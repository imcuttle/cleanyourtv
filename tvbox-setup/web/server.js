#!/usr/bin/env node
// TVBox web: one Node process, zero npm dependencies.
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

const PORT = Number(process.env.PORT) || 9988;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const CONFIG = path.join(ROOT, '..', 'config');
const PUBLIC = path.join(ROOT, 'public');
const DATA = process.env.TVBOX_DATA || path.join(ROOT, 'data');
const DL = path.join(DATA, 'downloads');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
fs.mkdirSync(DL, { recursive: true });

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
if (!fs.existsSync(STORE)) saveConfig();

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
  while (mediaRunning < 3 && mediaQueue.length) {
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
      ? [...input, '-skip_frame', 'nokey', '-i', url, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '5', tmp]
      : [...input, '-t', '3', '-i', url, '-an', '-vf', 'fps=8,scale=320:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer', '-loop', '0', tmp];
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
async function cachedText(url) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL) return hit.body;
  const body = await fetchText(url);
  cache.set(url, { at: Date.now(), body });
  return body;
}
async function cmsGet(site, params, fresh = false) {
  const u = new URL(site.api);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') u.searchParams.set(k, v);
  const key = u.toString();
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < TTL) return hit.body;
  let body;
  try { body = JSON.parse(await fetchText(key)); } catch (e) { throw new Error(`${site.name}：${/JSON/.test(e.message) ? '返回的不是 JSON' : e.message}`); }
  cache.set(key, { at: Date.now(), body });
  if (cache.size > 800) cache.delete(cache.keys().next().value);
  return body;
}

function item(site, d) {
  return { site: site.key, siteName: site.name, id: str(d.vod_id), name: str(d.vod_name), pic: str(d.vod_pic),
    remarks: str(d.vod_remarks), type: str(d.type_name), year: str(d.vod_year), area: str(d.vod_area),
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

// Import a TVBox config (single or multi-warehouse `{urls:[…]}`) and keep what is usable.
async function importFrom(url, depth = 0) {
  const text = await fetchText(url);
  let obj;
  try { obj = JSON.parse(text.replace(/^\uFEFF/, '').replace(/^\s*\/\/.*$/gm, '')); }
  catch { throw new Error('不是 JSON（可能是加密/图片伪装的配置，浏览器端用不了）'); }
  let found = normalize({ sites: obj.sites, lives: (obj.lives || []).filter(l => /^https?:\/\//.test(str(l.url))) });
  if (Array.isArray(obj.urls) && depth === 0) {
    for (const sub of obj.urls.slice(0, 12)) {
      try {
        const f = await importFrom(new URL(sub.url, url).toString(), 1);
        found = normalize({ sites: [...found.sites, ...f.sites], lives: [...found.lives, ...f.lives] });
      } catch {}
    }
  }
  return found;
}

// ======================= 豆瓣 =======================
const DB_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const DB_FILE = path.join(DATA, 'douban.json');
const dbRatings = readJson(DB_FILE, {}); // "name|year" -> {id, rate, at}
let dbDirty = false;
setInterval(() => { if (dbDirty) { dbDirty = false; writeJson(DB_FILE, dbRatings); } }, 10000).unref();
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

// ======================= downloads =======================
// Each episode → data/downloads/<id>/{index.m3u8, 00001.ts…}. Segments are decrypted on the way in,
// so the folder plays anywhere and concatenates into a single file.
const DL_INDEX = path.join(DL, 'index.json');
const jobs = readJson(DL_INDEX, []);
for (const j of jobs) if (j.status === 'downloading') j.status = 'queued';
let saveTimer;
const saveJobs = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => writeJson(DL_INDEX, jobs), 500); };
let running = 0;
const MAX_JOBS = 2, SEG_CONCURRENCY = 6;

function pump() {
  while (running < MAX_JOBS) {
    const j = jobs.find(x => x.status === 'queued');
    if (!j) return;
    running++;
    j.status = 'downloading'; j.error = ''; saveJobs();
    runJob(j).then(() => { if (j.status === 'downloading') j.status = 'done'; },
      e => { if (j.status === 'downloading') { j.status = 'error'; j.error = e.message || String(e); } })
      .finally(() => { running--; saveJobs(); pump(); });
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

async function runJob(j) {
  const dir = path.join(DL, j.id);
  await fsp.mkdir(dir, { recursive: true });
  if (/\.mp4(\?|$)/i.test(j.url)) return downloadMp4(j, dir);
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
    while (next < segs.length && j.status === 'downloading') {
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
  if (j.status !== 'downloading') return;
  const head = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-MEDIA-SEQUENCE:0'];
  const body = out.filter(l => !l.startsWith('#EXTM3U') && !l.startsWith('#EXT-X-VERSION'));
  await fsp.writeFile(path.join(dir, 'index.m3u8'), [...head, ...body, '#EXT-X-ENDLIST', ''].join('\n'));
}

async function downloadMp4(j, dir) {
  const r = await fetch(j.url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  j.total = Number(r.headers.get('content-length')) || 0; j.done = 0; j.bytes = 0; j.ext = 'mp4';
  const ws = fs.createWriteStream(path.join(dir, 'video.mp4'));
  for await (const chunk of Readable.fromWeb(r.body)) {
    if (j.status !== 'downloading') { ws.destroy(); return; }
    ws.write(chunk); j.bytes += chunk.length; j.done = j.bytes;
  }
  await new Promise(ok => ws.end(ok));
  j.done = j.total = j.bytes;
}

const jobView = j => ({ ...j, play: j.status !== 'done' ? '' : fs.existsSync(path.join(DL, j.id, 'index.m3u8')) ? `/dl/${j.id}/index.m3u8` : `/dl/${j.id}/video.mp4` });

async function serveDownload(rest, req, res) {
  const [id, file] = rest.split('/');
  const j = jobs.find(x => x.id === id);
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
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
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

  // ---- safety ----
  if (route === 'safety') {
    if (write) {
      const b = await readBody(req);
      if (safety.pin && b.pin !== safety.pin) return needPin(res);
      if (['kids', 'standard', 'all'].includes(b.level)) safety.level = b.level;
      if (typeof b.newPin === 'string') safety.pin = b.newPin.trim();
      writeJson(SAFETY, safety); cache.clear();
    }
    return send(res, 200, { level: safety.level, hasPin: !!safety.pin });
  }

  // ---- config ----
  if (route.startsWith('config')) {
    if (write && !pinOk(req)) return needPin(res);
    if (route === 'config' && req.method === 'PUT') { config = normalize(await readBody(req)); saveConfig(); cache.clear(); }
    if (route === 'config/reset' && write) { config = defaults(); saveConfig(); cache.clear(); }
    if (route === 'config/import' && write) {
      const { url, replace } = await readBody(req);
      if (!/^https?:\/\//.test(url || '')) return send(res, 400, { error: '要 http(s) 地址' });
      const found = await importFrom(url);
      if (!found.sites.length && !found.lives.length) return send(res, 422, { error: '没找到可直连的苹果CMS点播源或直播源' });
      config = replace ? found : normalize({ sites: [...config.sites, ...found.sites], lives: [...config.lives, ...found.lives] });
      saveConfig(); cache.clear();
      return send(res, 200, { ...config, imported: { sites: found.sites.length, lives: found.lives.length } });
    }
    return send(res, 200, config);
  }
  if (route === 'check') {
    const t = Date.now();
    try {
      const b = await cmsGet({ name: '', api: q.get('api') }, { ac: 'list' }, true);
      return send(res, 200, { ok: true, ms: Date.now() - t, total: Number(b.total) || 0 });
    } catch (e) { return send(res, 200, { ok: false, error: e.message }); }
  }
  if (route === 'info') return send(res, 200, { urls: lanIps().map(ip => `http://${ip}:${PORT}`), ffmpeg: !!FFMPEG });

  // ---- live: speed test, raw text editing, covers ----
  if (route === 'checklive') return send(res, 200, await checkLive(q.get('url') || '', q.get('name') || ''));
  if (route === 'live/raw') {
    if (req.method === 'GET') {
      try { return send(res, 200, { text: await liveText(q.get('url') || '', true) }); }
      catch (e) { return send(res, 200, { text: '', error: e.message }); }
    }
    if (!pinOk(req)) return needPin(res);
    const { url, text } = await readBody(req);
    const file = str(url).startsWith('local:') ? path.basename(str(url).slice(6)) : crypto.randomBytes(5).toString('hex') + '.m3u';
    await fsp.writeFile(path.join(LIVES, file), str(text));
    cache.clear();
    return send(res, 200, { url: 'local:' + file });
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
    const file = await liveMedia(route === 'live/thumb' ? 'thumb' : 'preview', u);
    if (!file) return send(res, 404, { error: FFMPEG ? '截不到画面' : '服务端没有 ffmpeg' });
    res.writeHead(200, { 'Content-Type': route === 'live/thumb' ? 'image/jpeg' : 'image/gif', 'Cache-Control': 'max-age=300' });
    return fs.createReadStream(file).pipe(res);
  }

  // ---- 豆瓣 ----
  if (route === 'douban/rating') return send(res, 200, await doubanRating(q.get('name') || '', q.get('year') || ''));
  if (route === 'douban/hot') return send(res, 200, safety.level === 'kids' ? { list: [] } : await doubanHot(q.get('type') === 'movie' ? 'movie' : 'tv'));

  // ---- downloads ----
  if (route === 'downloads') {
    if (req.method === 'POST') {
      const b = await readBody(req);
      const added = [];
      for (const e of Array.isArray(b.items) ? b.items : [b]) {
        if (!/^https?:\/\//.test(str(e.url))) continue;
        const key = `${e.site}|${e.id}|${e.url}`;
        let j = jobs.find(x => x.key === key);
        if (j) { if (j.status === 'error' || j.status === 'paused') j.status = 'queued'; }
        else {
          j = { id: crypto.randomBytes(6).toString('hex'), key, site: str(e.site), siteName: str(e.siteName), vid: str(e.id), name: str(e.name),
            pic: str(e.pic), line: Number(e.line) || 0, ep: Number(e.ep) || 0, epName: str(e.epName), url: e.url,
            status: 'queued', done: 0, total: 0, bytes: 0, at: Date.now() };
          jobs.unshift(j);
        }
        added.push(j.id);
      }
      saveJobs(); pump();
      return send(res, 200, { added });
    }
    if (req.method === 'DELETE') {
      const i = jobs.findIndex(x => x.id === q.get('id'));
      if (i >= 0) { jobs[i].status = 'deleted'; await fsp.rm(path.join(DL, jobs[i].id), { recursive: true, force: true }); jobs.splice(i, 1); saveJobs(); }
      return send(res, 200, { ok: true });
    }
    if (req.method === 'PATCH') {
      const j = jobs.find(x => x.id === q.get('id'));
      if (j && q.get('action') === 'pause' && ['queued', 'downloading'].includes(j.status)) j.status = 'paused';
      if (j && q.get('action') === 'resume' && ['paused', 'error'].includes(j.status)) j.status = 'queued';
      saveJobs(); pump();
      return send(res, 200, { ok: true });
    }
    let free = null;
    try { const s = await fsp.statfs(DL); free = s.bavail * s.bsize; } catch {}
    return send(res, 200, { jobs: jobs.map(jobView), free, dir: DL });
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
  if (route === 'search') {
    const wd = q.get('wd') || '';
    const out = await Promise.all(SITES.map(s => cmsGet(s, { ac: 'detail', wd })
      .then(b => ({ site: s.key, list: (b.list || []).map(d => item(s, d)).filter(it => itemOk(s, it)) }))
      .catch(e => ({ site: s.name, error: e.message, list: [] }))));
    return send(res, 200, { results: out.flatMap(o => o.list), failed: out.filter(o => o.error).map(o => o.site) });
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
    return send(res, 200, { ...it, blurb: clean(d.vod_content), actor: str(d.vod_actor), director: str(d.vod_director), lines: lines(d) });
  }
  send(res, 404, { error: 'unknown api' });
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
  const r = await fetch(u, { headers, redirect: 'follow', signal: AbortSignal.timeout(20000) });
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

function serveStatic(p, req, res) {
  const file = path.normalize(path.join(PUBLIC, p === '/' ? 'index.html' : p));
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'forbidden', 'text/plain');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'not found', 'text/plain');
    // no-cache: the browser revalidates, so an updated app.js/style.css shows up on the next load.
    const etag = '"' + crypto.createHash('md5').update(buf).digest('hex').slice(0, 16) + '"';
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag }); return res.end(); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ETag: etag });
    res.end(buf);
  });
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (u.pathname.startsWith('/api/')) return await api(u.pathname.slice(5), u.searchParams, res, req);
    if (u.pathname === '/hls') return await relay(u.searchParams.get('u') || '', res, req);
    if (u.pathname.startsWith('/dl/')) return await serveDownload(u.pathname.slice(4), req, res);
    serveStatic(decodeURIComponent(u.pathname), req, res);
  } catch (e) {
    if (!res.headersSent) send(res, 502, { error: e.message || String(e) });
    else res.destroy();
  }
}).listen(PORT, HOST, () => {
  console.log('\n  TVBox 已启动，浏览器打开：\n');
  console.log(`    本机      http://localhost:${PORT}`);
  for (const ip of lanIps()) console.log(`    局域网    http://${ip}:${PORT}`);
  console.log(`\n  下载目录：${DL}`);
  console.log(`  直播封面：${FFMPEG ? 'ffmpeg 已找到' : '没有 ffmpeg，悬停时用浏览器截图'}`);
  console.log('  关闭这个窗口即停止服务。\n');
  pump();
});
