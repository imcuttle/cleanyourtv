'use strict';
// 预览模式: ?pv=vod&pvapi=… / ?pv=live&pvu=… opens this same page for ONE source that is not in the config (see previewOf in server.js).
// The query string is the whole state (kept while the hash navigates), and the params ride along on every API call.
// The tab keeps its own 当前源 / 历史 / 收藏 / 测速缓存 so previewing never touches the real ones.
const PV = (() => {
  const p = new URLSearchParams(location.search), kind = p.get('pv');
  if (kind !== 'vod' && kind !== 'live') return null;
  const q = {}; for (const k of ['pv', 'pvapi', 'pvname', 'pvcats', 'pvu', 'pvstash']) if (p.get(k)) q[k] = p.get(k);
  return { kind, q, name: p.get('pvname') || '预览', api: p.get('pvapi') || '', url: p.get('pvu') || '', stash: p.get('pvstash') || '', cats: p.get('pvcats') || '' };
})();
if (PV) {
  document.documentElement.classList.add('pv', 'pv-' + PV.kind);
  document.title = '预览 · ' + PV.name;
  try {
    const real = window.localStorage, OWN = new Set(['site', 'live', 'history', 'favs', 'siteHealth']), mem = { site: 'preview', live: 'preview' };
    Object.defineProperty(window, 'localStorage', { configurable: true, value: new Proxy(real, {
      get: (t, k) => OWN.has(k) ? mem[k] : typeof t[k] === 'function' ? t[k].bind(t) : t[k],
      set: (t, k, v) => { if (OWN.has(k)) mem[k] = String(v); else t[k] = v; return true; },
      deleteProperty: (t, k) => { if (OWN.has(k)) delete mem[k]; else delete t[k]; return true; },
    }) });
  } catch {}
}
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const view = $('#view');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// 豆瓣/javdb image CDNs refuse requests without their Referer → go through the server's /img relay.
const img = u => /^https?:\/\/[^/]*(doubanio|jdbstatic|javdb)\.com\//.test(u || '') ? '/img?u=' + encodeURIComponent(u) : (u || '');
const cssUrl = u => `url('${esc(img(u)).replace(/'/g, '%27')}')`;
const bg = url => url ? `background-image:${cssUrl(url)}` : '';
// 豆瓣 serves every poster at s (270px) / m (540px) / l (1080px) wide, whatever size its API handed us.
const DB_POSTER = /^(https?:\/\/[^/]*doubanio\.com\/view\/photo\/)(?:[sml]_ratio_poster|[sml])\//;
const dbSize = (u, s) => DB_POSTER.test(u || '') ? u.replace(DB_POSTER, `$1${s}_ratio_poster/`) : '';
// Big posters: the sharp layer paints over the small one (already cached from the card) once it arrives.
const bgHi = (url, s = 'l') => !url ? '' : dbSize(url, s) ? `background-image:${cssUrl(dbSize(url, s))},${cssUrl(dbSize(url, 's'))}` : bg(url);
// Big poster from a source is often a thumbnail. Once 豆瓣 has the title, its poster goes on top of it as
// layers — sharp (l/m) over small (s) over the source's own — so the sharpest one that has loaded shows,
// and nothing goes blank while the bigger one is on its way.
const bgLayers = (pic, dbpic, size = 'l') => {
  const hi = dbpic && dbSize(dbpic, size), lo = dbpic && dbSize(dbpic, 's');
  const layers = [hi, lo, pic].filter(Boolean).map(cssUrl);
  return layers.length ? `background-image:${layers.join(',')}` : '';
};
// Card <img>: small first; once it is on screen, fade the sharp size in over it.
const posterImg = (u, sharp = 'm') => {
  if (sharp && sharpWanted()) sharp = 'l';
  const hi = sharp && dbSize(u, sharp);
  return `<img src="${esc(img(dbSize(u, 's') || u))}" data-src0="${esc(u)}"${hi ? ` data-hi="${esc(img(hi))}"` : ''} loading="lazy" decoding="async" referrerpolicy="no-referrer" alt="" onload="sharpen(this)" onerror="this.parentNode.classList.add('noimg');this.remove()">`;
};
function sharpen(el) {
  el.classList.add('ok');
  const hi = el.dataset.hi; if (!hi) return;
  delete el.dataset.hi;
  const h = document.createElement('img');
  h.decoding = 'async'; h.referrerPolicy = 'no-referrer'; h.alt = '';
  h.onload = () => h.classList.add('ok');
  h.onerror = () => h.remove();
  h.src = hi;
  el.after(h);
}
const ROWS = ['国产剧', '韩剧|韩国剧', '欧美剧', '动作片', '喜剧片', '科幻片', '日剧|日本剧', '国产动漫', '日韩动漫', '大陆综艺', '爱情片', '纪录片|记录片'];
const LEVELS = { kids: '儿童', standard: '标准', all: '全部' };
// 清晰度 chip: 4K / 1080P 蓝光 / 720P HD / 标清 / 抢先 (cam).
const Q_CLASS = { '4K': 'q4k', '1080P': 'q1080', '蓝光': 'q1080', '超清': 'q720', '720P': 'q720', 'HD': 'q720', '标清': 'qsd', '抢先': 'qcam' };
const qChip = (q, cls = '') => q ? `<span class="q ${Q_CLASS[q] || ''} ${cls}">${esc(q)}</span>` : '';
// What /api/probe learned (real resolution of a title / a stream) is kept in localStorage for 3 days, so
// cards show it right away on later visits and a title is never probed twice. Capped, oldest dropped first.
const qc = (() => {
  const KEY = 'qinfo', MAX = 600, TTL = 3 * 86400e3;
  let m; try { m = JSON.parse(localStorage[KEY] || '{}'); } catch { m = {}; }
  let timer = 0;
  const save = () => { clearTimeout(timer); timer = setTimeout(() => { try { localStorage[KEY] = JSON.stringify(m); } catch { m = {}; } }, 1500); };
  return {
    get(k) { const e = m[k]; if (!e) return ''; if (Date.now() - e.at > TTL) { delete m[k]; return ''; } return e.q; },
    set(k, q) {
      if (!q) return;
      delete m[k]; m[k] = { q, at: Date.now() }; // re-insert → newest last
      const ks = Object.keys(m); if (ks.length > MAX) for (const x of ks.slice(0, ks.length - MAX)) delete m[x];
      save();
    },
  };
})();
const Q_RANK = { '抢先': 0, '标清': 1, '720P': 2, 'HD': 2, '超清': 3, '1080P': 4, '蓝光': 4, '4K': 5 };
const bestQ = qs => qs.filter(Boolean).sort((a, b) => (Q_RANK[b] ?? -1) - (Q_RANK[a] ?? -1))[0] || '';
const vodQ = it => (it.site && it.id && qc.get(`v|${it.site}|${it.id}`)) || it.quality || '';
// 本地媒体 on this very machine (localhost): hand a file to the system's default player / show it in Finder
// or Explorer. The server refuses anyone who isn't the loopback browser, so other devices never see the buttons.
const localFileId = url => (/\/media\/[fh]\/([0-9a-f]+)/.exec(url || '') || [])[1] || '';
const openLocal = (url, action) => {
  const id = localFileId(url);
  if (!id) return Promise.resolve(toast('不是本地文件'));
  return req('POST', '/api/local/open', { id, action }).then(() => toast(action === 'reveal' ? '已在文件夹中显示' : '已交给系统播放器'), e => toast(e.message));
};
const DB_ROWS = [['tv', '豆瓣热门剧集'], ['movie', '豆瓣热门电影'], ['show', '豆瓣热门综艺'], ['anime', '豆瓣热门动漫']];
const dbRows = () => { try { return { tv: true, movie: true, show: true, anime: true, ...JSON.parse(localStorage.dbRows || '{}') }; } catch { return { tv: true, movie: true, show: true, anime: true }; } };

const state = { sites: [], lives: [], level: 'standard', site: localStorage.site || '', cats: [], downloads: [] };
// 封面卡片: 竖版 (poster, 2:3) or 宽版 (wide, 16:9). One class on <html> restyles every card, the home banner and the detail sheet.
const cardMode = () => localStorage.cardMode === 'wide' ? 'wide' : 'poster';
const applyCardMode = () => {
  document.documentElement.classList.toggle('wide-cards', cardMode() === 'wide');
  const b = $('#cardBtn'); if (b) { b.classList.toggle('on', cardMode() === 'wide'); b.title = cardMode() === 'wide' ? '当前：横版，点一下换竖版' : '当前：竖版，点一下换横版'; }
};
// 卡片大小: ⌘/Ctrl + / − / 0 (and the − + buttons in the cover menu) scale every card, the grid columns follow. Remembered.
// The page itself is never zoomed. Past 1.35× the covers switch to the sharp size, so a big card does not look blurry.
const CS_MIN = 0.6, CS_MAX = 2.2, CS_STEP = 0.1;
const cardScale = () => { const v = parseFloat(localStorage.cardScale); return Number.isFinite(v) ? Math.min(CS_MAX, Math.max(CS_MIN, v)) : 1; };
const sharpWanted = () => cardScale() >= 1.35;
const applyCardScale = () => {
  const v = cardScale();
  document.documentElement.style.setProperty('--cs', String(v));
  document.documentElement.classList.toggle('cs-big', sharpWanted());
  $$('[data-cs=val]').forEach(e => { e.textContent = Math.round(v * 100) + '%'; });
};
let csHiT = 0;
const setCardScale = (v, quiet) => {
  v = Math.round(Math.min(CS_MAX, Math.max(CS_MIN, v)) * 100) / 100;
  const wasBig = sharpWanted();
  localStorage.cardScale = String(v); applyCardScale();
  if (sharpWanted() !== wasBig) { clearTimeout(csHiT); csHiT = setTimeout(upgradeCovers, 120); }
  else if (sharpWanted()) { clearTimeout(csHiT); csHiT = setTimeout(upgradeCovers, 300); }
  if (!quiet) toast('封面大小 ' + Math.round(v * 100) + '%');
};
// Already-painted covers get the sharp version (only 豆瓣 posters have bigger sizes; others are shown as they are).
function upgradeCovers() {
  if (!sharpWanted()) return;
  $$('#view .card .img img.ok').forEach(el => {
    if (el.dataset.big || !el.dataset.src0) return;
    const hi = dbSize(el.dataset.src0, 'l'); if (!hi) return;
    el.dataset.big = '1';
    const h = new Image(); h.referrerPolicy = 'no-referrer';
    h.onload = () => { el.src = h.src; }; h.src = img(hi);
  });
}
addEventListener('keydown', e => {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
  const k = e.key;
  const plus = k === '+' || k === '=' || k === 'Add', minus = k === '-' || k === '_' || k === 'Subtract', zero = k === '0';
  if (!plus && !minus && !zero) return;
  if (e.target instanceof Element && e.target.closest('input, textarea, [contenteditable]') && zero) return;
  if (!$('#view') || (typeof playerOpen === 'function' && playerOpen())) return;     // only on pages with cards
  e.preventDefault();
  setCardScale(zero ? 1 : cardScale() + (plus ? CS_STEP : -CS_STEP));
}, true);
// pinch / Ctrl+wheel on a trackpad would zoom the page: use it for the cards instead (the browser reports pinch as ctrl+wheel)
addEventListener('wheel', e => {
  if (!e.ctrlKey || !$('#view') || (typeof playerOpen === 'function' && playerOpen())) return;
  e.preventDefault();
  if (!csWheel.t) { csWheel.t = setTimeout(() => { csWheel.t = 0; csWheel.acc = 0; }, 120); }
  csWheel.acc += -e.deltaY;
  if (Math.abs(csWheel.acc) >= 30) { setCardScale(cardScale() + Math.sign(csWheel.acc) * CS_STEP, true); csWheel.acc = 0; }
}, { passive: false });
const csWheel = { t: 0, acc: 0 };
const setCardMode = m => { localStorage.cardMode = m; applyCardMode(); $$('[data-cardmode]').forEach(x => x.classList.toggle('on', x.dataset.cardmode === m)); };
applyCardMode();

// ---------- http ----------
// Every read belongs to the current page: switching pages aborts what the old one still had in flight, so
// slow sources / 豆瓣 / covers don't hold the browser's ~6 connections per host and stall the next page.
let pageCtl = new AbortController();
let admEs = null;   // 设置页「管理员」的 SSE 连接: 离开设置页 / 关页面就由客户端断开 (回来时 initAdmin 会按进行中的任务重新接上)
const closeAdminEs = () => { if (admEs) { admEs.close(); admEs = null; } };
addEventListener('pagehide', closeAdminEs);
const isAbort = e => e?.name === 'AbortError';
// 预览: open this same page in a new tab with ?pv=… (see PV). Pasted lists (no URL) are parked on the server first.
function previewSource(kind, { url = '', name = '', cats = '', text = '' } = {}) {
  if (state.level !== 'all') return toast('预览只能在安全级别「全部」下使用');
  const page = qs => '/?' + new URLSearchParams({ pv: kind, pvname: name, ...qs }) + (kind === 'live' ? '#/live' : '#/');
  if (text) {
    const w = window.open('', '_blank');
    return req('POST', '/api/preview/stash', { text }).then(j => { if (w) w.location = page({ pvstash: j.id }); }, e => { if (w) w.close(); toast(e.message); });
  }
  url = String(url).trim();
  if (!(kind === 'vod' ? /^https?:\/\/|^local:[\w.-]+\.txt$/ : /^https?:\/\/|^local:[\w.-]+$/).test(url)) return toast('这个地址没法预览');
  window.open(page(kind === 'vod' ? { pvapi: url, ...(cats ? { pvcats: cats } : {}) } : { pvu: url }), '_blank');
}
async function req(method, path, body, retried, signal) {
  const headers = { 'Content-Type': 'application/json' };
  if (sessionStorage.pin) headers['X-Pin'] = sessionStorage.pin;
  const r = await fetch(path, { method, headers, signal, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (r.status === 403 && j.pin && !retried) {
    const pin = prompt('需要家长 PIN');
    if (pin === null) throw new Error('已取消');
    sessionStorage.pin = pin;
    if (body && typeof body === 'object' && 'pin' in body) body.pin = pin;
    return req(method, path, body, true, signal);
  }
  if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
// signal: omitted → current page; null → never aborted (app-level reads); or a specific controller's signal.
const get = (path, signal) => req('GET', path, undefined, false, signal === undefined ? pageCtl.signal : signal || undefined);
// Reads that a page is built from are remembered for a few minutes (and per safety level), so going Back to a page that
// was just left rebuilds it from memory in the same frame — no spinner, no network round trip, no flash.
// Only successful results are kept; the sources list changing / a rescan / settings saves clear it.
const altCache = new Map();   // 同名源 (详情页的「其他源」/ 播放页的「切换源」) 按片名缓存
const apiMemo = new Map(), MEMO_TTL = { list: 300e3, categories: 600e3, 'douban/hot': 1800e3 }, MEMO_MAX = 160;
let memoSig = '';

// ---------- DataLoader: coalesce single reads into batches ----------
// Modelled on the `dataloader` npm package: every load(key) made within one short window is collected and sent as ONE
// request (max `maxBatch` keys); the same key asked twice while in flight shares one promise. Differences from the
// original, for a UI: results are settled one by one as the server streams them (a slow key never holds back fast
// ones), and the cache only covers in-flight keys (`keep` ms after settling; 0 = none) — freshness stays with the
// callers' own caches (localStorage, apiMemo). batchFn(keys, settle): call settle(i, valueOrError) per key, or return
// an array of results.
class DataLoader {
  // wait: how long a normal key may sit in the queue. lazyWait / lazyMax: keys loaded with {lazy:true} (ratings, javdb,
  // probes — things nobody is waiting on) are *debounced*: the batch leaves lazyWait ms after the last such key, but at
  // most lazyMax ms after the first. Scrolling feeds IntersectionObserver a few cards every frame; a 6 ms window caught
  // one frame at a time and sent near-single requests, a debounce lets the whole scroll burst ride one request.
  // Any normal key in the queue pulls the departure forward to `wait`, and takes the lazy ones along.
  constructor(batchFn, { maxBatch = 24, wait = 6, lazyWait = 80, lazyMax = 400, keep = 0 } = {}) {
    Object.assign(this, { fn: batchFn, maxBatch, wait, lazyWait, lazyMax, keep });
    this.cache = new Map(); this.queue = []; this.timer = 0; this.due = 0; this.first = 0; this.urgent = false;
    this.refs = new Map();      // key -> 还有几个调用方在等它 (带 signal 的调用方离开时会 release)
    this.lazyKeys = new Set();  // 只有「后台补充」调用方要的 key
    this.running = new Set();   // 正在飞的批: { ctl, keys }
  }
  // 调用方不要这个 key 了 (切页面 / 关弹层): 还在排队就撤掉; 已经发出去的批, 里面所有 key 都没人要了就整批中断。
  release(key) {
    const n = (this.refs.get(key) || 0) - 1;
    if (n > 0) { this.refs.set(key, n); return; }
    if (!this.refs.has(key)) return;
    this.refs.delete(key);
    this.dropKey(key);
  }
  dropKey(key) {
    const qi = this.queue.findIndex(q => q.key === key);
    if (qi >= 0) { const [q] = this.queue.splice(qi, 1); q.rej(new DOMException('aborted', 'AbortError')); return; }
    for (const b of this.running) if (b.keys.includes(key) && b.keys.every(k => !(this.refs.get(k) > 0))) b.ctl.abort();
  }
  // 切页面: 后台补充类的请求 (javdb 评分 / 豆瓣评分 / 探测) 没人在等了 — 排队的撤掉, 只含这类的批中断。
  abortLazy() {
    for (const q of [...this.queue]) if (this.lazyKeys.has(q.key)) { this.refs.delete(q.key); this.dropKey(q.key); }
    for (const b of this.running) if (b.keys.every(k => this.lazyKeys.has(k) || !this.cache.has(k))) b.ctl.abort();
  }
  load(key, { lazy = false } = {}) {
    this.refs.set(key, (this.refs.get(key) || 0) + 1);
    if (!lazy) this.lazyKeys.delete(key);
    const hit = this.cache.get(key);
    if (hit) { if (!lazy) this.hurry(); return hit; }
    if (lazy) this.lazyKeys.add(key); // an urgent caller joining a lazy in-flight key speeds it up
    const p = new Promise((res, rej) => this.queue.push({ key, res, rej }));
    this.cache.set(key, p);
    p.then(() => this.drop(key, p), () => this.drop(key, p));
    const now = Date.now();
    if (this.queue.length === 1) { this.first = now; this.urgent = false; }
    if (this.queue.length >= this.maxBatch) this.flush();
    else if (lazy && !this.urgent) this.schedule(Math.min(now + this.lazyWait, this.first + this.lazyMax));
    else { this.urgent = true; this.schedule(now + this.wait); }
    return p;
  }
  hurry() { if (this.queue.length) { this.urgent = true; this.schedule(Date.now() + this.wait); } }
  schedule(at) {
    clearTimeout(this.timer);
    this.due = at;
    this.timer = setTimeout(() => this.flush(), Math.max(0, at - Date.now()));
  }
  loadMany(keys, opt) { return Promise.all(keys.map(k => this.load(k, opt).catch(e => e))); }
  drop(key, p) { if (this.cache.get(key) === p) { this.refs.delete(key); this.lazyKeys.delete(key); } const del = () => this.cache.get(key) === p && this.cache.delete(key); this.keep ? setTimeout(del, this.keep) : del(); }
  clear(key) { this.cache.delete(key); return this; }
  clearAll() { this.cache.clear(); return this; }
  prime(key, value) { if (!this.cache.has(key)) this.cache.set(key, Promise.resolve(value)); return this; }
  flush() {
    clearTimeout(this.timer); this.timer = 0; this.urgent = false;
    while (this.queue.length) this.run(this.queue.splice(0, this.maxBatch));
  }
  async run(batch) {
    const done = new Set();
    const live = { ctl: new AbortController(), keys: batch.map(b => b.key) };
    this.running.add(live);
    const settle = (i, v) => {
      if (done.has(i) || !batch[i]) return;
      done.add(i);
      v instanceof Error ? batch[i].rej(v) : batch[i].res(v);
    };
    try {
      const out = await this.fn(batch.map(b => b.key), settle, live.ctl.signal);
      if (Array.isArray(out)) out.forEach((v, i) => settle(i, v));
    } catch (e) { batch.forEach((_, i) => settle(i, e instanceof Error ? e : new Error(String(e)))); }
    finally { this.running.delete(live); }
    batch.forEach((_, i) => settle(i, new Error('没有返回结果')));
  }
}
// The server runs these as GETs inside POST /api/batch and streams back one NDJSON line per request, as it finishes.
const BATCHABLE = /^(list|categories|detail|search|person|sites|info|live|probe|javdb|douban\/(rating|hot|chart|charts))$/;
// ---- SWR 的 revalidate：Service Worker 发现批量接口里某条数据变了（{fresh:1}），先改记忆缓存，再通知当前页面里订阅的地方局部刷新 ----
const swrSubs = [];
const swrWatch = fn => { swrSubs.push({ sig: pageCtl.signal, fn }); };   // 订阅跟着当前页面：换页就自动失效
function swrUpdate(key, body) {
  const q = key.indexOf('?'), route = key.slice(0, q), qs = key.slice(q + 1);
  const norm = s => { const p = new URLSearchParams(s); p.sort(); return String(p); };
  for (const [k, hit] of apiMemo) if (k.startsWith(state.level + '|' + route + '?') && norm(k.slice(k.indexOf('?') + 1)) === qs) { hit.v = body; hit.at = Date.now(); }
  const params = Object.fromEntries(new URLSearchParams(qs));
  for (let i = swrSubs.length; i--;) {
    const s = swrSubs[i];
    if (s.sig.aborted) swrSubs.splice(i, 1); else try { s.fn(route, params, body); } catch {}
  }
}
// 信号来了：用 cache-first 请求（SW 只读缓存，不碰网络）取回刚写入的数据，当场更新依赖它的视图
async function swrFresh(key) {
  try {
    const r = await fetch('/__swr/' + encodeURIComponent(state.level) + '/' + key, { cache: 'force-cache' });
    if (r.ok) swrUpdate(key, await r.json());
  } catch {}
}
async function fetchBatch(keys, settle, signal) {
  const requests = keys.map(k => { const q = k.indexOf('?'); return { route: k.slice(0, q), q: Object.fromEntries(new URLSearchParams(k.slice(q + 1))) }; });
  const headers = { 'Content-Type': 'application/json' };
  if (sessionStorage.pin) headers['X-Pin'] = sessionStorage.pin;
  const r = await fetch('/api/batch', { method: 'POST', headers, signal, body: JSON.stringify({ requests, lvl: state.level }) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const line = t => {
    if (!t) return;
    let m; try { m = JSON.parse(t); } catch { return; }
    if (m.fresh) return m.body ? swrUpdate(keys[m.i], m.body) : swrFresh(keys[m.i]);             // Service Worker 先给了旧内容，后台发现服务端有新内容并已写入缓存：cache-first 取出来，只更新对应的那一块
    settle(m.i, m.status >= 400 || m.body?.error ? new Error(m.body?.error || `HTTP ${m.status}`) : m.body);
  };
  if (!r.body || !r.body.getReader) { (await r.text()).split('\n').forEach(line); return; }
  const rd = r.body.getReader(), dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    for (let nl; (nl = buf.indexOf('\n')) >= 0;) { line(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
  }
  line(buf + dec.decode());
}
// Background enrichment: nobody is waiting on these, so they are debounced into big batches (see DataLoader).
const LAZY = /^(javdb|probe|douban\/rating)$/;
const apiLoader = new DataLoader(fetchBatch);
// A caller that leaves (page change, closed sheet) just stops waiting; the shared request itself is not cancelled.
const withSignal = (p, signal) => !signal ? p : new Promise((ok, bad) => {
  const gone = () => bad(new DOMException('aborted', 'AbortError'));
  if (signal.aborted) return gone();
  signal.addEventListener('abort', gone, { once: true });
  p.then(ok, bad).finally(() => signal.removeEventListener('abort', gone));
});
const fetchApi = (route, params, signal) => {
  if (PV) params = { ...params, ...PV.q };
  if (!BATCHABLE.test(route)) return get(`/api/${route}?` + new URLSearchParams(params), signal);
  const qs = new URLSearchParams(params); qs.sort();
  const key = `${route}?${qs}`, p = apiLoader.load(key, { lazy: LAZY.test(route) }), sig = signal === undefined ? pageCtl.signal : signal || undefined;
  if (!sig) return p;
  // 调用方离开 (切页面等) 就 release: 没人要的请求不再发 / 已发的整批没人要了就中断，服务端也跟着断开上游
  return new Promise((ok, bad) => {
    const gone = () => { apiLoader.release(key); bad(new DOMException('aborted', 'AbortError')); };
    if (sig.aborted) return gone();
    sig.addEventListener('abort', gone, { once: true });
    p.then(ok, bad).finally(() => sig.removeEventListener('abort', gone));
  });
};
const api = (route, params = {}, signal) => {
  const ttl = MEMO_TTL[route];
  if (!ttl) return fetchApi(route, params, signal);
  const k = state.level + '|' + route + '?' + new URLSearchParams(params), hit = apiMemo.get(k);
  if (hit && Date.now() - hit.at < ttl) { apiMemo.delete(k); apiMemo.set(k, hit); return Promise.resolve(hit.v); }
  return fetchApi(route, params, signal).then(v => {
    apiMemo.set(k, { at: Date.now(), v });
    if (apiMemo.size > MEMO_MAX) apiMemo.delete(apiMemo.keys().next().value);
    return v;
  });
};
function toast(msg, sticky) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  document.body.append(t);
  if (!sticky) setTimeout(() => t.remove(), 2600);
  return t; // sticky: stays until the caller removes it
}
// ---------- 分享链接 ----------
// 详情页 / 播放页的「分享」：复制一个能直接打开这部片（或这一集 / 这个频道）的链接。链接就是现有的深链接
// （#/v/… 详情、#/play/… 某一集、#/tv/… 直播频道），不新增服务端接口。
// 在本机用 localhost 打开时，链接里换成局域网地址，不然发给别人是打不开的。
// 链接里不带访问令牌：对方第一次打开输入一次令牌（深链接会保留，输完直接进到这部片）。
const LOCAL_HOST = /^(localhost|127\.|\[?::1\]?$)/;
const shareUrl = hash => location.origin + '/' + (PV ? location.search : '') + hash;   // 按当前打开的地址 (host) 生成，不替换成别的网卡地址
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; } catch {}
  // http 的局域网地址不是安全上下文，没有 clipboard API：用选中文本 + execCommand 兜底
  const ta = document.createElement('textarea');
  ta.value = t; ta.readOnly = true; ta.style.cssText = 'position:fixed;left:0;top:0;opacity:0;font-size:16px';
  document.body.append(ta); ta.focus(); ta.select(); ta.setSelectionRange(0, t.length);
  let ok = false; try { ok = document.execCommand('copy'); } catch {}
  ta.remove(); return ok;
}
// 分享 = 手机上唤起系统分享面板 (微信 / 信息 / 邮件 / AirDrop …)，没有系统分享的环境 (桌面浏览器、http 局域网地址不是安全上下文)
// 退回复制链接。链接里不含令牌，对方打开后输入一次访问令牌。
// navigator.share 必须在用户手势里同步调用：shareUrl 是同步的，调用前不能 await 任何东西，否则 iOS Safari 会拒绝。
async function shareNow(hash, title = '') {
  const url = shareUrl(hash);
  // 桌面浏览器的系统分享面板不稳 (点了会卡死甚至整个浏览器退出)：只在触屏设备上用，桌面直接复制链接
  // 电脑 Chrome 的「模拟移动设备」也是触屏 UA，同样会卡：真机的 maxTouchPoints 是 5 以上，模拟器只有 1，据此排除
  if (navigator.share && matchMedia('(pointer: coarse)').matches && navigator.maxTouchPoints > 1) {
    try {
      await navigator.share({ ...(title ? { title, text: title } : {}), url });
      return;
    } catch (err) {
      if (err?.name === 'AbortError') return;   // 用户自己关掉了面板
      // 其它错误 (NotAllowedError 等): 退回复制
    }
  }
  if (await copyText(url)) toast('链接已复制');
  else prompt('复制这个链接：', url);
}
const spinner = '<div class="spinner"></div>';
const fmtSize = b => b > 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b > 1e7 ? (b / 1e6).toFixed(0) + ' MB' : (b / 1e6).toFixed(1) + ' MB';
const fmtSpeed = b => !b ? '' : b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB/s' : Math.max(1, Math.round(b / 1e3)) + ' KB/s';
const fmtEta = s => !s ? '' : s < 60 ? `剩 ${s} 秒` : s < 3600 ? `剩 ${Math.ceil(s / 60)} 分` : `剩 ${(s / 3600).toFixed(1)} 小时`;
const ACTIVE = ['queued', 'downloading'];

// ---------- history (继续观看) ----------
// 观看历史 / 进度属于当前账号 (UD, 见 acct.js)：访客存在本机，登录后按账号隔离并同步到服务端。
const hist = {
  all: () => UD.json('history', []),
  get: (site, id) => hist.all().find(h => h.site === site && h.id === id),
  put(entry) {
    const list = hist.all().filter(h => !(h.site === entry.site && h.id === entry.id));
    const e = { ...entry, at: Date.now() };
    list.unshift(e);
    UD.set('history', JSON.stringify(list.slice(0, 40)));
    ACCT.op({ t: 'hist.put', e });
  },
  del(site, id) { UD.set('history', JSON.stringify(hist.all().filter(h => !(h.site === site && h.id === id)))); ACCT.op({ t: 'hist.del', site, id }); },
  clear() { UD.set('history', '[]'); ACCT.op({ t: 'hist.clear' }); },
  // The local source lists only its own history; 成人 titles follow showEntry (see below).
  visible: (h, site = state.site) => (site === 'local' ? h.site === 'local' : true) && showEntry(h, site),
  list: () => hist.all().filter(h => hist.visible(h)),
};

// 成人 entries (history / favorites): a title is 成人 when it was saved with the flag, its source is a 成人 source, or it is
// a local title that is not explicitly flagged clean (legacy entries). They appear nowhere in 儿童 / 标准 mode, and in
// 全部 mode only while the current source is itself a 成人 source (or the local one) — never on an ordinary source's home.
const entryAdult = e => !!e.adult || (e.site === 'local' ? e.adult !== 0 : !!state.sites.find(s => s.key === e.site)?.adult);
const adultCtx = site => site === 'local' || !!state.sites.find(s => s.key === site)?.adult;
// (Outside 全部 mode a 成人 source is not in state.sites at all, so an entry from an unknown source can't be told apart: hidden.)
const showEntry = (e, site = state.site) => state.level === 'all' ? !entryAdult(e) || adultCtx(site)
  : !entryAdult(e) && (e.site === 'local' || state.sites.some(s => s.key === e.site));

// ---------- favorites (hidden in 儿童 mode) ----------
const favs = {
  all: () => UD.json('favs', []),
  has: (site, id) => favs.all().some(f => f.site === site && f.id === id),
  toggle(d) {
    if (favs.has(d.site, d.id)) { favs.del(d.site, d.id); return false; }
    const { site, siteName, id, name, pic, remarks, year, type, quality } = d;
    const e = { site, siteName, id, name, pic, remarks, year, type, quality, ...(d.adult ? { adult: 1 } : {}), at: Date.now() };
    UD.set('favs', JSON.stringify([e, ...favs.all()].slice(0, 500)));
    ACCT.op({ t: 'fav.put', e });
    return true;
  },
  list: () => favs.all().filter(f => showEntry(f)),
  del(site, id) { UD.set('favs', JSON.stringify(favs.all().filter(f => !(f.site === site && f.id === id)))); ACCT.op({ t: 'fav.del', site, id }); },
  clear() { UD.set('favs', '[]'); ACCT.op({ t: 'fav.clear' }); },
};
const kidsMode = () => state.level === 'kids';
const liveFavs = {
  all: () => UD.json('liveFavs', []),
  has: url => liveFavs.all().some(f => f.url === url),
  toggle(c) {
    const on = !liveFavs.has(c.url);
    const e = { name: c.name, url: c.url, logo: c.logo || '', at: Date.now() };
    UD.set('liveFavs', JSON.stringify(on ? [e, ...liveFavs.all()] : liveFavs.all().filter(f => f.url !== c.url)));
    ACCT.op(on ? { t: 'lfav.put', e } : { t: 'lfav.del', url: c.url });
    return on;
  },
};

// ---------- 豆瓣 ratings (lazy, cached) ----------
const dbCache = JSON.parse(localStorage.douban || '{}');
function dbRate(name, year) {
  const k = name + '|' + (year || '');
  const c = dbCache[k];
  if (c && c.v === 2 && Date.now() - c.at < 3 * 86400e3) return Promise.resolve(c);
  // Not tied to the page: the answer is worth keeping even if the user already moved on. Batched by apiLoader.
  return api('douban/rating', { name, year: year || '' }, null).catch(() => ({ found: false, error: 1 })).then(r => {
    const v = { rate: r.rate || '', id: r.id || '', pic: r.pic || '', v: 2, at: Date.now() };
    if (!r.error) { dbCache[k] = v; localStorage.douban = JSON.stringify(dbCache); }
    return v;
  });
}
const dbIO = new IntersectionObserver(es => es.forEach(e => {
  if (!e.isIntersecting) return;
  const el = e.target; dbIO.unobserve(el);
  dbRate(el.dataset.n, el.dataset.y).then(r => { if (r.rate) { el.textContent = r.rate; el.hidden = false; } });
}), { rootMargin: '200px' });
function observeRatings(root = document) { $$('.db[data-n]:not([data-javfb])', root).forEach(el => { if (!el.dataset.obs) { el.dataset.obs = 1; dbIO.observe(el); } }); }

// ---------- javdb (成人元数据, lazy, cached) ----------
const javCode = s => {
  // Literal escape debris from mangled names ("SNIS-989\\b中文", "\\bSNIS-989", "\\w@…") must not glue onto the code
  // as a letter ("\\bSNIS" would read as BSNIS): a backslash + letter is just a separator.
  const up = String(s ?? '').replace(/\\[A-Za-z]/g, ' ').toUpperCase();
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
// A title that BEGINS with a 番号 (SSIS-001 …, [FC2-PPV-123] …, 第一会所@SONE-123 …) is a JAV title whether or not its source is flagged 成人.
// Only meaningful with 安全级别「全部」: the server answers nothing else.
const javLead = name => {
  if (state.level !== 'all') return '';
  const n = String(name ?? '').trim();
  const code = javCode(n);
  if (!code) return '';
  // Position of the 番号 in the ORIGINAL title (CJK text counts): it must open the title, a short site tag in front is fine.
  const parts = code.split('-'), lead = parts[0], tail = parts[parts.length - 1].replace(/^0+/, '');
  const re = new RegExp(parts.length > 2 ? parts.join('[\\s\\-_]?') : lead + '[\\s\\-_]?0*' + tail, 'i');
  const at = n.search(re);
  return at >= 0 && at <= 10 ? code : '';
};
// The picture a card ends up showing: javdb's cover when it has one for this 番号 (the card swaps it in), else the source's own.
// javdb's cover replaces a title's picture only for 本地 media (frames cut from the file) or when the source gave no picture at all;
// a remote source's own cover stays. javdb is still used for the score / cast / title either way.
const javCoverWanted = it => !!it && (it.site === 'local' || !it.pic);
const cardPic = it => { const c = it && isJav(it) && javCoverWanted(it) ? javCache[javCode(it.name)] : null; return (c && c.found && c.cover) || it?.pic || ''; };
const isJav = it => !!(it && (it.adult || (it.site && it.site !== 'local' && state.sites.find(s => s.key === it.site)?.adult) || javLead(it.name)));
const javCache = JSON.parse(localStorage.javdb || '{}');
// Cached: found for 30 days; "javdb has no such code" for 3 days (a real answer). Errors / unreachable mirrors are never cached.
// Concurrent asks for one code share a single request.
const javBusy = new Map();
const saveJav = () => { try { localStorage.javdb = JSON.stringify(javCache); } catch { for (const k of Object.keys(javCache).slice(0, 200)) delete javCache[k]; } };
function javMeta(code) {
  const c = javCache[code], age = c ? Date.now() - c.at : Infinity;
  if (c && c.found && c.v === 2 && age < 30 * 86400e3) return Promise.resolve(c);
  if (c && c.found === false && c.v === 3 && age < 3 * 86400e3) return Promise.resolve(c);
  if (javBusy.has(code)) return javBusy.get(code);
  const p = api('javdb', { code }, null).catch(e => ({ found: false, error: e.message, aborted: isAbort(e) })).then(r => {
    javBusy.delete(code);
    const v = { ...r, at: Date.now() };
    if (r.found) { javCache[code] = v; saveJav(); }
    else if (!r.error) { javCache[code] = { found: false, v: 3, at: v.at }; saveJav(); }
    return v;
  });
  javBusy.set(code, p);
  return p;
}
// Cards: javdb 优先补封面+评分；没番号 / 匹配不到 / 抓取失败 → 豆瓣兜底（成人条目不预先走豆瓣）。
const javIO = new IntersectionObserver(es => es.forEach(e => {
  if (!e.isIntersecting) return;
  const el = e.target; javIO.unobserve(el);
  const db = el.querySelector('.db[data-javfb]');
  const douban = () => { if (db) dbRate(db.dataset.n, db.dataset.y).then(x => { if (x.rate) { db.textContent = x.rate; db.hidden = false; } }); };
  const code = el.dataset.jav;
  if (!code) { douban(); return; }
  javMeta(code).then(r => {
    if (!el.isConnected) return;
    if (r.aborted) { delete el.dataset.jobs; setTimeout(() => { if (el.isConnected) observeJav(el.parentElement || document); }, 800); return; }   // 切页面时被取消: 这张卡还在屏幕上就重新排队
    if (!r.found) { douban(); return; }
    if (r.cover && (el.dataset.site === 'local' || !el.querySelector('.img img'))) {
      const im = el.querySelector('.img img'); const ph = el.querySelector('.img');
      if (im) im.src = img(r.cover); else if (ph) ph.style.cssText = bg(r.cover);
    }
    if (r.score) {
      let t = el.querySelector('.jav'); if (!t) { t = document.createElement('span'); t.className = 'jav'; el.querySelector('.img')?.append(t); }
      if (t) t.textContent = r.score;
    }
  });
}), { rootMargin: '300px' });
function observeJav(root = document) { $$('.card[data-jav]', root).forEach(el => { if (!el.dataset.jobs) { el.dataset.jobs = 1; javIO.observe(el); } }); }

// ---------- boot / source picker ----------
// Source menu: opening it pings the rows in view (4 at a time, one retry); scrolling pings the rest.
// Only passing results are cached (localStorage, valid until 「重测」). A failure is shown but never kept: it is tested again every time the menu opens.
const siteHealth = new Map(Object.entries((() => { try { return JSON.parse(localStorage.siteHealth || '{}'); } catch { return {}; } })())); // api -> { ok, ms, total, at }
const healthBusy = new Set();
let healthEpoch = 0; // set whenever the menu opens: a failure older than that is not trusted
let menuIO = null, healthQ = [], healthRun = 0, healthSave = 0;
const saveHealth = () => { clearTimeout(healthSave); healthSave = setTimeout(() => {
  const live = new Set(state.sites.map(x => x.api)); // forget sources that no longer exist
  localStorage.siteHealth = JSON.stringify(Object.fromEntries([...siteHealth].filter(([k, v]) => v.ok && live.has(k)))); }, 400); };
const healthFresh = t => t && (t.ok || t.at >= healthEpoch);
// A 聚合源 has no link of its own: it is tested through its members (not listed in the menu). Result: how many of them answer.
const membersOf = g => (g.members || []).map(k => state.sites.find(x => x.key === k)).filter(m => m && m.api && !m.local);
const groupHealth = g => {
  const ms = membersOf(g), hs = ms.map(m => siteHealth.get(m.api));
  if (!ms.length) return null;
  const busy = ms.some(m => healthBusy.has(m.api));
  const done = hs.filter(Boolean), okN = done.filter(h => h.ok).length;
  return { busy, all: done.length === ms.length, okN, n: ms.length, ok: okN > 0 };
};
const isBusy = s => s.group ? !!groupHealth(s)?.busy : healthBusy.has(s.api);
const isDead = s => { if (s.group) { const g = groupHealth(s); return !!g && !g.busy && g.all && !g.ok; } const h = siteHealth.get(s.api); return !!h && !h.ok && !healthBusy.has(s.api); };
const healthCell = (s, busy) => busy ? `<b class="hs">${netBusy}</b>`
  : s.group ? (g => !g || !g.all ? `<b class="hs"><span class="net"><span class="nt"><small>聚合 ${s.group}</small></span></span></b>` : `<b class="hs">${netBox(!g.ok ? 0 : g.okN === g.n ? 4 : 2, `${g.okN}/${g.n} 可用`, '成员里能连上的')}</b>`)(groupHealth(s))
  : !s.api || s.local ? ''
  : !siteHealth.get(s.api) ? '<b class="hs"><span class="net"><span class="nt"><small>…</small></span></span></b>'
  : siteHealth.get(s.api).ok ? `<b class="hs">${netBox(netLvMs(siteHealth.get(s.api).ms), siteHealth.get(s.api).ms + ' ms')}</b>` : `<b class="hs">${netBox(0, '连不上')}</b>`;
let menuQ = '', menuTab = 'vis';   // menuTab: 'vis' = 可见的点播源, 'hid' = 在设置里标为隐藏的
const menuTabs = (n, h, tab, attr) => h ? `<div class="mtabs"><button type="button" ${attr}="vis" class="${tab === 'vis' ? 'on' : ''}">可见 ${n}</button><button type="button" ${attr}="hid" class="${tab === 'hid' ? 'on' : ''}">隐藏 ${h}</button></div>` : '';
function filterMenu() {
  const q = menuQ.toLowerCase(), rows = $$('#siteMenu button[data-k]');
  let n = 0;
  rows.forEach(b => { const hit = !q || (b.dataset.n || '').includes(q); b.classList.toggle('mhid', !hit); if (hit) n++; });
  const c = $('#siteMenu .mcount'); if (c) c.textContent = q ? `${n} / ${rows.length}` : rows.length;
  const e = $('#siteMenu .mempty'); if (e) e.hidden = n > 0;
  if (!$('#siteMenu').hidden) requestAnimationFrame(() => pingMenu());
}
function renderMenu() {
  const top = state.sites.filter(s => !s.inGroup), nHid = top.filter(s => s.hidden).length;
  if (!nHid) menuTab = 'vis';
  $('#siteMenu').innerHTML = menuTabs(top.length - nHid, nHid, menuTab, 'data-mtab') + `<div class="msearch"><input id="menuQ" class="find" type="search" placeholder="搜点播源" autocomplete="off" value="${esc(menuQ)}"></div><div class="mhead">点播源 · <span class="mcount"></span><span class="mre" data-re="1" title="重新测速当前可见的源">重测</span></div>` + top.filter(s => !!s.hidden === (menuTab === 'hid')).map(s =>
    `<button data-k="${esc(s.key)}" data-n="${esc((s.name + ' ' + s.key).toLowerCase())}" class="${s.key === state.site ? 'on' : ''}${isDead(s) ? ' dead' : ''}"><span>${esc(s.name)}</span>${s.kids ? '<i>少儿</i>' : ''}${healthCell(s, isBusy(s))}${s.key === 'local' || s.local || state.level !== 'all' ? '' : `<em class="x" data-del="${esc(s.key)}" title="删除这个源">×</em>`}</button>`).join('')
    + `<div class="mempty" hidden>没有匹配的点播源</div>`;
  filterMenu();
}
function watchMenu() {
  if (menuIO) menuIO.disconnect();
  if ($('#siteMenu').hidden) return;
  menuIO = new IntersectionObserver(es => es.forEach(en => {
    if (!en.isIntersecting) return;
    const s = state.sites.find(x => x.key === en.target.dataset.k);
    if (s && ((s.api && !s.local) || s.group)) queueHealth(s);
  }), { root: $('#siteMenu') });
  $$('#siteMenu button[data-k]').forEach(b => menuIO.observe(b));
}
function markHealth(s) {
  const b = $(`#siteMenu button[data-k="${CSS.escape(s.key)}"]`); if (!b) return;
  const had = $('.hs', b), tmp = document.createElement('div');
  tmp.innerHTML = healthCell(s, isBusy(s));
  const hs = tmp.firstElementChild;
  if (had) had.replaceWith(hs); else if (hs) b.insertBefore(hs, $('em.x', b));
  b.classList.toggle('dead', isDead(s));
}
const markGroupsOf = m => state.sites.filter(g => g.members?.includes(m.key)).forEach(markHealth);
function queueHealth(s, force) {
  if (s.group) { membersOf(s).forEach(m => queueHealth(m, force)); return markHealth(s); }
  if (healthBusy.has(s.api) || (!force && healthFresh(siteHealth.get(s.api)))) return;
  healthBusy.add(s.api); healthQ.push(s); markHealth(s); markGroupsOf(s); drainHealth();
}
function drainHealth() {
  while (healthRun < 4 && healthQ.length) {
    const s = healthQ.shift(); healthRun++;
    (async () => {
      let r;
      for (let k = 0; k < 2; k++) {
        r = await api('check', { api: s.api }, AbortSignal.timeout(22e3)).catch(e => ({ ok: false, error: e.message }));
        if (r.ok) break;
      }
      siteHealth.set(s.api, { ok: !!r.ok, ms: r.ms, total: r.total, at: Date.now() });
      healthBusy.delete(s.api); healthRun--; saveHealth();
      markHealth(s); markGroupsOf(s);
      drainHealth();
    })();
  }
}
// Rows currently visible in the menu, by geometry (does not depend on the observer having fired yet).
function visibleMenuSites() {
  const m = $('#siteMenu').getBoundingClientRect();
  return $$('#siteMenu button[data-k]').filter(b => { const r = b.getBoundingClientRect(); return r.height && r.bottom > m.top && r.top < m.bottom; })
    .map(b => state.sites.find(x => x.key === b.dataset.k)).filter(s => s && ((s.api && !s.local) || s.group));
}
function pingMenu(force) {
  watchMenu();
  const vis = visibleMenuSites();
  const todo = force && !vis.length ? testableSites() : vis;
  if (force && !todo.length) return toast('没有可测速的源');
  todo.forEach(s => queueHealth(s, force));
  if (force) toast(`重测 ${todo.length} 个源`);
}
const testableSites = () => state.sites.filter(s => ((s.api && !s.local) || s.group) && !s.inGroup);
// Without opening the menu: every source that has no good result yet gets pinged in the background (4 at a time);
// passing results are reused from the cache, failures are never cached.
let autoPingT = 0;
function autoPing() {
  clearTimeout(autoPingT);
  autoPingT = setTimeout(() => testableSites().forEach(s => queueHealth(s)), 1500);
}

// 点播源列表的三种来源：
//   'swr' 冷启动：服务端写进页面的 window.__BOOT__（有就直接用，一次请求都不发）；没有就 GET /api/sites，由 Service Worker 做 stale-while-revalidate（先回缓存，后台更新，有变化会发消息）
//   'net' 一定走网络（Service Worker 更新通知后用）
//   不传  走原来的批量接口（改完设置之后用）
let bootSites = window.__BOOT__ || null; delete window.__BOOT__;
async function fetchSites(cache) {
  const r = await fetch('/api/sites', { cache });
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
async function loadSites(src) {
  const boot = bootSites; bootSites = null;
  const j = PV || !src ? await api('sites', {}, null) : src === 'swr' && boot ? boot : await fetchSites(src === 'net' ? 'no-store' : 'default');
  state.sites = j.sites; state.lives = j.live; state.level = j.level;
  const sig = j.level + '|' + j.sites.map(s => s.key + '|' + (s.api || '')).join(',');
  if (sig !== memoSig) { memoSig = sig; apiMemo.clear(); altCache.clear(); }
  // A source that moved into a 聚合源 is no longer a choice of its own: switch to its group.
  const mine = state.sites.find(s => s.key === state.site);
  if (mine?.inGroup) state.site = localStorage.site = mine.inGroup;
  if (!state.sites.some(s => s.key === state.site)) state.site = state.sites.find(s => !s.inGroup)?.key || '';
  const cur = state.sites.find(s => s.key === state.site);
  $('#siteName').textContent = cur ? cur.name : '无源';
  syncScope();
  $('.picker').hidden = !state.sites.length;
  $('#levelTag').hidden = j.level === 'standard';
  $('[data-nav=favorites]').hidden = j.level === 'kids';
  document.documentElement.classList.toggle('kidslevel', j.level === 'kids');
  $('[data-nav=charts]').hidden = j.level === 'kids';
  chartCat = null;
  $('#levelTag').textContent = j.level === 'kids' ? '少儿' : '无限';
  $('#levelTag').className = 'level ' + j.level;
  renderMenu();
  autoPing();
}
// Service Worker 在后台发现源列表和刚才用的缓存不一样（比如在别的设备改了安全级别）：重新读一遍，级别或当前源变了就重画当前页
if (!PV && 'serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', async e => {
    if (e.data?.type !== 'sites-updated') return;
    const lv = state.level, site = state.site;
    try { await loadSites('net'); } catch { return; }
    if (state.level !== lv || state.site !== site) { state.cats = []; apiMemo.clear(); route(); }
  });
  navigator.serviceWorker.startMessages?.();
}
$('#siteBtn').onclick = e => { e.stopPropagation(); closeScope(); if ($('#siteMenu').hidden) { menuTab = state.sites.find(s => s.key === state.site)?.hidden ? 'hid' : 'vis'; renderMenu(); } $('#siteMenu').hidden = !$('#siteMenu').hidden; if (!$('#siteMenu').hidden) healthEpoch = Date.now(); $('#siteBtn').classList.toggle('open', !$('#siteMenu').hidden); if (!$('#siteMenu').hidden) { requestAnimationFrame(() => pingMenu()); if (matchMedia('(hover:hover)').matches) $('#menuQ')?.focus(); $('#siteMenu button.on')?.scrollIntoView({ block: 'nearest' }); } };
$('#siteMenu').oninput = e => { if (e.target.id === 'menuQ') { menuQ = e.target.value.trim(); filterMenu(); } };
$('#siteMenu').onkeydown = e => {
  if (e.target.id !== 'menuQ') return;
  if (e.key === 'Enter') { e.preventDefault(); $('#siteMenu button[data-k]:not(.mhid)')?.click(); }
  else if (e.key === 'Escape') { if (menuQ) { e.target.value = menuQ = ''; filterMenu(); } else closeMenu(); }
};
$('#siteMenu').onclick = async e => {
  const mt = e.target.closest('[data-mtab]');
  if (mt) { e.stopPropagation(); menuTab = mt.dataset.mtab; renderMenu(); requestAnimationFrame(() => pingMenu()); return; }
  if (e.target.closest('[data-re]')) { e.stopPropagation(); return pingMenu(true); }
  const del = e.target.closest('[data-del]');
  if (del) {
    e.stopPropagation();
    const key = del.dataset.del, s = state.sites.find(x => x.key === key); if (!s) return;
    if (!confirm(`删除点播源「${s.name}」？`)) return;
    if (!leaveSettingsOk()) return;   // the settings page is rebuilt afterwards
    try {
      const cfg = await get('/api/config');
      await req('PUT', '/api/config', { ...cfg, sites: cfg.sites.filter(x => x.key !== key) });
      const was = state.site === key;
      apiMemo.clear(); state.cats = []; await loadSites();
      toast(`已删除「${s.name}」`);
      if (was) route();
      else if (location.hash.startsWith('#/settings')) renderSettings();
    } catch (err) { toast(err.message); }
    return;
  }
  const b = e.target.closest('button[data-k]'); if (!b) return;
  state.site = localStorage.site = b.dataset.k; state.cats = [];
  closeMenu(); syncScope(); menuQ = '';
  loadSites(); if (location.hash && location.hash !== '#/') location.hash = '#/'; else route();
};
const closeMenu = () => { $('#siteMenu').hidden = true; $('#siteBtn').classList.remove('open'); };
// 小屏: the 点播源 list is a bottom sheet (like the 直播源 picker) over a blurred scrim instead of a popover under the header.
const sheetScrim = $('#sheetScrim');
{
  const sheets = () => [$('#siteMenu'), $('#liveMenu')].filter(Boolean);
  // The 直播源 sheet is built inside #view (a fixed layer below the scrim), so on a phone it moves to <body> while open and goes back when closed.
  const dockLive = () => {
    const m = $('#liveMenu'); if (!m) return;
    const mobile = matchMedia('(max-width: 760px)').matches;
    if (!m.hidden && mobile && m.parentElement !== document.body) document.body.append(m);
    else if ((m.hidden || !mobile) && m.parentElement === document.body) { const home = $('#view .lpick'); if (home) home.append(m); else m.remove(); }
  };
  // (长按卡片的浮窗开着时 ctxSheet 为真: 源菜单那边任何 hidden 变动触发 sync, 都不能把遮罩和 sheet-open 收掉)
  const sync = () => { dockLive(); const on = ctxSheet || (matchMedia('(max-width: 760px)').matches && sheets().some(m => !m.hidden)); sheetScrim.hidden = !on; document.body.classList.toggle('sheet-open', on); document.body.classList.toggle('live-sheet', on && !!$('#liveMenu') && !$('#liveMenu').hidden); };
  addEventListener('hashchange', () => { const m = $('#liveMenu'); if (m && m.parentElement === document.body) { m.hidden = true; $('#liveBtn')?.classList.remove('open'); } });
  const mo = new MutationObserver(sync);
  const watch = () => sheets().forEach(m => { if (!m._w) { m._w = 1; mo.observe(m, { attributes: true, attributeFilter: ['hidden'] }); } });
  watch(); new MutationObserver(watch).observe(document.body, { childList: true, subtree: true });
  matchMedia('(max-width: 760px)').addEventListener('change', sync);
  sheetScrim.addEventListener('click', () => { closeMenu(); const l = $('#liveMenu'); if (l && !l.hidden) { l.hidden = true; $('#liveBtn')?.classList.remove('open'); } });
}
document.addEventListener('click', e => { if (!e.composedPath().some(n => n.classList?.contains('picker'))) closeMenu(); });
// ---------- search box: scope (全部源 / 仅当前源) ----------
const searchScope = { get: () => localStorage.searchScope === 'site' ? 'site' : 'all', set(v) { localStorage.searchScope = v; syncScope(); } };
const personHash = (role, name, scope = searchScope.get()) => '#/person/' + role + '/' + encodeURIComponent(name) + (scope === 'site' && state.site ? '/' + encodeURIComponent(state.site) : '');
const searchHash = (q, scope = searchScope.get()) => '#/search/' + encodeURIComponent(q) + (scope === 'site' && state.site ? '/' + encodeURIComponent(state.site) : '');
const searchableCount = () => state.sites.filter(s => !s.group).length;
function syncScope() {
  const sc = searchScope.get(), cur = state.sites.find(s => s.key === state.site), site = sc === 'site' && !!cur;
  $('#scopeLabel').textContent = site ? '当前源' : '全部源';
  $('#scopeBtn').classList.toggle('on', site);
  $('#scopeBtn').title = site ? `只在「${cur.name}」里搜` : `在全部 ${searchableCount()} 个源里搜`;
  $('#scopeAllHint').textContent = `同时搜索全部 ${searchableCount()} 个源，结果自动合并`;
  $('#scopeSiteHint').textContent = cur ? cur.name : '没有可用的源';
  $$('#scopeMenu [data-scope]').forEach(b => b.classList.toggle('on', b.dataset.scope === (site ? 'site' : 'all')));
  $('#q').placeholder = smallScreen.matches ? '搜索' : site ? `在「${cur.name}」里搜` : '搜片名 / 演员 / 导演';
}
const closeScope = () => { $('#scopeMenu').hidden = true; $('#scopeBtn').classList.remove('open'); $('#scopeBtn').setAttribute('aria-expanded', 'false'); };
$('#scopeBtn').onclick = e => {
  e.stopPropagation(); closeMenu(); closeHist();
  const open = $('#scopeMenu').hidden;
  $('#scopeMenu').hidden = !open; $('#scopeBtn').classList.toggle('open', open); $('#scopeBtn').setAttribute('aria-expanded', String(open));
};
$('#scopeMenu').onclick = e => {
  const b = e.target.closest('[data-scope]'); if (!b) return;
  searchScope.set(b.dataset.scope); closeScope(); $('#q').focus(); closeHist();
  // Already looking at results: re-run them in the new scope.
  const q = $('#q').value.trim();
  if (location.hash.startsWith('#/search/') && q) location.hash = searchHash(q);
};
document.addEventListener('click', e => { if (!e.target.closest('#searchForm')) closeScope(); });
addEventListener('keydown', e => { if (e.key === 'Escape') closeScope(); });
const recents = {
  all: () => { try { return JSON.parse(UD.get('recentSearches') || '[]').filter(x => typeof x === 'string'); } catch { return []; } },
  add(q) { UD.set('recentSearches', JSON.stringify([q, ...this.all().filter(x => x !== q)].slice(0, 12))); },
  del(q) { UD.set('recentSearches', JSON.stringify(this.all().filter(x => x !== q))); },
  clear() { UD.del('recentSearches'); },
};
const runSearch = q => { q = q.trim(); if (!q) return; recents.add(q); closeScope(); closeSov(); if (typeof closeHist === 'function') closeHist(); $('#q').value = q; location.hash = searchHash(q); };
$('#searchForm').onsubmit = e => { e.preventDefault(); runSearch($('#q').value); };

// 小屏: focusing the search box opens a full-screen search sheet (own input, scope switch, recent searches) instead of
// typing into the cramped header pill.
const smallScreen = matchMedia('(max-width: 760px)');
const sov = $('#sOv');
function paintSov() {
  const cur = state.sites.find(s => s.key === state.site), site = searchScope.get() === 'site' && !!cur;
  $('#sOvAll').textContent = `${searchableCount()} 个源，结果合并`;
  $('#sOvSite').textContent = cur ? cur.name : '没有可用的源';
  $$('#sOvScope [data-scope]').forEach(b => { b.classList.toggle('on', b.dataset.scope === (site ? 'site' : 'all')); if (b.dataset.scope === 'site') b.disabled = !cur; });
  $('#q2').placeholder = site ? `在「${cur.name}」里搜` : '搜片名 / 演员 / 导演';
  const typed = $('#q2').value.trim().toLowerCase(), list = recents.all().filter(x => !typed || x.toLowerCase().includes(typed));
  $('#sOvClear').hidden = !recents.all().length;
  $('#sOvRecent').innerHTML = list.length ? list.map(x => `<div class="sov-row" data-q="${esc(x)}"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7.5V12l3 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><span>${esc(x)}</span><em data-del title="删除这条">×</em></div>`).join('')
    : `<div class="sov-empty">${recents.all().length ? '没有匹配的记录，回车直接搜' : '还没有搜索记录。输入片名、演员或导演，回车搜索。'}</div>`;
}
// Pin the sheet to what is actually visible: when the layout viewport is wider than the visible area (DevTools device mode,
// a browser zoomed out, a page that scrolls sideways) `inset: 0` would make it wider than the screen and push 取消 / the
// second scope card off the right edge.
const fitSov = () => {
  const vv = window.visualViewport;
  if (!vv || sov.hidden) return;
  const fit = Math.abs(vv.scale - 1) < 0.02;
  sov.style.cssText = fit ? `inset:auto;left:${vv.offsetLeft}px;top:${vv.offsetTop}px;width:${vv.width}px;height:${vv.height}px` : '';
};
window.visualViewport?.addEventListener('resize', fitSov);
window.visualViewport?.addEventListener('scroll', fitSov);
function openSov() {
  if (!sov.hidden) return;
  closeScope(); closeMenu();
  $('#q2').value = $('#q').value;
  paintSov(); sov.hidden = false; document.body.classList.add('sov-open'); fitSov();
  $('#q2').focus(); $('#q2').select();
}
function closeSov() {
  if (sov.hidden) return;
  sov.hidden = true; sov.style.cssText = ''; document.body.classList.remove('sov-open'); $('#q2').blur(); $('#q').blur();
}
$('#q').addEventListener('focus', () => { if (smallScreen.matches) openSov(); else openHist(); });

// 大屏: focusing the search box drops down the recent searches right under it. One × removes one, 清空 removes all.
const hist_ = $('#sHist');
let histSel = -1;
const histRows = () => $$('.sov-row', hist_);
function paintHist() {
  const all = recents.all(), typed = $('#q').value.trim().toLowerCase(), list = all.filter(x => !typed || x.toLowerCase().includes(typed));
  histSel = -1;
  if (!list.length) { hist_.hidden = true; return; }
  hist_.innerHTML = `<div class="mhead">最近搜索<span class="mre" data-clear>清空</span></div>` + list.map(x =>
    `<div class="sov-row" data-q="${esc(x)}"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7.5V12l3 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><span>${esc(x)}</span><em data-del title="删除这条">×</em></div>`).join('');
  hist_.hidden = false;
}
function openHist() { if (smallScreen.matches) return; closeScope(); closeMenu(); paintHist(); }
const closeHist = () => { hist_.hidden = true; histSel = -1; };
$('#q').addEventListener('click', () => { if (!smallScreen.matches && hist_.hidden) openHist(); });
// ⊗ on the left of the pill: clear the text, keep the focus (mousedown must not steal it)
for (const clr of $$('.s-clear')) {
  clr.addEventListener('mousedown', e => e.preventDefault());
  clr.addEventListener('click', () => {
    const inp = clr.parentElement.querySelector('input');
    inp.value = ''; inp.focus();
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
$('#q').addEventListener('input', () => { if (!smallScreen.matches && document.activeElement === $('#q')) paintHist(); });
$('#q').addEventListener('keydown', e => {
  if (hist_.hidden && e.key === 'ArrowDown' && !smallScreen.matches) return paintHist();
  if (hist_.hidden) return;
  const rows = histRows();
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    histSel = e.key === 'ArrowDown' ? (histSel + 1) % rows.length : (histSel - 1 + rows.length) % rows.length;
    rows.forEach((r, i) => r.classList.toggle('sel', i === histSel));
    rows[histSel].scrollIntoView({ block: 'nearest' });
    $('#q').value = rows[histSel].dataset.q;
  } else if (e.key === 'Delete' && e.shiftKey && histSel >= 0) {
    e.preventDefault(); recents.del(rows[histSel].dataset.q); $('#q').value = ''; paintHist();
  } else if (e.key === 'Escape') closeHist();
});
// mousedown (not click) so the input keeps focus and its blur does not close the list before the click lands
hist_.addEventListener('mousedown', e => e.preventDefault());
hist_.addEventListener('click', e => {
  if (e.target.closest('[data-clear]')) { recents.clear(); closeHist(); return; }
  const row = e.target.closest('.sov-row'); if (!row) return;
  if (e.target.closest('[data-del]')) { recents.del(row.dataset.q); paintHist(); return; }
  closeHist(); runSearch(row.dataset.q);
});
document.addEventListener('mousedown', e => { if (!e.target.closest('#searchForm')) closeHist(); });
$('#q').addEventListener('blur', () => setTimeout(() => { if (!hist_.matches(':hover')) closeHist(); }, 120));
$('#q2').addEventListener('input', paintSov);
$('#sOvForm').onsubmit = e => { e.preventDefault(); runSearch($('#q2').value); };
$('#sOvCancel').onclick = closeSov;
$('#sOvScope').onclick = e => {
  const b = e.target.closest('[data-scope]'); if (!b || b.disabled) return;
  searchScope.set(b.dataset.scope); paintSov(); $('#q2').focus();
  const q = $('#q2').value.trim();
  if (location.hash.startsWith('#/search/') && q) { closeSov(); location.hash = searchHash(q); }
};
$('#sOvRecent').onclick = e => {
  const row = e.target.closest('.sov-row'); if (!row) return;
  if (e.target.closest('[data-del]')) { recents.del(row.dataset.q); paintSov(); return; }
  runSearch(row.dataset.q);
};
$('#sOvClear').onclick = () => { recents.clear(); paintSov(); };
addEventListener('keydown', e => { if (e.key === 'Escape') closeSov(); });
smallScreen.addEventListener('change', () => { if (!smallScreen.matches) closeSov(); syncScope(); });
addEventListener('hashchange', closeSov);
syncScope();
// The page scrolls inside #view (not the window), so the scrollbar belongs to the content and the header / tab bar stay put.
{
  const top = $('#top'); let hs = -1;
  const paintTop = () => { const v = Math.min(1, Math.max(0, view.scrollTop / 90)); if (Math.abs(v - hs) < .01) return; hs = v; top.style.setProperty('--hs', v.toFixed(3)); top.classList.toggle('solid', v > .3); };
  view.addEventListener('scroll', paintTop, { passive: true });
  new MutationObserver(paintTop).observe(view, { childList: true });
}
addEventListener('hashchange', () => route({ nav: true }));

let heroTimer, pageTimer;
function newPage() {
  closeAdminEs();
  pageCtl.abort();
  pageCtl = new AbortController();
  apiLoader.abortLazy();
  // 上一页还没加载完的封面图: 不要再占浏览器的连接 (每个站点同时只有 6 条), 新页面的请求才不会排在它们后面
  $$('#view img').forEach(im => { if (!im.complete) im.src = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=='; });
  thumbQueue.length = 0;
  stopPreview(); stopLocalPreview(true);
}
// ---- scroll position per history entry ----
// Every page the user lands on gets a key in its history entry's state; the scroll offset is remembered under it
// (sessionStorage, 80 entries) and put back when that entry is visited again by Back / Forward / reload.
// Pages fill in asynchronously (rows, infinite-scroll grids), so restoring waits for the content to get tall enough.
history.scrollRestoration = 'manual';
const scrollMap = (() => { try { return JSON.parse(sessionStorage.scrolls || '{}'); } catch { return {}; } })();
let keepView = null, scrollGuard = false, scrollTick = 0, scrollSave = 0, routeSeq = 0, restoreCtl = null;
const saveScroll = (k, y) => {
  delete scrollMap[k]; scrollMap[k] = Math.round(y);
  const ks = Object.keys(scrollMap); if (ks.length > 80) for (const x of ks.slice(0, ks.length - 80)) delete scrollMap[x];
  clearTimeout(scrollSave); scrollSave = setTimeout(() => { try { sessionStorage.scrolls = JSON.stringify(scrollMap); } catch {} }, 400);
};
view.addEventListener('scroll', () => {
  if (scrollTick) return;
  scrollTick = requestAnimationFrame(() => {
    scrollTick = 0;
    const k = history.state?.sk;
    if (k && !scrollGuard) saveScroll(k, view.scrollTop);
  });
}, { passive: true });
// Returns the saved offset when this entry has been visited before; otherwise gives it a key.
function entryScroll() {
  const st = history.state && typeof history.state === 'object' ? history.state : {};
  if (st.sk) return scrollMap[st.sk] || 0;
  history.replaceState({ ...st, sk: Math.random().toString(36).slice(2) + Date.now().toString(36) }, '');
  return 0;
}
function restoreScroll(y) {
  restoreCtl?.();
  const t0 = Date.now();
  let ro = null, mo = null, timer = 0;
  const stop = () => {
    ro?.disconnect(); mo?.disconnect(); clearTimeout(timer);
    for (const ev of ['wheel', 'touchstart', 'keydown', 'mousedown']) removeEventListener(ev, stop, true);
    if (restoreCtl === stop) restoreCtl = null;
    scrollGuard = false;
  };
  restoreCtl = stop;
  const apply = () => {
    const max = view.scrollHeight - view.clientHeight;
    view.scrollTo(0, Math.min(y, Math.max(0, max)));
    return max >= y - 2;
  };
  if (apply()) return stop();
  ro = new ResizeObserver(() => { if (apply()) stop(); });
  const watch = () => { ro.observe(view); for (const c of view.children) ro.observe(c); };
  watch();
  mo = new MutationObserver(watch);
  mo.observe(view, { childList: true });
  timer = setTimeout(stop, 5000);                       // content never got that tall (list got shorter): give up
  for (const ev of ['wheel', 'touchstart', 'keydown', 'mousedown']) addEventListener(ev, stop, { capture: true, passive: true });
}

// ---- unsaved edits on the settings page ----
// dirty() flags them; saving clears the flag. Leaving (another page, a re-render, reload, closing the tab) asks first.
let settingsDirty = false, settingsHash = '', settingsSaver = null;
const settingsOpen = () => !!$('#srcWrap');
function leaveSettingsOk() {
  if (!settingsDirty || !settingsOpen()) { settingsDirty = false; return true; }
  if (confirm('设置页有未保存的修改，离开后会丢失。\n\n确定要离开吗？（取消 = 留下，去点「保存」）')) { settingsDirty = false; return true; }
  return false;
}
addEventListener('beforeunload', e => { if (settingsDirty && settingsOpen()) { e.preventDefault(); e.returnValue = ''; } });
async function route(opts = {}) {
  if (!leaveSettingsOk()) {
    // The address bar already moved on: put it back without a new history entry, and keep the page as it is.
    if (settingsHash && location.hash !== settingsHash) { history.replaceState(null, '', settingsHash); try { syncNav(); } catch {} }
    return;
  }
  clearInterval(heroTimer); clearInterval(pageTimer); view.onclick = null;
  newPage();
  const seq = ++routeSeq;
  view.classList.remove('restoring');
  let [, page, a, b, c] = location.hash.split('/');
  if (PV?.kind === 'live' && page !== 'live' && page !== 'tv') { history.replaceState(null, '', '#/live'); page = 'live'; }
  else if (PV?.kind === 'vod' && ['charts', 'live', 'tv', 'favorites', 'downloads', 'settings', 'me', 'history'].includes(page)) { history.replaceState(null, '', '#/'); page = ''; }
  // Deep links (what a card's href points at, e.g. after ⌘-click into a new tab): show the page
  // underneath, then the detail / player on top.
  if (page === 'play') {
    const [line, ep] = location.hash.split('/').slice(4).map(Number);
    history.replaceState(null, '', '#/');
    route();
    return openDetail(decodeURIComponent(a || ''), decodeURIComponent(b || ''), { line: line || 0, ep: ep || 0 });
  }
  if (page === 'v' || page === 'find') {
    history.replaceState(null, '', '#/');
    const [site, id, name] = [decodeURIComponent(a || ''), decodeURIComponent(b || ''), decodeURIComponent(a || '')];
    route();
    return page === 'v' ? openDetail(site, id) : openByName(name);
  }
  if (page === 'tv') {
    history.replaceState(null, '', '#/live');
    localStorage.live = decodeURIComponent(a || '');
    return renderLive().then(groups => {
      const url = decodeURIComponent(b || '');
      const g = groups?.find(x => x.channels.some(ch => ch.url === url));
      if (g) playLive(g.channels, g.channels.findIndex(ch => ch.url === url));
      else if (url) playLive([{ name: decodeURIComponent(c || '直播'), url }], 0);
    }).catch(e => { if (!isAbort(e)) throw e; });
  }
  $$('nav a').forEach(n => n.classList.toggle('on', n.dataset.nav === (page || 'home')));
  $('#mineTab')?.classList.toggle('on', ['favorites', 'downloads', 'settings'].includes(page));
  restoreCtl?.();
  const restoreY = entryScroll();
  scrollGuard = true;                                     // don't let the jump to the top overwrite the saved offset
  // Back to home / a category: leave the page that is on screen alone (no spinner, no jump to the top) and swap in the
  // finished page in one go, already at its old scroll position. If that takes over 150 ms (cold data), fall back to the
  // spinner so the click never looks dead.
  const keep = !!opts.nav && restoreY > 0 && state.sites.length > 0 && (!page || page === 'cat') && !!view.firstElementChild;
  keepView = keep ? view.firstElementChild : null;
  let keepTimer = 0;
  if (keep) {
    // Slow path: hide the page (a centred spinner instead) until it is complete and back at its old position, so the
    // user never sees it assemble at the top and then jump. 3 s at most, then the usual progressive fill takes over.
    keepTimer = setTimeout(() => {
      if (seq !== routeSeq) return;
      view.classList.add('restoring');
      setTimeout(() => { if (seq === routeSeq) view.classList.remove('restoring'); }, 3000);
    }, 150);
  } else {
    view.scrollTo(0, 0);
    // Pages that wait for the network before drawing: show the title and a spinner right away, so the tap never looks dead.
    const early = { settings: '设置', downloads: '下载', charts: '榜单' }[page];
    if (early) view.innerHTML = `<div class="page"><h1>${early}</h1>${spinner}</div>`;
  }
  try {
    if (page === 'live') return await renderLive();
    if (page === 'settings') { settingsGoto = a || ''; return await renderSettings(); }
    if (page === 'downloads') return await renderDownloads();
    if (page === 'charts') return await renderCharts();
    if (!state.sites.length) return renderNoSites();
    if (page === 'history') return renderHistory();
    if (page === 'favorites') return renderFavorites();
    if (page === 'person') return await renderPerson(a, decodeURIComponent(b || ''), decodeURIComponent(c || ''));
    if (page === 'site') {
      const k = decodeURIComponent(a || '');
      if (state.sites.some(x => x.key === k)) { state.site = localStorage.site = k; state.cats = []; await loadSites(); }
      history.replaceState(null, '', '#/');
      return await renderHome();
    }
    if (page === 'search') return await renderSearch(decodeURIComponent(a || ''), decodeURIComponent(b || ''));
    if (page === 'cat') return await renderCategory(decodeURIComponent(a || ''), decodeURIComponent(b || ''), decodeURIComponent(c || ''));
    return await renderHome();
  } catch (e) {
    if (isAbort(e)) return;
    view.innerHTML = `<div class="page"><div class="err">加载失败：${esc(e.message)}。右上角换个源试试，或去 <a href="#/settings"><u>设置</u></a> 检查。</div></div>`;
  } finally {
    clearTimeout(keepTimer);
    if (seq === routeSeq) keepView = null;
    if (seq === routeSeq) {
      if (opts.nav && restoreY > 0) restoreScroll(restoreY); else scrollGuard = false;
      view.classList.remove('restoring');
    }
  }
}

function renderNoSites() {
  view.innerHTML = `<div class="page"><h1>没有可用的点播源</h1><p class="empty">${state.level === 'kids' ? '当前是儿童模式，只显示标记为「少儿」的源。' : ''}去 <a href="#/settings"><u>设置</u></a> 添加源或调整安全级别。</p></div>`;
}

// ---------- cards & rows ----------
const vodHref = (site, id) => `#/v/${encodeURIComponent(site)}/${encodeURIComponent(id)}`;
const playHref = (site, id, line, ep) => `#/play/${encodeURIComponent(site)}/${encodeURIComponent(id)}/${line}/${ep}`;
// Plain clicks are handled in-page; ⌘/Ctrl/Shift/Alt/middle click fall through to the browser (new tab / window).
const plainClick = e => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
function card(it, opts = {}) {
  if (!it.douban && it.site) cardItems.set(it.site + '|' + it.id, it);
  const h = it.site && hist.get(it.site, it.id);
  const pct = h && h.dur ? Math.min(100, (h.t / h.dur) * 100) : 0;
  const href = it.douban ? `#/find/${encodeURIComponent(it.name)}` : vodHref(it.site, it.id);
  const pv = it.site === 'local' && /^\/media\/p\//.test(it.pic || '') ? ` data-pv="${esc(it.pic.replace('/media/p/', '/media/g/'))}"` : '';
  const data = it.douban ? `data-db="${esc(it.name)}"` : `data-site="${esc(it.site)}" data-id="${esc(it.id)}"${isJav(it) ? ` data-jav="${esc(javCode(it.name))}"` : ''}`;
  const rate = it.douban ? (it.rate ? `<span class="db">${esc(it.rate)}</span>` : '')
    : isJav(it) ? `<span class="db" hidden data-javfb data-n="${esc(it.name)}" data-y="${esc(it.year || '')}"></span>`
    : it.site === 'local' ? '' : `<span class="db" hidden data-n="${esc(it.name)}" data-y="${esc(it.year || '')}"></span>`;
  return `<a class="card${opts.rank ? ' top' : ''}" href="${esc(href)}" ${data}${pv}>${opts.rank ? `<span class="num">${opts.rank}</span>` : ''}${opts.removable ? `<button class="rm" data-rm="${opts.removable}" title="${opts.removable === 'fav' ? '取消收藏' : '从观看历史删除'}" aria-label="删除">✕</button>` : ''}
    <div class="img${it.pic ? '' : ' noimg'}">${it.pic ? posterImg(it.pic) : ''}<span class="ph">${esc(it.name)}</span>${it.remarks ? `<span class="badge">${esc(it.remarks)}</span>` : ''}${qChip(vodQ(it))}${rate}${opts.dup > 1 ? `<span class="dup" title="${esc(opts.dupTitle || '')}">${opts.dup} 源</span>` : ''}
      ${pct ? `<div class="prog" style="width:${pct}%"></div>` : ''}</div>
    <div class="name">${esc(it.name)}</div>${opts.sub ? `<div class="sub">${esc(opts.sub)}</div>` : ''}</a>`;
}
document.addEventListener('click', e => {
  const c = e.target.closest('#view .card'); if (!c) return;
  const rm = e.target.closest('.rm');
  if (rm) {
    e.preventDefault(); e.stopPropagation();
    (rm.dataset.rm === 'fav' ? favs : hist).del(c.dataset.site, c.dataset.id);
    const sc = c.closest('.scroller, .grid');
    c.remove();
    if (sc && !sc.querySelector('.card')) sc.closest('.row, .page')?.querySelector('.hempty')?.removeAttribute('hidden'), sc.closest('.row')?.remove();
    return;
  }
  if (!plainClick(e)) return;
  e.preventDefault();
  if (c.dataset.db !== undefined) openByName(c.dataset.db); else openDetail(c.dataset.site, c.dataset.id);
});
// ---------- 卡片菜单: 右键 (PC) / 长按 (手机) → 影片播放 (原模式) | 沉浸播放 (沉浸模式) ----------
// 沉浸播放从这张卡片开始, 按它所在列表 (一行 / 一个网格) 的顺序往下放; 分类 / 搜索页顶部的沉浸按钮才是随机 + 按喜好推荐。
// 电脑右键 = 鼠标位置的小菜单; 手机长按 = 底部上拉浮窗 (同点播源 / 直播源的底部抽屉: 虚化遮罩, 点遮罩收起)
let ctxEl = null, ctxCard = null, ctxSheet = false, ctxAt = 0, lpT = 0, lpXY = null, lpFired = 0;
function closeCardMenu() {
  if (!ctxEl) return;
  ctxEl.remove(); ctxEl = null;
  if (ctxSheet) { sheetScrim.hidden = true; document.body.classList.remove('sheet-open', 'card-sheet'); ctxSheet = false; }
  ctxCard?.classList.remove('lp'); ctxCard = null;
}
function openCardMenu(c, x, y, sheet) {
  closeCardMenu();
  ctxCard = c; c.classList.add('lp'); ctxAt = Date.now();
  const m = ctxEl = document.createElement('div');
  m.className = 'ctxm' + (sheet ? ' csheet' : '');
  m.innerHTML = `${sheet ? `<div class="chead">${esc(c.querySelector('.name')?.textContent || '')}</div>` : ''}<button data-ctx="play">${IC.play}影片播放</button><button data-ctx="feed">${IC.feed}沉浸播放</button>${c.dataset.site === 'local' ? '' : `<button data-ctx="share">${IC.share}分享</button>`}`;
  document.body.append(m);
  if (sheet) { ctxSheet = true; sheetScrim.hidden = false; document.body.classList.add('sheet-open', 'card-sheet'); }
  else {
    const r = m.getBoundingClientRect();
    m.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px';
    m.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
  }
  m.addEventListener('click', e => {
    const b = e.target.closest('[data-ctx]'); if (!b) return;
    e.stopPropagation();
    closeCardMenu();
    if (b.dataset.ctx === 'play') playDirect(c);
    else if (b.dataset.ctx === 'share') shareNow(c.getAttribute('href'), c.querySelector('.name')?.textContent || '');
    else feedFromCard(c);
  });
}
async function feedFromCard(c) {
  const box = c.closest('.scroller, .grid') || c.parentElement;
  const label = c.closest('.row')?.querySelector('h2')?.textContent.trim() || $('#view h1')?.textContent.trim() || '列表';
  let items = [...box.querySelectorAll('.card')].map(el => el === c || el.dataset.db === undefined ? [el, cardItems.get(el.dataset.site + '|' + el.dataset.id)] : null).filter(p => p && (p[0] === c || p[1]));
  let start = Math.max(0, items.findIndex(p => p[0] === c));
  items = items.map(p => p[1]);
  if (c.dataset.db !== undefined) {                       // 豆瓣 card: 先在源里找到这部
    const t = toast('正在打开沉浸播放…', true);
    try {
      const hit = await findTitle(c.dataset.db, new AbortController().signal);
      t.remove();
      if (!hit) return toast(`没找到「${c.dataset.db}」`);
      items[start] = hit;
    } catch (err) { t.remove(); if (!isAbort(err)) toast(err.message); return; }
  }
  items = items.filter(Boolean);
  if (!items.length) return;
  start = Math.min(start, items.length - 1);
  window.openFeed({ mode: 'list', items, start, label });
}
// 触感反馈: 安卓用 navigator.vibrate; iOS Safari 没有这个接口, 但 17.4+ 点一下 <input switch> 的标签会有系统触感, 借它用一下。
const haptic = (() => {
  let lab = null;
  return (ms = 18) => {
    try { if (navigator.vibrate && navigator.vibrate(ms)) return; } catch {}
    try {
      if (!lab) {
        lab = document.createElement('label');
        lab.setAttribute('aria-hidden', 'true');
        lab.style.cssText = 'position:fixed;left:-99px;top:-99px;width:1px;height:1px;opacity:0;pointer-events:none';
        lab.innerHTML = '<input type="checkbox" switch tabindex="-1">';
        document.body.append(lab);
      }
      lab.click();
    } catch {}
  };
})();
window.haptic = haptic;
const cardOf = e => e.target.closest?.('#view .card');
document.addEventListener('contextmenu', e => {
  const c = cardOf(e); if (!c || e.target.closest('.rm')) return;
  e.preventDefault();
  openCardMenu(c, e.clientX, e.clientY);
});
document.addEventListener('touchstart', e => {
  clearTimeout(lpT);
  if (e.touches.length !== 1) return;
  const c = cardOf(e); if (!c || e.target.closest('.rm')) return;
  const t = e.touches[0]; lpXY = [t.clientX, t.clientY];
  lpT = setTimeout(() => {
    lpFired = Date.now();
    haptic();
    openCardMenu(c, 0, 0, true);
  }, 500);
}, { passive: true });
document.addEventListener('touchmove', e => {
  if (!lpT) return;
  const t = e.touches[0];
  if (Math.hypot(t.clientX - lpXY[0], t.clientY - lpXY[1]) > 10) clearTimeout(lpT);
}, { passive: true });
for (const ev of ['touchend', 'touchcancel']) document.addEventListener(ev, () => clearTimeout(lpT), { passive: true });
// 长按松手后浏览器会补一个 click: 吞掉, 不然会打开详情
document.addEventListener('click', e => {
  if (Date.now() - lpFired < 700 && cardOf(e)) { e.preventDefault(); e.stopImmediatePropagation(); lpFired = 0; }
}, true);
// 手机浮窗只由遮罩的 click 收起: 在 pointerdown 就收的话, 随后的 click 会穿透到背后的卡片
document.addEventListener('pointerdown', e => { if (ctxEl && !ctxSheet && !e.target.closest('.ctxm')) closeCardMenu(); }, true);
addEventListener('scroll', () => { if (!ctxSheet) closeCardMenu(); }, true);
sheetScrim.addEventListener('click', e => { if (!ctxSheet) return; e.preventDefault(); e.stopPropagation(); if (Date.now() - ctxAt > 400) closeCardMenu(); });   // 长按松手补的那一下 click 不算
// 排序浮窗 (手机): 选项取自隐藏的 select，选中后写回 select 并触发它的 change，页面逻辑不用区分手机 / 桌面
function openSortSheet(btn) {
  const sel = document.getElementById(btn.dataset.for); if (!sel) return;
  closeCardMenu();
  ctxAt = Date.now();
  const m = ctxEl = document.createElement('div');
  m.className = 'ctxm csheet ssheet';
  m.setAttribute('role', 'listbox');
  m.innerHTML = `<div class="chead">排序</div>${[...sel.options].map(o => `<button type="button" role="option" data-v="${esc(o.value)}" class="${o.value === sel.value ? 'on' : ''}">${esc(o.textContent)}</button>`).join('')}`;
  document.body.append(m);
  ctxSheet = true; sheetScrim.hidden = false; document.body.classList.add('sheet-open', 'card-sheet');
  m.addEventListener('click', e => {
    const b = e.target.closest('[data-v]'); if (!b) return;
    e.stopPropagation();
    closeCardMenu();
    if (sel.value === b.dataset.v) return;
    sel.value = b.dataset.v;
    btn.textContent = sel.selectedOptions[0].textContent;
    sel.dispatchEvent(new Event('change'));
  });
}
document.addEventListener('click', e => { const b = e.target.closest('.ssort .sbtn'); if (b) openSortSheet(b); });
addEventListener('resize', () => { if (!ctxSheet) closeCardMenu(); });
addEventListener('keydown', e => { if (e.key === 'Escape') closeCardMenu(); });
const cardItems = new Map();
// 卡片菜单「影片播放」: no detail sheet. Resumes where this title was left (or starts at the first episode).
async function playDirect(c) {
  const t = toast('正在打开播放…', true);
  try {
    let site = c.dataset.site, id = c.dataset.id;
    if (c.dataset.db !== undefined) {                       // 豆瓣 card: find the title in our sources first
      const hit = await findTitle(c.dataset.db, new AbortController().signal);
      if (!hit) { t.remove(); return toast(`没找到「${c.dataset.db}」`); }
      ({ site, id } = hit);
    }
    const d = await api('detail', { site, id }, null);
    t.remove();
    if (!d.lines?.length) return openDetail(site, id);      // nothing playable here: show the sheet with the other sources
    const h = hist.get(site, id), line = h && d.lines[h.line] ? h.line : 0;
    play(d, line, h && h.line === line && d.lines[line].episodes[h.ep] ? h.ep : 0);
  } catch (err) { t.remove(); if (!isAbort(err)) toast(err.message); }
}
// 豆瓣 card → the same title in our sources. Hits are kept in an LRU (30 min), and identical lookups already
// in flight share one request. The "finding…" toast stays until it is found, failed, timed out (20 s),
// or the page was left.
const FIND_MAX = 100, FIND_TTL = 30 * 60e3, FIND_TIMEOUT = 20e3;
const findLru = new Map(), findBusy = new Map();
const findGet = k => {
  const e = findLru.get(k);
  if (!e) return null;
  findLru.delete(k);
  if (Date.now() - e.at > FIND_TTL || !state.sites.some(s => s.key === e.hit.site)) return null;
  findLru.set(k, e); // most recently used goes last
  return e.hit;
};
const findPut = (k, hit) => { findLru.delete(k); findLru.set(k, { hit, at: Date.now() }); if (findLru.size > FIND_MAX) findLru.delete(findLru.keys().next().value); };
async function findTitle(name, signal) {
  const k = normName(name);
  const cached = findGet(k);
  if (cached) return cached;
  if (!findBusy.has(k)) {
    const p = api('search', { wd: name }, null).then(j => {
      const hit = j.results.find(r => r.name === name) || j.results.find(r => normName(r.name) === k) || null;
      if (hit) findPut(k, { site: hit.site, id: hit.id });
      return hit;
    }).finally(() => findBusy.delete(k));
    findBusy.set(k, p);
  }
  // The shared request itself isn't cancelled; each caller just stops waiting.
  return Promise.race([findBusy.get(k), new Promise((_, bad) => signal.addEventListener('abort', () => bad(signal.reason || new DOMException('aborted', 'AbortError')), { once: true }))]);
}
async function openByName(name) {
  const t = toast(`在所有源里找「${name}」…`, true);
  const ctl = new AbortController(), page = pageCtl.signal;
  const timer = setTimeout(() => ctl.abort(new DOMException('timeout', 'TimeoutError')), FIND_TIMEOUT);
  const onLeave = () => ctl.abort(new DOMException('left', 'AbortError'));
  page.addEventListener('abort', onLeave, { once: true });
  try {
    const hit = await findTitle(name, ctl.signal);
    t.remove();
    if (hit) openDetail(hit.site, hit.id); else { toast(`没找到「${name}」，已转到搜索`); location.hash = '#/search/' + encodeURIComponent(name); }
  } catch (e) {
    t.remove();
    if (e?.name === 'TimeoutError') toast(`找「${name}」超时了，可以稍后再点一次`);
    else if (e?.name !== 'AbortError') toast(`找「${name}」失败：${e.message}`);
  } finally {
    clearTimeout(timer);
    page.removeEventListener('abort', onLeave);
  }
}
const normName = s => String(s || '').replace(/[\s·:：\-—!！,，.。]/g, '').toLowerCase();
function row(title, items, href, sub, opts = {}) {
  return `<section class="row"${opts.rk ? ` data-rk="${esc(opts.rk)}"` : ''}><h2>${href ? `<a href="${href}">${esc(title)}</a>` : esc(title)}${opts.extra || ''}</h2>
    <div class="track"><button class="arrow l">‹</button>
    <div class="scroller">${items.map(it => card(it, { sub: sub?.(it), removable: opts.removable })).join('')}</div>
    <button class="arrow r">›</button></div></section>`;
}
document.addEventListener('click', e => {
  const a = e.target.closest('#view .arrow'); if (!a) return;
  const sc = a.parentElement.querySelector('.scroller');
  sc.scrollBy({ left: (a.classList.contains('l') ? -1 : 1) * sc.clientWidth * 0.9 });
});

// ---------- home ----------
const catsRow = cats => cats.length ? `<section class="row" data-rk="cats"><h2>全部分类</h2><div class="chips">${cats.map(c => `<a class="chip" href="#/cat/${encodeURIComponent(c.id)}/${encodeURIComponent(c.name)}">${esc(c.name)}</a>`).join('')}</div></section>` : '';
// 把 el 换成新内容，横向滚动的位置保留，新卡片接上评分 / 封面的懒加载
function swapRow(el, html) {
  const sc = el.querySelector('.scroller'), left = sc ? sc.scrollLeft : 0;
  const tmp = document.createElement('div'); tmp.innerHTML = html;
  const nu = tmp.firstElementChild;
  if (!nu) return el.remove();
  el.replaceWith(nu);
  const ns = nu.querySelector('.scroller'); if (ns) ns.scrollLeft = left;
  observeRatings(nu); observeJav(nu);
}
async function renderHome() {
  if (!keepView) view.innerHTML = `<div class="page pageload">${spinner}</div>`;
  const site = state.site;
  const [latest, cats] = await Promise.all([api('list', { site }),
    state.cats.length ? { categories: state.cats } : api('categories', { site }).catch(() => ({ categories: [] }))]);
  state.cats = cats.categories;
  const sig = pageCtl.signal;
  const cont = hist.list().filter(h => state.sites.some(s => s.key === h.site)).slice(0, 20);
  const favList = favs.list().filter(f => state.sites.some(s => s.key === f.site)).slice(0, 30);
  const kids = state.level === 'kids';
  const own = site === 'local' || !!PV; // 本地媒体 / 预览: the source's own content only, no 豆瓣
  const adultSite = !!state.sites.find(x => x.key === site)?.adult; // 成人源: no 豆瓣 rows either
  view.innerHTML = `
    <div class="hero" id="hero"></div>
    <div class="rows">
      ${cont.length ? row('继续观看', cont, '#/history', it => `${it.siteName} · ${it.epName || ''}`,
        { removable: 'hist', extra: '<button class="hclear" data-clear="hist">清空</button>' }) : ''}
      ${!kids && favList.length ? row('我的收藏', favList, '#/favorites', it => it.siteName, { removable: 'fav' }) : ''}
      ${row(kids ? '少儿精选' : '最新更新', latest.list, '#/cat//' + encodeURIComponent(kids ? '少儿精选' : '最新更新'), undefined, { rk: 'latest' })}
      <div id="dbRows"></div>
      <div id="more"></div>
      ${catsRow(state.cats)}
    </div>`;
  hero(latest.list.slice(0, 6));
  observeRatings(view); observeJav(view);
  // revalidate 发现新内容：只换对应的那一行（最新更新 + 轮播 / 分类行 / 豆瓣行 / 分类标签），其余不动
  const builders = new Map([['latest', b => row(kids ? '少儿精选' : '最新更新', b.list, '#/cat//' + encodeURIComponent(kids ? '少儿精选' : '最新更新'), undefined, { rk: 'latest' })]]);
  swrWatch((route, p, body) => {
    if (site !== state.site) return;
    let k = '';
    if (route === 'list' && p.site === site && !p.pg) k = p.t ? 't:' + p.t : 'latest';
    else if (route === 'douban/hot') k = 'db:' + p.type;
    else if (route === 'categories' && p.site === site) { state.cats = body.categories; builders.set('cats', b => catsRow(b.categories)); k = 'cats'; }
    const build = builders.get(k); if (!build) return;
    const el = [...view.querySelectorAll('[data-rk]')].find(x => x.dataset.rk === k); if (!el) return;
    swapRow(el, build(body));
    if (k === 'latest') { clearInterval(heroTimer); hero(body.list.slice(0, 6)); }
  });
  if (!kids && !own && !adultSite) {
    // Which 豆瓣 rows to show is a per-browser setting (设置 → 首页豆瓣分类); only the enabled ones are fetched.
    const on = dbRows(), kinds = DB_ROWS.filter(([k]) => on[k]);
    Promise.all(kinds.map(([k]) => api('douban/hot', { type: k }).catch(() => ({ list: [] })))).then(res => {
      if (sig.aborted || !$('#dbRows')) return;
      kinds.forEach(([k, title]) => builders.set('db:' + k, b => b.list.length ? row(title, b.list.map(x => ({ ...x, douban: 1 })), '#/charts', undefined, { rk: 'db:' + k }) : ''));
      $('#dbRows').innerHTML = kinds.map(([k], i) => res[i].list.length ? builders.get('db:' + k)(res[i]) : '').join('');
    });
  }
  const isWhitelisted = kids || own || state.cats.length <= 8;
  const wanted = isWhitelisted ? state.cats.slice(0, own ? 20 : 8) : ROWS.map(w => state.cats.find(c => w.split('|').includes(c.name))).filter(Boolean);
  const lists = await Promise.all(wanted.map(c => api('list', { site, t: c.id }).catch(() => ({ list: [] }))));
  if (sig.aborted || site !== state.site || !$('#more')) return;
  $('#more').innerHTML = wanted.map((c, i) => lists[i].list.length ? row(c.name, lists[i].list, `#/cat/${encodeURIComponent(c.id)}/${encodeURIComponent(c.name)}`) : '').join('');
  observeRatings($('#more'));
  observeJav($('#more'));
}

function hero(items) {
  const el = $('#hero'); if (!el || !items.length) return;
  let i = 0;
  const show = () => {
    const it = items[i];
    el.innerHTML = `<div class="bg" style="${bg(dbSize(it.pic, 's') || it.pic)}"></div><div class="poster" style="${bgHi(it.pic)}"></div>
      <div class="info"><h1>${esc(it.name)}</h1>
        <div class="meta"><span class="dbtag" hidden></span>${esc([it.year, it.area, it.type, it.remarks].filter(x => x && x !== '0').join('  ·  '))}</div>
        <p>${esc(it.blurb)}</p>
        <div class="btns"><button class="btn play">▶ 播放</button><button class="btn more">ⓘ 详情</button></div></div>
      <div class="dots">${items.map((_, k) => `<i class="${k === i ? 'on' : ''}" data-k="${k}"></i>`).join('')}</div>`;
    el.querySelector('.play').onclick = () => openDetail(it.site, it.id, true);
    el.querySelector('.more').onclick = () => openDetail(it.site, it.id);
    $$('.dots i', el).forEach(d => d.onclick = () => { i = +d.dataset.k; show(); });
    const dbTag = r => { if (items[i] !== it) return; const t = el.querySelector('.dbtag'); if (t && r.rate) { t.textContent = '豆瓣 ' + r.rate; t.hidden = false; } };
    if (isJav(it)) {
      const code = javCode(it.name);
      if (code) javMeta(code).then(r => {
        if (items[i] !== it) return;
        if (r.found) {
          const p = el.querySelector('.poster'); if (p && r.cover && javCoverWanted(it)) p.style.cssText = bgLayers(it.pic, r.cover, 'l');
          const t = el.querySelector('.dbtag'); if (t) { t.textContent = r.score ? 'JAVDB ' + r.score : ''; t.hidden = !r.score; }
        } else dbRate(it.name, it.year).then(dbTag);
      });
      else dbRate(it.name, it.year).then(dbTag);
    } else dbRate(it.name, it.year).then(r => {
      if (items[i] !== it) return; // the slide has moved on
      const t = el.querySelector('.dbtag'); if (t && r.rate) { t.textContent = '豆瓣 ' + r.rate; t.hidden = false; }
      const p = el.querySelector('.poster'); if (p && r.pic) p.style.cssText = bgLayers(it.pic, r.pic, 'l');
    });
  };
  show();
  heroTimer = setInterval(() => { if (!document.hidden && $('#player').hidden && !$('#modal')) { i = (i + 1) % items.length; show(); } }, 8000);
}

// ---------- watch history ----------
function renderHistory() {
  const list = hist.list();
  const names = Object.fromEntries(state.sites.map(s => [s.key, s.name]));
  view.innerHTML = `<div class="page"><div class="pagehead"><h1>观看历史</h1>
      ${list.length ? `<button class="small ibs feedgo" data-feed="hist" title="沉浸观看" aria-label="沉浸观看">${IC.feed}</button><button class="small ibs" data-clear="hist" title="清空全部" aria-label="清空全部">${IC.trash}</button>` : ''}</div>
    <p class="empty hempty" ${list.length ? 'hidden' : ''}>还没有观看记录。</p>
    ${list.length ? `<div class="grid">${list.map(it => card(it, { removable: 'hist', sub: `${names[it.site] || it.siteName} · ${it.epName || ''}` })).join('')}</div>` : ''}</div>`;
  observeRatings(view);
  observeJav(view);
}
function renderFavorites() {
  if (kidsMode()) { view.innerHTML = '<div class="page"><h1>我的收藏</h1><p class="empty">儿童模式下收藏不可见。</p></div>'; return; }
  const list = favs.list();
  view.innerHTML = `<div class="page"><div class="pagehead"><h1>我的收藏</h1>
      ${list.length ? `<button class="small ibs feedgo" data-feed="fav" title="沉浸观看" aria-label="沉浸观看">${IC.feed}</button><button class="small ibs" data-clear="fav" title="清空全部" aria-label="清空全部">${IC.trash}</button>` : ''}</div>
    <p class="empty hempty" ${list.length ? 'hidden' : ''}>还没有收藏。打开影片，点封面页的「♡」。</p>
    ${list.length ? `<div class="grid">${list.map(it => card(it, { removable: 'fav', sub: [it.siteName, it.type].filter(Boolean).join(' · ') })).join('')}</div>` : ''}</div>`;
  observeRatings(view);
}
document.addEventListener('click', e => {
  const b = e.target.closest('#view [data-clear]'); if (!b) return;
  e.preventDefault();
  const fav = b.dataset.clear === 'fav';
  if (!confirm(fav ? '清空全部收藏？' : '清空全部观看历史？')) return;
  (fav ? favs : hist).clear();
  toast(fav ? '收藏已清空' : '观看历史已清空');
  route();
});

// ---------- people (演员 / 导演) ----------
async function renderPerson(role, name, scopeKey = '') {
  const label = role === 'director' ? '导演' : '演员';
  const scoped = scopeKey ? state.sites.find(s => s.key === scopeKey) : null;
  const head = `<h1>${esc(name)} <span class="role">${label}</span></h1>`;
  view.innerHTML = `<div class="page">${head}<p class="lan">在 ${scoped ? `「${esc(scoped.name)}」` : `${searchableCount()} 个源`}里找作品…</p>${spinner}</div>`;
  const j = await api('person', { name, role, ...(scoped ? { site: scoped.key } : {}) });
  const names = Object.fromEntries(state.sites.map(s => [s.key, s.name]));
  const curName = names[scoped ? scoped.key : state.site] || '当前源';
  const cards = () => {
    const groups = searchMerge.on() ? mergeDupes(j.list) : j.list.map(it => ({ main: it, srcs: [it] }));
    const html = groups.map(g => {
      const srcs = [...new Set(g.srcs.map(x => x.site))];
      return card(g.main, { sub: [g.main.year, g.main.type, srcs.length > 1 ? `${srcs.length} 个源` : g.main.siteName].filter(x => x && x !== '0').join(' · '),
        dup: srcs.length });
    }).join('');
    return { html, shown: groups.length };
  };
  const status = shown => j.list.length ? `${shown} 部作品 · 按年份排序` : '';
  const first = cards();
  view.innerHTML = `<div class="page">${head}
    <div class="stool">
      <div class="sseg" role="group" aria-label="搜索范围"><button type="button" data-sc="all" class="${scoped ? '' : 'on'}">全部源</button><button type="button" data-sc="site" class="${scoped ? 'on' : ''}" title="${esc(curName)}"><span>当前源</span></button></div>
      <label class="swt" title="同名同年的影片只显示一张，点开后在「其他源」里切换"><input type="checkbox" id="sMerge" ${searchMerge.on() ? 'checked' : ''}><i></i><span>合并同名资源</span></label>
      <span class="lan" id="sStatus">${status(first.shown)}</span>
    </div>
    ${j.list.length ? `<div class="grid" id="sGrid">${first.html}</div>`
      : `<p class="empty">${scoped ? `「${esc(scoped.name)}」里没找到。` : '各源都没搜到。'}部分源的搜索只按片名匹配，不认演员。${scoped ? ' <a href="#" id="sAll"><u>改成在全部源里找</u></a>' : ''}</p>`}</div>`;
  const go = sc => { searchScope.set(sc); location.hash = personHash(role, name, sc); };
  $$('.sseg [data-sc]', view).forEach(b => b.onclick = () => { if ((b.dataset.sc === 'site') !== !!scoped) go(b.dataset.sc); });
  const all = $('#sAll', view); if (all) all.onclick = e => { e.preventDefault(); go('all'); };
  $('#sMerge', view).onchange = e => {
    searchMerge.set(e.target.checked);
    const c = cards(); const g = $('#sGrid', view); if (g) g.innerHTML = c.html;
    $('#sStatus', view).innerHTML = status(c.shown);
    observeRatings(view);
  };
  observeRatings(view);
}

// ---------- 排序 (分类页 / 搜索页) ----------
// 只在浏览器里排：CMS 的 list 接口没有统一的排序参数 (实测源站会忽略 by=)，源站默认顺序就是更新时间倒序。
const SORTS = {
  time: ['最近更新', (a, b) => (b.time || '').localeCompare(a.time || '')],
  year: ['年份', (a, b) => (parseInt(b.year) || 0) - (parseInt(a.year) || 0) || (b.time || '').localeCompare(a.time || '')],
  quality: ['画质', (a, b) => (Q_RANK[b.quality] ?? -1) - (Q_RANK[a.quality] ?? -1)],
  name: ['名称', (a, b) => (a.name || '').localeCompare(b.name || '', 'zh')],
};
// '' = 不排序 (保持原顺序)
const sortPref = (key, allowed) => ({ get: () => allowed.includes(localStorage[key]) ? localStorage[key] : '', set(v) { localStorage[key] = v; } });
// 桌面: 原生下拉。手机 (≤760px): 同一个 select 藏起来当数据源，露出一个按钮，点开是底部上拉浮窗 (openSortSheet)
const sortSelect = (id, cur, first, keys, tip) => `<div class="ssort" title="${esc(tip)}"><span>排序</span><select id="${id}"><option value="">${first}</option>${keys.map(k => `<option value="${k}"${k === cur ? ' selected' : ''}>${SORTS[k][0]}</option>`).join('')}</select><button type="button" class="sbtn" data-for="${id}" aria-haspopup="listbox">${esc(cur ? SORTS[cur][0] : first)}</button></div>`;
const catSort = sortPref('catSort', ['time', 'year', 'name']);

// ---------- category grid (infinite scroll) ----------
async function renderCategory(t, name, siteKey) {
  const site = state.sites.some(x => x.key === siteKey) ? siteKey : state.site;
  const other = site !== state.site ? state.sites.find(x => x.key === site)?.name : '';
  let mode = catSort.get();
  const base = [];                                         // everything loaded so far, in load order
  const order = list => mode ? [...list].sort(SORTS[mode][1]) : list;
  const head = `<div class="page"><div class="pagehead"><h1>${esc(name || '全部')}${other ? ` <span class="role">${esc(other)}</span>` : ''}</h1><button class="small ibs feedgo" data-feed="cat" data-t="${esc(t || '')}" data-name="${esc(name || '全部')}" data-site="${esc(site)}" title="沉浸观看" aria-label="沉浸观看">${IC.feed}</button></div><div class="stool">${sortSelect('cSort', mode, '默认', ['time', 'year', 'name'], '只对已加载的内容排序；继续下滑加载的新内容在各自这一批里排序')}</div><div class="grid" id="grid"></div><div id="tail">${spinner}</div></div>`;
  let pg = 0, count = 1, busy = false;
  const seen = new Set();
  const sk = history.state?.sk;
  const wantPages = keepView && sk ? Math.max(1, Math.min(scrollMap[sk + '#p'] || 1, 12)) : 1;
  if (!keepView) view.innerHTML = head;
  else {                                                   // coming Back: fetch the pages seen before in parallel, paint once
    let js;
    try { js = await Promise.all(Array.from({ length: wantPages }, (_, i) => api('list', { site, t, pg: i + 1 }))); }
    catch (e) { if (isAbort(e)) return; js = null; }
    if (js && js[0]) {
      view.innerHTML = head;
      const g = $('#grid');
      for (const j of js) {
        pg = j.page; count = j.pagecount;
        base.push(...j.list.filter(it => !seen.has(it.id) && seen.add(it.id)));
      }
      g.insertAdjacentHTML('beforeend', order(base).map(it => card(it)).join(''));
      observeRatings(g); observeJav(g);
      $('#tail').innerHTML = pg >= count ? (seen.size ? '' : '<div class="empty">这个分类是空的</div>') : spinner;
    } else view.innerHTML = head;
  }
  const more = async () => {
    if (busy || pg >= count || !$('#grid')) return;
    busy = true;
    const j = await api('list', { site, t, pg: pg + 1 });
    pg = j.page; count = j.pagecount;
    if (sk) saveScroll(sk + '#p', pg);                      // how deep this entry was, so Back can rebuild it at once
    const fresh = j.list.filter(it => !seen.has(it.id) && seen.add(it.id));
    base.push(...fresh);
    $('#grid')?.insertAdjacentHTML('beforeend', order(fresh).map(it => card(it)).join(''));
    if ($('#grid')) { observeRatings($('#grid')); observeJav($('#grid')); }
    if (pg >= count && $('#tail')) $('#tail').innerHTML = seen.size ? '' : '<div class="empty">这个分类是空的</div>';
    busy = false;
    // IntersectionObserver only reports changes: a tail that is still near (tall window, restored scroll position)
    // would never be reported again, so keep filling until it is out of reach.
    const tailEl = $('#tail');
    if (tailEl && pg < count && tailEl.getBoundingClientRect().top < innerHeight + 600) setTimeout(() => more().catch(() => { busy = false; }), 0);
  };
  $('#cSort', view).onchange = e => {
    mode = e.target.value; catSort.set(mode);
    const g = $('#grid'); if (!g) return;
    g.innerHTML = order(base).map(it => card(it)).join('');
    observeRatings(g); observeJav(g);
  };
  if (!pg) await more();
  else if (pg < count) { const tailEl = $('#tail'); if (tailEl && tailEl.getBoundingClientRect().top < innerHeight + 600) await more(); }
  const sig = pageCtl.signal;
  // revalidate：第一页有新片，插到网格最前面（已有的不动；页面滚到下面时补偿高度，不跳）
  swrWatch((route, p, body) => {
    if (route !== 'list' || p.site !== site || (p.t || '') !== (t || '') || String(p.pg) !== '1') return;
    const g = $('#grid'); if (!g) return;
    const nu = body.list.filter(it => !seen.has(it.id) && seen.add(it.id)); if (!nu.length) return;
    const h = view.scrollHeight;
    base.unshift(...nu);
    g.insertAdjacentHTML('afterbegin', order(nu).map(it => card(it)).join(''));
    if (view.scrollTop > 0) view.scrollTop += view.scrollHeight - h;
    observeRatings(g); observeJav(g);
  });
  // Scroll-driven (not IntersectionObserver): a restored / programmatic scroll can move the tail into reach in the same
  // frame the grid grew, which an observer sees as "still intersecting" and never reports.
  let tick = 0;
  const onScroll = () => {
    if (tick) return;
    tick = requestAnimationFrame(() => {
      tick = 0;
      const t = $('#tail');
      if (t && !busy && pg < count && t.getBoundingClientRect().top < innerHeight + 600) more().catch(() => { busy = false; });
    });
  };
  view.addEventListener('scroll', onScroll, { passive: true });
  sig.addEventListener('abort', () => { view.removeEventListener('scroll', onScroll); cancelAnimationFrame(tick); });
}

// ---------- search (all sources) ----------
// Every title that matched (by name, or because a site's search also matched its 演员/导演), then the
// matching people as name tags that open their filmography.
const searchMerge = { on: () => localStorage.searchMerge !== '0', set(v) { localStorage.searchMerge = v ? '1' : '0'; } };
// Same title on several sources → one result. Same name (ignoring spaces / punctuation) and compatible year (equal, or one
// side unknown). The first one in ranking order is the face of the group; it borrows a cover / remarks / year if it lacks them.
function mergeDupes(list) {
  const byName = new Map(), out = [];
  for (const it of list) {
    const k = normName(it.name) || it.name;
    if (!byName.has(k)) byName.set(k, []);
    const g = byName.get(k).find(g => !g.main.year || !it.year || g.main.year === it.year);
    if (!g) { const n = { main: { ...it }, srcs: [it] }; byName.get(k).push(n); out.push(n); continue; }
    g.srcs.push(it);
    for (const f of ['pic', 'remarks', 'year', 'quality']) if (!g.main[f] && it[f]) g.main[f] = it[f];
  }
  return out;
}
async function renderSearch(q, scopeKey = '') {
  $('#q').value = q;
  const scoped = scopeKey ? state.sites.find(s => s.key === scopeKey) : null;
  const nSrc = scoped ? (scoped.members?.length || 1) : searchableCount();
  view.innerHTML = `<div class="page"><h1>“${esc(q)}”</h1><p class="lan">${scoped ? `正在「${esc(scoped.name)}」里搜索` : `正在搜索全部 ${nSrc} 个源`}（片名 / 演员 / 导演）…</p>${spinner}</div>`;
  const j = await api('search', { wd: q, ...(scoped ? { site: scoped.key } : {}) });
  const names = Object.fromEntries(state.sites.map(s => [s.key, s.name]));
  const order = Object.fromEntries(state.sites.map((s, i) => [s.key, i]));
  const nq = normName(q);
  const rank = it => it.name === q ? 0 : normName(it.name).includes(nq) ? 1 : 2;
  const res = j.results.sort((a, b) => rank(a) - rank(b) || order[a.site] - order[b.site]);
  const people = [...(j.actor || []).map(p => ({ ...p, role: 'actor', label: '演员' })), ...(j.director || []).map(p => ({ ...p, role: 'director', label: '导演' }))]
    .sort((a, b) => (b.name === q) - (a.name === q) || (b.count ?? b.list?.length ?? 0) - (a.count ?? a.list?.length ?? 0));
  const curName = names[scoped ? scoped.key : state.site] || '当前源';
  const sub = g => {
    const sites = [...new Set(g.srcs.map(x => names[x.site] || x.siteName))];
    return sites.length > 1 ? `${sites.length} 个源` : sites[0];
  };
  const searchSort = sortPref('searchSort', ['time', 'year', 'quality', 'name']);
  const cards = () => {
    let groups = searchMerge.on() ? mergeDupes(res) : res.map(it => ({ main: it, srcs: [it] }));
    const mode = searchSort.get();
    if (mode) {                                            // a merged title is as new as its newest source
      const rep = g => ({ ...g.main, time: g.srcs.reduce((m, x) => (x.time || '') > m ? x.time : m, '') });
      groups = groups.map(g => [g, rep(g)]).sort((a, b) => SORTS[mode][1](a[1], b[1])).map(x => x[0]);
    }
    const html = groups.map(g => {
      const n = new Set(g.srcs.map(x => x.site)).size;
      return card(g.main, { sub: sub(g), dup: n });
    }).join('');
    return { html, shown: groups.length };
  };
  const status = shown => [`${shown} 部影片`, people.length ? `${people.length} 位演职员` : '', j.failed.length ? `<span title="${esc(j.failed.join('、'))}">${j.failed.length} 个源未响应</span>` : ''].filter(Boolean).join(' · ');
  const first = cards();
  view.innerHTML = `<div class="page"><div class="pagehead"><h1>“${esc(q)}”</h1>${res.length ? `<button class="small ibs feedgo" data-feed="search" data-q="${esc(q)}" data-scope="${esc(scoped ? scoped.key : '')}" title="沉浸观看" aria-label="沉浸观看">${IC.feed}</button>` : ''}</div>
    <div class="stool">
      <div class="sseg" role="group" aria-label="搜索范围"><button type="button" data-sc="all" class="${scoped ? '' : 'on'}">全部源</button><button type="button" data-sc="site" class="${scoped ? 'on' : ''}" title="${esc(curName)}"><span>当前源</span></button></div>
      <label class="swt" title="同名同年的影片只显示一张，点开后在「其他源」里切换"><input type="checkbox" id="sMerge" ${searchMerge.on() ? 'checked' : ''}><i></i><span>合并同名资源</span></label>
      ${res.length ? sortSelect('sSort', searchSort.get(), '相关性', ['time', 'year', 'quality', 'name'], '换个顺序看搜索结果') : ''}
      <span class="lan" id="sStatus">${status(first.shown)}</span>
    </div>
    ${res.length ? `<div class="grid" id="sGrid">${first.html}</div>` : `<div class="empty">${scoped ? `「${esc(scoped.name)}」里没有匹配的影片。` : '没有影片匹配，换个关键词（片名、演员或导演）。'}${scoped ? ' <a href="#" id="sAll"><u>改成在全部源里搜</u></a>' : ''}</div>`}
    ${people.length ? `<h2 class="rtitle">演员 / 导演</h2><div class="ptags">${people.map(p =>
      `<a class="ptag" href="${personHash(p.role, p.name, scoped ? 'site' : 'all')}"><b>${esc(p.name)}</b><span>${p.label} · ${p.count ?? p.list?.length ?? 0} 部</span></a>`).join('')}</div>` : ''}</div>`;
  $$('.sseg [data-sc]', view).forEach(b => b.onclick = () => {
    const sc = b.dataset.sc; if ((sc === 'site') === !!scoped) return;
    searchScope.set(sc); location.hash = searchHash(q, sc);
  });
  const all = $('#sAll', view); if (all) all.onclick = e => { e.preventDefault(); searchScope.set('all'); location.hash = searchHash(q, 'all'); };
  const refresh = () => {
    const c = cards(); const g = $('#sGrid', view); if (g) g.innerHTML = c.html;
    $('#sStatus', view).innerHTML = status(c.shown);
    observeRatings(view); observeJav(view);
  };
  $('#sMerge', view).onchange = e => { searchMerge.set(e.target.checked); refresh(); };
  const ss = $('#sSort', view); if (ss) ss.onchange = e => { searchSort.set(e.target.value); refresh(); };
  observeRatings(view);
  observeJav(view);
}

// ---------- 榜单 (豆瓣) ----------
// #/charts                                   精选榜单: Top 10 rows of each 豆瓣 collection
// #/charts/c/<id>                            one collection, full ranked list
// #/charts/genre/<type>/<interval>           类型排行 (movie.douban.com/typerank)
// #/charts/year/<kind>/<year>/<genre>/<region>/<sort>   年度榜 (豆瓣 选影视); empty segment = 全部
let chartCat = null;
const chartHref = (...p) => '#/charts/' + p.map(x => encodeURIComponent(x ?? '')).join('/');
const fmtVotes = v => v >= 1e4 ? (v / 1e4).toFixed(v >= 1e5 ? 0 : 1) + '万' : String(v);
const fmtAgo = t => { const m = Math.round((Date.now() - t) / 60e3); return m < 2 ? '刚刚' : m < 60 ? m + ' 分钟前' : m < 1440 ? Math.round(m / 60) + ' 小时前' : Math.round(m / 1440) + ' 天前'; };
const pianName = n => /片$|电影$|剧$/.test(n) ? n : n + '片';

function rankRow(it, n) {
  return `<div class="rk"><a class="rmain" href="#/find/${encodeURIComponent(it.name)}" data-db="${esc(it.name)}" title="在所有源里找「${esc(it.name)}」">
      <span class="no ${n <= 3 ? 'hi' : ''}">${n}</span>
      <div class="rimg">${it.pic ? posterImg(it.pic, '') : ''}</div>
      <div class="rinfo"><div class="rt">${esc(it.name)}${it.year ? `<span>${esc(it.year)}</span>` : ''}</div>
        <div class="rs">${it.rate ? `<i class="stars" style="--v:${Number(it.rate)}"></i><b>${esc(it.rate)}</b>` : '<span>暂无评分</span>'}${it.votes ? `<span>${fmtVotes(it.votes)}人评价</span>` : ''}${it.remarks ? `<span>${esc(it.remarks)}</span>` : ''}</div>
        <div class="rsub">${esc(it.sub)}</div>${it.desc ? `<div class="rq">“${esc(it.desc)}”</div>` : ''}</div></a>
    <a class="rdb" href="https://movie.douban.com/subject/${encodeURIComponent(it.id)}/" target="_blank" rel="noreferrer" title="在豆瓣打开">豆瓣 ↗</a></div>`;
}
document.addEventListener('click', e => {
  const a = e.target.closest('#view .rmain'); if (!a || !plainClick(e)) return;
  e.preventDefault(); openByName(a.dataset.db);
});

// Ranked list with infinite scroll. Numbers come from 豆瓣 when it ranks (collections, typerank), else by order.
async function rankList(params) {
  let start = 0, end = false, busy = false, n = 0;
  const sig = pageCtl.signal;
  const tail = $('#tail');
  const more = async () => {
    if (busy || end || !$('#rlist')) return;
    busy = true;
    try {
      const j = await api('douban/chart', { ...params, start });
      start = j.next; end = !!j.end;
      if (j.floor && $('#floor')) $('#floor').textContent = `只算评价人数 ≥ ${fmtVotes(j.floor)} 的，免得几百人打分的冷门片冲到榜首`;
      if (j.updated && $('#updated')) $('#updated').textContent = '· 更新于 ' + fmtAgo(j.updated);
      $('#rlist').insertAdjacentHTML('beforeend', j.list.map(it => rankRow(it, it.rank || ++n)).join(''));
      if (j.list.length) n = Math.max(n, j.list[j.list.length - 1].rank || 0);
    } catch (e) {
      if (isAbort(e)) return;
      end = true;
      if (tail) tail.innerHTML = `<div class="err">豆瓣没响应：${esc(e.message)}</div>`;
      return;
    } finally { busy = false; }
    if (end && tail) tail.innerHTML = $('#rlist .rk') ? '<div class="empty rend">— 到底了 —</div>' : '<div class="empty">没有符合条件的影片，放宽一下筛选</div>';
    // A page can come back short after filtering; keep going while the tail is still on screen.
    else if (tail && tail.getBoundingClientRect().top < innerHeight + 600) more();
  };
  await more();
  const io = new IntersectionObserver(es => { if (es[0].isIntersecting) more(); }, { rootMargin: '600px' });
  if (tail) io.observe(tail);
  sig.addEventListener('abort', () => io.disconnect());
}

function filterRow(label, opts) {
  return `<div class="frow"><b>${label}</b><div class="opts">${opts.map(([href, text, on]) => `<a href="${esc(href)}" class="${on ? 'on' : ''}">${esc(text)}</a>`).join('')}</div></div>`;
}

async function renderCharts() {
  if (kidsMode()) { view.innerHTML = '<div class="page"><h1>榜单</h1><p class="empty">儿童模式下榜单不可用。</p></div>'; return; }
  const [, , tab = '', ...p] = location.hash.split('/').map(s => { try { return decodeURIComponent(s); } catch { return s; } });
  view.innerHTML = `<div class="page">${spinner}</div>`;
  if (!chartCat) chartCat = await api('douban/charts');
  const C = chartCat;
  const cur = tab === 'c' ? '' : tab;
  const head = `<div class="pagehead"><h1>榜单</h1><div class="seg">${[['', '精选榜单'], ['genre', '类型排行'], ['year', '年度榜']].map(([k, n]) =>
    `<a href="#/charts${k ? '/' + k : ''}" class="${cur === k ? 'on' : ''}">${n}</a>`).join('')}</div><span class="lan">数据来自豆瓣，服务端每 3 小时自动刷新 · 点影片在所有源里找 <span id="updated"></span></span></div>`;

  if (tab === 'c') {
    const c = C.collections.find(x => x.id === p[0]) || C.collections[0];
    view.innerHTML = `<div class="page charts">${head}
      ${filterRow('榜单', C.collections.map(x => [chartHref('c', x.id), x.name, x.id === c.id]))}
      <h2 class="rtitle">${esc(c.name)} <span class="lan">${esc(c.desc)}</span></h2>
      <div class="rlist" id="rlist"></div><div id="tail">${spinner}</div></div>`;
    return rankList({ kind: 'collection', id: c.id });
  }

  if (tab === 'genre') {
    const g = C.genres.find(x => x.id === p[0]) || C.genres[0];
    const iv = C.intervals.find(x => x.id === p[1]) || C.intervals[0];
    view.innerHTML = `<div class="page charts">${head}
      <div class="filters">${filterRow('类型', C.genres.map(x => [chartHref('genre', x.id, iv.id), x.name, x.id === g.id]))}
        ${filterRow('排名', C.intervals.map(x => [chartHref('genre', g.id, x.id), x.name, x.id === iv.id]))}</div>
      <h2 class="rtitle">${esc(pianName(g.name))}排行榜 <span class="lan">豆瓣评分排在所有${esc(pianName(g.name))}的${esc(iv.name.replace(/^前 /, '前'))}</span></h2>
      <div class="rlist" id="rlist"></div><div id="tail">${spinner}</div></div>`;
    return rankList({ kind: 'genre', type: g.id, interval: iv.id });
  }

  if (tab === 'year') {
    const kind = C.kinds.some(k => k.id === p[0]) ? p[0] : 'movie';
    const year = p[1] === undefined ? C.years[0] : C.years.includes(p[1]) ? p[1] : '';
    const genre = C.explore[kind].includes(p[2]) ? p[2] : '';
    const region = C.regions.includes(p[3]) ? p[3] : '';
    const sort = C.sorts.some(s => s.id === p[4]) ? p[4] : 'S';
    const h = o => { const v = { kind, year, genre, region, sort, ...o }; if (o.kind && o.kind !== kind) v.genre = ''; return chartHref('year', v.kind, v.year, v.genre, v.region, v.sort); };
    const kindName = C.kinds.find(k => k.id === kind).name;
    const title = `${year || '历年'}${region ? ' · ' + region : ''}${genre ? ' · ' + genre : ''} ${kindName}${{ S: '高分榜', T: '综合榜', U: '热度榜', R: '新片' }[sort]}`;
    view.innerHTML = `<div class="page charts">${head}
      <div class="filters">${filterRow('类别', C.kinds.map(k => [h({ kind: k.id }), k.name, k.id === kind]))}
        ${filterRow('年份', [[h({ year: '' }), '全部', !year], ...C.years.map(y => [h({ year: y }), y, y === year])])}
        ${filterRow('类型', [[h({ genre: '' }), '全部', !genre], ...C.explore[kind].map(x => [h({ genre: x }), x, x === genre])])}
        ${filterRow('地区', [[h({ region: '' }), '全部', !region], ...C.regions.map(x => [h({ region: x }), x, x === region])])}
        ${filterRow('排序', C.sorts.map(s => [h({ sort: s.id }), s.name, s.id === sort]))}</div>
      <h2 class="rtitle">${esc(title)} <span class="lan" id="floor"></span></h2>
      <div class="rlist" id="rlist"></div><div id="tail">${spinner}</div></div>`;
    return rankList({ kind: 'explore', type: kind, year, genre, region, sort });
  }

  // 精选榜单: one Netflix-style Top 10 row per collection, then entry points to the other two.
  const skeleton = Array.from({ length: 6 }, (_, i) => `<div class="card top"><span class="num">${i + 1}</span><div class="img"></div><div class="name">&nbsp;</div></div>`).join('');
  view.innerHTML = `<div class="page charts chome">${head}</div>
    <div class="srows">${C.collections.map(c => `<section class="row" data-c="${esc(c.id)}"><h2><a href="${chartHref('c', c.id)}">${esc(c.name)}</a><small>${esc(c.desc)}</small></h2>
      <div class="track"><button class="arrow l">‹</button><div class="scroller">${skeleton}</div><button class="arrow r">›</button></div></section>`).join('')}
      <section class="row"><h2><a href="#/charts/genre">类型排行榜</a><small>好于同类 X% 的影片</small></h2><div class="chips">${C.genres.map(g => `<a class="chip" href="${chartHref('genre', g.id)}">${esc(g.name)}</a>`).join('')}</div></section>
      <section class="row"><h2><a href="#/charts/year">年度榜</a><small>按年份看高分电影 / 剧集 / 综艺</small></h2><div class="chips">${C.years.map(y => `<a class="chip" href="${chartHref('year', 'movie', y)}">${esc(y)}</a>`).join('')}
        ${C.kinds.slice(1).map(k => `<a class="chip" href="${chartHref('year', k.id, C.years[1])}">${C.years[1]} ${esc(k.name)}</a>`).join('')}</div></section></div>`;
  const sig = pageCtl.signal;
  await Promise.all(C.collections.map(c => api('douban/chart', { kind: 'collection', id: c.id, count: 10 }).then(j => {
    const sec = !sig.aborted && $(`#view .row[data-c="${c.id}"]`); if (!sec) return;
    if (!j.list.length) return sec.remove();
    if (j.updated && $('#updated')) $('#updated').textContent = '· 更新于 ' + fmtAgo(j.updated);
    $('.scroller', sec).innerHTML = j.list.slice(0, 10).map((x, i) => card({ ...x, douban: 1 }, { rank: x.rank || i + 1, sub: x.year })).join('');
  }, e => { if (!isAbort(e)) $(`#view .row[data-c="${c.id}"]`)?.remove(); })));
}

// ---------- downloads ----------
async function refreshDownloads(signal) {
  const j = await api('downloads', {}, signal).catch(() => null);
  if (Array.isArray(j?.jobs)) state.downloads = j.jobs;
  return state.downloads;
}
const dlFor = (site, id, url) => (state.downloads || []).find(j => j.site === site && j.vid === id && j.url === url);
// Icon-only 收藏 / 下载 buttons (same glyphs as the player bar).
const svgI = p => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${p}"/></svg>`;
const IC = {
  heart: svgI('M12 20.5l-1.2-1.1C5.9 15 3 12.4 3 9a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 21 9c0 3.4-2.9 6-7.8 10.4z'),
  dl: svgI('M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 20h14'),
  done: svgI('M5 12.5l4.5 4.5L19 7.5'),
  pause: svgI('M8 5v14M16 5v14'),
  play: svgI('M7 4.5v15l12-7.5z'),
  retry: svgI('M20 12a8 8 0 1 1-2.6-5.9M20 4v5h-5'),
  feed: svgI('M5 3h14v18H5zM10 9.2v5.6l4.5-2.8z'),
  share: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="2.6"/><circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="19" r="2.6"/><path d="M8.3 10.7l7.4-4.2M8.3 13.3l7.4 4.2"/></svg>',
  trash: svgI('M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3'),
  clear: svgI('M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3'),
  top: svgI('M12 19V7M6 12.5l6-6 6 6M5 3.5h14'),
  save: svgI('M12 3v12m0 0l-4-4m4 4l4-4M4 17v3h16v-3M4 3h4M16 3h4'),
  wait: svgI('M12 7v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z'),
};

async function enqueue(d, line, eps) {
  await req('POST', '/api/downloads', { items: eps.map(i => ({ site: d.site, siteName: d.siteName, adult: d.adult ? 1 : 0, id: d.id, name: d.name, pic: d.pic, line, ep: i, epName: d.lines[line].episodes[i].name, url: d.lines[line].episodes[i].url })) });
  await refreshDownloads();
  toast(eps.length > 1 ? `已加入下载：${eps.length} 集` : '已加入下载');
  $('#modal')?.pollDl?.();
}

const saveFiles = new Map();   // 已取到内存、等着弹分享面板的文件 (href -> File)
async function renderDownloads() {
  const status = { queued: '排队中', downloading: '下载中', done: '已完成', error: '失败', paused: '已暂停' };
  const draw = async () => {
    const j = await api('downloads');
    state.downloads = j.jobs;
    if (!location.hash.startsWith('#/downloads')) return;
    const total = j.jobs.reduce((s, x) => s + (x.bytes || 0), 0);
    const anyActive = j.jobs.some(x => ACTIVE.includes(x.status)), anyPaused = j.jobs.some(x => ['paused', 'error'].includes(x.status));
    const totalSpeed = j.jobs.reduce((n, x) => n + (x.speed || 0), 0);
    view.innerHTML = `<div class="page"><div class="pagehead"><h1>下载</h1>
        ${anyActive ? `<button class="small ibs" data-op="pause" data-all title="全部暂停" aria-label="全部暂停">${IC.pause}</button>` : ''}
        ${anyPaused ? `<button class="small ibs" data-op="resume" data-all title="全部开始" aria-label="全部开始">${IC.play}</button>` : ''}
        ${totalSpeed ? `<span class="spd">${fmtSpeed(totalSpeed)}</span>` : ''}</div>
      <p class="lan">已用 ${fmtSize(total)}${j.free ? ` · 剩余 ${fmtSize(j.free)}` : ''} · 同时下载 ${j.maxJobs} 集</p>
      ${j.jobs.length ? `<div class="dls">${j.jobs.map(x => {
        const pct = x.pct || 0;
        return `<div class="dl ${x.status}" data-id="${esc(x.id)}">
          <div class="thumb" style="${bg(x.pic)}"></div>
          <div class="dinfo"><div><b>${esc(x.name)}</b> <span>${esc(x.epName)}</span></div>
            <div class="lan">${esc(x.siteName)} · ${status[x.status] || x.status}${x.status === 'queued' && x.qpos ? ` 第 ${x.qpos} 位` : ''}${['downloading', 'paused'].includes(x.status) ? ` ${pct}%` : ''} · ${fmtSize(x.bytes || 0)}${x.status === 'downloading' && x.speed ? ` · <b class="spd">${fmtSpeed(x.speed)}</b> · ${fmtEta(x.eta)}` : ''}${x.error ? ' · ' + esc(x.error) : ''}</div>
            <div class="bar"><i style="width:${x.status === 'done' ? 100 : pct}%"></i></div></div>
          <div class="dops">
            ${x.status === 'done' ? `<button class="small ibs ok" data-op="play" title="播放" aria-label="播放">${IC.play}</button><a class="small ibs" href="/dl/${esc(x.id)}/save" download title="保存到本机" aria-label="保存到本机">${IC.save}</a>` : ''}
            ${['queued', 'downloading'].includes(x.status) ? `<button class="small ibs" data-op="pause" title="暂停" aria-label="暂停">${IC.pause}</button>` : ''}
            ${['paused', 'error'].includes(x.status) ? `<button class="small ibs" data-op="resume" title="${x.status === 'error' ? '重试' : '继续'}" aria-label="${x.status === 'error' ? '重试' : '继续'}">${x.status === 'error' ? IC.retry : IC.play}</button>` : ''}
            ${(x.status === 'queued' && x.qpos > 1) || ['paused', 'error'].includes(x.status) ? `<button class="small ibs" data-op="top" title="排到队首，下一个就下" aria-label="优先">${IC.top}</button>` : ''}
            <button class="small ibs" data-op="del" title="删除" aria-label="删除">${IC.trash}</button></div></div>`;
      }).join('')}</div>` : '<p class="empty">还没有下载。打开任意影片，点封面页的下载图标再选集。</p>'}</div>`;
  };
  await draw();
  view.onclick = async e => {
    // iOS 主屏幕应用里 <a download> / window.open 都不行 (应用内预览页退不出来 / 白屏)：先把文件取到内存，再用系统分享面板存到「文件」。
    // 分享要用户手势，而取文件要一会儿，所以分两下：第一下取文件，第二下弹分享。
    const sv = e.target.closest('a[href$="/save"]');
    if (sv && /iPad|iPhone|iPod/.test(navigator.userAgent) && (navigator.standalone || matchMedia('(display-mode: standalone)').matches)) {
      e.preventDefault();
      const href = sv.getAttribute('href'), x = state.downloads.find(j => href.includes('/' + j.id + '/'));
      const have = saveFiles.get(href);
      if (have) {
        try { await navigator.share({ files: [have] }); saveFiles.delete(href); sv.classList.remove('ok'); }
        catch (err) { if (err.name !== 'AbortError') toast('无法打开系统分享：' + err.message); }
        return;
      }
      if (sv.dataset.busy) return;
      if (!navigator.canShare) return toast('这个系统版本不支持从应用里保存文件，请用 Safari 打开本页下载');
      if (x && x.bytes > 1.5e9) return toast(`文件有 ${fmtSize(x.bytes)}，太大了，应用里放不下。请用电脑或 Safari 打开本页下载`);
      sv.dataset.busy = '1'; toast(`正在准备文件${x ? '（' + fmtSize(x.bytes) + '）' : ''}，请稍等…`);
      try {
        const r = await fetch(href); if (!r.ok) throw new Error('HTTP ' + r.status);
        const name = decodeURIComponent((/filename\*=UTF-8''([^;]+)/.exec(r.headers.get('content-disposition') || '') || [])[1] || 'video.mp4');
        const blob = await r.blob(), file = new File([blob], name, { type: blob.type || 'video/mp4' });
        if (!navigator.canShare({ files: [file] })) throw new Error('系统不接受这个文件');
        saveFiles.set(href, file); sv.classList.add('ok'); toast('文件已准备好，再点一次「保存」按钮，选「存储到文件」');
      } catch (err) { toast('准备文件失败：' + err.message); }
      finally { delete sv.dataset.busy; }
      return;
    }
    const ob = e.target.closest('[data-op]'); if (!ob) return;
    const op = ob.dataset.op;
    if (ob.dataset.all !== undefined) { await req('PATCH', `/api/downloads?id=*&action=${op}`); return draw(); }
    const id = ob.closest('.dl').dataset.id;
    const x = state.downloads.find(j => j.id === id);
    if (op === 'play') { cur = { kind: 'local', eps: [{ name: x.epName, url: x.play }], ep: 0, title: x.name }; return openPlayer(0); }
    if (op === 'del' && !confirm(`删除「${x.name} ${x.epName}」？`)) return;
    if (op === 'del') await req('DELETE', '/api/downloads?id=' + id);
    else await req('PATCH', `/api/downloads?id=${id}&action=${op}`);
    draw();
  };
  pageTimer = setInterval(() => { if (state.downloads.some(x => ACTIVE.includes(x.status))) draw().catch(() => {}); }, 1000);
}

// ---------- detail modal ----------
async function openDetail(site, id, autoplay = false, replace = false) {
  replace = replace && !!$('#modal');
  closeDetail();
  const m = document.createElement('div');
  m.className = 'modal'; m.id = 'modal';
  // The card that was clicked already has its picture loaded: show it at once (cover + title) instead of a bare spinner, and keep
  // that very node when the details arrive, so the cover never blinks out and back in.
  const known = cardItems.get(site + '|' + id);
  m.innerHTML = known && known.pic
    ? `<div class="sheet"><div class="top"><div class="bg" style="${bg(dbSize(known.pic, 's') || known.pic)}"></div><div class="poster sk" style="${bgHi(known.pic, 'm')}"></div>
        <button class="close">✕</button><div class="info"><h1>${esc(known.name || '')}</h1></div></div><div class="body">${spinner}</div></div>`
    : `<div class="sheet">${spinner}</div>`;
  m.querySelector('.close') && (m.querySelector('.close').onclick = () => history.back());
  const skPoster = m.querySelector('.poster.sk');
  m.onclick = e => { if (e.target === m) history.back(); };
  m.ctl = new AbortController();
  document.body.append(m); document.body.style.overflow = 'hidden';
  if (!replace) history.pushState({ modal: 1 }, '');
  let d;
  try { [d] = await Promise.all([api('detail', { site, id }, m.ctl.signal), refreshDownloads(m.ctl.signal)]); }
  catch (e) { if (isAbort(e)) return; m.firstChild.innerHTML = `<button class="close">✕</button><div class="body"><div class="err">详情加载失败：${esc(e.message)}</div></div>`; m.querySelector('.close').onclick = () => history.back(); return; }
  const canOpen = d.local && !!(await infoP().catch(() => ({}))).loopback;
  const h0 = hist.get(site, id);
  let line = h0 && d.lines[h0.line] ? h0.line : 0, dlMode = false, alts = null, dbPic = '';
  const render = () => {
    const h = hist.get(site, id);
    const eps = d.lines[line]?.episodes || [];
    const resumeIdx = h && h.line === line && eps[h.ep] ? h.ep : 0;
    m.firstChild.innerHTML = `
      <div class="top"><div class="bg" style="${bg(dbSize(d.pic, 's') || d.pic)}"></div><div class="poster" ${d.local ? `data-pv="/media/g/${esc(d.id)}"` : ''} style="${dbPic ? bgLayers(d.pic, dbPic, 'l') : bgHi(d.pic, 'm')}"></div>
        <button class="close">✕</button>
        <div class="info"><h1>${esc(d.name)}</h1><div class="btns">
          ${eps.length ? `<a class="btn play" data-ep="${resumeIdx}" href="${esc(playHref(site, id, line, resumeIdx))}">▶ ${h && h.line === line ? '继续 ' + esc(eps[resumeIdx].name) : eps.length > 1 ? '播放 ' + esc(eps[0].name) : '播放'}</a>
            ${d.local ? '' : `<button class="btn more ico ib dlbtn" id="dlToggle" title="下载" aria-label="下载">${IC.dl}</button>`}` : ''}
          ${canOpen && eps.length ? `<button class="btn more ico ib" id="extPlay" aria-label="用系统播放器打开" title="用系统默认播放器打开${eps.length > 1 ? ' ' + esc(eps[resumeIdx].name) : ''}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg></button><button class="btn more ico ib" id="extReveal" aria-label="在文件夹中显示" title="在文件夹中显示这个文件"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.7c.4 0 .8.2 1.1.5L11.8 7h7.7A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/></svg></button>` : ''}
          <button class="btn more ico" id="shareBtn" title="分享" aria-label="分享"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="2.6"/><circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="19" r="2.6"/><path d="M8.3 10.7l7.4-4.2M8.3 13.3l7.4 4.2"/></svg></button>
          ${kidsMode() ? '' : `<button class="btn more ico ib fav ${favs.has(site, id) ? 'on' : ''}" id="favBtn" title="${favs.has(site, id) ? '取消收藏' : '收藏'}" aria-label="收藏">${IC.heart}</button>`}
        </div></div></div>
      <div class="body">
        <div class="metaRow"><span id="qtag">${qChip(vodQ(d), 'big')}</span><a class="dbtag" id="dbtag" hidden target="_blank" rel="noreferrer"></a>
          <a class="tag" data-nav href="#/site/${encodeURIComponent(site)}" title="切换到这个源">${esc(d.siteName)}</a>
          ${d.type ? `<a class="tag cat" data-nav href="#/cat/${encodeURIComponent(d.typeId || '')}/${encodeURIComponent(d.type)}/${encodeURIComponent(site)}" title="看这个分类">${esc(d.type)} ›</a>` : ''}
          ${esc([d.year, d.area, d.lang, d.remarks].filter(x => x && x !== '0').join('  ·  '))}</div>
        ${d.blurb ? `<p class="desc">${esc(d.blurb)}</p>` : ''}
        ${people('导演', 'director', d.directors)}
        ${people('演员', 'actor', d.actors, 16)}
        ${d.lines.length ? `<h3>剧集 <span class="lines">${d.lines.map((l, i) => `<button data-line="${i}" class="${i === line ? 'on' : ''}">${esc(l.name)} (${l.episodes.length})${qChip(l.quality, 'sm')}</button>`).join('')}</span>
            ${dlMode ? `<span class="dlhint">点选要下载的集，再点一下暂停/继续 <button class="small" id="dlAll">全部下载</button>
              ${state.downloads.some(j => j.site === site && j.vid === id && ACTIVE.includes(j.status)) ? '<button class="small" id="dlAllPause">全部暂停</button>' : ''}</span>` : ''}</h3>
          <div class="eps ${dlMode ? 'dlmode' : ''}">${eps.map((e, i) => {
            const inner = esc(e.name);
            const cls = h && h.line === line && i <= h.ep ? 'seen' : '';
            return dlMode ? `<button data-dl="${i}" class="${cls}" title="${esc(e.name)}">${inner}</button>`
              : `<a data-ep="${i}" class="${cls}" title="${esc(e.name)}" href="${esc(playHref(site, id, line, i))}">${inner}</a>`;
          }).join('')}</div>`
          : '<p class="err">这个源没有可直接播放的地址，看看下面的其他源。</p>'}
        <h3>其他源</h3><div class="alts" id="alts"><span class="lan">在所有源里搜索中…</span></div>
      </div>`;
    m.querySelector('.close').onclick = () => history.back();
    // The cover node lives for the whole sheet: the skeleton's node (already painted from the card) is moved into every render,
    // so opening a card never shows the picture blinking out and back in.
    { const np = $('.top .poster', m);
      if (!m._poster) m._poster = skPoster || np;
      if (np && np !== m._poster) {
        const keep = m._poster;
        for (const a of [...keep.attributes]) if (a.name !== 'style') keep.removeAttribute(a.name);
        for (const a of [...np.attributes]) keep.setAttribute(a.name, a.value);       // class / data-pv / the real (possibly sharper) style
        np.replaceWith(keep);
      } }
    $$('[data-line]', m).forEach(b => b.onclick = () => { line = +b.dataset.line; render(); });
    $$('[data-ep]', m).forEach(b => b.onclick = e => { if (!plainClick(e)) return; e.preventDefault(); play(d, line, +b.dataset.ep); });
    // In 下载 mode a chip starts that episode; tapping it again pauses / resumes it.
    $$('[data-dl]', m).forEach(b => b.onclick = () => {
      const j = dlFor(site, id, eps[+b.dataset.dl].url);
      if (j && j.status !== 'done') return dlAction(j, j.status === 'paused' || j.status === 'error' ? 'resume' : 'pause');
      if (!j) enqueue(d, line, [+b.dataset.dl]).then(paintDl, e => toast(e.message));
    });
    if ($('#dlToggle', m)) $('#dlToggle', m).onclick = () => {
      if (eps.length > 1) { dlMode = !dlMode; return render(); }
      // Single episode (a film): the button itself downloads, then shows its progress.
      const j = dlFor(site, id, eps[0].url);
      if (!j) return enqueue(d, line, [0]).then(paintDl, e => toast(e.message));
      if (j.status === 'done') return toast('已下载，播放时会自动用本地文件');
      dlAction(j, ACTIVE.includes(j.status) ? 'pause' : 'resume');
    };
    if ($('#dlAllPause', m)) $('#dlAllPause', m).onclick = () => Promise.all(state.downloads.filter(j => j.site === site && j.vid === id && ACTIVE.includes(j.status)).map(j => req('PATCH', `/api/downloads?id=${j.id}&action=pause`))).then(() => refreshDownloads(m.ctl.signal)).then(paintDl);
    try { paintDl(); } catch (err) { console.error('paintDl', err); }
    if ($('#extPlay', m)) {
      $('#extPlay', m).onclick = () => openLocal(eps[resumeIdx]?.url, 'play');
      $('#extReveal', m).onclick = () => openLocal(eps[resumeIdx]?.url, 'reveal');
    }
    $('#shareBtn', m).onclick = () => shareNow(vodHref(site, id), d.name);
    if ($('#favBtn', m)) $('#favBtn', m).onclick = () => { toast(favs.toggle(d) ? '已收藏' : '已取消收藏'); render(); };
    $$('[data-more-people]', m).forEach(b => b.onclick = () => { b.parentElement.classList.add('all'); b.remove(); });
    if ($('#dlAll', m)) $('#dlAll', m).onclick = () => enqueue(d, line, eps.map((_, i) => i)).then(render, e => toast(e.message));
    const doubanDetail = r => {
      if (!m.isConnected) return;
      if (r.pic && !dbPic) { dbPic = r.pic; const p = $('.top .poster', m); if (p) p.style.cssText = bgLayers(d.pic, dbPic, 'l'); }
      const t = $('#dbtag', m); if (!t || !r.id) return;
      t.textContent = r.rate ? '豆瓣 ' + r.rate : '豆瓣 暂无评分'; t.href = `https://movie.douban.com/subject/${r.id}/`; t.hidden = false;
    };
    // 成人条目: javdb 优先补全标题/封面/演员/评分，匹配不到或失败再走豆瓣兜底。
    if (isJav(d)) {
      const code = javCode(d.name);
      if (code) javMeta(code).then(r => {
        if (!m.isConnected) return;
        if (!r.found) { dbRate(d.name, d.year).then(doubanDetail); return; }
        const h1 = $('.info h1', m);
        if (h1 && r.title && r.title !== d.name) h1.textContent = r.title;
        const p = $('.top .poster', m);
        if (p && r.cover && javCoverWanted(d)) p.style.cssText = bgLayers(d.pic, r.cover, 'l');
        if (r.actors?.length) {
          const ap = $$('.people', m).find(x => x.querySelector('.plabel')?.textContent === '演员');
          if (ap) ap.outerHTML = people('演员', 'actor', r.actors, 16);
        }
        const mr = $('.metaRow', m);
        let t = $('#javtag', m);
        if (mr && !t) { t = document.createElement('a'); t.id = 'javtag'; t.className = 'tag'; t.target = '_blank'; t.rel = 'noreferrer'; mr.append(t); }
        if (t && r.url) { t.textContent = r.score ? `JAVDB ${r.score}${r.votes ? ` · ${r.votes}人` : ''}` : 'JAVDB'; t.title = r.score ? `JAVDB 评分 ${r.score}${r.votes ? `，${r.votes} 人评价` : ''}` : ''; t.href = r.url; t.hidden = false; }
      });
      else dbRate(d.name, d.year).then(doubanDetail);
    } else dbRate(d.name, d.year).then(doubanDetail);
    paintAlts();
    probeLine();
  };
  // Real resolution of the current line's first stream — asked for only after the sheet is on screen,
  // answered from the local cache when possible, never blocks playback.
  const probed = new Set();
  const paintQ = () => {
    const t = $('#qtag', m); if (t) t.innerHTML = qChip(vodQ(d), 'big');
    $$('[data-line]', m).forEach(b => { b.querySelector('.q')?.remove(); b.insertAdjacentHTML('beforeend', qChip(d.lines[+b.dataset.line]?.quality, 'sm')); });
  };
  const probeLine = async () => {
    const l = d.lines[line], u = l?.episodes[0]?.url;
    if (!u || probed.has(line) || !(/\.m3u8(\?|$)/i.test(u) || u.startsWith('/media/'))) return;
    probed.add(line);
    let q = qc.get('u|' + u);
    if (!q) {
      try { q = (await api('probe', { u }, m.ctl.signal)).quality; } catch { return; }
      if (!q) return;
      qc.set('u|' + u, q);
    }
    if (!m.isConnected) return;
    l.quality = q;
    qc.set(`v|${site}|${id}`, bestQ([q, ...d.lines.map(x => x.quality)]));
    paintQ();
  };
  const paintAlts = () => {
    const box = $('#alts', m); if (!box || !alts) return;
    box.innerHTML = alts.length ? alts.map(a => `<a href="${esc(vodHref(a.site, a.id))}" data-s="${esc(a.site)}" data-i="${esc(a.id)}">${esc(a.siteName)}<small>${esc(a.remarks)}</small></a>`).join('') : '<span class="lan">其他源没有同名的</span>';
    $$('a', box).forEach(b => b.onclick = e => { if (!plainClick(e)) return; e.preventDefault(); openDetail(b.dataset.s, b.dataset.i, false, true); });
  };
  const dlAction = (j, action) => req('PATCH', `/api/downloads?id=${j.id}&action=${action}`)
    .then(() => refreshDownloads(m.ctl.signal)).then(() => { paintDl(); pollDl(); toast(action === 'pause' ? '已暂停' : '已继续'); }, e => toast(e.message));
  // Download state, updated in place every second while this title has active jobs.
  const paintDl = () => {
    if (!m.isConnected) return;
    const eps = d.lines[line]?.episodes || [];
    $$('.eps [data-ep], .eps [data-dl]', m).forEach(el => {
      const j = dlFor(site, id, eps[+(el.dataset.ep ?? el.dataset.dl)]?.url);
      el.querySelector('em')?.remove();
      if (j) el.insertAdjacentHTML('afterbegin', `<em class="${j.status}">${j.status === 'done' ? '✓' : j.status === 'downloading' ? `${j.pct}%` : j.status === 'error' ? '!' : j.status === 'paused' ? `⏸${j.pct ? j.pct + '%' : ''}` : '排队'}</em>`);
      if (j) el.title = `${eps[+(el.dataset.ep ?? el.dataset.dl)].name} · ${{ done: '已下载', downloading: '下载中，点一下暂停', queued: `排队第 ${j.qpos} 位，点一下暂停`, paused: '已暂停，点一下继续', error: '失败，点一下重试' }[j.status] || ''}`;
      el.classList.toggle('dling', !!j && j.status !== 'done');
      el.style.setProperty('--p', j && j.status !== 'done' ? j.pct + '%' : '0%');
    });
    const b = $('#dlToggle', m); if (!b) return;
    const mine = (state.downloads || []).filter(j => j.site === site && j.vid === id);
    const active = mine.filter(j => ACTIVE.includes(j.status));
    const speed = fmtSpeed(active.reduce((n, j) => n + (j.speed || 0), 0));
    let ic = IC.dl, txt = '', tip = '下载', p = 0;
    if (dlMode) { ic = IC.done; tip = '完成'; }
    else if (eps.length === 1) {
      const j = dlFor(site, id, eps[0].url);
      if (!j) { /* default */ }
      else if (j.status === 'done') { ic = IC.done; tip = '已下载'; }
      else if (j.status === 'queued') { ic = IC.wait; txt = `#${j.qpos}`; tip = `排队第 ${j.qpos} 位，点一下暂停`; }
      else if (j.status === 'downloading') { ic = IC.pause; txt = `${j.pct}%`; tip = `下载中${speed ? ' · ' + speed : ''}，点一下暂停`; p = j.pct; }
      else if (j.status === 'paused') { ic = IC.play; txt = `${j.pct}%`; tip = '已暂停，点一下继续'; p = j.pct; }
      else { ic = IC.retry; tip = '失败，点一下重试'; }
    } else if (active.length) {
      const done = mine.filter(j => j.status === 'done').length;
      txt = `${done}/${mine.length}`; tip = `下载中 ${done}/${mine.length} 集${speed ? ' · ' + speed : ''}`;
      p = Math.round(mine.reduce((n, j) => n + (j.status === 'done' ? 100 : j.pct || 0), 0) / mine.length);
    } else {
      const done = mine.filter(j => j.status === 'done').length;
      tip = done ? `下载 · 已下 ${done} 集` : '下载';
    }
    b.innerHTML = ic + (txt ? `<span>${txt}</span>` : '');
    b.title = tip; b.setAttribute('aria-label', tip);
    b.classList.toggle('dling', p > 0);
    b.style.setProperty('--p', p + '%');
  };
  let dlTimer = 0;
  const pollDl = () => {
    clearTimeout(dlTimer);
    if (!m.isConnected || !state.downloads.some(j => j.site === site && j.vid === id && ACTIVE.includes(j.status))) return;
    dlTimer = setTimeout(() => refreshDownloads(m.ctl.signal).then(() => { paintDl(); pollDl(); }), 1000);
  };
  m.ctl.signal.addEventListener('abort', () => clearTimeout(dlTimer));
  m.refresh = () => refreshDownloads(m.ctl.signal).then(render);
  m.pollDl = pollDl;
  pollDl();
  render();
  findAlts(d).then(list => { if (m.ctl.signal.aborted) return; alts = list; paintAlts(); });
  if (autoplay && typeof autoplay === 'object' && d.lines[autoplay.line]?.episodes[autoplay.ep]) {
    line = autoplay.line; render(); play(d, line, autoplay.ep);
  } else if (autoplay && d.lines.length) play(d, line, h0 && h0.line === line ? h0.ep : 0);
}
function people(label, role, list, max = 99) {
  if (!list?.length) return '';
  return `<div class="people ${list.length > max ? '' : 'all'}"><span class="plabel">${label}</span>${list.map((n, i) =>
    `<a class="pchip ${i >= max ? 'extra' : ''}" data-nav href="${personHash(role, n)}">${esc(n)}</a>`).join('')}
    ${list.length > max ? `<button class="pchip more" data-more-people>+${list.length - max}</button>` : ''}</div>`;
}
// Links inside the detail sheet: a plain click leaves the sheet and goes there (replacing the sheet's
// history entry, so Back returns to the page underneath); modifier clicks open a new tab as usual.
document.addEventListener('click', e => {
  const a = e.target.closest('#modal a[data-nav]'); if (!a || !plainClick(e)) return;
  e.preventDefault();
  closeDetail();
  history.replaceState(null, '', a.getAttribute('href'));
  route();
});
function closeDetail() {
  const m = $('#modal'); if (!m) return;
  stopLocalPreview(true);
  m.ctl?.abort();
  m.remove(); document.body.style.overflow = '';
}
addEventListener('popstate', () => {
  if (pipSkip) { pipSkip = false; return; }  // our own back() when the player went into 画中画
  if (playerOpen()) return closePlayer();
  closeDetail();
});

// ---------- player ----------
const player = $('#player'), video = $('#video'), sysPanel = $('.psyspanel');
let hls, cur = null, idleTimer;
// 画中画: the small window keeps playing while the full-screen player steps aside and the page underneath
// comes back. "Back to tab" brings the player back; closing the small window stops playback.
let pipOn = false, pipSkip = false;
const playerOpen = () => !player.hidden && !pipOn;
const onEnterPip = () => {
  if (pipOn) return;
  pipOn = true;
  player.classList.add('pip'); togglePlist(false);
  if (!$('#modal')) document.body.style.overflow = '';
  if (history.state?.player) { pipSkip = true; history.back(); }
};
const onLeavePip = () => {
  if (!pipOn) return;
  pipOn = false;
  player.classList.remove('pip');
  if (video.paused) return closePlayer();
  history.pushState({ player: 1 }, ''); document.body.style.overflow = 'hidden'; poke();
};
video.addEventListener('enterpictureinpicture', onEnterPip);
video.addEventListener('leavepictureinpicture', onLeavePip);
// iOS Safari older than the standard API: same thing through the presentation mode.
video.addEventListener('webkitpresentationmodechanged', () => (video.webkitPresentationMode === 'picture-in-picture' ? onEnterPip : onLeavePip)());
// 浏览器 / 系统自带的小窗 (标准 API, 或 iOS 的 webkit 接口) 只要有就显示
let pipFailed = false;
const pipSupported = () => !pipFailed && !(/iPad|iPhone|iPod/.test(navigator.userAgent) && (navigator.standalone || matchMedia('(display-mode: standalone)').matches)) && !video.disablePictureInPicture && !!(document.pictureInPictureEnabled || typeof video.webkitSetPresentationMode === 'function');
// 装到主屏幕 (触屏) 的应用本来就是全屏: 竖屏视频不需要全屏按钮, 横屏视频 (宽 > 高) 要有, 好横过来看; 浏览器里、桌面的独立窗口里一直保留
const hideFs = () => !fineCursor && (navigator.standalone || matchMedia('(display-mode: standalone)').matches) && !(video.videoWidth > video.videoHeight);
function togglePip() {
  if (pipOn || document.pictureInPictureElement || video.webkitPresentationMode === 'picture-in-picture') {
    return document.exitPictureInPicture ? document.exitPictureInPicture().catch(() => {}) : video.webkitSetPresentationMode('inline');
  }
  const p = video.requestPictureInPicture ? video.requestPictureInPicture() : (video.webkitSetPresentationMode('picture-in-picture'), Promise.resolve());
  return p.catch(() => { pipFailed = true; $('[data-act=pip]').hidden = true; $('[data-c=pip]').hidden = true; toast('这个浏览器不支持小窗播放'); });
}
// 小窗 + 后台播放: leaving the app (home / another app / lock screen) while something plays shrinks it into the small window
// where the browser allows it (Safari: autoPictureInPicture; Chrome: the Media Session hook below), and the lock-screen /
// notification controls drive the player. Nothing in the page pauses a hidden tab, so audio keeps going where the OS lets it.
video.autoPictureInPicture = true;
const ms = navigator.mediaSession;
function syncMedia() {
  if (!ms || !cur || !window.MediaMetadata) return;
  const e = cur.eps[cur.ep], live = cur.kind === 'live';
  const pic = live ? e.logo : cur.d?.pic;
  try {
    ms.metadata = new MediaMetadata({ title: live ? e.name : (cur.eps.length > 1 ? e.name : cur.title), artist: live ? '直播' : cur.title, album: 'TVBOX',
      artwork: pic ? [{ src: new URL(pic, location.href).href, sizes: '512x512' }] : [] });
  } catch {}
  try { ms.setActionHandler('previoustrack', cur.ep > 0 ? () => step(-1) : null); ms.setActionHandler('nexttrack', cur.ep < cur.eps.length - 1 ? () => step(1) : null); } catch {}
}
if (ms) {
  const on = (a, f) => { try { ms.setActionHandler(a, f); } catch {} };
  on('play', () => video.play().catch(() => {}));
  on('pause', () => video.pause());
  const vod = () => cur && cur.kind !== 'live' && isFinite(vdur(video));
  on('seekbackward', d => { if (vod()) video.currentTime -= d?.seekOffset || 10; });
  on('seekforward', d => { if (vod()) video.currentTime += d?.seekOffset || 10; });
  on('seekto', d => { if (vod() && d.seekTime != null && isFinite(d.seekTime)) video.currentTime = d.seekTime; });
  on('enterpictureinpicture', () => { if (cur && !video.paused && !pipOn) togglePip(); });
  video.addEventListener('play', () => { ms.playbackState = 'playing'; });
  video.addEventListener('pause', () => { ms.playbackState = 'paused'; });
  const pos = () => { if (isFinite(vdur(video)) && vdur(video) > 0) try { ms.setPositionState({ duration: vdur(video), position: Math.min(video.currentTime, vdur(video)), playbackRate: video.playbackRate || 1 }); } catch {} };
  video.addEventListener('loadedmetadata', pos); video.addEventListener('ratechange', pos); video.addEventListener('seeked', pos);
}

function play(d, line, ep) {
  cur = { kind: 'vod', d, line, ep, eps: d.lines[line].episodes, title: d.name };
  const h = hist.get(d.site, d.id);
  openPlayer(h && h.line === line && h.ep === ep && h.dur - h.t > 30 ? h.t : 0);
}
// 沉浸看片的「全屏观看」: 从指定进度接着用普通播放器播放
function playAt(d, line, ep, t) {
  cur = { kind: 'vod', d, line, ep, eps: d.lines[line].episodes, title: d.name };
  openPlayer(t);
}
function playLive(channels, idx) {
  cur = { kind: 'live', eps: channels.map(c => ({ name: c.name, url: c.url, logo: c.logo })), ep: idx };
  openPlayer(0);
}
function openPlayer(startAt) {
  const e = cur.eps[cur.ep];
  if (pipOn) { pipOn = false; player.classList.remove('pip'); document.exitPictureInPicture?.().catch(() => {}); }
  if (!playerOpen() || !history.state?.player) { player.hidden = false; history.pushState({ player: 1 }, ''); document.body.style.overflow = 'hidden'; }
  $('.ptitle').textContent = cur.kind === 'live' ? e.name : (cur.eps.length > 1 ? `${cur.title} · ${e.name}` : cur.title);
  const live = cur.kind === 'live';
  setL('next', live ? '下一台' : '下一集'); setL('list', live ? '频道' : '选集');
  $('[data-act=next]').hidden = cur.ep >= cur.eps.length - 1;
  $('[data-act=list]').hidden = cur.eps.length <= 1;
  syncFs();
  $('[data-act=pip]').hidden = !pipSupported() || fineCursor;   // desktop has it in the control bar
  syncMedia();
  $('[data-act=star]').hidden = !live;
  $('[data-act=share]').hidden = cur.kind === 'local';   // 下载列表里的本地文件没有可分享的页面
  paintVodActs();
  srcAlts = []; syncSrcAct();                       // 先不显示「切换源」, 查到别的源再出现
  if (cur.kind === 'vod' && !cur.d.local) {
    const nm = cur.d.name;
    findAlts(cur.d).then(a => { if (cur && cur.kind === 'vod' && cur.d.name === nm) { srcAlts = a; syncSrcAct(); } });
  }
  $('[data-act=ext]').hidden = !(cur.kind === 'vod' && cur.d.local && serverInfo?.loopback);
  if (live) paintStar(liveFavs.has(e.url));
  renderPlist();
  const local = cur.kind === 'vod' ? dlFor(cur.d.site, cur.d.id, e.url) : null;
  const useLocal = cur.kind === 'local' || local?.status === 'done';
  $('.local').hidden = !useLocal;
  load(local?.status === 'done' ? local.play : e.url, startAt, false, useLocal || e.url.startsWith('/media/'));
  // 一直没有画面 (起播不了 / 卡在缓冲): 10 秒后提示, 并挂上「切换源」。别的源还在搜就等搜到再挂上
  clearTimeout(stuckT);
  stuckT = setTimeout(() => {
    if (!cur || video.readyState >= 2) return;
    msg(msgTxt === '点一下播放' ? msgTxt : '一直没加载出来…', true);
  }, 10000);
  skipInit();
  syncMore();
  poke();
}
// 收藏 / 下载 inside the player (点播 only, not 本地媒体): same actions as the detail sheet, so a title opened by double-click
// can still be saved or downloaded without leaving the player.
function paintVodActs() {
  const v = cur?.kind === 'vod' && !cur.d.local;
  const fav = $('[data-act=vfav]'), dl = $('[data-act=dl]');
  fav.hidden = !v || kidsMode(); dl.hidden = !v;
  if (!v) return;
  const on = favs.has(cur.d.site, cur.d.id);
  setL('vfav', on ? '已收藏' : '收藏'); fav.classList.toggle('on', on);
  const j = dlFor(cur.d.site, cur.d.id, cur.eps[cur.ep].url);
  setL('dl', !j ? '下载' : j.status === 'done' ? '已下载' : ACTIVE.includes(j.status) ? `${j.pct || 0}%` : j.status === 'paused' ? '继续' : '重试');
  dl.classList.toggle('on', j?.status === 'done');
}
// The player's buttons are an icon plus a small label (shown on touch screens, a tooltip on desktop).
function setL(act, text) { const b = $(`[data-act=${act}]`); if (!b) return; const l = $('.l', b); if (l) l.textContent = text; b.title = text; }
function paintStar(on) { const b = $('[data-act=star]'); b.classList.toggle('on', on); setL('star', on ? '已收藏' : '收藏'); }
// 同名同年的其他源: 详情页的「其他源」和播放页的「切换源」共用，按片名只查一次。
function findAlts(d) {
  const k = d?.name;
  const mine = list => list.filter(r => !(r.site === d.site && r.id === d.id));
  if (!k) return Promise.resolve([]);
  if (altCache.has(k)) return Promise.resolve(mine(altCache.get(k)));
  return api('search', { wd: k }).then(j => { const list = j.results.filter(r => r.name === k); altCache.set(k, list); return mine(list); }).catch(() => []);
}
// 播放页: 当前片名的其他源 (拿到之前「切换源」不出现)
let srcAlts = [];
const syncSrcAct = () => { const b = $('[data-act=src]'); if (b) b.hidden = !srcAlts.length; paintMsg(); syncMore(); };
// 播放失败的提示后面挂一个文字按钮「切换源」(有别的源时才有)
let msgTxt = '', msgAct = false;
function msg(t, act = false) { msgTxt = t || ''; msgAct = act; paintMsg(); }
let stuckT = 0;
function paintMsg() {
  const el = $('.pmsg'); if (!el) return;
  if (!msgAct || !srcAlts.length || !cur || cur.kind !== 'vod') { el.textContent = msgTxt; return; }
  el.innerHTML = `<span>${esc(msgTxt)}</span><button type="button" class="sw">切换源</button>`;
  // 一律打开列表：每个源旁边有网络测速，选哪个一目了然
  $('.sw', el).onclick = e => { e.stopPropagation(); openSrcSheet(); };
}
// 切换源的上拉面板 (和选集同一个 .plist): 当前源 + 其他同名源，每个源同时测一下网络 (服务端取第一个分片，量首包时间和下载速度)。
// 一行一个源：左边源名，右边信号格 + 一个词 (畅通 / 良好 / 一般 / 较慢 / 不通) + 毫秒数；测完最快的打「最快」，当前源不通就提示换。
const NET_TXT = ['不通', '较慢', '一般', '良好', '畅通'];
function netLevel(r) {
  if (!r || !r.ok) return 0;
  const ms = r.ms || 0, kb = r.kbps || 0;
  if (ms <= 1000 && kb >= 4000) return 4;
  if (ms <= 2000 && kb >= 2000) return 3;
  if (ms <= 4000 && kb >= 800) return 2;
  return 1;
}
// 测速结果统一画法 (播放页切换源 / 点播源菜单 / 直播源菜单)：左边信号格，右边上面一个状态词、下面一行小字 (毫秒数 …)
const netLvMs = ms => ms <= 1000 ? 4 : ms <= 2000 ? 3 : ms <= 4000 ? 2 : 1;
const netBox = (lv, sub, tip = '', cls = '') => `<span class="net lv${lv} ${cls}"${tip ? ` title="${esc(tip)}"` : ''}>${netBars(lv)}<span class="nt"><em>${NET_TXT[lv]}</em><small>${esc(sub)}</small></span></span>`;
const netBusy = '<span class="net busy"><svg class="bars" viewBox="0 0 20 16" aria-hidden="true">' + [0, 1, 2, 3].map(i => `<rect x="${i * 5.3}" y="${12 - i * 4}" width="3.6" height="${4 + i * 4}" rx="1"/>`).join('') + '</svg><span class="nt"><small>测速中</small></span></span>';
const netBars = lv => `<svg class="bars" viewBox="0 0 20 16" aria-hidden="true">${[0, 1, 2, 3].map(i => `<rect x="${i * 5.3}" y="${12 - i * 4}" width="3.6" height="${4 + i * 4}" rx="1" class="${i < lv ? 'on' : ''}"/>`).join('')}</svg>`;
const netCell = n => !n ? '' : n.busy ? `<span class="net busy">${netBars(0)}<span class="nt"><small>测速中</small></span></span>`
  : n.skip ? `<span class="net skip"><span class="nt"><small>${esc(n.skip)}</small></span></span>`
  : `<span class="net lv${n.lv}" title="${esc(n.tip || '')}">${netBars(n.lv)}<span class="nt"><em>${NET_TXT[n.lv]}</em><small>${n.lv ? n.ms + ' ms' : esc(n.err || '')}</small></span></span>`;
let srcRun = null;
async function openSrcSheet() {
  if (!cur || cur.kind !== 'vod') return;
  const d = cur.d, epNow = cur.ep;
  if (!srcAlts.length) srcAlts = await findAlts(d);
  if (!srcAlts.length) return toast('没有找到同名的其他源');
  srcRun?.ctl.abort();
  const run = srcRun = { ctl: new AbortController(), touched: false };
  const box = $('.plist');
  const rows = [{ site: d.site, id: d.id, siteName: d.siteName, remarks: d.remarks, cur: 1, url: cur.eps[epNow]?.url || '' }, ...srcAlts.map(a => ({ ...a }))];
  const alive = () => srcRun === run && !box.hidden && box.dataset.mode === 'src';
  const slotOf = r => $$('.pitems button', box)[rows.indexOf(r)];
  const draw = () => {
    box.classList.remove('live', 'skipset'); box.classList.add('srcs'); box.dataset.mode = 'src';
    box.innerHTML = `<div class="phead"><i class="grab"></i><b>切换源</b><span>${rows.length} 个源</span><span class="mre" data-retest role="button" tabindex="0" title="重新测速">重测</span></div>
      <div class="srctip" hidden></div>
      <div class="pitems">${rows.map((a, i) => `<button data-i="${i}" class="${a.cur ? 'on' : ''}"><span class="sn"><b>${esc(a.siteName)}</b>${a.cur ? '<u>当前</u>' : ''}<s class="best" hidden>最快</s>${a.remarks ? `<small>${esc(a.remarks)}</small>` : ''}</span><span class="netslot">${netCell(a.net)}</span></button>`).join('')}</div>`;
    $('[data-retest]', box).onclick = () => { rows.forEach(r => { r.net = { busy: 1 }; r.best = false; }); draw(); testAll(true); };
    box.onpointerdown = () => { run.touched = true; };
    $$('.pitems button', box).forEach(b => b.onclick = () => {
      const a = rows[+b.dataset.i];
      if (a.cur) return togglePlist(false);
      run.ctl.abort(); switchSrc(a.site, a.id);
    });
  };
  const apply = (r, res) => {
    r.net = res.skip ? { skip: res.skip } : res.ok ? { lv: netLevel(res), ms: res.ms, tip: `首包 ${res.ms} ms · 下载约 ${((res.kbps || 0) / 1000).toFixed(1)} Mbps` } : { lv: 0, err: res.error || '连不上', tip: res.error || '连不上' };
    if (!alive()) return;
    const cell = slotOf(r)?.querySelector('.netslot'); if (cell) cell.innerHTML = netCell(r.net);
  };
  const finish = () => {
    if (!alive()) return;
    const ok = rows.filter(r => r.net && r.net.lv > 0);
    const best = ok.length > 1 ? ok.slice().sort((x, y) => y.net.lv - x.net.lv || x.net.ms - y.net.ms)[0] : null;
    rows.forEach(r => { r.best = r === best; });
    // 没动过列表就按网络好坏重排 (当前源始终在最上面)；动过就别让行跳来跳去
    if (!run.touched) { const head = rows.shift(); rows.sort((x, y) => (y.net?.lv || 0) - (x.net?.lv || 0) || (x.net?.ms || 1e9) - (y.net?.ms || 1e9)); rows.unshift(head); draw(); }
    $$('.pitems button', box).forEach((b, i) => { $('.best', b).hidden = !rows[i].best; });
    const me = rows.find(r => r.cur), tip = $('.srctip', box);
    if (me && me.net && me.net.lv === 0 && best && best.net.lv >= 3) {
      tip.hidden = false;
      tip.innerHTML = `<span>当前源连不上，「${esc(best.siteName)}」${NET_TXT[best.net.lv]}</span><button type="button">换过去</button>`;
      $('button', tip).onclick = () => { run.ctl.abort(); switchSrc(best.site, best.id); };
    }
  };
  async function testOne(r, fresh) {
    try {
      let url = r.url;
      if (!url) {
        const dd = await api('detail', { site: r.site, id: r.id }, run.ctl.signal), ln = dd?.lines?.[0];
        url = ln?.episodes?.[Math.min(epNow, (ln.episodes.length || 1) - 1)]?.url || ''; r.url = url;
      }
      if (!url) return apply(r, { ok: false, error: '没有资源' });
      if (!/^https?:\/\//i.test(url)) return apply(r, { skip: '本地文件' });
      apply(r, await api('speed', { u: url, ...(fresh ? { fresh: 1 } : {}) }, run.ctl.signal));
    } catch (e) { if (!isAbort(e)) apply(r, { ok: false, error: '连不上' }); }
  }
  async function testAll(fresh) {
    const queue = rows.slice();
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => { while (queue.length && alive()) await testOne(queue.shift(), fresh); }));
    finish();
  }
  rows.forEach(r => { r.net = { busy: 1 }; });
  draw();
  togglePlist(true);
  testAll(false);
}
// 换到另一个源播放: 选集 / 线路跟着新片源走, 顶栏的「当前源」不动；进度接着看 (超过 5 秒才带)
async function switchSrc(site, id) {
  togglePlist(false);
  const ep = cur?.ep || 0, t = video.currentTime || 0;
  const tt = toast('正在切换到另一个源…', true);
  try {
    const d = await api('detail', { site, id });
    tt.remove();
    if (!d || !d.lines?.length) return toast('这个源也放不了，再换一个试试');
    const e = Math.min(ep, Math.max(0, d.lines[0].episodes.length - 1));
    if (t > 5 && e === ep) playAt(d, 0, e, Math.max(0, t - 2)); else play(d, 0, e);
  } catch (err) { tt.remove(); toast(err.message); }
}
// 成人源 only: until the first frame is on screen the card's cover is shown (blurred backdrop + the sharp picture), not a black screen.
// Hidden again by the first 'playing' / 'loadeddata' frame, and for live channels / local files without a cover.
const pcover = $('.pcover');
function showCover(url) {
  if (!pcover) return;
  if (!url) { pcover.hidden = true; return; }
  const small = dbSize(url, 's') || url, big = dbSize(url, 'l') || url;
  $('.pcbg', pcover).style.cssText = bg(small);
  $('.pcimg', pcover).style.cssText = big === small ? bg(small) : `background-image:${cssUrl(big)},${cssUrl(small)}`;
  pcover.classList.remove('gone'); pcover.hidden = false;
}
function hideCover() { if (!pcover || pcover.hidden) return; pcover.classList.add('gone'); setTimeout(() => { if (pcover.classList.contains('gone')) pcover.hidden = true; }, 260); }
// 致命错误先让 hls.js 自己恢复 (网络抖动 / 解码器卡住), 各最多两次; 恢复不了才换线路 / 报错。
function hlsRecover(h, data) {
  const t = h._rec || (h._rec = { net: 0, media: 0 });
  if (data.type === Hls.ErrorTypes.NETWORK_ERROR && t.net++ < 2) { h.startLoad(); return true; }
  if (data.type === Hls.ErrorTypes.MEDIA_ERROR && t.media++ < 2) { if (t.media === 2) h.swapAudioCodec?.(); h.recoverMediaError(); return true; }
  return false;
}
let loadMuteT = 0, flashT = 0, lastRebuild = 0;
const STALL_ERR = /^(bufferStalledError|bufferSeekOverHole|bufferNudgeOnStall|bufferAppendError|fragLoadError|fragLoadTimeOut|fragParsingError)$/;
const REBUILD_CC = 6;   // 跨过多少个断点后重建一次 (断点二十来秒一个, 约 2 分钟); 没有断点的源永远不会触发
// 跨过 #EXT-X-DISCONTINUITY (不少采集源每二十来秒就断一次): 音频解码器重开, 会蹦一下「电流声」。
// 和拖动时一样: 先静音一小会儿再恢复, 不动音量, 也不改动用户的静音设置。
function duckFlash(ms = 600) {
  video._duck = 1; if (!video.muted) video.muted = true;
  clearTimeout(flashT);
  flashT = setTimeout(() => { if (video._duck) video._unduck?.(); }, ms);
}
// rebuild: 播放中悄悄重建 (见 FRAG_CHANGED 里的说明): 不弹「加载中」、不盖封面, 倍速保留
let lastLoad = null;
function load(url, startAt, viaProxy, isLocal, rebuild = false, native = false) {
  lastLoad = { url, viaProxy, isLocal };
  const keepRate = rebuild ? video.playbackRate : 0;
  // 换源 / 换线路 / 重新加载: 先把旧解码器彻底断开并静音, 新画面接上的瞬间就不会有「电流声」; 有画面后恢复原来的静音状态
  video._duck = 1; video.muted = true;
  clearTimeout(loadMuteT);
  const undo = () => { clearTimeout(loadMuteT); loadMuteT = setTimeout(() => { if (video._duck) video._unduck?.(); }, 300); };
  for (const ev of ['playing', 'loadeddata', 'error']) video.addEventListener(ev, undo, { once: true });
  if (hls) { hls.destroy(); hls = null; }
  video.onerror = null; video.onloadedmetadata = null;
  video.removeAttribute('src'); video.load();
  const src = viaProxy ? '/hls?u=' + encodeURIComponent(url) : url;
  // 本地媒体 originals (/media/f/…) play natively; /media/h/… is a growing HLS playlist, start at its beginning.
  const direct = /\.mp4(\?|$)/i.test(url) || url.startsWith('/media/f/');
  playingSrc = { src, hls: !direct };
  pvReset();
  if (!rebuild) { msg('加载中…'); showCover(cur?.kind === 'vod' && cur.d?.adult ? cardPic(cur.d) : ''); }   // adult sources only
  fixDuration(video, url.startsWith('/media/h/') ? url : '');
  const seek = () => { if (startAt) video.currentTime = startAt; if (keepRate) video.playbackRate = keepRate; video.play().catch(() => msg('点一下播放')); };
  const retry = why => { if (!viaProxy && !isLocal) { msg('直连失败，改走中转…'); load(url, startAt, true); } else msg('播放失败：' + why + '。换一集或换个源试试', true); };
  if (window.Hls && Hls.isSupported() && !direct && !native) {
    // 缓冲只留近处: 向前最多 30 秒 / 30MB, 向后只留 30 秒。码率高的源 (2~3Mbps) 如果让它一路缓冲下去, 几分钟后音频
    // SourceBuffer 先满, 浏览器被迫丢旧数据, 音频出现缺口, 之后就是一段「电流声」; 刷新后缓冲清空又正常。
    hls = new Hls({ maxBufferLength: 30, maxMaxBufferLength: 60, maxBufferSize: 30 * 1000 * 1000, backBufferLength: 30, enableWorker: true, maxAudioFramesDrift: 8, ...(url.startsWith('/media/h/') || rebuild ? { startPosition: startAt || 0 } : {}) });
    hls.on(Hls.Events.MANIFEST_PARSED, seek);
    // 每跨一个断点静音挡一下, 蹦的一声就听不到了
    // 有的源每二十来秒一个断点 (#EXT-X-DISCONTINUITY), 浏览器里音频时间轴每跨一次就比画面多落后一点点 (实测约 0.15 秒 / 100 秒),
    // 连续看十来分钟后每个断点处都会「电流」一下, 一直到刷新或暂停很久才恢复。刷新其实就是把时间轴清零: 这里跨过 REBUILD_CC 个断点后,
    // 在断点处 (本来就是不连续的位置) 静音、销毁并重建播放链路, 回到当前位置接着放, 把偏差清零。
    let cc = null, crossed = 0;
    const me = hls;
    // 卡顿 (缓冲见底 / 跳过空洞 / 分片加载失败) 之后, 浏览器里的音频时间轴会错位, 一直「电流声」, 拖进度条也没用, 刷新才好。
    // 和上面断点累积是同一个病根: 卡顿一过 (恢复播放 2 秒后) 同样悄悄重建一次, 回到当前位置接着放。
    hls.on(Hls.Events.FRAG_CHANGED, () => {
      if (me.dirty && me === hls && Date.now() - me.dirty > 1500 && !video.paused && !video.seeking && !isLocal && cur?.kind === 'vod' && Date.now() - lastRebuild > 60e3) {
        lastRebuild = Date.now();
        return load(url, video.currentTime + 0.15, viaProxy, isLocal, true);
      }
    });
    hls.on(Hls.Events.FRAG_CHANGED, (_, d) => {
      const c = d.frag?.cc;
      if (cc !== null && c !== undefined && c !== cc) {
        duckFlash();
        // 只在点播里重建 (直播没有「当前位置」可回, 本地转码流本身没有这个问题)
        if (++crossed >= REBUILD_CC && me === hls && !isLocal && cur?.kind === 'vod' && !video.paused && !video.seeking && Date.now() - lastRebuild > 60e3) {
          lastRebuild = Date.now();
          const at = video.currentTime + 0.15;
          return load(url, at, viaProxy, isLocal, true);
        }
      }
      cc = c ?? cc;
    });
    hls.on(Hls.Events.ERROR, (_, data) => {
      (me.errs || (me.errs = [])).push([Math.round(video.currentTime), data.details, data.fatal ? 1 : 0]); if (me.errs.length > 30) me.errs.shift();
      if (!data.fatal && STALL_ERR.test(data.details || '')) me.dirty = Date.now();
      if (data.fatal && !hlsRecover(hls, data)) retry(data.details);
    });
    hls.loadSource(src); hls.attachMedia(video);
  } else {
    video.src = src;
    video.onloadedmetadata = seek;
    video.onerror = () => retry('无法解码');
  }
}
video.addEventListener('playing', () => { clearTimeout(stuckT); msg(''); });
video.addEventListener('timeupdate', () => { if (video.currentTime > 0 && video.readyState >= 2) hideCover(); });
video.addEventListener('playing', hideCover);
video.addEventListener('error', hideCover);
// 卡顿的判定: 一次缓冲超过 0.8 秒, 或者 90 秒内缓冲了 3 次 (网络差的源是一连串的小卡顿, 单次都不长)
let waitAt = 0, stalls = [];
video.addEventListener('waiting', () => { waitAt = waitAt || Date.now(); if (!msgAct) msg('缓冲中…'); });
video.addEventListener('playing', () => {
  const ms = waitAt ? Date.now() - waitAt : 0; waitAt = 0;
  if (!hls || Date.now() - lastRebuild < 15e3) return;
  if (ms > 300) { stalls.push(Date.now()); stalls = stalls.filter(t => Date.now() - t < 90e3); }
  if (ms > 800 || stalls.length >= 3) { hls.dirty = Date.now(); stalls = []; }
});
// 播着播着死在原地 (声音和画面一起僵住, 刷新才好): 实测 (魔都 JOJO 在 113.5 秒) 是这个源的一段音频缺了, 音频缓冲到 113.5、视频已缓冲到 117.1,
// 浏览器的可播放区间就停在音频空洞前; hls.js 只微调 3 次就放弃, hls 自己闲在 IDLE 也不会再去取。拖进度条拖回去也一样会再卡在这里。
// 判定: 暂停之外的「时间几乎不动 + hls 没在加载 + 数据不够播」超过 4 秒。先看音频 / 视频缓冲谁先断:
//   差 1 秒以上 → 跳过空洞 (到较长那条缓冲的末尾), 丢掉的只是那一小段缺声音的画面; 否则 → 在当前位置悄悄重建播放链路。
setInterval(() => {
  const st = hls?.streamController?.state;
  if (!hls || !cur || cur.kind !== 'vod' || player.hidden || video.paused || video.ended || !lastLoad || lastLoad.isLocal || st !== 'IDLE' || video.readyState >= 3) { wdAt = 0; return; }
  const t = video.currentTime;
  if (!wdAt || Math.abs(t - wdT) > 0.6) { wdAt = Date.now(); wdT = t; return; }   // 0.6: hls.js 的微调每次挪 0.1 秒, 不算在动
  const d = vdur(video);
  if (Date.now() - wdAt < 4000 || (d > 0 && t >= d - 1)) return;
  wdAt = 0;
  const sb = hls.bufferController?.sourceBuffer || {}, endOf = k => { const b = sb[k]?.buffered; let e = 0; for (let i = 0; b && i < b.length; i++) if (b.start(i) <= t + 0.6 && b.end(i) > e) e = b.end(i); return e; };
  const ae = endOf('audio'), ve = endOf('video'), far = Math.max(ae, ve);
  if (ae && ve && Math.abs(ae - ve) > 1) { hls.errs?.push([Math.round(t), 'avGapJump', 0]); video.currentTime = far + 0.3; return; }
  if (Date.now() - lastRebuild > 10e3) { lastRebuild = Date.now(); load(lastLoad.url, t, lastLoad.viaProxy, lastLoad.isLocal, true); }
}, 1000);
let wdAt = 0, wdT = 0;
// 排查用: 控制台里运行 avDiag(), 听到电流声时看一眼 音频 / 视频 的缓冲区是否对得上、有没有空洞、hls 报过什么
window.avDiag = () => { const sb = hls?.bufferController?.sourceBuffer || {}, r = b => b ? [...Array(b.length).keys()].map(i => [+b.start(i).toFixed(2), +b.end(i).toFixed(2)]) : null;
  return { t: +video.currentTime.toFixed(2), rate: video.playbackRate, audio: r(sb.audio?.buffered), video: r(sb.video?.buffered), errors: hls?.errs, dirty: !!hls?.dirty, lastRebuild: lastRebuild && Math.round((Date.now() - lastRebuild) / 1000) + 's ago' }; };
video.addEventListener('ended', () => { if (cur && cur.ep < cur.eps.length - 1) step(1); });
let lastSave = 0;
video.addEventListener('timeupdate', () => {
  if (!cur || cur.kind !== 'vod' || Date.now() - lastSave < 4000 || !vdur(video)) return;
  lastSave = Date.now();
  const { d, line, ep, eps } = cur;
  hist.put({ site: d.site, adult: d.adult ? 1 : 0, siteName: d.siteName, id: d.id, name: d.name, pic: d.pic, remarks: d.remarks, year: d.year,
    line, ep, epName: eps[ep].name, t: video.currentTime, dur: vdur(video) });
});
// ---------- 自动跳过片头 / 片尾 / 每集重复的广告 ----------
// 服务端拿相邻两集的音频做指纹, 找出两集里一模一样的片段 (片头曲、片尾曲、每集都插的同一条广告), 算好后缓存。
// 选集少于 3 集不做。这里只管问结果、播放到那一段时自动跳过 (每一段只跳一次, 跳完想回看不会再拦)。只有点播多集、普通播放器用; 沉浸看片不用。
let ask = null;
// 广告 (skipAd) 和片头片尾 (skipHT) 分开设置, 进度条上的标记不受开关影响 (关着也标出来, 只是不跳)。旧的总开关 autoSkip 当作两者的默认值。
const skipHT = () => (localStorage.skipHT ?? localStorage.autoSkip) !== '0';
const skipAd = () => (localStorage.skipAd ?? localStorage.autoSkip) !== '0';
function paintSkip() { const b = $('[data-act=skipt]'); if (!b) return; const on = skipHT() || skipAd(); b.classList.toggle('on', on); setL('skipt', on ? '自动跳过' : '不跳过'); }
// 数据的获取 (ask 里留着复用, 同一集不重复问):
//  ad  片源拼进 m3u8 的广告: 读一次播放列表, 很轻, 不管开关都问 (为了标记), 不需要选集门槛
//  fp  片头 / 片尾的音频指纹: 重活 (服务端要下载整段音频)。开着才让服务端去算; 关着只用 peek 看看服务端有没有现成的缓存 (只为标记), 要 3 集以上
function skipInit() {
  skipStop();
  const e = cur.eps[cur.ep], n = cur.eps[cur.ep + 1] || cur.eps[cur.ep - 1];
  const ok = cur.kind === 'vod' && !cur.d.local && /^https?:/.test(e.url);
  const fp = ok && cur.eps.length >= 3 && n && /^https?:/.test(n.url);
  $('[data-act=skipt]').hidden = !ok;
  ask = ok ? { tok: Math.random(), u: e.url, n: fp ? n.url : '', head: [], tail: [], mid: [], done: new Set(), adGot: false, adBusy: false, adTries: 0, adT: 0, fpGot: false, peeked: false, tries: 0, timer: 0, t0: Date.now() } : null;
  if (ok) { paintSkip(); skipKick(); }
}
// 自动跳过设置: 顶栏一个按钮, 点开浮窗 (大屏在右侧, 小屏从底部上拉), 里面两个开关。复用选集 / 换源用的 .plist 面板, 样式和关闭方式都一致
const skipUiOpen = () => { const b = $('.plist'); return !b.hidden && b.dataset.mode === 'skip'; };
function skipState() {
  const A = ask; if (!A) return [];
  const n = x => x.length;
  return [
    { key: 'skipHT', name: '跳过片头 / 片尾', on: skipHT(),
      sub: !A.n ? '选集要 3 集以上才能识别' : A.fpGot ? (n(A.head) + n(A.tail) ? `已识别 ${n(A.head) ? '片头 ' : ''}${n(A.tail) ? '片尾' : ''}`.trim() : '这一集没识别到') : skipHT() ? '识别中，稍等…' : '开启后才会分析' },
    { key: 'skipAd', name: '跳过广告', on: skipAd(),
      sub: A.adGot ? (n(A.mid) ? `发现 ${n(A.mid)} 段广告` : '没有发现广告') : '检测中…' },
  ];
}
function drawSkip() {
  const box = $('.plist');
  box.dataset.mode = 'skip'; box.classList.remove('live', 'srcs'); box.classList.add('skipset');
  box.innerHTML = `<div class="phead"><i class="grab"></i><b>自动跳过</b><span>进度条上标出位置</span><button class="icon sm" data-pclose title="关闭">✕</button></div>
    <div class="pitems">${skipState().map(r => `<button data-k="${r.key}" role="switch" aria-checked="${r.on}"><span class="sn"><b>${r.name}</b><small>${esc(r.sub)}</small></span><i class="tgl${r.on ? ' on' : ''}"></i></button>`).join('')}</div>`;
  $('[data-pclose]', box).onclick = () => togglePlist(false);
  $$('.pitems button', box).forEach(b => b.onclick = () => {
    const k = b.dataset.k, on = (k === 'skipAd' ? skipAd() : skipHT()) ? '0' : '1';
    localStorage[k] = on; paintSkip(); skipKick(); if (!skipHT()) skipStopFp(); drawSkip();
  });
}
function openSkipSheet() {
  if (!ask) return;
  if (skipUiOpen()) return togglePlist(false);
  drawSkip(); togglePlist(true);
}
function skipStopFp() { if (ask) { clearTimeout(ask.timer); ask.timer = 0; } }
function skipStop() { if (ask) { skipStopFp(); clearTimeout(ask.adT); ask.adT = 0; } }
function skipKick() {
  if (!ask) return;
  const A = ask, tok = A.tok;
  if (!A.adGot && !A.adBusy) {
    A.adBusy = true;
    api('adsegs', { u: A.u }, null).then(r => { if (ask?.tok === tok) { A.mid = r?.ads || []; A.adGot = !r?.err; paintMarks(); } }, () => {})
      .finally(() => { A.adBusy = false; if (ask?.tok === tok && !A.adGot && ++A.adTries < 3 && !A.adT) A.adT = setTimeout(() => { A.adT = 0; skipKick(); }, 5000); });
  }
  if (!A.n || A.fpGot) return;
  if (!skipHT()) {                                    // 关着: 只看服务端有没有现成的, 没有就算了, 绝不触发计算
    if (!A.peeked) { A.peeked = true; api('skipmarks', { u: A.u, n: A.n, peek: 1 }, null).then(r => { if (ask?.tok === tok && r?.status === 'ready') { A.head = r.head || []; A.tail = r.tail || []; A.fpGot = true; paintMarks(); } }, () => {}); }
    return;
  }
  if (!A.timer && A.tries < 40) A.timer = setTimeout(() => skipFetch(tok), Math.max(0, 8000 - (Date.now() - A.t0)));   // 先让正片稳稳播起来, 再去问
}
function skipFetch(tok) {
  const A = ask; if (!A || A.tok !== tok) return;
  A.timer = 0;
  if (!skipHT()) return;
  api('skipmarks', { u: A.u, n: A.n }, null).then(r => {
    if (ask?.tok !== tok) return;
    if (r.status === 'ready') { A.head = r.head || []; A.tail = r.tail || []; A.fpGot = true; paintMarks(); }
    else if (r.status === 'none') { A.fpGot = true; if (skipUiOpen()) drawSkip(); }     // 算不了 (太短 / 没音轨 / 排队满): 不再追问
    else if (r.status === 'pending' && ++A.tries < 40 && skipHT()) A.timer = setTimeout(() => skipFetch(tok), 15000);
  }).catch(() => {});
}
// 把声音指纹的结果 (片头 / 片尾) 和播放列表里认出的广告对起来:
//  1. 指纹会把「每集都一样的广告」也当成片头 / 片尾 (实测: 开头 5 分钟里的广告被报成第二段片头): 和广告重叠一半以上的剔掉, 只当广告
//  2. 片头最多留 2 段 (最长的), 片尾 1 段
//  3. 片尾后面的广告并进片尾: 紧跟着 (间隔 ≤ 30 秒) 或者是视频最后的那条广告 (间隔 ≤ 120 秒, 中间多半是下集预告) 都并入, 一起标、一起跳到结尾
// 返回 { head, tail, mid (画标记用, 已并入片尾的不再单画), ads (跳过用, 全部) }
function marksOf(d = vdur(video)) {
  const ads = (ask.mid || []).map(r => [...r]).sort((x, y) => x[0] - y[0]);
  const isAd = r => ads.some(x => Math.min(r[1], x[1]) - Math.max(r[0], x[0]) >= (r[1] - r[0]) * .5);
  const longest = (l, n) => l.slice().sort((x, y) => (y[1] - y[0]) - (x[1] - x[0])).slice(0, n).sort((x, y) => x[0] - y[0]);
  const head = longest((ask.head || []).filter(r => !isAd(r)), 2);
  const tail = longest((ask.tail || []).filter(r => !isAd(r)), 1).map(r => [...r]);
  for (const t of tail) for (const x of ads) {
    if (x[0] < t[0] - 1 || x[1] <= t[1]) continue;
    const gap = x[0] - t[1], last = isFinite(d) && x[1] >= d - 3;
    if (gap < 30 || (last && gap < 120)) t[1] = x[1];
  }
  const merged = x => tail.some(t => x[0] >= t[0] - 1 && x[1] <= t[1] + 0.5);
  return { head, tail, mid: ads.filter(x => !merged(x)), ads };
}
// 进度条上标出片头 / 片尾 (青色) 和广告 (琥珀色); 位置没变就不重画
const marksEl = $('.tl .marks'); let marksKey = '';
function paintMarks(d = vdur(video)) {
  const M = ask && d > 0 && isFinite(d) && isVodTime() ? marksOf(d) : null, list = M ? [['h', M.head], ['a', M.mid], ['h', M.tail]] : [];
  const key = list.map(([, l]) => JSON.stringify(l)).join('|') + '/' + Math.round(d);
  if (key === marksKey) return;
  marksKey = key;
  if (skipUiOpen()) drawSkip();
  marksEl.innerHTML = list.flatMap(([k, l]) => l.map(r => `<i class="${k}" style="left:${Math.max(0, r[0] / d * 100)}%;width:${Math.max(0.4, (Math.min(r[1], d) - r[0]) / d * 100)}%"></i>`)).join('');
}
// t 秒落在哪类段里 (预览浮层的时间后面带上类型)
function markAt(t) {
  if (!ask) return '';
  const M = marksOf();
  for (const [name, list] of [['片头', M.head], ['广告', M.mid], ['片尾', M.tail]]) if (list.some(r => t >= r[0] && t < r[1])) return name;
  return '';
}
video.addEventListener('timeupdate', () => {
  if (!ask || (!ask.head.length && !ask.tail.length && !ask.mid.length) || scrubbing || video.seeking) return;
  const t = video.currentTime, d = vdur(video), M = marksOf();
  for (const [name, list] of [['片头', skipHT() ? M.head : []], ['广告', skipAd() ? M.ads : []], ['片尾', skipHT() ? M.tail : []]]) for (const r of list) {
    const id = name + r[0];
    if (ask.done.has(id) || t < r[0] - 0.3 || t >= r[1] - 2) continue;
    ask.done.add(id);
    duckFlash(); video.currentTime = r[1] >= d - 1 ? d : r[1];   // 跳的瞬间先静音一小会儿, 不要「啪」一声
    return toast('已跳过' + name);
  }
});

function step(n) { cur.ep = Math.max(0, Math.min(cur.eps.length - 1, cur.ep + n)); openPlayer(0); }
// Episode / channel picker. Live: numbered single column with a filter; 点播: compact grid.
// Picking closes the panel; click outside or Esc also closes it.
function renderPlist() {
  const box = $('.plist'), live = cur.kind === 'live';
  box.dataset.mode = 'ep'; box.classList.remove('srcs', 'skipset');
  box.classList.toggle('live', live);
  box.innerHTML = `<div class="phead"><i class="grab"></i><b>${live ? '频道' : '选集'}</b><span>${cur.ep + 1} / ${cur.eps.length}</span>
      <button class="icon sm" data-pclose title="关闭">✕</button></div>
    ${live || cur.eps.length > 20 ? `<input class="pfind" type="search" enterkeyhint="search" autocomplete="off" placeholder="${live ? '搜频道' : '搜集数'}">` : ''}
    <div class="pitems">${cur.eps.map((e, i) => `<button data-i="${i}" class="${i === cur.ep ? 'on' : ''}">${live ? `<em>${i + 1}</em>` : ''}<span>${esc(e.name)}</span></button>`).join('')}</div>`;
  $('[data-pclose]', box).onclick = () => togglePlist(false);
  $$('.pitems button', box).forEach(b => b.onclick = () => { cur.ep = +b.dataset.i; togglePlist(false); openPlayer(0); });
  const find = $('.pfind', box);
  if (find) find.oninput = () => {
    const q = find.value.trim().toLowerCase();
    $$('.pitems button', box).forEach(b => { b.hidden = !!q && !cur.eps[+b.dataset.i].name.toLowerCase().includes(q) && String(+b.dataset.i + 1) !== q; });
  };
}
function togglePlist(open = $('.plist').hidden) {
  const box = $('.plist');
  if (open) sysClose();
  box.hidden = !open;
  $('[data-act=list]').classList.toggle('on', open && box.dataset.mode === 'ep');
  player.classList.toggle('plopen', open);
  player.classList.toggle('srcopen', open && box.dataset.mode === 'src');
  if (open) {
    const list = $('.pitems', box), on = $('.pitems .on', box);   // 不用 scrollIntoView (会连播放器容器一起滚走)
    if (list && on) list.scrollTop = on.offsetTop - list.offsetTop - (list.clientHeight - on.offsetHeight) / 2;
    player.scrollTop = 0; poke();
  }
}
function closePlayer() {
  skipStop(); ask = null;
  if (hls) { hls.destroy(); hls = null; }
  pvReset(); playingSrc = null;
  video.pause(); video.removeAttribute('src'); video.load();
  if (ms) { try { ms.metadata = null; ms.playbackState = 'none'; } catch {} }
  if (pipOn) { pipOn = false; player.classList.remove('pip'); document.exitPictureInPicture?.().catch(() => {}); }
  setRot(false); player.hidden = true; togglePlist(false); sysClose(); clearTimeout(stuckT); msg(''); setLock(false); setBright(1); if (pcover) pcover.hidden = true;
  if (!$('#modal')) document.body.style.overflow = '';
  $('#modal')?.refresh?.();
  cur = null;
}
player.addEventListener('click', e => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'close') history.back();
  if (act === 'next') step(1);
  if (act === 'pip') togglePip();
  if (act === 'src') { $('.pmore').hidden = true; $('[data-act=more]').setAttribute('aria-expanded', false); return openSrcSheet(); }
  if (act === 'list') { if ($('.plist').dataset.mode !== 'ep') { renderPlist(); return togglePlist(true); } return togglePlist(); }
  if (act === 'ext') { video.pause(); return openLocal(cur.eps[cur.ep].url, 'play'); }
  if (act === 'share') {
    const c = cur.eps[cur.ep], live = cur.kind === 'live';
    const hash = live ? `#/tv/${encodeURIComponent(localStorage.live || '')}/${encodeURIComponent(c.url)}/${encodeURIComponent(c.name || '')}`
      : playHref(cur.d.site, cur.d.id, cur.line, cur.ep);
    $('.pmore').hidden = true; $('[data-act=more]').setAttribute('aria-expanded', false);
    const nm = live ? c.name || '' : [cur.d.name, cur.eps.length > 1 ? c.name : ''].filter(Boolean).join(' ');
    return shareNow(hash, nm);
  }
  if (act === 'vfav') { toast(favs.toggle(cur.d) ? '已收藏' : '已取消收藏'); return paintVodActs(); }
  if (act === 'dl') {
    const e = cur.eps[cur.ep], j = dlFor(cur.d.site, cur.d.id, e.url);
    if (j?.status === 'done') return toast('已下载，播放时会自动用本地文件');
    if (j) return req('PATCH', `/api/downloads?id=${j.id}&action=${ACTIVE.includes(j.status) ? 'pause' : 'resume'}`).then(() => refreshDownloads()).then(paintVodActs, err => toast(err.message));
    return enqueue(cur.d, cur.line, [cur.ep]).then(paintVodActs, err => toast(err.message));
  }
  if (act === 'star') { const c = cur.eps[cur.ep]; toast(liveFavs.toggle(c) ? '已收藏' : '已取消收藏'); paintStar(liveFavs.has(c.url)); return; }
  if (act === 'more') { sysClose(); const m = $('.pmore'); m.hidden = !m.hidden; e.target.closest('[data-act]').setAttribute('aria-expanded', !m.hidden); return; }
  if (act === 'rate') return cycleRate();
  if (act === 'skipt') { $('.pmore').hidden = true; $('[data-act=more]').setAttribute('aria-expanded', false); return openSkipSheet(); }
  if (act === 'fs') return toggleFs();
  if (act === 'cast') return sysToggle();
  if (act === 'lock') return setLock(true);
  if (!$('.pmore').hidden && !e.target.closest('.pmore, [data-act=more]')) { $('.pmore').hidden = true; $('[data-act=more]').setAttribute('aria-expanded', false); }
  if (!sysPanel.hidden && !e.target.closest('.psyspanel, .psys')) sysClose();
  if (!$('.plist').hidden && !e.target.closest('.plist, .pbar, .pacts')) togglePlist(false);
});
function poke() { player.classList.remove('idle'); clearTimeout(idleTimer); idleTimer = setTimeout(() => !video.paused && $('.plist').hidden && sysPanel.hidden && !scrubbing && !gesturing && !(fineCursor && ctrl.matches(':hover')) && player.classList.add('idle'), fineCursor ? 3000 : 4000); }
// touch: a tap on the picture shows / hides the controls (see below); only touches on the controls themselves keep them up
player.addEventListener('touchstart', e => { if (e.target.closest('.ctrl, .pbar, .pcenter, .plist')) poke(); }, { passive: true });

// ---------- player controls ----------
// Native controls can't tell us where the pointer is on the timeline, so the
// player gets its own bar. Hovering the timeline seeks a second, muted, lowest-quality copy of the stream
// to that moment and shows its frame (hover on a mouse, dragging on a touch screen).
const fineCursor = matchMedia('(hover: hover) and (pointer: fine)').matches;
if (fineCursor) player.addEventListener('mousemove', poke);   // (a tap also fires a compatibility mousemove: it would undo the tap-to-hide)
const ctrl = $('.ctrl'), tl = $('.tl'), tip = $('.tip'), seekV = $('.tip video');
let playingSrc = null, pvHls = null, pvKey = '', pvWant = null, pvBusy = false, pvTimer = 0, scrubbing = false;
// Every screen gets the same custom player (Netflix-style). On touch screens the centre carries the transport buttons, the
// timeline sits well above the bottom edge (iPhone's home-bar swipe lives there) and the picture takes gestures.
video.controls = false;
let gesturing = false;
document.documentElement.classList.toggle('touchui', !fineCursor);
const pacts = $('.pacts');
if (!fineCursor) {
  // 触屏: 顶栏右上角「更多」(浮窗向下展开: 收藏 / 下载 / 分享 / 自动跳过 / 小窗); 底栏 上一集 下一集 选集 倍速, 全屏贴在最右
  ctrl.append(pacts);
  const wrap = document.createElement('div'); wrap.className = 'pmorewrap';
  wrap.append($('[data-act=more]'), $('.pmore'));
  $('.pbar').append(wrap);
  $('.pmore').prepend($('[data-act=vfav]'), $('[data-act=star]'), $('[data-act=dl]'));
  $('.pmore').append($('[data-act=pip]'));
  pacts.insertBefore($('[data-act=rate]'), $('[data-act=fs]'));
}
else {
  $('[data-c=rate]').before($('[data-act=next]'), $('[data-act=list]'));   // 大屏: 选集在播放器下面, 倍速左边
  // 下载 / 分享 / 自动跳过 不管窗口多宽都收进「更多」，顶栏只留 收藏 和 更多
  setTimeout(() => { const more = $('.pmore'); for (const x of ['dl', 'share', 'skipt']) more.insertBefore($(`[data-act=${x}]`), $('[data-act=rate]', more)); syncMore?.(); });   // syncMore 在下面才定义，等本段跑完再排
}   // 右上角「更多」里放 下载 / 分享 / 自动跳过 / 切换源
// 「更多」里一个能点的都没有 (本地文件、浏览器没有小窗…) 就不显示这个按钮
const syncMore = () => { $('[data-act=more]').hidden = ![...$('.pmore').children].some(b => !b.hidden && !(fineCursor && b.dataset.act === 'rate')); };   // 大屏的倍速在控制条里，「更多」里只剩切换源
const syncFs = () => { const h = hideFs(); $('[data-act=fs]').hidden = h; $('[data-c=fs]').hidden = h; };
$('[data-c=pip]').hidden = !pipSupported();
syncFs();
video.addEventListener('loadedmetadata', () => { if (cur) $('[data-act=pip]').hidden = !pipSupported() || fineCursor; syncFs(); syncMore(); });
video.addEventListener('resize', syncFs);
// ---- 拖动 / 快进快退时的杂音处理 ----
// 远程 HLS 切换进度后偶尔有「电流音」: 一是连续的 seek 把解码器冲得太快 (滚轮 / 连按快进 / 拖动进度条), 二是跳转瞬间新旧音频接缝处的爆音。
// duckOnSeek: 一发生 seek 就静音, seek 完成 220ms 后恢复 (拖动中一直静音, 像大多数播放器那样); 只动 muted, 不动音量, 也不记进 playerMuted。
// seekBy: 连续的相对快进快退合并成一次, 140ms 内没有新的才真正跳。
function duckOnSeek(v, wantMuted) {
  let t = 0;
  const up = () => { clearTimeout(t); v._duck = 0; if (v.muted !== wantMuted()) v.muted = wantMuted(); };
  v.addEventListener('seeking', () => { clearTimeout(t); v._duck = 1; if (!v.muted) v.muted = true; t = setTimeout(up, 2500); });   // 2.5s: seeked 一直不来也要恢复
  v.addEventListener('seeked', () => { clearTimeout(t); t = setTimeout(up, 220); });
  v._unduck = up;
}
function seekBy(v, d, apply) {
  const dur = vdur(v), lim = dur > 0 && isFinite(dur) ? dur : Infinity;
  v._st = Math.max(0, Math.min(lim, (v._st ?? v.currentTime) + d));
  clearTimeout(v._stT);
  v._stT = setTimeout(() => { const x = v._st; v._st = undefined; v.currentTime = x; apply?.(x); }, 140);
  return v._st;
}
// 视频长度: 本地媒体边转码边播 (HLS EVENT 列表), 浏览器报的长度会随转码进度一路变长。服务端用 ffmpeg 读出真实长度 (probe),
// 记在 video._fixDur 上, 之后进度条 / 快进都按它走; 转码完成后浏览器自己的长度追上来, 取两者较大值。
function vdur(v) { if (!v) return NaN; const k = v._fixDur; return k > 0 ? Math.max(k, v.duration || 0) : v.duration; }
function fixDuration(v, url) {
  v._fixDur = 0; v._fixUrl = url;
  if (!url || !url.startsWith('/media/h/')) return;
  api('probe', { u: url }, null).then(r => { if (r && r.duration > 0 && v._fixUrl === url) { v._fixDur = r.duration; v.dispatchEvent(new Event('durationchange')); } }).catch(() => {});
}
const fmtT = s => { s = Math.max(0, Math.floor(s || 0)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = String(s % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`; };
const isVodTime = () => Number.isFinite(vdur(video)) && vdur(video) > 0;
function paintCtrl() {
  const d = vdur(video), t = video.currentTime;
  player.classList.toggle('paused', video.paused);
  player.classList.toggle('muted', (video.muted && !video._duck) || video.volume === 0);
  $('.vol').value = video.muted && !video._duck ? 0 : video.volume;
  tl.hidden = !isVodTime();
  $('.rem').textContent = isVodTime() ? '-' + fmtT(d - t) : cur?.kind === 'live' ? '● 直播' : '';
  if (!isVodTime()) return;
  if (!scrubbing) tl.style.setProperty('--p', (t / d) * 100 + '%');
  let end = 0;
  for (let i = 0; i < video.buffered.length; i++) if (video.buffered.start(i) <= t + 1) end = Math.max(end, video.buffered.end(i));
  tl.style.setProperty('--b', (end / d) * 100 + '%');
  paintMarks(d);
}
for (const ev of ['timeupdate', 'durationchange', 'progress', 'play', 'pause', 'volumechange', 'loadedmetadata']) video.addEventListener(ev, paintCtrl);
// Volume and mute are remembered (localStorage) and shared with the 沉浸 player: restored once at start, saved on every change.
{
  const vol = parseFloat(localStorage.playerVolume);
  if (Number.isFinite(vol)) video.volume = Math.min(1, Math.max(0, vol));
  video.muted = localStorage.playerMuted === '1';
  video.addEventListener('volumechange', () => {
    if (video._duck) return;   // 拖动 / 跳转时的临时静音, 不记
    localStorage.playerMuted = video.muted ? '1' : '0';
    if (video.volume > 0) localStorage.playerVolume = String(+video.volume.toFixed(3));   // keep the last audible level through a mute
  });
}
duckOnSeek(video, () => localStorage.playerMuted === '1');
const togglePlay = () => (video.paused ? video.play().catch(() => {}) : video.pause());
// ---------- 全屏 + 手机上横屏视频自动横屏 ----------
// 点全屏：手机 / 小平板上的横屏视频，进全屏后把屏幕方向锁成横向（视频是竖屏的就不锁，保持竖着看）；退出全屏、换成竖屏视频时解锁。
// iPhone 只能让 <video> 自己全屏（系统播放器接管，横屏视频系统会自动转横屏）；其它浏览器全屏整个播放器，自带的控制条都在。
// 方向锁定只在全屏里有效（浏览器的限制），不支持的浏览器（如 iOS Safari）就保持系统默认，不报错。
const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement;
const phoneLike = () => !fineCursor && Math.min(screen.width, screen.height) <= 820;
const lockLandscape = () => { try { return screen.orientation?.lock ? screen.orientation.lock('landscape').then(() => true, () => false) : Promise.resolve(false); } catch { return Promise.resolve(false); } };
const unlockOrient = () => { try { screen.orientation?.unlock?.(); } catch {} };
// ---- 兜底：拿不到真横屏时，把播放器自己转 90° ----
// iPhone 没有元素全屏接口 (只能走系统播放器，那里没有我们的控制条，也不保证转屏)，安卓上方向锁也可能被拒。
// 这时手机竖着拿 + 横屏视频：把 #player 顺时针转 90° 铺满屏幕 (画面横过来、控制条还是我们自己的)；
// 手机本来就横着拿 (innerWidth > innerHeight) 不用转，旋转状态随屏幕方向自动开关。点全屏按钮 / 关闭播放器 / 退出全屏都会恢复。
// 转了之后触点坐标要换算：屏幕 (x, y) → 播放器内 (y, 屏宽 - x)，见 rotP / rotR。
let rotOn = false;
const portraitNow = () => innerHeight > innerWidth;
function syncRot() {
  const on = rotOn && portraitNow() && !player.hidden;
  player.classList.toggle('rot', on);
  if (on) { player.style.setProperty('--rw', innerWidth + 'px'); player.style.setProperty('--rh', innerHeight + 'px'); }
}
const setRot = on => { rotOn = on; syncRot(); };
addEventListener('resize', syncRot); addEventListener('orientationchange', () => setTimeout(syncRot, 120));
const rotP = e => player.classList.contains('rot') ? { x: e.clientY, y: innerWidth - e.clientX } : { x: e.clientX, y: e.clientY };
const rotR = el => {
  const r = el.getBoundingClientRect();
  if (!player.classList.contains('rot')) return r;
  const W = innerWidth;
  return { left: r.top, right: r.bottom, top: W - r.right, bottom: W - r.left, width: r.height, height: r.width };
};
// land: 视频还没出尺寸时 (刚从沉浸点「全屏观看」进来) 由调用方告诉我们它是不是横屏的
function enterFs(land) {
  const isLand = video.videoWidth ? video.videoWidth > video.videoHeight : land === true;
  const want = phoneLike() && isLand;
  const rq = player.requestFullscreen || player.webkitRequestFullscreen;
  if (rq) {
    let p; try { p = rq.call(player); } catch { p = null; }
    return Promise.resolve(p).then(async () => { if (want && !(await lockLandscape()) && portraitNow()) setRot(true); }, () => { if (want) setRot(true); });
  }
  if (want && portraitNow()) { setRot(true); return Promise.resolve(); }   // iPhone：没有元素全屏，自己转
  try { video.webkitEnterFullscreen?.(); } catch {}
  return Promise.resolve();
}
const toggleFs = () => {
  if (rotOn) return setRot(false);
  if (fsEl()) return (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  return enterFs();
};
const onFsChange = () => { if (!fsEl()) { unlockOrient(); setRot(false); } else if (phoneLike() && video.videoWidth) (video.videoWidth > video.videoHeight ? lockLandscape() : unlockOrient()); };
document.addEventListener('fullscreenchange', onFsChange);
document.addEventListener('webkitfullscreenchange', onFsChange);
video.addEventListener('loadedmetadata', () => { if (fsEl() && phoneLike()) (video.videoWidth > video.videoHeight ? lockLandscape() : unlockOrient()); });   // 全屏里换集 / 换源
// ---------- 系统连接：蓝牙 / 投屏（播放页右上角，类似 iOS 控制中心里的那两个图标）----------
// 网页能碰到的系统能力有限，能用的都接上，不能用的给出路：
//  · 投屏：Safari / iOS 走 AirPlay（弹系统的设备选择器）；Chrome / Edge 走 Remote Playback。浏览器用 MSE 在播（hls.js）时 Chrome 投不了，
//    这时给「复制播放地址 / 复制本页链接」和各系统自带的投屏入口。Safari 在 hls.js 播放时会先切回系统原生播放再弹选择器（AirPlay 只认原生）。
//  · 蓝牙：网页不能直接连蓝牙耳机，耳机的连接由系统管。能做的是：选择音频输出设备（蓝牙耳机 / 音箱在系统里连上后会出现在这里，
//    Chrome / Edge 桌面和部分安卓浏览器支持），以及用 Web Bluetooth 扫描附近的蓝牙设备；都不支持的浏览器给系统蓝牙入口的说明。
const canAirplay = typeof video.webkitShowPlaybackTargetPicker === 'function';
const canRemote = !!(video.remote && typeof video.remote.prompt === 'function');
const canSink = typeof video.setSinkId === 'function';
const canPickOut = !!(navigator.mediaDevices && navigator.mediaDevices.selectAudioOutput);
const canBle = !!navigator.bluetooth;
const isAndroid = /Android/i.test(navigator.userAgent), isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const sys = { open: '', castOn: false, castMsg: '', out: '', ble: '' };
try { const o = JSON.parse(localStorage.playerSink || 'null'); if (o && canSink) { sys.out = o.label || ''; video.setSinkId(o.id).catch(() => { sys.out = ''; localStorage.removeItem('playerSink'); sysPaint(); }); } } catch {}
function sysPaint() {
  const on = sys.castOn || !!(sys.out || sys.ble), b = $('[data-act=cast]');
  b.classList.toggle('on', on);
  b.title = sys.castOn ? '正在投屏' : sys.out || sys.ble ? '播放到：' + (sys.out || sys.ble) : '播放到…（投屏 / 蓝牙）';
}
if (canAirplay) video.addEventListener('webkitcurrentplaybacktargetiswirelesschanged', () => { sys.castOn = !!video.webkitCurrentPlaybackTargetIsWireless; sysPaint(); });
if (canRemote) for (const ev of ['connect', 'connecting', 'disconnect']) video.remote.addEventListener(ev, () => { sys.castOn = video.remote.state === 'connected'; sysPaint(); });
const streamUrl = () => { const u = cur?.eps?.[cur.ep]?.url || ''; try { return new URL(u, location.href).href; } catch { return u; } };
const pageLink = () => {
  const e = cur?.eps?.[cur.ep]; if (!e) return location.href;
  return shareUrl(cur.kind === 'live' ? `#/tv/${encodeURIComponent(localStorage.live || '')}/${encodeURIComponent(e.url)}/${encodeURIComponent(e.name || '')}` : cur.d ? playHref(cur.d.site, cur.d.id, cur.line, cur.ep) : '#/');
};
function sysClose() {
  sys.open = ''; sysPanel.hidden = true; player.classList.remove('sysopen');
  $('[data-act=cast]').classList.remove('open');
}
// 一个面板：上面是「这台设备 / 蓝牙耳机」(音频输出)，下面是「电视 / 投屏」。和 iOS 的 AirPlay 列表一样，设备都在一处选。
async function sysOpen() {
  sys.open = 'cast'; poke();
  $('.pmore').hidden = true; $('[data-act=more]').setAttribute('aria-expanded', false); if (!$('.plist').hidden) togglePlist(false);   // 一次只开一个浮层
  $('[data-act=cast]').classList.add('open');
  let outs = [];
  if (canSink && navigator.mediaDevices?.enumerateDevices) { try { outs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audiooutput'); } catch {} }
  if (sys.open !== 'cast') return;
  const outId = (() => { try { return JSON.parse(localStorage.playerSink || 'null')?.id || ''; } catch { return ''; } })();
  const named = outs.filter(d => d.deviceId && d.deviceId !== 'communications');
  const tips = isIOS ? '控制中心 → 屏幕镜像' : isAndroid ? '下拉通知栏 → 投屏' : 'Mac 控制中心 → 屏幕镜像 · Windows Win + K';
  const tick = '<span class="sp-ck">✓</span>';
  const btNote = !canPickOut && !canBle && !named.length ? `<p class="sp-note">蓝牙请在系统设置里连接，连上后声音自动从它出来。</p>` : '';
  sysPanel.innerHTML = `<div class="sp-h"><b>播放到</b><button class="icon sm" data-sp="x" aria-label="关闭">✕</button></div>
    <div class="sp-list">
      <button data-sink="" data-label="" class="${sys.out ? '' : 'on'}"><b>${isIOS || isAndroid ? '这台手机' : '这台电脑'}</b>${sys.out ? '' : tick}</button>
      ${named.filter(d => d.deviceId !== 'default').map((d, i) => `<button data-sink="${esc(d.deviceId)}" data-label="${esc(d.label || '')}" class="${outId === d.deviceId ? 'on' : ''}"><b>${esc(d.label || '输出设备 ' + (i + 1))}</b>${outId === d.deviceId ? tick : ''}</button>`).join('')}
      ${canPickOut ? '<button data-sp="pick"><b>蓝牙 / 其他音频设备…</b></button>' : ''}
      ${canBle ? `<button data-sp="ble"><b>${sys.ble ? '蓝牙：' + esc(sys.ble) : '扫描蓝牙设备…'}</b></button>` : ''}
      ${isAndroid ? '<a class="sp-a" href="intent:#Intent;action=android.settings.BLUETOOTH_SETTINGS;end"><b>系统蓝牙设置</b></a>' : ''}
    </div>${btNote}
    <div class="sp-sec">电视</div>
    <div class="sp-list"><button data-sp="copy-url"><b>复制播放地址</b></button><button data-sp="copy-page"><b>复制本页链接</b></button></div>
    <p class="sp-note">${esc(sys.castMsg || '浏览器不能直接投屏')} · ${esc(tips)}</p>`;
  sysPanel.hidden = false; player.classList.add('sysopen');
}
async function setSink(id, label) {
  try { await video.setSinkId(id); } catch (e) { return toast('这个设备用不了：' + (e.message || e.name)); }
  sys.out = id && id !== 'default' ? label || '已选择的设备' : '';
  if (sys.out) localStorage.playerSink = JSON.stringify({ id, label: sys.out }); else localStorage.removeItem('playerSink');
  sysPaint(); toast(sys.out ? '声音已切到：' + sys.out : '已改回这台设备输出'); sysOpen();
}
async function doCast() {
  sys.castMsg = '';
  // AirPlay 只认系统原生播放：hls.js (MSE) 在播就先切成原生 HLS (同一次点击里)，再弹选择器
  if (canAirplay) {
    if (hls && lastLoad && video.canPlayType('application/vnd.apple.mpegurl')) load(lastLoad.url, video.currentTime, lastLoad.viaProxy, lastLoad.isLocal, true, true);
    try { video.webkitShowPlaybackTargetPicker(); return; } catch {}
  }
  if (canRemote && !hls) {
    try { await video.remote.prompt(); return; }
    catch (e) {
      if (e.name === 'NotAllowedError') return;   // 用户把选择器关了
      sys.castMsg = e.name === 'NotFoundError' ? '没找到可投屏的设备（需在同一 Wi-Fi）' : '';
    }
  } else if (canRemote && hls) sys.castMsg = '网页内解码播放，浏览器无法直接投';
  sysOpen();
}
function sysToggle() {
  if (sys.open) return sysClose();
  doCast();
}
sysPanel.addEventListener('click', async e => {
  const b = e.target.closest('[data-sp], [data-sink]'); if (!b) return;
  const k = b.dataset.sp;
  if (k === 'x') return sysClose();
  if (b.dataset.sink != null) return setSink(b.dataset.sink, b.dataset.label);
  if (k === 'pick') { try { const d = await navigator.mediaDevices.selectAudioOutput(); await setSink(d.deviceId, d.label); } catch (err) { if (err.name !== 'NotAllowedError') toast('没选成：' + (err.message || err.name)); } return; }
  if (k === 'ble') {
    try { const d = await navigator.bluetooth.requestDevice({ acceptAllDevices: true }); sys.ble = d.name || '蓝牙设备'; sysPaint(); toast('已选择蓝牙设备：' + sys.ble); sysOpen(); d.addEventListener?.('gattserverdisconnected', () => { sys.ble = ''; sysPaint(); }); }
    catch (err) { if (err.name !== 'NotFoundError') toast('蓝牙没连上：' + (err.message || err.name)); }
    return;
  }
  if (k === 'copy-url') return copyText(streamUrl()).then(() => toast('播放地址已复制'), () => toast('复制失败'));
  if (k === 'copy-page') return copyText(pageLink()).then(() => toast('链接已复制'), () => toast('复制失败'));
});
navigator.mediaDevices?.addEventListener?.('devicechange', () => { if (sys.open) sysOpen(); });

const RATES = [1, 1.25, 1.5, 2, 0.75];
const cycleRate = () => { video.playbackRate = RATES[(RATES.indexOf(video.playbackRate) + 1) % RATES.length]; };
video.addEventListener('ratechange', () => { const t = video.playbackRate + 'x'; $('[data-c=rate]').textContent = t; setL('rate', t); $('[data-act=rate]').title = '倍速 ' + t; });
const onCtrl = e => {
  const c = e.target.closest('[data-c]')?.dataset.c; if (!c) return;
  e.stopPropagation(); poke();
  if (c === 'play') togglePlay();
  if (c === 'back') seekBy(video, -10);
  if (c === 'fwd') seekBy(video, 10);
  if (c === 'mute') { video._unduck?.(); video.muted = !video.muted; if (!video.muted && !video.volume) video.volume = 0.5; }
  if (c === 'fs') toggleFs();
  if (c === 'pip') togglePip();
  if (c === 'rate') cycleRate();
};
ctrl.addEventListener('click', onCtrl); $('.pcenter').addEventListener('click', onCtrl);
$('.vol').oninput = e => { video.volume = +e.target.value; video.muted = video.volume === 0; };
if (fineCursor) {
  video.addEventListener('click', () => { if (!player.hidden && $('.plist').hidden) { togglePlay(); poke(); } });
  video.addEventListener('dblclick', toggleFs);
}

// Timeline: hover → time + frame, press/drag → seek.
const tlFrac = e => { const r = rotR(tl); return Math.min(1, Math.max(0, (rotP(e).x - r.left) / r.width)); };
function hoverAt(e) { showAt(tlFrac(e)); }
function showAt(f) {
  if (!isVodTime()) return;
  const t = f * vdur(video), r = rotR(tl);
  tl.style.setProperty('--h', f * 100 + '%');
  tip.hidden = false;
  $('span', tip).textContent = fmtT(t) + (markAt(t) ? ' · ' + markAt(t) : '');   // 落在会被跳过的段里: 时间后面带上类型 (电脑悬停 / 手机拖动都走这里)
  const w = tip.offsetWidth;
  tip.style.left = Math.min(r.width - w / 2, Math.max(w / 2, f * r.width)) + 'px';
  previewAt(t);
}
tl.addEventListener('pointermove', e => { hoverAt(e); if (scrubbing) { tl.style.setProperty('--p', tlFrac(e) * 100 + '%'); } });
tl.addEventListener('pointerleave', () => { if (!scrubbing) { tip.hidden = true; tl.style.setProperty('--h', '0%'); } });
tl.addEventListener('pointerdown', e => {
  if (!isVodTime() || e.button !== 0) return;
  scrubbing = true; tl.setPointerCapture(e.pointerId); tl.classList.add('drag');
  tl.style.setProperty('--p', tlFrac(e) * 100 + '%'); hoverAt(e);
});
tl.addEventListener('pointerup', e => {
  if (!scrubbing) return;
  scrubbing = false; tl.classList.remove('drag');
  video.currentTime = tlFrac(e) * vdur(video);
  if (!fineCursor || !tl.matches(':hover')) { tip.hidden = true; tl.style.setProperty('--h', '0%'); }
});
tl.addEventListener('pointercancel', () => { scrubbing = false; tl.classList.remove('drag'); tip.hidden = true; tl.style.setProperty('--h', '0%'); });

// ---------- touch: gestures on the picture, double-tap skip, screen lock ----------
// Tap shows / hides the controls; double-tap the left / right side skips 10 s (middle: play / pause); a horizontal drag scrubs
// with the frame preview above the timeline; a vertical drag on the left side changes brightness, on the right side the volume.
// No pinch / double-tap zoom anywhere, and nothing starts within reach of the screen edges (iOS swipes live there).
const hud = $('.phud'), skipEl = $('.pskip'), lockBtn = $('.plock');
let bright = 1, hudTimer = 0, skipTimer = 0, lockTimer = 0;
const volOk = (() => { try { const v = document.createElement('video'); v.volume = .5; return v.volume === .5; } catch { return false; } })();   // iOS keeps volume to the hardware keys
const clamp01 = x => Math.min(1, Math.max(0, x));
function showHud(kind, f) {
  hud.dataset.k = kind; $('i', hud).style.width = f * 100 + '%'; hud.hidden = false;
  clearTimeout(hudTimer); hudTimer = setTimeout(() => { hud.hidden = true; }, 900);
}
function setBright(b) { bright = Math.min(1.6, Math.max(.25, b)); video.style.filter = bright === 1 ? '' : `brightness(${bright})`; }
function skip(n) {
  if (!isVodTime()) return;
  seekBy(video, n);
  skipEl.className = 'pskip ' + (n < 0 ? 'l' : 'r'); skipEl.textContent = (n < 0 ? '« ' : '') + Math.abs(n) + ' 秒' + (n > 0 ? ' »' : '');
  skipEl.hidden = false; void skipEl.offsetWidth; skipEl.classList.add('go');
  clearTimeout(skipTimer); skipTimer = setTimeout(() => { skipEl.hidden = true; }, 600);
}
function showLockBtn() { lockBtn.classList.add('show'); clearTimeout(lockTimer); lockTimer = setTimeout(() => lockBtn.classList.remove('show'), 2500); }
function setLock(on) {
  player.classList.toggle('locked', on); lockBtn.hidden = !on; lockBtn.classList.remove('show');
  if (on) { clearTimeout(idleTimer); togglePlist(false); showLockBtn(); } else poke();
}
lockBtn.onclick = e => { e.stopPropagation(); setLock(false); };
if (!fineCursor) {
  let g = null, lastTap = { t: 0, f: 0 }, tapTimer = 0;
  const EDGE = 26;
  video.addEventListener('pointerdown', e => {
    if (player.classList.contains('locked') || !$('.plist').hidden) return;
    const r = rotR(video), P = rotP(e);
    if (P.x - r.left < EDGE || r.right - P.x < EDGE || r.bottom - P.y < 80) return;
    g = { id: e.pointerId, x: P.x, y: P.y, r, axis: '', left: P.x - r.left < r.width / 2, t0: video.currentTime, b0: bright, v0: video.volume, target: 0 };
    video.setPointerCapture(e.pointerId);
  });
  video.addEventListener('pointermove', e => {
    if (!g || e.pointerId !== g.id) return;
    const P = rotP(e), dx = P.x - g.x, dy = P.y - g.y;
    if (!g.axis && Math.max(Math.abs(dx), Math.abs(dy)) > 10) g.axis = Math.abs(dx) > Math.abs(dy) ? (isVodTime() ? 'x' : 'none') : 'y';
    if (g.axis === 'x') {
      const d = vdur(video), span = Math.min(Math.max(d * .35, 60), 600);
      g.target = Math.min(d, Math.max(0, g.t0 + dx / g.r.width * span));
      if (!gesturing) { gesturing = true; player.classList.remove('idle'); clearTimeout(idleTimer); }
      tl.style.setProperty('--p', g.target / d * 100 + '%');
      showAt(g.target / d);
    } else if (g.axis === 'y') {
      const k = -dy / (g.r.height * .7);
      if (g.left) { setBright(g.b0 + k * 1.35); showHud('sun', (bright - .25) / 1.35); }
      else if (volOk) { video.muted = false; video.volume = clamp01(g.v0 + k); showHud('vol', video.volume); }
      else if (!g.said) { g.said = true; toast('音量请用手机侧边的音量键'); }
    }
  });
  const end = (e, ok) => {
    if (!g || e.pointerId !== g.id) return;
    const x = g; g = null;
    if (x.axis === 'x') {
      if (ok) video.currentTime = x.target;
      gesturing = false; tip.hidden = true; tl.style.setProperty('--h', '0%'); poke();
    }
  };
  video.addEventListener('pointerup', e => end(e, true));
  video.addEventListener('pointercancel', e => end(e, false));
  video.addEventListener('click', e => {
    if (player.classList.contains('locked')) return showLockBtn();
    if (!$('.plist').hidden) return;
    const r = rotR(video), f = (rotP(e).x - r.left) / r.width, now = performance.now();
    if (now - lastTap.t < 300 && Math.abs(f - lastTap.f) < .25) {
      clearTimeout(tapTimer); lastTap.t = 0;
      if (f < .38) skip(-10); else if (f > .62) skip(10); else togglePlay();
      poke();
    } else {
      lastTap = { t: now, f };
      tapTimer = setTimeout(() => {
        if (player.classList.contains('idle') || video.paused) poke();
        else { clearTimeout(idleTimer); player.classList.add('idle'); }
      }, 260);
    }
  });
}

// The preview copy: same source the player ended up using (direct or relayed), lowest level, tiny buffer.
function previewAt(t) {
  if (!playingSrc) return;
  if (pvKey !== playingSrc.src) {
    pvReset(); tip.hidden = false;
    pvKey = playingSrc.src;
    tip.classList.remove('ready');
    if (playingSrc.hls && window.Hls && Hls.isSupported()) {
      pvHls = new Hls({ startLevel: 0, capLevelToPlayerSize: true, maxBufferLength: 2, maxMaxBufferLength: 4, backBufferLength: 0, enableWorker: true, startPosition: t });
      pvHls.on(Hls.Events.MANIFEST_PARSED, () => { pvHls.autoLevelCapping = 0; });
      pvHls.loadSource(pvKey); pvHls.attachMedia(seekV);
    } else seekV.src = pvKey;
  }
  pvWant = Math.round(t);
  pvPump();
}
function pvPump() {
  if (pvBusy || pvWant === null || seekV.readyState < 1) return;
  const t = pvWant; pvWant = null;
  if (Math.abs(seekV.currentTime - t) < 0.5 && seekV.readyState >= 2) return;
  pvBusy = true;
  clearTimeout(pvTimer);
  pvTimer = setTimeout(() => { pvBusy = false; pvPump(); }, 4000);  // a slow fragment shouldn't block newer hovers
  seekV.currentTime = t;
}
seekV.addEventListener('loadedmetadata', pvPump);
seekV.addEventListener('seeked', () => { clearTimeout(pvTimer); pvBusy = false; tip.classList.add('ready'); pvPump(); });
function pvReset() {
  clearTimeout(pvTimer);
  if (pvHls) { pvHls.destroy(); pvHls = null; }
  seekV.removeAttribute('src'); seekV.load();
  pvKey = ''; pvWant = null; pvBusy = false;
  tip.hidden = true; tip.classList.remove('ready');
}
// ---------- 后退 / 前进 / 刷新 (installed window: no browser toolbar) ----------
// The buttons appear only in a standalone / app window on a PC-sized screen (a normal tab has the browser's own;
// phones have swipe gestures). Back and forward just walk the history, so they also close the detail sheet and
// the player, which are history entries. localStorage.navBtns = '1' / '0' forces them on / off.
const appWin = matchMedia('(display-mode: standalone), (display-mode: minimal-ui), (display-mode: window-controls-overlay), (display-mode: fullscreen)');
const syncAppWin = () => document.documentElement.classList.toggle('app-win', localStorage.navBtns === '1' || (localStorage.navBtns !== '0' && appWin.matches));
syncAppWin(); appWin.addEventListener?.('change', syncAppWin);
let lastGo = 0;
// A second step within 250 ms is dropped: some shells also handle Alt+← themselves, and two steps would skip a page.
const go = n => { if (Date.now() - lastGo < 250) return; lastGo = Date.now(); history.go(n); };
const syncNav = () => {
  const n = window.navigation;
  $('#navBack').disabled = n ? !n.canGoBack : history.length <= 1;
  $('#navFwd').disabled = n ? !n.canGoForward : false;
};
$('#navBack').onclick = () => go(-1);
$('#navFwd').onclick = () => go(1);
$('#navReload').onclick = () => location.reload();
window.navigation?.addEventListener('currententrychange', syncNav);
addEventListener('popstate', syncNav); addEventListener('hashchange', syncNav);
syncNav();

addEventListener('keydown', e => {
  if ((e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight'))
    || (e.metaKey && !e.altKey && !e.ctrlKey && (e.key === '[' || e.key === ']')) ) {
    if (!e.target.matches?.('input, textarea')) { e.preventDefault(); return go(e.key === 'ArrowLeft' || e.key === '[' ? -1 : 1); }
  }
  if (e.key === 'Escape' && !player.hidden && !sysPanel.hidden) { e.preventDefault(); return sysClose(); }
  if (e.key === 'Escape' && !player.hidden && !$('.plist').hidden) { e.preventDefault(); return togglePlist(false); }
  if (e.target.matches?.('input, textarea')) return;
  if (e.key === 'Escape' && (playerOpen() || $('#modal'))) history.back();
  if (!playerOpen()) return;
  if (e.key === ' ') { e.preventDefault(); video.paused ? video.play() : video.pause(); }
  if (e.key === 'ArrowRight') video.currentTime += 10;
  if (e.key === 'ArrowLeft') video.currentTime -= 10;
  if (e.key === 'n' || e.key === 'PageDown') step(1);
  if (e.key === 'p' || e.key === 'PageUp') step(-1);
  if (e.key === 'f' && !hideFs()) toggleFs();
  if (e.key === 'm') video.muted = !video.muted;
  if (cur?.kind === 'live' && e.key === 'ArrowDown') { e.preventDefault(); step(1); }
  if (cur?.kind === 'live' && e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
});

// ---------- live ----------
let serverInfo = null;
const infoP = () => serverInfo ? Promise.resolve(serverInfo) : get('/api/info', null).then(j => (serverInfo = j), () => ({ urls: [], ffmpeg: false }));
infoP().catch(() => {});   // 提前拿局域网地址：分享要同步生成链接再复制（Safari 里 await 之后复制会被拒）
// Covers: two at a time (ffmpeg can take seconds per channel), dropped when the page changes.
const thumbQueue = []; let thumbActive = 0;
function thumbPump() {
  while (thumbActive < 2 && thumbQueue.length) {
    const el = thumbQueue.shift();
    if (!el.isConnected) continue;
    thumbActive++;
    fetch('/api/live/thumb?u=' + encodeURIComponent(el.dataset.u), { signal: pageCtl.signal })
      .then(r => r.ok ? r.blob() : null)
      .then(b => { if (b && el.isConnected) { el.style.backgroundImage = `url('${URL.createObjectURL(b)}')`; el.classList.add('has'); } })
      .catch(() => {})
      .finally(() => { thumbActive--; thumbPump(); });
  }
}
const thumbIO = new IntersectionObserver(es => es.forEach(e => {
  if (!e.isIntersecting) return;
  thumbIO.unobserve(e.target);
  thumbQueue.push(e.target);
  thumbPump();
}), { rootMargin: '300px' });

// ---- 直播源 picker: one fixed-size button + a popover (desktop) / bottom sheet (phone). Search, click to switch, × to delete — same feel as the 点播源 menu. ----
const liveHealth = new Map();           // url -> { ok, text, at } | 'busy'
const lm = { cfg: [], q: '', tab: 'vis' };
const liveUrlOf = key => lm.cfg[Number(key)]?.url || '';
async function lmRefresh() { lm.cfg = (await get('/api/config', null)).lives || []; }
const lmVisible = () => { const q = lm.q.toLowerCase(); return state.lives.filter(l => !!l.hidden === (lm.tab === 'hid') && (!q || l.name.toLowerCase().includes(q))); };
// Status text of a row: running → 测速中, waiting in the queue → 排队中, else the last result.
function lmStatus(k) {
  const h = liveHealth.get(liveUrlOf(k));
  if (h === 'busy') return { html: netBusy };
  if (lmQ.includes(k)) return { html: '<span class="net"><span class="nt"><small>排队中</small></span></span>' };
  if (!h) return null;
  if (!h.ok) return { html: netBox(0, '连不上', h.text) };
  // 列表打开快慢 + 抽样频道的通畅率：通畅率低的不能算畅通
  let lv = netLvMs(h.ms || 0);
  if (h.ratio < .4) lv = 1; else if (h.ratio < .75) lv = Math.min(lv, 2);
  return { html: netBox(lv, (h.ms || 0) + ' ms', h.text) };
}
function lmRender() {
  const box = $('#llist'); if (!box) return;
  const cur = localStorage.live;
  const nHid = state.lives.filter(l => l.hidden).length;
  if (!nHid) lm.tab = 'vis';
  const tabs = $('#lmTabs'); if (tabs) tabs.innerHTML = menuTabs(state.lives.length - nHid, nHid, lm.tab, 'data-ltab');
  const rows = lmVisible();
  box.innerHTML = rows.map(l => {
    const s = lmStatus(l.key), h = liveHealth.get(liveUrlOf(l.key));
    return `<div class="lpr ${l.key === cur ? 'on' : ''} ${h && h !== 'busy' && !h.ok ? 'dead' : ''} " data-k="${esc(l.key)}">
      <span class="nm" title="${esc(l.name)}">${esc(l.name)}</span>${s ? `<b class="hs">${s.html}</b>` : ''}
      ${state.level === 'all' ? `<em class="x" data-del="${esc(l.key)}" title="删除这个直播源">×</em>` : ''}</div>`;
  }).join('') || '<div class="lan" style="padding:10px">没有匹配的直播源</div>';
  $('#lmCount').textContent = lm.q ? `${rows.length} / ${state.lives.length}` : state.lives.length;
  lmWatch();
}
async function lmSave(mutate) {
  const curUrl = liveUrlOf(localStorage.live);
  const cfg = await get('/api/config', null);
  await req('PUT', '/api/config', { ...cfg, lives: mutate(cfg.lives) });
  await Promise.all([loadSites(), lmRefresh()]);
  const i = lm.cfg.findIndex(l => l.url === curUrl);
  localStorage.live = String(i >= 0 ? i : 0);
  $('#lmName').textContent = state.lives.find(l => l.key === localStorage.live)?.name || '无直播源';
  lmRender();
  if (i < 0 && location.hash.startsWith('#/live')) loadLiveBody();
}
const LIVE_TTL = 5 * 60e3;
let lmEpoch = 0; // set whenever the live menu opens: only passing results are cached, a failure is retried then
let lmIO = null, lmQ = [], lmRun = 0;
async function lmPingOne(k) {
  const url = liveUrlOf(k), name = state.lives.find(l => l.key === k)?.name || '';
  let j;
  for (let t = 0; t < 3; t++) {            // network blips: retry twice before calling a source dead
    if (t) await new Promise(ok => setTimeout(ok, 600 * t));
    j = await api('checklive', { url, name }, AbortSignal.timeout(25e3)).catch(e => ({ ok: false, error: e.message }));
    if (j.ok) break;
  }
  liveHealth.set(url, { ok: !!j.ok, text: j.channels ? `${j.channels}台 · ${j.alive}/${j.sampled}` : '不通', ms: j.ms || 0, ratio: j.sampled ? j.alive / j.sampled : 0, at: Date.now() });
}
// Rows scrolled into view are pinged (3 at a time, newest first), results are kept 5 min. A row that scrolls away
// before its turn leaves the queue, so what the user is looking at is always what gets tested next.
function lmQueue(k) {
  const url = liveUrlOf(k), h = liveHealth.get(url);
  if (!url || h === 'busy' || (h && (h.ok ? Date.now() - h.at < LIVE_TTL : h.at >= lmEpoch))) return;
  lmQ = [k, ...lmQ.filter(x => x !== k)];
  lmMark(k); lmDrain();
}
// 重测: forget the results of the rows in view (all rows when none is measurable by geometry) and queue them again.
function lmRetest() {
  const box = $('#llist'), b = box.getBoundingClientRect();
  let keys = $$('#llist .lpr').filter(r => { const x = r.getBoundingClientRect(); return x.height && x.bottom > b.top && x.top < b.bottom; }).map(r => r.dataset.k);
  if (!keys.length) keys = lmVisible().map(l => l.key);
  keys = keys.filter(k => liveUrlOf(k) && liveHealth.get(liveUrlOf(k)) !== 'busy');
  if (!keys.length) return toast('没有可重测的直播源');
  keys.forEach(k => liveHealth.delete(liveUrlOf(k)));
  [...keys].reverse().forEach(k => lmQueue(k));
  keys.forEach(lmMark);
  toast(`重测 ${keys.length} 个直播源`);
}
function lmUnqueue(k) { if (lmQ.includes(k)) { lmQ = lmQ.filter(x => x !== k); lmMark(k); } }
function lmDrain() {
  while (lmRun < 3 && lmQ.length) {
    const k = lmQ.shift(), url = liveUrlOf(k); if (!url) continue;
    lmRun++; liveHealth.set(url, 'busy'); lmMark(k);
    lmPingOne(k).finally(() => { lmRun--; lmMark(k); lmDrain(); });
  }
}
// Update one row in place (no re-render, so the list never jumps while results arrive).
function lmMark(k) {
  const row = $(`#llist .lpr[data-k="${CSS.escape(k)}"]`); if (!row) return;
  const s = lmStatus(k), h = liveHealth.get(liveUrlOf(k));
  let hs = $('.hs', row);
  if (!s) { hs?.remove(); return; }
  if (!hs) { hs = document.createElement('b'); hs.className = 'hs'; row.insertBefore(hs, $('em.x', row)); }
  hs.innerHTML = s.html;
  row.classList.toggle('dead', !!h && h !== 'busy' && !h.ok);
}
function lmWatch() {
  lmIO?.disconnect();
  const m = $('#liveMenu'); if (!m || m.hidden) return;
  lmIO = new IntersectionObserver(es => es.forEach(en => en.isIntersecting ? lmQueue(en.target.dataset.k) : lmUnqueue(en.target.dataset.k)), { root: $('#llist') });
  $$('#llist .lpr').forEach(r => lmIO.observe(r));
}
document.addEventListener('click', e => {
  const m = $('#liveMenu'); if (!m || m.hidden) return;
  // composedPath: a row that was re-rendered during the click is already detached, closest() would miss it
  if (e.composedPath().some(n => n === m || n.classList?.contains('lpick'))) return;
  m.hidden = true; $('#liveBtn')?.classList.remove('open');
});

let liveSrc = '';
async function renderLive() {
  if (!state.lives.length) {
    view.innerHTML = `<div class="page"><h1>直播</h1><p class="empty">${state.level === 'kids' ? '儿童模式下直播已关闭。' : '没有直播源，去 <a href="#/settings"><u>设置</u></a> 添加。'}</p></div>`;
    return;
  }
  if (!state.lives.some(l => l.key === localStorage.live)) localStorage.live = state.lives[0].key;
  // The frame is built once; switching source only swaps #liveBody (no re-layout of the header, no jump).
  if (!$('#liveHead')) {
    $$('body > #liveMenu').forEach(x => x.remove());
    view.innerHTML = `<div class="page"><div class="pagehead" id="liveHead"><h1>直播</h1>
      <div class="lpick"><button id="liveBtn" class="sitebtn lbtn" type="button"><span id="lmName"></span><svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        <div id="liveMenu" class="menu lmenu" hidden>
          <div id="lmTabs"></div>
          <div class="lm-top"><input id="lmq" class="find" type="search" placeholder="搜直播源" autocomplete="off"></div>
          <div class="mhead lm-head"><span>直播源 · <span id="lmCount"></span></span><span class="mre" data-re="1" title="重新测速当前可见的直播源">重测</span></div>
          <div class="lm-list" id="llist"></div>
        </div></div>
      <input id="chq" class="find" type="search" placeholder="搜频道"></div>
      <div id="liveBody"></div></div>`;
    $('#liveBtn').onclick = async e => {
      e.stopPropagation();
      const m = $('#liveMenu'); if (m.hidden) lm.tab = state.lives.find(l => l.key === localStorage.live)?.hidden ? 'hid' : 'vis'; m.hidden = !m.hidden; if (!m.hidden) lmEpoch = Date.now(); $('#liveBtn').classList.toggle('open', !m.hidden);
      if (!m.hidden) { lmRender(); await lmRefresh().catch(() => {}); lmRender(); $('.lpr.on', m)?.scrollIntoView({ block: 'nearest' }); }
    };
    $('#lmq').oninput = e => { lm.q = e.target.value.trim(); lmRender(); };
    $('#liveMenu').onclick = e => {
      if (e.target.closest('[data-re]')) { e.stopPropagation(); return lmRetest(); }
      const lt = e.target.closest('[data-ltab]');
      if (lt) { e.stopPropagation(); lm.tab = lt.dataset.ltab; lmRender(); return; }
      const del = e.target.closest('[data-del]');
      if (del) {
        e.stopPropagation();
        const k = del.dataset.del, l = state.lives.find(x => x.key === k); if (!l) return;
        if (confirm(`删除直播源「${l.name}」？`)) lmSave(lives => lives.filter((_, i) => i !== Number(k))).then(() => toast(`已删除「${l.name}」`), err => toast(err.message));
        return;
      }
      const row = e.target.closest('.lpr'); if (!row) return;
      localStorage.live = row.dataset.k;
      $('#liveMenu').hidden = true; $('#liveBtn').classList.remove('open');
      $('#lmName').textContent = l2name(); newPage(); loadLiveBody();
    };
    lmRefresh().catch(() => {});
  }
  $('#lmName').textContent = l2name();
  return loadLiveBody();
}
const l2name = () => state.lives.find(l => l.key === localStorage.live)?.name || '无直播源';
async function loadLiveBody() {
  const src = localStorage.live; liveSrc = src;
  $('#liveBody').innerHTML = spinner;
  $('#chq').value = '';
  try { return await renderLiveBody(src); } catch (e) { if (!isAbort(e)) toast(e.message); }
}
async function renderLiveBody(src) {
  const [{ groups }, info] = await Promise.all([api('live', { src }), infoP()]);
  if (src !== liveSrc || !$('#liveBody')) return groups;
  // gi = -1 is the ★ 收藏 group (channels starred from any live source).
  let gi = liveFavs.all().length ? -1 : 0;
  const paint = () => {
    const q = $('#chq').value.trim().toLowerCase();
    const fav = liveFavs.all();
    if (gi === -1 && !fav.length) gi = 0;
    const chans = q ? groups.flatMap(g => g.channels).filter(c => c.name.toLowerCase().includes(q)) : gi === -1 ? fav : groups[gi]?.channels || [];
    $('#liveBody').innerHTML = `<div class="live"><div class="groups">${fav.length ? `<button data-g="-1" class="favg ${gi === -1 && !q ? 'on' : ''}">★ 收藏<span>${fav.length}</span></button>` : ''}${groups.map((g, i) => `<button data-g="${i}" class="${i === gi && !q ? 'on' : ''}">${esc(g.name)}<span>${g.channels.length}</span></button>`).join('')}</div>
      <div class="channels">${chans.map((c, i) => `<a class="ch" data-c="${i}" href="#/tv/${encodeURIComponent(src)}/${encodeURIComponent(c.url)}/${encodeURIComponent(c.name)}">
          <div class="cover" data-u="${esc(c.url)}"><div class="logo2" style="${bg(c.logo)}">${c.logo ? '' : '📺'}</div><span class="live-dot">LIVE</span>
            <button class="star ${liveFavs.has(c.url) ? 'on' : ''}" data-star="${i}" title="${liveFavs.has(c.url) ? '取消收藏' : '收藏'}">${liveFavs.has(c.url) ? '★' : '☆'}</button></div>
          <span class="chname">${esc(c.name)}</span></a>`).join('') || '<div class="empty">没有频道</div>'}</div></div>`;
    $$('[data-g]', $('#liveBody')).forEach(b => b.onclick = () => { gi = +b.dataset.g; $('#chq').value = ''; paint(); });
    $$('.ch', $('#liveBody')).forEach(b => {
      b.onclick = e => {
        const st = e.target.closest('[data-star]');
        if (st) { e.preventDefault(); e.stopPropagation(); toast(liveFavs.toggle(chans[+st.dataset.star]) ? '已收藏' : '已取消收藏'); return paint(); }
        if (!plainClick(e)) return; e.preventDefault(); stopPreview(); playLive(chans, +b.dataset.c);
      };
      b.onmouseenter = () => startPreview($('.cover', b), info.ffmpeg);
      b.onmouseleave = stopPreview;
    });
    $$('.cover', $('#liveBody')).forEach(el => thumbIO.observe(el));
  };
  $('#chq').oninput = paint;
  paint();
  return groups;
}

// 本地媒体 hover preview (local titles only — remote sources are never previewed, it would be too slow).
// Hover a cover for 350 ms (120 ms when it has played before) → the server's gif is fetched; once it has loaded and decoded
// it opens as a floating layer on top of the cover: as tall as the cover, as wide as the video's aspect needs, and it
// grows out of the cover's own rectangle (clip-path + opacity via the Web Animations API, so it runs on the compositor) toward
// the side with room — from the left edge when the cover sits in the left third of the window, from the right edge in the
// right third, from the middle otherwise. The layer ignores the pointer, so the card underneath still gets hover and
// click; leaving the cover (or scrolling) folds it back. Server: disk LRU + hot LRU; browser: HTTP cache for a week; here only
// "played before" is remembered (a failed preview is not), and one preview exists at a time.
const lpvSeen = new Set();
// Two animations on purpose: the shape grows with a soft start and a long settle, the fade-in is short and independent of it.
const LPV_GROW = { duration: 440, easing: 'cubic-bezier(.32,.72,0,1)', fill: 'forwards' };
const LPV_FADE = { duration: 180, easing: 'ease-out', fill: 'forwards' };
let lpv = null;
function startLocalPreview(el, url, box = el) {
  if (!url || !matchMedia('(hover: hover) and (pointer: fine)').matches) return;
  if (lpv && lpv.el === el) return;
  stopLocalPreview();
  const me = lpv = { el, box, ov: null, img: null, timer: 0, off: null };
  me.timer = setTimeout(async () => {
    if (lpv !== me) return;
    const info = serverInfo || await infoP();
    if (lpv !== me || !info.ffmpeg) return;
    box.classList.add('pvload');
    const img = new Image();
    img.className = 'lpv-img'; img.decoding = 'async'; img.alt = '';
    me.img = img;
    img.onerror = () => {
      if (lpv === me) { box.classList.remove('pvload'); lpv = null; }
    };
    img.onload = async () => {
      await img.decode().catch(() => {});                 // first frame ready before anything moves
      if (lpv !== me || !box.isConnected) return;
      box.classList.remove('pvload');
      lpvSeen.delete(url); lpvSeen.add(url); if (lpvSeen.size > 300) lpvSeen.delete(lpvSeen.values().next().value);
      openLocalPreview(me);
    };
    img.src = url;
  }, lpvSeen.has(url) ? 120 : 350);
}
function openLocalPreview(me) {
  const r = me.box.getBoundingClientRect(), vw = document.documentElement.clientWidth;
  const ar = me.img.naturalWidth / Math.max(1, me.img.naturalHeight);
  let h = r.height, w = Math.max(r.width, h * ar);       // cover's height, the video's width (never narrower than the cover)
  const room = vw - 24;
  if (w > room) { const k = room / w; w *= k; h *= k; }  // wider than the window: shrink, keep the aspect
  const top = r.top + (r.height - h) / 2;
  const cx = r.left + r.width / 2;
  let left = cx < vw / 3 ? r.left : cx > vw * 2 / 3 ? r.right - w : cx - w / 2;
  left = Math.max(12, Math.min(left, vw - 12 - w));
  const px = n => Math.max(0, n).toFixed(1) + 'px';
  const from = `inset(${px(r.top - top)} ${px(left + w - r.right)} ${px(top + h - r.bottom)} ${px(r.left - left)} round 4px)`;
  const to = 'inset(0px round 8px)';
  const ov = document.createElement('div');
  ov.className = 'lpv';
  ov.style.cssText = `left:${left.toFixed(1)}px;top:${top.toFixed(1)}px;width:${w.toFixed(1)}px;height:${h.toFixed(1)}px`;
  const inner = document.createElement('div');
  inner.className = 'lpv-in';
  inner.style.clipPath = from; inner.style.opacity = '0';
  inner.append(me.img); ov.append(inner);
  document.body.append(ov);
  me.ov = ov; me.inner = inner; me.from = from; me.to = to;
  inner.animate([{ clipPath: from }, { clipPath: to }], LPV_GROW);
  inner.animate([{ opacity: 0 }, { opacity: 1 }], LPV_FADE);
  const off = () => { if (lpv === me) stopLocalPreview(); };
  me.off = off;
  addEventListener('scroll', off, { passive: true, once: true, capture: true });
  addEventListener('resize', off, { once: true });
}
function stopLocalPreview(immediate) {
  const me = lpv; if (!me) return;
  lpv = null;
  clearTimeout(me.timer);
  me.box.classList.remove('pvload');
  if (me.img) me.img.onload = me.img.onerror = null;
  if (me.off) { removeEventListener('scroll', me.off, true); removeEventListener('resize', me.off); }
  if (!me.ov) { if (me.img) me.img.src = ''; return; }
  if (immediate) return me.ov.remove();
  // Fold back into the cover's rectangle, then go (a quick re-hover elsewhere can already start the next one).
  me.inner.getAnimations().forEach(x => x.cancel());
  me.inner.animate([{ clipPath: me.to }, { clipPath: me.from }], { duration: 240, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' });
  const a = me.inner.animate([{ opacity: 1 }, { opacity: 1, offset: .5 }, { opacity: 0 }], { duration: 240, easing: 'linear', fill: 'forwards' });
  a.onfinish = a.oncancel = () => me.ov.remove();
}
// The preview belongs to the cover itself. Pointing at an action on it (✕ 删除 / 取消收藏 / a link or button) is a different
// intent and gets no hover effect: a running preview folds away and none starts until the pointer is back on the plain cover.
// (mouseover bubbles, so one listener on document sees every card and the detail poster; moving from a button back onto the
// cover fires it again, which is what restarts the preview.)
const LPV_ACTION = 'button, a[href]:not(.card), .rm, .badge, .db, .q, input, select, textarea, [role=button]';
const lpvTarget = t => t instanceof Element && t.closest('#view .card[data-pv], .sheet .top .poster[data-pv]');
document.addEventListener('mouseover', e => {
  const t = e.target instanceof Element ? e.target : null; if (!t) return;
  const host = lpvTarget(t); if (!host) return;
  if (t !== host && t.closest(LPV_ACTION) && host.contains(t.closest(LPV_ACTION))) { if (lpv) stopLocalPreview(); return; }
  if (lpv && lpv.el === host) return;
  startLocalPreview(host, host.dataset.pv, host.classList.contains('card') ? $('.img', host) || host : host);
});
document.addEventListener('mouseout', e => {
  if (!lpv) return;
  const to = e.relatedTarget instanceof Node ? e.relatedTarget : null;
  if (!to || !lpv.el.contains(to)) stopLocalPreview();
});

// Hover preview: a fresh 3-second gif cut by the server's ffmpeg; without ffmpeg, a muted live mini-player
// (through the same-origin relay, so a frame can be captured and saved as the channel's cover).
let pv = null;
function startPreview(cover, hasFfmpeg) {
  stopPreview();
  const u = cover.dataset.u;
  const me = pv = { cover, timer: 0, hls: null };
  me.timer = setTimeout(() => {
    if (pv !== me) return;
    cover.classList.add('loading');
    if (hasFfmpeg) {
      const img = new Image();
      img.className = 'pv';
      img.onload = () => { if (pv === me) { cover.classList.remove('loading'); cover.append(img); } };
      img.onerror = () => { if (pv === me) cover.classList.remove('loading'); };
      img.src = '/api/live/preview?u=' + encodeURIComponent(u);
      me.img = img;
    } else {
      const v = document.createElement('video');
      v.className = 'pv'; v.muted = true; v.playsInline = true; v.autoplay = true;
      const proxied = '/hls?u=' + encodeURIComponent(u);
      if (window.Hls && Hls.isSupported()) { me.hls = new Hls({ maxBufferLength: 6 }); me.hls.loadSource(proxied); me.hls.attachMedia(v); }
      else v.src = proxied;
      v.addEventListener('playing', () => {
        if (pv !== me) return;
        cover.classList.remove('loading');
        setTimeout(() => {
          if (pv !== me || !v.videoWidth) return;
          const c = document.createElement('canvas');
          c.width = 320; c.height = Math.round(320 * v.videoHeight / v.videoWidth);
          try {
            c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
            const data = c.toDataURL('image/jpeg', 0.55);
            cover.style.backgroundImage = `url('${data}')`; cover.classList.add('has');
            req('POST', '/api/live/thumb?u=' + encodeURIComponent(u), { data }).catch(() => {});
          } catch {}
        }, 800);
      }, { once: true });
      cover.append(v);
      me.video = v;
    }
  }, 250);
}
function stopPreview() {
  if (!pv) return;
  clearTimeout(pv.timer);
  pv.cover.classList.remove('loading');
  if (pv.img) { pv.img.onload = pv.img.onerror = null; pv.img.src = ''; pv.img.remove(); }
  if (pv.hls) pv.hls.destroy();
  if (pv.video) { pv.video.pause(); pv.video.removeAttribute('src'); pv.video.load(); pv.video.remove(); }
  pv = null;
}

// ---------- shared multi-select: shift+click a checkbox selects the range since the last click ----------
// (no drag-rectangle: it fights with selecting / copying text in the rows.)
// box: where the checkbox clicks happen; rows(): selectable rows in order; box_(row): the row's checkbox; changed(): after a change.
function multiPick({ box, rows, box_, changed }) {
  let anchor = null;
  box.addEventListener('click', e => {
    const c = e.target.closest('input[type=checkbox]'); if (!c) return;
    const list = rows(), row = list.find(r => r.contains(c)); if (!row || box_(row) !== c) return;
    if (e.shiftKey && anchor && list.includes(anchor)) {
      const a = list.indexOf(anchor), b = list.indexOf(row);
      list.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(r => { if (!box_(r).disabled) box_(r).checked = c.checked; });
      changed();
    }
    anchor = row;
  });
}
// Small dropdown for the bulk bars ("分类" / "更多"): fixed-position so the bars' own scrolling never clips it.
function toggleBulkMenu(btn) {
  const menu = btn.nextElementSibling, open = menu.hidden;
  closeBulkMenus();
  if (!open) return;
  const r = btn.getBoundingClientRect();
  menu.hidden = false;
  const room = innerHeight - r.bottom - 12, h = menu.offsetHeight;
  menu.style.maxHeight = Math.max(160, innerHeight - 24) + 'px'; menu.style.overflowY = 'auto';
  menu.style.top = (h <= room ? r.bottom + 4 : Math.max(8, Math.min(r.top - h - 4, innerHeight - 8 - Math.min(h, innerHeight - 24)))) + 'px';
  menu.style.left = Math.max(8, Math.min(r.left, innerWidth - menu.offsetWidth - 8)) + 'px';
}
function closeBulkMenus() { $$('.bmenu').forEach(m => { m.hidden = true; }); }
document.addEventListener('click', e => { if (!e.target.closest('.bmenu, [data-bulk=more], [data-bulk=cat], [data-bulk=vis], [data-cbulk=more], [data-cbulk=cat]')) closeBulkMenus(); });
addEventListener('scroll', closeBulkMenus, { passive: true });

// ---------- text editor: Monaco (the open-source editor core of VS Code), loaded on first use ----------
// textEditor(host, { value, language }) → { get value / set value, onchange, focus(), dispose() } — the same small surface as a <textarea>,
// so callers do not care which one they got. If Monaco cannot be loaded (offline, blocked) a plain textarea stands in.
let monacoP = null;
function loadMonaco() {
  if (monacoP) return monacoP;
  return monacoP = new Promise((ok, bad) => {
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'vendor/monaco/vs/editor/editor.main.css'; document.head.append(css);
    const sc = document.createElement('script'); sc.src = 'vendor/monaco/vs/loader.js';
    sc.onerror = () => { monacoP = null; bad(new Error('编辑器组件加载失败')); };
    sc.onload = () => {
      window.require.config({ paths: { vs: 'vendor/monaco/vs' }, 'vs/nls': { availableLanguages: { '*': 'zh-cn' } } });
      // The language workers run from a same-origin blob that imports the real one (workers cannot be loaded cross-path directly).
      window.MonacoEnvironment = { getWorkerUrl: () => URL.createObjectURL(new Blob([`self.MonacoEnvironment={baseUrl:'${location.origin}${location.pathname.replace(/[^/]*$/, '')}vendor/monaco/'};importScripts('${location.origin}${location.pathname.replace(/[^/]*$/, '')}vendor/monaco/vs/base/worker/workerMain.js');`], { type: 'text/javascript' })) };
      window.require(['vs/editor/editor.main'], () => ok(window.monaco), e => { monacoP = null; bad(e); });
    };
    document.head.append(sc);
  });
}
// Channel / title lists: m3u comments, "分类,#genre#" group lines and "名称,地址" rows get light syntax colouring.
function defineListLanguage(monaco) {
  if (monaco.languages.getLanguages().some(l => l.id === 'tvlist')) return;
  monaco.languages.register({ id: 'tvlist' });
  monaco.languages.setMonarchTokensProvider('tvlist', {
    tokenizer: { root: [
      [/^\s*\/\/.*$/, 'comment'], [/^#EXTM3U.*$/, 'keyword'], [/^#EXTINF/, 'keyword', '@extinf'], [/^#.*$/, 'comment'],
      [/^[^,\n#]+(?=,#genre#)/, 'type.identifier'], [/,#genre#/, 'keyword'],
      [/^[^,\n]+(?=,)/, 'string'], [/\$/, 'delimiter'], [/@@/, 'keyword'], [/\s\|\|\s/, 'keyword'], [/https?:\/\/[^\s#$|]+/, 'string.link'],
    ], extinf: [[/[a-z-]+(?==)/, 'attribute.name'], [/"[^"]*"/, 'string'], [/,.*$/, 'type.identifier', '@pop'], [/./, '']] },
  });
}
async function textEditor(host, { value = '', language = 'tvlist' } = {}) {
  const fallback = () => {
    const ta = document.createElement('textarea'); ta.spellcheck = false; ta.value = value; ta.className = 'plainedit'; host.replaceChildren(ta);
    const api = { get value() { return ta.value; }, set value(v) { ta.value = v; api.onchange?.(); }, focus: () => ta.focus(), dispose: () => ta.remove(), onchange: null, kind: 'textarea' };
    ta.oninput = () => api.onchange?.();
    return api;
  };
  let monaco;
  try { monaco = await Promise.race([loadMonaco(), new Promise((_, bad) => setTimeout(() => bad(new Error('timeout')), 15000))]); } catch { return fallback(); }
  defineListLanguage(monaco);
  host.replaceChildren();
  const ed = monaco.editor.create(host, { value, language, theme: 'vs-dark', automaticLayout: true, minimap: { enabled: false }, fontSize: 13,
    lineNumbers: 'on', wordWrap: 'off', scrollBeyondLastLine: false, renderWhitespace: 'none', tabSize: 2, fixedOverflowWidgets: true, padding: { top: 8, bottom: 8 },
    contextmenu: true, smoothScrolling: true, quickSuggestions: false, suggestOnTriggerCharacters: false });
  const api = { get value() { return ed.getValue(); }, set value(v) { ed.setValue(v); }, focus: () => ed.focus(), dispose: () => ed.dispose(), onchange: null, kind: 'monaco', editor: ed, monaco };
  ed.onDidChangeModelContent(() => api.onchange?.());
  ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => host.closest('.sheet')?.querySelector('#ltSave')?.click());
  return api;
}

// ---------- settings ----------
let installEvt = null;
addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; });
addEventListener('appinstalled', () => { installEvt = null; });
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone;
// ---------- 管理员 (设置页): 管理员令牌登录后可重启 / 检查更新 / 更新并重启 / 清理缓存 / 换令牌 ----------
const admApi = (method, path, body) => req(method, '/api/admin/' + path, body, false, null);
const fmtUp = sec => { sec = Math.max(0, sec | 0); const d = Math.floor(sec / 86400), h = Math.floor(sec / 3600) % 24, m = Math.floor(sec / 60) % 60; return d ? `${d} 天 ${h} 小时` : h ? `${h} 小时 ${m} 分` : `${m} 分钟`; };
const ago = t => { const s = Math.max(0, (Date.now() - t) / 1000); return s < 60 ? '刚刚' : s < 3600 ? Math.floor(s / 60) + ' 分钟前' : s < 86400 ? Math.floor(s / 3600) + ' 小时前' : Math.floor(s / 86400) + ' 天前'; };
let admPoll = 0;
async function initAdmin() {
  const box = $('#adminSec'); if (!box) return;
  const alive = () => box.isConnected;
  let st = null, busy = '', checkErr = '';
  const load = async () => { st = await admApi('GET', 'status'); };
  const verTxt = v => !v ? '' : v.mode === 'git' ? `git · ${esc(v.branch)} @ <code>${esc(v.short)}</code>${v.subject ? ' · ' + esc(v.subject.slice(0, 60)) : ''}${v.dirty ? ' <span class="warn">（有未提交的本地改动）</span>' : ''}`
    : v.mode === 'zip' ? `压缩包安装 · ${v.short ? `<code>${esc(v.short)}</code>` : '版本未知（更新一次后记录）'}${v.at ? ' · 更新于 ' + ago(v.at) : ''} · 来源 ${esc(v.repo || '')}` : esc(v.error || '未知');
  const updTxt = u => {
    if (checkErr) return `<span class="warn">检查失败：${esc(checkErr)}</span>${u ? '（以下是上次的结果）<br>' : ''}` + (u ? updBody(u) : '');
    return u ? updBody(u) : '还没检查过。点「检查更新」。';
  };
  const updBody = u => {
    const when = `<span class="lan">检查于 ${ago(u.at)}${u.cached ? '（缓存结果）' : ''}</span>`;
    if (!u.available) return `<b class="okc">已是最新</b> ${u.mode === 'git' && u.ahead ? `<span class="lan">本地领先 ${u.ahead} 个提交</span> ` : ''}${when}`;
    const list = (u.commits || []).map(c => `<li><code>${esc(c.id)}</code> ${esc(c.subject || '')}</li>`).join('');
    return `<b class="newc">${u.unknown ? '可更新（当前版本未知）' : u.mode === 'git' ? `有新版本：落后 ${u.behind} 个提交` : '有新版本'}</b> → <code>${esc(u.latest)}</code> ${when}${list ? `<ul class="adcommits">${list}</ul>` : ''}`;
  };
  const jobTxt = j => !j ? '' : (j.log || []).map(esc).join('\n');
  const paint = () => {
    if (!alive()) return;
    if (!st || !st.authed) {
      box.innerHTML = `<h2>管理员</h2><p class="hint">用管理员令牌登录后，可以在网页里重启服务、检查更新、更新并重启、清理缓存。令牌在服务启动窗口里显示，也存在 <code>web/.env</code> 的 <code>TVBOX_ADMIN_TOKEN</code>（第一次启动自动生成）。</p>
        <div class="actions"><input type="password" id="admTok" placeholder="管理员令牌" autocomplete="off" style="max-width:280px"><button class="small" id="admLogin">登录</button></div>`;
      const go = async () => {
        const token = $('#admTok', box).value.trim(); if (!token) return;
        try { await admApi('POST', 'login', { token }); localStorage.adminToken = token; await load(); paint(); toast('已登录管理员'); } catch (e) { toast(e.message); }
      };
      $('#admLogin', box).onclick = go;
      $('#admTok', box).onkeydown = e => { if (e.key === 'Enter') go(); };
      return;
    }
    const u = st.update, j = st.job, run = j && (j.status === 'running' || j.status === 'restarting') || !!busy;
    const last = st.last && !j ? `<p class="lan">上一次操作：${st.last.cancelled ? '' : ''}${{ update: '更新', restart: '重启', clear: '清理缓存', rotate: '换令牌' }[st.last.kind] || st.last.kind}${st.last.cancelled ? '已取消' : st.last.ok ? '成功' + (st.last.to ? `（${esc(st.last.from || '?')} → ${esc(st.last.to)}）` : st.last.unchanged ? '（已是最新）' : '') : '失败：' + esc(st.last.error || '')} · ${ago(st.last.at)}</p>` : '';
    box.innerHTML = `<h2>管理员 <span class="tagl">已登录</span></h2>
      <div class="admgrid">
        <span>版本</span><div>${verTxt(st.ver)}</div>
        <span>更新</span><div>${updTxt(u)}${st.autoCheck ? '' : ' <span class="lan">（自动检查已关闭）</span>'}</div>
        <span>运行</span><div>已运行 ${fmtUp(st.uptime)} · 进程 ${st.workers} 个 · Node ${esc(st.node)} · ${st.ffmpeg ? 'ffmpeg ✓' : '无 ffmpeg'}${st.canRestart ? '' : ' · <span class="warn">没有看守进程，不能自动重启</span>'}</div>
        <span>缓存</span><div>转码 ${fmtSize(st.caches.transcode)} · 封面图片 ${fmtSize(st.caches.covers)}${st.caches.tmp ? ' · 更新临时文件 ' + fmtSize(st.caches.tmp) : ''}</div>
      </div>
      <div class="actions">
        ${j && j.status === 'running' && j.kind === 'update' ? '<button class="small" id="admCancel">取消更新</button>' : ''}
        <button class="small" id="admCheck" ${run ? 'disabled' : ''}>检查更新</button>
        <button class="btn ${u && u.available ? 'red' : 'more'}" id="admUpdate" ${run ? 'disabled' : ''}>更新并重启</button>
        <button class="small" id="admRestart" ${run || !st.canRestart ? 'disabled' : ''}>重启服务</button>
        <span class="grow"></span>
        <button class="small" id="admOut">退出管理员</button>
      </div>
      <details class="admmore"><summary>更多：清理缓存 / 换令牌</summary>
        <div class="actions"><button class="small" data-adc="transcode" ${run ? 'disabled' : ''}>清理转码缓存</button><button class="small" data-adc="covers" ${run || !st.canRestart ? 'disabled' : ''} title="清理后会自动重启">清理封面图片缓存（会重启）</button>
          <button class="small" data-adr="access" ${run || !st.canRestart ? 'disabled' : ''}>换访问令牌</button><button class="small" data-adr="admin" ${run || !st.canRestart ? 'disabled' : ''}>换管理员令牌</button></div>
        <p class="hint">换访问令牌后所有浏览器要重新输入；换管理员令牌后需要用新的重新登录。</p></details>
      ${j && j.progress ? (pg => `<div class="admprog"><div class="bar"><i style="width:${pg.total ? Math.min(100, pg.done / pg.total * 100).toFixed(1) : 100}%" class="${pg.total ? '' : 'ind'}"></i></div><span>${pg.total ? Math.round(pg.done / pg.total * 100) + '% · ' : ''}${(pg.done / 1048576).toFixed(1)}${pg.total ? ' / ' + (pg.total / 1048576).toFixed(1) : ''} MB · ${(pg.speed / 1048576).toFixed(2)} MB/s${pg.total && pg.speed > 0 ? ' · 剩余 ' + Math.max(0, Math.ceil((pg.total - pg.done) / pg.speed)) + ' 秒' : ''} · ${esc(pg.via)}</span></div>`)(j.progress) : ''}
      ${j ? `<pre class="admlog ${j.status}">${jobTxt(j)}${busy ? '\n' + esc(busy) : ''}</pre>` : busy ? `<pre class="admlog">${esc(busy)}</pre>` : ''}${last}`;
    const cn = $('#admCancel', box); if (cn) cn.onclick = async () => { cn.disabled = true; try { await admApi('POST', 'cancel', {}); } catch (e) { toast(e.message); } };
    $('#admOut', box).onclick = async () => { delete localStorage.adminToken; await admApi('POST', 'logout', {}).catch(() => {}); st = { authed: false }; paint(); };
    $('#admCheck', box).onclick = async () => {
      busy = '正在检查更新…'; paint(); checkErr = '';
      try { const r = await admApi('POST', 'check', { force: true }); checkErr = r.checkError || ''; await load(); if (!checkErr) toast(st.update?.available ? '有新版本' : '已是最新'); } catch (e) { checkErr = e.message; }
      busy = ''; paint();
    };
    const runJob = async (path, body, label) => {
      let r;
      try { r = await admApi('POST', path, body); } catch (e) { return toast(e.message); }
      watch(label, r);
    };
    $('#admUpdate', box).onclick = () => { if (confirm(u && !u.available && !u.unknown ? '已经是最新版本，仍要执行更新并重启吗？' : '更新到最新版本并重启服务？重启期间页面会短暂断开。')) runJob('update', {}, '更新'); };
    $('#admRestart', box).onclick = () => { if (confirm('重启服务？重启期间页面会短暂断开。')) runJob('restart', {}, '重启'); };
    $$('[data-adc]', box).forEach(b => b.onclick = () => { if (confirm(b.dataset.adc === 'covers' ? '清理封面和图片缓存，并重启服务？（封面会按需重新生成）' : '清理转码缓存？正在转码的会停掉，下次播放时重新转。')) runJob('clear', { what: b.dataset.adc }, '清理'); });
    $$('[data-adr]', box).forEach(b => b.onclick = async () => {
      const acc = b.dataset.adr === 'access';
      if (!confirm(acc ? '换一个新的访问令牌并重启？所有浏览器都要重新输入新令牌。' : '换一个新的管理员令牌并重启？之后要用新令牌重新登录。')) return;
      let r;
      try { r = await admApi('POST', 'rotate', { which: b.dataset.adr }); } catch (e) { return toast(e.message); }
      if (!acc) localStorage.adminToken = r.token;   // 换的是管理员令牌: 浏览器记住新的, 重启后自动重新登录
      prompt(`新${acc ? '访问' : '管理员'}令牌（已写入 .env；复制保存好）`, r.token);
      watch('换令牌', r);
    });
  };
  // 任务进度: SSE (/api/admin/events) 服务端有变化就推; 断了浏览器自动重连。服务重启时连接断开, 重连后 boot 变了就刷新页面, 用上新代码。
  let esBoot = null, esLabel = '', esDownAt = 0;
  const stopWatch = () => { closeAdminEs(); clearTimeout(admPoll); };
  const watch = (label, r) => {
    st.job = r?.job || st.job; busy = ''; paint();
    esLabel = label || esLabel || '操作'; esBoot = st.boot; esDownAt = 0;
    stopWatch();
    const open = () => {
      if (!alive()) return stopWatch();
      const es = admEs = new EventSource('/api/admin/events');
      es.addEventListener('job', ev => {
        if (!alive()) return stopWatch();
        let x; try { x = JSON.parse(ev.data); } catch { return; }
        if (esDownAt) { esDownAt = 0; busy = ''; }
        if (esBoot && x.boot !== esBoot) { stopWatch(); toast(esLabel + '完成，服务已重启'); setTimeout(() => location.reload(), 400); return; }
        esBoot = x.boot; st.job = x.job; paint();
        const j = x.job;
        if (j && ['done', 'error', 'cancelled'].includes(j.status)) {
          stopWatch(); toast(j.status === 'done' ? esLabel + '完成' : j.status === 'cancelled' ? '已取消' : (j.error || esLabel + '失败'));
          load().then(paint, () => {});
        }
      });
      es.onerror = () => {
        if (admEs !== es) return;
        // 重启中 / 网络断了: EventSource 自己会重连; 被浏览器彻底关掉 (比如 403) 才手动再开, 太久没回来就放弃。
        if (!esDownAt) { esDownAt = Date.now(); busy = '连接断开，正在重连…'; paint(); }
        if (Date.now() - esDownAt > 300e3) { stopWatch(); busy = '等了很久服务还没回来，看看启动窗口 / 日志，或手动刷新页面。'; paint(); return; }
        if (es.readyState === 2) { es.close(); if (admEs === es) admEs = null; admPoll = setTimeout(open, 2000); }
      };
    };
    open();
  };
  try { await load(); } catch (e) { st = { authed: false }; }
  // 浏览器记住了管理员令牌: Cookie 丢了 / 服务换了 Cookie 时自动静默登录 (令牌被换掉了才会丢掉记忆, 重新输入)
  if (!st.authed && localStorage.adminToken) {
    try { await admApi('POST', 'login', { token: localStorage.adminToken }); await load(); }
    catch (e) { if (/不对/.test(e.message)) delete localStorage.adminToken; }
  }
  paint();
  if (st.authed && st.job && (st.job.status === 'running' || st.job.status === 'restarting')) watch({ update: '更新', restart: '重启', clear: '清理', rotate: '换令牌' }[st.job.kind] || '操作', { job: st.job });
  // 自动检查由服务端在启动时和每小时做 (有缓存); 这里打开时如果还没有结果, 顺手查一次
  if (st.authed && !st.update && st.autoCheck && !(st.job && st.job.status === 'running')) {
    try { await admApi('POST', 'check', {}); await load(); paint(); } catch {}
  }
}
function installSection() {
  if (isStandalone()) return '';
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const how = ios ? '用 Safari 打开本页，点底部的分享按钮，选「添加到主屏幕」。'
    : /Android/.test(navigator.userAgent) ? '点浏览器右上角菜单，选「添加到主屏幕」或「安装应用」。'
    : '点地址栏右侧的安装图标，或浏览器菜单里的「安装 TVBOX」。';
  return `<section><h2>添加到桌面</h2><div class="installbox"><img src="icons/icon-192.png" alt=""><p class="hint" style="flex:1;margin:0;min-width:200px">把 TVBOX 放到${ios || /Android/.test(navigator.userAgent) ? '手机' : ''}桌面，像 App 一样全屏打开。${how}</p>
    <button class="small" id="installBtn" ${installEvt ? '' : 'hidden'}>安装</button></div></section>`;
}

const testCache = new Map();
let settingsGoto = '';   // #/settings/account：打开设置页后滚到「账号管理」
async function renderSettings() {
  settingsDirty = false;
  const localP = get('/api/local'); // sent together with the rest, so it never queues behind speed tests
  localP.catch(() => {});
  const [cfg, info, safety] = await Promise.all([get('/api/config'), get('/api/info').catch(() => ({ urls: [] })), get('/api/safety')]);
  const locked = safety.level !== 'all'; // source settings are read-only outside 全部 (the server refuses the writes as well)
  const flags = x => `<label class="flag"><input type="checkbox" class="kids" ${x.kids ? 'checked' : ''}>少儿</label><label class="flag"><input type="checkbox" class="adult" ${x.adult ? 'checked' : ''}>成人</label><label class="flag" title="隐藏后只在点播源 / 直播源菜单的「隐藏」标签里"><input type="checkbox" class="hid" ${x.hidden ? 'checked' : ''}>隐藏</label>`;
  const cacheOf = x => testCache.get(String(x.api || x.url || '').trim());
  const stOf = x => { const t = cacheOf(x); return t ? `<span class="${t.cls}" title="${esc(t.title)}">${esc(t.text)}</span>` : '<span class="status"></span>'; };
  const dragH = '<span class="drag" title="按住拖动排序">⋮⋮</span>';
  const rowHtml = (x, kind, i, parent) => x.members ? `<div class="srow grp" data-i="${i}" ${x.keep ? 'data-keep="1"' : ''} data-key="${esc(x.key)}" data-members="${esc(JSON.stringify(x.members))}">
      <label class="selcell">${dragH}<input type="checkbox" class="sel"><span class="lan">${i + 1}</span></label>
      <input class="nm" value="${esc(x.name)}" placeholder="名称">
      <input class="url" value="" readonly>
      <span class="ops"><span class="tagl">聚合源</span>${flags(x)}<span class="status"></span><button data-op="test" title="测速：逐个测成员，汇总能连上几个">测速</button><button data-op="edit" title="把聚合结果存成一个本地片单再编辑（会失去聚合状态）">编辑文本</button><button data-op="toggle"></button><button data-op="dissolve" title="解散：成员回到主列表，聚合源删除">解散</button><button data-op="del" title="删除聚合源和它的所有成员">删除</button></span></div>`
    : `<div class="srow${parent ? ' mem' : ''}" data-i="${i}" ${parent ? `data-parent="${esc(parent)}" hidden` : ''} ${x.key && kind === 'site' ? `data-key="${esc(x.key)}"` : ''} ${x.from ? `data-from="${esc(x.from)}"` : ''} ${x.restore ? `data-restore="${esc(JSON.stringify(x.restore))}"` : ''} ${x.categories ? `data-cats="${esc(JSON.stringify(x.categories))}"` : ''} ${cacheOf(x) ? `data-ok="${cacheOf(x).cls === 'status ok' ? 1 : 0}"${cacheOf(x).total !== undefined ? ` data-total="${cacheOf(x).total}"` : ''}` : ''}>
      <label class="selcell">${dragH}<input type="checkbox" class="sel"><span class="lan">${i + 1}</span></label>
      <input class="nm" value="${esc(x.name)}" placeholder="名称">
      <input class="url" value="${esc(kind === 'site' ? x.api : x.url)}" placeholder="${kind === 'site' ? 'https://example.com/api.php/provide/vod' : 'https://…/live.m3u / .m3u8 / .txt'}">
      <span class="ops">${kind === 'site' ? `${String(x.api).startsWith('local:') ? '<span class="tagl">本地片单</span>' : ''}${flags(x)}${stOf(x)}<button data-op="preview" title="新开页面看这个源自己的首页效果（不含豆瓣）">预览</button><button data-op="test">测速</button><button data-op="edit" title="把片单存成服务端本地文本再编辑">编辑文本</button>${x.restore && String(x.api).startsWith('local:') ? '<button data-op="undo" title="撤销转换：恢复成转换前的' + (x.restore.group ? '聚合源' : '点播源接口') + '">撤销转换</button>' : ''}<button data-op="release" class="rel" title="移出聚合源，回到主列表">释放</button>` : `${String(x.url).startsWith('local:') ? '<span class="tagl">本地文本</span>' : ''}${flags(x)}${stOf(x)}<button data-op="preview" title="新开页面看这个直播源的分组和频道，可试播">预览</button><button data-op="test">测速</button><button data-op="edit">编辑文本</button>`}
        <button data-op="del">删除</button></span></div>`;
  const rowsHtml = (list, kind) => list.map((x, i) => rowHtml(x, kind, i)).join('');
  // 点播源 list: a 聚合源 row carries its members right under it (collapsed); they are not listed on their own any more.
  const siteRowsHtml = () => {
    const byKey = new Map(cfg.sites.filter(s => !s.members).map(s => [s.key, s]));
    const claimed = new Map();
    for (const g of cfg.sites) if (g.members) for (const k of g.members) if (byKey.has(k) && !claimed.has(k)) claimed.set(k, g.key);
    const out = []; let i = 0;
    for (const x of cfg.sites) {
      if (x.members) {
        const mem = x.members.filter(k => claimed.get(k) === x.key).map(k => byKey.get(k));
        out.push(rowHtml({ ...x, members: mem.map(m => m.key) }, 'site', i++));
        mem.forEach(m => out.push(rowHtml(m, 'site', i++, x.key)));
      } else if (!claimed.has(x.key)) out.push(rowHtml(x, 'site', i++));
    }
    return out.join('');
  };
  const foldOpen = window.__fold || (window.__fold = {});
  const FOLD_AT = 8; // more sources than this: the list starts collapsed
  const fold = (kind, n) => n > FOLD_AT ? `<div class="foldbar" data-foldbar="${kind}"><button class="small" data-foldbtn="${kind}">${foldOpen[kind] ? '收起' : `展开全部 ${n} 个`}</button><span class="lan" data-foldpeek="${kind}"></span></div>` : '';
  const setFold = (kind, open) => {
    foldOpen[kind] = open;
    const box = $(`[data-fold=${kind}]`), btn = $(`[data-foldbtn=${kind}]`); if (!box || !btn) return;
    box.hidden = !open;
    btn.textContent = open ? '收起' : `展开全部 ${$$('.srow', box).length} 个`;
  };
  const bulk = kind => `<div class="actions bulk" data-kind="${kind}"><label class="flag"><input type="checkbox" data-bulk="all">全选</label>
      <button class="small" data-bulk="invert">反选</button><button class="small" data-bulk="delsel">删除选中</button>
      <span class="bwrap"><button class="small" data-bulk="cat">设分类 ▾</button><div class="bmenu" hidden>
        <button data-bulk="setkids">设为 少儿</button><button data-bulk="setadult">设为 成人</button><button data-bulk="setstd">设为 标准（去掉标记）</button></div></span>
      <span class="bwrap"><button class="small" data-bulk="vis">隐藏 ▾</button><div class="bmenu" hidden>
        <button data-bulk="hide">隐藏选中</button><button data-bulk="show">取消隐藏</button></div></span>
      <span class="bwrap"><button class="small" data-bulk="more">更多 ▾</button><div class="bmenu" hidden>
        <button data-bulk="merge" title="${kind === 'live' ? '把选中的直播源合成一个频道列表（同分组归并、相同地址去重）' : '把选中的点播源聚合成一个入口：搜索/浏览/播放线路同时覆盖所有成员，同名影片合并'}">${kind === 'live' ? '合并选中' : '聚合选中'}</button>
        <button data-bulk="export">导出选中</button>
        <button data-bulk="retry">重测不通的</button>
        <button data-bulk="delbad">删除不通的</button>${kind === 'site' ? '<button data-bulk="delempty" title="删除能连上、但一部片都没有的点播源">删除 0 部的</button><button data-bulk="classify" title="按分类名自动判断：80% 以上分类是色情词 → 成人，80% 以上是少儿词 → 少儿，否则标准（不勾选）。只处理还没勾少儿 / 成人的源；勾选了源就只看选中的，否则看全部">自动分类</button>' : ''}</div></span>
      <span class="lan" data-bulk="count"></span></div>`;
  view.innerHTML = `<div class="page set"><h1>设置</h1>
    <section><h2>沉浸式看片</h2><p class="hint">像刷短视频一样看片：上下滑动切换，双击喜欢，系统会按你的口味推荐。</p>
      <div class="actions"><button class="small" data-feed="rec">▶ 开始沉浸观看</button></div></section>
    <section id="acctSec"><h2>账号管理</h2><p class="lan">加载中…</p></section>
    ${installSection()}
    <section><h2>安全级别</h2><p class="hint">儿童：只显示勾了「少儿」的源，关闭直播和豆瓣热门；标准：隐藏勾了「成人」的源以及伦理/写真等分类；全部：不过滤。${safety.hasPin ? '已设家长 PIN。' : '设了 PIN 后，别人想从儿童 / 标准切到更宽松的级别就必须输入 PIN。'}</p>
      <div class="seg big">${Object.entries(LEVELS).map(([k, v]) => `<button data-level="${k}" class="${k === safety.level ? 'on' : ''}">${v}</button>`).join('')}</div>
      <div class="actions"><button class="small" id="setPin">${safety.hasPin ? '修改 / 清除 PIN' : '设置家长 PIN'}</button>${safety.hasPin ? '<span class="lan">切到更宽松的级别、改 PIN 都要输入 PIN；切到更严的级别不用；只有在「全部」下才能清除 PIN。</span>' : ''}</div>
    </section>
    <section><h2>封面</h2><p class="hint">竖版：2:3 海报；横版：16:9，一屏能放更多标题，详情页和首页大图同步变成横版。</p>
      <div class="seg big"><button data-cardmode="poster" class="${cardMode() === 'poster' ? 'on' : ''}">竖版</button><button data-cardmode="wide" class="${cardMode() === 'wide' ? 'on' : ''}">横版</button></div>
      <div class="actions"><span class="lan">大小</span><button class="small" data-csz="-">−</button><button class="small" data-csz="0" data-cs="val">${Math.round(cardScale() * 100)}%</button><button class="small" data-csz="+">+</button><span class="lan">也可以按 ⌘/Ctrl 加 + / − / 0，触控板双指捏合也行；放大到 135% 以上封面会换成高清图。</span></div></section>
    ${safety.level === 'kids' ? '' : `<section><h2>首页豆瓣分类</h2><p class="hint">在点播首页显示豆瓣热门榜单，只影响这个浏览器。儿童模式下不显示；本地媒体源也不显示。</p>
      <div class="field">${DB_ROWS.map(([k, t]) => `<label class="flag"><input type="checkbox" data-dbrow="${k}" ${dbRows()[k] ? 'checked' : ''}>${esc(t.replace('豆瓣热门', ''))}</label>`).join('')}</div></section>`}
    <section id="adminSec"><h2>管理员</h2><p class="lan">加载中…</p></section>
    ${locked ? `<section class="locklote"><h2>源设置已锁定</h2><p class="hint">当前安全级别是「${LEVELS[safety.level]}」。点播源、直播源、少儿 / 成人分类、导入和本地媒体文件夹只能在「全部」下修改，免得误改成人分类。想改的话，先在上面把安全级别切到「全部」${safety.hasPin ? '（需要家长 PIN）' : ''}。</p></section>` : ''}
    <div id="srcWrap" ${locked ? 'hidden' : ''}>
    <section><h2>点播源</h2><p class="hint">苹果CMS 接口（<code>…/api.php/provide/vod</code>，返回 JSON）。需要 spider jar / 解析的 type 3 源浏览器跑不了，导入时会自动跳过。</p>
      ${fold('site', cfg.sites.length)}<div class="foldbox" data-fold="site" ${cfg.sites.length > FOLD_AT && !foldOpen.site ? 'hidden' : ''}>${bulk('site')}<div id="sites">${siteRowsHtml()}</div></div>
      <div class="actions"><button class="small" id="addSite">+ 添加点播源</button><button class="small" id="testAll">全部测速</button><button class="small" id="stopTest">停止测速</button></div></section>
    <section id="localSec"><h2>本地媒体 <span class="tagl">内置源</span></h2><p class="lan">加载中…</p></section>
    <section><h2>直播源</h2><p class="hint">支持 m3u / m3u8 频道列表、TVBox txt（<code>频道名,地址</code> + <code>分组,#genre#</code>），或者单条 .m3u8 播放地址。内置文件直接写文件名。「编辑文本」可以直接改频道列表。勾上「少儿 / 成人」标记整个直播源；没标记的也会按分组、频道名自动识别：标准模式隐藏成人分组，儿童模式只留少儿分组。</p>
      ${fold('live', cfg.lives.length)}<div class="foldbox" data-fold="live" ${cfg.lives.length > FOLD_AT && !foldOpen.live ? 'hidden' : ''}>${bulk('live')}<div id="lives">${rowsHtml(cfg.lives, 'live')}</div></div>
      <div class="actions"><button class="small" id="addLive">+ 添加直播源</button><button class="small" id="testLives">全部测速</button></div></section>
    <div class="actions savebar"><button class="btn red" id="save">保存</button><span class="lan" id="dirty"></span></div>
    <section><h2>从剪贴板识别</h2><p class="hint">复制一段含源地址的文字（接口地址、m3u/txt 链接、直播流、TVBox 配置 JSON 或整段频道列表都行），在任意页面按 <code>Ctrl/⌘ + V</code>，或者粘到下面。识别后列出新源，确认后去重添加。</p>
      <div class="field"><textarea id="clipText" placeholder="粘贴到这里" style="min-height:110px"></textarea></div>
      <div class="actions"><button class="small" id="clipRead">读取剪贴板</button><button class="small" id="clipGo">识别</button><button class="small" id="exportAll">导出全部到剪贴板</button></div></section>
    <section><h2>导入 TVBox 配置</h2><p class="hint">粘贴 TVBox 配置地址（单仓或多仓 <code>{"urls":[…]}</code>），把其中能直连的点播源和直播源合并进来。</p>
      <div class="field"><input id="impUrl" placeholder="https://…/config.json"><label class="lan"><input type="checkbox" id="impReplace"> 替换现有</label><button class="small" id="imp">导入</button></div></section>
    <section><h2>高级：直接编辑 JSON</h2><p class="hint">格式 <code>{"sites":[{"key","name","api","kids","adult","categories"}],"lives":[{"name","url"}]}</code>，可整份复制到别的设备。</p>
      <div class="field"><textarea id="raw" spellcheck="false">${esc(JSON.stringify(cfg, null, 2))}</textarea></div>
      <div class="actions"><button class="small" id="saveRaw">保存 JSON</button><button class="small" id="reset">恢复默认</button></div></section>
    </div></div>`;

  const collect = (box, kind) => $$('.srow', box).map(r => {
    const name = $('.nm', r).value.trim(), url = $('.url', r).value.trim();
    if (r.dataset.members) return { key: r.dataset.key, name: name || r.dataset.key, type: 1, members: JSON.parse(r.dataset.members), api: 'group', ...($('.kids', r).checked ? { kids: 1 } : {}), ...($('.adult', r).checked ? { adult: 1 } : {}), ...($('.hid', r).checked ? { hidden: 1 } : {}) };
    if (kind !== 'site') return { name: name || url, url, ...(r.dataset.from ? { from: r.dataset.from } : {}), ...($('.kids', r).checked ? { kids: 1 } : {}), ...($('.adult', r).checked ? { adult: 1 } : {}), ...($('.hid', r).checked ? { hidden: 1 } : {}) };
    const s = { key: r.dataset.key || name || url, name: name || url, type: 1, api: url };
    if ($('.kids', r).checked) s.kids = 1;
    if ($('.adult', r).checked) s.adult = 1;
    if ($('.hid', r).checked) s.hidden = 1;
    if (r.dataset.cats) s.categories = JSON.parse(r.dataset.cats);
    if (r.dataset.restore && url.startsWith('local:')) s.restore = JSON.parse(r.dataset.restore);
    return s;
  }).filter(x => (x.api || x.url));
  const current = () => ({ sites: collect($('#sites'), 'site'), lives: collect($('#lives'), 'live') });
  const dirty = () => { settingsDirty = true; settingsHash = location.hash; const d = $('#dirty'); if (d) d.textContent = '有未保存的修改'; };
  const isMem = r => r.classList.contains('mem');
  const blockOf = head => {
    const b = [head];
    if (!head.dataset.members) return b;
    for (let n = head.nextElementSibling; n && isMem(n) && n.dataset.parent === head.dataset.key; n = n.nextElementSibling) b.push(n);
    return b;
  };
  const headOf = r => { while (r && isMem(r)) r = r.previousElementSibling; return r; };
  const unMem = m => { m.classList.remove('mem'); delete m.dataset.parent; m.hidden = false; };
  // Members, the summary text and the expand button of every 聚合源 row follow what is actually under it; an empty one goes away.
  const syncGroups = () => $$('#sites .srow.grp').forEach(g => {
    const mem = $$('#sites .srow.mem').filter(m => m.dataset.parent === g.dataset.key);
    if (!mem.length) return g.dataset.keep ? undefined : g.remove();
    g.dataset.members = JSON.stringify(mem.map(m => m.dataset.key));
    $('.url', g).value = `聚合 ${mem.length} 个源：` + mem.map(m => $('.nm', m).value.trim() || m.dataset.key).join('、');
    $('[data-op=toggle]', g).textContent = (g.dataset.open ? '收起 ' : '展开 ') + mem.length;
    mem.forEach(m => { m.hidden = !g.dataset.open; });
  });
  const renumber = () => {
    syncGroups();
    $$('#sites, #lives').forEach(box => { let n = 0; $$('.srow', box).forEach(r => { const m = isMem(r); r.dataset.i = n; $('.lan', r).textContent = m ? '' : ++n; }); });
  };
  const refreshCount = () => $$('.bulk').forEach(b => {
    const box = $(b.dataset.kind === 'site' ? '#sites' : '#lives'), n = $$('.sel:checked', box).length, all = $$('.srow', box).length;
    $('[data-bulk=count]', b).textContent = n ? `已选 ${n} / ${all}` : `共 ${all}`;
    $('[data-bulk=all]', b).checked = n > 0 && n === all; });
  const addRow = (kind, x, before) => {
    if ($(`[data-fold=${kind}]`)?.hidden) setFold(kind, true);
    const box = $(kind === 'site' ? '#sites' : '#lives');
    const tpl = document.createElement('div'); tpl.innerHTML = rowHtml(x, kind, 0);
    const row = tpl.firstElementChild;
    box.insertBefore(row, before || null); renumber(); dirty(); refreshCount();
    return row;
  };
  // Up / down: a member moves inside its group, anything else moves together with its members, past the neighbouring entry.
  const moveRow = (r, dir) => {
    if (isMem(r)) {
      const s = dir < 0 ? r.previousElementSibling : r.nextElementSibling;
      if (s && isMem(s) && s.dataset.parent === r.dataset.parent) dir < 0 ? s.before(r) : s.after(r);
      return;
    }
    const blk = blockOf(r);
    if (dir < 0) { const p = r.previousElementSibling; if (p) headOf(p).before(...blk); }
    else { const n = blk[blk.length - 1].nextElementSibling; if (n) { const nb = blockOf(n); nb[nb.length - 1].after(...blk); } }
  };
  const dropRows = rows => { rows.forEach(r => (r.dataset.members ? blockOf(r) : [r]).forEach(x => x.remove())); renumber(); dirty(); refreshCount(); };
  // Saves without rebuilding the page (fold state, scroll position and speed-test results stay as they are).
  // Only the raw-JSON editor re-renders, since there the text itself may have been normalised.
  const persist = async (c, rerender) => {
    const j = await req('PUT', '/api/config', c);
    state.cats = []; apiMemo.clear(); await loadSites(); toast('已保存');
    settingsDirty = false;
    if (rerender) return renderSettings();
    // The server de-duplicates by link and may rename keys: drop rows it removed, keep every other row untouched.
    const keep = new Set((j.sites || []).map(x => x.key));
    $$('#sites .srow[data-key]').forEach(r => { if (!keep.has(r.dataset.key)) r.remove(); });
    renumber(); refreshCount();
    settingsDirty = false;
    const d = $('#dirty'); if (d) d.textContent = '';
    const raw = $('#raw'); if (raw) raw.value = JSON.stringify(j, null, 2);
  };
  // Speed test: bounded concurrency (so hundreds of sources don't flood the network), auto retry on failure,
  // results cached per url so they survive deleting / reordering / re-rendering.
  const RETRIES = 2;
  // Each row carries its own run token (r._tok): starting a test on one row only supersedes that row's earlier run.
  // Only 「停止测速」 (stopEpoch) cancels everything that is queued or running.
  let testSeq = 0, stopEpoch = 0;
  const TEST_TIMEOUT = 22e3; // the server gives up on a source after 15 s; a request that hangs must never hold a slot of the pool
  const testOnce = async (url, name, live) => {
    const signal = AbortSignal.timeout(TEST_TIMEOUT);
    if (live) {
      const j = await api('checklive', { url, name }, signal).catch(e => ({ ok: false, error: e.message }));
      return { ok: !!j.ok, text: j.channels ? `${j.ms}ms · ${j.channels}台 · 抽测${j.alive}/${j.sampled}` : '不通', title: j.error || '随机抽 8 个频道，能拿到数据的算可连' };
    }
    const j = await api('check', { api: url }, signal).catch(e => ({ ok: false, error: e.message }));
    return { ok: !!j.ok, total: j.ok ? j.total : undefined, text: j.ok ? `${j.ms}ms · ${j.total}部` : '不通', title: j.error || '' };
  };
  // A row that was queued / running when its run was cancelled goes back to its last known result (or blank).
  const restoreRow = r => {
    const st = $('.status', r); if (!st) return;
    const c = testCache.get($('.url', r)?.value.trim());
    st.className = c ? c.cls : 'status'; st.textContent = c ? c.text : ''; st.title = c ? c.title : '';
    if (!c) { delete r.dataset.ok; delete r.dataset.total; }
    sumGroups();
  };
  // 聚合源 row: summary of its member rows (how many answer), kept in step with the pool as results come in.
  const sumGroups = () => $$('#sites .srow.grp').forEach(g => {
    const st = $('.status', g); if (!st) return;
    const ms = blockOf(g).slice(1);
    const reset = () => { st.className = 'status'; st.textContent = ''; st.title = ''; };
    if (!ms.length) return reset();
    if (ms.some(m => /测试中|重试|排队/.test($('.status', m)?.textContent || ''))) { st.className = 'status'; st.textContent = `测试中 ${ms.filter(m => m.dataset.ok !== undefined).length}/${ms.length}`; return; }
    const tested = ms.filter(m => m.dataset.ok !== undefined), okN = tested.filter(m => m.dataset.ok === '1').length;
    if (tested.length < ms.length) return reset();
    st.className = 'status ' + (okN ? 'ok' : 'bad'); st.textContent = `${okN}/${ms.length} 可用`; st.title = '成员里能连上的';
  });
  const claim = r => (r._tok = ++testSeq);
  const test = async (r, tok = claim(r), epoch = stopEpoch) => {
    const st = $('.status', r), url = $('.url', r).value.trim(), live = r.parentElement.id === 'lives';
    if (!url || r.dataset.members) return;
    const superseded = () => r._tok !== tok;                      // a newer run of this same row owns the status now
    const stale = () => superseded() || epoch !== stopEpoch || !r.isConnected;
    const bail = () => { if (!superseded()) restoreRow(r); };
    if (stale()) return bail();
    st.className = 'status'; st.textContent = '测试中…'; sumGroups();
    let res;
    for (let k = 0; k <= RETRIES; k++) {
      if (stale()) return bail();
      if (k) { st.textContent = `重试 ${k}/${RETRIES}…`; await new Promise(ok => setTimeout(ok, 600 * k)); if (stale()) return bail(); }
      res = await testOnce(url, $('.nm', r).value.trim(), live);
      if (res.ok) break;
    }
    if (stale()) return bail();
    const cls = 'status ' + (res.ok ? 'ok' : 'bad');
    st.className = cls; st.textContent = res.text; st.title = res.title;
    r.dataset.ok = res.ok ? '1' : '0';
    if (res.total !== undefined) r.dataset.total = res.total; else delete r.dataset.total;
    sumGroups();
    if (res.ok) testCache.set(url, { cls, text: res.text, title: res.title, total: res.total }); else testCache.delete(url);
  };
  // One pool for sites and lives together: at most 4 requests in flight, so page loads and /api/local are never starved
  // (browsers allow only 6 connections per host). Entries that were superseded or stopped drain instantly (test() bails out).
  const TEST_MAX = 4, testQ = []; let testRun = 0;
  const pump = () => {
    while (testRun < TEST_MAX && testQ.length) {
      const { r, tok, epoch, done } = testQ.shift(); testRun++;
      test(r, tok, epoch).catch(() => {}).finally(() => { testRun--; done(); pump(); });
    }
  };
  // Every row of the run says 排队中 right away; the pool turns them into 测试中… four at a time.
  const testMany = rows => Promise.all(rows.map(r => new Promise(done => {
    const st = $('.status', r);
    if (st && $('.url', r).value.trim() && !r.dataset.members) { st.className = 'status'; st.textContent = '排队中'; st.title = ''; }
    testQ.push({ r, tok: claim(r), epoch: stopEpoch, done }); sumGroups(); pump();
  })));
  // 点播源: the title list becomes a text file on the server (a web source starts from a full copy).
  const editVodText = async r => {
    const isGroup = !!r.dataset.members, keys = isGroup ? JSON.parse(r.dataset.members) : [];
    const url = isGroup ? 'group:' + r.dataset.key : $('.url', r).value.trim(), name = $('.nm', r).value.trim() || url;
    if (!url) return toast('先填接口地址');
    if (isGroup) {
      if (!keys.length) return toast('这个聚合源没有成员');
      if (!confirm(`把聚合源「${name}」转成本地片单？\n成员源会被隐藏，之后可以撤销。`)) return;
    }
    const m = document.createElement('div');
    let editorOf = null;
    m.className = 'modal'; m.id = 'textModal';
    m.innerHTML = `<div class="sheet editor"><div class="body"><h3>编辑「${esc(name)}」<span class="lan" id="chCount"></span></h3>
      <p class="hint">每行一部：<code>片名,播放地址</code>；分类写 <code>分类名,#genre#</code>。</p>
      <div id="liveText" class="edhost"><p class="lan edload">${url.startsWith('local:') ? '加载中…' : '正在拉取…'}</p></div>
      <div class="actions"><button class="btn red" id="ltSave" disabled>保存</button><button class="small" id="ltCancel">取消</button></div></div></div>`;
    document.body.append(m); document.body.style.overflow = 'hidden';
    const jobId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    let gone = false, started = false;
    const close = () => { gone = true; editorOf?.dispose(); m.remove(); document.body.style.overflow = ''; if (started) req('POST', '/api/vod/snap', { id: jobId, op: 'cancel' }).catch(() => {}); };
    m.onclick = e => { if (e.target === m) close(); };
    $('#ltCancel').onclick = close;
    // 网页源: 服务端分级拉取 (前 20 页并发最高、先拉完；之后逐档降速)，这里每秒看一次进度；随时可以「先用已拉到的」收工。
    const TIER = ['前 20 页', '21–200 页', '200 页之后'];
    const runSnap = async () => {
      const st = await req('POST', '/api/vod/snap', isGroup ? { id: jobId, op: 'start', keys } : { id: jobId, op: 'start', api: url }).catch(e => ({ error: e.message }));
      if (st.error) return { text: '', error: st.error };
      started = true;
      const early = document.createElement('button'); early.className = 'small'; early.id = 'ltEarly'; early.textContent = '先用已拉到的';
      early.title = '停止继续拉取，用已经拉到的部分（靠前的页）先编辑保存';
      early.onclick = () => { early.disabled = true; early.textContent = '收尾中…'; req('POST', '/api/vod/snap', { id: jobId, op: 'stop' }).catch(() => {}); };
      $('#ltCancel').before(early);
      let bad = 0;
      try {
        while (!gone) {
          await new Promise(r => setTimeout(r, 1000));
          if (gone) break;
          let p; try { p = await api('vod/snap', { id: jobId }); bad = 0; } catch { if (++bad > 30) return { text: '', error: '和服务端失去联系了' }; continue; }
          if (p.error && p.state !== 'error') return { text: '', error: p.error };
          const el = $('.edload', m);
          if (el && p.total) el.textContent = `${p.stopping ? '收尾中' : '正在拉取'} ${p.done}/${p.total} 页 · ${p.titles} 部`;
          if (p.state === 'done') return await api('vod/snap', { id: jobId, text: '1' });
          if (p.state === 'error') return { text: '', error: p.error };
        }
      } finally { early.remove(); }
      return { text: '', error: '已取消' };
    };
    const j = await (url.startsWith('local:') ? api('vod/raw', { api: url }).catch(e => ({ text: '', error: e.message })) : runSnap());
    if (!m.isConnected) return;
    if (j.error) toast(j.error + (isGroup ? '' : '，可以直接手写片单'));
    else if (j.partial) toast(`只拉了前 ${j.pages} 页`);
    if (isGroup && j.members) {
      const bad = j.members.filter(x => !x.ok);
      if (bad.length) toast(`${bad.length} 个成员没取到：${bad.map(x => x.name).join('、')}`);
    }
    const applyOut = async out => {
    if (isGroup) {
      // The group row turns into an ordinary 本地片单 source: swap it for a plain row in place (its members stay in the list).
      // 聚合源转成本地片单后，原来的成员源不再单独露出：标为「隐藏」(只在菜单的「隐藏」标签里)，撤销时再恢复
      const memRows = blockOf(r).slice(1), unhide = memRows.filter(m => !$('.hid', m).checked).map(m => m.dataset.key);
      memRows.forEach(m => { $('.hid', m).checked = true; });
      const tpl = document.createElement('div');
      tpl.innerHTML = rowHtml({ name: $('.nm', r).value.trim(), api: out.api, restore: { group: { key: r.dataset.key, unhide, name: $('.nm', r).value.trim(), members: keys, ...($('.kids', r).checked ? { kids: 1 } : {}), ...($('.adult', r).checked ? { adult: 1 } : {}), ...($('.hid', r).checked ? { hidden: 1 } : {}) } }, kids: $('.kids', r).checked ? 1 : 0, adult: $('.adult', r).checked ? 1 : 0, hidden: $('.hid', r).checked ? 1 : 0 }, 'site', +r.dataset.i || 0);
      const plain = tpl.firstElementChild;
      blockOf(r).slice(1).forEach(unMem);
      r.replaceWith(plain);
      close();
      await persist(current());
      toast(`已转成本地片单（${out.titles} 部）`);
      return renderSettings();
    }
    if (!url.startsWith('local:') && !isGroup) { r.dataset.from = url; r.dataset.restore = JSON.stringify({ api: url }); }
    $('.url', r).value = out.api;
    close();
    await persist(current());
    toast(`已存成本地片单（${out.titles} 部）`);
    renderSettings();
    };
    if (j.big) {   // 片太多: 不放进编辑器，服务端把拉到的临时文件直接存成本地片单
      try { await applyOut(await req('POST', '/api/vod/snap', { id: jobId, op: 'commit' })); } catch (err) { toast(err.message); close(); }
      return;
    }
    const ta = await textEditor($('#liveText'), { value: j.text || '我的分类,#genre#\n片名,https://example.com/movie.m3u8\n剧名,第1集$https://example.com/1.m3u8#第2集$https://example.com/2.m3u8\n' });
    if (!m.isConnected) { ta.dispose(); return; }
    editorOf = ta;
    const count = () => { $('#chCount').textContent = `${new Set(ta.value.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('//') && !l.startsWith('#') && /^[^,]+,.*https?:\/\//.test(l) && !/,#genre#/.test(l)).map(l => l.slice(0, l.indexOf(',')))).size} 部`; };
    ta.onchange = count; count(); ta.focus();
    $('#ltSave').disabled = false;
    $('#ltSave').onclick = async () => {
      const b = $('#ltSave'); b.disabled = true; b.textContent = '保存中…';
      try { await applyOut(await req('PUT', '/api/vod/raw', { api: isGroup ? 'new' : url, text: ta.value })); }
      catch (err) { toast(err.message); b.disabled = false; b.textContent = '保存'; }
    };
  };
  const editText = async r => {
    if (r.parentElement.id === 'sites') return editVodText(r);
    let url = $('.url', r).value.trim();
    const name = $('.nm', r).value.trim() || url;
    const info_ = await infoP().catch(() => ({}));
    const m = document.createElement('div');
    let ta = null;
    m.className = 'modal'; m.id = 'textModal';
    m.innerHTML = `<div class="sheet editor"><div class="body"><h3>编辑「${esc(name)}」<span class="lan" id="chCount"></span></h3>
      <p class="hint">m3u（<code>#EXTINF:-1 group-title="分组" tvg-logo="…",频道名</code> 下一行写地址）或 TVBox txt（<code>分组,#genre#</code> / <code>频道名,地址</code>）。保存后存成服务端本地文件，不再拉原地址。⌘/Ctrl+S 保存，⌘/Ctrl+F 查找，⌘/Ctrl+H 替换。</p>
      <div id="liveText" class="edhost"><p class="lan edload">加载中…</p></div>
      <div class="actions"><button class="btn red" id="ltSave" disabled>保存</button><button class="small" id="ltCancel">取消</button>${info_.loopback ? '<button class="small" id="ltVsc" title="改用本机的 VS Code 打开这个文件（保存文件即生效）">在 VS Code 打开</button>' : ''}</div></div></div>`;
    document.body.append(m); document.body.style.overflow = 'hidden';
    const close = () => { ta?.dispose(); m.remove(); document.body.style.overflow = ''; };
    m.onclick = e => { if (e.target === m) close(); };
    $('#ltCancel').onclick = close;
    const j = await api('live/raw', { url }).catch(e => ({ text: '', error: e.message }));
    if (!m.isConnected) return;
    ta = await textEditor($('#liveText'), { value: j.text || '#EXTM3U\n#EXTINF:-1 group-title="我的频道",频道名\nhttps://example.com/live.m3u8\n' });
    if (!m.isConnected) { ta.dispose(); return; }
    const count = () => { const v = ta.value; $('#chCount').textContent = `${(v.match(/^#EXTINF/gm) || []).length || v.split('\n').filter(l => /,https?:\/\//.test(l)).length} 个频道`; };
    ta.onchange = count; count(); ta.focus();
    $('#ltSave').disabled = false;
    $('#ltSave').onclick = async () => {
      const b = $('#ltSave'); b.disabled = true; b.textContent = '保存中…';
      try {
        const out = await req('PUT', '/api/live/raw', { url, text: ta.value });
        if (!url.startsWith('local:')) { r.dataset.from = url; $('.url', r).value = out.url; }
        close();
        await persist(current());
      } catch (err) { toast(err.message); b.disabled = false; b.textContent = '保存'; }
    };
    if ($('#ltVsc')) $('#ltVsc').onclick = async () => {
      try {
        const o = await req('POST', '/api/live/edit', { url });
        if (!url.startsWith('local:')) { r.dataset.from = url; $('.url', r).value = url = o.url; await persist(current()); }
        if (o.ok) { close(); toast('已在 VS Code 打开，保存文件即生效（频道列表每次都从这个文件读）'); } else toast(o.error);
      } catch (err) { toast(err.message); }
    };
  };
  view.onclick = async e => {
    const cm = e.target.dataset.cardmode;
    if (cm) return setCardMode(cm);
    if (e.target.dataset.csz) return setCardScale(e.target.dataset.csz === '0' ? 1 : cardScale() + (e.target.dataset.csz === '+' ? CS_STEP : -CS_STEP), true);
    const lv = e.target.dataset.level;
    if (lv) {
      if (!leaveSettingsOk()) return;   // the page is rebuilt with the new level
      try {
        const looser = ({ kids: 0, standard: 1, all: 2 })[lv] > ({ kids: 0, standard: 1, all: 2 })[safety.level];
        await req('POST', '/api/safety', { level: lv, pin: sessionStorage.pin || '' });
        if (safety.hasPin && !looser) delete sessionStorage.pin;   // locking again: the PIN is asked for next time
        state.cats = []; await loadSites(); toast('安全级别：' + LEVELS[lv]); renderSettings(); }
      catch (err) { toast(err.message); }
      return;
    }
    const fb = e.target.dataset.foldbtn;
    if (fb) return setFold(fb, $(`[data-fold=${fb}]`).hidden);
    const bk = e.target.dataset.bulk;
    if (bk) return bulkOp(e.target, bk);
    if (e.target.classList.contains('sel')) return refreshCount();
    const op = e.target.dataset.op; if (!op) return;
    const r = e.target.closest('.srow');
    if (op === 'preview') {
      let cats = ''; try { cats = (JSON.parse(r.dataset.cats || '[]') || []).length ? r.dataset.cats : ''; } catch {}
      return previewSource(r.closest('#sites') ? 'vod' : 'live', { url: $('.url', r).value, name: $('.nm', r).value, cats });
    }
    if (op === 'test') {
      if (r.dataset.members) { const ms = blockOf(r).slice(1); return ms.length ? testMany(ms) : toast('这个聚合源没有成员'); }
      return test(r);
    }
    if (op === 'edit') return editText(r);
    if (op === 'del') return dropRows([r]);
    if (op === 'undo') {
      let rs; try { rs = JSON.parse(r.dataset.restore || 'null'); } catch {}
      if (!rs) return toast('没有可以撤销的记录');
      if (!confirm(rs.group ? '撤销转换，恢复成聚合源？' : '撤销转换，恢复成原来的接口？')) return;
      if (rs.group) {
        const g = rs.group, mem = g.members.map(k => $$('#sites .srow[data-key]').find(x => x.dataset.key === k && x !== r && !x.dataset.members)).filter(Boolean);
        if (!mem.length) return toast('原来的成员源都不在列表里了，没法恢复成聚合源');
        const tpl = document.createElement('div');
        tpl.innerHTML = rowHtml({ ...g, keep: false }, 'site', +r.dataset.i || 0);
        const head = tpl.firstElementChild;
        r.replaceWith(head);
        let at = head;
        for (const m of mem) { m.classList.add('mem'); m.dataset.parent = g.key; m.hidden = true; at.after(m); at = m; if ((g.unhide || []).includes(m.dataset.key)) $('.hid', m).checked = false; }
      } else {
        $('.url', r).value = rs.api; delete r.dataset.restore; delete r.dataset.from;
      }
      try { await persist(current(), true); toast('已撤销转换'); } catch (err) { toast(err.message); }
      return;
    }
    if (op === 'toggle') { r.dataset.open = r.dataset.open ? '' : '1'; return syncGroups(); }
    if (op === 'dissolve') {
      if (!confirm(`解散聚合源「${$('.nm', r).value.trim()}」？成员回到主列表。`)) return;
      blockOf(r).slice(1).forEach(unMem); r.remove(); renumber(); dirty(); return refreshCount();
    }
    if (op === 'release') {
      const g = $$('#sites .srow.grp').find(x => x.dataset.key === r.dataset.parent);
      if (g) { const rest = blockOf(g).filter(x => x !== r); rest[rest.length - 1].after(r); }
      unMem(r); renumber(); dirty(); return refreshCount();
    }
    if (op === 'up' || op === 'down') moveRow(r, op === 'up' ? -1 : 1);
    renumber(); dirty();
  };
  // Export rows as a shareable JSON set. Local / edited live lists carry their channel text so the paste is self-contained.
  const exportSources = async (siteRows, liveRows) => {
    try {
      const gRows = siteRows.filter(r => r.dataset.members);
      const groups = gRows.map(r => ({ key: r.dataset.key, name: $('.nm', r).value.trim(), members: JSON.parse(r.dataset.members), ...($('.kids', r).checked ? { kids: 1 } : {}), ...($('.adult', r).checked ? { adult: 1 } : {}) }));
      const gKeys = new Set(gRows.map(r => r.dataset.key));
      siteRows = [...new Set([...siteRows.filter(r => !r.dataset.members), ...$$('#sites .srow.mem').filter(m => gKeys.has(m.dataset.parent))])];
      let sites = siteRows.map(r => {
        const s = { key: r.dataset.key || undefined, name: $('.nm', r).value.trim(), api: $('.url', r).value.trim() };
        if ($('.kids', r).checked) s.kids = 1;
        if ($('.adult', r).checked) s.adult = 1;
        if (r.dataset.cats) s.categories = JSON.parse(r.dataset.cats);
        return s;
      }).filter(s => s.api);
      // A 本地片单 only exists on this server: it travels as its text, like an edited channel list.
      for (let i = 0; i < sites.length; i++) {
        if (!String(sites[i].api).startsWith('local:')) continue;
        const j = await api('vod/raw', { api: sites[i].api });
        const { api: _a, key: _k, ...rest } = sites[i];
        if (j.text) sites[i] = { ...rest, text: j.text }; else sites[i] = null;
      }
      sites = sites.filter(Boolean);
      const lives = [];
      for (const r of liveRows) {
        const l = { name: $('.nm', r).value.trim(), url: $('.url', r).value.trim(), ...($('.kids', r).checked ? { kids: 1 } : {}), ...($('.adult', r).checked ? { adult: 1 } : {}) };
        if (!l.url) continue;
        if (!/^https?:\/\//.test(l.url)) {
          const j = await api('live/raw', { url: l.url });
          if (!j.text) continue;
          lives.push({ name: l.name, text: j.text, ...(l.kids ? { kids: 1 } : {}), ...(l.adult ? { adult: 1 } : {}) });
        } else lives.push(l);
      }
      sites.push(...groups);
      if (!sites.length && !lives.length) return toast('没有可导出的源');
      const text = JSON.stringify({ tvbox: 1, sites, lives }, null, 1);
      if (await copyText(text)) toast(`已复制 ${sites.length} 个点播源、${lives.length} 个直播源，到另一台设备粘贴即可导入`);
      else { $('#clipText').value = text; $('#clipText').select(); toast('浏览器不让自动复制，已放进下面的框里，请手动复制'); }
    } catch (err) { toast('导出失败：' + err.message); }
  };
  const bulkOp = async (btn, op) => {
    const bar = btn.closest('.bulk'), kind = bar.dataset.kind, box = $(kind === 'site' ? '#sites' : '#lives'), rows = $$('.srow', box);
    const sel = rows.filter(r => $('.sel', r).checked);
    if (op === 'more' || op === 'cat' || op === 'vis') return toggleBulkMenu(btn);
    closeBulkMenus();
    if (op === 'setkids' || op === 'setadult' || op === 'setstd') {
      if (!sel.length) return toast('先勾选要设置的源');
      for (const r of sel) { $('.kids', r).checked = op === 'setkids'; $('.adult', r).checked = op === 'setadult'; }
      dirty();
      return toast(`已把 ${sel.length} 个设为${({ setkids: '少儿', setadult: '成人', setstd: '标准' })[op]}，点「保存」后生效`);
    }
    if (op === 'hide' || op === 'show') {
      if (!sel.length) return toast('先勾选要设置的源');
      for (const r of sel) $('.hid', r).checked = op === 'hide';
      dirty();
      return toast(`已${op === 'hide' ? '隐藏' : '取消隐藏'} ${sel.length} 个，点「保存」后生效`);
    }
    if (op === 'all') { rows.forEach(r => { $('.sel', r).checked = btn.checked; }); return refreshCount(); }
    if (op === 'invert') { rows.forEach(r => { $('.sel', r).checked = !$('.sel', r).checked; }); return refreshCount(); }
    if (op === 'delsel') {
      if (!sel.length) return toast('先勾选要删除的源');
      if (confirm(`删除选中的 ${sel.length} 个源？（点「保存」后生效）`)) dropRows(sel);
      return;
    }
    if (op === 'export') {
      if (!sel.length) return toast('先勾选要导出的源');
      return exportSources(kind === 'site' ? sel : [], kind === 'live' ? sel : []);
    }
    if (op === 'classify') {
      // Only sources that carry no 少儿 / 成人 mark yet: a classification someone already made is never overwritten.
      const targets = (sel.length ? sel : rows).filter(r => !r.dataset.members && !$('.kids', r).checked && !$('.adult', r).checked && /^https?:\/\//.test($('.url', r).value.trim()));
      if (!targets.length) return toast('没有未分类的点播源（已勾少儿 / 成人的不会改）');
      if (btn.dataset.busy) return toast('自动分类正在进行');
      // 8 at a time: the toast shows how far it is, and each batch is applied to the rows as soon as it is back.
      const label = btn.textContent, STEP = 8, n = { adult: 0, kids: 0, none: 0, fail: 0 };
      btn.disabled = true; btn.dataset.busy = '1'; btn.textContent = `分类中 ${targets.length}…`;
      const bar = toast(`自动分类 0/${targets.length}…`, true);
      const line = done => `自动分类 ${done}/${targets.length} · 成人 ${n.adult} · 少儿 ${n.kids} · 标准 ${n.none}${n.fail ? ` · 连不上 ${n.fail}` : ''}`;
      try {
        let done = 0;
        for (let i = 0; i < targets.length; i += STEP) {
          const part = targets.slice(i, i + STEP);
          if (part.some(r => !r.isConnected)) throw new Error('页面已刷新');
          const j = await req('POST', '/api/classify', { apis: part.map(r => $('.url', r).value.trim()) });
          part.forEach((r, k) => {
            const x = j.results[k];
            if (!x) { n.fail++; return; }
            $('.adult', r).checked = x.kind === 'adult'; $('.kids', r).checked = x.kind === 'kids'; n[x.kind]++;
            const lab = $('.flag', r)?.parentElement; if (lab) lab.title = `${x.total} 个分类：成人词 ${x.adult}，少儿词 ${x.kids}`;
          });
          done += part.length; bar.textContent = line(done);
          dirty();
        }
        bar.remove();
        toast(`自动分类完成：成人 ${n.adult} · 少儿 ${n.kids} · 标准 ${n.none}${n.fail ? ` · ${n.fail} 个连不上（没改）` : ''}，点「保存」后生效`);
      } catch (err) { bar.remove(); toast('自动分类中断：' + err.message + (n.adult + n.kids + n.none ? `（已处理的 ${n.adult + n.kids + n.none} 个保留，点「保存」后生效）` : '')); }
      finally { btn.disabled = false; delete btn.dataset.busy; btn.textContent = label; }
      return;
    }
    if (op === 'retry') {
      const bad = rows.filter(r => r.dataset.ok === '0');
      if (!bad.length) return toast('没有不通的源');
      return testMany(bad);
    }
    if (op === 'delbad') {
      const todo = rows.filter(r => !r.dataset.ok && !r.dataset.members && $('.url', r).value.trim());
      if (todo.length) { toast(`还有 ${todo.length} 个没测过，先测速…`); await testMany(todo); }
      const bad = $$('.srow', box).filter(r => r.dataset.ok === '0');
      if (!bad.length) return toast('没有不通的源');
      if (confirm(`删除 ${bad.length} 个不通的源？（已自动重试 ${RETRIES} 次；点「保存」后生效）`)) dropRows(bad);
      return;
    }
    if (op === 'delempty') {
      const todo = rows.filter(r => r.dataset.ok === undefined && !r.dataset.members && !r.dataset.cats && $('.url', r).value.trim());
      if (todo.length) { toast(`还有 ${todo.length} 个没测过，先测速…`); await testMany(todo); }
      const empty = $$('.srow', box).filter(r => r.dataset.ok === '1' && r.dataset.total === '0');
      if (!empty.length) return toast('没有 0 部内容的点播源');
      if (confirm(`删除 ${empty.length} 个 0 部内容的点播源？（点「保存」后生效）`)) dropRows(empty);
      return;
    }
    if (op === 'merge' && kind === 'site') {
      // Pick several 点播源 → one new 聚合源 (at the place of the first picked one). Pick a 聚合源 as well → the others
      // join it instead (and it moves to the first picked place). Picked 聚合源 are merged into the first one.
      const top = sel.filter(r => !isMem(r));
      const groups = top.filter(r => r.dataset.members), atoms = top.filter(r => !r.dataset.members && $('.url', r).value.trim());
      if (!groups.length && atoms.length < 2) return toast('至少勾选 2 个点播源；已有聚合源时，勾选它再勾要加入的点播源');
      if (groups.length === 1 && !atoms.length) return toast('再勾选要加入这个聚合源的点播源');
      const first = top[0];
      let target = groups[0], nameFor = '';
      if (!target) {
        nameFor = prompt(`把选中的 ${atoms.length} 个点播源聚合成一个入口（同名影片合并，播放线路汇总，成员不通会自动跳过）。\n成员会收进这个聚合源里，不再单独显示，需要时可「释放」。\n聚合源名称：`, '聚合源');
        if (!nameFor) return;
        target = addRow('site', { key: 'group-' + Date.now().toString(36), name: nameFor, members: [], keep: 1 }, first);
      } else if (first !== target) first.before(...blockOf(target));
      const add = top.flatMap(r => r === target ? [] : r.dataset.members ? blockOf(r).slice(1) : [r]);
      const others = groups.filter(g => g !== target);
      let tail = blockOf(target).pop();
      add.forEach(m => {
        if (!m.dataset.key) m.dataset.key = $('.nm', m).value.trim() || $('.url', m).value.trim();
        m.classList.add('mem'); m.dataset.parent = target.dataset.key; tail.after(m); tail = m;
      });
      others.forEach(g => g.remove());
      delete target.dataset.keep; target.dataset.open = '1';
      renumber(); dirty(); refreshCount();
      toast(nameFor ? `已生成聚合源「${nameFor}」，成员收在它下面；点「保存」生效` : `已并入「${$('.nm', target).value.trim()}」${add.length} 个源；点「保存」生效`);
      target.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (op === 'merge') {
      if (sel.length < 2) return toast('至少勾选 2 个直播源');
      const name = prompt(`把选中的 ${sel.length} 个直播源合并成一个（同分组归并，相同地址去重）。\n新源名称：`, '合并直播源');
      if (!name) return;
      btn.disabled = true;
      try {
        const out = await req('POST', '/api/live/merge', { sources: sel.map(r => ({ name: $('.nm', r).value.trim(), url: $('.url', r).value.trim() })) });
        addRow('live', { name, url: out.url }, sel[0]);
        dropRows(sel);
        toast(`合并完成：${out.groups} 个分组、${out.channels} 个频道，去重 ${out.dup}${out.failed.length ? '，打不开：' + out.failed.join('、') : ''}`);
        await persist(current());
      } catch (err) { toast(err.message); }
      finally { btn.disabled = false; }
    }
  };
  $$('[data-dbrow]').forEach(c => c.onchange = () => { localStorage.dbRows = JSON.stringify({ ...dbRows(), [c.dataset.dbrow]: c.checked }); toast('已保存'); });
  // picking rows (the select checkboxes) is not an edit
  view.oninput = e => { if (e.target.closest('.srow:not(.lrow)') && !e.target.classList.contains('sel')) dirty(); };
  view.onchange = e => { if (e.target.closest('.srow:not(.lrow)') && !e.target.classList.contains('sel')) dirty(); };
  settingsSaver = () => persist(current());
  $('#setPin').onclick = async () => {
    const newPin = prompt(!safety.hasPin ? '设置家长 PIN（4 位以上数字）' : safety.level === 'all' ? '新 PIN（留空 = 清除 PIN）' : '新 PIN（儿童 / 标准模式下不能清除，只能改）');
    if (newPin === null) return;
    if (!leaveSettingsOk()) return;
    if (safety.hasPin && safety.level !== 'all' && !newPin.trim()) return toast('儿童 / 标准模式下不能清除 PIN');
    try { await req('POST', '/api/safety', { pin: sessionStorage.pin || '', newPin }); delete sessionStorage.pin; toast(newPin ? 'PIN 已设置，之后放宽级别需要输入它' : 'PIN 已清除'); renderSettings(); }
    catch (err) { toast(err.message); }
  };
  if ($('#installBtn')) $('#installBtn').onclick = async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice.catch(() => {}); installEvt = null; $('#installBtn').hidden = true; };
  $('#addSite').onclick = () => $('.nm', addRow('site', { name: '', api: '' })).focus();
  $('#addLive').onclick = () => $('.nm', addRow('live', { name: '', url: '' })).focus();
  $('#testAll').onclick = () => { testMany($$('#sites .srow')); };
  $('#testLives').onclick = () => { testMany($$('#lives .srow')); };
  $('#stopTest').onclick = () => { stopEpoch++; $$('.srow').forEach(r => { if (/测试中|重试|排队/.test($('.status', r)?.textContent || '')) restoreRow(r); }); };
  // Drag to reorder (mouse and touch): hold the ⋮⋮ handle. A top-level row travels with its members; a member only moves inside
  // its own group. The page scrolls by itself near the top / bottom edge.
  const bindDrag = box => {
    box.addEventListener('click', e => { if (e.target.closest('.drag')) e.preventDefault(); });
    box.addEventListener('pointerdown', e => {
      const h = e.target.closest('.drag'); if (!h || (e.pointerType === 'mouse' && e.button !== 0)) return;
      e.preventDefault();
      const row = h.closest('.srow'), mem = isMem(row), unit = mem ? [row] : blockOf(row);
      const cands = () => (mem ? $$('.srow.mem', box).filter(r => r.dataset.parent === row.dataset.parent) : $$('.srow', box).filter(r => !isMem(r))).filter(r => r !== row)
        .map(r => { const b = mem ? [r] : blockOf(r).filter(x => !x.hidden); return { r, b, top: b[0].getBoundingClientRect().top, bot: b[b.length - 1].getBoundingClientRect().bottom }; });
      let y = e.clientY, drop = null, timer = 0;
      const mark = () => {
        $$('.drop-top, .drop-bottom', box).forEach(x => x.classList.remove('drop-top', 'drop-bottom'));
        const cs = cands(); drop = null;
        if (!cs.length) return;
        for (const c of cs) if (y < (c.top + c.bot) / 2) { drop = { before: true, c }; break; }
        if (!drop) drop = { before: false, c: cs[cs.length - 1] };
        (drop.before ? drop.c.b[0] : drop.c.b[drop.c.b.length - 1]).classList.add(drop.before ? 'drop-top' : 'drop-bottom');
      };
      const tick = () => {
        const edge = 90, top = (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--hh')) || 64) + 56;
        if (y < top + edge * .4) view.scrollBy(0, -14); else if (y > innerHeight - edge) view.scrollBy(0, 14);
        mark();
      };
      unit.forEach(x => x.classList.add('dragging')); document.body.classList.add('sorting');
      h.setPointerCapture(e.pointerId); mark(); timer = setInterval(tick, 40);
      const move = ev => { y = ev.clientY; };
      const end = ev => {
        h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', end); h.removeEventListener('pointercancel', end);
        clearInterval(timer); mark();
        unit.forEach(x => x.classList.remove('dragging')); document.body.classList.remove('sorting');
        $$('.drop-top, .drop-bottom', box).forEach(x => x.classList.remove('drop-top', 'drop-bottom'));
        if (ev.type === 'pointercancel' || !drop) return;
        const { before, c } = drop;
        if (before) c.b[0].before(...unit); else c.b[c.b.length - 1].after(...unit);
        renumber(); dirty();
      };
      h.addEventListener('pointermove', move); h.addEventListener('pointerup', end); h.addEventListener('pointercancel', end);
    });
  };
  bindDrag($('#sites')); bindDrag($('#lives'));
  sumGroups();
  // Multi-select in the lists: shift+click a checkbox for a range.
  for (const box of [$('#sites'), $('#lives')]) multiPick({ box, rows: () => $$('.srow', box).filter(r => !r.hidden), box_: r => $('.sel', r), changed: refreshCount });
  renumber(); refreshCount();
  $('#save').onclick = () => persist(current()).catch(err => toast(err.message));
  $('#saveRaw').onclick = () => { let c; try { c = JSON.parse($('#raw').value); } catch { return toast('JSON 格式不对'); } persist(c, true).catch(err => toast(err.message)); };
  $('#reset').onclick = async () => {
    if (!confirm('恢复成内置的默认源？')) return;
    settingsDirty = false;
    try { await req('POST', '/api/config/reset', {}); await loadSites(); toast('已恢复默认'); renderSettings(); } catch (err) { toast(err.message); }
  };
  $('#exportAll').onclick = () => exportSources($$('#sites .srow'), $$('#lives .srow'));
  $('#clipGo').onclick = () => { const t = $('#clipText').value.trim(); if (t) recognizeFlow(t); };
  $('#clipRead').onclick = async () => {
    try { const t = await navigator.clipboard.readText(); $('#clipText').value = t; if (t.trim() && !isOwnShare(t)) recognizeFlow(t); }
    catch { toast('浏览器不让直接读剪贴板（局域网 http 页面的限制），请在框里粘贴'); $('#clipText').focus(); }
  };
  $('#imp').onclick = async () => {
    const url = $('#impUrl').value.trim(); if (!url) return;
    if (!leaveSettingsOk()) return;   // the page is rebuilt with the imported sources
    $('#imp').disabled = true; $('#imp').textContent = '导入中…';
    try {
      const j = await req('POST', '/api/config/import', { url, replace: $('#impReplace').checked });
      await loadSites(); toast(`导入 ${j.imported.sites} 个点播源（自动分类：成人 ${j.imported.adult || 0}、少儿 ${j.imported.kids || 0}）、${j.imported.lives} 个直播源${j.imported.skippedEmpty ? `（跳过 ${j.imported.skippedEmpty} 个 0 部内容的）` : ''}`); renderSettings();
    } catch (err) { toast('导入失败：' + err.message); $('#imp').disabled = false; $('#imp').textContent = '导入'; }
  };
  ACCT.mountSettings($('#acctSec')).then(() => { if (settingsGoto === 'account') { settingsGoto = ''; $('#acctSec')?.scrollIntoView({ block: 'start' }); } });
  initAdmin();
  localSettings(localP).catch(err => { if (!isAbort(err) && $('#localSec')) $('#localSec').innerHTML = `<h2>本地媒体</h2><div class="err">${esc(err.message)}</div>`; });
}

// ---------- settings: 本地媒体 (built-in source from local folders) ----------
async function localSettings(pre) {
  const j = await (pre || get('/api/local'));
  const box = $('#localSec'); if (!box) return;
  const c = j.cfg;
  const flag = (cls, on, label, title) => `<label class="flag" title="${title}"><input type="checkbox" class="${cls}" ${on ? 'checked' : ''}>${label}</label>`;
  const dirRow = (d, i, st) => `<div class="srow lrow" data-i="${i}">
      <span class="lan">${i + 1}</span>
      <input class="nm" value="${esc(d.name || '')}" placeholder="分类名（默认文件夹名）">
      <input class="url" value="${esc(d.path || '')}" placeholder="${navigator.platform.startsWith('Win') ? 'D:\\Movies' : '/Volumes/NAS/电影'}">
      <span class="ops">${flag('sub', d.sub, '子目录分类', '它下面每个一级子文件夹各是一个分类')}${flag('flat', d.flat, '逐个文件', '不合并成剧集：每个文件单独一部')}${flag('kids', d.kids, '少儿', '儿童模式下可见')}${flag('adult', d.adult, '成人', '只在安全级别「全部」时可见')}
        <span class="status ${st ? (st.error ? 'bad' : 'ok') : ''}" title="${esc(st?.error || '')}">${st ? (st.error ? esc(st.error) : `${st.items}部 · ${st.files}个文件`) : ''}</span>
        <button data-lop="del">删除</button></span></div>`;
  const statusText = s => s.running ? `扫描中… 已找到 ${s.dirs.reduce((n, d) => n + d.items, 0)} 部`
    : s.at ? `上次扫描 ${new Date(s.at).toLocaleString()}，${s.items} 部 / ${s.files} 个文件，用时 ${(s.ms / 1000).toFixed(1)} 秒${s.error ? ' · 出错：' + s.error : ''}` : '还没扫描过';
  const draw = (cfg, status) => {
    const stOf = d => status.dirs.find(x => x.path === d.path);
    box.innerHTML = `<h2>本地媒体 <span class="tagl">内置源</span></h2>
      <p class="hint">扫描这台电脑上（或挂载的 NAS 里）的文件夹，合成一个点播源。每个目录是一个分类，勾「子目录分类」后它下面的每个一级子文件夹各是一个分类。同一文件夹里带集数的视频合成一部剧，其他文件各算一部。封面优先用同目录的 poster / folder / 同名图片，没有就用 ffmpeg 截一帧；有 .nfo 会读片名、简介和演员。勾了「成人」的目录只在安全级别为「全部」时显示。
      ${j.ffmpeg ? '浏览器放不了的格式（mkv / avi / rmvb 等）会由 ffmpeg 转成 HLS 边转边播，转好的缓存保留一天。' : '<b>没找到 ffmpeg</b>：mkv / avi 等格式在浏览器里可能放不了，电视端不受影响。'}</p>
      <div class="field"><label class="lan"><input type="checkbox" id="lcOn" ${cfg.enabled ? 'checked' : ''}> 启用</label>
        <input id="lcName" value="${esc(cfg.name)}" placeholder="源名称" style="flex:0 1 160px;min-width:120px">
        <label class="lan">每 <input id="lcRescan" type="number" min="0" max="1440" value="${cfg.rescan}" style="width:70px;min-width:0;flex:none"> 分钟自动重扫（0 = 不自动）</label></div>
      <div class="field" style="margin-top:8px"><span class="lan">后缀</span><input id="lcExts" value="${esc(cfg.exts.join(', '))}" title="可选：${esc(j.exts.join(' '))}"></div>
      <div id="lcDirs" style="margin-top:10px">${cfg.dirs.map((d, i) => dirRow(d, i, stOf(d))).join('') || '<p class="lan">还没有目录。</p>'}</div>
      <div class="actions"><button class="small" id="lcAdd">+ 添加目录</button><button class="btn red" id="lcSave">保存并扫描</button>
        <button class="small" id="lcScan">重新扫描</button><span class="lan" id="lcStatus">${esc(statusText(status))}</span></div>
      ${j.urls.length ? `<details class="admmore" style="margin-top:12px"><summary>电视端使用</summary><p class="hint" style="margin-top:8px">在 TVBox / FongMi 里添加点播源，类型 1（苹果CMS JSON），地址 ${j.urls.map(u => `<code>${esc(u)}</code>`).join(' 或 ')}。电视端直接播原文件。</p></details>` : ''}`;
  };
  const collect = () => ({
    enabled: $('#lcOn').checked, name: $('#lcName').value.trim(), rescan: Number($('#lcRescan').value) || 0,
    exts: $('#lcExts').value.split(/[\s,，;；]+/).filter(Boolean),
    dirs: $$('.lrow', box).map(r => ({ path: $('.url', r).value.trim(), name: $('.nm', r).value.trim(),
      sub: +$('.sub', r).checked, flat: +$('.flat', r).checked, kids: +$('.kids', r).checked, adult: +$('.adult', r).checked })).filter(d => d.path),
  });
  let cfg = c, status = j.status, timer = 0;
  // While a scan runs, refresh the counts every second.
  const poll = () => {
    clearTimeout(timer);
    if (!status.running) return;
    timer = setTimeout(async () => {
      if (!box.isConnected) return;
      try { status = (await get('/api/local')).status; } catch { return; }
      if (!box.isConnected) return;
      if (status.running) { $('#lcStatus').textContent = statusText(status); return poll(); }
      cfg = collect(); draw(cfg, status); bind();
      state.cats = []; apiMemo.clear(); await loadSites();
    }, 1000);
  };
  const bind = () => {
    $('#lcAdd').onclick = () => { cfg = collect(); cfg.dirs.push({ path: '', name: '' }); draw(cfg, status); bind(); $('#lcDirs .lrow:last-child .url').focus(); };
    $('#lcDirs').onclick = e => { if (e.target.dataset.lop !== 'del') return; cfg = collect(); cfg.dirs.splice(+e.target.closest('.lrow').dataset.i, 1); draw(cfg, status); bind(); };
    $('#lcSave').onclick = async () => {
      const bad = collect().dirs.find(d => !/^(\/|~|[a-z]:[\\/]|\\\\)/i.test(d.path));
      if (bad) return toast('要写完整路径：' + bad.path);
      try {
        const r = await req('PUT', '/api/local', collect());
        cfg = r.cfg; status = r.status; draw(cfg, status); bind(); poll();
        toast(cfg.enabled ? '已保存，开始扫描' : '已保存（已停用）');
        if (!cfg.enabled) { state.cats = []; apiMemo.clear(); await loadSites(); }
      } catch (err) { toast(err.message); }
    };
    $('#lcScan').onclick = async () => {
      try { status = await req('POST', '/api/local/scan', {}); $('#lcStatus').textContent = statusText(status); poll(); }
      catch (err) { toast(err.message); }
    };
  };
  draw(cfg, status); bind(); poll();
}

// ---------- clipboard → sources ----------
// Ctrl/⌘+V anywhere (outside inputs) recognises 点播/直播 sources in the pasted text. Over plain http on the
// LAN browsers refuse navigator.clipboard.readText, so the paste event is the dependable path; when
// clipboard-read is already granted (localhost), new clipboard text is also checked on window focus.
const clipKey = t => { let h = 0; for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0; return String(h); };
const looksLikeSource = t => /(https?|rtmp|rtsp):\/\/|#EXTINF|#genre#|"sites"\s*:/.test(t);
// 自己这个站点的分享链接 (#/v/… #/play/… #/tv/… #/find/…) 不用当源去识别: 同一个地址，或者本机的局域网地址
const SHARE_ROUTE = /^#\/(v|play|tv|find|search|cat|charts|person)\b/;
function isOwnShare(t) {
  const s = String(t || '').trim();
  const urls = s ? s.match(/https?:\/\/[^\s"'<>]+/gi) : null;
  if (!urls) return false;
  const port = u => u.port || (u.protocol === 'https:' ? '443' : '80');
  const local = h => h === location.hostname || /^(localhost|127\.|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
  const own = raw => {
    let u; try { u = new URL(raw); } catch { return false; }
    if (!SHARE_ROUTE.test(u.hash)) return false;
    if (u.origin === location.origin) return true;
    // 同一个端口 + 本机 / 局域网地址: 手机上分享的链接拷到电脑上粘贴也算
    if (port(u) === port(location) && local(u.hostname)) return true;
    return (serverInfo?.urls || []).some(x => { try { const y = new URL(x); return y.hostname === u.hostname && port(y) === port(u); } catch { return false; } });
  };
  return urls.every(own);          // 里面的链接全是自己站点的分享链接 (前后带片名之类的文字也算)
}
document.addEventListener('paste', e => {
  if (e.target instanceof Element && e.target.closest('input, textarea, [contenteditable]')) return;
  const t = e.clipboardData?.getData('text') || '';
  if (isOwnShare(t)) { localStorage.clipSeen = clipKey(t); return; }   // 本站的分享链接: 不识别, 也不提示
  if (looksLikeSource(t)) { e.preventDefault(); recognizeFlow(t); }   // an explicit paste is always taken
});
addEventListener('focus', async () => {
  try {
    const p = await navigator.permissions.query({ name: 'clipboard-read' });
    if (p.state !== 'granted') return;
    const t = await navigator.clipboard.readText();
    if (isOwnShare(t)) { localStorage.clipSeen = clipKey(t); return; }
    if (!looksLikeSource(t) || localStorage.clipSeen === clipKey(t)) return;
    localStorage.clipSeen = clipKey(t);
    recognizeFlow(t, true);
  } catch {}
});

// One recognition task at a time. While its sheet is open, any new clipboard text (a paste, the window regaining focus, or the
// background check below) is analysed too and merged into the same list, so the result is given once, for everything.
// POST /api/recognize/stream: NDJSON lines {t:'progress'|'ping'|'result'|'error'}; onProgress gets each progress line.
async function recognizeStream(text, onProgress, signal) {
  const headers = { 'Content-Type': 'application/json' };
  if (sessionStorage.pin) headers['X-Pin'] = sessionStorage.pin;
  const r = await fetch('/api/recognize/stream', { method: 'POST', headers, body: JSON.stringify({ text }), signal });
  if (!r.ok || !r.body) { const j = await r.json().catch(() => ({})); throw new Error(j.error || `HTTP ${r.status}`); }
  const rd = r.body.getReader(), dec = new TextDecoder();
  let buf = '', result = null, error = '';
  const line = t => { if (!t.trim()) return; let m; try { m = JSON.parse(t); } catch { return; } if (m.t === 'progress') onProgress(m); else if (m.t === 'result') result = m; else if (m.t === 'error') error = m.error; };
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    for (let nl; (nl = buf.indexOf('\n')) >= 0;) { line(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
  }
  line(buf + dec.decode());
  if (error) throw new Error(error);
  if (!result) throw new Error('识别中断了（服务端没有返回结果）');
  return result;
}
let clipSess = null;
// auto: the text was picked up by watching the clipboard (window focus / polling), not pasted or requested by the user.
function recognizeFlow(text, auto) {
  const key = clipKey(text);
  localStorage.clipSeen = key;
  if (clipSess?.settled() && auto) return;   // the result of this task has been given: watching the clipboard stops
  // 自动发现的 (窗口重新获得焦点时的剪贴板): 先不弹窗, 分析出能加的源才显示; 手动粘贴的立刻显示
  if (!clipSess) clipSess = openClipSession(!!auto);
  if (!auto) clipSess.show();
  clipSess.add(text, key);
}
function openClipSession(lazy = false) {
  const m = document.createElement('div');
  m.className = 'modal clipmodal'; m.id = 'clipModal';
  m.innerHTML = `<div class="sheet editor clipsheet"><div class="body clipbody">
    <h3 id="clipTitle">识别剪贴板</h3>
    <p class="hint">已存在的自动去重；不通、没内容的默认不勾（0 内容的不能选）。按住 Shift 点选可以连选一段；名称可以直接改，也能批量设分类。分析期间剪贴板有新内容会自动并进来，一起给出结果。</p>
    <div class="actions cbulk"><label class="flag"><input type="checkbox" data-cbulk="all">全选</label>
      <button class="small" data-cbulk="invert">反选</button><button class="small" data-cbulk="good">只选能用的</button>
      <span class="bwrap"><button class="small" data-cbulk="cat">设分类 ▾</button><div class="bmenu" hidden>
        <button data-cbulk="setkids">设为 少儿</button><button data-cbulk="setadult">设为 成人</button><button data-cbulk="setstd">设为 标准（去掉标记）</button></div></span>
      <button class="small" data-cbulk="paste" title="读取当前剪贴板，并入这次识别">追加剪贴板</button>
      <span class="lan" data-cbulk="count"></span></div>
    <div class="clipstatus" id="clipStatus"><div class="spinner mini"></div><div class="clipprog"><span></span><i class="bar" hidden><b></b></i><small></small></div></div>
    <div class="clipnote" id="clipNote" hidden></div>
    <div id="clipRows" class="cliprows"></div>
    <div id="clipUnknown"></div>
    <div class="actions clipfoot"><button class="btn red" id="clipAdd" disabled>分析中…</button><button class="small" id="clipCancel">取消</button><span class="lan" id="clipMsg"></span></div></div></div>`;
  const all = [], keys = new Set(), unknown = new Set(), seen = new Set(), notes = new Set();
  let pending = 0, saving = false, closed = false, texts = 0, updates = 0, done = false, shown = false;
  const show = () => { if (shown || closed) return; shown = true; document.body.append(m); document.body.style.overflow = 'hidden'; };
  if (!lazy) show();
  const prog = { msg: '', done: 0, total: 0, long: false, t0: Date.now() };
  const ctl = new AbortController();
  const tick = setInterval(() => { if (pending && !closed) count(); }, 1000);   // done: the result has been handed over
  const close = () => { closed = true; clearInterval(poll); clearInterval(tick); ctl.abort(); closeBulkMenus(); m.remove(); clipSess = null; if (!$('#modal')) document.body.style.overflow = ''; };
  // Same per-row controls as the settings list: 少儿 / 成人 checkboxes, then the status.
  const flagsHtml = (x, i) => { const off = x.exists || x.empty ? 'disabled' : ''; return `<label class="flag"><input type="checkbox" class="ckids" data-i="${i}" ${x.kids ? 'checked' : ''} ${off}>少儿</label><label class="flag"><input type="checkbox" class="cadult" data-i="${i}" ${x.adult ? 'checked' : ''} ${off}>成人</label>`; };
  const keyOf = x => x.kind === 'site' ? (x.text ? 't|' + x.text : x.members ? 'g|' + x.name + '|' + x.members.join(',') : 'a|' + x.api)
    : (x.text ? 't|' + x.text : 'u|' + x.url);
  const rowHtml = (x, i) => `<div class="crow ${x.exists || x.empty ? 'dim' : ''}" data-i="${i}">
      <input type="checkbox" class="csel" data-i="${i}" ${x.exists || x.empty ? 'disabled' : x._sel ? 'checked' : ''}>
      <input class="cname" data-i="${i}" value="${esc(x.name)}" ${x.exists ? 'disabled' : ''}>
      <span class="curl">${esc(x.kind === 'site' ? x.api || '分享的片单（存成本地文本）' : x.url || '粘贴的频道列表（存成本地文本）')}</span>
      <span class="cops">${x.members || (x.kind === 'site' && x.text) ? '' : `<button type="button" class="small" data-cprev="${i}" title="新开页面预览，不用先添加">预览</button>`}${flagsHtml(x, i)}<span class="cstat ${x.exists ? '' : x.ok === true ? 'ok' : x.ok === false ? 'bad' : ''}">${x.exists ? '已存在' : esc(x.info || (x.ok === false ? '不通' : '未验证'))}</span></span></div>`;
  const section = (title, kind) => {
    const items = all.map((x, i) => [x, i]).filter(([x]) => x.kind === kind);
    return items.length ? `<h4>${title} · 新 ${items.filter(([x]) => !x.exists).length} / 共 ${items.length}</h4>${items.map(([x, i]) => rowHtml(x, i)).join('')}` : '';
  };
  const boxes = () => $$('.crow:not(.dim) .csel', m);
  const syncFromDom = () => $$('.csel', m).forEach(c => { const x = all[+c.dataset.i]; if (x && !c.disabled) x._sel = c.checked; });
  const count = () => {
    syncFromDom();
    const n = boxes().filter(c => c.checked).length, tot = boxes().length;
    const busy = pending > 0;
    $('#clipAdd', m).textContent = saving ? '保存中…' : busy ? `分析中，还有 ${pending} 段…` : n ? `添加选中的 ${n} 个` : '没有选中';
    $('#clipAdd', m).disabled = saving || busy || !n;   // nothing picked (or still analysing): the button cannot be pressed
    $('[data-cbulk=count]', m).textContent = tot ? `已选 ${n} / ${tot}` : '';
    $('[data-cbulk=all]', m).checked = n > 0 && n === tot;
    const st = $('#clipStatus', m); st.hidden = !busy;
    if (busy) {
      const sp = $('.clipprog span', st), bar = $('.clipprog .bar', st), sm = $('.clipprog small', st);
      sp.textContent = prog.msg || (all.length ? `又有 ${pending} 段内容在分析，完成后并进下面的列表…` : '正在逐个打开链接确认类型，并检测点播源是否有内容、归哪一类（源多要等十几秒）…');
      const frac = prog.total ? Math.min(1, (prog.done || 0) / prog.total) : 0;
      bar.hidden = !prog.total; if (prog.total) $('b', bar).style.width = frac * 100 + '%';
      sm.textContent = prog.long ? `已用 ${Math.round((Date.now() - prog.t0) / 1000)} 秒 · 大仓库可能要几分钟，可以先去做别的，这个窗口会一直等到完成；不想等就点「取消」` : '';
    }
  };
  const render = () => {
    syncFromDom();
    const box = $('#clipRows', m), top = box.scrollTop;
    box.innerHTML = all.length ? section('点播源', 'site') + section('直播源', 'live') : '';
    box.scrollTop = top;
    $('#clipTitle', m).textContent = all.length ? `剪贴板里识别到 ${all.length} 个源${texts > 1 ? `（合并 ${texts} 段内容）` : ''}` : '识别剪贴板';
    $('#clipUnknown', m).innerHTML = (notes.size ? `<div class="lan clipnotes">${[...notes].map(n => `<div>· ${esc(n)}</div>`).join('')}</div>` : '')
      + (unknown.size ? `<details class="lan"><summary>${unknown.size} 个链接没认出来</summary>${[...unknown].map(u => `<div class="curl">${esc(u)}</div>`).join('')}</details>` : '');
    count();
  };
  const merge = r => {
    for (const x of [...r.sites.map(x => ({ ...x, kind: 'site' })), ...r.lives.map(x => ({ ...x, kind: 'live' }))]) {
      const k = keyOf(x);
      if (keys.has(k)) {
        // Same link already listed: a plain copy replaces a category-whitelisted one that arrived earlier.
        const j = all.findIndex(y => keyOf(y) === k);
        if (j >= 0 && x.kind === 'site' && all[j].categories && !x.categories && !x.members && !x.text) { x._sel = !x.exists && !x.empty && x.ok !== false; all[j] = x; }
        continue;
      }
      if (/^0 ?(个频道|部|台)/.test(x.info || '')) { x.empty = true; x.ok = false; }   // 0 channels / 0 titles: never selectable, never default-selected
      keys.add(k); x._sel = !x.exists && !x.empty && x.ok !== false; all.push(x);
    }
    r.unknown.forEach(u => unknown.add(u));
    if (!shown && all.some(x => !x.exists)) show();   // 自动发现: 有能加的新源才弹出来
  };
  const settle = () => {
    if (closed || pending) return render();
    render();
    if (!shown) {                       // 自动发现的那次: 没有能加的新源就静默收掉 (不弹窗, 也不提示)
      if (all.some(x => !x.exists)) show();
      else return close();
    }
    // One batch, one result. From here on a changed clipboard is no longer picked up by itself — only an explicit
    // paste (Ctrl/⌘+V) or 「追加剪贴板」 adds to the list.
    if (all.length && all.some(x => !x.exists)) {
      done = true; clearInterval(poll);
      $('#clipStatus', m).hidden = true;
      const note = $('#clipNote', m);
      note.hidden = false; note.classList.remove('flash');
      note.textContent = '已给出结果，不再自动识别剪贴板的变化。要追加内容，请按 Ctrl/⌘+V 粘贴，或点「追加剪贴板」。';
    }
    if (!all.length) { const n = unknown.size; close(); toast(n ? `剪贴板里 ${n} 个链接都不是点播/直播源` : '剪贴板里没识别到点播/直播源'); }
    else if (!all.some(x => !x.exists)) { const n = all.length; close(); toast(`识别到 ${n} 个源，都已存在`); }
  };
  const add = (text, key) => {
    if (closed) return;
    if (saving) { delete localStorage.clipSeen; return toast('正在保存，保存完成后再粘贴一次就能识别新内容'); }
    if (seen.has(key)) return toast('这段剪贴板内容已经在分析了');
    const appended = done;   // added by hand after the result was already given
    seen.add(key); texts++; pending++; done = false;
    if (appended) {
      const note = $('#clipNote', m);
      note.hidden = false; note.classList.remove('flash'); void note.offsetWidth; note.classList.add('flash');
      note.textContent = `已追加一段内容（共 ${texts} 段），分析完成后并入下面的列表`;
    } else if (texts > 1) {
      // The clipboard changed while this task is open: say so clearly, once as a toast and once as a banner that stays.
      updates++;
      const note = $('#clipNote', m);
      note.hidden = false; note.classList.remove('flash'); void note.offsetWidth; note.classList.add('flash');
      note.textContent = `检测到剪贴板内容变化 ${updates} 次：新内容已加入这次任务（共 ${texts} 段），全部分析完一起给出结果`;
      toast('检测到剪贴板更新，已并入当前识别任务');
    }
    count();
    if (/github\.com|gitee\.com|gitlab\.com|codeberg\.org|githubusercontent\.com/i.test(text)) prog.long = true;
    prog.t0 = prog.t0 || Date.now();
    recognizeStream(text, m => {
      prog.msg = m.msg;
      if (m.phase === 'scan' || m.phase === 'probe') { prog.done = m.done || 0; prog.total = m.total || 0; } else if (m.phase) { prog.done = 0; prog.total = m.total && m.phase === 'files' ? 0 : 0; }
      if (!closed) count();
    }, ctl.signal)
      .then(r => { prog.msg = ''; prog.done = prog.total = 0; if (r.notes?.length) r.notes.forEach(n => notes.add(n)); merge(r); }, e => { if (e.name !== 'AbortError' && (!lazy || shown)) toast('识别失败：' + e.message); })
      .finally(() => { pending--; if (!closed) settle(); });
  };
  // Keeps watching while the sheet is open (only possible when the browser already allows reading the clipboard).
  const poll = setInterval(async () => {
    if (closed || done || saving || !document.hasFocus()) return;
    try {
      if ((await navigator.permissions.query({ name: 'clipboard-read' })).state !== 'granted') return;
      const t = await navigator.clipboard.readText(), k = clipKey(t);
      if (!isOwnShare(t) && looksLikeSource(t) && !seen.has(k)) add(t, k);
    } catch {}
  }, 1500);
  const lock = on => {   // while saving nothing in the sheet can be changed, cancelled or submitted twice
    saving = on;
    $$('input, button', m).forEach(x => { if (on) { x.dataset.was = x.disabled ? '1' : ''; x.disabled = true; } else if (x.dataset.was !== undefined) { x.disabled = x.dataset.was === '1'; delete x.dataset.was; } });
    $('#clipMsg', m).textContent = on ? '正在写入，请稍等…' : '';
    count();
  };
  multiPick({ box: $('#clipRows', m), rows: () => $$('.crow:not(.dim)', m), box_: r => $('.csel', r), changed: count });
  m.onchange = e => {
    if (saving) return;
    const t = e.target, x = all[+t.dataset.i];
    if (t.classList.contains('csel')) count();
    else if (x && (t.classList.contains('ckids') || t.classList.contains('cadult'))) {   // a single row's own 少儿 / 成人, like in the settings list
      x[t.classList.contains('ckids') ? 'kids' : 'adult'] = t.checked ? 1 : 0;
    }
  };
  m.oninput = e => { if (e.target.classList.contains('cname')) { const x = all[+e.target.dataset.i]; if (x) x.name = e.target.value; } };
  m.onclick = async e => {
    if (e.target === m && !saving) return close();
    const pv = e.target.closest('[data-cprev]');
    if (pv && !saving) {
      const x = all[+pv.dataset.cprev]; if (!x) return;
      return previewSource(x.kind === 'site' ? 'vod' : 'live', { url: x.kind === 'site' ? x.api : x.url, name: x.name, text: x.kind === 'live' ? x.text || '' : '', cats: x.categories?.length ? JSON.stringify(x.categories) : '' });
    }
    const op = e.target.dataset.cbulk; if (!op || saving) return;
    if (op === 'cat') return toggleBulkMenu(e.target);
    closeBulkMenus();
    if (op === 'paste') {
      try {
        const t = await navigator.clipboard.readText();
        if (isOwnShare(t)) return;                 // 自己站点的分享链接: 不识别也不提示
        if (!looksLikeSource(t)) return toast('剪贴板里没有源地址');
        const k = clipKey(t); localStorage.clipSeen = k; return add(t, k);
      } catch { return toast('浏览器不让直接读剪贴板（局域网 http 页面的限制），请直接按 Ctrl/⌘+V 粘贴'); }
    }
    const rows = boxes();
    if (op === 'all') rows.forEach(c => { c.checked = e.target.checked; });
    else if (op === 'invert') rows.forEach(c => { c.checked = !c.checked; });
    else if (op === 'good') rows.forEach(c => { c.checked = all[+c.dataset.i].ok !== false; });
    else if (op === 'setkids' || op === 'setadult' || op === 'setstd') {
      const picked = rows.filter(c => c.checked);
      if (!picked.length) return toast('先勾选要设置的源');
      for (const c of picked) {
        const x = all[+c.dataset.i], row = c.closest('.crow');
        x.kids = op === 'setkids' ? 1 : 0; x.adult = op === 'setadult' ? 1 : 0;
        $('.ckids', row).checked = !!x.kids; $('.cadult', row).checked = !!x.adult;
      }
      toast(`已把 ${picked.length} 个设为${({ setkids: '少儿', setadult: '成人', setstd: '标准' })[op]}`);
    }
    count();
  };
  $('#clipCancel', m).onclick = () => { if (!saving) close(); };
  $('#clipAdd', m).onclick = async () => {
    if (saving || pending) return;
    syncFromDom();
    const pick = all.filter(x => x._sel && !x.exists && !x.empty).map(x => ({ ...x, name: (x.name || '').trim() || x.name }));
    if (!pick.length) return;
    if (settingsDirty && settingsOpen() && settingsSaver) {
      // adding refreshes the settings page: the pending edits have to be saved first, or they would be lost (or overwrite what is added)
      if (!confirm('设置页有未保存的修改。\n\n先保存这些修改，再添加选中的源？（取消 = 不添加）')) return;
      try { await settingsSaver(); } catch (e) { return toast('保存设置页的修改失败：' + e.message); }
    }
    lock(true);
    try {
      const j = await req('POST', '/api/config/add', { sites: pick.filter(x => x.kind === 'site'), lives: pick.filter(x => x.kind === 'live') });
      saving = false; close(); await loadSites();
      toast(`已添加 ${j.added.sites} 个点播源（成人 ${j.added.adult || 0}、少儿 ${j.added.kids || 0}）、${j.added.lives} 个直播源${j.added.skippedEmpty ? `（跳过 ${j.added.skippedEmpty} 个 0 部内容的）` : ''}`);
      if (location.hash.startsWith('#/settings')) renderSettings();
    } catch (e) { lock(false); toast(e.message); }
  };
  render();
  return { add, close, show, settled: () => done };
}

// 预览模式的头部标记: 名称 + 「添加到我的源」+「关闭」。其余界面差异靠 html.pv 的样式 (隐藏源切换 / 榜单 / 收藏 / 下载 / 设置)。
if (PV) {
  if (PV.kind === 'live' && (!location.hash || location.hash === '#/')) history.replaceState(null, '', '#/live');
  $('.logo').setAttribute('href', PV.kind === 'live' ? '#/live' : '#/');
  const tag = document.createElement('div'); tag.className = 'pvtag';
  tag.innerHTML = `<b>预览</b><span class="pvn" title="${esc(PV.api || PV.url || PV.name)}">${esc(PV.name)}</span>${PV.stash ? '' : '<button type="button" id="pvAdd">添加到我的源</button>'}<button type="button" id="pvClose">关闭</button>`;
  $('#top .right').prepend(tag);
  $('#pvClose').onclick = () => { window.close(); setTimeout(() => { location.href = '/#/settings'; }, 150); };
  const add = $('#pvAdd');
  // Already in 我的源: no button at all (nothing to add, nothing to explain after a click).
  if (add) {
    const norm = u => { try { const x = new URL(String(u).trim()); for (const k of ['ac', 'pg', 't', 'wd', 'ids', 'h']) x.searchParams.delete(k); x.hash = ''; return x.toString().replace(/\/+(?=\?|$)/, ''); } catch { return String(u).trim(); } };
    get('/api/config', null).then(cfg => {
      const mine = PV.kind === 'vod' ? (cfg.sites || []).some(s => !s.categories && s.api && norm(s.api) === norm(PV.api)) : (cfg.lives || []).some(l => l.url && norm(l.url) === norm(PV.url));
      if (mine) add.remove();
    }, () => {});
  }
  if (add) add.onclick = async () => {
    add.disabled = true;
    try {
      let cats = []; try { cats = JSON.parse(PV.cats || '[]'); } catch {}
      const body = PV.kind === 'vod' ? { sites: [{ name: PV.name, api: PV.api, ...(cats.length ? { categories: cats } : {}) }], lives: [] } : { sites: [], lives: [{ name: PV.name, url: PV.url }] };
      const j = await req('POST', '/api/config/add', body);
      toast('已添加到我的源');
      add.remove();
    } catch (e) { add.disabled = false; toast(e.message); }
  };
}
loadSites('swr').then(() => ACCT.ready).then(() => route({ nav: true }), e => { view.innerHTML = `<div class="page"><div class="err">连不上服务：${esc(e.message)}</div></div>`; });

applyCardMode(); applyCardScale();

setInterval(() => { if (cur?.kind === 'vod' && !player.hidden && state.downloads.some(j => ACTIVE.includes(j.status))) refreshDownloads().then(paintVodActs); }, 2000);

// ---------- 小屏底部「我的」: 收藏 / 下载 / 设置收进一个菜单 (二级菜单再进入各页) ----------
{
  const tab = $('#mineTab'); let menu = null;
  const close = () => { menu?.remove(); menu = null; tab.setAttribute('aria-expanded', 'false'); };
  const ICONS = { favorites: tab.ownerDocument.querySelector('[data-nav=favorites] svg').outerHTML, downloads: $('[data-nav=downloads] svg').outerHTML, settings: $('[data-nav=settings] svg').outerHTML };
  tab.addEventListener('click', e => {
    e.preventDefault(); e.stopPropagation();
    if (menu) return close();
    const kids = document.documentElement.classList.contains('kidslevel');
    const rows = [['downloads', '下载'], ['settings', '设置']]; if (!kids) rows.unshift(['favorites', '收藏']);
    menu = document.createElement('div'); menu.className = 'minemenu'; menu.setAttribute('role', 'menu');
    menu.innerHTML = rows.map(([k, t]) => `<a href="#/${k}" role="menuitem" class="${location.hash.startsWith('#/' + k) ? 'on' : ''}">${ICONS[k]}<span>${t}</span></a>`).join('')
      + (ACCT.me || localStorage.tvbox_acct_on ? `<a href="#/settings/account" role="menuitem">${tab.querySelector('svg').outerHTML}<span>账号：${esc(ACCT.me ? ACCT.me.name : '访客')}</span></a>` : '');
    document.body.append(menu); tab.setAttribute('aria-expanded', 'true');
    menu.addEventListener('click', () => setTimeout(close, 0));
  });
  document.addEventListener('click', e => { if (menu && !menu.contains(e.target)) close(); });
  addEventListener('hashchange', close);
  matchMedia('(max-width: 760px)').addEventListener('change', close);
}
