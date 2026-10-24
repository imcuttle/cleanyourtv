#!/usr/bin/env node
// TVBox web: zero npm dependencies. One worker per CPU core (node:cluster); stateful work — downloads,
// config/safety writes, ffmpeg, 豆瓣 rate limiting — lives in one "leader" worker, the others reach it over IPC.
//   - serves the Netflix-style UI in ./public
//   - /api/*    sources (editable), 苹果CMS proxy, 豆瓣, safety level, downloads
//   - /hls?u=   relays m3u8/ts for CDNs that send no CORS headers
//   - /dl/<id>/ downloaded episodes, playable by every device on the LAN
'use strict';
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { Readable } = require('stream');
const { spawn, execFileSync } = require('child_process');
const cluster = require('cluster');
const zlib = require('zlib');

const PORT = Number(process.env.PORT) || 9988;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const CONFIG = path.join(ROOT, '..', 'config');
const PUBLIC = path.join(ROOT, 'public');
const DATA = process.env.TVBOX_DATA || path.join(ROOT, 'data');
const DL = path.join(DATA, 'downloads');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
fs.mkdirSync(DL, { recursive: true });

const CPUS = (os.availableParallelism ? os.availableParallelism() : os.cpus().length) || 1;
const WORKERS = Math.max(1, Math.min(Number(process.env.WORKERS) || CPUS, 16));
if (cluster.isPrimary && WORKERS > 1) return primary();
const IS_LEADER = !cluster.isWorker || process.env.TVBOX_LEADER === '1';

// ---- primary: fork, restart, relay RPC between workers and the leader ----
function primary() {
  cluster.schedulingPolicy = cluster.SCHED_RR; // even spread, also on Windows
  let leader = null, announced = false, stopping = false;
  const pending = new Map(); // rpc id -> requesting worker
  const fork = lead => {
    const w = cluster.fork({ TVBOX_LEADER: lead ? '1' : '0' });
    w.isLeader = lead;
    if (lead) leader = w;
    w.on('message', m => {
      if (!m || typeof m !== 'object') return;
      if (m.t === 'rpc') {
        if (!leader || !leader.isConnected()) return w.send({ t: 'rpc-res', id: m.id, error: '服务重启中，稍后再试' });
        pending.set(m.id, w);
        leader.send(m);
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
  fork(true);
  for (let i = 1; i < WORKERS; i++) fork(false);
  cluster.on('exit', (w, code, sig) => {
    if (stopping) return;
    if (w.isLeader) leader = null;
    console.log(`  进程 ${w.process.pid} 退出（${sig || code}），1 秒后重启`);
    setTimeout(() => fork(w.isLeader), 1000);
  });
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { stopping = true; for (const w of Object.values(cluster.workers)) w.kill(); process.exit(0); });
}

function banner(n, ffmpeg, dl) {
  console.log('\n  TVBox 已启动，浏览器打开：\n');
  console.log(`    本机      http://localhost:${PORT}`);
  for (const ip of lanIps()) console.log(`    局域网    http://${ip}:${PORT}`);
  console.log(`\n  进程：${n} 个（CPU ${CPUS} 核，环境变量 WORKERS 可调）`);
  console.log(`  下载目录：${dl}`);
  console.log(`  直播封面：${ffmpeg ? 'ffmpeg 已找到' : '没有 ffmpeg，悬停时用浏览器截图'}`);
  console.log('  关闭这个窗口即停止服务。\n');
}

// ---- RPC: run `op` in the leader (directly when we are the leader) ----
const rpcHandlers = {};
const rpcWait = new Map();
let rpcSeq = 0;
function rpc(op, args, ms = 60000) {
  if (IS_LEADER) return Promise.resolve().then(() => rpcHandlers[op](args));
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
    if (m.t === 'rpc' && IS_LEADER) {
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
  cache.clear();
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json',
  '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.mp4': 'video/mp4', '.m4s': 'video/iso.segment' };

const str = v => (v === undefined || v === null ? '' : String(v));
const clean = h => str(h).replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&[a-z]+;/g, '').trim();
const readJson = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } };
const writeJson = (f, v) => { fs.writeFileSync(f + '.tmp', JSON.stringify(v, null, 1)); fs.renameSync(f + '.tmp', f); };

// ======================= sources (editable, shared on the LAN) =======================
const STORE = path.join(DATA, 'sources.json');

function defaults() {
  return normalize(JSON.parse(fs.readFileSync(path.join(CONFIG, 'vod-apps.json'), 'utf8')));
}

// Keep what a browser can use: 苹果CMS JSON sites (type 1). Extra fields understood here:
//   kids: 1        shown in 儿童 mode
//   adult: 1       hidden unless 安全级别 = 全部
//   categories: [] TVBox-style whitelist of category names
function normalize(cfg) {
  const seen = new Set(), keys = new Set();
  const sites = [];
  for (const s of cfg.sites || []) {
    if (!s || !/^https?:\/\//.test(str(s.api).trim()) || (s.type !== undefined && Number(s.type) !== 1)) continue;
    const api = str(s.api).trim();
    const categories = Array.isArray(s.categories) ? s.categories.map(String).filter(Boolean) : [];
    const sig = api + '|' + categories.join(',');
    if (seen.has(sig)) continue;
    seen.add(sig);
    const name = str(s.name || s.key || api).trim();
    let key = str(s.key || name).trim(), n = 2;
    while (keys.has(key)) key = `${str(s.key || name).trim()}${n++}`;
    keys.add(key);
    const site = { key, name, type: 1, api };
    if (Number(s.kids)) site.kids = 1;
    if (Number(s.adult)) site.adult = 1;
    if (categories.length) site.categories = categories;
    sites.push(site);
  }
  const liveSeen = new Set();
  const lives = (cfg.lives || []).filter(l => l && typeof l.url === 'string' && l.url.trim())
    .map(l => ({ name: str(l.name || l.url).trim(), url: l.url.trim(), ...(l.from ? { from: str(l.from) } : {}) }))
    .filter(l => !liveSeen.has(l.url) && liveSeen.add(l.url));
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

function visibleSites() {
  if (safety.level === 'kids') return config.sites.filter(s => s.kids);
  if (safety.level === 'standard') return config.sites.filter(s => !s.adult);
  return config.sites;
}
function catAllowed(site, name) {
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
    try { execFileSync(c, ['-version'], { stdio: 'ignore' }); return c; } catch {}
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
function ffmpeg(args, ms) {
  return new Promise((ok, bad) => {
    const p = spawn(FFMPEG, args, { stdio: 'ignore' });
    const t = setTimeout(() => p.kill('SIGKILL'), ms);
    p.on('exit', code => { clearTimeout(t); code === 0 ? ok() : bad(new Error('ffmpeg exit ' + code)); });
    p.on('error', e => { clearTimeout(t); bad(e); });
  });
}
const mediaFile = (kind, url) => path.join(THUMBS, crypto.createHash('md5').update(url).digest('hex') + (kind === 'thumb' ? '.jpg' : '.gif'));
rpcHandlers.media = ({ kind, url }) => liveMedia(kind, url);
async function liveMedia(kind, url) {
  const file = mediaFile(kind, url);
  const st = await fsp.stat(file).catch(() => null);
  if (st && Date.now() - st.mtimeMs < MEDIA_TTL) return file;
  if (!FFMPEG) return st ? file : null;
  const key = file;
  if (!mediaJobs.has(key)) {
    const tmp = file.replace(/(\.\w+)$/, '.tmp$1');
    const input = ['-hide_banner', '-loglevel', 'error', '-y', '-user_agent', UA, '-rw_timeout', '8000000', '-live_start_index', '-1'];
    const args = kind === 'thumb'
      // Preview-sized on purpose: ~8 KB covers, ~130 KB gifs (240px, 6 fps, 2.5 s, 48 colours).
      ? [...input, '-skip_frame', 'nokey', '-i', url, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '9', tmp]
      : [...input, '-t', '2.5', '-i', url, '-an', '-vf', 'fps=6,scale=240:-2:flags=bilinear,split[a][b];[a]palettegen=max_colors=48:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle', '-loop', '0', tmp];
    mediaJobs.set(key, limited(() => ffmpeg(args, kind === 'thumb' ? 25000 : 40000))
      .then(() => fsp.rename(tmp, file)).then(() => file, () => { fsp.rm(tmp, { force: true }).catch(() => {}); return st ? file : null; })
      .finally(() => mediaJobs.delete(key)));
  }
  return mediaJobs.get(key);
}

// ======================= 苹果CMS =======================
const cache = new Map();
const TTL = 5 * 60 * 1000;

async function fetchText(url, ms = 15000, headers = {}) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, redirect: 'follow', signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}
// Identical upstream requests that overlap share one fetch.
const inflight = new Map();
function once(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
async function cachedText(url) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL) return hit.body;
  return once('t|' + url, async () => {
    const body = await fetchText(url);
    cache.set(url, { at: Date.now(), body });
    return body;
  });
}
async function cmsGet(site, params, fresh = false, ms = 15000) {
  const u = new URL(site.api);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') u.searchParams.set(k, v);
  const key = u.toString();
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < TTL) return hit.body;
  return once('j|' + key, async () => {
    let body;
    try { body = JSON.parse(await fetchText(key, ms)); } catch (e) { throw new Error(`${site.name}：${/JSON/.test(e.message) ? '返回的不是 JSON' : e.message}`); }
    cache.set(key, { at: Date.now(), body });
    if (cache.size > 800) cache.delete(cache.keys().next().value);
    return body;
  });
}

function item(site, d) {
  return { site: site.key, siteName: site.name, id: str(d.vod_id), name: str(d.vod_name), pic: str(d.vod_pic),
    remarks: str(d.vod_remarks), type: str(d.type_name), typeId: str(d.type_id), year: str(d.vod_year), area: str(d.vod_area),
    blurb: clean(d.vod_content).slice(0, 300) };
}
const itemOk = (site, it) => !it.type || catAllowed(site, it.type);

function lines(d) {
  const froms = str(d.vod_play_from).split('$$$');
  return str(d.vod_play_url).split('$$$').map((u, i) => ({
    name: froms[i] || `线路${i + 1}`,
    // Only direct streams: "share" pages need a 解析 service and won't play.
    episodes: u.split('#').map(p => {
      const [a, b] = p.split('$');
      const url = (b === undefined ? a : b || '').trim();
      return { name: b === undefined ? '播放' : a, url };
    }).filter(e => /^https?:\/\//.test(e.url) && /\.(m3u8|mp4)(\?|$)/i.test(e.url)),
  })).filter(l => l.episodes.length);
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

// ======================= clipboard recognition =======================
// Pasted text → 点播 sites / 直播 sources. Each link is fetched and classified by what it actually
// returns (苹果CMS JSON, TVBox config, m3u/txt list, single stream); names come from the text on the
// same line. Results are marked `exists` against the current config so the client can add only new ones.
const VOD_HINT = /provide\/vod|\/api\.php|\/inc\/api|\/at\/(json|xml)/i;
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

function classifyText(text) {
  const t = str(text).trim();
  if (!t) return null;
  if (/#EXT-X-(TARGETDURATION|STREAM-INF|MEDIA-SEQUENCE)/.test(t)) return { kind: 'stream' };
  if (/#EXTINF|#genre#/.test(t)) return { kind: 'list', channels: parseLive(t).groups.reduce((n, g) => n + g.channels.length, 0) };
  if (/^[{[]/.test(t)) {
    try {
      const o = parseJsonLoose(t);
      if (o && (o.sites || o.urls || o.lives)) return { kind: 'config', obj: o };
      if (o && (Array.isArray(o.class) || Array.isArray(o.list))) return { kind: 'vod', total: Number(o.total) || 0 };
    } catch {}
  }
  const rows = t.split(/\r?\n/).filter(l => /^[^,#\s][^,]{0,40},\s*(https?|rtmp|rtsp):\/\//.test(l.trim()));
  if (rows.length >= 2) return { kind: 'list', channels: parseLive(t).groups.reduce((n, g) => n + g.channels.length, 0) || rows.length };
  return null;
}

async function recognize(input) {
  const text = str(input).slice(0, 2e6);
  let sites = [], lives = [];
  const unknown = [];
  const direct = classifyText(text);
  if (direct?.kind === 'config') {
    const f = await configFrom(direct.obj, null);
    sites = f.sites.map(s => ({ ...s, info: '来自粘贴的配置' }));
    lives = f.lives.map(l => ({ ...l, info: '来自粘贴的配置' }));
  } else if (direct?.kind === 'list') {
    lives.push({ name: `剪贴板频道 ${direct.channels}台`, text: text.trim() + '\n', ok: true, info: `${direct.channels} 个频道` });
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
    const results = await Promise.all(entries.map(async e => {
      const host = hostOf(e.url);
      let p = null, c = null;
      if (/^https?:/i.test(e.url)) {
        try { p = await peek(e.url); c = p.stream ? { kind: 'stream' } : classifyText(p.text); } catch (err) { p = { error: err.message }; }
      } else c = { kind: 'stream' };
      const why = p?.error ? '不通：' + p.error : '';
      if (c?.kind === 'vod') return { sites: [{ name: e.name || host, api: normApi(e.url), ok: true, info: `${c.total}部` }] };
      if (c?.kind === 'config') {
        const f = await configFrom(c.obj, p.final || e.url);
        const info = `来自配置 ${e.name || host}`;
        return { sites: f.sites.map(s => ({ ...s, info })), lives: f.lives.map(l => ({ ...l, info })) };
      }
      if (c?.kind === 'list') return { lives: [{ name: e.name || host, url: e.url, ok: true, info: `${c.channels} 个频道` }] };
      if (c?.kind === 'stream') return { single: { ...e, ok: true } };
      if (VOD_HINT.test(e.url)) return { sites: [{ name: e.name || host, api: normApi(e.url), ok: false, info: why || '返回的不是苹果CMS JSON' }] };
      if (STREAMISH.test(e.url) && !/\.txt|\.m3u(\?|$)/i.test(e.url)) return { single: { ...e, ok: false, info: why } };
      if (LIVE_HINT.test(e.url)) return { lives: [{ name: e.name || host, url: e.url, ok: false, info: why || '没解析出频道' }] };
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
  const seenS = new Set(), seenL = new Set();
  sites = sites.filter(s => { const k = normApi(s.api) + '|' + (s.categories || []).join(','); return !seenS.has(k) && seenS.add(k); })
    .map(s => ({ ...s, api: normApi(s.api), exists: !s.categories && haveApi.has(normApi(s.api)) }));
  lives = lives.filter(l => { const k = l.text ? textKey(l.text) : normUrl(l.url); return !seenL.has(k) && seenL.add(k); })
    .map(l => ({ ...l, exists: l.text ? haveText.has(textKey(l.text)) : haveUrl.has(normUrl(l.url)) }));
  return { sites, lives, unknown };
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
    const k = it.name.replace(/\s+/g, '') + '|' + it.year;
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
  if (!/(^|\.)doubanio\.com$/.test(u.hostname)) return send(res, 403, 'host not allowed', 'text/plain');
  const file = path.join(IMGS, crypto.createHash('md5').update(u.toString()).digest('hex'));
  const st = await fsp.stat(file).catch(() => null);
  const head = { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=604800, immutable' };
  if (st && Date.now() - st.mtimeMs < 7 * 86400e3) { res.writeHead(200, { ...head, 'Content-Length': st.size }); return fs.createReadStream(file).pipe(res); }
  const buf = await once('img|' + file, async () => {
    const r = await fetch(u, { headers: { 'User-Agent': DB_UA_IMG, Referer: 'https://movie.douban.com/' }, signal: AbortSignal.timeout(15000) });
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
function dbJson(url, ttl) {
  const hit = dbMem.get(url);
  if (hit && Date.now() - hit.at < ttl) return Promise.resolve(hit.body);
  const run = dbChain.then(async () => {
    const r = await fetch(url, { headers: { 'User-Agent': DB_UA, Referer: 'https://movie.douban.com/' }, signal: AbortSignal.timeout(10000) });
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

async function doubanRating(name, year) {
  name = name.trim();
  if (!name) return { found: false };
  const key = name + '|' + year;
  const c = dbRatings[key];
  if (c && Date.now() - c.at < (c.rate ? 7 : 1) * 86400e3) return c.id ? { found: true, ...c } : { found: false };
  try {
    const list = await dbJson('https://movie.douban.com/j/subject_suggest?q=' + encodeURIComponent(name), 86400e3);
    const exact = list.filter(x => x.title === name || normTitle(x.title) === normTitle(name));
    const pick = exact.find(x => year && x.year === String(year)) || exact[0];
    let out = { id: '', rate: '', at: Date.now() };
    if (pick) {
      const abs = await dbJson('https://movie.douban.com/j/subject_abstract?subject_id=' + pick.id, 86400e3);
      out = { id: pick.id, rate: abs?.subject?.rate || '', year: pick.year, at: Date.now() };
    }
    dbRatings[key] = out; dbDirty = true;
    return out.id ? { found: true, ...out } : { found: false };
  } catch (e) { return { found: false, error: e.message }; }
}
async function doubanHot(type) {
  const url = `https://movie.douban.com/j/search_subjects?type=${type}&tag=${encodeURIComponent('热门')}&page_limit=30&page_start=0`;
  try {
    const j = await dbJson(url, 3600e3);
    return { list: (j.subjects || []).map(x => ({ id: x.id, name: x.title, pic: x.cover, rate: x.rate, remarks: x.episodes_info || '' })) };
  } catch (e) { return { list: [], error: e.message }; }
}

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
  const fp = path.join(dir, file);
  const st = await fsp.stat(fp).catch(() => null);
  if (!st) return send(res, 404, 'not found', 'text/plain');
  const type = MIME[path.extname(fp)] || 'application/octet-stream';
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (range) {
    const start = range[1] ? Number(range[1]) : 0, end = range[2] ? Number(range[2]) : st.size - 1;
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' });
    return fs.createReadStream(fp, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes' });
  fs.createReadStream(fp).pipe(res);
}

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
function readBody(req) {
  return new Promise((ok, fail) => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 2e6) req.destroy(); });
    req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch { fail(new Error('bad json')); } });
    req.on('error', fail);
  });
}
const needPin = res => send(res, 403, { error: '需要家长 PIN', pin: true });

async function api(route, q, res, req) {
  const SITES = visibleSites();
  const write = req.method !== 'GET';

  const leader = async (op, args) => { const r = await rpc(op, args); return send(res, r.code || 200, r.body); };

  // ---- safety / config: written by the leader, then every worker reloads ----
  if (route === 'safety') {
    if (!write) return send(res, 200, { level: safety.level, hasPin: !!safety.pin });
    return leader('safety', await readBody(req));
  }
  if (route.startsWith('config')) {
    if (!write) return send(res, 200, config);
    if (!pinOk(req)) return needPin(res);
    const op = { config: 'put', 'config/reset': 'reset', 'config/add': 'add', 'config/import': 'import' }[route];
    if (!op || (op === 'put' && req.method !== 'PUT')) return send(res, 404, { error: 'unknown api' });
    return leader('config', { op, body: await readBody(req) });
  }
  if (route === 'check') {
    const t = Date.now();
    try {
      const b = await cmsGet({ name: '', api: q.get('api') }, { ac: 'list' }, true);
      return send(res, 200, { ok: true, ms: Date.now() - t, total: Number(b.total) || 0 });
    } catch (e) { return send(res, 200, { ok: false, error: e.message }); }
  }
  if (route === 'recognize' && write) return send(res, 200, await recognize((await readBody(req)).text));
  if (route === 'info') return send(res, 200, { urls: lanIps().map(ip => `http://${ip}:${PORT}`), ffmpeg: !!FFMPEG });

  // ---- live: speed test, raw text editing, covers ----
  if (route === 'checklive') return send(res, 200, await checkLive(q.get('url') || '', q.get('name') || ''));
  if (route === 'live/raw') {
    if (req.method === 'GET') {
      try { return send(res, 200, { text: await liveText(q.get('url') || '', true) }); }
      catch (e) { return send(res, 200, { text: '', error: e.message }); }
    }
    if (!pinOk(req)) return needPin(res);
    return leader('config', { op: 'liveRaw', body: await readBody(req) });
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
    const file = await rpc('media', { kind: route === 'live/thumb' ? 'thumb' : 'preview', url: u }, 90000);
    if (!file) return send(res, 404, { error: FFMPEG ? '截不到画面' : '服务端没有 ffmpeg' });
    res.writeHead(200, { 'Content-Type': route === 'live/thumb' ? 'image/jpeg' : 'image/gif', 'Cache-Control': 'max-age=300' });
    return fs.createReadStream(file).pipe(res);
  }

  // ---- 豆瓣 ----
  if (route === 'douban/rating') return send(res, 200, await rpc('dbRating', { name: q.get('name') || '', year: q.get('year') || '' }));
  if (route === 'douban/hot') return send(res, 200, safety.level === 'kids' ? { list: [] } : await rpc('dbHot', { type: q.get('type') === 'movie' ? 'movie' : 'tv' }));
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
  if (route === 'sites') return send(res, 200, { level: safety.level, sites: SITES.map(({ key, name, kids }) => ({ key, name, kids: !!kids })), live: safety.level === 'kids' ? [] : config.lives.map((l, i) => ({ key: String(i), name: l.name })) });
  if (route === 'live') {
    if (safety.level === 'kids') return send(res, 200, { groups: [] });
    const src = config.lives[Number(q.get('src')) || 0];
    if (!src) return send(res, 200, { groups: [] });
    return send(res, 200, parseLive(await liveText(src.url), src));
  }

  // ---- 点播 ----
  if (route === 'person') {
    const name = (q.get('name') || '').trim();
    if (!name) return send(res, 400, { error: '缺少名字' });
    return send(res, 200, { list: await person(name, q.get('role'), SITES) });
  }
  if (route === 'search') {
    const wd = (q.get('wd') || '').trim();
    const out = await Promise.all(SITES.map(s => cmsGet(s, { ac: 'detail', wd }, false, 8000)
      .then(b => ({ site: s.key, list: (b.list || []).map(d => ({ d, it: item(s, d) })).filter(x => itemOk(s, x.it)) }))
      .catch(e => ({ site: s.name, error: e.message, list: [] }))));
    // Many sites' `wd` also matches vod_actor / vod_director. Any credited name containing the query counts;
    // hits are grouped per person (most works first), each list one per title + year, newest first.
    const credit = field => {
      const people = new Map();
      for (const { d, it } of out.flatMap(o => o.list)) {
        if (!wd || /解说|预告/.test(it.name + it.type)) continue;
        for (const p of new Set(splitPeople(d[field]).filter(p => p.includes(wd)))) {
          if (!people.has(p)) people.set(p, { seen: new Set(), list: [] });
          const g = people.get(p), k = it.name.replace(/\s+/g, '').replace(it.year, '') + '|' + it.year;
          if (!g.seen.has(k)) { g.seen.add(k); g.list.push(it); }
        }
      }
      return [...people].map(([name, g]) => ({ name, list: g.list.sort((a, b) => (Number(b.year) || 0) - (Number(a.year) || 0)) }))
        .sort((a, b) => (b.name === wd) - (a.name === wd) || b.list.length - a.list.length).slice(0, 6);
    };
    return send(res, 200, { results: out.flatMap(o => o.list.map(x => x.it)), actor: credit('vod_actor'), director: credit('vod_director'),
      failed: out.filter(o => o.error).map(o => o.site) });
  }

  const site = SITES.find(s => s.key === q.get('site')) || SITES[0];
  if (!site) return send(res, 404, { error: safety.level === 'kids' ? '儿童模式下没有少儿源，去「设置」添加' : '还没有点播源，去「设置」里添加' });

  if (route === 'categories') return send(res, 200, { categories: await categories(site) });
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
    return send(res, 200, { ...it, blurb: clean(d.vod_content), actor: str(d.vod_actor), director: str(d.vod_director),
      actors: splitPeople(d.vod_actor), directors: splitPeople(d.vod_director), lang: str(d.vod_lang), lines: lines(d) });
  }
  send(res, 404, { error: 'unknown api' });
}

// ======================= leader-side handlers =======================
rpcHandlers.safety = b => {
  if (safety.pin && b.pin !== safety.pin) return { code: 403, body: { error: '需要家长 PIN', pin: true } };
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
  } else if (op === 'import') {
    if (!/^https?:\/\//.test(b.url || '')) return { code: 400, body: { error: '要 http(s) 地址' } };
    const found = await importFrom(b.url);
    if (!found.sites.length && !found.lives.length) return { code: 422, body: { error: '没找到可直连的苹果CMS点播源或直播源' } };
    config = b.replace ? found : normalize({ sites: [...config.sites, ...found.sites], lives: [...config.lives, ...found.lives] });
    extra = { imported: { sites: found.sites.length, lives: found.lives.length } };
  } else if (op === 'add') {
    // From clipboard recognition: append only what isn't there; pasted lists become local files.
    const lives = [];
    const haveText = new Set();
    for (const f of await fsp.readdir(LIVES).catch(() => [])) {
      if (config.lives.some(l => l.url === 'local:' + f)) haveText.add(textKey(await fsp.readFile(path.join(LIVES, f), 'utf8').catch(() => '')));
    }
    for (const l of Array.isArray(b.lives) ? b.lives : []) {
      if (l.text && haveText.has(textKey(l.text))) continue;
      if (l.text) {
        haveText.add(textKey(l.text));
        const file = crypto.randomBytes(5).toString('hex') + '.m3u';
        await fsp.writeFile(path.join(LIVES, file), str(l.text));
        lives.push({ name: str(l.name) || '剪贴板频道', url: 'local:' + file });
      } else if (/^https?:\/\//.test(str(l.url))) lives.push({ name: str(l.name) || hostOf(l.url), url: str(l.url) });
    }
    const haveApi = new Set(config.sites.filter(s => !s.categories).map(s => normApi(s.api)));
    const sites = (Array.isArray(b.sites) ? b.sites : []).filter(s => s.categories || !haveApi.has(normApi(s.api)));
    const before = { s: config.sites.length, l: config.lives.length };
    config = normalize({ sites: [...config.sites, ...sites], lives: [...config.lives, ...lives] });
    extra = { added: { sites: config.sites.length - before.s, lives: config.lives.length - before.l } };
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
          pic: str(e.pic), line: Number(e.line) || 0, ep: Number(e.ep) || 0, epName: str(e.epName), url: e.url,
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
  return { body: { jobs: jobs.map(j => ({ ...jobView(j), qpos: queue.indexOf(j.id) + 1 })), free, dir: DL, maxJobs: MAX_JOBS } };
};

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

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (u.pathname.startsWith('/api/')) return await api(u.pathname.slice(5), u.searchParams, res, req);
    if (u.pathname === '/hls') return await relay(u.searchParams.get('u') || '', res, req);
    if (u.pathname === '/img') return await imageProxy(u.searchParams.get('u') || '', res);
    if (u.pathname.startsWith('/dl/')) return await serveDownload(u.pathname.slice(4), req, res);
    return await serveStatic(decodeURIComponent(u.pathname), req, res);
  } catch (e) {
    if (res.destroyed) return;            // the browser already gave up (page switched)
    if (!res.headersSent) send(res, 502, { error: e.message || String(e) });
    else res.destroy();
  }
});
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.listen(PORT, HOST, () => {
  if (!cluster.isWorker) banner(1, !!FFMPEG, DL);
  if (IS_LEADER) {
    pump();
    if (cluster.isWorker) process.send({ t: 'ready', ffmpeg: !!FFMPEG, dl: DL });
  }
});
