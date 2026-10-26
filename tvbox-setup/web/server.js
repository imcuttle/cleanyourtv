#!/usr/bin/env node
// TVBox web: zero npm dependencies. One worker per CPU core (node:cluster); stateful work — downloads,
// config/safety writes, ffmpeg, 豆瓣 rate limiting — lives in one "leader" worker, the others reach it over IPC.
//   - serves the Netflix-style UI in ./public
//   - /api/*    sources (editable), 苹果CMS proxy, 豆瓣, safety level, downloads
//   - /hls?u=   relays m3u8/ts for CDNs that send no CORS headers
//   - /dl/<id>/ downloaded episodes, playable by every device on the LAN
//   - /media/   本地媒体: scanned local folders as a built-in source (also /api/local/vod for TVBox)
'use strict';
// 入口保护 (guard.js): this file, run directly, only starts a watcher that runs itself as a child and restarts it after a crash
// or a hang. The child (TVBOX_SUPERVISED=1) then forks the cluster workers. TVBOX_NO_SUPERVISOR=1 turns the outer watcher off.
if (require('cluster').isPrimary && !process.env.TVBOX_SUPERVISED && process.env.TVBOX_NO_SUPERVISOR !== '1' && require.main === module) {
  require('./auth').ensureToken();                       // token is made once, before any child needs it
  require('./guard').supervise(__filename);
  return;
}
const GUARD = require('./guard');
const http = require('http');
const https = require('https');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { Readable } = require('stream');
const { AsyncLocalStorage } = require('async_hooks');
// 每个请求带一个 AbortSignal: 浏览器断开 (切换页面 / 关页面) 就触发，请求里发起的上游 fetch 跟着中断，不再白占资源。
const reqCtx = new AsyncLocalStorage();
const { spawn, execFileSync } = require('child_process');
const cluster = require('cluster');
const zlib = require('zlib');

const PORT = Number(process.env.PORT) || 9988;
const HOST = process.env.HOST || '0.0.0.0';
const HTTPS_PORT = process.env.TVBOX_HTTPS === '0' ? 0 : Number(process.env.HTTPS_PORT) || PORT + 1;   // 0 = 不开 https (见 tls.js)
const ROOT = __dirname;
const CONFIG = path.join(ROOT, '..', 'config');
const PUBLIC = path.join(ROOT, 'public');
const DATA = process.env.TVBOX_DATA || path.join(ROOT, 'data');
const DL = path.join(DATA, 'downloads');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
fs.mkdirSync(DL, { recursive: true });

const CPUS = (os.availableParallelism ? os.availableParallelism() : os.cpus().length) || 1;
const WORKERS = Math.max(1, Math.min(Number(process.env.WORKERS) || CPUS, 16));
const MEDIA_OP = /^(local|hls)/; // rpc ops handled by the media process
// 访问令牌 (web/.env 的 TVBOX_TOKEN，第一次启动自动生成)。必须在 fork 之前定下来：子进程继承 process.env，用的是同一个。
const AUTH = require('./auth');
const TOKEN = AUTH.ensureToken().token;
const ADMIN_TOKEN = AUTH.ensureToken().adminToken;   // 管理员令牌 (TVBOX_ADMIN_TOKEN)：设置页「管理员」用，能重启 / 更新服务
// HTTPS 证书: 主进程先生成 (写到 data/tls)，工作进程之后直接读文件。没有证书 / 没有 openssl 时只提示，http 照常。
const TLS = HTTPS_PORT ? require('./tls').load() : null;
if (TLS && TLS.error && !cluster.isWorker) console.log('  [https] ' + TLS.error);
if (cluster.isPrimary && WORKERS > 1) return primary();
const IS_LEADER = !cluster.isWorker || process.env.TVBOX_LEADER === '1';
// 本地媒体 (folder scans, poster frames, ffmpeg → HLS) runs in its own process that never serves HTTP,
// so scanning / transcoding can't take event-loop time from the request workers. Single-process mode does it all.
const IS_MEDIA = !cluster.isWorker || process.env.TVBOX_MEDIA === '1';
const MEDIA_ONLY = cluster.isWorker && process.env.TVBOX_MEDIA === '1';

// ---- primary: fork, restart, relay RPC between workers and the leader / media process ----
function primary() {
  cluster.schedulingPolicy = cluster.SCHED_RR; // even spread, also on Windows
  cluster.setupPrimary({ windowsHide: true });   // Windows: 后台运行 (没有控制台) 时，不隐藏的话每个工作进程都会弹出一个 node.exe 黑窗口
  let leader = null, media = null, announced = false, stopping = false;
  const pending = new Map(); // rpc id -> requesting worker
  const dog = new GUARD.Watchdog(w => { try { w.process.kill('SIGKILL'); } catch {} });
  const recycling = new Set();
  // Graceful replacement: tell the worker to stop taking new connections and finish what it has; start the new one first
  // (web workers) so there is no gap; the old one is killed after a grace period if it still has not exited.
  const recycle = (w, why) => {
    if (stopping || recycling.has(w.id)) return;
    recycling.add(w.id);
    if (w.role === 'web') fork('web');
    try { w.send({ t: 'drain', why }); } catch {}
    setTimeout(() => { try { w.process.kill('SIGKILL'); } catch {} }, 20e3).unref();
  };
  const fork = role => {
    const w = cluster.fork({ TVBOX_LEADER: role === 'leader' ? '1' : '0', TVBOX_MEDIA: role === 'media' ? '1' : '0' });
    w.role = role;
    dog.beat(w);
    if (role === 'leader') leader = w;
    if (role === 'media') media = w;
    w.on('message', m => {
      if (!m || typeof m !== 'object') return;
      if (m.t === 'hb') { dog.beat(w); w.stats = m.stats; return; }
      if (m.t === 'recycle') return recycle(w, m.why);
      if (m.t === 'restart') { console.log(`  [管理] 重启请求：${m.why || ''}`); try { process.send({ t: 'restart', why: m.why }); } catch {} return; }   // → 最外层看守进程 (guard.js) 整体重拉
      if (m.t === 'rpc') {
        const to = MEDIA_OP.test(m.op) ? media : leader;
        if (!to || !to.isConnected()) return w.send({ t: 'rpc-res', id: m.id, error: '服务重启中，稍后再试' });
        pending.set(m.id, w);
        to.send(m);
      } else if (m.t === 'rpc-res') {
        const to = pending.get(m.id);
        pending.delete(m.id);
        if (to && to.isConnected()) to.send(m);
      } else if (m.t === 'reload') {
        for (const x of Object.values(cluster.workers)) if (x !== w && x.isConnected()) x.send(m);
      } else if (m.t === 'ready' && !announced) {
        announced = true;
        banner(WORKERS, m.ffmpeg, m.dl);
      }
    });
  };
  fork('leader');
  for (let i = 1; i < WORKERS; i++) fork('web');
  fork('media');
  // A worker that keeps dying right after it starts is restarted with a growing delay (1s … 30s), not in a tight loop.
  const fails = {};
  cluster.on('exit', (w, code, sig) => {
    dog.forget(w);
    if (stopping) return;
    if (w.role === 'leader' && leader === w) leader = null;
    if (w.role === 'media' && media === w) media = null;
    const wasRecycled = recycling.delete(w.id);
    if (wasRecycled && w.role === 'web') return console.log(`  进程 ${w.process.pid}（web）已平滑退出，新进程已接手`);
    const f = fails[w.role] = fails[w.role] || { n: 0, at: 0 };
    f.n = Date.now() - f.at > 60e3 ? 1 : f.n + 1; f.at = Date.now();
    const wait = wasRecycled ? 300 : Math.min(30e3, 1000 * 2 ** Math.min(f.n - 1, 5));
    console.log(`  进程 ${w.process.pid}（${w.role}）${wasRecycled ? '已平滑退出' : '退出（' + (sig || code) + '）'}，${wait >= 1000 ? Math.round(wait / 1000) + ' 秒' : '马上'}后重启${f.n > 5 ? '（连续异常，请检查日志）' : ''}`);
    setTimeout(() => fork(w.role), wait);
  });
  dog.start(() => Object.values(cluster.workers).filter(w => w.isConnected()));
  // tell the outer watcher the primary itself is alive; ask it for a full restart if every worker is gone for good
  setInterval(() => { try { process.send?.({ t: 'hb' }); } catch {} }, 5000).unref();
  process.on('uncaughtException', e => console.error('  [保护] 主进程异常（已拦截，继续运行）：', e && e.stack || e));
  process.on('unhandledRejection', e => console.error('  [保护] 主进程未处理的 Promise 错误（已拦截）：', e && e.stack || e));
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { stopping = true; for (const w of Object.values(cluster.workers)) w.kill(); process.exit(0); });
}

function banner(n, ffmpeg, dl) {
  const { toTerminal } = require('./qr');
  const lan = lanIps();
  console.log('\n  TVBox 已启动，浏览器打开：\n');
  console.log(`    本机      http://localhost:${PORT}`);
  for (const ip of lan) console.log(`    局域网    http://${ip}:${PORT}`);
  if (TLS?.cert) {
    console.log(`\n  HTTPS（手机「分享」要唤起系统分享面板 / 微信，必须用 https 打开）：`);
    console.log(`    本机      https://localhost:${HTTPS_PORT}`);
    for (const ip of lan) console.log(`    局域网    https://${ip}:${HTTPS_PORT}`);
    if (TLS.source === 'self-signed') console.log('    自签名证书：浏览器第一次会提示不安全，点「继续访问 / 高级」即可 (证书 ' + require('./tls').DIR + '；有域名证书用 TVBOX_TLS_CERT / TVBOX_TLS_KEY)');
  }
  console.log(`\n  访问令牌  ${TOKEN}`);
  console.log(`  管理员令牌  ${ADMIN_TOKEN}   （设置页「管理员」里用，可重启 / 更新服务；存在 ${AUTH.ENV_FILE} 的 ${AUTH.ADMIN_KEY}）`);
  console.log(`  （浏览器第一次打开要输入它，之后一直记住；存在 ${AUTH.ENV_FILE} 的 ${AUTH.KEY}，换令牌就删掉那一行再重启）`);
  console.log(`\n  进程：${n} 个（CPU ${CPUS} 核，环境变量 WORKERS 可调）`);
  console.log(`  下载目录：${dl}`);
  console.log(`  直播封面：${ffmpeg ? 'ffmpeg 已找到' : '没有 ffmpeg，悬停时用浏览器截图'}`);
  console.log('  关闭这个窗口即停止服务。');
  // 二维码: 手机 / 电视扫一下就能打开。局域网的马上显示，公网的等查到 IP 再显示。
  const qr = (title, url) => { try { console.log(`\n  ${title}  ${url}\n${toTerminal(url)}`); } catch {} };
  if (lan[0]) qr('局域网二维码（手机和这台电脑连同一个 Wi-Fi）', `http://${lan[0]}:${PORT}`);
  if (lan[0] && TLS?.cert) qr('局域网 HTTPS 二维码（可唤起系统分享）', `https://${lan[0]}:${HTTPS_PORT}`);
  publicIp().then(ip => {
    if (!ip) return console.log('\n  公网：没查到公网 IP（离线或被墙），只能在局域网里访问。');
    const url = `http://${ip}:${PORT}`;
    console.log(`\n  公网      ${url}  （正在从外网探测是否可达…）`);
    reachableFromOutside(ip, PORT).then(ok => {
      if (ok === true) {
        console.log(`  公网可达  ✓ ${url}  外网节点已连通，端口映射生效。没有访问令牌的人打不开；令牌别发给别人。`);
        qr('公网二维码', url);
      } else if (ok === false) {
        console.log(`  公网可达  ✗ 外网连不上 ${ip}:${PORT}。需要在路由器 / 光猫里把端口 ${PORT} 转发到这台电脑（二级路由要两层都转；运营商没给公网 IPv4 时不通）。`);
      } else {
        console.log('  公网可达  ? 探测服务没有响应，没法确认；请用手机流量自己试一下上面的地址。');
      }
    });
  });
}
// Ask check-host.net's nodes (outside our network) to TCP-connect to ip:port. true = reachable, false = refused / timed out,
// null = the probe service itself failed. Note: only tests the internal PORT; an external port that differs from it can't be detected.
async function reachableFromOutside(ip, port) {
  try {
    const hdr = { accept: 'application/json', 'user-agent': 'curl/8' };
    const r = await fetch(`https://check-host.net/check-tcp?host=${ip}:${port}&max_nodes=3`, { headers: hdr, signal: AbortSignal.timeout(8000) });
    const id = (await r.json()).request_id;
    if (!id) return null;
    for (let i = 0; i < 6; i++) {
      await new Promise(s => setTimeout(s, 3000));
      const res = await (await fetch(`https://check-host.net/check-result/${id}`, { headers: hdr, signal: AbortSignal.timeout(8000) })).json();
      const rows = Object.values(res).filter(Boolean).map(v => v[0]);
      if (rows.some(x => x && x.address)) return true;
      if (rows.length && rows.every(x => x && x.error)) return false;
    }
    return false;
  } catch { return null; }
}
// Public IPv4, asked from a few lookup services at once; first answer wins. null when offline.
async function publicIp() {
  const ask = async u => {
    const r = await fetch(u, { signal: AbortSignal.timeout(4000), headers: { 'user-agent': 'curl/8' } });
    const t = (await r.text()).trim();
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(t)) throw new Error('not an ip');
    return t;
  };
  try { return await Promise.any(['https://api.ipify.org', 'https://4.ipw.cn', 'https://ifconfig.me/ip', 'https://icanhazip.com'].map(ask)); } catch { return null; }
}

// ---- RPC: run `op` in the process that owns it (leader, or media for local*/hls*) — directly when that is us ----
const rpcHandlers = {};
const rpcWait = new Map();
let rpcSeq = 0;
const ownsOp = op => !cluster.isWorker || (MEDIA_OP.test(op) ? IS_MEDIA : IS_LEADER);
function rpc(op, args, ms = 60000) {
  if (ownsOp(op)) return Promise.resolve().then(() => rpcHandlers[op](args));
  return new Promise((ok, bad) => {
    const id = `${process.pid}:${++rpcSeq}`;
    const t = setTimeout(() => { rpcWait.delete(id); bad(new Error('内部请求超时')); }, ms);
    rpcWait.set(id, { ok, bad, t });
    process.send({ t: 'rpc', id, op, args });
  });
}
if (cluster.isWorker) {
  process.on('message', async m => {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'rpc' && ownsOp(m.op)) {
      try { process.send({ t: 'rpc-res', id: m.id, result: await rpcHandlers[m.op](m.args) }); }
      catch (e) { process.send({ t: 'rpc-res', id: m.id, error: e.message || String(e) }); }
    } else if (m.t === 'rpc-res') {
      const w = rpcWait.get(m.id);
      if (!w) return;
      rpcWait.delete(m.id); clearTimeout(w.t);
      m.error !== undefined ? w.bad(new Error(m.error)) : w.ok(m.result);
    } else if (m.t === 'reload') reloadState();
  });
}
// After the leader changes config/safety on disk, every worker re-reads it.
function broadcastReload() {
  reloadState();
  if (cluster.isWorker) process.send({ t: 'reload' });
}
function reloadState() {
  const c = readJson(STORE, null);
  if (c) config = normalize(c);
  safety = readJson(SAFETY, { level: 'standard', pin: '' });
  localCfg = readLocalCfg();
  cache.clear();
}

const MIME = { '.webmanifest': 'application/manifest+json', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json',
  '.ttf': 'font/ttf', '.map': 'application/json', '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.mp4': 'video/mp4', '.m4s': 'video/iso.segment',
  '.webp': 'image/webp', '.jpeg': 'image/jpeg', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo', '.flv': 'video/x-flv', '.wmv': 'video/x-ms-wmv',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.opus': 'audio/ogg' };

const str = v => (v === undefined || v === null ? '' : String(v));
const clean = h => str(h).replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&[a-z]+;/g, '').trim();
const readJson = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } };
const writeJson = (f, v) => { fs.writeFileSync(f + '.tmp', JSON.stringify(v, null, 1)); fs.renameSync(f + '.tmp', f); };

// ======================= sources (editable, shared on the LAN) =======================
const STORE = path.join(DATA, 'sources.json');

function defaults() {
  return normalize(JSON.parse(fs.readFileSync(path.join(CONFIG, 'vod-apps.json'), 'utf8')));
}

const LOCAL_VOD = /^local:[\w.-]+\.txt$/; // a 点播源 edited as text on this server (data/vods)
// Keep what a browser can use: 苹果CMS JSON sites (type 1). Extra fields understood here:
//   kids: 1        shown in 儿童 mode
//   adult: 1       hidden unless 安全级别 = 全部
//   categories: [] TVBox-style whitelist of category names
function normalize(cfg) {
  const sigKey = new Map(), keys = new Set(['local']), remap = new Map(); // remap: key as written → final key
  const out = [];
  for (const s of cfg.sites || []) {
    if (!s) continue;
    if (Array.isArray(s.members)) { out.push({ group: s }); continue; }
    if (!(/^https?:\/\//.test(str(s.api).trim()) || LOCAL_VOD.test(str(s.api).trim())) || (s.type !== undefined && Number(s.type) !== 1)) continue;
    const api = str(s.api).trim();
    const categories = Array.isArray(s.categories) ? s.categories.map(String).filter(Boolean) : [];
    // Same link (ignoring ac/pg/t/wd params, fragment, trailing slash) is the same source: keep the first.
    const sig = normApi(api) + '|' + categories.join(',');
    const written = str(s.key || s.name || api).trim();
    if (sigKey.has(sig)) { if (!remap.has(written)) remap.set(written, sigKey.get(sig)); continue; }
    const name = str(s.name || s.key || api).trim();
    let key = written, n = 2;
    while (keys.has(key)) key = `${written}${n++}`;
    keys.add(key);
    sigKey.set(sig, key);
    if (!remap.has(written)) remap.set(written, key);
    const site = { key, name, type: 1, api };
    if (Number(s.kids)) site.kids = 1;
    if (Number(s.adult)) site.adult = 1;
    if (Number(s.hidden)) site.hidden = 1;
    // 转成本地片单前的样子, 供「撤销转换」: { api: 原接口 } 或 { group: 原聚合源 }
    const rs = s.restore;
    if (rs && typeof rs === 'object' && LOCAL_VOD.test(api)) {
      if (/^https?:\/\//.test(str(rs.api).trim())) site.restore = { api: str(rs.api).trim() };
      else if (rs.group && Array.isArray(rs.group.members) && rs.group.members.length) {
        const g = rs.group;
        site.restore = { group: { key: str(g.key).trim(), name: str(g.name).trim(), members: g.members.map(x => str(x).trim()).filter(Boolean),
          ...(Array.isArray(g.unhide) && g.unhide.length ? { unhide: g.unhide.map(x => str(x).trim()).filter(Boolean) } : {}),
          ...(Number(g.kids) ? { kids: 1 } : {}), ...(Number(g.adult) ? { adult: 1 } : {}), ...(Number(g.hidden) ? { hidden: 1 } : {}) } };
      }
    }
    if (categories.length) site.categories = categories;
    out.push(site);
  }
  // 聚合源: {key, name, members: [site keys]} searches / lists / plays through all of its members at once.
  const sites = [];
  for (const o of out) {
    if (!o.group) { sites.push(o); continue; }
    const g = o.group, name = str(g.name || g.key).trim();
    const members = [...new Set(g.members.map(k => remap.get(str(k).trim())).filter(Boolean))];
    if (!name || !members.length) continue;
    const written = str(g.key || name).trim();
    let key = written, n = 2;
    while (keys.has(key)) key = `${written}${n++}`;
    keys.add(key);
    sites.push({ key, name, type: 1, members, ...(Number(g.kids) ? { kids: 1 } : {}), ...(Number(g.adult) ? { adult: 1 } : {}), ...(Number(g.hidden) ? { hidden: 1 } : {}) });
  }
  const liveSeen = new Set();
  const lives = (cfg.lives || []).filter(l => l && typeof l.url === 'string' && l.url.trim())
    .map(l => ({ name: str(l.name || l.url).trim(), url: l.url.trim(), ...(l.from ? { from: str(l.from) } : {}), ...(Number(l.kids) ? { kids: 1 } : {}), ...(Number(l.adult) ? { adult: 1 } : {}), ...(Number(l.hidden) ? { hidden: 1 } : {}) }))
    .filter(l => { const k = /^https?:\/\//.test(l.url) ? normUrl(l.url) : l.url; return !liveSeen.has(k) && liveSeen.add(k); });
  return { sites, lives };
}

let config = (() => { const c = readJson(STORE, null); return c ? normalize(c) : defaults(); })();
const saveConfig = () => writeJson(STORE, config);
if (IS_LEADER && !fs.existsSync(STORE)) saveConfig();

// ======================= safety level =======================
// kids: only kids sites; standard: hide adult sites + adult categories; all: everything.
const SAFETY = path.join(DATA, 'safety.json');
let safety = readJson(SAFETY, { level: 'standard', pin: '' });
const ADULT = /伦理|理论|三级|福利|写真|里番|两性|擦边|成人|情色|激情|无码|有码|性感|午夜|黄色|av|porn/i;
const KIDS_CATS = /动漫|动画|儿童|少儿|卡通|亲子|早教|绘本/;
// 直播: a source can be flagged 少儿 / 成人 like a 点播源; on top of that every group / channel is classified by its name.
//   全部: everything · 标准: no 成人 source, no 成人 group / channel · 儿童: no 成人 either, and from a source that is not flagged
//   少儿 only the groups / channels that look like kids content.
const LIVE_ADULT = /伦理|三级|福利|写真|里番|成人|情色|激情|无码|有码|午夜|黄色|性感|限制级|18\+|porn|xxx|\badult\b/i;
const LIVE_KIDS = /少儿|儿童|卡通|动画|动漫|亲子|早教|幼儿|宝宝|童话|kids|cartoon|disney/i;
const liveSrcOk = l => safety.level === 'all' || !l.adult;
function liveFilter(groups, src) {
  if (safety.level === 'all') return groups;
  const kids = safety.level === 'kids' && !src.kids;
  return groups.map(g => ({ ...g, channels: g.channels.filter(c => { const t = g.name + ' ' + c.name; return !LIVE_ADULT.test(t) && (!kids || LIVE_KIDS.test(t)); }) }))
    .filter(g => g.channels.length);
}

// /api/sites 的内容：点播源 / 直播源列表 + 安全级别。入口页也把它直接写进 HTML（见 serveStatic），首屏不用再等一次请求。
function sitesBody(SITES, pv) {
  const inGroup = new Map();
  for (const g of SITES) for (const m of g.memberSites || []) if (!inGroup.has(m.key)) inGroup.set(m.key, g.key);
  return { level: safety.level, sites: SITES.map(({ key, name, kids, adult, hidden, memberSites, api, local }) => ({ key, name, kids: !!kids, ...(hidden ? { hidden: true } : {}), ...(inGroup.has(key) ? { inGroup: inGroup.get(key) } : {}), ...(api && !memberSites ? { api } : {}), ...(local ? { local: true } : {}), adult: !!(adult || memberSites?.some(m => m.adult)), ...(memberSites ? { group: memberSites.length, members: memberSites.map(m => m.key) } : {}) })), live: pv ? pv.liveList : config.lives.map((l, i) => ({ key: String(i), name: l.name, kids: !!l.kids, adult: !!l.adult, ...(l.hidden ? { hidden: true } : {}) })).filter(l => safety.level === 'all' || !l.adult) };
}

function visibleSites() {
  const ok = s => safety.level === 'kids' ? s.kids : safety.level === 'standard' ? !s.adult : true;
  const all = new Map(config.sites.filter(s => !s.members).map(s => [s.key, s]));
  const sites = [];
  for (const s of config.sites) {
    if (!s.members) { if (ok(s)) sites.push(s); continue; }
    // 聚合源 has its own 少儿 / 成人 flags. 成人 hides the whole group in 标准; 少儿 lets all its members through in 儿童
    // (without the flag, only members that are 少儿 themselves do).
    if (safety.level === 'standard' && s.adult) continue;
    const memberSites = s.members.map(k => all.get(k)).filter(m => m && (s.kids && safety.level === 'kids' ? true : ok(m)));
    if (memberSites.length) sites.push({ ...s, memberSites });
  }
  const loc = localSite();
  return loc ? [loc, ...sites] : sites;
}
function catAllowed(site, name) {
  if (site.local) return true; // 本地媒体 filters by its folders' 少儿/成人 flags itself
  if (site.categories && !site.categories.includes(name)) return false;
  if (safety.level === 'all') return true;
  if (ADULT.test(name)) return false;
  if (safety.level === 'kids' && !site.categories && !KIDS_CATS.test(name)) return false;
  return true;
}
const pinOk = req => !safety.pin || req.headers['x-pin'] === safety.pin;

// ======================= live: text, check, covers =======================
const LIVES = path.join(DATA, 'lives');
const THUMBS = path.join(DATA, 'thumbs');
const VODS = path.join(DATA, 'vods');
fs.mkdirSync(VODS, { recursive: true });
fs.mkdirSync(LIVES, { recursive: true });
fs.mkdirSync(THUMBS, { recursive: true });

// Live source url forms: http(s) URL · built-in file name in ../config · local:<file> edited on this server.
async function liveText(url, fresh = false) {
  if (/^https?:\/\//.test(url)) return fresh ? fetchText(url) : cachedText(url);
  if (url.startsWith('local:')) return fsp.readFile(path.join(LIVES, path.basename(url.slice(6))), 'utf8');
  return fsp.readFile(path.join(CONFIG, path.basename(url)), 'utf8');
}

async function checkLive(url, name) {
  const t0 = Date.now();
  let text;
  try { text = await liveText(url, true); } catch (e) { return { ok: false, error: '列表打不开：' + e.message }; }
  const ms = Date.now() - t0;
  const channels = parseLive(text, { url, name }).groups.flatMap(g => g.channels);
  if (!channels.length) return { ok: false, ms, channels: 0, error: '没解析出频道' };
  const sample = channels.sort(() => Math.random() - 0.5).slice(0, 8);
  const alive = (await Promise.all(sample.map(c => fetch(c.url, { headers: { 'User-Agent': UA, Range: 'bytes=0-2047' }, signal: AbortSignal.timeout(6000) })
    .then(r => { r.body?.cancel().catch(() => {}); return r.status < 400; }, () => false)))).filter(Boolean).length;
  return { ok: alive > 0, ms, channels: channels.length, alive, sampled: sample.length };
}

// Covers (one frame) and hover previews (3s gif), made with ffmpeg when it is installed. Cached 15 min.
const FFMPEG = (() => {
  for (const c of [process.env.FFMPEG, path.join(ROOT, '.tools', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'), 'ffmpeg'].filter(Boolean)) {
    try { execFileSync(c, ['-version'], { stdio: 'ignore', windowsHide: true }); return c; } catch {}
  }
  return '';
})();
const MEDIA_TTL = 15 * 60e3;
const mediaJobs = new Map(), mediaQueue = [];
let mediaRunning = 0;
function limited(fn) {
  return new Promise((ok, bad) => { mediaQueue.push({ fn, ok, bad }); drainMedia(); });
}
function drainMedia() {
  while (mediaRunning < Math.max(2, Math.min(CPUS, 6)) && mediaQueue.length) {
    const { fn, ok, bad } = mediaQueue.shift();
    mediaRunning++;
    fn().then(ok, bad).finally(() => { mediaRunning--; drainMedia(); });
  }
}
function ffmpeg(args, ms, nice, signal) {
  return new Promise((ok, bad) => {
    if (signal?.aborted) return bad(new Error('aborted'));
    const p = spawn(FFMPEG, args, { stdio: 'ignore', windowsHide: true });
    signal?.addEventListener('abort', () => p.kill('SIGKILL'), { once: true });
    if (nice) try { os.setPriority(p.pid, nice); } catch {} // background work yields to request handling
    const t = setTimeout(() => p.kill('SIGKILL'), ms);
    p.on('exit', code => { clearTimeout(t); code === 0 ? ok() : bad(new Error('ffmpeg exit ' + code)); });
    p.on('error', e => { clearTimeout(t); bad(e); });
  });
}
const mediaFile = (kind, url) => path.join(THUMBS, crypto.createHash('md5').update(url).digest('hex') + (kind === 'thumb' ? '.jpg' : '.gif'));
// 引用计数 (按文件): 请求的页面切走了就发 hold:'leave'，没人要的截图 / 预览: 还在排队的跳过，已经在跑的 ffmpeg 直接杀掉。
const mediaCtl = new Map();   // file -> { refs, ctl }
rpcHandlers.media = ({ kind, url, hold }) => { if (hold === 'leave') { mediaLeave(mediaFile(kind, url)); return null; } return liveMedia(kind, url, hold === 'ref'); };
function mediaLeave(file) { const e = mediaCtl.get(file); if (e && --e.refs <= 0) { e.ctl.abort(); mediaCtl.delete(file); } }
async function liveMedia(kind, url, counted) {
  const file = mediaFile(kind, url);
  const st = await fsp.stat(file).catch(() => null);
  if (st && Date.now() - st.mtimeMs < MEDIA_TTL) return file;
  if (!FFMPEG) return st ? file : null;
  const key = file;
  if (counted) {
    let e = mediaCtl.get(file); if (!e) mediaCtl.set(file, e = { refs: 0, ctl: new AbortController() });
    e.refs++;
  }
  if (!mediaJobs.has(key)) {
    const sig = mediaCtl.get(file)?.ctl.signal;
    const tmp = file.replace(/(\.\w+)$/, '.tmp$1');
    const input = ['-hide_banner', '-loglevel', 'error', '-y', '-user_agent', UA, '-rw_timeout', '8000000', '-live_start_index', '-1'];
    const args = kind === 'thumb'
      // Preview-sized on purpose: ~8 KB covers, ~130 KB gifs (240px, 6 fps, 2.5 s, 48 colours).
      ? [...input, '-skip_frame', 'nokey', '-i', url, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '9', tmp]
      : [...input, '-t', '2.5', '-i', url, '-an', '-vf', `fps=6,${GIF_FIT},split[a][b];[a]palettegen=max_colors=64:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`, '-loop', '0', tmp];
    mediaJobs.set(key, limited(() => sig?.aborted ? Promise.reject(new Error('aborted')) : ffmpeg(args, kind === 'thumb' ? 25000 : 40000, undefined, sig))
      .then(() => fsp.rename(tmp, file)).then(() => file, () => { fsp.rm(tmp, { force: true }).catch(() => {}); return st ? file : null; })
      .finally(() => { mediaJobs.delete(key); mediaCtl.delete(file); }));
  }
  return mediaJobs.get(key);
}

// ======================= 苹果CMS =======================
const cache = new Map();
const TTL = 5 * 60 * 1000;

async function fetchText(url, ms = 15000, headers = {}, signal) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, redirect: 'follow', signal: signal ? AbortSignal.any([AbortSignal.timeout(ms), signal]) : AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}
// Identical upstream requests that overlap share one fetch.
const inflight = new Map();
// 引用计数: 共享这一个请求的所有请求都断开了 (没人要结果了) 才真正中断上游; 还有人在等就继续。fn 收到这个共享的 signal。
function once(key, fn) {
  const sig = reqCtx.getStore()?.signal;
  let e = inflight.get(key);
  if (!e) {
    const ctl = new AbortController();
    e = { refs: 0, ctl };
    e.p = reqCtx.exit(() => fn(ctl.signal)).finally(() => { if (inflight.get(key) === e) inflight.delete(key); });
    inflight.set(key, e);
  }
  if (!sig) { e.refs++; return e.p; }   // 没有请求上下文 (后台任务): 一直占着一个引用，不会被别人的断开中断
  e.refs++;
  return new Promise((ok, bad) => {
    const leave = () => { if (--e.refs <= 0) e.ctl.abort(); };
    if (sig.aborted) { leave(); return bad(new Error('aborted')); }
    const onAbort = () => { leave(); bad(new Error('aborted')); };
    sig.addEventListener('abort', onAbort, { once: true });
    e.p.then(ok, bad).finally(() => sig.removeEventListener('abort', onAbort));
  });
}
async function cachedText(url) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL) return hit.body;
  return once('t|' + url, async signal => {
    const body = await fetchText(url, 15000, {}, signal);
    cache.set(url, { at: Date.now(), body });
    return body;
  });
}
// ---- 本地片单: a 点播源 that is a text file on this server, served in 苹果CMS shape ----
//   分类名,#genre#                       starts a category (titles before any category go to 「未分类」)
//   片名,https://…/a.m3u8                one title; the same title again adds another episode
//   片名,第1集$https://…#第2集$https://…   episodes written out; // starts a comment
//   片名,线路甲@@第1集$…#第2集$… || 线路乙@@第1集$…   several lines (sources) of one title, separated by ' || '
//   片名,… ## pic=封面地址 ## year=2020 ## remarks=更新至8集   optional details after ' ## ' (pic remarks year area actor director lang desc)
const VOD_META = ['pic', 'remarks', 'year', 'area', 'actor', 'director', 'lang', 'desc'];
function parseVodText(text) {
  const cats = new Map(), titles = new Map(), bad = [];
  let cat = '未分类';
  const parseEps = s => s.split('#').map(p => {
    const j = p.indexOf('$'), url = (j < 0 ? p : p.slice(j + 1)).trim();
    return { name: j < 0 ? '' : p.slice(0, j).trim().replace(/[$#]/g, ' '), url };
  }).filter(e => /^https?:\/\//.test(e.url));
  str(text).replace(/^\uFEFF/, '').split(/\r?\n/).forEach((raw, n) => {
    const line = raw.trim();
    if (!line || line.startsWith('//') || line.startsWith('#')) return;
    const i = line.indexOf(',');
    const name = i > 0 ? line.slice(0, i).trim() : '';
    const [rest = '', ...metaParts] = (i > 0 ? line.slice(i + 1).trim() : '').split(/\s##\s/).map(x => x.trim());
    const meta = {};
    for (const p of metaParts) { const j = p.indexOf('='), k = p.slice(0, j).trim(); if (j > 0 && VOD_META.includes(k) && p.slice(j + 1).trim()) meta[k] = p.slice(j + 1).trim(); }
    if (rest === '#genre#') { cat = name || '未分类'; return; }
    const lines = rest.split(/\s\|\|\s/).map((seg, k) => {
      const at = seg.indexOf('@@'), hasName = at > 0 && !/^https?:/i.test(seg.slice(0, at));
      return { name: hasName ? seg.slice(0, at).trim().replace(/[$#]/g, ' ') : '', eps: parseEps(hasName ? seg.slice(at + 2) : seg) };
    }).filter(l => l.eps.length);
    if (!name || !lines.length) return bad.push(n + 1);
    const key = cat + '|' + name;
    if (!cats.has(cat)) cats.set(cat, 'c' + crypto.createHash('sha1').update(cat).digest('hex').slice(0, 6));
    if (!titles.has(key)) titles.set(key, { id: 'v' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 10), name: name.replace(/[$#]/g, ' '), cat, lines: [], meta: {} });
    const t = titles.get(key);
    for (const k in meta) if (!t.meta[k]) t.meta[k] = meta[k];
    for (const l of lines) {
      // Same-named line again, or a plain line with no name: more episodes of the first line; a new name is a new line.
      const ex = l.name ? t.lines.find(x => x.name === l.name) : t.lines[0];
      if (ex) ex.eps.push(...l.eps); else t.lines.push(l);
    }
  });
  const items = [...titles.values()];
  for (const t of items) {
    t.lines.forEach((l, k) => { if (!l.name) l.name = t.lines.length > 1 ? `线路${k + 1}` : '本地片单'; l.eps.forEach((e, j) => { if (!e.name) e.name = l.eps.length > 1 ? `第${j + 1}集` : '播放'; }); });
    t.eps = t.lines[0].eps;
  }
  return { cats: [...cats].map(([name, id]) => ({ id, name })), items, bad };
}
const vodFileCache = new Map();
const VOD_PAGE = 30;
function fileCms(api, params) {
  const file = path.join(VODS, path.basename(str(api).slice(6)));
  let st; try { st = fs.statSync(file); } catch { throw new Error('本地片单文件不存在'); }
  let hit = vodFileCache.get(file);
  if (!hit || hit.mtime !== st.mtimeMs) { hit = { mtime: st.mtimeMs, ...parseVodText(fs.readFileSync(file, 'utf8')) }; vodFileCache.set(file, hit); }
  const ids = str(params.ids).split(',').map(x => x.trim()).filter(Boolean);
  const t = str(params.t), wd = str(params.wd).trim().toLowerCase();
  const catId = new Map(hit.cats.map(c => [c.name, c.id]));
  if (!hit.byId) hit.byId = new Map(hit.items.map(it => [it.id, it]));
  const list = ids.length ? ids.map(i => hit.byId.get(i)).filter(Boolean)
    : hit.items.filter(it => (!t || catId.get(it.cat) === t) && (!wd || it.name.toLowerCase().includes(wd)));
  const pg = Math.max(1, Number(params.pg) || 1);
  const page = ids.length ? list : list.slice((pg - 1) * VOD_PAGE, pg * VOD_PAGE);
  return { code: 1, msg: '数据列表', page: pg, pagecount: Math.max(1, Math.ceil(list.length / VOD_PAGE)), limit: String(VOD_PAGE), total: list.length,
    class: hit.cats.map(c => ({ type_id: c.id, type_pid: 0, type_name: c.name })),
    list: page.map(it => ({ vod_id: it.id, vod_name: it.name, vod_pic: it.meta.pic || '', type_id: catId.get(it.cat), type_name: it.cat,
      vod_remarks: it.meta.remarks || (it.eps.length > 1 ? `${it.eps.length}集` : ''), vod_year: it.meta.year || '', vod_area: it.meta.area || '',
      vod_actor: it.meta.actor || '', vod_director: it.meta.director || '', vod_lang: it.meta.lang || '', vod_content: it.meta.desc || '', vod_play_from: it.lines.map(l => l.name).join('$$$'),
      vod_play_url: it.lines.map(l => l.eps.map(e => `${e.name}$${e.url}`).join('#')).join('$$$') })) };
}
// Text for the editor: the local file itself, or (for a web source) a full copy of it — every page, with cover / year / area / cast / remarks.
// Only titles with a directly playable line are kept. `prog` ({done,total,titles,cancel}) is updated while it runs.
const vodRow = (name, ls, meta) => `${name},${ls.length === 1 && ls[0].name === '' ? ls[0].eps : ls.map(l => `${l.name}@@${l.eps}`).join(' || ')}${Object.entries(meta || {}).filter(([, v]) => v).map(([k, v]) => ` ## ${k}=${v}`).join('')}`;
const lineTexts = d => lines(d).map(l => ({ name: str(l.name).replace(/[@|,\n$#]/g, ' ').trim(), eps: l.episodes.map(e => `${str(e.name).replace(/[$#\n]/g, ' ').trim() || '播放'}$${e.url}`).join('#') }));
const metaClean = v => str(v).replace(/\s+/g, ' ').replace(/\s##\s/g, ' # ').trim();
const metaOf = d => ({ pic: metaClean(d.vod_pic), remarks: metaClean(d.vod_remarks), year: metaClean(d.vod_year), area: metaClean(d.vod_area),
  actor: metaClean(d.vod_actor), director: metaClean(d.vod_director), lang: metaClean(d.vod_lang), desc: metaClean(clean(d.vod_content)).slice(0, 600) });
// ---- 分级拉取: 页越靠前越值钱 (最新更新 / 最热在前面)，所以按「页面等级」分配资源 ----
//   一档 前 20 页       并发最高、最先拉完        (几十秒内就有一份能用的片单)
//   二档 21 – 200 页    并发居中
//   三档 200 页之后     并发最低 (几千页的源这部分最慢，随时可以「先用已拉到的」收工)
// 页按顺序领取，所以任何时候已拉到的基本都是连续的前 N 页。
const PAGE_TIERS = [{ upto: 20, conc: 48 }, { upto: 200, conc: 32 }, { upto: Infinity, conc: 24 }];
// 源站吃不消 (请求失败 / 超时) 时自动降速: 并发乘一个 0.25–1 的系数，失败就打折，连续成功再慢慢恢复。
const tierOf = pg => PAGE_TIERS.findIndex(t => pg <= t.upto);
// prog: { done, total, titles, tier: [{done,total}×3], cancel, stop }. cancel → 抛 '已取消'; stop → 正常返回已拉到的。
// share: 一个任务里有几个源 (聚合源的成员) 一起拉时, 每个源按比例分并发, 总量不变。
async function allPages(site, onPage, prog, share = 1) {
  const first = await cmsGet(site, { ac: 'detail', pg: '1' }, true, 15000);
  const total = Math.max(1, Number(first.pagecount || 1));
  if (prog) {
    prog.total += total; prog.done++;
    prog.tier ||= PAGE_TIERS.map(() => ({ done: 0, total: 0 }));
    for (let pg = 1, t = 0; t < PAGE_TIERS.length; t++) { const hi = Math.min(total, PAGE_TIERS[t].upto); if (hi >= pg) prog.tier[t].total += hi - pg + 1; pg = hi + 1; }
    prog.tier[0].done++;
  }
  onPage(1, first);
  let next = 2, failed = 0, inflight = 0, factor = 1, okRun = 0;
  const limit = pg => Math.max(1, Math.floor(PAGE_TIERS[tierOf(pg)].conc * factor / share));
  const stopped = () => prog?.cancel || prog?.stop;
  await Promise.all(Array.from({ length: Math.max(0, Math.min(PAGE_TIERS[0].conc, total - 1)) }, async () => {
    while (next <= total && !stopped()) {
      if (inflight >= limit(next)) { await new Promise(r => setTimeout(r, 40)); continue; }   // 这一档的名额满了, 等一等
      const pg = next++; inflight++;
      try {
        let b = null;
        for (let k = 0; k < 2 && !b && !stopped(); k++) b = await cmsGet(site, { ac: 'detail', pg: String(pg) }, true, tierOf(pg) === 0 ? 15000 : 10000).catch(() => null);
        if (b) { onPage(pg, b); if (++okRun >= 20) { okRun = 0; factor = Math.min(1, factor + 0.1); } }
        else if (!stopped()) { failed++; okRun = 0; factor = Math.max(0.25, factor * 0.7); }
      } finally { inflight--; }
      if (prog) { prog.done++; prog.tier[tierOf(pg)].done++; }
    }
  }));
  return { total, failed };
}
const catsText = byCat => [...byCat].map(([c, rows]) => `${c},#genre#\n${rows.join('\n')}`).join('\n\n') + '\n';
// A web source as list text. Returns a collector so the text can be taken at any moment (「先用已拉到的」).
// 片多的源 (几十万部) 不能全放内存 / 全塞进编辑器: 单源直接边拉边追加写进磁盘上的临时文件；少于 BIG_TITLES 部才把文本交给编辑器。
const BIG_TITLES = 30000;
const spoolPath = id => path.join(VODS, '.snap-' + String(id).replace(/[^\w]/g, '') + '.tmp');
function vodCollector(api, prog, spool) {
  const byCat = new Map(), seen = new Set(), cats = new Set();
  let n = 0, total = 0, failed = 0, fd = null;
  if (spool) fd = fs.openSync(spool, 'w');
  const run = async () => {
    try {
      ({ total, failed } = await allPages({ name: '', api }, (pg, b) => {
        const page = new Map();
        for (const d of b.list || []) {
          const ls = lineTexts(d); if (!ls.length) continue;
          const cat = str(d.type_name).replace(/[,\n]/g, ' ') || '未分类', name = str(d.vod_name).replace(/[,\n]/g, ' ').trim();
          const sk = cat + '|' + str(d.vod_id);
          if (!name || seen.has(sk)) continue;
          seen.add(sk); cats.add(cat);
          const row = vodRow(name, ls, metaOf(d));
          const into = fd !== null ? page : byCat;
          if (!into.has(cat)) into.set(cat, []);
          into.get(cat).push(row); n++;
        }
        if (fd !== null && page.size) fs.writeSync(fd, catsText(page) + '\n');   // 同一个分类头可以出现多次，读取时自动归到一起
        if (prog) prog.titles = n;
      }, prog));
    } finally { if (fd !== null) { fs.closeSync(fd); fd = null; } }
    if (prog?.cancel) throw new Error('已取消');
    if (!n) throw new Error('这个源里没有可直接播放的片');
  };
  const result = () => {
    const base = { titles: n, cats: cats.size, pages: prog?.done || total, totalPages: total, failedPages: failed, partial: !!prog?.stop && (prog.done < prog.total) };
    if (!spool) return { text: catsText(byCat), ...base };
    if (n > BIG_TITLES) return { big: true, ...base };
    const text = fs.readFileSync(spool, 'utf8'); fs.rmSync(spool, { force: true });
    return { text, ...base };
  };
  return { run, result, file: spool || '' };
}
async function vodText(api, prog) {
  if (LOCAL_VOD.test(api)) return fsp.readFile(path.join(VODS, path.basename(api.slice(6))), 'utf8');
  if (!/^https?:\/\//.test(api)) throw new Error('不是点播源地址');
  const c = vodCollector(api, prog); await c.run(); return c.result();
}
// 聚合源 → one local list: every page of every member, same title (name + year) merged into one row whose lines are all the
// members' lines (each line named after its member); cover / details come from the first member that has them.
function groupCollector(g, prog, spool) {
  const merged = new Map(), report = [];
  const run = async () => {
    await Promise.all(g.memberSites.map(async m => {
      const r = { name: m.name, ok: false, n: 0, err: '' };
      report.push(r);
      try {
        const { failed } = await allPages(m, (pg, b) => {
          for (const d of b.list || []) {
            const it = item(m, d), ls = lineTexts(d).map(l => ({ ...l, name: `${m.name}${l.name && l.name !== m.name ? '·' + l.name : ''}`.replace(/[@|,\n$#]/g, ' ') }));
            if (!ls.length || !it.name) continue;
            const k = dedupKey(it), cat = str(d.type_name).replace(/[,\n]/g, ' ') || '未分类', meta = metaOf(d);
            if (!merged.has(k)) merged.set(k, { name: it.name.replace(/[,\n]/g, ' ').trim(), cat, lines: [], meta: {} });
            const t = merged.get(k);
            t.lines.push(...ls); r.n++;
            for (const f in meta) if (!t.meta[f] && meta[f]) t.meta[f] = meta[f];
          }
          if (prog) prog.titles = merged.size;
        }, prog, g.memberSites.length);
        r.ok = true; if (failed) r.err = `${failed} 页没取到`;
      } catch (e) { r.err = (e.message || '').replace(new RegExp('^' + m.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '：'), '').slice(0, 60); }
    }));
    if (prog?.cancel) throw new Error('已取消');
    if (!merged.size) throw new Error('成员里没有取到可直接播放的片' + (report.length ? '（' + report.map(r => `${r.name}：${r.err || '没有内容'}`).join('；') + '）' : ''));
  };
  const result = () => {
    const byCat = new Map();
    for (const t of merged.values()) { if (!byCat.has(t.cat)) byCat.set(t.cat, []); byCat.get(t.cat).push(vodRow(t.name, t.lines, t.meta)); }
    const base = { titles: merged.size, cats: byCat.size, merged: [...merged.values()].filter(t => t.lines.length > 1).length,
      members: report.map(r => ({ name: r.name, ok: r.ok, n: r.n, err: r.err })), partial: !!prog?.stop && prog.done < prog.total };
    if (!spool || merged.size <= BIG_TITLES) return { text: catsText(byCat), ...base };
    const fd = fs.openSync(spool, 'w');
    try { for (const [c, rows] of byCat) for (let i = 0; i < rows.length; i += 2000) fs.writeSync(fd, (i ? '' : `${c},#genre#\n`) + rows.slice(i, i + 2000).join('\n') + '\n\n'); } finally { fs.closeSync(fd); }
    return { big: true, ...base };
  };
  return { run, result, file: spool || '' };
}
async function groupText(g, prog) { const c = groupCollector(g, prog); await c.run(); return c.result(); }
// ---- 拉取任务: 在 leader 进程里跑，页面轮询进度 / 随时「先用已拉到的」/ 关掉页面 (超过 60 秒没人问) 自动取消 ----
const snapJobs = new Map();
function snapMembers(keys) {
  return keys.map(k => config.sites.find(x => x.key === k && x.api && !x.members)).filter(Boolean).filter(m => safety.level === 'all' || !m.adult);
}
rpcHandlers.vodSnap = async ({ op, id, api, keys, withText }) => {
  const j = snapJobs.get(id);
  if (op === 'start') {
    if (snapJobs.size >= 4) return { error: '同时拉取的任务太多了，等一个结束再试' };
    let col;
    const prog = { done: 0, total: 0, titles: 0, tier: PAGE_TIERS.map(() => ({ done: 0, total: 0 })), cancel: false, stop: false };
    if (Array.isArray(keys)) {
      const members = snapMembers(keys);
      if (!members.length) return { error: '这个聚合源的成员都不在已保存的源里（先点「保存」再试），或当前安全级别下不可用' };
      col = groupCollector({ memberSites: members }, prog, spoolPath(id));
    } else {
      if (!/^https?:\/\//.test(str(api))) return { error: '不是点播源地址' };
      col = vodCollector(str(api), prog, spoolPath(id));
    }
    const job = { id, prog, col, state: 'running', error: '', polled: Date.now(), at: Date.now() };
    snapJobs.set(id, job);
    job.timer = setInterval(() => { if (job.state === 'running' && Date.now() - job.polled > 60e3) prog.cancel = true; }, 5000);
    reqCtx.exit(() => col.run()).then(() => { job.state = 'done'; }, e => { job.state = 'error'; job.error = e.message; }).finally(() => {
      clearInterval(job.timer);
      setTimeout(() => { snapJobs.delete(id); if (!job.committed) fs.rm(spoolPath(id), { force: true }, () => {}); }, job.state === 'done' ? 30 * 60e3 : 10e3).unref?.();
    });
    return { id };
  }
  if (!j) return { error: '这个拉取任务已经结束或不存在' };
  j.polled = Date.now();
  if (op === 'stop') { j.prog.stop = true; return { ok: true }; }
  if (op === 'cancel') { j.prog.cancel = true; if (j.state !== 'running' && !j.committed) fs.rm(spoolPath(id), { force: true }, () => {}); return { ok: true }; }
  if (op === 'commit') {
    // 片太多 (BIG_TITLES) 的结果不进编辑器: 临时文件直接变成服务端的本地片单文件
    if (j.state !== 'done') return { error: '还没拉完' };
    const r = (j.result ||= j.col.result());
    if (!r.big) return { error: '这个结果要在编辑器里保存' };
    if (j.committed) return { error: '已经保存过了' };
    const file = crypto.randomBytes(5).toString('hex') + '.txt';
    await fsp.rename(spoolPath(id), path.join(VODS, file));
    j.committed = true;
    vodFileCache.clear();
    broadcastReload();
    return { api: 'local:' + file, titles: r.titles, cats: r.cats };
  }
  const p = j.prog;
  return { state: j.state, error: j.error, done: p.done, total: p.total, titles: p.titles, tier: p.tier, stopping: p.stop && j.state === 'running',
    ...(withText && j.state === 'done' ? (j.result ||= j.col.result()) : {}) };
};
// ---- 上游响应缓存：进程内存 (L1) + 磁盘 (L2，所有 worker 共用) ----
// 服务按 CPU 核数起多个 worker，请求落在哪个是随机的。只有进程内存缓存时，同一个分类在每个 worker 上各要现拉一次上游（1~4 秒），
// 表现就是同一个请求忽快忽慢。落盘后，一个 worker 拉过，其它 worker 直接读文件。过了 TTL 就作废，不给旧数据（新片更新要及时）。
const CMS_DIR = path.join(DATA, 'cms-cache');
fs.mkdirSync(CMS_DIR, { recursive: true });
const cmsFile = key => path.join(CMS_DIR, crypto.createHash('sha1').update(key).digest('hex') + '.json');
async function cmsDiskRead(key) {
  try { const j = JSON.parse(await fsp.readFile(cmsFile(key), 'utf8')); return j && j.body && j.at ? { at: j.at, body: j.body } : null; } catch { return null; }
}
async function cmsDiskWrite(key, e) {
  const f = cmsFile(key), tmp = f + '.' + process.pid + '.tmp';
  try { await fsp.writeFile(tmp, JSON.stringify(e)); await fsp.rename(tmp, f); } catch { fsp.unlink(tmp).catch(() => {}); }
}
if (IS_LEADER) setInterval(async () => {
  try {
    for (const n of await fsp.readdir(CMS_DIR)) {
      const f = path.join(CMS_DIR, n), st = await fsp.stat(f).catch(() => null);
      if (st && Date.now() - st.mtimeMs > TTL + 600e3) await fsp.unlink(f).catch(() => {});
    }
  } catch {}
}, 600e3).unref();
async function cmsGet(site, params, fresh = false, ms = 15000) {
  if (site.local) return localCms(params, '');
  if (LOCAL_VOD.test(str(site.api))) return fileCms(site.api, params);
  const u = new URL(site.api);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') u.searchParams.set(k, v);
  const key = u.toString();
  if (!fresh) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL) return hit.body;
    const d = await cmsDiskRead(key);                  // 别的 worker 刚拉过
    if (d && Date.now() - d.at < TTL) { cache.set(key, d); return d.body; }
  }
  return once('j|' + key, async signal => {
    let body;
    try { body = JSON.parse(await fetchText(key, ms, {}, signal)); } catch (e) { throw new Error(site.name + '：' + (/JSON/.test(e.message) ? '返回的不是 JSON' : e.message)); }
    const e = { at: Date.now(), body };
    cache.set(key, e);
    if (cache.size > 800) cache.delete(cache.keys().next().value);
    if (!fresh) cmsDiskWrite(key, e);                  // 扫库用的 fresh 请求体积大且只用一次，不落盘
    return body;
  });
}

// ---- 清晰度 ----
// Read off text that is already in hand (remarks / 版本 / title / episode names / url) — no extra requests.
// Exact resolution of what is about to play comes later from /api/probe, after the page is already shown.
const Q_RANK = { '抢先': 0, '标清': 1, '720P': 2, 'HD': 2, '超清': 3, '1080P': 4, '蓝光': 4, '4K': 5 };
const Q_RES = /(?<![0-9a-z])(2160|1080|720|576|480|360)[pi]?(?![0-9a-z])/i;
function qualityOf(...texts) {
  const t = texts.map(str).join(' ');
  if (!t.trim()) return '';
  if (/枪版|抢先|抢鲜|(?<![a-z])(hd)?(tc|cam|hdcam|hc)(?![a-z])/i.test(t)) return '抢先';
  if (/(?<![0-9a-z])4k(?![0-9a-z])|uhd|超高清|(?<![0-9a-z])2160/i.test(t)) return '4K';
  const m = Q_RES.exec(t);
  if (m) return { 2160: '4K', 1080: '1080P', 720: '720P' }[m[1]] || '标清';
  if (/蓝光|(?<![a-z])(bd|blu-?ray)(?![a-z])|全高清|fhd/i.test(t)) return '蓝光';
  if (/超清/.test(t)) return '超清';
  if (/(?<![a-z])hd(?![a-z])|高清/i.test(t)) return 'HD';
  if (/标清|(?<![a-z])sd(?![a-z])/i.test(t)) return '标清';
  return '';
}
const bestQuality = list => list.filter(Boolean).sort((a, b) => (Q_RANK[b] ?? -1) - (Q_RANK[a] ?? -1))[0] || '';
// Letterboxed films are wide but short, so judge by width as well as height.
const sizeQuality = (w, h) => (w >= 3000 || h >= 1900) ? '4K' : (w >= 1800 || h >= 1000) ? '1080P' : (w >= 1200 || h >= 700) ? '720P' : (w > 0 || h > 0) ? '标清' : '';

// ---- /api/probe?u=: real resolution of the stream about to play (called after the detail page is up) ----
// HLS master playlists list RESOLUTION per variant; media playlists don't say, so those stay unknown.
// Local files go to the media process (ffmpeg -i). Results are cached for a day; identical probes share one request.
const skipMarks = require('./skipmarks')({ ffmpeg: FFMPEG, ua: UA, file: path.join(DATA, 'skipmarks.json') });
const probeCache = new Map(), probeBusy = new Map();
rpcHandlers.skipmarks = ({ u, n }) => skipMarks(u, n);   // 只在主进程算 + 写缓存, 多个 worker 不会互相覆盖
let probeRunning = 0; const probeWait = [];
async function probeStream(u) {
  const hit = probeCache.get(u);
  if (hit && Date.now() - hit.at < 86400e3) return hit.v;
  if (probeBusy.has(u)) return probeBusy.get(u);
  const run = (async () => {
    if (probeRunning >= 6) await new Promise(ok => probeWait.push(ok));
    probeRunning++;
    try {
      let v = {};
      if (u.startsWith('/media/')) {
        const id = (/^\/media\/[fh]\/([0-9a-f]+)/.exec(u) || [])[1] || '';
        const f = localIndex().byFile.get(id);
        if (f && localCfg.enabled && localCatOk(localIndex().catById.get(f.item.cat))) v = await rpc('localProbe', { id }, 30000);
      } else if (/^https?:\/\//.test(u) && /\.m3u8(\?|$)/i.test(u)) {
        const r = await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(4000) });
        const text = r.ok ? (await r.text()).slice(0, 262144) : '';
        let w = 0, h = 0;
        for (const m of text.matchAll(/#EXT-X-STREAM-INF:[^\n]*RESOLUTION=(\d+)x(\d+)/gi)) if (+m[2] > h) { w = +m[1]; h = +m[2]; }
        if (h) v = { width: w, height: h };
      }
      const out = { ...v, quality: sizeQuality(v.width || 0, v.height || 0) };
      probeCache.set(u, { at: Date.now(), v: out });
      if (probeCache.size > 800) probeCache.delete(probeCache.keys().next().value);
      return out;
    } catch { return { quality: '' }; } // not cached: try again next time
    finally { probeRunning--; probeWait.shift()?.(); probeBusy.delete(u); }
  })();
  probeBusy.set(u, run);
  return run;
}

// 成人判定：本地源看文件夹标记；整站标成人的源全算；混合源按分类名（伦理/写真/无码…）识别。
function adultOf(site, d) {
  if (site.local) return localIndex().catById.get(str(d.type_id))?.adult ? 1 : 0;
  if (site.adult) return 1;
  return ADULT.test(str(d.type_name)) ? 1 : 0;
}
function item(site, d) {
  const adult = adultOf(site, d);
  return { site: site.key, siteName: site.name, id: str(d.vod_id), name: str(d.vod_name), pic: str(d.vod_pic),
    remarks: str(d.vod_remarks), type: str(d.type_name), typeId: str(d.type_id), year: str(d.vod_year), area: str(d.vod_area), time: str(d.vod_time),
    quality: qualityOf(d.vod_remarks, d.vod_version, d.vod_name), blurb: clean(d.vod_content).slice(0, 300),
    ...(adult ? { adult } : {}) };
}
// 成人 titles (flagged source / category / local folder) never leave the server outside 安全级别「全部」.
const itemOk = (site, it) => (safety.level === 'all' || !it.adult) && (!it.type || catAllowed(site, it.type));

function lines(d) {
  const froms = str(d.vod_play_from).split('$$$');
  return str(d.vod_play_url).split('$$$').map((u, i) => ({
    name: froms[i] || `线路${i + 1}`,
    // Only direct streams: "share" pages need a 解析 service and won't play.
    episodes: u.split('#').map(p => {
      const [a, b] = p.split('$');
      const url = (b === undefined ? a : b || '').trim();
      return { name: b === undefined ? '播放' : a, url };
    }).filter(e => (/^https?:\/\//.test(e.url) && /\.(m3u8|mp4)(\?|$)/i.test(e.url)) || e.url.startsWith('/media/')),
  })).filter(l => l.episodes.length).map(l => {
    // Line label ("hd" / "1080" / "蓝光" lines) and the file names are the best hints a source gives.
    const q = bestQuality([qualityOf(l.name), ...l.episodes.slice(0, 3).map(e => qualityOf(e.name, e.url.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*/, '')))]);
    return q ? { ...l, quality: q } : l;
  });
}

// ---- 聚合源: one entry that fans out to several 点播源 and merges the answers ----
// A member that fails is skipped for a minute, so one dead source never slows the rest down.
const deadUntil = new Map();
const dedupKey = it => it.name.replace(/\s+/g, '') + '|' + (it.year || '');
const catKey = n => str(n).replace(/片$/, '');
const packParts = parts => 'g.' + Buffer.from(JSON.stringify(parts)).toString('base64url');
const unpackParts = id => { try { return JSON.parse(Buffer.from(str(id).slice(2), 'base64url').toString('utf8')); } catch { return []; } };
async function eachMember(group, fn) {
  let ms = group.memberSites.filter(m => (deadUntil.get(m.key) || 0) < Date.now());
  if (!ms.length) ms = group.memberSites;
  const res = await Promise.all(ms.map(m => fn(m).then(v => ({ m, v }), () => { deadUntil.set(m.key, Date.now() + 60e3); return null; })));
  return res.filter(Boolean);
}
async function groupCategories(g) {
  const seen = new Map();
  for (const { v } of await eachMember(g, m => categories(m))) for (const c of v) if (!seen.has(catKey(c.name))) seen.set(catKey(c.name), { id: catKey(c.name), pid: '', name: c.name });
  return [...seen.values()];
}
async function memberList(site, t, pg) {
  // Whitelisted (e.g. 少儿) sites: "latest" comes from their first allowed category.
  if (!t && (site.categories || safety.level === 'kids')) t = (await categories(site))[0]?.id || '';
  const b = await cmsGet(site, { ac: 'detail', t, pg }, false, 8000);
  return { list: (b.list || []).map(d => item(site, d)).filter(it => itemOk(site, it)), page: Number(b.page) || 1, pagecount: Number(b.pagecount) || 1 };
}
async function groupList(g, t, pg) {
  const res = (await eachMember(g, async m => {
    let id = '';
    if (t) { const c = (await categories(m)).find(c => catKey(c.name) === t); if (!c) return null; id = c.id; }
    return memberList(m, id, pg);
  })).filter(r => r.v);
  const merged = new Map();
  const rounds = Math.max(0, ...res.map(r => r.v.list.length));
  for (let i = 0; i < rounds; i++) for (const { m, v } of res) {
    const it = v.list[i]; if (!it) continue;
    const k = dedupKey(it), e = merged.get(k);
    if (e) { e.parts.push([m.key, it.id]); if (!e.pic) e.pic = it.pic; }
    else merged.set(k, { ...it, parts: [[m.key, it.id]] });
  }
  return { list: [...merged.values()].map(({ parts, ...it }) => ({ ...it, ...(g.adult ? { adult: 1 } : {}), typeId: catKey(it.type), site: g.key, siteName: g.name, id: packParts(parts), sources: parts.length })),
    page: Number(pg) || 1, pagecount: Math.max(1, ...res.map(r => r.v.pagecount)) };
}
async function groupDetail(g, id) {
  const parts = unpackParts(id), found = new Map();
  const fetchOne = async (m, vid) => (await cmsGet(m, { ac: 'detail', ids: vid }, false, 8000).catch(() => ({}))).list?.[0];
  await Promise.all(parts.map(async ([k, vid]) => {
    const m = g.memberSites.find(x => x.key === k); if (!m) return;
    const d = await fetchOne(m, vid); if (d) found.set(m.key, { m, d });
  }));
  const first = [...found.values()][0];
  if (!first) return null;
  // Members that were not on the page this title came from: look the title up by name.
  const base = item(first.m, first.d), want = dedupKey(base);
  await Promise.all(g.memberSites.filter(m => !found.has(m.key) && (deadUntil.get(m.key) || 0) < Date.now()).map(async m => {
    const b = await cmsGet(m, { ac: 'detail', wd: base.name }, false, 8000).catch(() => null);
    const d = (b?.list || []).find(d => dedupKey(item(m, d)) === want);
    if (d) found.set(m.key, { m, d });
  }));
  return { first, all: [...found.values()] };
}

async function categories(site) {
  const b = await cmsGet(site, { ac: 'list' });
  const all = (b.class || []).map(c => ({ id: str(c.type_id), pid: str(c.type_pid), name: str(c.type_name) }));
  const parents = new Set(all.map(c => c.pid));
  // Top-level categories return empty lists on these sites; only leaves are useful.
  return all.filter(c => !parents.has(c.id) && catAllowed(site, c.name));
}

// TVBox configs: single or multi-warehouse `{urls:[…]}`. Keep what a browser can use.
const parseJsonLoose = text => JSON.parse(str(text).replace(/^\uFEFF/, '').replace(/^\s*\/\/.*$/gm, ''));
// Live entries are sometimes wrapped as proxy://do=live&…&ext=<base64 url>.
function unwrapLive(u) {
  u = str(u).trim();
  const ext = /^proxy:\/\/.*[?&]ext=([^&]+)/.exec(u);
  if (ext) { try { const d = Buffer.from(decodeURIComponent(ext[1]), 'base64').toString('utf8'); if (/^https?:\/\//.test(d)) return d; } catch {} }
  return u;
}
async function configFrom(obj, base, depth = 0) {
  const lives = (obj.lives || []).map(l => ({ ...l, url: unwrapLive(l.url) })).filter(l => /^https?:\/\//.test(l.url));
  let found = normalize({ sites: obj.sites, lives });
  if (Array.isArray(obj.urls) && depth === 0) {
    for (const sub of obj.urls.slice(0, 12)) {
      try {
        const f = await importFrom(base ? new URL(sub.url, base).toString() : new URL(sub.url).toString(), 1);
        found = normalize({ sites: [...found.sites, ...f.sites], lives: [...found.lives, ...f.lives] });
      } catch {}
    }
  }
  return found;
}
async function importFrom(url, depth = 0) {
  const text = await fetchText(url);
  let obj;
  try { obj = parseJsonLoose(text); } catch { throw new Error('不是 JSON（可能是加密/图片伪装的配置，浏览器端用不了）'); }
  return configFrom(obj, url, depth);
}

// 0 部内容的点播源（能连上，但一部片都没有）没有导入价值。连不上的不动：可能只是暂时的。
// Returns the sites without the empty ones, and how many were dropped. Category-whitelist and 聚合 entries are kept.
async function dropEmptySites(sites) {
  const todo = sites.filter(s => s.api && !s.members && !s.categories);
  const empty = new Set();
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, todo.length) }, async () => {
    while (next < todo.length) {
      const s = todo[next++];
      try {
        const b = await cmsGet({ name: '', api: s.api }, { ac: 'list' }, true, 10000);
        if (!(Number(b.total) > 0) && !(b.list || []).length) empty.add(s);
      } catch {}
    }
  }));
  return { sites: sites.filter(s => !empty.has(s)), dropped: empty.size };
}

// ======================= 自动分类: 成人 / 少儿 / 标准 =======================
// A 点播源 is judged by its category names: when 80 % or more of its (leaf) categories are 色情 words it is 成人, when 80 % or
// more are kids words it is 少儿, otherwise it stays 标准 (no flag). 成人 is checked first.
const CLS_ADULT = /伦理|三级|福利|写真|里番|两性|擦边|成人|情色|色情|激情|无码|有码|性感|午夜|黄色|偷拍|自拍|制服|丝袜|人妻|熟女|乱伦|萝莉|巨乳|口交|中出|强奸|调教|露出|诱惑|情欲|一本道|步兵|骑兵|porn|(^|[^a-z])av([^a-z]|$)/i;
const CLS_KIDS = /少儿|儿童|卡通|动画|动漫|亲子|早教|幼儿|宝宝|绘本|童话|儿歌|益智|启蒙/;
const CLS_RATIO = 0.8;
function classifyNames(names) {
  names = names.map(str).filter(Boolean);
  if (!names.length) return null;
  const adult = names.filter(n => CLS_ADULT.test(n)).length, kids = names.filter(n => CLS_KIDS.test(n)).length, n = names.length;
  return { total: n, adult, kids, kind: adult / n >= CLS_RATIO ? 'adult' : kids / n >= CLS_RATIO ? 'kids' : 'none' };
}
async function classifyApi(api) {
  const b = await cmsGet({ name: '', api }, { ac: 'list' }, true, 10000);
  const all = b.class || [], parents = new Set(all.map(c => str(c.type_pid)));
  const leaves = all.filter(c => !parents.has(str(c.type_id)));
  return classifyNames((leaves.length ? leaves : all).map(c => c.type_name));
}
// Classify many links, 8 at a time. Returns one result (or null: unreachable / no categories) per link.
async function classifyApis(apis) {
  const out = new Array(apis.length).fill(null);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, apis.length) }, async () => {
    while (next < apis.length) { const i = next++; try { out[i] = await classifyApi(apis[i]); } catch {} }
  }));
  return out;
}
// New sources arrive without flags: give them one (a source that already carries 少儿 / 成人 is left alone).
async function classifyNew(sites) {
  const todo = sites.filter(s => s.api && !s.members && !s.kids && !s.adult && !s.categories);
  const res = await classifyApis(todo.map(s => s.api));
  const n = { adult: 0, kids: 0 };
  todo.forEach((s, i) => { const k = res[i]?.kind; if (k === 'adult' || k === 'kids') { s[k] = 1; n[k]++; } });
  return n;
}

// One request per source (8 at a time): is it empty / unreachable, and which kind is it. Used before saving so that
// saving itself does no network work. Mutates the entries: ok/info for the row, adult/kids flags, empty/probed markers.
async function probeSites(sites, onProgress = () => {}) {
  const todo = sites.filter(s => s.api && !s.members && s.ok !== false);
  let next = 0, fin = 0;
  await Promise.all(Array.from({ length: Math.min(8, todo.length) }, async () => {
    while (next < todo.length) {
      const s = todo[next++];
      try {
        let b, err;
        for (let k = 0; k < 2 && !b; k++) { try { b = await cmsGet({ name: '', api: s.api }, { ac: 'list' }, true, k ? 14000 : 9000); } catch (e) { err = e; } }   // one retry: a busy scan must not condemn a working source
        if (!b) throw err;
        if (!(Number(b.total) > 0) && !(b.list || []).length) { s.ok = false; s.empty = true; s.info = '0 部内容，不导入'; continue; }
        const all = b.class || [], parents = new Set(all.map(c => str(c.type_pid)));
        const leaves = all.filter(c => !parents.has(str(c.type_id)));
        const k = classifyNames((leaves.length ? leaves : all).map(c => c.type_name))?.kind;
        if (!s.kids && !s.adult && (k === 'adult' || k === 'kids')) s[k] = 1;
        s.ok = true; s.info = (Number(b.total) > 0 ? b.total + '部' : (s.info || '能连上')) + (s.note ? ' · ' + s.note : '');
      } catch (e) { s.ok = false; s.info = '连不上：' + (e.message || '').replace(/^[^：]{0,30}：/, '').slice(0, 40); }
      s.probed = true; onProgress(++fin, todo.length);
    }
  }));
}

// Live sources that came out of a pasted TVBox config were never opened: open them now (8 at a time) so the list says
// reachable / how many channels / empty before anything is saved.
async function probeLives(lives, onProgress = () => {}) {
  const todo = lives.filter(l => l.url && /^https?:\/\//.test(l.url) && l.ok === undefined);
  let next = 0, fin = 0;
  await Promise.all(Array.from({ length: Math.min(8, todo.length) }, async () => {
    while (next < todo.length) {
      const l = todo[next++];
      try {
        const p = await peek(l.url);
        const c = p.stream ? { kind: 'stream' } : classifyText(p.text);
        if (c?.kind === 'list' && c.channels > 0) { l.ok = true; l.info = `${c.channels} 个频道`; }
        else if (c?.kind === 'stream') { l.ok = true; l.info = '直播流'; }
        else { l.ok = false; l.empty = true; l.info = '打开了但没有频道，不导入'; }
      } catch (e) { l.ok = false; l.info = '连不上：' + (e.message || '').replace(/^[^：]{0,30}：/, '').slice(0, 40); }
      l.probed = true; onProgress(++fin, todo.length);
    }
  }));
}

// ======================= clipboard recognition =======================
// Pasted text → 点播 sites / 直播 sources. Each link is fetched and classified by what it actually
// returns (苹果CMS JSON, TVBox config, m3u/txt list, single stream); names come from the text on the
// same line. Results are marked `exists` against the current config so the client can add only new ones.
const VOD_HINT = /provide\/vod|\/api\.php|\/inc\/api|\/at\/(json|xml)|\/(xml|json)\.php/i;
const LIVE_HINT = /\.(m3u8?|txt)(\?|$)/i;
const STREAMISH = /\.(m3u8|flv|ts|mp4|mpd)(\?|$)|^(rtmp|rtsp):/i;

function normApi(u) {
  try {
    const x = new URL(str(u).trim());
    for (const k of ['ac', 'pg', 't', 'wd', 'ids', 'h']) x.searchParams.delete(k);
    x.hash = '';
    return x.toString().replace(/\/+(?=\?|$)/, '');
  } catch { return str(u).trim(); }
}
function normUrl(u) { try { const x = new URL(str(u).trim()); x.hash = ''; return x.toString(); } catch { return str(u).trim(); } }
const hostOf = u => { try { return new URL(u).hostname.replace(/^(www|api|cj|caiji|collect|m3u8)\./, ''); } catch { return str(u).slice(0, 30); } };
const cleanName = t => str(t).replace(/^[\s\d.、)）\-*•#>\[【(（]+/, '').replace(/[\s:：,，\-—|=>【】\[\]()（）]+$/, '').trim().slice(0, 24);
const textKey = t => crypto.createHash('md5').update(str(t).replace(/\r/g, '').trim()).digest('hex');

async function peek(url, max = 2e6) {
  const r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(8000) });
  if (!r.ok) { r.body?.cancel().catch(() => {}); throw new Error(`HTTP ${r.status}`); }
  const type = r.headers.get('content-type') || '';
  if (/^(video|audio)\//i.test(type) || (/octet-stream/i.test(type) && STREAMISH.test(url))) { r.body?.cancel().catch(() => {}); return { stream: true, final: r.url }; }
  if (/^image\//i.test(type)) { r.body?.cancel().catch(() => {}); return { text: '', final: r.url }; }
  const chunks = []; let n = 0;
  const reader = r.body.getReader();
  while (n < max) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); n += value.length; }
  reader.cancel().catch(() => {});
  return { text: Buffer.concat(chunks).toString('utf8'), final: r.url };
}

// 苹果CMS also serves the same data as XML (…/xml.php, …/at/xml): the browser client reads JSON, so an XML link is swapped for
// its JSON twin (json.php, at/json, or the plain provide/vod link) — whichever of them really answers with a title list.
const isCmsXml = t => /^\s*(<\?xml[^>]*>\s*)?<rss[\s>]/i.test(t) && /<list[\s>]/i.test(t);
function jsonTwins(url) {
  const out = [];
  try {
    const u = new URL(url);
    const swap = p => { const x = new URL(u); x.pathname = p; return x.toString(); };
    if (/\/xml\.php$/i.test(u.pathname)) out.push(swap(u.pathname.replace(/xml\.php$/i, 'json.php')));
    if (/\/at\/xml\/?$/i.test(u.pathname)) out.push(swap(u.pathname.replace(/\/at\/xml\/?$/i, '/at/json/')), swap(u.pathname.replace(/\/at\/xml\/?$/i, '/')));
    if (/\/provide\/vod\/?$/i.test(u.pathname)) out.push(u.toString());
    if (!out.length) { out.push(swap(u.pathname.replace(/xml(\.\w+)?$/i, 'json$1'))); }
  } catch {}
  return [...new Set(out)].filter(x => x !== url);
}
async function xmlToJson(url, xmlText) {
  const m = /recordcount="(\d+)"/i.exec(xmlText), count = m ? Number(m[1]) : 0;
  for (const cand of jsonTwins(url)) {
    try {
      const p = await peek(cand);
      const c = p.stream ? null : classifyText(p.text);
      if (c?.kind === 'vod') return { api: cand, c };
    } catch {}
  }
  return { api: '', count };
}

function classifyText(text) {
  const t = str(text).trim();
  if (!t) return null;
  if (isCmsXml(t)) return { kind: 'cms-xml' };
  if (/^[{[]/.test(t)) {
    try {
      const o = parseJsonLoose(t);
      if (o && (o.sites || o.urls || o.lives)) return { kind: 'config', obj: o };
      if (o && (Array.isArray(o.class) || Array.isArray(o.list))) return { kind: 'vod', total: Number(o.total) || 0, count: (o.list || []).length };
    } catch {}
  }
  if (/#EXT-X-(TARGETDURATION|STREAM-INF|MEDIA-SEQUENCE)/.test(t)) return { kind: 'stream' };
  if (/#EXTINF|#genre#/.test(t)) return { kind: 'list', channels: parseLive(t).groups.reduce((n, g) => n + g.channels.length, 0) };
  const rows = t.split(/\r?\n/).filter(l => /^[^,#\s][^,]{0,40},\s*(https?|rtmp|rtsp):\/\//.test(l.trim()));
  if (rows.length >= 2) return { kind: 'list', channels: parseLive(t).groups.reduce((n, g) => n + g.channels.length, 0) || rows.length };
  return null;
}

async function recognize(input, emit = () => {}) {
  const text = str(input).slice(0, 2e6);
  let sites = [], lives = [];
  const unknown = [], repoNotes = [];
  const direct = classifyText(text);
  if (direct?.kind === 'config') {
    // Exported source sets embed edited / local channel lists as {name, text}; keep those as pasted lists.
    const embedded = (Array.isArray(direct.obj.lives) ? direct.obj.lives : []).filter(l => l && typeof l.text === 'string' && l.text.trim());
    const embeddedVod = (Array.isArray(direct.obj.sites) ? direct.obj.sites : []).filter(s => s && typeof s.text === 'string' && s.text.trim());
    const f = await configFrom({ ...direct.obj, sites: (direct.obj.sites || []).filter(s => !(s && typeof s.text === 'string')), lives: (direct.obj.lives || []).filter(l => !(l && l.text)) }, null);
    sites = [...f.sites.map(s => ({ ...s, info: '来自粘贴的配置' })),
      ...embeddedVod.map(s => { const n = parseVodText(s.text).items.length;
        return { name: str(s.name) || '分享的片单', text: s.text.trim() + '\n', ok: n > 0, ...(n ? {} : { empty: true }), info: n ? `${n} 部（含片单文本）` : '片单里没有可播放的片，不导入', ...(Number(s.kids) ? { kids: 1 } : {}), ...(Number(s.adult) ? { adult: 1 } : {}) }; })];
    lives = [...f.lives.map(l => ({ ...l, info: '来自粘贴的配置' })),
      ...embedded.map(l => { const n = parseLive(l.text).groups.reduce((a, g) => a + g.channels.length, 0);
        return { name: str(l.name) || '分享的频道', text: l.text.trim() + '\n', ok: n > 0, ...(n > 0 ? {} : { empty: true }), info: n > 0 ? `${n} 个频道（含频道列表）` : '0 个频道，不导入' }; })];
  } else if (direct?.kind === 'list') {
    lives.push({ name: `剪贴板频道 ${direct.channels}台`, text: text.trim() + '\n', ok: direct.channels > 0, ...(direct.channels > 0 ? {} : { empty: true }), info: direct.channels > 0 ? `${direct.channels} 个频道` : '0 个频道，不导入' });
  } else {
    const found = new Map();
    for (const line of text.split(/\r?\n/)) {
      const re = /(?:https?|rtmp|rtsp):\/\/[^\s"'<>，。；、）)】\]]+/g;
      let m, last = 0;
      while ((m = re.exec(line))) {
        const url = m[0].replace(/[.,;:!?'"]+$/, '');
        const name = cleanName(line.slice(last, m.index));
        last = m.index + m[0].length;
        if (!found.has(normUrl(url))) found.set(normUrl(url), { url, name });
      }
    }
    const entries = [...found.values()].slice(0, 30);
    // Repository links (GitHub / Gitee / GitLab / Codeberg): walk the repo instead of fetching the page.
    const repoJobs = [];
    for (const e of entries) { const rp = parseRepoUrl(e.url); if (rp) { e.repo = rp; repoJobs.push(e); } }
    const repoIsFile = e => e.repo?.mode === 'file';
    for (const e of repoJobs.filter(e => !repoIsFile(e))) {
      try { const r = await recognizeRepo(e.repo, e.url, emit); sites.push(...r.sites); lives.push(...r.lives); r.unknown.forEach(u => unknown.push(u)); repoNotes.push(...r.notes); }
      catch (err) { repoNotes.push(`${hostOf(e.url)}：${err.message}`); lives.push({ name: e.repo.repo, url: e.url, ok: false, info: err.message }); }
    }
    const results = await Promise.all(entries.filter(e => !e.repo || repoIsFile(e)).map(async e => {
      const host = hostOf(e.url);
      let p = null, c = null;
      if (/^https?:/i.test(e.url)) {
        try { p = await peek(e.url); c = p.stream ? { kind: 'stream' } : classifyText(p.text); } catch (err) { p = { error: err.message }; }
      } else c = { kind: 'stream' };
      const why = p?.error ? '不通：' + p.error : '';
      if (c?.kind === 'cms-xml') {
        const x = await xmlToJson(e.url, p.text);
        if (!x.api) return { sites: [{ name: e.name || host, api: normApi(e.url), ok: false, info: `这是 XML 接口（${x.count} 条），没找到对应的 JSON 接口，浏览器版用不了` }] };
        c = x.c; e.url = x.api; p = { ...p, note: '已换成 JSON 接口' };
      }
      if (c?.kind === 'vod') return c.total > 0 || c.count > 0 ? { sites: [{ name: e.name || host, api: normApi(e.url), ok: true, info: `${c.total || c.count}部`, ...(p?.note ? { note: p.note } : {}) }] } : { sites: [{ name: e.name || host, api: normApi(e.url), ok: false, empty: true, info: '0 部内容，不导入' }] };
      if (c?.kind === 'config') {
        const f = await configFrom(c.obj, p.final || e.url);
        const info = `来自配置 ${e.name || host}`;
        return { sites: f.sites.map(s => ({ ...s, info })), lives: f.lives.map(l => ({ ...l, info })) };
      }
      if (c?.kind === 'list') return { lives: [c.channels > 0 ? { name: e.name || host, url: e.url, ok: true, info: `${c.channels} 个频道` } : { name: e.name || host, url: e.url, ok: false, empty: true, info: '0 个频道，不导入' }] };
      if (c?.kind === 'stream') return { single: { ...e, ok: true } };
      if (VOD_HINT.test(e.url)) return { sites: [{ name: e.name || host, api: normApi(e.url), ok: false, info: why || '返回的不是苹果CMS JSON' }] };
      if (STREAMISH.test(e.url) && !/\.txt|\.m3u(\?|$)/i.test(e.url)) return { single: { ...e, ok: false, info: why } };
      if (LIVE_HINT.test(e.url)) return { lives: [{ name: e.name || host, url: e.url, ok: false, ...(why ? {} : { empty: true }), info: why || '0 个频道，不导入' }] };   // opened fine but nothing in it: not importable
      return { unknown: e.url };
    }));
    const singles = [];
    for (const r of results) {
      if (r.sites) sites.push(...r.sites);
      if (r.lives) lives.push(...r.lives);
      if (r.single) singles.push(r.single);
      if (r.unknown) unknown.push(r.unknown);
    }
    if (singles.length) {
      const body = singles.map(s => `#EXTINF:-1 group-title="剪贴板",${s.name || hostOf(s.url)}\n${s.url}`).join('\n');
      const alive = singles.filter(s => s.ok).length;
      lives.push({ name: singles.length === 1 ? (singles[0].name || '剪贴板直播') : `剪贴板频道 ${singles.length}台`,
        text: '#EXTM3U\n' + body + '\n', ok: alive > 0, info: `${singles.length} 条直播流，${alive} 条能连上` });
    }
  }

  // De-duplicate inside the paste, then against what is configured.
  const haveApi = new Set(config.sites.filter(s => !s.categories).map(s => normApi(s.api)));
  const haveUrl = new Set(config.lives.flatMap(l => [normUrl(l.url), l.from ? normUrl(l.from) : '']).filter(Boolean));
  const haveText = new Set();
  for (const f of await fsp.readdir(LIVES).catch(() => [])) {
    if (config.lives.some(l => l.url === 'local:' + f)) haveText.add(textKey(await fsp.readFile(path.join(LIVES, f), 'utf8').catch(() => '')));
  }
  const haveVodText = new Set();
  for (const s of config.sites) if (LOCAL_VOD.test(str(s.api))) haveVodText.add(textKey(await fsp.readFile(path.join(VODS, path.basename(s.api.slice(6))), 'utf8').catch(() => '')));
  const seenS = new Set(), seenL = new Set();
  // Same link under different names or category whitelists (every repo file has its own copy of the popular ones) is one source:
  // keep the first, and prefer the plain entry over a whitelisted one.
  const plainApi = new Set(sites.filter(s => s.api && !s.categories && !s.members).map(s => normApi(s.api)));
  sites = sites.filter(s => {
    if (s.categories && !s.members && plainApi.has(normApi(s.api))) return false;   // the plain copy already covers it
    const k = s.text ? 't|' + textKey(s.text) : s.members ? 'g|' + s.name + '|' + s.members.join(',') : normApi(s.api);
    return !seenS.has(k) && seenS.add(k);
  })
    .map(s => s.text ? { ...s, exists: haveVodText.has(textKey(s.text)) } : s.members ? { ...s, exists: config.sites.some(g => g.members && g.name === s.name) } : { ...s, api: normApi(s.api), exists: !s.categories && haveApi.has(normApi(s.api)) });
  lives = lives.filter(l => { const k = l.text ? textKey(l.text) : normUrl(l.url); return !seenL.has(k) && seenL.add(k); })
    .map(l => ({ ...l, exists: l.text ? haveText.has(textKey(l.text)) : haveUrl.has(normUrl(l.url)) }));
  const nS = sites.filter(s => !s.exists).length, nL = lives.filter(l => !l.exists).length;
  if (nS + nL > 6) emit({ t: 'progress', msg: `去重完成：新点播源 ${nS}、新直播源 ${nL}（已存在的自动跳过），正在检测是否连得通、有没有内容…`, phase: 'probe' });
  await Promise.all([probeSites(sites.filter(s => !s.exists), (d, n) => emit({ t: 'progress', msg: `检测点播源 ${d}/${n}`, phase: 'probe', done: d, total: n })), probeLives(lives.filter(l => !l.exists), (d, n) => emit({ t: 'progress', msg: `检测直播源 ${d}/${n}`, phase: 'probe', done: d, total: n }))]);
  return { sites, lives, unknown, notes: repoNotes };
}

// ======================= code hosting repos =======================
// A pasted link to a repository (GitHub / Gitee / GitLab / Codeberg…, a branch, tag or commit, a sub-folder or a single file) is
// walked: every text-like file that could be a source set is fetched, classified by what it really contains (never by folder
// layout), de-duplicated and probed like any other pasted link. Progress is streamed to the client (NDJSON).
const GH_TOKEN = () => process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const GITEE_TOKEN = () => process.env.GITEE_TOKEN || '';
const GITLAB_TOKEN = () => process.env.GITLAB_TOKEN || '';
const REPO_HOSTS = {
  'github.com': 'github', 'www.github.com': 'github',
  'gitee.com': 'gitee', 'www.gitee.com': 'gitee',
  'gitlab.com': 'gitlab', 'www.gitlab.com': 'gitlab',
  'codeberg.org': 'forgejo', 'www.codeberg.org': 'forgejo',
};
const SKIP_DIR = /(^|\/)(\.git|\.github|node_modules|jar|jars|js|css|img|image|images|icons?|pic|pics|logo|logos|fonts?|assets|apk|so|dex|lib|libs|__MACOSX)(\/|$)/i;
const SKIP_EXT = /\.(jar|apk|zip|rar|7z|gz|tgz|bz2|xz|png|jpe?g|gif|webp|bmp|ico|svg|woff2?|ttf|otf|eot|mp4|mkv|avi|mov|flv|ts|mp3|aac|flac|wav|exe|dll|so|dex|bin|dat|db|pdf|docx?|xlsx?|pptx?|js|css|html?|md|py|java|kt|sh|bat|lock|map|yml|yaml|toml|ini|cfg|gitignore|gitattributes|license|sql|csv)$/i;
const TEXT_EXT = /\.(json|txt|m3u8?|xml|list|conf|text|php)$/i;
const MAX_REPO_FILE = 3e6;     // bigger than this is not a source list
const MAX_REPO_FILES = 400;    // files actually fetched per repository
const rawHeaders = host => { const h = { 'User-Agent': UA }; return h; };

// Which repo + ref + path does this URL point at? Branch names may contain "/", so the ref is resolved against the repo.
function parseRepoUrl(u) {
  let x; try { x = new URL(u); } catch { return null; }
  const host = x.hostname.toLowerCase(), segs = x.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (host === 'raw.githubusercontent.com' && segs.length >= 4)
    return { kind: 'github', host: 'github.com', owner: segs[0], repo: segs[1], rest: segs.slice(2), mode: 'file' };
  const kind = REPO_HOSTS[host]; if (!kind || segs.length < 2) return null;
  const owner = segs[0], repo = segs[1].replace(/\.git$/, '');
  if (/^(topics|orgs|settings|marketplace|explore|search|about|features|pricing|enterprise|login|sponsors|collections|trending|events|notifications|new)$/i.test(owner)) return null;
  const base = { kind, host: host.replace(/^www\./, ''), owner, repo };
  const tail = segs.slice(2);
  if (kind === 'gitlab') {                       // gitlab: …/-/tree|blob|raw/<ref>/<path>, projects may sit in sub-groups
    const dash = segs.indexOf('-');
    if (dash >= 2) { const project = segs.slice(0, dash); return { ...base, owner: project.slice(0, -1).join('/'), repo: project[project.length - 1], ...refPart(segs.slice(dash + 1)) }; }
    return { ...base, rest: [], mode: 'repo' };
  }
  return { ...base, ...refPart(tail) };
}
function refPart(t) {
  const m = /^(tree|blob|raw|src|-|commits?)$/.exec(t[0] || '');
  if (!t.length) return { rest: [], mode: 'repo' };
  if (t[0] === 'tree' || (t[0] === 'src' && ['branch', 'tag', 'commit'].includes(t[1]))) {
    const skip = t[0] === 'src' ? 2 : 1; return { rest: t.slice(skip), mode: 'tree' };
  }
  if (t[0] === 'blob' || t[0] === 'raw') return { rest: t.slice(1), mode: 'file' };
  if (t[0] === 'releases' || t[0] === 'issues' || t[0] === 'pulls' || t[0] === 'wiki') return { rest: [], mode: 'repo' };
  return { rest: [], mode: 'repo' };
}

async function jget(url, headers = {}, ms = 15000) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers }, redirect: 'follow', signal: AbortSignal.timeout(ms) });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch {}
  return { status: r.status, json: j, text, headers: r.headers };
}
function apiBase(repo) {
  const e = encodeURIComponent;
  if (repo.kind === 'github') return { tree: ref => `https://api.github.com/repos/${e(repo.owner)}/${e(repo.repo)}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    info: `https://api.github.com/repos/${e(repo.owner)}/${e(repo.repo)}`, commit: ref => `https://api.github.com/repos/${e(repo.owner)}/${e(repo.repo)}/commits/${encodeURIComponent(ref)}`,
    headers: GH_TOKEN() ? { Authorization: 'Bearer ' + GH_TOKEN(), 'X-GitHub-Api-Version': '2022-11-28' } : {} };
  if (repo.kind === 'gitee') return { tree: ref => `https://gitee.com/api/v5/repos/${e(repo.owner)}/${e(repo.repo)}/git/trees/${encodeURIComponent(ref)}?recursive=1${GITEE_TOKEN() ? '&access_token=' + GITEE_TOKEN() : ''}`,
    info: `https://gitee.com/api/v5/repos/${e(repo.owner)}/${e(repo.repo)}${GITEE_TOKEN() ? '?access_token=' + GITEE_TOKEN() : ''}`, headers: {} };
  if (repo.kind === 'forgejo') return { tree: ref => `https://${repo.host}/api/v1/repos/${e(repo.owner)}/${e(repo.repo)}/git/trees/${encodeURIComponent(ref)}?recursive=true&per_page=10000`,
    info: `https://${repo.host}/api/v1/repos/${e(repo.owner)}/${e(repo.repo)}`, headers: {} };
  const pid = encodeURIComponent(repo.owner + '/' + repo.repo);
  return { info: `https://gitlab.com/api/v4/projects/${pid}`, treeGl: (ref, page) => `https://gitlab.com/api/v4/projects/${pid}/repository/tree?ref=${encodeURIComponent(ref)}&recursive=true&per_page=100&page=${page}`,
    headers: GITLAB_TOKEN() ? { 'PRIVATE-TOKEN': GITLAB_TOKEN() } : {} };
}
function rawUrl(repo, ref, p) {
  const path_ = p.split('/').map(encodeURIComponent).join('/'), o = encodeURIComponent(repo.owner), r = encodeURIComponent(repo.repo);
  if (repo.kind === 'github') return `https://raw.githubusercontent.com/${o}/${r}/${encodeURIComponent(ref)}/${path_}`;
  if (repo.kind === 'gitee') return `https://gitee.com/${o}/${r}/raw/${encodeURIComponent(ref)}/${path_}`;
  if (repo.kind === 'forgejo') return `https://${repo.host}/${o}/${r}/raw/branch/${encodeURIComponent(ref)}/${path_}`;
  return `https://gitlab.com/${repo.owner.split('/').map(encodeURIComponent).join('/')}/${r}/-/raw/${encodeURIComponent(ref)}/${path_}`;
}

// Walk the tree through the host's API. Returns { files: [{path,size}], ref, note }.
async function listRepoApi(repo, ref, say) {
  const A = apiBase(repo);
  if (repo.kind === 'gitlab') {
    const files = [];
    for (let page = 1; page <= 40; page++) {
      const r = await jget(A.treeGl(ref, page), A.headers);
      if (r.status === 404) throw Object.assign(new Error('NOREF'), { code: 404 });
      if (r.status >= 400 || !Array.isArray(r.json)) throw new Error(`GitLab 接口 HTTP ${r.status}`);
      for (const x of r.json) if (x.type === 'blob') files.push({ path: x.path, size: 0 });
      say(`正在读取目录… 已发现 ${files.length} 个文件`);
      if (r.json.length < 100) break;
    }
    return { files, ref };
  }
  const r = await jget(A.tree(ref), A.headers);
  if (r.status === 404 || r.status === 422) throw Object.assign(new Error('NOREF'), { code: 404 });
  if (r.status === 403 || r.status === 429) throw Object.assign(new Error('RATE'), { code: 403, reset: r.headers.get('x-ratelimit-reset') });
  if (r.status >= 400 || !r.json) throw new Error(`HTTP ${r.status}`);
  const tree = Array.isArray(r.json.tree) ? r.json.tree : [];
  return { files: tree.filter(x => x.type === 'blob').map(x => ({ path: x.path, size: Number(x.size) || 0 })), ref, truncated: !!r.json.truncated };
}
// GitHub without (or beyond) API quota: the folder pages carry their listing as embedded JSON; read them folder by folder.
async function listGithubHtml(repo, ref, startDir, say) {
  const files = [], queue = [startDir], seen = new Set();
  let dirs = 0;
  while (queue.length && dirs < 200) {
    const dir = queue.shift(); if (seen.has(dir)) continue; seen.add(dir); dirs++;
    const url = `https://github.com/${repo.owner}/${repo.repo}/tree/${ref.split('/').map(encodeURIComponent).join('/')}${dir ? '/' + dir.split('/').map(encodeURIComponent).join('/') : ''}`;
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) { if (dirs === 1) throw Object.assign(new Error('NOREF'), { code: 404 }); continue; }
    const html = await r.text();
    const m = /<script type="application\/json" data-target="react-app\.embeddedData">([\s\S]*?)<\/script>/.exec(html);
    let items = null;
    if (m) { try { const walk = o => { if (o && typeof o === 'object') { if (o.tree && Array.isArray(o.tree.items)) return o.tree.items; for (const v of Object.values(o)) { const f = walk(v); if (f) return f; } } return null; }; items = walk(JSON.parse(m[1])); } catch {} }
    if (!items) { if (dirs === 1) throw new Error('网页结构变了，读不到目录'); continue; }
    for (const it of items) { if (it.contentType === 'directory') { if (!SKIP_DIR.test(it.path + '/')) queue.push(it.path); } else files.push({ path: it.path, size: 0 }); }
    say(`正在读取目录（网页方式）… 已读 ${dirs} 个文件夹，发现 ${files.length} 个文件`);
  }
  return { files, ref, note: '没有 API 额度，改用网页方式读目录（较慢，也读不到文件大小）' };
}

// Split "ref/and/path" into a real ref + path: try the longest ref candidate that exists.
async function resolveRef(repo, say) {
  const A = apiBase(repo), segs = repo.rest || [];
  let def = '';
  const info = await jget(A.info, A.headers).catch(() => null);
  if (info?.status === 404 && repo.mode !== 'repo') throw new Error('仓库不存在或是私有仓库');
  if (info?.json) def = info.json.default_branch || info.json.defaultBranch || '';
  if (repo.mode === 'repo' || !segs.length) return { ref: def || 'HEAD', path: '', def, info: info?.json || null };
  // Candidates from longest to shortest ref; the first that the host recognises wins.
  for (let n = Math.min(segs.length, 6); n >= 1; n--) {
    const ref = segs.slice(0, n).join('/'), p = segs.slice(n).join('/');
    if (repo.kind === 'github' && info?.json) {
      const c = await jget(A.commit(ref), A.headers).catch(() => null);
      if (c?.status === 200) return { ref, path: p, def, info: info.json };
      if (c?.status === 403 || c?.status === 429) break;   // no quota: fall back to the first guess below
    } else if (repo.kind === 'gitlab') {
      const c = await jget(`https://gitlab.com/api/v4/projects/${encodeURIComponent(repo.owner + '/' + repo.repo)}/repository/commits/${encodeURIComponent(ref)}`, A.headers).catch(() => null);
      if (c?.status === 200) return { ref, path: p, def, info: info?.json || null };
    } else if (repo.kind === 'gitee') {
      const c = await jget(`https://gitee.com/api/v5/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/commits/${encodeURIComponent(ref)}${GITEE_TOKEN() ? '?access_token=' + GITEE_TOKEN() : ''}`).catch(() => null);
      if (c?.status === 200) return { ref, path: p, def, info: info?.json || null };
    } else {
      const c = await jget(`https://${repo.host}/api/v1/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/git/commits/${encodeURIComponent(ref)}`).catch(() => null);
      if (c?.status === 200) return { ref, path: p, def, info: info?.json || null };
    }
  }
  // Could not verify (rate limited, offline API): assume the common shape ref = first segment (folder or file after it).
  return { ref: segs[0], path: segs.slice(1).join('/'), def, info: info?.json || null, guessed: true };
}

// Is this file worth fetching? Folder layout is not a criterion; names and sizes only rule out the obviously useless.
function repoCandidate(f, under) {
  const p = f.path;
  if (under && !(p === under || p.startsWith(under + '/'))) return false;
  if (SKIP_DIR.test(p + '/') && !/\.(json|txt|m3u8?)$/i.test(p)) return false;
  if (/(^|\/)(package(-lock)?\.json|tsconfig.*\.json|composer\.json|\.eslintrc.*|manifest\.json|config\.json\.example)$/i.test(p)) return false;
  if (f.size && f.size > MAX_REPO_FILE) return false;
  const base = p.split('/').pop();
  if (TEXT_EXT.test(base)) return true;
  if (SKIP_EXT.test(base)) return false;
  return !/\./.test(base);          // extension-less files (TVBox people often name them "tv", "live", "bk") are worth a look
}
const repoPri = p => /(^|\/)(tv|live|vod|box|tvbox|config|source|sources|api|json|m3u8?|iptv|zb|bk|dianbo|zhibo)[^/]*$/i.test(p) ? 0 : /\.(json|m3u8?|txt)$/i.test(p) ? 1 : 2;

// ---- classify one fetched file's content ----
async function classifyRepoFile(rel, url, text) {
  const t = str(text).trim();
  if (!t || t.length < 12) return { skip: '空文件' };
  if (/^<!doctype html|^<html/i.test(t)) return { skip: '网页' };
  const c = classifyText(t);
  const name = rel.split('/').pop().replace(/\.[^.]+$/, '');
  if (!c) return { skip: '不是源列表' };
  if (c.kind === 'cms-xml') return { skip: 'XML 接口，不是文件' };
  return { c, name, url, text: t };
}

async function recognizeRepo(repo, url, emit) {
  const say = (msg, extra = {}) => emit({ t: 'progress', msg, ...extra });
  const out = { sites: [], lives: [], unknown: [], notes: [] };
  const where = `${repo.host}/${repo.owner}/${repo.repo}`;
  say(`识别为 ${repo.kind === 'github' ? 'GitHub' : repo.kind === 'gitee' ? 'Gitee' : repo.kind === 'gitlab' ? 'GitLab' : 'Codeberg'} 仓库：${where}`, { phase: 'repo' });
  const R = await resolveRef(repo, say);
  let ref = R.ref, under = R.path;
  if (repo.mode === 'file' && under) { /* single file inside a repo */ }
  say(`分支/版本：${ref}${under ? '，范围：' + under : ''}${R.guessed ? '（无法核对，按常见写法猜测）' : ''}`, { phase: 'ref' });

  let files = [], note = '';
  if (repo.mode === 'file') files = [{ path: under, size: 0 }];
  else {
    try { ({ files, note } = await listRepoApi(repo, ref, say)); }
    catch (e) {
      if (e.code === 404 && R.def && ref !== R.def && R.guessed) { ref = R.def; say(`找不到 ${R.ref}，改用默认分支 ${ref}`); ({ files, note } = await listRepoApi(repo, ref, say).catch(() => ({ files: [] }))); }
      else if ((e.code === 403 || e.message === 'RATE') && repo.kind === 'github') {
        out.notes.push('GitHub API 额度用完' + (GH_TOKEN() ? '（已带 token）' : '：设置环境变量 GITHUB_TOKEN 可提升到每小时 5000 次') + '，改用网页方式读目录');
        say('GitHub API 被限流，改用网页方式读目录（较慢）…');
        ({ files, note } = await listGithubHtml(repo, ref, under, say).catch(err => { throw new Error('读不到目录：' + err.message); }));
      } else throw new Error(e.code === 404 ? `找不到 ${ref}（分支、标签或提交不存在，或者是私有仓库）` : '读取目录失败：' + e.message);
    }
    if (note) out.notes.push(note);
  }
  const totalFiles = files.length;
  let cand = files.filter(f => repoCandidate(f, repo.mode === 'file' ? '' : under)).sort((a, b) => repoPri(a.path) - repoPri(b.path) || a.path.localeCompare(b.path));
  let capped = 0;
  if (cand.length > MAX_REPO_FILES) { capped = cand.length - MAX_REPO_FILES; cand = cand.slice(0, MAX_REPO_FILES); }
  say(`目录共 ${totalFiles} 个文件，其中 ${cand.length} 个可能是源列表${capped ? `（再多 ${capped} 个已略过）` : ''}，开始逐个读取检查…`, { phase: 'files', total: cand.length });
  if (!cand.length) { out.notes.push('这个仓库（或所选目录）里没有 json / txt / m3u 之类的文件'); return out; }

  // fetch + classify, 6 at a time
  const parts = [];
  let next = 0, done = 0, bad = 0, lastSay = 0;
  const skipped = { 网页: 0, 空文件: 0, 不是源列表: 0, 读取失败: 0 };
  await Promise.all(Array.from({ length: Math.min(6, cand.length) }, async () => {
    while (next < cand.length) {
      const f = cand[next++], u = rawUrl(repo, ref, f.path);
      try {
        const r = await fetch(u, { headers: rawHeaders(), redirect: 'follow', signal: AbortSignal.timeout(15000) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const len = Number(r.headers.get('content-length')) || 0;
        if (len > MAX_REPO_FILE) { r.body?.cancel().catch(() => {}); skipped.不是源列表++; }
        else {
          const buf = Buffer.from(await r.arrayBuffer());
          if (buf.length <= MAX_REPO_FILE && !buf.subarray(0, 2048).includes(0)) {
            const k = await classifyRepoFile(f.path, u, buf.toString('utf8'));
            if (k.skip) skipped[k.skip] = (skipped[k.skip] || 0) + 1; else parts.push({ ...k, path: f.path });
          } else skipped.不是源列表++;
        }
      } catch { skipped.读取失败++; bad++; }
      done++;
      if (Date.now() - lastSay > 400 || done === cand.length) { lastSay = Date.now(); say(`读取检查 ${done}/${cand.length} · 已识别 ${parts.length} 个源文件${bad ? ` · 失败 ${bad}` : ''}`, { phase: 'scan', done, total: cand.length, found: parts.length }); }
    }
  }));
  const sk = Object.entries(skipped).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join('、');
  say(`读取完成：${parts.length} 个文件含源${sk ? `（略过：${sk}）` : ''}，正在整理…`, { phase: 'parse' });

  // turn each recognised file into sites / lives, exactly like a pasted link
  let expand = 0;
  for (const part of parts) {
    const { c, name, url: u, text, path: rel } = part;
    const label = rel.replace(/\.[^.]+$/, '');
    if (c.kind === 'config') {
      const embedded = (Array.isArray(c.obj.lives) ? c.obj.lives : []).filter(l => l && typeof l.text === 'string' && l.text.trim());
      let f; try { f = await configFrom({ ...c.obj, sites: (c.obj.sites || []).filter(s => !(s && typeof s.text === 'string')), lives: (c.obj.lives || []).filter(l => !(l && l.text)) }, u); } catch { f = { sites: [], lives: [] }; }
      const info = `来自 ${rel}`;
      out.sites.push(...f.sites.map(s => ({ ...s, info })));
      out.lives.push(...f.lives.map(l => ({ ...l, info })));
      for (const l of embedded) { const n = parseLive(l.text).groups.reduce((a, g) => a + g.channels.length, 0); out.lives.push({ name: str(l.name) || label, text: l.text.trim() + '\n', ok: n > 0, ...(n ? {} : { empty: true }), info: n ? `${n} 个频道（${rel}）` : '0 个频道，不导入' }); }
      expand++;
    } else if (c.kind === 'list') {
      // A channel list file: keep it as a link to the file itself, so it stays in step with the repo.
      out.lives.push(c.channels > 0 ? { name: label, url: u, ok: true, info: `${c.channels} 个频道 · ${rel}` } : { name: label, url: u, ok: false, empty: true, info: `0 个频道，不导入 · ${rel}` });
    } else if (c.kind === 'vod') {
      // a CMS API response saved as a file is not a live API: ignore, but a file that just holds a link is handled by the generic path
      out.unknown.push(u);
    }
  }
  out.notes.push(`扫描了 ${cand.length} 个文件，${parts.length} 个含源`);
  say(`整理完成：点播源 ${out.sites.length}、直播源 ${out.lives.length}（还要去重和检测可用性）…`, { phase: 'merge' });
  return out;
}

// ======================= people =======================
// 苹果CMS has no actor filter, but some sites' `wd` also matches vod_actor / vod_director. Search every
// visible site (two pages), keep titles whose credits really contain the name, one per title+year.
const NO_PERSON = /^(暂无|未知|内详|无|不详|佚名|其他|n\/?a|none|unknown|-+)$/i;
const splitPeople = v => str(v).split(/[,，、/|;；]+|\s{2,}/).map(x => x.trim()).filter(x => x && !NO_PERSON.test(x));
async function person(name, role, sites) {
  const field = role === 'director' ? 'vod_director' : 'vod_actor';
  const pages = await Promise.all(sites.flatMap(s => [1, 2].map(pg => cmsGet(s, { ac: 'detail', wd: name, pg: String(pg) }, false, 8000)
    .then(b => (b.list || []).map(d => ({ s, d })), () => []))));
  const seen = new Set(), out = [];
  for (const { s, d } of pages.flat()) {
    if (!splitPeople(d[field]).some(p => p === name)) continue;
    if (/解说|预告/.test(str(d.vod_name)) || /解说|预告/.test(str(d.type_name))) continue;
    const it = item(s, d);
    if (!itemOk(s, it)) continue;
    const k = s.key + '|' + it.name.replace(/\s+/g, '') + '|' + it.year;   // one per source: the client merges same-title ones (or not)
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out.sort((a, b) => (Number(b.year) || 0) - (Number(a.year) || 0));
}

// ======================= images =======================
// 豆瓣's image CDN answers 418 without a douban Referer, which browsers won't send cross-site. Relay those
// (and only those), cached on disk for a week.
const IMGS = path.join(DATA, 'img');
fs.mkdirSync(IMGS, { recursive: true });
async function imageProxy(target, res) {
  let u;
  try { u = new URL(target); } catch { return send(res, 400, 'bad url', 'text/plain'); }
  const isDouban = /(^|\.)doubanio\.com$/.test(u.hostname);
  const isJav = /(^|\.)(jdbstatic|javdb)\.com$/.test(u.hostname);
  if (!isDouban && !isJav) return send(res, 403, 'host not allowed', 'text/plain');
  const file = path.join(IMGS, crypto.createHash('md5').update(u.toString()).digest('hex'));
  const st = await fsp.stat(file).catch(() => null);
  const head = { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=604800, immutable' };
  if (st && Date.now() - st.mtimeMs < 7 * 86400e3) { res.writeHead(200, { ...head, 'Content-Length': st.size }); return fs.createReadStream(file).pipe(res); }
  const buf = await once('img|' + file, async signal => {
    const r = await fetch(u, { headers: { 'User-Agent': DB_UA_IMG, Referer: isDouban ? 'https://movie.douban.com/' : JAVDB_URL + '/' }, signal: AbortSignal.any([AbortSignal.timeout(15000), signal]) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const b = Buffer.from(await r.arrayBuffer());
    await fsp.writeFile(file + '.' + process.pid, b);
    await fsp.rename(file + '.' + process.pid, file);
    return b;
  });
  res.writeHead(200, { ...head, 'Content-Length': buf.length });
  res.end(buf);
}
const DB_UA_IMG = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

// ======================= 豆瓣 =======================
const DB_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const DB_FILE = path.join(DATA, 'douban.json');
const dbRatings = readJson(DB_FILE, {}); // "name|year" -> {id, rate, at}
let dbDirty = false;
if (IS_LEADER) setInterval(() => { if (dbDirty) { dbDirty = false; writeJson(DB_FILE, dbRatings); } }, 10000).unref();
rpcHandlers.dbRating = ({ name, year }) => doubanRating(name, year);
rpcHandlers.dbHot = ({ type }) => doubanHot(type);
const dbMem = new Map();
let dbChain = Promise.resolve();
// Serialize requests to 豆瓣 with a small gap so we don't get rate-limited.
function dbJson(url, ttl, headers) {
  const hit = dbMem.get(url);
  if (hit && Date.now() - hit.at < ttl) return Promise.resolve(hit.body);
  const run = dbChain.then(async () => {
    const r = await fetch(url, { headers: headers || { 'User-Agent': DB_UA, Referer: 'https://movie.douban.com/' }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`豆瓣 HTTP ${r.status}`);
    const body = await r.json();
    dbMem.set(url, { at: Date.now(), body });
    if (dbMem.size > 2000) dbMem.delete(dbMem.keys().next().value);
    await new Promise(ok => setTimeout(ok, 150));
    return body;
  });
  dbChain = run.catch(() => {});
  return run;
}
const normTitle = t => str(t).replace(/\s+|[·:：\-—!！,，.。]/g, '').replace(/第[一二三四五六七八九十\d]+季$/, '').toLowerCase();

// Title → 豆瓣 subject (id, score, year, poster). m.douban.com's subject search answers where the old
// movie.douban.com/j/subject_suggest now returns an empty list. `pic` is the poster at 豆瓣's small size;
// clients ask the /img relay for the sharp ones (see dbSize in app.js).
const DB_M = { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148', Referer: 'https://m.douban.com/movie/' };
async function doubanRating(name, year) {
  name = name.trim();
  if (!name) return { found: false };
  const key = name + '|' + year;
  const c = dbRatings[key];
  // Entries from before posters were kept are looked up again once.
  if (c && c.v === 2 && Date.now() - c.at < (c.rate ? 7 : 1) * 86400e3) return c.id ? { found: true, ...c } : { found: false };
  try {
    const j = await dbJson('https://m.douban.com/rexxar/api/v2/search/subjects?count=8&q=' + encodeURIComponent(name), 86400e3, DB_M);
    const subs = (j?.subjects?.items || []).map(x => x.target).filter(t => t && t.id && t.title);
    const exact = subs.filter(t => t.title === name || normTitle(t.title) === normTitle(name));
    const pick = exact.find(t => year && str(t.year) === String(year)) || exact[0];
    let out = { id: '', rate: '', v: 2, at: Date.now() };
    if (pick) {
      const pid = (/\/(p\d+)\./.exec(str(pick.cover_url)) || [])[1];
      out = { id: str(pick.id), rate: fmtRate(pick.rating?.value), year: str(pick.year), v: 2, at: Date.now(),
        pic: pid ? `https://img3.doubanio.com/view/photo/s_ratio_poster/public/${pid}.jpg` : '' };
    }
    dbRatings[key] = out; dbDirty = true;
    return out.id ? { found: true, ...out } : { found: false };
  } catch (e) { return { found: false, error: e.message }; }
}
// 综艺 / 日本动画 are tags of the tv type on 豆瓣's search_subjects.
async function doubanHot(type) {
  const url = `https://movie.douban.com/j/search_subjects?type=${type === 'movie' ? 'movie' : 'tv'}&tag=${encodeURIComponent({ show: '综艺', anime: '日本动画' }[type] || '热门')}&page_limit=30&page_start=0`;
  try {
    const j = await dbJson(url, 3600e3);
    return { list: (j.subjects || []).map(x => ({ id: x.id, name: x.title, pic: x.cover, rate: x.rate, remarks: x.episodes_info || '' })) };
  } catch (e) { return { list: [], error: e.message }; }
}

// ======================= javdb（成人元数据） =======================
// javdb.com is the de-facto database for Japanese adult video. It has no public JSON API, so the search page
// is scraped for the title/cover/date/score and, best-effort, the video page for the cast. Requests are
// serialized with a polite gap (Cloudflare rate-limits) and cached in data/javdb.json + a memory LRU.
// When the official host is unreachable, set JAVDB_URL to a mirror/proxy of the same site.
// JAVDB_URL may list several hosts separated by commas (mirrors); they are tried in order and the one that answered last is tried first.
const JAVDB_HOSTS = (process.env.JAVDB_URL || 'https://javdb.com').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
let JAVDB_URL = JAVDB_HOSTS[0];
const JAVDB_FILE = path.join(DATA, 'javdb.json');
const javdbCache = readJson(JAVDB_FILE, {}); // 番号 -> {found, title, cover, date, score, actors, id, at}
let javDirty = false;
if (IS_LEADER) setInterval(() => { if (javDirty) { javDirty = false; writeJson(JAVDB_FILE, javdbCache); } }, 10000).unref();
const javMem = new Map();
let javChain = Promise.resolve();
function javText(url) {
  const hit = javMem.get(url);
  if (hit && Date.now() - hit.at < 24 * 3600e3) return Promise.resolve(hit.body);
  const run = javChain.then(async () => {
    // `url` is written against JAVDB_URL; on failure the same path is tried on the other hosts.
    const path_ = url.slice(JAVDB_URL.length);
    const order = [JAVDB_URL, ...JAVDB_HOSTS.filter(h => h !== JAVDB_URL)];
    let body = '', lastErr = null;
    for (const host of order) {
      try {
        const r = await fetch(host + path_, { headers: { 'User-Agent': DB_UA, Referer: host + '/', Accept: 'text/html', 'Accept-Language': 'zh-CN,zh;q=0.9', Cookie: 'over18=1; locale=zh' }, signal: AbortSignal.timeout(order.length > 1 ? 9000 : 15000) });   // over18: 不带的话 javdb 会先给年龄确认页, 搜不到任何东西
        if (!r.ok) throw new Error(`javdb HTTP ${r.status}`);
        const t = await r.text();
        if (/<title>\s*(Redirecting|Just a moment)/i.test(t)) throw new Error('javdb 需要人机验证，换一个镜像（环境变量 JAVDB_URL）');
        body = t; JAVDB_URL = host; lastErr = null; break;
      } catch (e) { lastErr = e; }
    }
    if (lastErr) throw lastErr;
    javMem.set(url, { at: Date.now(), body });
    if (javMem.size > 500) javMem.delete(javMem.keys().next().value);
    await new Promise(ok => setTimeout(ok, 400));
    return body;
  });
  javChain = run.catch(() => {});
  return run;
}
// 番号 shapes: ABC-123, ABCDEF-123, FC2-PPV-1234567, 123456_123 (Caribbean)… — normalized to UPPER with dashes.
// Dash-required LETTERS-DIGITS comes before the no-dash fallback, so messy source names like
// "第一会所…@SIS001@SONE-123" or "169bbs.com@SONE-645 [4k]" resolve to the real 番号, not the site id.
const javCode = s => {
  // Literal escape debris from mangled names ("SNIS-989\\b中文", "\\bSNIS-989", "\\w@…") must not glue onto the code
  // as a letter ("\\bSNIS" would read as BSNIS): a backslash + letter is just a separator.
  const up = str(s).replace(/\\[A-Za-z]/g, ' ').toUpperCase();
  // Release-name words that look like LETTERS+DIGITS but are not a 番号.
  const STOP = /^(?:AAC|AC|DTS|DDP|HEVC|AVC|HDR|UHD|FHD|WEB|BD|DVD|MP|EP|HD|HQ|CD|VOL|NO|PART|CAM|TS|SE)$/;
  // IPX00988 → IPX-988, ABP-0123 → ABP-123 (zero-padded to 5 on some sites); real 4-digit codes (DV-1656) stay.
  const num = n => n.length > 3 ? n.replace(/^0+/, '').padStart(3, '0') : n;
  // What may follow the digits: end, any non-alphanumeric (CJK titles, @ . - [ space …), or a tag glued on directly
  // (SNIS-989UC, MIDA-829restored, ABP-123C). The tag must end there so "ABC-123DEF" is not read as ABC-123.
  const MULTI = 'UNCENSORED|DECENSORED|RESTORED|RESTORE|MOSAIC|LEAKED|LEAK|SUBBED|SUB|ENG|CHS|CHT|CH|CN|JP|UC|UHD|FHD|HD|4K|8K|1080P|720P|60FPS|HEVC|H265|X265|REMUX|UNCUT';
  const tail = `(?=$|[^A-Z0-9]|(?:(?:${MULTI})+|[CURABDE])(?![A-Z0-9]))`; // several tags may be glued: SNIS-989UCrestored
  const pats = [
    [new RegExp(`(?:^|[^A-Z0-9])(FC2)[\\s\\-_]?(PPV)[\\s\\-_]?(\\d{5,8})${tail}`, 'g'), m => `${m[1]}-${m[2]}-${m[3]}`],
    [new RegExp(`(?:^|[^A-Z0-9])([A-Z]{2,6})[\\-_](?:(?:${MULTI})[\\-_. ]?)*(\\d{2,5})${tail}`, 'g'), m => `${m[1]}-${num(m[2])}`], // tags may even sit inside: SNIS-UC-989
    [new RegExp(`(?:^|[^A-Z0-9])(\\d{6})[\\-_](\\d{3})${tail}`, 'g'), m => `${m[1]}-${m[2]}`],
    [new RegExp(`(?:^|[^A-Z0-9])([A-Z]{2,6})(\\d{2,5})${tail}`, 'g'), m => STOP.test(m[1]) ? '' : `${m[1]}-${num(m[2])}`],
  ];
  for (const [re, fmt] of pats) for (const m of up.matchAll(re)) { const c = fmt(m); if (c) return c; }
  return '';
};
// "4.47分, 由2123人評價" lives inside <div class="score"> (search cards) / <span class="value"> (video page).
const javScore = html => {
  const i = str(html).search(/class="[^"]*\b(?:score|value)\b[^"]*"/i);
  const t = stripHtml(i < 0 ? '' : str(html).slice(i, i + 400)); // nested spans (stars icon): look at a window, not a tag pair
  const m = /(\d+(?:\.\d+)?)\s*分/.exec(t);
  return m ? { score: m[1], votes: (/由\s*(\d+)\s*人/.exec(t) || [])[1] || '' } : { score: '', votes: '' };
};
const stripHtml = s => str(s).replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
async function javMeta(code) {
  code = javCode(code);
  if (!code) return { found: false };
  const c = javdbCache[code];
  // 「没有这个番号」只有 v:3 的才算数 (旧版没带年龄确认的 cookie，拿到确认页就记成了「没有」)
  if (c && c.at && (c.found === false ? c.v === 3 : c.v === 2) && Date.now() - c.at < (c.found === false ? 7 : 30) * 86400e3)
    return c.found === false ? { found: false } : { found: true, code, ...c };
  try {
    const html = await javText(`${JAVDB_URL}/search?q=${encodeURIComponent(code)}&f=all`);
    let best = null;
    for (const m of html.matchAll(/<a\b[^>]*href="\/v\/([A-Za-z0-9]+)"[^>]*>(.*?)<\/a>/gs)) {
      const inner = m[2];
      const uid = (/class="uid"[^>]*>([^<]+)</i.exec(inner) || [])[1] || '';
      const title = (/<strong>([\s\S]*?)<\/strong>/i.exec(inner) || [])[1]
        || (/title="([^"]{2,})"/.exec(inner) || [])[1] || '';
      if (!title) continue;
      // 搜索结果是模糊匹配的: 必须是同一个番号才算 (番号写在 class="uid" 里, 新版页面写在标题开头的 <strong> 里)
      const cc = javCode(uid || stripHtml(title));
      if (cc ? cc !== code : !stripHtml(inner).toUpperCase().includes(code)) continue;
      best = { id: m[1], title: stripHtml(title), uid: stripHtml(uid) || code,
        cover: (/(?:src|data-src)="([^"]*(?:jdbstatic|covers)[^"]*)"/i.exec(inner) || [])[1] || '',
        date: (/\b(19|20)\d{2}[-/]\d{1,2}[-/]\d{1,2}\b/.exec(inner) || [''])[0] || '',
        ...javScore(inner) };
      break; // first exact-code hit
    }
    if (!best) {
      // 只有确实是「搜索结果页」才记成没有; 年龄确认 / 人机验证 / 改版的页面不记, 下次再试
      if (!/movie-list|empty-message|class="[^"]*\bsearch/i.test(html)) { javWarn(`${code}: 返回的不是搜索结果页 (${html.length} 字节)`); return { found: false, error: 'javdb 返回的不是搜索结果页' }; }
      javdbCache[code] = { found: false, v: 3, at: Date.now() }; javDirty = true; return { found: false };
    }
    let actors = [];
    try {
      const vh = await javText(`${JAVDB_URL}/v/${best.id}`);
      actors = [...vh.matchAll(/href="\/(?:actors|star)\/[^"]*"[^>]*>([^<]{1,40})<\/a>/gi)].map(m => stripHtml(m[1])).filter(Boolean);
      actors = [...new Set(actors)].slice(0, 20);
      if (!best.score) Object.assign(best, javScore(vh));
    } catch {}
    const out = { found: true, title: best.title, cover: best.cover, date: best.date, score: best.score, votes: best.votes, v: 2, actors, id: best.id, url: JAVDB_URL + '/v/' + best.id, at: Date.now() };
    javdbCache[code] = out; javDirty = true;
    return { found: true, code, ...out };
  } catch (e) { javWarn(`${code}: ${e.message}`); return { found: false, error: e.message }; }
}
let javWarnAt = 0;
const javWarn = m => { if (Date.now() - javWarnAt > 30e3) { javWarnAt = Date.now(); console.error('[javdb] ' + m + ' （连不上可以设环境变量 JAVDB_URL 为镜像地址）'); } };
rpcHandlers.javdb = ({ code }) => javMeta(code);

// ======================= 豆瓣榜单 =======================
// Three kinds, modelled on 豆瓣's own pages:
//   精选榜单  m.douban.com subject_collection (Top250, 一周口碑榜, 实时热门…), ranked by 豆瓣
//   类型排行  movie.douban.com/typerank: one genre, "好于 X% 的同类影片"
//   年度榜    movie.douban.com/explore (选影视): 电影/电视剧/综艺 × 年份 × 类型 × 地区 × 排序
// Only the ids / values listed here are forwarded, so this isn't an open proxy to 豆瓣.
const CHARTS = {
  collections: [
    { id: 'movie_top250', name: '豆瓣电影 Top250', kind: 'movie', desc: '按看过人数与评分综合排名，每周更新' },
    { id: 'movie_weekly_best', name: '一周口碑电影榜', kind: 'movie', desc: '每周五更新' },
    { id: 'movie_real_time_hotest', name: '实时热门电影', kind: 'movie', desc: '按最近的关注度排名' },
    { id: 'tv_chinese_best_weekly', name: '华语口碑剧集榜', kind: 'tv', desc: '每周三更新' },
    { id: 'tv_global_best_weekly', name: '全球口碑剧集榜', kind: 'tv', desc: '每周三更新' },
    { id: 'tv_real_time_hotest', name: '实时热门剧集', kind: 'tv', desc: '按最近的关注度排名' },
    { id: 'show_chinese_best_weekly', name: '国内口碑综艺榜', kind: 'show', desc: '每周三更新' },
    { id: 'show_global_best_weekly', name: '国外口碑综艺榜', kind: 'show', desc: '每周三更新' },
  ],
  // movie.douban.com/j/chart/top_list?type=<id>
  genres: [[11, '剧情'], [24, '喜剧'], [5, '动作'], [13, '爱情'], [17, '科幻'], [25, '动画'], [10, '悬疑'], [19, '惊悚'],
    [20, '恐怖'], [3, '犯罪'], [16, '奇幻'], [15, '冒险'], [22, '战争'], [4, '历史'], [2, '传记'], [28, '家庭'], [8, '儿童'],
    [14, '音乐'], [7, '歌舞'], [29, '武侠'], [30, '古装'], [12, '灾难'], [27, '西部'], [18, '运动'], [31, '黑色电影'],
    [1, '纪录片'], [23, '短片'], [26, '同性'], [6, '情色']].map(([id, name]) => ({ id: String(id), name, ...(id === 6 ? { adult: 1 } : {}) })),
  intervals: [['100:90', '前 10%'], ['90:80', '10–20%'], ['80:70', '20–30%'], ['70:60', '30–40%'], ['60:50', '40–50%']].map(([id, name]) => ({ id, name })),
  kinds: [{ id: 'movie', name: '电影' }, { id: 'tv', name: '电视剧' }, { id: 'show', name: '综艺' }],
  explore: {
    movie: ['喜剧', '爱情', '动作', '科幻', '动画', '悬疑', '犯罪', '惊悚', '冒险', '奇幻', '恐怖', '战争', '历史', '传记', '音乐', '歌舞', '武侠', '灾难', '西部', '纪录片', '短片'],
    tv: ['剧情', '喜剧', '爱情', '悬疑', '犯罪', '古装', '武侠', '家庭', '科幻', '奇幻', '动作', '历史', '战争', '惊悚', '恐怖', '动画', '传记'],
    show: ['真人秀', '脱口秀', '音乐', '歌舞'],
  },
  regions: ['华语', '欧美', '韩国', '日本', '中国大陆', '中国香港', '中国台湾', '美国', '英国', '法国', '德国', '意大利', '西班牙', '印度', '泰国', '俄罗斯'],
  decades: ['2010年代', '2000年代', '90年代', '80年代', '70年代', '60年代', '更早'],
  sorts: [{ id: 'S', name: '高分优先' }, { id: 'T', name: '综合' }, { id: 'U', name: '近期热度' }, { id: 'R', name: '最新上映' }],
};
const chartYears = () => { const y = new Date().getFullYear(); return [...Array.from({ length: 8 }, (_, i) => String(y - i)), ...CHARTS.decades]; };
// 高分优先 on 豆瓣 puts concert films with a few hundred votes first; a vote floor makes it a real ranking.
const MIN_VOTES = { movie: 5000, tv: 2000, show: 500 };
rpcHandlers.dbChart = q => doubanChart(q);

// Chart pages live on disk (data/charts.json) for 6 h; the leader refreshes the main lists in the background
// every 3 h, and a stale copy is served when 豆瓣 doesn't answer.
const CHART_FILE = path.join(DATA, 'charts.json');
const CHART_TTL = 6 * 3600e3;
const chartStore = IS_LEADER ? readJson(CHART_FILE, {}) : {};
let chartDirty = false;
async function chartJson(url) {
  const hit = chartStore[url];
  if (hit && Date.now() - hit.at < CHART_TTL) return hit;
  try {
    chartStore[url] = { at: Date.now(), body: await dbJson(url, 0) };
    chartDirty = true;
    return chartStore[url];
  } catch (e) { if (hit) return hit; throw e; }
}
async function refreshCharts() {
  const y = String(new Date().getFullYear());
  const jobs = [
    ...CHARTS.collections.flatMap(c => Array.from({ length: c.id === 'movie_top250' ? 5 : 1 }, (_, i) => ({ kind: 'collection', id: c.id, start: i * 50 }))),
    ...CHARTS.genres.filter(g => !g.adult).map(g => ({ kind: 'genre', type: g.id, interval: '100:90' })),
    ...CHARTS.kinds.flatMap(k => [y, String(y - 1)].map(year => ({ kind: 'explore', type: k.id, year, sort: 'S' }))),
  ];
  for (const q of jobs) await doubanChart(q).catch(() => {});
}
if (IS_LEADER) {
  setTimeout(refreshCharts, 20e3).unref();
  setInterval(refreshCharts, CHART_TTL / 2).unref();
  setInterval(() => {
    if (!chartDirty) return;
    chartDirty = false;
    for (const [k, v] of Object.entries(chartStore)) if (Date.now() - v.at > 3 * 86400e3) delete chartStore[k];
    writeJson(CHART_FILE, chartStore);
  }, 10000).unref();
}

const fmtRate = v => (Number(v) > 0 ? Number(v).toFixed(1) : '');
// rexxar (collections, explore) item → the card shape the clients use.
function dbSubject(x) {
  const r = x.rating || {};
  return { id: str(x.id), name: str(x.title), pic: str(x.pic?.normal || x.cover_url || x.cover?.url), rate: fmtRate(r.value),
    votes: Number(r.count) || 0, rank: Number(x.rank) || 0, sub: str(x.card_subtitle), year: (/^\d{4}/.exec(str(x.card_subtitle)) || [''])[0],
    desc: str(x.description || x.comment?.comment || '').slice(0, 120), remarks: str(x.episodes_info) };
}

async function doubanChart(q) {
  const start = Math.max(0, Math.min(Number(q.start) || 0, 1000));
  if (q.kind === 'collection') {
    const c = CHARTS.collections.find(x => x.id === q.id);
    if (!c) return { list: [], end: true, error: '没有这个榜单' };
    // Always fetch 50-aligned pages so every client page size shares the same cached request.
    const count = Math.min(Number(q.count) || 25, 50), page = Math.floor(start / 50) * 50;
    const { at, body: j } = await chartJson(`https://m.douban.com/rexxar/api/v2/subject_collection/${c.id}/items?start=${page}&count=50`);
    const list = (j.subject_collection_items || []).slice(start - page, start - page + count).filter(x => x.type === 'movie' || x.type === 'tv').map(dbSubject);
    const total = Number(j.total) || 0;
    return { list, total, next: start + count, end: start + count >= total, updated: at };
  }
  if (q.kind === 'genre') {
    const g = CHARTS.genres.find(x => x.id === q.type);
    const iv = CHARTS.intervals.find(x => x.id === q.interval) || CHARTS.intervals[0];
    if (!g || (g.adult && safety.level !== 'all')) return { list: [], end: true, error: '没有这个类型' };
    const limit = 20;
    const { at, body: j } = await chartJson(`https://movie.douban.com/j/chart/top_list?type=${g.id}&interval_id=${iv.id}&action=&start=${start}&limit=${limit}`);
    const list = (Array.isArray(j) ? j : []).map(x => ({ id: str(x.id), name: str(x.title), pic: str(x.cover_url), rate: fmtRate(x.score),
      votes: Number(x.vote_count) || 0, rank: Number(x.rank) || 0, year: '',
      sub: [(x.regions || []).join(' '), (x.types || []).join(' '), (x.actors || []).slice(0, 3).join(' ')].filter(Boolean).join(' / '), desc: '', remarks: '' }));
    return { list, next: start + limit, end: list.length < limit, updated: at };
  }
  if (q.kind === 'explore') {
    const kind = CHARTS.kinds.some(k => k.id === q.type) ? q.type : 'movie';
    const genre = CHARTS.explore[kind].includes(q.genre) ? q.genre : '';
    const region = CHARTS.regions.includes(q.region) ? q.region : '';
    const year = chartYears().includes(q.year) ? q.year : '';
    const sort = CHARTS.sorts.some(s => s.id === q.sort) ? q.sort : 'S';
    const form = { tv: '电视剧', show: '综艺' }[kind];
    const sel = { ...(form ? { 形式: form } : {}), ...(genre ? { 类型: genre } : {}), ...(region ? { 地区: region } : {}) };
    const tags = [form, genre, region, year].filter(Boolean).join(',');
    const count = 30;
    const u = `https://m.douban.com/rexxar/api/v2/${kind === 'movie' ? 'movie' : 'tv'}/recommend?refresh=0&start=${start}&count=${count}`
      + `&selected_categories=${encodeURIComponent(JSON.stringify(sel))}&uncollect=false&tags=${encodeURIComponent(tags)}&sort=${sort}`;
    const { at, body: j } = await chartJson(u);
    const raw = j.items || [];
    const floor = sort === 'S' ? MIN_VOTES[kind] : 0;
    const list = raw.filter(x => (x.type === 'movie' || x.type === 'tv') && (!floor || (x.rating?.count || 0) >= floor)).map(dbSubject);
    const total = Number(j.total) || 0;
    return { list, total, next: start + count, end: !raw.length || start + count >= total, updated: at, ...(floor ? { floor } : {}) };
  }
  return { list: [], end: true, error: 'unknown chart' };
}

// ======================= downloads =======================
// Each episode → data/downloads/<id>/{index.m3u8, 00001.ts…}. Segments are decrypted on the way in,
// so the folder plays anywhere and concatenates into a single file.
const DL_INDEX = path.join(DL, 'index.json');
let jobs = [];
if (IS_LEADER) {
  jobs = readJson(DL_INDEX, []);
  for (const j of jobs) if (j.status === 'downloading') j.status = 'queued';
}
// Other workers serve finished files; they read the leader's index (re-read when it changes).
let jobSnap = { mtime: -1, list: [] };
function jobsSnapshot() {
  if (IS_LEADER) return jobs;
  try {
    const st = fs.statSync(DL_INDEX);
    if (st.mtimeMs !== jobSnap.mtime) jobSnap = { mtime: st.mtimeMs, list: readJson(DL_INDEX, []) };
  } catch {}
  return jobSnap.list;
}
let saveTimer;
const saveJobs = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => writeJson(DL_INDEX, jobs), 500); };
// Concurrency scales with the machine: 2–4 episodes at once, 6–12 segments per episode.
const MAX_JOBS = Number(process.env.DL_JOBS) || Math.max(2, Math.min(4, Math.round(CPUS / 4)));
const SEG_CONCURRENCY = Math.max(6, Math.min(12, CPUS));

function pump() {
  // Slots are counted by status, so pausing frees one at once (the old run winds down on its own).
  while (jobs.filter(x => x.status === 'downloading').length < MAX_JOBS) {
    // First in, first out; 优先 moves a job to the front.
    const j = jobs.filter(x => x.status === 'queued').sort((a, b) => (a.qat ?? a.at) - (b.qat ?? b.at))[0];
    if (!j) return;
    // Each run gets a token: a pause → resume while the old run is still finishing its in-flight segments
    // must not leave two runs writing the same folder.
    const token = j.run = (j.run || 0) + 1;
    const mine = () => j.status === 'downloading' && j.run === token;
    j.status = 'downloading'; j.error = ''; saveJobs();
    runJob(j, mine).then(() => { if (mine()) j.status = 'done'; },
      e => { if (mine()) { j.status = 'error'; j.error = e.message || String(e); } })
      .finally(() => {
        saveJobs(); pump();
        // Deleted mid-run: its in-flight segments may have landed after the first rm.
        if (j.status === 'deleted' && j.run === token) fsp.rm(path.join(DL, j.id), { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
      });
  }
}

async function fetchBuf(url, ms = 30000) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(ms) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return { buf: Buffer.from(await r.arrayBuffer()), url: r.url };
    } catch (e) { if (i === 2) throw e; await new Promise(ok => setTimeout(ok, 800 * (i + 1))); }
  }
}

async function resolveMedia(url) {
  let { buf, url: final } = await fetchBuf(url);
  let text = buf.toString('utf8');
  for (let hop = 0; hop < 3 && /#EXT-X-STREAM-INF/.test(text); hop++) {
    const rows = text.split(/\r?\n/);
    let best = null, bw = -1;
    rows.forEach((l, i) => {
      if (!l.startsWith('#EXT-X-STREAM-INF')) return;
      const b = Number((l.match(/BANDWIDTH=(\d+)/) || [])[1] || 0);
      const next = rows.slice(i + 1).find(x => x.trim() && !x.startsWith('#'));
      if (next && b >= bw) { bw = b; best = next.trim(); }
    });
    if (!best) break;
    ({ buf, url: final } = await fetchBuf(new URL(best, final).toString()));
    text = buf.toString('utf8');
  }
  return { text, url: final };
}

async function runJob(j, mine) {
  const dir = path.join(DL, j.id);
  await fsp.mkdir(dir, { recursive: true });
  if (/\.mp4(\?|$)/i.test(j.url)) return downloadMp4(j, dir, mine);
  const { text, url: base } = await resolveMedia(j.url);
  const rows = text.split(/\r?\n/);
  const segs = [];
  const out = [];
  let key = null, seq = Number((text.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/) || [])[1] || 0), map = null;
  const keys = new Map();
  for (const l of rows) {
    if (l.startsWith('#EXT-X-KEY')) {
      const method = (l.match(/METHOD=([^,]+)/) || [])[1];
      if (method === 'NONE') { key = null; continue; }
      if (method !== 'AES-128') throw new Error('不支持的加密：' + method);
      const uri = new URL((l.match(/URI="([^"]+)"/) || [])[1], base).toString();
      const iv = (l.match(/IV=0x([0-9a-f]+)/i) || [])[1];
      key = { uri, iv };
      continue;
    }
    if (l.startsWith('#EXT-X-MAP')) {
      map = new URL((l.match(/URI="([^"]+)"/) || [])[1], base).toString();
      out.push('#EXT-X-MAP:URI="init.mp4"');
      continue;
    }
    if (/^#EXT-X-(ENDLIST|MEDIA-SEQUENCE|PLAYLIST-TYPE)/.test(l)) continue;
    if (l.startsWith('#') || !l.trim()) { if (l.trim()) out.push(l); continue; }
    const ext = map ? '.m4s' : '.ts';
    const file = String(segs.length + 1).padStart(5, '0') + ext;
    segs.push({ url: new URL(l.trim(), base).toString(), file, key, seq });
    out.push(file);
    seq++;
  }
  if (!segs.length) throw new Error('播放列表里没有分片');
  j.total = segs.length; j.done = 0; j.bytes = 0; j.ext = map ? 'mp4' : 'ts'; saveJobs();
  if (map && !fs.existsSync(path.join(dir, 'init.mp4'))) await fsp.writeFile(path.join(dir, 'init.mp4'), (await fetchBuf(map)).buf);

  const getKey = async uri => { if (!keys.has(uri)) keys.set(uri, (await fetchBuf(uri)).buf.subarray(0, 16)); return keys.get(uri); };
  let next = 0;
  const worker = async () => {
    while (next < segs.length && mine()) {
      const s = segs[next++];
      const fp = path.join(dir, s.file);
      const have = await fsp.stat(fp).catch(() => null);
      if (!have || !have.size) {
        let { buf } = await fetchBuf(s.url);
        if (s.key) {
          const k = await getKey(s.key.uri);
          const iv = s.key.iv ? Buffer.from(s.key.iv.padStart(32, '0'), 'hex') : (() => { const b = Buffer.alloc(16); b.writeUInt32BE(s.seq, 12); return b; })();
          const d = crypto.createDecipheriv('aes-128-cbc', k, iv);
          buf = Buffer.concat([d.update(buf), d.final()]);
        }
        await fsp.writeFile(fp + '.part', buf);
        await fsp.rename(fp + '.part', fp);
        j.bytes += buf.length;
      } else j.bytes += have.size;
      j.done++;
      if (j.done % 10 === 0) saveJobs();
    }
  };
  await Promise.all(Array.from({ length: SEG_CONCURRENCY }, worker));
  if (!mine()) return;
  const head = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-MEDIA-SEQUENCE:0'];
  const body = out.filter(l => !l.startsWith('#EXTM3U') && !l.startsWith('#EXT-X-VERSION'));
  await fsp.writeFile(path.join(dir, 'index.m3u8'), [...head, ...body, '#EXT-X-ENDLIST', ''].join('\n'));
}

async function downloadMp4(j, dir, mine) {
  const r = await fetch(j.url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  j.total = Number(r.headers.get('content-length')) || 0; j.done = 0; j.bytes = 0; j.ext = 'mp4';
  const ws = fs.createWriteStream(path.join(dir, 'video.mp4'));
  for await (const chunk of Readable.fromWeb(r.body)) {
    if (!mine()) { ws.destroy(); return; }
    ws.write(chunk); j.bytes += chunk.length; j.done = j.bytes;
  }
  await new Promise(ok => ws.end(ok));
  j.done = j.total = j.bytes;
}

// Speed: sampled once a second in the leader, smoothed; not persisted.
const rates = new Map(); // job id -> { bytes, at, speed }
if (IS_LEADER) setInterval(() => {
  const now = Date.now();
  for (const j of jobs) {
    if (j.status !== 'downloading') { rates.delete(j.id); continue; }
    const r = rates.get(j.id);
    if (!r) { rates.set(j.id, { bytes: j.bytes, at: now, speed: 0 }); continue; }
    const inst = Math.max(0, (j.bytes - r.bytes) * 1000 / Math.max(1, now - r.at));
    r.speed = r.speed ? r.speed * 0.6 + inst * 0.4 : inst;
    r.bytes = j.bytes; r.at = now;
  }
}, 1000).unref();
function jobView(j) {
  const speed = j.status === 'downloading' ? Math.round(rates.get(j.id)?.speed || 0) : 0;
  const pct = j.status === 'done' ? 100 : j.total ? Math.min(99, Math.floor(j.done / j.total * 100)) : 0;
  // ETA: mp4 counts bytes; HLS counts segments, so estimate the rest from the average segment so far.
  const left = j.ext === 'mp4' ? j.total - j.done : j.done ? (j.total - j.done) * (j.bytes / j.done) : 0;
  const eta = speed > 0 && left > 0 ? Math.round(left / speed) : 0;
  return { ...j, pct, speed, eta,
    play: j.status !== 'done' ? '' : fs.existsSync(path.join(DL, j.id, 'index.m3u8')) ? `/dl/${j.id}/index.m3u8` : `/dl/${j.id}/video.mp4` };
}

async function serveDownload(rest, req, res) {
  const [id, file] = rest.split('/');
  const j = jobsSnapshot().find(x => x.id === id);
  if (!j || !/^[\w.-]+$/.test(file || '')) return send(res, 404, 'not found', 'text/plain');
  const dir = path.join(DL, id);
  if (file === 'save') {
    // Whole episode as one file: init + segments (decrypted already) concatenate cleanly.
    const files = (await fsp.readdir(dir)).filter(f => /^\d+\.(ts|m4s)$/.test(f)).sort();
    const parts = [...(fs.existsSync(path.join(dir, 'init.mp4')) ? ['init.mp4'] : []), ...files];
    if (!parts.length && fs.existsSync(path.join(dir, 'video.mp4'))) parts.push('video.mp4');
    const ext = j.ext === 'mp4' ? 'mp4' : 'ts';
    const name = `${j.name}${j.epName && j.epName !== '播放' ? ' ' + j.epName : ''}.${ext}`.replace(/[\\/:*?"<>|]/g, '_');
    res.writeHead(200, { 'Content-Type': ext === 'mp4' ? 'video/mp4' : 'video/mp2t',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}` });
    for (const p of parts) await new Promise((ok, bad) => fs.createReadStream(path.join(dir, p)).on('end', ok).on('error', bad).pipe(res, { end: false }));
    return res.end();
  }
  return sendFile(req, res, path.join(dir, file), MIME[path.extname(file)] || 'application/octet-stream');
}

// A file with Range support (seeking), incl. suffix ranges ("bytes=-N").
async function sendFile(req, res, fp, type, extra = {}) {
  const st = await fsp.stat(fp).catch(() => null);
  if (!st || !st.isFile()) return send(res, 404, 'not found', 'text/plain');
  const { etag: useEtag, ...extraHeaders } = extra;
  const head = { 'Content-Type': type, 'Accept-Ranges': 'bytes', ...extraHeaders };
  if (useEtag) { // validators for cacheable images: a revalidating client gets 304 without a body
    head.ETag = `W/"${st.size.toString(36)}-${Math.round(st.mtimeMs).toString(36)}"`;
    if (req.headers['if-none-match'] === head.ETag) { delete head['Accept-Ranges']; res.writeHead(304, { ETag: head.ETag, 'Cache-Control': head['Cache-Control'] }); return res.end(); }
  }
  const pipe = rs => { rs.on('error', () => res.destroy()); res.on('close', () => rs.destroy()); rs.pipe(res); };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : Math.max(0, st.size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
    if (start >= st.size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { ...head, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    return req.method === 'HEAD' ? res.end() : pipe(fs.createReadStream(fp, { start, end }));
  }
  res.writeHead(200, { ...head, 'Content-Length': st.size });
  return req.method === 'HEAD' ? res.end() : pipe(fs.createReadStream(fp));
}

// ======================= 本地媒体（内置点播源） =======================
// Folders on this machine or a mounted NAS → one built-in 苹果CMS source (key "local"). Each configured
// folder is a category (with `sub`, each of its first-level subfolders is one). Inside, a folder of
// numbered videos becomes a series; any other video is a title of its own (`flat`: always one per file).
// Posters: poster/folder/cover or a same-name image, else an ffmpeg frame; an .nfo gives title/plot/cast.
// Files are reachable only by opaque ids from the scan index, so nothing else on disk can be requested.
// The media process (IS_MEDIA) scans and writes data/local-index.json; the web workers re-read it when it changes.
// Also served as a real CMS API at /api/local/vod (absolute urls, original files) for TVBox/FongMi on the TV.
const LOCAL_CFG = path.join(DATA, 'local.json');
const LOCAL_INDEX = path.join(DATA, 'local-index.json');
const TRANS = path.join(DATA, 'transcode');
fs.mkdirSync(TRANS, { recursive: true });
const MEDIA_EXT = new Set(['mp4', 'm4v', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'f4v', 'ts', 'm2ts', 'mts', 'webm', 'rmvb', 'rm',
  'mpg', 'mpeg', 'vob', '3gp', 'ogv', 'divx', 'asf', 'mp3', 'flac', 'm4a', 'aac', 'wav', 'ogg', 'opus', 'ape', 'wma']);
// What a browser <video> plays as is; the rest is remuxed (or transcoded) to HLS by ffmpeg on demand.
const BROWSER_EXT = new Set(['mp4', 'm4v', 'webm', 'mov', 'mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus']);
const LOCAL_DEFAULT = { enabled: true, name: '本地媒体', exts: ['mp4', 'mkv', 'avi', 'mov', 'm4v', 'webm', 'flv', 'wmv', 'rmvb', 'ts', 'm2ts', 'mts'], rescan: 60, dirs: [] };
// .ts / .mts 同时是 TypeScript 的后缀：扫描时按文件内容判断 (见 isMpegTs)，真的是 MPEG-TS 视频才收，所以这几个后缀始终开着，不会把代码当视频。
const SNIFFED_EXT = ['ts', 'm2ts', 'mts'];
const SKIP_NAME = /^(\.|node_modules$|recycler$|@eaDir$|#recycle$|\$recycle\.bin$|system volume information$|lost\+found$|samples?$|extras?$|featurettes$)/i;
const SKIP_SAMPLE = /(^|[\s._-])sample\.\w+$/i;
const IMG_RE = /\.(jpe?g|png|webp)$/i;
const POSTERS = ['poster', 'folder', 'cover', 'movie', 'show', 'fanart', 'thumb', 'landscape'];

function normLocal(c) {
  c = c && typeof c === 'object' ? c : {};
  const extList = Array.isArray(c.exts) ? c.exts : str(c.exts).split(/[\s,，;；]+/);
  const exts = [...new Set([...extList.map(e => str(e).trim().toLowerCase().replace(/^\./, '')).filter(e => MEDIA_EXT.has(e)), ...SNIFFED_EXT])];
  const dirs = [];
  for (const d of Array.isArray(c.dirs) ? c.dirs : []) {
    let p = str(d && d.path).trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim(); // Windows "复制为路径" wraps it in quotes
    if (p === '~' || p.startsWith('~\\')) p = path.join(os.homedir(), p.slice(1));
    if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
    if (!p || !path.isAbsolute(p)) continue;
    dirs.push({ path: path.resolve(p), name: str(d.name).trim().slice(0, 30), ...(Number(d.sub) ? { sub: 1 } : {}),
      ...(Number(d.flat) ? { flat: 1 } : {}), ...(Number(d.kids) ? { kids: 1 } : {}), ...(Number(d.adult) ? { adult: 1 } : {}) });
  }
  const rescan = Math.round(Number(c.rescan ?? LOCAL_DEFAULT.rescan));
  return { enabled: c.enabled !== false, name: str(c.name).trim().slice(0, 20) || LOCAL_DEFAULT.name,
    exts: exts.length > SNIFFED_EXT.length ? exts : LOCAL_DEFAULT.exts, rescan: Math.max(0, Math.min(rescan || 0, 1440)), dirs };
}
function readLocalCfg() { return normLocal(readJson(LOCAL_CFG, LOCAL_DEFAULT)); }
let localCfg = readLocalCfg();

let localSnap = { mtime: -1, cats: [], items: [], byItem: new Map(), byFile: new Map(), catById: new Map() };
function localIndex() {
  let mtime = -1;
  try { mtime = fs.statSync(LOCAL_INDEX).mtimeMs; } catch {}
  if (mtime !== localSnap.mtime) {
    const idx = readJson(LOCAL_INDEX, {}) || {};
    const cats = idx.cats || [], items = idx.items || [];
    const byItem = new Map(), byFile = new Map();
    for (const it of items) { byItem.set(it.id, it); for (const f of it.files) byFile.set(f.id, { ...f, item: it }); }
    localSnap = { mtime, cats, items, byItem, byFile, catById: new Map(cats.map(c => [c.id, c])) };
  }
  return localSnap;
}
// 儿童: only folders marked 少儿; 标准: everything but folders marked 成人; 全部: all.
const localCatOk = c => !!c && (safety.level === 'all' || (safety.level === 'kids' ? !!c.kids && !c.adult : !c.adult));
function localSite() {
  if (!localCfg.enabled || !localCfg.dirs.length || !localIndex().cats.some(localCatOk)) return null;
  return { key: 'local', name: localCfg.name, type: 1, api: '', local: 1, ...(safety.level === 'kids' ? { kids: 1 } : {}) };
}

const LOCAL_PAGE = 30;
const fmtBytes = b => b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : Math.max(1, Math.round(b / 1e6)) + ' MB';
// base '' = this web app (relative urls, HLS for what browsers can't play); 'http://host' = external CMS clients.
function localCms(params, base) {
  const snap = localIndex();
  const cats = localCfg.enabled ? snap.cats.filter(localCatOk) : [];
  const ok = new Set(cats.map(c => c.id));
  const ids = str(params.ids).split(',').map(s => s.trim()).filter(Boolean);
  let list;
  if (ids.length) list = ids.map(i => snap.byItem.get(i)).filter(it => it && ok.has(it.cat));
  else {
    const t = str(params.t), wd = str(params.wd).trim().toLowerCase();
    list = snap.items.filter(it => ok.has(it.cat) && (!t || it.cat === t)
      && (!wd || it.name.toLowerCase().includes(wd) || str(it.actor).toLowerCase().includes(wd)));
  }
  const pg = Math.max(1, Number(params.pg) || 1);
  const page = ids.length ? list : list.slice((pg - 1) * LOCAL_PAGE, pg * LOCAL_PAGE);
  return { code: 1, msg: '数据列表', page: pg, pagecount: Math.max(1, Math.ceil(list.length / LOCAL_PAGE)), limit: String(LOCAL_PAGE),
    total: list.length, class: cats.map(c => ({ type_id: c.id, type_pid: 0, type_name: c.name })),
    list: page.map(it => localVod(it, snap.catById.get(it.cat)?.name || '', base)) };
}
function localVod(it, type, base) {
  const url = f => (base || BROWSER_EXT.has(f.ext) || !FFMPEG) ? `${base}/media/f/${f.id}.${f.ext}` : `/media/h/${f.id}/index.m3u8`;
  const size = it.files.reduce((n, f) => n + f.size, 0);
  return { vod_id: it.id, vod_name: it.name, vod_pic: (it.pic || FFMPEG) ? `${base}/media/p/${it.id}?v=${hashId(it.pic + '|' + it.mtime + '|' + it.files.length, 6)}` : '', type_id: it.cat, type_name: type,
    vod_year: it.year || '', vod_actor: it.actor || '', vod_director: it.director || '',
    vod_remarks: it.files.length > 1 ? `${it.files.length}集` : fmtBytes(size), vod_version: it.quality || '',
    vod_content: it.plot || `${it.files.length} 个文件 · ${fmtBytes(size)}`,
    vod_time: new Date(it.mtime).toISOString().replace('T', ' ').slice(0, 19),
    vod_play_from: '本地', vod_play_url: it.files.map(f => `${f.name}$${url(f)}`).join('#') };
}

// ---- scanning (media process) ----
const natural = (a, b) => a.localeCompare(b, 'zh-CN', { numeric: true, sensitivity: 'base' });
const hashId = (s, n) => crypto.createHash('sha1').update(s).digest('hex').slice(0, n);
// Category identity: same-named folders merge regardless of case, surrounding spaces or unicode form (NFC/NFD from NAS/macOS).
const catId = name => hashId('c|' + str(name).normalize('NFC').trim().toLowerCase(), 8);
const noDelim = s => str(s).replace(/[$#]+/g, ' ').trim(); // $ and # separate episodes in 苹果CMS play lists
const SEASON = /^(?:season|series|s)[\s._-]*(\d{1,2})$|^第\s*([一二三四五六七八九十\d]+)\s*季$/i;
const EP_MARK = /S\d{1,2}[\s._-]?E\d{1,3}|第\s*\d+\s*[集话話期]|(^|[^a-z])EP?[\s._-]?\d{1,3}(\D|$)/i;
const RELEASE = /\s(2160p|1080[pi]|720p|480p|4k|uhd|blu-?ray|bdrip|web-?dl|webrip|hdtv|hdrip|dvdrip|remux|x26[45]|h\.?26[45]|hevc|avc|10bit|hdr|dts|aac|ac3|atmos)\b.*$/i;

const CODE_PROJECT = /^(package\.json|tsconfig(\..+)?\.json|deno\.jsonc?|pnpm-lock\.yaml|yarn\.lock|package-lock\.json)$/i;
const AMBIGUOUS_EXT = new Set(['ts', 'mts']);
// All scan I/O goes through one gate: many requests in flight hide NAS (SMB/NFS) latency, but not unbounded.
const IO_LIMIT = Math.max(8, Math.min(Number(process.env.SCAN_IO) || 24, 64));
let ioBusy = 0; const ioWait = [];
async function io(fn) {
  if (ioBusy >= IO_LIMIT) await new Promise(ok => ioWait.push(ok));
  ioBusy++;
  try { return await fn(); } finally { ioBusy--; ioWait.shift()?.(); }
}
// MPEG-TS = 188-byte packets (192 with a 4-byte timestamp, m2ts) that each start with sync byte 0x47.
// 真正的 MPEG-TS: 每 188 字节 (m2ts 是 192, 前面多 4 字节时间戳) 有一个 0x47 同步字节。录制 / 截取的文件开头可能不对齐，
// 所以在前 ~200 字节里找第一个对齐点，要求连续 5 个同步字节。TypeScript 源码是文本，不会满足。
async function isMpegTs(file) {
  let fh;
  try {
    fh = await io(() => fsp.open(file));
    const b = Buffer.alloc(1400);
    const { bytesRead } = await io(() => fh.read(b, 0, b.length, 0));
    if (bytesRead < 188 * 2) return false;
    for (const step of [188, 192]) {
      for (let o = 0; o < Math.min(step + 4, bytesRead); o++) {
        if (b[o] !== 0x47) continue;
        let n = 0;
        while (o + n * step < bytesRead && b[o + n * step] === 0x47) n++;
        const need = Math.min(5, Math.floor((bytesRead - o - 1) / step) + 1);
        if (n >= need && n >= 2) return true;
      }
    }
    return false;
  } catch { return false; } finally { await fh?.close().catch(() => {}); }
}

async function walkMedia(dir, exts, out, deep, depth = 0) {
  let ents;
  try { ents = await io(() => fsp.readdir(dir, { withFileTypes: true })); } catch { return; }
  const g = { dir, files: [], images: [], nfos: [] }, subs = [], maybe = [];
  for (const e of ents) {
    if (SKIP_NAME.test(e.name)) continue;
    if (e.isDirectory()) { subs.push(e.name); continue; } // symlinked folders are not followed (no loops)
    if (!e.isFile() && !e.isSymbolicLink()) continue;
    const ext = path.extname(e.name).slice(1).toLowerCase();
    if (CODE_PROJECT.test(e.name)) return; // a source tree, not a media folder: .ts here is TypeScript
    if (exts.has(ext)) { if (!SKIP_SAMPLE.test(e.name)) (AMBIGUOUS_EXT.has(ext) ? maybe : g.files).push(e.name); }
    else if (IMG_RE.test(e.name)) g.images.push(e.name);
    else if (/\.nfo$/i.test(e.name)) g.nfos.push(e.name);
  }
  // .ts / .mts are also TypeScript: keep only files that really are MPEG transport streams.
  for (const f of await Promise.all(maybe.map(async f => (await isMpegTs(path.join(dir, f))) ? f : ''))) if (f) g.files.push(f);
  if (g.files.length) out.push(g);
  if (deep && depth < 8) await Promise.all(subs.map(s => walkMedia(path.join(dir, s), exts, out, deep, depth + 1)));
}

function titleOf(raw) {
  let s = raw.replace(/^(\s*(\[[^\]]*\]|【[^】]*】))+\s*/, '');
  if (!/\s/.test(s) && /[._]/.test(s)) s = s.replace(/[._]+/g, ' ');
  let year = '';
  const m = /^(.+)[\s(\[（]+((?:19|20)\d{2})(?=$|[\s)\]）])/.exec(s);
  if (m && m[1].trim()) { s = m[1]; year = m[2]; }
  s = s.replace(RELEASE, '').replace(/[\s(\[（-]+$/, '').trim();
  return { name: noDelim(s) || noDelim(raw), year, quality: qualityOf(raw) };
}
function commonAffix(bases) {
  let pre = bases[0], suf = bases[0];
  for (const b of bases) {
    while (pre && !b.startsWith(pre)) pre = pre.slice(0, -1);
    while (suf && !b.endsWith(suf)) suf = suf.slice(1);
  }
  pre = pre.replace(/\d+$/, ''); suf = suf.replace(/^\d+/, ''); // never cut into the episode number
  if (pre.length + suf.length >= Math.min(...bases.map(b => b.length))) suf = '';
  return [pre, suf];
}
// Episodes: most names carry a marker (S01E02, 第3集, EP04), or the part that differs is a run of
// close numbers. "ABC-123 / ABC-456" in one folder are separate titles, not episodes.
function isSeries(bases) {
  if (bases.filter(b => EP_MARK.test(b)).length * 2 >= bases.length) return true;
  const [pre, suf] = commonAffix(bases);
  const nums = bases.map(b => /^\D{0,2}(\d{1,3})(?!\d)/.exec(b.slice(pre.length, b.length - suf.length)));
  if (nums.some(n => !n)) return false;
  const v = nums.map(n => Number(n[1]));
  return Math.max(...v) - Math.min(...v) < bases.length * 2;
}
function epNames(bases) {
  const se = bases.map(b => /S(\d{1,2})[\s._-]?E(\d{1,3})/i.exec(b));
  if (se.every(Boolean)) {
    const multi = new Set(se.map(m => +m[1])).size > 1;
    return se.map(m => multi ? `S${+m[1]}E${+m[2]}` : `第${+m[2]}集`);
  }
  const [pre, suf] = commonAffix(bases);
  return bases.map(b => {
    const x = b.slice(pre.length, b.length - suf.length).replace(/^[\s._\-–—]+|[\s._\-–—]+$/g, '');
    const n = /^(?:EP?|第)?\s*(\d{1,4})\s*[集话話期]?$/i.exec(x);
    return noDelim(n ? `第${+n[1]}集` : x || b);
  });
}
function pickImage(images, base) {
  const named = images.map(i => [i, i.toLowerCase().replace(IMG_RE, '')]);
  if (base) {
    const b = base.toLowerCase();
    return (named.find(([, n]) => n === b) || named.find(([, n]) => [b + '-poster', b + '.poster', b + '-thumb', b + '-fanart'].includes(n)) || [''])[0];
  }
  for (const p of POSTERS) { const hit = named.find(([, n]) => n === p); if (hit) return hit[0]; }
  return named.length ? named[0][0] : '';
}
async function readNfo(file) {
  let x;
  try {
    const fh = await io(() => fsp.open(file));
    try { const b = Buffer.alloc(256e3); const { bytesRead } = await io(() => fh.read(b, 0, b.length, 0)); x = b.subarray(0, bytesRead).toString('utf8'); }
    finally { await fh.close(); }
  } catch { return null; }
  const tag = t => { const m = new RegExp(`<${t}>([\\s\\S]*?)</${t}>`, 'i').exec(x); return m ? clean(m[1].replace(/<!\[CDATA\[|\]\]>/g, '')) : ''; };
  const actors = [...x.matchAll(/<actor>[\s\S]*?<name>([\s\S]*?)<\/name>/gi)].map(m => noDelim(clean(m[1]))).filter(Boolean);
  const directors = [...x.matchAll(/<director[^>]*>([\s\S]*?)<\/director>/gi)].map(m => noDelim(clean(m[1]))).filter(Boolean);
  return { title: noDelim(tag('title')), plot: tag('plot') || tag('outline'), year: (/\d{4}/.exec(tag('year') || tag('premiered')) || [''])[0],
    actor: [...new Set(actors)].slice(0, 30).join(','), director: [...new Set(directors)].join(',') };
}

// One folder's media files → titles.
async function groupItems(g, root, cat, flat) {
  const stats = await Promise.all(g.files.map(f => io(() => fsp.stat(path.join(g.dir, f))).catch(() => null)));
  const entries = g.files.map((f, i) => ({ f, st: stats[i] })).filter(x => x.st && x.st.isFile()).sort((a, b) => natural(a.f, b.f));
  if (!entries.length) return [];
  const bases = entries.map(x => x.f.replace(/\.[^.]+$/, ''));
  const rec = (x, name) => ({ id: hashId('f|' + path.join(g.dir, x.f), 16), path: path.join(g.dir, x.f),
    ext: path.extname(x.f).slice(1).toLowerCase(), size: x.st.size, name });
  const nfoFor = base => { const n = g.nfos.find(n => n.toLowerCase() === base.toLowerCase() + '.nfo'); return n ? readNfo(path.join(g.dir, n)) : null; };
  const make = (key, t, nfo, files, pic, mtime) => ({ id: hashId('i|' + key, 12), name: nfo?.title || t.name, year: nfo?.year || t.year, cat, quality: t.quality || qualityOf(path.basename(files[0].path)),
    pic: pic ? path.join(g.dir, pic) : '', plot: nfo?.plot || '', actor: nfo?.actor || '', director: nfo?.director || '', mtime, files,
    ...(files.length > 1 || key === g.dir ? { _dir: 1 } : {}) });
  // Files lying directly in a category folder are always titles of their own.
  if (g.dir !== root && !flat && (entries.length === 1 || isSeries(bases))) {
    const folder = path.basename(g.dir), season = SEASON.exec(folder);
    const t = titleOf(season ? path.basename(path.dirname(g.dir)) : folder);
    if (season) t.name += ` 第${season[1] || season[2]}季`;
    const nfoName = g.nfos.find(n => /^(tvshow|movie)\.nfo$/i.test(n)) || (g.nfos.length === 1 ? g.nfos[0] : '');
    const nfo = season ? null : nfoName ? await readNfo(path.join(g.dir, nfoName)) : null;
    const names = entries.length === 1 ? ['正片'] : epNames(bases);
    return [make(g.dir, t, nfo, entries.map((x, i) => rec(x, names[i])), pickImage(g.images, ''), Math.max(...entries.map(x => x.st.mtimeMs)))];
  }
  return Promise.all(entries.map(async (x, i) => make(path.join(g.dir, x.f), titleOf(bases[i]), await nfoFor(bases[i]), [rec(x, '正片')],
    pickImage(g.images, bases[i]), x.st.mtimeMs)));
}

let localScan = { running: false, at: 0, ms: 0, items: 0, files: 0, dirs: [], error: '' };
let scanQueued = false;
async function scanLocal() {
  if (localScan.running) { scanQueued = true; return; }
  const t0 = Date.now(), cfg = localCfg, exts = new Set(cfg.exts);
  const cats = new Map(), items = new Map(), merged = new Map(), dirs = [];
  localScan = { ...localScan, running: true, dirs, error: '' };
  try {
    // Every configured folder and category root is scanned in parallel (I/O is gated by io()); results are
    // merged afterwards in configuration order so the outcome doesn't depend on which finished first.
    const perDir = await Promise.all(cfg.dirs.map(async d => {
      const ds = { path: d.path, items: 0, files: 0, error: '' };
      dirs.push(ds);
      const st = await io(() => fsp.stat(d.path)).catch(() => null);
      if (!st || !st.isDirectory()) { ds.error = '目录不存在或没有权限'; return []; }
      const own = d.name || path.basename(d.path) || d.path;
      const roots = [];
      if (d.sub) {
        for (const e of await io(() => fsp.readdir(d.path, { withFileTypes: true })).catch(() => [])) {
          if (e.isDirectory() && !SKIP_NAME.test(e.name)) roots.push({ dir: path.join(d.path, e.name), cat: e.name, deep: true });
        }
        roots.push({ dir: d.path, cat: own, deep: false }); // loose files in the folder itself
      } else roots.push({ dir: d.path, cat: own, deep: true });
      return Promise.all(roots.map(async r => {
        const groups = [];
        await walkMedia(r.dir, exts, groups, r.deep);
        groups.sort((a, b) => natural(a.dir, b.dir));
        const found = (await Promise.all(groups.map(g => groupItems(g, r.dir, catId(r.cat), d.flat)))).flat();
        for (const it of found) { ds.items++; ds.files += it.files.length; }
        return { d, r, found };
      }));
    }));
    for (const res of perDir.flat()) {
      if (!res.found.length) continue;
      const { d, r } = res;
      // The same name from several folders is one category: 成人 if any of them is, 少儿 only if all are.
      const id = catId(r.cat);
      const c = cats.get(id) || { id, name: r.cat, adult: 0, kids: 1 };
      if (d.adult) c.adult = 1;
      if (!d.kids) c.kids = 0;
      cats.set(id, c);
      for (const it of res.found) {
        if (items.has(it.id)) continue;
        // Same-named series folders (in several folders / same-named subfolders) are one title: merge their episodes.
        const mk = it._dir ? `${it.cat}|${it.name.toLowerCase()}|${it.year}` : '';
        const prev = mk && merged.get(mk);
        if (prev) {
          prev.files.push(...it.files);
          prev.files.sort((a, b) => natural(a.name, b.name) || natural(a.path, b.path));
          prev.mtime = Math.max(prev.mtime, it.mtime);
          prev.pic = prev.pic || it.pic; prev.plot = prev.plot || it.plot; prev.actor = prev.actor || it.actor; prev.director = prev.director || it.director;
          continue;
        }
        items.set(it.id, it);
        if (mk) merged.set(mk, it);
      }
    }
    for (const it of items.values()) delete it._dir;
    const list = [...items.values()].sort((a, b) => b.mtime - a.mtime);
    const used = new Set(list.map(it => it.cat));
    fs.writeFileSync(LOCAL_INDEX + '.tmp', JSON.stringify({ at: Date.now(), cats: [...cats.values()].filter(c => used.has(c.id)), items: list }));
    for (let i = 0; ; i++) { // Windows: EPERM/EBUSY while a web worker is reading the old index
      try { fs.renameSync(LOCAL_INDEX + '.tmp', LOCAL_INDEX); break; }
      catch (e) { if (i >= 8 || !/^(EPERM|EBUSY|EACCES)$/.test(e.code)) throw e; await new Promise(ok => setTimeout(ok, 60 * (i + 1))); }
    }
    localSnap.mtime = -2;
    thumbHot.clear(); // sources may have changed
    localScan = { running: false, at: Date.now(), ms: Date.now() - t0, items: list.length, files: list.reduce((n, it) => n + it.files.length, 0), dirs, error: '' };
  } catch (e) {
    localScan = { ...localScan, running: false, at: Date.now(), error: e.message || String(e) };
  }
  if (scanQueued) { scanQueued = false; scanLocal(); }
}
const localStatus = () => ({ ...localScan, dirs: localScan.dirs.map(d => ({ ...d })) });
rpcHandlers.localStatus = () => localStatus();
rpcHandlers.localScan = () => { if (localCfg.enabled) scanLocal(); return localStatus(); };
rpcHandlers.localSave = b => {
  localCfg = normLocal(b);
  writeJson(LOCAL_CFG, localCfg);
  broadcastReload();
  if (localCfg.enabled) scanLocal();
  return { cfg: localCfg, status: localStatus() };
};
if (IS_MEDIA) {
  setTimeout(() => { if (localCfg.enabled && localCfg.dirs.length) scanLocal(); }, 1500).unref();
  setInterval(() => {
    if (localCfg.enabled && localCfg.rescan && localCfg.dirs.length && !localScan.running
      && Date.now() - localScan.at > localCfg.rescan * 60e3) scanLocal();
  }, 60e3).unref();
}

// ---- posters (media process, cached in data/thumbs) ----
// Cover = the folder's image (downscaled once when it is big) or an ffmpeg frame of the first video. Built for throughput:
//  · own LIFO queue with low concurrency + nice 10 — what the user is looking at now is made first, scrolled-past requests
//    are dropped when the backlog is long (they get a 503 and are simply asked again), and live previews are not starved;
//  · "hot" LRU map id → ready file, so repeat requests need no stat/ffmpeg; disk is capped (oldest-used covers pruned);
//  · cover files are keyed by their source, so a changed image/video yields a new cover instead of a stale one.
const THUMB_CONC = Math.max(1, Math.min(3, CPUS >> 1));
const THUMB_BACKLOG = 240, THUMB_DISK_MAX = 4000, THUMB_HOT_MAX = 3000, PIC_DIRECT = 150e3;
const thumbFail = new Map(), thumbHot = new Map(), thumbQ = [];
let thumbRun = 0;
const hotGet = id => { const f = thumbHot.get(id); if (f) { thumbHot.delete(id); thumbHot.set(id, f); } return f; };
function hotSet(id, f) { thumbHot.delete(id); thumbHot.set(id, f); if (thumbHot.size > THUMB_HOT_MAX) thumbHot.delete(thumbHot.keys().next().value); }
function thumbJob(fn) {
  return new Promise((ok, bad) => {
    thumbQ.push({ fn, ok, bad });
    if (thumbQ.length > THUMB_BACKLOG) thumbQ.shift().bad(new Error('busy')); // oldest request = most likely scrolled away
    drainThumbs();
  });
}
function drainThumbs() {
  while (thumbRun < THUMB_CONC && thumbQ.length) {
    const { fn, ok, bad } = thumbQ.pop(); // newest first
    thumbRun++;
    fn().then(ok, bad).finally(() => { thumbRun--; drainThumbs(); });
  }
}
// Resolves to a file path, null (no cover possible) or rejects with 'busy'.
rpcHandlers.localThumb = ({ id }) => localThumb(id);
async function localThumb(id) {
  const hot = hotGet(id);
  if (hot) return hot;
  const it = localIndex().byItem.get(id);
  if (!it) return null;
  const pic = it.pic ? await io(() => fsp.stat(it.pic)).catch(() => null) : null;
  if (pic && (pic.size <= PIC_DIRECT || !FFMPEG)) { hotSet(id, it.pic); return it.pic; }
  if (!FFMPEG) return null;
  const src = pic ? it.pic : it.files[0].path;
  const file = path.join(THUMBS, `local-${hashId(id + '|' + src + '|' + (pic ? pic.mtimeMs : ''), 12)}.jpg`);
  const done = await fsp.stat(file).catch(() => null);
  if (done) { hotSet(id, file); fsp.utimes(file, new Date(), new Date()).catch(() => {}); return file; } // touch = LRU stamp for pruning
  if (Date.now() - (thumbFail.get(id) || 0) < 3600e3) return pic ? it.pic : null;
  const key = 'lt|' + file;
  if (!mediaJobs.has(key)) {
    const tmp = file.replace(/\.jpg$/, '.tmp.jpg');
    const run = pic
      ? () => ffmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-vf', 'scale=480:-2:force_original_aspect_ratio=decrease', '-frames:v', '1', '-q:v', '4', tmp], 30000, 10)
      // Skip the opening (logos / black); short clips fall back to the start.
      : () => {
        const args = ss => ['-hide_banner', '-loglevel', 'error', '-y', ...(ss ? ['-ss', String(ss)] : []), '-i', src,
          '-map', '0:v:0', '-vf', 'thumbnail=30,scale=480:-2', '-frames:v', '1', '-q:v', '5', tmp];
        return ffmpeg(args(90), 40000, 10).then(() => fsp.stat(tmp)).catch(() => ffmpeg(args(0), 40000, 10));
      };
    mediaJobs.set(key, thumbJob(run)
      .then(() => fsp.rename(tmp, file)).then(() => { hotSet(id, file); return file; }, e => {
        fsp.rm(tmp, { force: true }).catch(() => {});
        if (e.message === 'busy') throw e; // dropped from the backlog: not a failure of the source
        thumbFail.set(id, Date.now());
        return pic ? it.pic : null; // an image we could not shrink is still better than nothing
      })
      .finally(() => mediaJobs.delete(key)));
  }
  return mediaJobs.get(key);
}
// ---- hover previews: a short gif of the title (media process, cached in data/thumbs) ----
// A title ≥ 40 s long gets three 2 s clips (15 % / 45 % / 75 % in) joined into one gif (6 s), shorter ones a single 5 s clip,
// fitted into 512×288 (aspect kept), 6 fps, 64 colours. Same machinery as the covers: shared LIFO queue (the card being hovered now
// is made next), at most a few ffmpeg at once at nice 10, "hot" LRU id → file, disk cap with oldest-used pruned, failures
// remembered for an hour, files keyed by source path + size + mtime so an edited video gets a new preview.
const GIF_DISK_MAX = 400, GIF_HOT_MAX = 600;
const GIF_FIT = 'scale=512:288:force_original_aspect_ratio=decrease:flags=bilinear'; // shown as tall as the cover, so not tiny
const gifHot = new Map(), gifFail = new Map();
// The gif lane is a side channel and never competes with what the page needs: its own queue (newest request first,
// short backlog, a request that waited > 15 s is dropped as 'busy' — the client simply doesn't show a preview), ONE
// ffmpeg at a time, nice 10, and it only runs while nothing else is being worked on in this process: no cover being
// made or waiting, no folder scan, no transcode for playback. Anything above it always goes first.
const GIF_BACKLOG = 8, GIF_WAIT = 15e3;
const gifQ = []; let gifRun = 0;
const gifIdle = () => thumbRun === 0 && thumbQ.length === 0 && !localScan.running && hlsJobs.size === 0;
function gifJob(fn) {
  return new Promise((ok, bad) => {
    gifQ.push({ fn, ok, bad, at: Date.now() });
    if (gifQ.length > GIF_BACKLOG) gifQ.shift().bad(new Error('busy'));
    drainGifs();
  });
}
function drainGifs() {
  for (let i = gifQ.length - 1; i >= 0; i--) if (Date.now() - gifQ[i].at > GIF_WAIT) gifQ.splice(i, 1)[0].bad(new Error('busy'));
  while (gifRun < 1 && gifQ.length && gifIdle()) {
    const { fn, ok, bad } = gifQ.pop(); // newest first
    gifRun++;
    fn().then(ok, bad).finally(() => { gifRun--; drainGifs(); });
  }
}
if (IS_MEDIA) setInterval(() => { if (gifQ.length) drainGifs(); }, 1500).unref(); // the gate opens without an event of its own
rpcHandlers.localGif = ({ id }) => localGif(id);
async function localGif(id) {
  const hot = gifHot.get(id);
  if (hot) { gifHot.delete(id); gifHot.set(id, hot); return hot; }
  const it = localIndex().byItem.get(id);
  if (!it || !FFMPEG) return null;
  const f = it.files[0];
  const st = await io(() => fsp.stat(f.path)).catch(() => null);
  if (!st) return null;
  const file = path.join(THUMBS, `localgif3-${hashId(id + '|' + f.path + '|' + st.size + '|' + Math.round(st.mtimeMs), 12)}.gif`);
  const done = await fsp.stat(file).catch(() => null);
  const keep = () => { gifHot.delete(id); gifHot.set(id, file); if (gifHot.size > GIF_HOT_MAX) gifHot.delete(gifHot.keys().next().value); return file; };
  if (done) { fsp.utimes(file, new Date(), new Date()).catch(() => {}); return keep(); } // touch = LRU stamp for pruning
  if (Date.now() - (gifFail.get(id) || 0) < 3600e3) return null;
  const key = 'lg|' + file;
  if (!mediaJobs.has(key)) {
    const tmp = file.replace(/\.gif$/, '.tmp.gif');
    const run = async () => {
      const { duration: dur = 0 } = await mediaInfo(f.path);
      const clip = dur >= 40 ? 2 : 5;
      const starts = dur >= 40 ? [0.15, 0.45, 0.75].map(p => dur * p) : dur >= 8 ? [Math.min(dur * 0.25, dur - 5.5)] : [0];
      const inputs = starts.flatMap(t => ['-ss', t.toFixed(2), '-t', String(clip), '-i', f.path]);
      const chains = starts.map((_, n) => `[${n}:v:0]fps=6,${GIF_FIT},setpts=PTS-STARTPTS[v${n}]`);
      if (starts.length > 1) chains.push(`${starts.map((_, n) => `[v${n}]`).join('')}concat=n=${starts.length}:v=1:a=0[c]`);
      const fc = [...chains, `${starts.length > 1 ? '[c]' : '[v0]'}split[a][b]`, '[a]palettegen=max_colors=64:stats_mode=diff[p]',
        '[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle'].join(';');
      const base = ['-hide_banner', '-loglevel', 'error', '-y'];
      const tail = ['-an', '-loop', '0', tmp];
      // Odd containers (no index) can't seek; fall back to the first 5 s.
      return ffmpeg([...base, ...inputs, '-filter_complex', fc, ...tail], 60000, 10)
        .catch(() => ffmpeg([...base, '-t', '5', '-i', f.path, '-an', '-vf', 'fps=6,scale=240:-2:flags=bilinear,split[a][b];[a]palettegen=max_colors=48:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle', '-loop', '0', tmp], 60000, 10));
    };
    mediaJobs.set(key, gifJob(run)
      .then(() => fsp.rename(tmp, file)).then(keep, e => {
        fsp.rm(tmp, { force: true }).catch(() => {});
        if (e.message === 'busy') throw e;
        gifFail.set(id, Date.now());
        return null;
      })
      .finally(() => mediaJobs.delete(key)));
  }
  return mediaJobs.get(key);
}

// Disk caps: keep the most recently used covers / gifs (mtime is touched on first use after a restart / LRU eviction).
async function pruneThumbs() {
  try {
    const all = await fsp.readdir(THUMBS);
    for (const n of all) if (/^local(gif\d?)?-.*\.tmp\./.test(n)) fsp.rm(path.join(THUMBS, n), { force: true }).catch(() => {});
    for (const n of all) if (/^localgif[12]?-/.test(n)) fsp.rm(path.join(THUMBS, n), { force: true }).catch(() => {}); // earlier, shorter / smaller previews
    for (const [prefix, cap] of [['local-', THUMB_DISK_MAX], ['localgif3-', GIF_DISK_MAX]]) {
      const names = all.filter(n => n.startsWith(prefix) && !n.includes('.tmp.'));
      if (names.length <= cap) continue;
      const st = [];
      for (let i = 0; i < names.length; i += 64) {
        st.push(...await Promise.all(names.slice(i, i + 64).map(n => fsp.stat(path.join(THUMBS, n)).then(s => ({ n, t: s.mtimeMs }), () => null))));
      }
      const old = st.filter(Boolean).sort((a, b) => a.t - b.t).slice(0, names.length - Math.floor(cap * 0.9));
      await Promise.all(old.map(x => fsp.rm(path.join(THUMBS, x.n), { force: true })));
      (prefix === 'local-' ? thumbHot : gifHot).clear();
    }
  } catch {}
}
if (IS_MEDIA) {
  setTimeout(pruneThumbs, 30e3).unref();
  setInterval(pruneThumbs, 30 * 60e3).unref();
}

// ---- browser playback of mkv/avi/rmvb…: ffmpeg → HLS in data/transcode/<file id>/ (media process) ----
// H.264 video is copied (fast, about disk speed); anything else is encoded to H.264. Audio → AAC stereo.
// The playlist grows while ffmpeg runs (EVENT); a finished one (.done) is kept a day after last use.
const hlsJobs = new Map(), hlsFail = new Map();
const HLS_MAX = Math.max(2, Math.min(4, Math.floor(CPUS / 3)));
const HLS_IDLE = 5 * 60e3;
const HLS_VER = 'v2';   // bump when the ffmpeg arguments change: finished transcodes from an older version are redone
function probeVideo(file) {
  return new Promise(ok => {
    let err = '';
    const p = spawn(FFMPEG, ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    const t = setTimeout(() => p.kill('SIGKILL'), 20000);
    p.stderr.on('data', d => { if (err.length < 64e3) err += d; });
    p.on('error', () => { clearTimeout(t); ok({ copy: false }); });
    p.on('close', () => {
      clearTimeout(t);
      const line = err.split('\n').find(l => /Stream #.*Video:/.test(l) && !/attached pic/.test(l)) || '';
      ok({ copy: /Video: h264\b/.test(line) && !/high 10|10le|4:2:2|4:4:4|yuv42[24]/i.test(line) });
    });
  });
}
function startHls(f) {
  const dir = path.join(TRANS, f.id);
  if (hlsJobs.size >= HLS_MAX) [...hlsJobs.values()].sort((a, b) => a.last - b.last)[0].stop();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(dir, { recursive: true });
  const j = { last: Date.now(), proc: null, stopped: false, exited: false, error: '' };
  j.stop = () => {
    j.stopped = true; j.proc?.kill('SIGKILL');
    if (hlsJobs.get(f.id) === j) hlsJobs.delete(f.id);
    fsp.rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  };
  hlsJobs.set(f.id, j);
  j.ready = (async () => {
    const v = await probeVideo(f.path);
    if (j.stopped) return;
    const vargs = v.copy ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-force_key_frames', 'expr:gte(t,n_forced*6)'];
    // Audio: resampled onto one continuous 48 kHz timeline (aresample async) so segment joins don't click / crackle.
    const p = j.proc = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-fflags', '+genpts', '-i', f.path,
      '-map', '0:V:0?', '-map', '0:a:0?', ...vargs, '-c:a', 'aac', '-ac', '2', '-ar', '48000', '-b:a', '192k', '-af', 'aresample=async=1000:first_pts=0',
      '-max_muxing_queue_size', '1024', '-f', 'hls', '-hls_time', '6', '-hls_list_size', '0', '-hls_playlist_type', 'event', '-hls_flags', 'independent_segments',
      '-hls_segment_filename', path.join(dir, '%05d.ts'), path.join(dir, 'index.m3u8')], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    try { os.setPriority(p.pid, 10); } catch {} // yields to the request workers
    p.stderr.on('data', d => { j.error = (j.error + d).slice(-300); });
    p.on('error', e => { j.error = e.message; j.exited = true; });
    p.on('exit', code => {
      j.exited = true;
      if (hlsJobs.get(f.id) === j) hlsJobs.delete(f.id);
      if (j.stopped) return;
      if (code === 0) fs.writeFileSync(path.join(dir, '.done'), HLS_VER);
      else hlsFail.set(f.id, { at: Date.now(), error: j.error.trim() || 'exit ' + code });
    });
    // Ready once the first segment is listed (or ffmpeg gave up).
    for (let i = 0; i < 200 && !j.exited && !j.stopped; i++) {
      if (/\.ts\s*$/m.test(await fsp.readFile(path.join(dir, 'index.m3u8'), 'utf8').catch(() => ''))) return;
      await new Promise(ok => setTimeout(ok, 300));
    }
  })();
  return j;
}
// Duration + resolution of a local file: one `ffmpeg -i` (header only), remembered (LRU, 3000 files).
const infoCache = new Map();
function mediaInfo(file) {
  const hit = infoCache.get(file);
  if (hit) { infoCache.delete(file); infoCache.set(file, hit); return Promise.resolve(hit); }
  return new Promise(ok => {
    let err = '';
    const p = spawn(FFMPEG, ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    try { os.setPriority(p.pid, 10); } catch {}
    const t = setTimeout(() => p.kill('SIGKILL'), 15000);
    p.stderr.on('data', d => { if (err.length < 64e3) err += d; });
    p.on('error', () => { clearTimeout(t); ok({}); });
    p.on('close', () => {
      clearTimeout(t);
      const line = err.split(/\r?\n/).find(l => /Stream #.*Video:/.test(l) && !/attached pic/.test(l)) || '';
      const m = /[\s,](\d{2,5})x(\d{2,5})[\s,\[]/.exec(line);
      const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(err);
      const v = {};
      if (m) { v.width = +m[1]; v.height = +m[2]; }
      if (d) v.duration = +d[1] * 3600 + +d[2] * 60 + +d[3];
      if (m || d) { infoCache.set(file, v); if (infoCache.size > 3000) infoCache.delete(infoCache.keys().next().value); }
      ok(v);
    });
  });
}
rpcHandlers.localProbe = async ({ id }) => {
  const f = localIndex().byFile.get(id);
  if (!f || !FFMPEG) return {};
  const { width, height, duration } = await mediaInfo(f.path);
  return width || duration ? { ...(width ? { width, height } : {}), ...(duration > 0 ? { duration } : {}) } : {};
};
rpcHandlers.hlsOpen = async ({ id }) => {
  const f = localIndex().byFile.get(id);
  if (!f || !FFMPEG) return { error: '找不到文件' };
  const dir = path.join(TRANS, id), done = path.join(dir, '.done');
  if (fs.existsSync(done) && fs.readFileSync(done, 'utf8') === HLS_VER) { const now = new Date(); fsp.utimes(done, now, now).catch(() => {}); return { ok: true }; }
  const fail = hlsFail.get(id);
  if (!hlsJobs.has(id) && fail && Date.now() - fail.at < 10 * 60e3) return { error: 'ffmpeg 转换失败：' + fail.error };
  const j = hlsJobs.get(id) || startHls(f);
  j.last = Date.now();
  await j.ready;
  if (fs.existsSync(path.join(dir, 'index.m3u8'))) return { ok: true };
  return { error: 'ffmpeg 转换失败：' + (j.error.trim() || '没有输出') };
};
if (IS_MEDIA) {
  // Unfinished output from an earlier run can't be resumed.
  for (const d of fs.readdirSync(TRANS)) if (!fs.existsSync(path.join(TRANS, d, '.done'))) fs.rmSync(path.join(TRANS, d), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  setInterval(async () => {
    for (const j of [...hlsJobs.values()]) if (Date.now() - j.last > HLS_IDLE) j.stop();
    for (const d of await fsp.readdir(TRANS).catch(() => [])) {
      const st = await fsp.stat(path.join(TRANS, d, '.done')).catch(() => null);
      if (st && Date.now() - st.mtimeMs > 86400e3) fsp.rm(path.join(TRANS, d), { recursive: true, force: true }).catch(() => {});
    }
  }, 60e3).unref();
}

// /media/p/<item>  poster · /media/f/<file>.<ext>  original file · /media/h/<file>/index.m3u8  HLS for browsers
async function serveMedia(rest, req, res) {
  const [kind, raw = '', file = ''] = rest.split('/');
  const snap = localIndex();
  const visible = it => it && localCfg.enabled && localCatOk(snap.catById.get(it.cat));
  if (kind === 'p') {
    const it = snap.byItem.get(raw);
    if (!visible(it)) return send(res, 404, 'not found', 'text/plain');
    // The url carries ?v=<version> (see localVod), so a cover can be cached for good; the ETag covers bare urls.
    const cacheH = { 'Cache-Control': 'public, max-age=2592000, stale-while-revalidate=86400', etag: true };
    let thumb;
    try { thumb = await rpc('localThumb', { id: it.id }, 90000); }
    catch (e) { res.setHeader?.('Retry-After', '5'); return send(res, 503, 'busy', 'text/plain'); }
    return thumb ? sendFile(req, res, thumb, MIME[path.extname(thumb).toLowerCase()] || 'image/jpeg', cacheH) : send(res, 404, 'no poster', 'text/plain');
  }
  if (kind === 'g') {
    const it = snap.byItem.get(raw);
    if (!visible(it)) return send(res, 404, 'not found', 'text/plain');
    let gif;
    try { gif = await rpc('localGif', { id: it.id }, 120000); }
    catch (e) { res.setHeader?.('Retry-After', '5'); return send(res, 503, 'busy', 'text/plain'); }
    return gif ? sendFile(req, res, gif, 'image/gif', { 'Cache-Control': 'public, max-age=604800', etag: true }) : send(res, 404, 'no preview', 'text/plain');
  }
  const f = snap.byFile.get(raw.replace(/\.\w+$/, ''));
  if (!f || !visible(f.item)) return send(res, 404, 'not found', 'text/plain');
  if (kind === 'f') return sendFile(req, res, f.path, MIME['.' + f.ext] || 'application/octet-stream');
  if (kind === 'h' && file === 'index.m3u8') {
    const r = await rpc('hlsOpen', { id: f.id }, 90000);
    if (r.error) return send(res, 500, r.error, 'text/plain; charset=utf-8');
    const text = await fsp.readFile(path.join(TRANS, f.id, 'index.m3u8'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
    return res.end(text);
  }
  if (kind === 'h' && /^\d{5}\.ts$/.test(file)) return sendFile(req, res, path.join(TRANS, f.id, file), 'video/mp2t');
  send(res, 404, 'not found', 'text/plain');
}

// ======================= 管理员 (设置页 → 管理员) =======================
// 管理员令牌 (.env 的 TVBOX_ADMIN_TOKEN) 登录后得到一个 HttpOnly Cookie；之后可以：看版本 / 检查更新 / 更新并重启 / 重启 / 清理缓存 / 换令牌。
// 状态和任务都在 leader 进程里 (admin rpc)，其它 web 进程只负责验令牌后转过去。
const updater = require('./updater');
const BOOT = Date.now();
const ADMIN_LAST = path.join(DATA, '.admin-last.json');
const adminJob = { cur: null, ctl: null };   // ctl: 当前任务的 AbortController (取消按钮)
const canRestart = () => !!process.env.TVBOX_SUPERVISED;
function requestRestart(why) { if (!canRestart()) throw new Error('当前不是由看守进程启动的 (TVBOX_NO_SUPERVISOR=1)，没法自动重启，请手动重启'); process.send({ t: 'restart', why }); }
const rmContents = async dir => { for (const e of await fsp.readdir(dir).catch(() => [])) await fsp.rm(path.join(dir, e), { recursive: true, force: true, maxRetries: 3 }).catch(() => {}); };
async function dirSize(dir) {
  let n = 0, files = 0;
  const walk = async d => {
    for (const e of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (files > 30000) return;
      const f = path.join(d, e.name);
      if (e.isDirectory()) await walk(f);
      else { files++; n += (await fsp.stat(f).catch(() => ({ size: 0 }))).size; }
    }
  };
  await walk(dir);
  return n;
}
let sizeMemo = { at: 0, v: null };
async function cacheSizes() {
  if (sizeMemo.v && Date.now() - sizeMemo.at < 30e3) return sizeMemo.v;
  const [transcode, covers, tmp] = await Promise.all([dirSize(TRANS), Promise.all([dirSize(THUMBS), dirSize(IMGS)]).then(a => a[0] + a[1]), dirSize(updater.TMP)]);
  sizeMemo = { at: Date.now(), v: { transcode, covers, tmp } };
  return sizeMemo.v;
}
const saveLast = o => { try { fs.writeFileSync(ADMIN_LAST, JSON.stringify({ ...o, at: Date.now() })); } catch {} };
function startJob(kind, fn) {
  const c = adminJob.cur;
  if (c && (c.status === 'running' || c.status === 'restarting')) throw new Error('已有任务在进行：' + ({ update: '更新', restart: '重启', clear: '清理', rotate: '换令牌' }[c.kind] || c.kind));
  const j = adminJob.cur = { id: Date.now(), kind, status: 'running', log: [], at: Date.now(), error: '', needRestart: false };
  const ctl = adminJob.ctl = new AbortController();
  const log = t => { j.log.push(String(t).slice(0, 300)); if (j.log.length > 60) j.log.shift(); };
  Promise.resolve().then(() => fn(log, j, ctl.signal)).catch(e => {
    j.progress = null;
    if (ctl.signal.aborted || e.message === updater.CANCELLED) { j.status = 'cancelled'; j.error = ''; log('已取消，没有改动任何文件'); saveLast({ kind, ok: false, cancelled: true }); return; }
    j.status = 'error'; j.error = e.message || String(e); log('✘ ' + j.error); saveLast({ kind, ok: false, error: j.error });
  });
  return j;
}
// 到点重启：先让页面拿到响应
function restartSoon(j, log, why, extra = {}) {
  if (!canRestart()) { j.status = 'done'; j.needRestart = true; log('当前不是由看守进程启动的，请手动重启生效'); saveLast({ kind: j.kind, ok: true, needRestart: true, ...extra }); return; }
  j.status = 'restarting'; log('正在重启服务…');
  saveLast({ kind: j.kind, ok: true, ...extra });
  setTimeout(() => { try { requestRestart(why); } catch (e) { j.status = 'error'; j.error = e.message; } }, 800);
}
const autoCheck = () => { if (process.env.TVBOX_NO_AUTOCHECK !== '1') updater.check().catch(() => {}); };
rpcHandlers.admin = async ({ op, body = {} }) => {
  const ok = b => ({ code: 200, body: b }), no = (code, error) => ({ code, body: { error } });
  if (op === 'status') {
    const [ver, caches] = await Promise.all([updater.current().catch(e => ({ mode: 'unknown', error: e.message })), cacheSizes()]);
    let last = null; try { last = JSON.parse(fs.readFileSync(ADMIN_LAST, 'utf8')); } catch {}
    return ok({ authed: true, boot: BOOT, pid: process.pid, uptime: Math.round(process.uptime()), node: process.version, platform: process.platform, workers: WORKERS,
      canRestart: canRestart(), autoCheck: process.env.TVBOX_NO_AUTOCHECK !== '1', ver, update: updater.cachedCheck(), caches, job: adminJob.cur, last,
      ffmpeg: !!FFMPEG, port: PORT });
  }
  if (op === 'job') return ok({ boot: BOOT, job: adminJob.cur });
  if (op === 'check') {
    try { return ok({ update: await updater.check({ force: !!body.force }) }); }
    catch (e) { return ok({ update: updater.cachedCheck(), checkError: e.message }); }
  }
  if (op === 'restart') {
    if (!canRestart()) return no(409, '当前不是由看守进程启动的，没法自动重启，请手动重启');
    const j = startJob('restart', (log, j) => restartSoon(j, log, '管理员：重启'));
    return ok({ job: j });
  }
  if (op === 'update') {
    const j = startJob('update', async (log, j, signal) => {
      log('开始更新…');
      const r = await updater.apply(log, pr => { j.progress = pr; }, signal);
      j.progress = null;
      j.result = r;
      if (!r.changed) { j.status = 'done'; log('已是最新，无需重启'); saveLast({ kind: 'update', ok: true, unchanged: true }); return; }
      restartSoon(j, log, '管理员：更新后重启', { from: r.from, to: r.to });
    });
    return ok({ job: j });
  }
  if (op === 'cancel') {
    const c = adminJob.cur;
    if (!c || c.status !== 'running') return no(409, '没有可以取消的任务');
    adminJob.ctl?.abort();
    return ok({ ok: true });
  }
  if (op === 'clear') {
    const what = body.what;
    if (!['transcode', 'covers'].includes(what)) return no(400, '不认识的缓存类型');
    const j = startJob('clear', async (log, j) => {
      if (what === 'transcode') { log('停掉转码任务并清空转码缓存…'); await rpc('hlsPurge', {}, 30000); }
      else { log('清空封面 / 图片缓存…'); await rmContents(THUMBS); await rmContents(IMGS); }
      sizeMemo = { at: 0, v: null };
      log('已清理');
      if (what === 'covers') return restartSoon(j, log, '管理员：清理封面缓存');   // 各进程里还记着旧封面的索引, 重启后重建
      j.status = 'done'; saveLast({ kind: 'clear', ok: true, what });
    });
    return ok({ job: j });
  }
  if (op === 'rotate') {
    const which = body.which === 'admin' ? AUTH.ADMIN_KEY : body.which === 'access' ? AUTH.KEY : '';
    if (!which) return no(400, '要换哪个令牌？');
    if (!canRestart()) return no(409, '换令牌后需要重启才生效，但当前没法自动重启；请手动改 .env 后重启');
    let fresh;
    const j = startJob('rotate', (log, j) => { fresh = AUTH.rotate(which); log('新令牌已写入 .env'); restartSoon(j, log, '管理员：换令牌'); });
    return ok({ job: j, token: fresh, which: body.which });
  }
  return no(404, 'unknown admin op');
};
rpcHandlers.hlsPurge = async () => {
  for (const j of [...hlsJobs.values()]) j.stop();
  hlsFail.clear();
  await rmContents(TRANS);
  return {};
};
if (IS_LEADER) {
  setTimeout(() => { updater.cleanup(); autoCheck(); }, 20e3).unref();   // 启动后清掉上次遗留的更新临时文件，并自动查一次有没有新版本
  setInterval(autoCheck, 3600e3).unref();                                // 之后每小时看一眼 (结果缓存 6 小时，期间不会真的联网)
}
if (IS_MEDIA) for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { for (const j of hlsJobs.values()) { try { j.proc?.kill('SIGKILL'); } catch {} } process.exit(0); });   // 重启时不留孤儿 ffmpeg

// ======================= HTTP =======================
function send(res, code, body, type = 'application/json; charset=utf-8') {
  if (res.destroyed) return;
  let buf = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  const headers = { 'Content-Type': type, 'Cache-Control': 'no-store' };
  if (buf.length > 1024 && /json|text/.test(type) && /\bgzip\b/.test(res.req?.headers['accept-encoding'] || '')) {
    buf = zlib.gzipSync(buf, { level: 5 });
    headers['Content-Encoding'] = 'gzip';
    headers.Vary = 'Accept-Encoding';
  }
  res.writeHead(code, headers);
  res.end(buf);
}
function readBody(req, max = 2e6) {
  return new Promise((ok, fail) => {
    const parts = []; let n = 0, over = false;
    req.on('data', c => { n += c.length; if (n > max) { over = true; parts.length = 0; } else if (!over) parts.push(c); });   // 超限: 把剩下的读掉再报错 (直接断开的话浏览器只看到 fetch failed)
    req.on('end', () => {
      if (over) return fail(new Error(`内容太大（超过 ${Math.round(max / 1048576)} MB）`));
      try { const b = Buffer.concat(parts).toString('utf8'); ok(b ? JSON.parse(b) : {}); } catch { fail(new Error('bad json')); }
    });
    req.on('error', fail);
  });
}
const needPin = res => send(res, 403, { error: '需要家长 PIN', pin: true });

// ---- batch support ----
const BATCH_MAX = 60, BATCH_PAR = 6;
// Read-only GET routes the client may bundle. Slow ones (search / detail / javdb) don't hold up fast ones: results stream back as each finishes.
const searchNorm = x => str(x).toLowerCase().replace(/[\s\u3000·•・:：\-—–_.,，。、!！?？'"“”‘’()（）\[\]【】《》<>~～]/g, '');
const BATCHABLE = /^(list|categories|detail|search|person|sites|info|live|probe|javdb|douban\/(rating|hot|chart|charts))$/;
// Runs api() as a GET against an in-memory response and returns {status, body}.
async function captureApi(route, params, req) {
  const cap = { destroyed: false, headersSent: false, req: { headers: {} }, code: 200, out: '',
    writeHead(c) { this.code = c; }, setHeader() {}, end(b) { this.out = b == null ? '' : String(b); } };
  try {
    await api(route, params, cap, { method: 'GET', headers: req.headers, socket: req.socket, url: '/api/' + route });
    let body; try { body = JSON.parse(cap.out); } catch { body = { error: 'bad response' }; }
    return { status: cap.code, body };
  } catch (e) { return { status: 502, body: { error: e.message || String(e) } }; }
}
const PREVIEWS = path.join(DATA, 'previews');
// 预览模式: the normal UI opened with ?pv=vod&pvapi=…&pvname=…[&pvcats=…] (a 点播源) or ?pv=live&pvu=… / pvstash=… (a 直播源).
// The page adds those params to every request, so the preview lives entirely in the URL: that one source is the only one visible,
// nothing is read from or written to the config.
function previewOf(q) {
  const kind = q.get('pv');
  if (kind !== 'vod' && kind !== 'live') return null;
  const name = str(q.get('pvname')).slice(0, 60) || '预览';
  if (kind === 'vod') {
    const api = str(q.get('pvapi')).trim();
    if (!/^https?:\/\//.test(api) && !LOCAL_VOD.test(api)) return { bad: '不是可预览的接口地址' };
    let cats = []; try { cats = JSON.parse(q.get('pvcats') || '[]').map(String).filter(Boolean); } catch {}
    return { site: { key: 'preview', name, api, ...(cats.length ? { categories: cats } : {}) }, liveList: [] };
  }
  const url = str(q.get('pvu')).trim(), stash = str(q.get('pvstash'));
  if (!stash && !/^https?:\/\//.test(url) && !/^local:[\w.-]+$/.test(url)) return { bad: '不是可预览的直播源地址' };
  return { site: null, live: { url, stash, name }, liveList: [{ key: 'preview', name, kids: false, adult: false }] };
}
async function previewLive(pv) {
  const { url, stash, name } = pv.live;
  const text = stash ? (/^[a-f0-9]{12}$/.test(stash) ? await fsp.readFile(path.join(PREVIEWS, stash), 'utf8').catch(() => null) : null) : await liveText(url, true);
  if (text === null) return null;
  return parseLive(text, { url, name });
}
async function api(route, q, res, req) {
  const pv = previewOf(q);
  if (pv && (pv.bad || safety.level !== 'all')) return send(res, pv.bad ? 400 : 403, { error: pv.bad || '预览只能在安全级别「全部」下使用' });
  const SITES = pv ? (pv.site ? [pv.site] : []) : visibleSites();
  const write = req.method !== 'GET';
  // Source settings (点播源 / 直播源 / 导入 / 本地媒体 folders) can only be changed at 安全级别「全部」: they carry the 成人 flags
  // that the other levels rely on. Safety level itself is changed through /api/safety (with the PIN, if one is set).
  if (write && safety.level !== 'all' && /^(config(\/.*)?|live\/(raw|edit|merge)|recognize|classify|local)$/.test(route))
    return send(res, 403, { error: '源设置只能在安全级别「全部」下修改', locked: true });

  const leader = async (op, args) => { const r = await rpc(op, args); return send(res, r.code || 200, r.body); };

  // ---- batch: many small reads in one round trip (client DataLoader) ----
  // POST {requests:[{route, q}]} → NDJSON, one line {i, status, body} per request *as it finishes*, so a slow one
  // (javdb is paced) never holds back the fast ones. Each sub-request runs through this very function as a GET,
  // so safety level, site visibility and error handling are identical to the single endpoints. Identical
  // sub-requests in one batch are computed once.
  if (route === 'batch') {
    if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
    const body = await readBody(req);
    const list = (Array.isArray(body.requests) ? body.requests : []).slice(0, BATCH_MAX);
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    const shared = new Map();
    const run = r => {
      const route = str(r && r.route), params = new URLSearchParams(r && typeof r.q === 'object' && r.q ? r.q : {});
      if (!BATCHABLE.test(route)) return Promise.resolve({ status: 400, body: { error: 'not batchable' } });
      params.sort();
      const key = route + '?' + params;
      if (!shared.has(key)) shared.set(key, captureApi(route, params, req));
      return shared.get(key);
    };
    let next = 0;
    const worker = async () => {
      while (next < list.length && !res.destroyed) {
        const i = next++;
        const out = await run(list[i]);
        if (!res.destroyed) res.write(JSON.stringify({ i, ...out }) + '\n');
      }
    };
    await Promise.all(Array.from({ length: Math.min(BATCH_PAR, list.length) }, worker));
    return res.end();
  }

  // ---- 管理员 ----
  if (route.startsWith('admin/')) {
    const sub = route.slice(6), ip = req.socket.remoteAddress || '';
    const isAdmin = adminAuthed(req);
    if (sub === 'login' && write) {
      const f = failures.get('a|' + ip);
      if (f && f.n >= 5 && f.reset > Date.now()) { res.setHeader('Retry-After', '60'); return send(res, 429, { error: '管理员令牌错误次数太多，请 1 分钟后再试' }); }
      const t = String((await readBody(req)).token || '').trim();
      if (!adminTokenOk(t)) {
        const x = f && f.reset > Date.now() ? f : { n: 0, reset: Date.now() + 60000 };
        x.n++; failures.set('a|' + ip, x);
        return send(res, 403, { error: '管理员令牌不对' });
      }
      failures.delete('a|' + ip);
      const secure = req.socket.encrypted || /^https\b/i.test(req.headers['x-forwarded-proto'] || '');
      res.setHeader('Set-Cookie', `${ADMIN_COOKIE}=${encodeURIComponent(ADMIN_TOKEN)}; Path=/; Max-Age=315360000; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`);
      return send(res, 200, { ok: true });
    }
    if (sub === 'logout' && write) { res.setHeader('Set-Cookie', `${ADMIN_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`); return send(res, 200, { ok: true }); }
    if (sub === 'status' && !write && !isAdmin) return send(res, 200, { authed: false });
    if (!isAdmin) return send(res, 403, { error: '需要管理员令牌', admin: true });
    if (sub === 'events' && !write) {
      // SSE: 任务状态 (进度 / 日志) 有变化就推一条，空闲时每 10 秒一条心跳; 服务重启时连接断开，浏览器自动重连并拿到新的 boot。
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.socket?.setNoDelay(true); res.socket?.setTimeout(0);
      res.write('retry: 1500\n\n');
      let last = '', beat = 0, gone = false, busy = false;
      const tick = async () => {
        if (gone || busy) return;
        busy = true;
        try {
          const r = await rpc('admin', { op: 'job' }, 5000);
          const data = JSON.stringify(r.body);
          if (data !== last) { last = data; beat = 0; res.write(`event: job\ndata: ${data}\n\n`); }
          else if (++beat >= 10) { beat = 0; res.write(': ping\n\n'); }
        } catch {} finally { busy = false; }
      };
      const timer = setInterval(tick, 1000);
      res.on('close', () => { gone = true; clearInterval(timer); });
      return tick();
    }
    const ops = { status: 'GET', cancel: 'POST', check: 'POST', restart: 'POST', update: 'POST', clear: 'POST', rotate: 'POST' };
    if (ops[sub] !== req.method) return send(res, 404, { error: 'unknown api' });
    return leader('admin', { op: sub, body: write ? await readBody(req) : {} });
  }

  // ---- safety / config: written by the leader, then every worker reloads ----
  if (route === 'safety') {
    if (!write) return send(res, 200, { level: safety.level, hasPin: !!safety.pin });
    return leader('safety', await readBody(req));
  }
  if (route.startsWith('config')) {
    if (!write) {
      if (safety.level === 'all') return send(res, 200, config);
      // Outside 全部 the 成人 sources are not even listed (live sources keep their index: a key is a position).
      const keys = new Set(SITES.flatMap(s => [s.key, ...(s.memberSites || []).map(m => m.key)]));
      return send(res, 200, { sites: config.sites.filter(s => keys.has(s.key)).map(s => s.members ? { ...s, members: s.members.filter(k => keys.has(k)) } : s),
        lives: config.lives.map(l => liveSrcOk(l) ? l : { name: '', url: '', hidden: 1 }) });
    }
    if (!pinOk(req)) return needPin(res);
    const op = { config: 'put', 'config/reset': 'reset', 'config/add': 'add', 'config/import': 'import' }[route];
    if (!op || (op === 'put' && req.method !== 'PUT')) return send(res, 404, { error: 'unknown api' });
    return leader('config', { op, body: await readBody(req) });
  }
  if (route === 'check') {
    deadUntil.clear(); // a user-run test starts clean: no 聚合源 member stays skipped because of an earlier failure
    const t = Date.now();
    try {
      const b = await cmsGet({ name: '', api: q.get('api') }, { ac: 'list' }, true);
      return send(res, 200, { ok: true, ms: Date.now() - t, total: Number(b.total) || 0 });
    } catch (e) { return send(res, 200, { ok: false, error: e.message }); }
  }
  if (route === 'classify' && write) {
    const b = await readBody(req);
    const apis = (Array.isArray(b.apis) ? b.apis : []).map(str).filter(u => /^https?:\/\//.test(u)).slice(0, 200);
    return send(res, 200, { results: await classifyApis(apis), ratio: CLS_RATIO });
  }
  // Preview (a source that is not in the config yet, opened in the normal UI): pasted live lists have no URL, so the text is parked in a file first.
  if (route === 'preview/stash' && write) {
    if (safety.level !== 'all') return send(res, 403, { error: '预览只能在安全级别「全部」下使用' });
    const id = crypto.randomBytes(6).toString('hex');
    await fsp.mkdir(PREVIEWS, { recursive: true });
    // a file, not memory: requests may land on any worker process; old ones are swept away
    for (const n of await fsp.readdir(PREVIEWS).catch(() => [])) { const p = path.join(PREVIEWS, n); if (Date.now() - (await fsp.stat(p).catch(() => ({ mtimeMs: 0 }))).mtimeMs > 24 * 3600e3) fsp.unlink(p).catch(() => {}); }
    await fsp.writeFile(path.join(PREVIEWS, id), str((await readBody(req)).text));
    return send(res, 200, { id });
  }
  if (route === 'recognize' && write) return send(res, 200, await recognize((await readBody(req)).text));
  if (route === 'recognize/stream' && write) {
    // Same as recognize, but streams progress lines (NDJSON) while it works; the last line is {t:'result', …}.
    const body = await readBody(req);
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    const emit = o => { if (!res.destroyed) res.write(JSON.stringify(o) + '\n'); };
    const beat = setInterval(() => emit({ t: 'ping' }), 8000);
    try { emit({ t: 'result', ...(await recognize(body.text, emit)) }); } catch (e) { emit({ t: 'error', error: e.message || String(e) }); }
    clearInterval(beat); return res.end();
  }
  if (process.env.TVBOX_TEST_HOOKS === '1' && route === '_busy') { const t = Date.now() + (Number(q.get('ms')) || 3000); while (Date.now() < t); return send(res, 200, { ok: 1 }); }
  if (process.env.TVBOX_TEST_HOOKS === '1' && route === '_throw') { setTimeout(() => { throw new Error('test boom'); }, 10); return send(res, 200, { ok: 1 }); }
  if (route === 'health') return send(res, 200, { pid: process.pid, uptime: Math.round(process.uptime()), ...GUARD.stats, limits: global.__tvboxGuard?.limits || null });
  if (route === 'info') return send(res, 200, { urls: lanIps().map(ip => `http://${ip}:${PORT}`), ...(TLS?.cert ? { httpsUrls: lanIps().map(ip => `https://${ip}:${HTTPS_PORT}`) } : {}), ffmpeg: !!FFMPEG, loopback: isLoopback(req) });

  // ---- 本地媒体: folders, scan, and the CMS API for TVBox / FongMi ----
  if (route === 'local') {
    if (!write) return send(res, 200, { cfg: localCfg, status: await rpc('localStatus'), exts: [...MEDIA_EXT], ffmpeg: !!FFMPEG,
      urls: lanIps().map(ip => `http://${ip}:${PORT}/api/local/vod`) });
    if (!pinOk(req)) return needPin(res);
    return send(res, 200, await rpc('localSave', await readBody(req)));
  }
  // Open a local file in this computer's default player / show it in the file manager. Only for a browser running
  // on this same machine (see isLoopback), and only for files in the scan index that the safety level lets through.
  if (route === 'local/open' && write) {
    if (!isLoopback(req)) return send(res, 403, { error: '只有在这台电脑本机（localhost）上打开才能调用系统播放器' });
    const b = await readBody(req);
    const f = localIndex().byFile.get(str(b.id));
    if (!f || !localCfg.enabled || !localCatOk(localIndex().catById.get(f.item.cat))) return send(res, 404, { error: '找不到文件' });
    if (!['play', 'reveal'].includes(b.action)) return send(res, 400, { error: 'action 要么是 play 要么是 reveal' });
    if (!await fsp.stat(f.path).then(st => st.isFile(), () => false)) return send(res, 404, { error: '文件已不在磁盘上，重新扫描一下' });
    try { await openPath(f.path, b.action === 'reveal'); } catch (e) { return send(res, 500, { error: '打开失败：' + (e.message || e) }); }
    return send(res, 200, { ok: true });
  }
  if (route === 'probe') return send(res, 200, await probeStream(q.get('u') || ''));
  // 自动识别片头 / 片尾 / 每集重复的广告: 立刻返回，没算完是 pending，客户端过一会儿再问
  if (route === 'skipmarks') return send(res, 200, await rpc('skipmarks', { u: q.get('u') || '', n: q.get('n') || '' }, 5000).catch(() => ({ status: 'none' })));
  if (route === 'local/scan' && write) return send(res, 200, await rpc('localScan'));
  if (route === 'local/vod') {
    const host = /^([\w-]+\.)*[\w-]+(:\d+)?$|^\[[\da-f:]+\](:\d+)?$/i.test(req.headers.host || '') ? req.headers.host : `${lanIps()[0] || '127.0.0.1'}:${PORT}`;
    return send(res, 200, localCms(Object.fromEntries(q), `${req.socket.encrypted ? 'https' : 'http'}://${host}`));
  }

  // ---- live: speed test, raw text editing, covers ----
  if (route === 'checklive') return send(res, 200, await checkLive(q.get('url') || '', q.get('name') || ''));
  if (route === 'vod/group') {
    // Snapshot of a 聚合源 as local list text. The members are read from the saved config (by key); `keys` may also be passed
    // for rows that were just added in the settings page and not saved yet.
    const keys = (q.get('keys') || '').split(',').map(s => s.trim()).filter(Boolean);
    const members = keys.map(k => config.sites.find(x => x.key === k && x.api && !x.members)).filter(Boolean)
      .filter(m => safety.level === 'all' || !m.adult);
    if (!members.length) return send(res, 200, { text: '', error: '这个聚合源的成员都不在已保存的源里（先点「保存」再试），或当前安全级别下不可用' });
    try { return send(res, 200, await groupText({ memberSites: members }, { done: 0, total: 0, titles: 0, cancel: false })); }
    catch (e) { return send(res, 200, { text: '', error: e.message }); }
  }
  if (route === 'vod/snap') {
    const body = write ? await readBody(req) : {};
    const id = String(write ? body.id : q.get('id') || '').replace(/[^\w]/g, '').slice(0, 24);
    if (!id) return send(res, 400, { error: 'missing id' });
    const op = !write ? 'status' : ['start', 'stop', 'cancel', 'commit'].includes(body.op) ? body.op : '';
    if (!op) return send(res, 400, { error: 'bad op' });
    const r = await rpc('vodSnap', { op, id, api: body.api, keys: Array.isArray(body.keys) ? body.keys.map(String) : undefined, withText: q.get('text') === '1' });
    return send(res, 200, r);
  }
  if (route === 'vod/raw') {
    if (req.method === 'GET') {
      try { return send(res, 200, await vodText(q.get('api') || '', { done: 0, total: 0, titles: 0, cancel: false }).then(r => typeof r === 'string' ? { text: r } : r)); }
      catch (e) { return send(res, 200, { text: '', error: e.message }); }
    }
    if (!pinOk(req)) return needPin(res);
    return leader('config', { op: 'vodRaw', body: await readBody(req, 512e6) });
  }
  if (route === 'live/raw') {
    if (req.method === 'GET') {
      try { return send(res, 200, { text: await liveText(q.get('url') || '', true) }); }
      catch (e) { return send(res, 200, { text: '', error: e.message }); }
    }
    if (!pinOk(req)) return needPin(res);
    return leader('config', { op: 'liveRaw', body: await readBody(req, 512e6) });
  }
  // 编辑文本 in VS Code (this machine only): the list becomes a local file under data/lives and that file is opened in the
  // editor; saved edits are read from disk on every load, so nothing else has to be done afterwards.
  if (route === 'live/edit' && write) {
    if (!isLoopback(req)) return send(res, 403, { error: '只有在这台电脑本机（localhost）上才能调用 VS Code' });
    if (!pinOk(req)) return needPin(res);
    const url = str((await readBody(req)).url);
    let file;
    if (url.startsWith('local:')) file = path.basename(url.slice(6));
    else {
      file = crypto.randomBytes(5).toString('hex') + '.m3u';
      await fsp.writeFile(path.join(LIVES, file), await liveText(url, true));
    }
    const full = path.join(LIVES, file);
    try { await openInVSCode(full); } catch (e) { return send(res, 200, { ok: false, url: 'local:' + file, error: e.message }); }
    return send(res, 200, { ok: true, url: 'local:' + file, path: full });
  }
  if (route === 'live/merge' && write) {
    if (!pinOk(req)) return needPin(res);
    return leader('config', { op: 'liveMerge', body: await readBody(req) });
  }
  if (route === 'live/thumb' || route === 'live/preview') {
    const u = q.get('u') || '';
    if (!/^https?:\/\//.test(u)) return send(res, 400, { error: 'bad url' });
    if (req.method === 'POST' && route === 'live/thumb') {
      // Fallback when the server has no ffmpeg: the browser captured a frame from the hover preview.
      const { data } = await readBody(req);
      const m = /^data:image\/jpeg;base64,(.+)$/.exec(str(data));
      if (m) await fsp.writeFile(mediaFile('thumb', u), Buffer.from(m[1], 'base64'));
      return send(res, 200, { ok: !!m });
    }
    const kind = route === 'live/thumb' ? 'thumb' : 'preview', sig = reqCtx.getStore()?.signal;
    let left = false;
    const leave = () => { if (!left) { left = true; rpc('media', { kind, url: u, hold: 'leave' }).catch(() => {}); } };
    sig?.addEventListener('abort', leave, { once: true });
    let file;
    try { file = await rpc('media', { kind, url: u, hold: 'ref' }, 90000); } finally { sig?.removeEventListener('abort', leave); }
    if (sig?.aborted) return;
    if (!file) return send(res, 404, { error: FFMPEG ? '截不到画面' : '服务端没有 ffmpeg' });
    res.writeHead(200, { 'Content-Type': route === 'live/thumb' ? 'image/jpeg' : 'image/gif', 'Cache-Control': 'max-age=300' });
    return fs.createReadStream(file).pipe(res);
  }

  // ---- javdb (成人元数据，仅在非儿童级别开放) ----
  if (route === 'javdb') {
    if (safety.level !== 'all') return send(res, 200, { found: false });
    return send(res, 200, await rpc('javdb', { code: q.get('code') || '' }));
  }

  // ---- 豆瓣 ----
  if (route === 'douban/rating') return send(res, 200, await rpc('dbRating', { name: q.get('name') || '', year: q.get('year') || '' }));
  if (route === 'douban/hot') return send(res, 200, safety.level === 'kids' ? { list: [] } : await rpc('dbHot', { type: ['movie', 'show', 'anime'].includes(q.get('type')) ? q.get('type') : 'tv' }));
  if (route === 'douban/charts') {
    if (safety.level === 'kids') return send(res, 200, { off: true });
    return send(res, 200, { ...CHARTS, genres: CHARTS.genres.filter(g => !g.adult || safety.level === 'all'), years: chartYears() });
  }
  if (route === 'douban/chart') {
    if (safety.level === 'kids') return send(res, 200, { list: [], end: true, error: '儿童模式下榜单不可用' });
    const args = Object.fromEntries(['kind', 'id', 'type', 'interval', 'genre', 'region', 'year', 'sort', 'start', 'count'].map(k => [k, q.get(k) || '']));
    try { return send(res, 200, await rpc('dbChart', args)); }
    catch (e) { return send(res, 200, { list: [], end: true, error: e.message }); }
  }

  // ---- downloads (leader runs the queue) ----
  if (route === 'downloads') {
    return leader('downloads', { method: req.method, id: q.get('id'), action: q.get('action'), body: req.method === 'POST' ? await readBody(req) : null });
  }

  // ---- 直播 ----
  if (route === 'sites') {
    return send(res, 200, sitesBody(SITES, pv));
  }
  if (route === 'live') {
    if (pv?.live) {
      const parsed = await previewLive(pv);
      return parsed ? send(res, 200, parsed) : send(res, 404, { error: '预览内容已过期，回到设置页重新点预览' });
    }
    const src = config.lives[Number(q.get('src')) || 0];
    if (!src || !liveSrcOk(src)) return send(res, 200, { groups: [] });
    const parsed = parseLive(await liveText(src.url), src);
    return send(res, 200, { ...parsed, groups: liveFilter(parsed.groups, src) });
  }

  // ---- 点播 ----
  // 一个源 / 聚合源的搜索范围; 聚合源标了成人时，它的成员在这里也按成人算 (评分 / 封面走 javdb)
  const scopeSites = only => only.memberSites ? only.memberSites.map(m => only.adult && !m.adult ? { ...m, adult: 1 } : m) : [only];
  if (route === 'person') {
    const name = (q.get('name') || '').trim();
    if (!name) return send(res, 400, { error: '缺少名字' });
    const only = SITES.find(s => s.key === q.get('site'));   // same scope switch as search: one source (a 聚合源 → its members) or all
    return send(res, 200, { list: await person(name, q.get('role'), only ? scopeSites(only) : SITES.filter(s => !s.memberSites)) });
  }
  if (route === 'search') {
    const wd = (q.get('wd') || '').trim();
    // `site` limits the search to one source (a 聚合源 → its members); without it every source is searched.
    const only = SITES.find(s => s.key === q.get('site'));
    const targets = only ? scopeSites(only) : SITES.filter(s => !s.memberSites);
    // Many sources answer a keyword with loosely related (or unrelated) titles. Keep a title only when the query is in its
    // name / alias, or its name is inside the query (a longer phrase such as "名字 第二季"); actors / directors are covered below.
    const nq = searchNorm(wd);
    const nameHit = d => {
      if (!nq) return true;
      for (const f of [d.vod_name, d.vod_sub, d.vod_en]) {
        const n = searchNorm(f);
        if (n && (n.includes(nq) || (n.length >= 2 && nq.includes(n)))) return true;
      }
      return false;
    };
    const out = await Promise.all(targets.map(s => cmsGet(s, { ac: 'detail', wd }, false, 8000)
      .then(b => ({ site: s.key, all: (b.list || []).map(d => ({ d, it: item(s, d) })).filter(x => itemOk(s, x.it)) }))
      .then(o => ({ site: o.site, all: o.all, list: o.all.filter(x => nameHit(x.d)) }))
      .catch(e => ({ site: s.name, error: e.message, list: [] }))));
    // Many sites' `wd` also matches vod_actor / vod_director. Any credited name containing the query counts;
    // hits are grouped per person (most works first), each list one per title + year, newest first.
    const credit = field => {
      const people = new Map();
      for (const { d, it } of out.flatMap(o => o.all || o.list)) {
        if (!wd || /解说|预告/.test(it.name + it.type)) continue;
        for (const p of new Set(splitPeople(d[field]).filter(p => p.includes(wd)))) {
          if (!people.has(p)) people.set(p, { seen: new Set(), list: [] });
          const g = people.get(p), k = it.name.replace(/\s+/g, '').replace(it.year, '') + '|' + it.year;
          if (!g.seen.has(k)) { g.seen.add(k); g.list.push(it); }
        }
      }
      return [...people].map(([name, g]) => ({ name, count: g.list.length }))
        .sort((a, b) => (b.name === wd) - (a.name === wd) || b.count - a.count).slice(0, 30);
    };
    return send(res, 200, { results: out.flatMap(o => o.list.map(x => x.it)), actor: credit('vod_actor'), director: credit('vod_director'),
      failed: out.filter(o => o.error).map(o => o.site) });
  }

  // A source that is not visible at this 安全级别 (e.g. a 成人 one, typed into the URL) is refused, not swapped for another.
  if (q.get('site') && !SITES.some(s => s.key === q.get('site'))) return send(res, 404, { error: '没有这个源（当前安全级别下不可用）' });
  const site = SITES.find(s => s.key === q.get('site')) || SITES[0];
  if (!site) return send(res, 404, { error: safety.level === 'kids' ? '儿童模式下没有少儿源，去「设置」添加' : '还没有点播源，去「设置」里添加' });

  if (route === 'categories') return send(res, 200, { categories: site.memberSites ? await groupCategories(site) : await categories(site) });
  if (route === 'list' && site.memberSites) return send(res, 200, await groupList(site, q.get('t') || '', q.get('pg') || '1'));
  if (route === 'detail' && site.memberSites) {
    const gd = await groupDetail(site, q.get('id'));
    if (!gd) return send(res, 404, { error: '没有这部（聚合源里的成员都打不开或没有）' });
    const { first, all } = gd, it = item(first.m, first.d);
    if (site.adult) it.adult = 1;   // 聚合源整体标了成人: 它的片都算成人 (成员自己没标也一样)
    if (!itemOk(first.m, it)) return send(res, 403, { error: '当前安全级别下不可看' });
    const ls = all.flatMap(({ m, d }) => lines(d).map(l => ({ ...l, name: `${m.name} · ${l.name}` })));
    const d = first.d;
    return send(res, 200, { ...it, typeId: catKey(it.type), site: site.key, siteName: site.name, id: q.get('id'), quality: it.quality || bestQuality(ls.map(l => l.quality)), blurb: clean(d.vod_content),
      actor: str(d.vod_actor), director: str(d.vod_director), actors: splitPeople(d.vod_actor), directors: splitPeople(d.vod_director), lang: str(d.vod_lang), lines: ls });
  }
  if (route === 'list') {
    let t = q.get('t') || '';
    // Whitelisted (e.g. 少儿) sites: "latest" comes from their first allowed category.
    if (!t && (site.categories || safety.level === 'kids')) t = (await categories(site))[0]?.id || '';
    const b = await cmsGet(site, { ac: 'detail', t, pg: q.get('pg') || '1' });
    return send(res, 200, { list: (b.list || []).map(d => item(site, d)).filter(it => itemOk(site, it)),
      page: Number(b.page) || 1, pagecount: Number(b.pagecount) || 1 });
  }
  if (route === 'detail') {
    const b = await cmsGet(site, { ac: 'detail', ids: q.get('id') });
    const d = (b.list || [])[0];
    if (!d) return send(res, 404, { error: '没有这部' });
    const it = item(site, d);
    if (!itemOk(site, it)) return send(res, 403, { error: '当前安全级别下不可看' });
    const ls = lines(d);
    return send(res, 200, { ...it, quality: it.quality || bestQuality(ls.map(l => l.quality)), blurb: clean(d.vod_content), actor: str(d.vod_actor), director: str(d.vod_director),
      actors: splitPeople(d.vod_actor), directors: splitPeople(d.vod_director), lang: str(d.vod_lang), lines: ls, ...(site.local ? { local: true } : {}) });
  }
  send(res, 404, { error: 'unknown api' });
}

// ======================= leader-side handlers =======================
const LEVEL_RANK = { kids: 0, standard: 1, all: 2 };
rpcHandlers.safety = b => {
  // With a PIN set, going to a stricter level is free (locking never needs a key); loosening the level, or changing / clearing
  // the PIN, needs the PIN.
  const loosen = LEVEL_RANK[b.level] > LEVEL_RANK[safety.level];
  const needs = typeof b.newPin === 'string' || loosen;
  if (safety.pin && needs && b.pin !== safety.pin) return { code: 403, body: { error: loosen ? '切换到更宽松的级别需要家长 PIN' : '需要家长 PIN', pin: true } };
  const after = ['kids', 'standard', 'all'].includes(b.level) ? b.level : safety.level;
  // A PIN guards the stricter levels, so it can only be removed while the level is 「全部」. (Forgotten PIN: run reset-pin.js on the host.)
  if (b.newPin === '' && safety.pin && after !== 'all') return { code: 403, body: { error: '儿童 / 标准模式下不能清除 PIN，先切到「全部」（需要 PIN）。忘记 PIN 的话，在运行服务的电脑上执行 node reset-pin.js' } };
  if (['kids', 'standard', 'all'].includes(b.level)) safety.level = b.level;
  if (typeof b.newPin === 'string') safety.pin = b.newPin.trim();
  writeJson(SAFETY, safety);
  broadcastReload();
  return { body: { level: safety.level, hasPin: !!safety.pin } };
};

rpcHandlers.config = async ({ op, body: b }) => {
  let extra = {};
  if (op === 'put') config = normalize(b);
  else if (op === 'reset') config = defaults();
  else if (op === 'liveRaw') {
    const file = str(b.url).startsWith('local:') ? path.basename(str(b.url).slice(6)) : crypto.randomBytes(5).toString('hex') + '.m3u';
    await fsp.writeFile(path.join(LIVES, file), str(b.text));
    broadcastReload();
    return { body: { url: 'local:' + file } };
  } else if (op === 'vodRaw') {
    const parsed = parseVodText(b.text);
    if (!parsed.items.length) return { code: 422, body: { error: '没有读到片：每行写「片名,播放地址」（地址要 http(s)），分类用「分类名,#genre#」' + (parsed.bad.length ? `；第 ${parsed.bad.slice(0, 5).join('、')} 行格式不对` : '') } };
    const file = LOCAL_VOD.test(str(b.api)) ? path.basename(str(b.api).slice(6)) : crypto.randomBytes(5).toString('hex') + '.txt';
    await fsp.writeFile(path.join(VODS, file), str(b.text));
    vodFileCache.clear();
    broadcastReload();
    return { body: { api: 'local:' + file, titles: parsed.items.length, cats: parsed.cats.length, bad: parsed.bad.length } };
  } else if (op === 'liveMerge') {
    // Merge several live sources into one local m3u: same group name joins, same stream url is kept once.
    const srcs = (Array.isArray(b.sources) ? b.sources : []).filter(s => s && s.url);
    const groups = new Map(), seen = new Set(), failed = [];
    let dup = 0;
    await Promise.all(srcs.map(async s => {
      try { s.parsed = parseLive(await liveText(str(s.url), true), { url: str(s.url), name: str(s.name) }).groups; }
      catch (e) { failed.push(str(s.name) || str(s.url)); }
    }));
    // Streams pasted from the clipboard carry the placeholder group 「剪贴板」 (a plain list: 「其他」): in a merge they go
    // under the name their source had before, not under a group of their own.
    for (const s of srcs) for (const g of s.parsed || []) for (const c of g.channels) {
      if (seen.has(c.url)) { dup++; continue; }
      seen.add(c.url);
      const gn = g.name === '剪贴板' || g.name === '其他' ? (str(s.name).trim() || g.name) : g.name;
      if (!groups.has(gn)) groups.set(gn, []);
      groups.get(gn).push(c);
    }
    if (!seen.size) return { code: 422, body: { error: '选中的直播源里没解析出频道' + (failed.length ? '（打不开：' + failed.join('、') + '）' : '') } };
    const clean = t => str(t).replace(/["\r\n]/g, ' ').trim();
    const out = ['#EXTM3U'];
    for (const [g, chs] of groups) for (const c of chs)
      out.push(`#EXTINF:-1${c.logo ? ` tvg-logo="${clean(c.logo)}"` : ''} group-title="${clean(g)}",${clean(c.name).replace(/,/g, ' ')}`, c.url);
    const file = crypto.randomBytes(5).toString('hex') + '.m3u';
    await fsp.writeFile(path.join(LIVES, file), out.join('\n') + '\n');
    broadcastReload();
    return { body: { url: 'local:' + file, channels: seen.size, groups: groups.size, dup, failed } };
  } else if (op === 'import') {
    if (!/^https?:\/\//.test(b.url || '')) return { code: 400, body: { error: '要 http(s) 地址' } };
    const found = await importFrom(b.url);
    const kept = await dropEmptySites(found.sites);
    found.sites = kept.sites;
    const cls = await classifyNew(found.sites);
    if (!found.sites.length && !found.lives.length) return { code: 422, body: { error: kept.dropped ? `找到的 ${kept.dropped} 个点播源都是 0 部内容，没有导入` : '没找到可直连的苹果CMS点播源或直播源' } };
    config = b.replace ? found : normalize({ sites: [...config.sites, ...found.sites], lives: [...config.lives, ...found.lives] });
    extra = { imported: { sites: found.sites.length, lives: found.lives.length, skippedEmpty: kept.dropped, adult: cls.adult, kids: cls.kids } };
  } else if (op === 'add') {
    // From clipboard recognition: append only what isn't there; pasted lists become local files.
    const lives = [];
    const haveText = new Set();
    for (const f of await fsp.readdir(LIVES).catch(() => [])) {
      if (config.lives.some(l => l.url === 'local:' + f)) haveText.add(textKey(await fsp.readFile(path.join(LIVES, f), 'utf8').catch(() => '')));
    }
    for (const l of Array.isArray(b.lives) ? b.lives : []) {
      if (l.empty) continue;
      if (l.text && haveText.has(textKey(l.text))) continue;
      if (l.text) {
        haveText.add(textKey(l.text));
        const file = crypto.randomBytes(5).toString('hex') + '.m3u';
        await fsp.writeFile(path.join(LIVES, file), str(l.text));
        lives.push({ name: str(l.name) || '剪贴板频道', url: 'local:' + file, ...(Number(l.kids) ? { kids: 1 } : {}), ...(Number(l.adult) ? { adult: 1 } : {}) });
      } else if (l.empty) continue;
      else if (/^https?:\/\//.test(str(l.url))) lives.push({ name: str(l.name) || hostOf(l.url), url: str(l.url), ...(Number(l.kids) ? { kids: 1 } : {}), ...(Number(l.adult) ? { adult: 1 } : {}) });
    }
    const haveApi = new Set(config.sites.filter(s => !s.categories).map(s => normApi(s.api)));
    const incoming = [];
    const haveVod = new Set();
    for (const s of config.sites) if (LOCAL_VOD.test(str(s.api))) haveVod.add(textKey(await fsp.readFile(path.join(VODS, path.basename(s.api.slice(6))), 'utf8').catch(() => '')));
    for (const s of Array.isArray(b.sites) ? b.sites : []) {
      if (typeof s.text !== 'string') { incoming.push(s); continue; }
      if (s.empty || haveVod.has(textKey(s.text)) || !parseVodText(s.text).items.length) continue;
      haveVod.add(textKey(s.text));
      const file = crypto.randomBytes(5).toString('hex') + '.txt';
      await fsp.writeFile(path.join(VODS, file), s.text);
      incoming.push({ name: str(s.name) || '分享的片单', api: 'local:' + file, probed: true, ok: true, ...(Number(s.kids) ? { kids: 1 } : {}), ...(Number(s.adult) ? { adult: 1 } : {}) });
    }
    const apiOf = new Map(incoming.filter(s => !s.members).map(s => [str(s.key), s.api]));
    const fresh = incoming.filter(s => s.members || s.categories || !haveApi.has(normApi(s.api)));
    // Already probed (and classified) during recognition: saving does no network work. Only API callers that skip that pay for it here.
    const probed = fresh.filter(s => s.probed), raw = fresh.filter(s => !s.probed);
    const kept = await dropEmptySites(raw);
    const sites = [...fresh.filter(s => s.probed ? !s.empty : kept.sites.includes(s))];
    const skippedEmpty = probed.filter(s => s.empty).length + kept.dropped;
    const cls = await classifyNew(sites.filter(s => !s.probed));
    for (const s of sites) if (s.probed) { if (s.adult) cls.adult++; else if (s.kids) cls.kids++; }
    // A pasted group refers to its members by key; re-point them at whatever source has the same link here.
    for (const g of sites.filter(s => s.members)) {
      g.members = g.members.map(k => {
        const api = apiOf.get(str(k)); if (!api) return k;
        return config.sites.find(x => x.api && normApi(x.api) === normApi(api) && !x.categories)?.key || str(k);
      });
    }
    const before = { s: config.sites.length, l: config.lives.length };
    config = normalize({ sites: [...config.sites, ...sites], lives: [...config.lives, ...lives] });
    extra = { added: { sites: config.sites.length - before.s, lives: config.lives.length - before.l, skippedEmpty, adult: cls.adult, kids: cls.kids } };
  }
  saveConfig();
  broadcastReload();
  return { body: { ...config, ...extra } };
};

// Queue order: strictly increasing, so a batch added in one request keeps its episode order.
let qSeq = 0;
const nextQ = () => (qSeq = Math.max(Date.now() * 1000, qSeq + 1));

rpcHandlers.downloads = async ({ method, id, action, body: b }) => {
  if (method === 'POST') {
    const added = [];
    for (const e of Array.isArray(b.items) ? b.items : [b]) {
      if (!/^https?:\/\//.test(str(e.url))) continue;
      const key = `${e.site}|${e.id}|${e.url}`;
      let j = jobs.find(x => x.key === key);
      if (j) { if (j.status === 'error' || j.status === 'paused') { j.status = 'queued'; j.qat = nextQ(); } }
      else {
        j = { id: crypto.randomBytes(6).toString('hex'), key, site: str(e.site), siteName: str(e.siteName), vid: str(e.id), name: str(e.name),
          pic: str(e.pic), adult: e.adult ? 1 : 0, line: Number(e.line) || 0, ep: Number(e.ep) || 0, epName: str(e.epName), url: e.url,
          status: 'queued', done: 0, total: 0, bytes: 0, at: Date.now(), qat: nextQ() };
        jobs.unshift(j);
      }
      added.push(j.id);
    }
    saveJobs(); pump();
    return { body: { added } };
  }
  if (method === 'DELETE') {
    const j = jobs.find(x => x.id === id);
    if (j) {
      const wasRunning = j.status === 'downloading';
      j.status = 'deleted';                         // stops its run (mine() turns false)
      jobs = jobs.filter(x => x !== j);             // remove first: the index can shift while we await
      saveJobs();
      // A running job's folder is removed again once its run has stopped (see pump()).
      await fsp.rm(path.join(DL, j.id), { recursive: true, force: true, maxRetries: wasRunning ? 3 : 0 }).catch(() => {});
    }
    return { body: { ok: true } };
  }
  if (method === 'PATCH') {
    // id '*' = every job (全部暂停 / 全部开始).
    const order = j => j.qat ?? j.at;
    for (const j of id === '*' ? [...jobs].sort((a, b) => order(a) - order(b)) : jobs.filter(x => x.id === id)) {
      if (action === 'pause' && ['queued', 'downloading'].includes(j.status)) j.status = 'paused';
      if (action === 'resume' && ['paused', 'error'].includes(j.status)) { j.status = 'queued'; j.qat = nextQ(); }
      if (action === 'top' && ['queued', 'paused', 'error'].includes(j.status)) { j.status = 'queued'; j.qat = Math.min(0, ...jobs.map(x => x.qat ?? 0)) - 1; }
    }
    saveJobs(); pump();
    return { body: { ok: true } };
  }
  let free = null;
  try { const st = await fsp.statfs(DL); free = st.bavail * st.bsize; } catch {}
  const queue = jobs.filter(x => x.status === 'queued').sort((a, b) => (a.qat ?? a.at) - (b.qat ?? b.at)).map(x => x.id);
  // 成人 downloads (flagged, or from a source that is hidden at this level) are not listed outside 全部.
  const shown = j => { if (safety.level === 'all') return true; if (j.adult) return false; if (j.site === 'local') return safety.level !== 'kids'; const s = config.sites.find(x => x.key === j.site); return !!s && !s.adult && (safety.level !== 'kids' || !!s.kids); };
  return { body: { jobs: jobs.filter(shown).map(j => ({ ...jobView(j), qpos: queue.indexOf(j.id) + 1 })), free, dir: DL, maxJobs: MAX_JOBS } };
};

// True only for a browser on this very machine: the socket peer is loopback AND the request is addressed to
// localhost (a page on another site that resolves its own name to 127.0.0.1 — DNS rebinding — carries its own
// Host / Origin and is refused).
function isLoopback(req) {
  const peer = str(req.socket.remoteAddress).replace(/^::ffff:/, '');
  if (!(peer === '127.0.0.1' || peer === '::1')) return false;
  const loop = h => { try { const n = new URL('http://' + h).hostname; return n === 'localhost' || n === '127.0.0.1' || n === '[::1]'; } catch { return false; } };
  if (!loop(req.headers.host || '')) return false;
  const o = req.headers.origin;
  if (o && o !== 'null') { try { if (!loop(new URL(o).host)) return false; } catch { return false; } }
  return true;
}
// Hand a file to the OS. Arguments go as an array (no shell), so file names can't inject commands.
// Windows: the window of what we open must stay visible (no windowsHide here), explorer wants backslashes, and
// `/select,"path"` has to reach it with the quotes intact (windowsVerbatimArguments). explorer.exe exits non-zero
// even when it worked, so only a failure to start counts as an error.
function openPath(file, reveal) {
  const win = process.platform === 'win32';
  if (win) file = path.win32.normalize(file.replace(/\//g, '\\'));
  const [cmd, args] = process.platform === 'darwin' ? ['open', reveal ? ['-R', file] : [file]]
    : win ? (reveal ? [process.env.SystemRoot ? path.win32.join(process.env.SystemRoot, 'explorer.exe') : 'explorer.exe', [`/select,"${file}"`]]
        : [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `start "" "${file}"`]])
    : ['xdg-open', [reveal ? path.dirname(file) : file]];
  return new Promise((ok, bad) => {
    const p = spawn(cmd, args, { stdio: 'ignore', detached: !win, windowsVerbatimArguments: win });
    p.on('error', bad);
    p.unref();
    setTimeout(ok, 200);
  });
}
// VS Code: the `code` command when it is on PATH, else the app itself (macOS / Windows default install locations).
function openInVSCode(file) {
  const win = process.platform === 'win32';
  const tries = [[win ? 'code.cmd' : 'code', [file]]];
  if (process.platform === 'darwin') tries.push(['open', ['-a', 'Visual Studio Code', file]]);
  if (win && process.env.LOCALAPPDATA) tries.push([path.win32.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe'), [file]]);
  const run = ([cmd, args]) => new Promise((ok, bad) => {
    const p = spawn(cmd, args, { stdio: 'ignore', detached: !win, shell: win && /\.cmd$/i.test(cmd) });
    let done = false;
    p.on('error', e => { if (!done) { done = true; bad(e); } });
    p.on('exit', c => { if (!done && c) { done = true; bad(new Error('exit ' + c)); } });
    p.unref();
    setTimeout(() => { if (!done) { done = true; ok(); } }, 1200);
  });
  return (async () => {
    for (const t of tries) { try { return await run(t); } catch {} }
    throw new Error('没找到 VS Code（命令行 code 不可用）');
  })();
}
function lanIps() {
  return Object.values(os.networkInterfaces()).flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.')).map(i => i.address);
}

// Live source formats: m3u/m3u8 channel list (#EXTINF + group-title), TVBox txt (名称,url + #genre#),
// or a single HLS stream (.m3u8 with #EXT-X-TARGETDURATION / STREAM-INF) → one channel.
function parseLive(text, src = {}) {
  const groups = new Map();
  const add = (g, ch) => { if (!groups.has(g)) groups.set(g, []); groups.get(g).push(ch); };
  const rows = text.split(/\r?\n/).map(l => l.trim());
  if (/^https?:\/\//.test(src.url || '') && /#EXT-X-(TARGETDURATION|STREAM-INF|MEDIA-SEQUENCE)/.test(text)) {
    add(src.name || '直播', { name: src.name || '直播', logo: '', url: src.url });
  } else if (text.includes('#EXTINF')) {
    let pending = null;
    for (const l of rows) {
      if (l.startsWith('#EXTINF')) {
        const attr = k => (l.match(new RegExp(k + '="([^"]*)"')) || [])[1] || '';
        pending = { name: l.split(',').pop().trim(), group: attr('group-title') || '其他', logo: attr('tvg-logo') };
      } else if (l && !l.startsWith('#') && pending) {
        add(pending.group, { name: pending.name, logo: pending.logo, url: l });
        pending = null;
      }
    }
  } else {
    let g = '其他';
    for (const l of rows) {
      const i = l.indexOf(',');
      if (i < 0) continue;
      const name = l.slice(0, i), rest = l.slice(i + 1);
      if (rest.includes('#genre#')) { g = name; continue; }
      for (const u of rest.split('#')) if (/^https?:\/\//.test(u)) add(g, { name, logo: '', url: u });
    }
  }
  return { groups: [...groups].map(([name, channels]) => ({ name, channels })) };
}

// Stream relay for CDNs without CORS. Rewrites playlist URIs so segments come through here too.
async function relay(target, res, req) {
  let u;
  try { u = new URL(target); } catch { return send(res, 400, 'bad url', 'text/plain'); }
  if (!/^https?:$/.test(u.protocol)) return send(res, 400, 'bad url', 'text/plain');
  const headers = { 'User-Agent': UA };
  if (req.headers.range) headers.Range = req.headers.range;
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ac.abort(); });
  const timer = setTimeout(() => ac.abort(), 20000);
  let r;
  try { r = await fetch(u, { headers, redirect: 'follow', signal: ac.signal }); } finally { clearTimeout(timer); }
  const type = r.headers.get('content-type') || '';
  const isList = /mpegurl/i.test(type) || /\.m3u8(\?|$)/i.test(r.url);
  const base = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
  if (isList) {
    const text = await r.text();
    const wrap = x => '/hls?u=' + encodeURIComponent(new URL(x, r.url).toString());
    const out = text.split(/\r?\n/).map(l => {
      if (!l.trim()) return l;
      if (l.startsWith('#')) return l.replace(/URI="([^"]+)"/g, (_, x) => `URI="${wrap(x)}"`);
      return wrap(l.trim());
    }).join('\n');
    res.writeHead(r.status, { ...base, 'Content-Type': 'application/vnd.apple.mpegurl' });
    return res.end(out);
  }
  const h = { ...base, 'Content-Type': type || 'application/octet-stream' };
  for (const k of ['content-length', 'content-range', 'accept-ranges']) if (r.headers.get(k)) h[k] = r.headers.get(k);
  res.writeHead(r.status, h);
  if (r.body) Readable.fromWeb(r.body).on('error', () => res.destroy()).pipe(res); else res.end();
}

// Static files: kept in memory with a pre-gzipped copy; re-read when the file changes on disk.
// no-cache + ETag: the browser revalidates, so an updated app.js/style.css shows up on the next load.
const staticCache = new Map();
async function serveStatic(p, req, res) {
  const file = path.normalize(path.join(PUBLIC, p === '/' ? 'index.html' : p));
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'forbidden', 'text/plain');
  const st = await fsp.stat(file).catch(() => null);
  if (!st || !st.isFile()) return send(res, 404, 'not found', 'text/plain');
  if (file === INDEX_HTML) {
    // 入口页由服务端把「已登录 / 未登录」直接写进 <html data-auth>，首帧就是对的状态：不会先闪出内容再盖蒙层，也不会先闪蒙层再消失。
    let c = staticCache.get(file);
    if (!c || c.mtime !== st.mtimeMs) { c = { mtime: st.mtimeMs, text: await fsp.readFile(file, 'utf8') }; staticCache.set(file, c); }
    let html = c.text.replace(/<html\b/, `<html data-auth="${req.authed ? 1 : 0}"`);
    // 已登录且不是预览页（带 ?pv= 的）：把 /api/sites 的内容直接写进页面，前端 loadSites 不用再发请求。< 转义，防止 </script> 截断。
    if (req.authed && !String(req.url || '').includes('?')) {
      const boot = JSON.stringify(sitesBody(visibleSites(), null)).replace(/</g, '\\u003c');
      html = html.replace('<head>', () => '<head>\n<script>window.__BOOT__=' + boot + '</script>');
    }
    const body = Buffer.from(html);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', Vary: 'Cookie', 'Content-Length': body.length });
    return res.end(body);
  }
  let c = staticCache.get(file);
  if (!c || c.mtime !== st.mtimeMs) {
    const buf = await fsp.readFile(file);
    const type = MIME[path.extname(file)] || 'application/octet-stream';
    c = { mtime: st.mtimeMs, buf, type, etag: '"' + crypto.createHash('md5').update(buf).digest('hex').slice(0, 16) + '"',
      gz: /text|javascript|css|svg|json/.test(type) && buf.length > 1024 ? zlib.gzipSync(buf, { level: 9 }) : null };
    staticCache.set(file, c);
  }
  if (req.headers['if-none-match'] === c.etag) { res.writeHead(304, { ETag: c.etag }); return res.end(); }
  const gz = c.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  const body = gz ? c.gz : c.buf;
  res.writeHead(200, { 'Content-Type': c.type, 'Cache-Control': 'no-cache', ETag: c.etag, 'Content-Length': body.length,
    ...(gz ? { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : {}) });
  res.end(body);
}

// ---- 访问令牌 ----
// 一道统一的闸，放在所有路由前面：除了网页本身的静态文件，/api /hls /img /dl /media 全部要令牌，没有一个接口单独处理。
// 令牌两种带法，都不走 URL：Cookie（浏览器登录后服务端种下，HttpOnly、长期有效，<img> / <video> / hls 请求自动带上）、
// Authorization: Bearer（网页的 fetch 拦截器带，用来登录和 Cookie 丢了时自动恢复）。
// 带对了令牌、而 Cookie 还不对，就顺手种一个 Cookie。
const INDEX_HTML = path.join(PUBLIC, 'index.html');
const COOKIE = 'tvbox_token';
const tokenHash = crypto.createHash('sha256').update(TOKEN).digest();
const tokenOk = v => typeof v === 'string' && v.length > 0 && v.length < 512 &&
  crypto.timingSafeEqual(crypto.createHash('sha256').update(v).digest(), tokenHash);
const ADMIN_COOKIE = 'tvbox_admin';
const adminHash = crypto.createHash('sha256').update(ADMIN_TOKEN).digest();
const adminTokenOk = v => typeof v === 'string' && v.length > 0 && v.length < 512 &&
  crypto.timingSafeEqual(crypto.createHash('sha256').update(v).digest(), adminHash);
const adminAuthed = req => adminTokenOk(cookieOf(req, ADMIN_COOKIE)) || adminTokenOk(String(req.headers['x-admin-token'] || ''));
const cookieOf = (req, name) => {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) { try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return ''; } }
  }
  return '';
};
const failures = new Map(); // ip -> { n, reset }  给错令牌的次数（每个 worker 各记各的）
setInterval(() => { const now = Date.now(); for (const [k, v] of failures) if (v.reset < now) failures.delete(k); }, 60000).unref();
// -> { ok, tooMany, fresh }  fresh = 令牌是 header 带的，Cookie 还没有
function checkAuth(req, u) {
  if (tokenOk(cookieOf(req, COOKIE))) return { ok: true };
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!m) return { ok: false };
  const given = m[1].trim();
  const ip = req.socket.remoteAddress || '';
  const f = failures.get(ip);
  if (f && f.n >= 10 && f.reset > Date.now()) return { ok: false, tooMany: true };
  if (tokenOk(given)) return { ok: true, fresh: true };
  const x = f && f.reset > Date.now() ? f : { n: 0, reset: Date.now() + 60000 };
  x.n++; failures.set(ip, x);
  return { ok: false, bad: true };
}

// ---- worker protection: heartbeat to the primary, memory / event-loop self check, drain on request, crash handlers ----
{
  const role = !cluster.isWorker ? '' : process.env.TVBOX_LEADER === '1' ? 'leader' : process.env.TVBOX_MEDIA === '1' ? 'media' : 'web';
  let draining = false;
  const drain = why => {
    if (draining) return; draining = true;
    console.log(`  [保护] ${role || 'main'} 进程 ${process.pid} 开始退出：${why}`);
    try { server.close(); tlsServer?.close(); } catch {}      // no new connections; the ones in flight finish
    const done = () => process.exit(0);
    const t = setInterval(() => { if (!openConns) done(); }, 500); t.unref?.();
    setTimeout(done, 15e3).unref();
  };
  let openConns = 0;
  const watch = GUARD.selfWatch({ role, recycle: why => {
    if (cluster.isWorker) { try { process.send({ t: 'recycle', why }); } catch { drain(why); } }
    else if (process.env.TVBOX_SUPERVISED) { try { process.send({ t: 'restart', why }); } catch {} }   // single-process mode: ask the outer watcher
    else console.log('  [保护] 单进程且没有看守进程，只记录：' + why);
  } });
  if (cluster.isWorker) {
    setInterval(() => { try { process.send({ t: 'hb', stats: GUARD.stats }); } catch {} }, 3000).unref();
    process.on('message', m => { if (m && m.t === 'drain') drain(m.why || ''); });
  }
  process.on('uncaughtException', e => { console.error(`  [保护] ${role || 'main'} 未捕获的异常：`, e && e.stack || e); if (/EADDRINUSE|ENOMEM|out of memory/i.test(String(e && (e.code || e.message)))) process.exit(1); });
  process.on('unhandledRejection', e => console.error(`  [保护] ${role || 'main'} 未处理的 Promise 错误（已拦截）：`, e && e.stack || e));
  global.__tvboxGuard = { limits: watch.limits, track: s => { openConns++; s.on('close', () => { openConns--; }); } };
}
const handle = async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const guarded = /^\/(api|hls|img|dl|media)(\/|$)/.test(u.pathname);
  const a = checkAuth(req, u);
  req.authed = a.ok;
  if (a.fresh) {
    const secure = req.socket.encrypted || /^https\b/i.test(req.headers['x-forwarded-proto'] || '');
    res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(TOKEN)}; Path=/; Max-Age=315360000; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`);
  }
  if (guarded && !a.ok) {
    res.setHeader('X-Auth-Required', '1');
    if (a.tooMany) res.setHeader('Retry-After', '60');
    return send(res, a.tooMany ? 429 : 401, { error: a.tooMany ? '令牌错误次数太多，请 1 分钟后再试' : '需要访问令牌', auth: true });
  }
  const gone = new AbortController();
  res.on('close', () => { if (!res.writableFinished) gone.abort(); });
  try {
    if (u.pathname.startsWith('/api/')) return await reqCtx.run({ signal: gone.signal }, () => api(u.pathname.slice(5), u.searchParams, res, req));
    if (u.pathname === '/hls') return await relay(u.searchParams.get('u') || '', res, req);
    if (u.pathname === '/img') return await reqCtx.run({ signal: gone.signal }, () => imageProxy(u.searchParams.get('u') || '', res));
    if (u.pathname.startsWith('/dl/')) return await serveDownload(u.pathname.slice(4), req, res);
    if (u.pathname.startsWith('/media/')) return await serveMedia(u.pathname.slice(7), req, res);
    return await serveStatic(decodeURIComponent(u.pathname), req, res);
  } catch (e) {
    if (res.destroyed) return;            // the browser already gave up (page switched)
    if (!res.headersSent) send(res, 502, { error: e.message || String(e) });
    else res.destroy();
  }
};
const server = http.createServer(handle);
const tlsServer = TLS?.cert ? https.createServer({ cert: TLS.cert, key: TLS.key }, handle) : null;
for (const s of [server, tlsServer]) if (s) {
  s.on(s === tlsServer ? 'secureConnection' : 'connection', c => global.__tvboxGuard.track(c));
  s.keepAliveTimeout = 65000;
  s.headersTimeout = 66000;
}
if (tlsServer && !MEDIA_ONLY) {
  tlsServer.on('tlsClientError', () => {});   // 浏览器对自签名证书的握手中断很常见，不当成错误
  tlsServer.on('error', e => console.error('  [https] 监听失败，只用 http：', e.message));
  tlsServer.listen(HTTPS_PORT, HOST);
}
if (!MEDIA_ONLY) server.listen(PORT, HOST, () => {
  if (!cluster.isWorker) banner(1, !!FFMPEG, DL);
  if (IS_LEADER) {
    pump();
    if (cluster.isWorker) process.send({ t: 'ready', ffmpeg: !!FFMPEG, dl: DL });
  }
});
