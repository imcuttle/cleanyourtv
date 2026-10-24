'use strict';
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
  const hi = sharp && dbSize(u, sharp);
  return `<img src="${esc(img(dbSize(u, 's') || u))}"${hi ? ` data-hi="${esc(img(hi))}"` : ''} loading="lazy" decoding="async" referrerpolicy="no-referrer" alt="" onload="sharpen(this)" onerror="this.parentNode.classList.add('noimg');this.remove()">`;
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
  const b = $('#cardBtn'); if (b) { b.classList.toggle('on', cardMode() === 'wide'); b.title = cardMode() === 'wide' ? '当前：宽卡，点一下换竖版封面' : '当前：竖版，点一下换宽卡'; }
};
const setCardMode = m => { localStorage.cardMode = m; applyCardMode(); $$('[data-cardmode]').forEach(x => x.classList.toggle('on', x.dataset.cardmode === m)); };
applyCardMode();

// ---------- http ----------
// Every read belongs to the current page: switching pages aborts what the old one still had in flight, so
// slow sources / 豆瓣 / covers don't hold the browser's ~6 connections per host and stall the next page.
let pageCtl = new AbortController();
const isAbort = e => e?.name === 'AbortError';
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
  }
  load(key, { lazy = false } = {}) {
    const hit = this.cache.get(key);
    if (hit) { if (!lazy) this.hurry(); return hit; } // an urgent caller joining a lazy in-flight key speeds it up
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
  drop(key, p) { const del = () => this.cache.get(key) === p && this.cache.delete(key); this.keep ? setTimeout(del, this.keep) : del(); }
  clear(key) { this.cache.delete(key); return this; }
  clearAll() { this.cache.clear(); return this; }
  prime(key, value) { if (!this.cache.has(key)) this.cache.set(key, Promise.resolve(value)); return this; }
  flush() {
    clearTimeout(this.timer); this.timer = 0; this.urgent = false;
    while (this.queue.length) this.run(this.queue.splice(0, this.maxBatch));
  }
  async run(batch) {
    const done = new Set();
    const settle = (i, v) => {
      if (done.has(i) || !batch[i]) return;
      done.add(i);
      v instanceof Error ? batch[i].rej(v) : batch[i].res(v);
    };
    try {
      const out = await this.fn(batch.map(b => b.key), settle);
      if (Array.isArray(out)) out.forEach((v, i) => settle(i, v));
    } catch (e) { batch.forEach((_, i) => settle(i, e instanceof Error ? e : new Error(String(e)))); }
    batch.forEach((_, i) => settle(i, new Error('没有返回结果')));
  }
}
// The server runs these as GETs inside POST /api/batch and streams back one NDJSON line per request, as it finishes.
const BATCHABLE = /^(list|categories|detail|search|person|sites|info|live|probe|javdb|douban\/(rating|hot|chart|charts))$/;
async function fetchBatch(keys, settle) {
  const requests = keys.map(k => { const q = k.indexOf('?'); return { route: k.slice(0, q), q: Object.fromEntries(new URLSearchParams(k.slice(q + 1))) }; });
  const headers = { 'Content-Type': 'application/json' };
  if (sessionStorage.pin) headers['X-Pin'] = sessionStorage.pin;
  const r = await fetch('/api/batch', { method: 'POST', headers, body: JSON.stringify({ requests }) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const line = t => {
    if (!t) return;
    let m; try { m = JSON.parse(t); } catch { return; }
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
  if (!BATCHABLE.test(route)) return get(`/api/${route}?` + new URLSearchParams(params), signal);
  const qs = new URLSearchParams(params); qs.sort();
  return withSignal(apiLoader.load(`${route}?${qs}`, { lazy: LAZY.test(route) }), signal === undefined ? pageCtl.signal : signal || undefined);
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
const spinner = '<div class="spinner"></div>';
const fmtSize = b => b > 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b > 1e7 ? (b / 1e6).toFixed(0) + ' MB' : (b / 1e6).toFixed(1) + ' MB';
const fmtSpeed = b => !b ? '' : b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB/s' : Math.max(1, Math.round(b / 1e3)) + ' KB/s';
const fmtEta = s => !s ? '' : s < 60 ? `剩 ${s} 秒` : s < 3600 ? `剩 ${Math.ceil(s / 60)} 分` : `剩 ${(s / 3600).toFixed(1)} 小时`;
const ACTIVE = ['queued', 'downloading'];

// ---------- history (继续观看) ----------
const hist = {
  all: () => JSON.parse(localStorage.history || '[]'),
  get: (site, id) => hist.all().find(h => h.site === site && h.id === id),
  put(entry) {
    const list = hist.all().filter(h => !(h.site === entry.site && h.id === entry.id));
    list.unshift({ ...entry, at: Date.now() });
    localStorage.history = JSON.stringify(list.slice(0, 40));
  },
  del(site, id) { localStorage.history = JSON.stringify(hist.all().filter(h => !(h.site === site && h.id === id))); },
  clear() { localStorage.history = '[]'; },
  // 成人 local titles are private to the 本地媒体 source: never listed under other sources (legacy local entries
  // without the flag count as private too); the local source itself lists only its own history.
  visible: (h, site = state.site) => site === 'local' ? h.site === 'local' : !(h.site === 'local' && h.adult !== 0),
  list: () => hist.all().filter(h => hist.visible(h)),
};

// ---------- favorites (hidden in 儿童 mode) ----------
const favs = {
  all: () => JSON.parse(localStorage.favs || '[]'),
  has: (site, id) => favs.all().some(f => f.site === site && f.id === id),
  toggle(d) {
    if (favs.has(d.site, d.id)) { favs.del(d.site, d.id); return false; }
    const { site, siteName, id, name, pic, remarks, year, type, quality } = d;
    localStorage.favs = JSON.stringify([{ site, siteName, id, name, pic, remarks, year, type, quality, at: Date.now() }, ...favs.all()].slice(0, 500));
    return true;
  },
  del(site, id) { localStorage.favs = JSON.stringify(favs.all().filter(f => !(f.site === site && f.id === id))); },
  clear() { localStorage.favs = '[]'; },
};
const kidsMode = () => state.level === 'kids';
const liveFavs = {
  all: () => JSON.parse(localStorage.liveFavs || '[]'),
  has: url => liveFavs.all().some(f => f.url === url),
  toggle(c) {
    const on = !liveFavs.has(c.url);
    localStorage.liveFavs = JSON.stringify(on ? [{ name: c.name, url: c.url, logo: c.logo || '' }, ...liveFavs.all()] : liveFavs.all().filter(f => f.url !== c.url));
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
const javCache = JSON.parse(localStorage.javdb || '{}');
function javMeta(code) {
  const c = javCache[code];
  if (c && c.found && c.v === 2 && Date.now() - c.at < 30 * 86400e3) return Promise.resolve(c);
  return api('javdb', { code }, null).catch(() => ({ found: false })).then(r => {
    const v = { ...r, at: Date.now() };
    if (r.found) { javCache[code] = v; localStorage.javdb = JSON.stringify(javCache); }
    return v;
  });
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
    if (!r.found) { douban(); return; }
    if (r.cover) {
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
// Results are cached in localStorage and stay valid until 「重测」 — only a failed result is looked at again after 10 min.
const siteHealth = new Map(Object.entries((() => { try { return JSON.parse(localStorage.siteHealth || '{}'); } catch { return {}; } })())); // api -> { ok, ms, total, at }
const healthBusy = new Set();
const FAIL_TTL = 10 * 60e3;
let menuIO = null, healthQ = [], healthRun = 0, healthSave = 0;
const saveHealth = () => { clearTimeout(healthSave); healthSave = setTimeout(() => {
  const live = new Set(state.sites.map(x => x.api)); // forget sources that no longer exist
  localStorage.siteHealth = JSON.stringify(Object.fromEntries([...siteHealth].filter(([k]) => live.has(k)))); }, 400); };
const healthFresh = t => t && (t.ok || Date.now() - t.at < FAIL_TTL);
const healthCell = (s, busy) => busy ? '<b class="hs">测速中…</b>' : s.group ? `<b class="hs">聚合 ${s.group}</b>` : !s.api || s.local ? ''
  : !siteHealth.get(s.api) ? '<b class="hs">…</b>' : siteHealth.get(s.api).ok ? `<b class="hs ok">${siteHealth.get(s.api).ms}ms</b>` : '<b class="hs bad">不通</b>';
function renderMenu() {
  const h = s => siteHealth.get(s.api);
  $('#siteMenu').innerHTML = `<div class="mhead">点播源 · ${state.sites.filter(s => !s.inGroup).length}<span class="mre" data-re="1" title="重新测速当前可见的源">重测</span></div>` + state.sites.filter(s => !s.inGroup).map(s =>
    `<button data-k="${esc(s.key)}" class="${s.key === state.site ? 'on' : ''}${h(s) && !h(s).ok ? ' dead' : ''}"><span>${esc(s.name)}</span>${s.kids ? '<i>少儿</i>' : ''}${healthCell(s, healthBusy.has(s.api))}${s.key === 'local' || s.local ? '' : `<em class="x" data-del="${esc(s.key)}" title="删除这个源">×</em>`}</button>`).join('');
  watchMenu();
}
function watchMenu() {
  if (menuIO) menuIO.disconnect();
  if ($('#siteMenu').hidden) return;
  menuIO = new IntersectionObserver(es => es.forEach(en => {
    if (!en.isIntersecting) return;
    const s = state.sites.find(x => x.key === en.target.dataset.k);
    if (s && s.api && !s.local) queueHealth(s);
  }), { root: $('#siteMenu') });
  $$('#siteMenu button[data-k]').forEach(b => menuIO.observe(b));
}
function markHealth(s) {
  const b = $(`#siteMenu button[data-k="${CSS.escape(s.key)}"]`); if (!b) return;
  const had = $('.hs', b), tmp = document.createElement('div');
  tmp.innerHTML = healthCell(s, healthBusy.has(s.api));
  const hs = tmp.firstElementChild;
  if (had) had.replaceWith(hs); else if (hs) b.insertBefore(hs, $('em.x', b));
  b.classList.toggle('dead', !!siteHealth.get(s.api) && !siteHealth.get(s.api).ok && !healthBusy.has(s.api));
}
function queueHealth(s, force) {
  if (healthBusy.has(s.api) || (!force && healthFresh(siteHealth.get(s.api)))) return;
  healthBusy.add(s.api); healthQ.push(s); markHealth(s); drainHealth();
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
      markHealth(s);
      drainHealth();
    })();
  }
}
// Rows currently visible in the menu, by geometry (does not depend on the observer having fired yet).
function visibleMenuSites() {
  const m = $('#siteMenu').getBoundingClientRect();
  return $$('#siteMenu button[data-k]').filter(b => { const r = b.getBoundingClientRect(); return r.height && r.bottom > m.top && r.top < m.bottom; })
    .map(b => state.sites.find(x => x.key === b.dataset.k)).filter(s => s && s.api && !s.local);
}
function pingMenu(force) {
  watchMenu();
  const vis = visibleMenuSites();
  const todo = force && !vis.length ? testableSites() : vis;
  if (force && !todo.length) return toast('没有可测速的源');
  todo.forEach(s => queueHealth(s, force));
  if (force) toast(`重测 ${todo.length} 个源`);
}
const testableSites = () => state.sites.filter(s => s.api && !s.local && !s.inGroup);
// Without opening the menu: every source that has no good result yet gets pinged in the background (4 at a time);
// passing results are reused from the cache, failures are looked at again after 10 min.
let autoPingT = 0;
function autoPing() {
  clearTimeout(autoPingT);
  autoPingT = setTimeout(() => testableSites().forEach(s => queueHealth(s)), 1500);
}

async function loadSites() {
  const j = await api('sites', {}, null);
  state.sites = j.sites; state.lives = j.live; state.level = j.level;
  const sig = j.level + '|' + j.sites.map(s => s.key + '|' + (s.api || '')).join(',');
  if (sig !== memoSig) { memoSig = sig; apiMemo.clear(); }
  // A source that moved into a 聚合源 is no longer a choice of its own: switch to its group.
  const mine = state.sites.find(s => s.key === state.site);
  if (mine?.inGroup) state.site = localStorage.site = mine.inGroup;
  if (!state.sites.some(s => s.key === state.site)) state.site = state.sites.find(s => !s.inGroup)?.key || '';
  const cur = state.sites.find(s => s.key === state.site);
  $('#siteName').textContent = cur ? cur.name : '无源';
  $('.picker').hidden = !state.sites.length;
  $('#levelTag').hidden = j.level === 'standard';
  $('[data-nav=favorites]').hidden = j.level === 'kids';
  $('[data-nav=charts]').hidden = j.level === 'kids';
  chartCat = null;
  $('#levelTag').textContent = j.level === 'kids' ? '儿童模式' : '无限制';
  $('#levelTag').className = 'level ' + j.level;
  renderMenu();
  autoPing();
}
$('#siteBtn').onclick = e => { e.stopPropagation(); $('#siteMenu').hidden = !$('#siteMenu').hidden; $('#siteBtn').classList.toggle('open', !$('#siteMenu').hidden); if (!$('#siteMenu').hidden) requestAnimationFrame(() => pingMenu()); };
$('#siteMenu').onclick = async e => {
  if (e.target.closest('[data-re]')) { e.stopPropagation(); return pingMenu(true); }
  const del = e.target.closest('[data-del]');
  if (del) {
    e.stopPropagation();
    const key = del.dataset.del, s = state.sites.find(x => x.key === key); if (!s) return;
    if (!confirm(`删除点播源「${s.name}」？`)) return;
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
  closeMenu();
  loadSites(); if (location.hash && location.hash !== '#/') location.hash = '#/'; else route();
};
const closeMenu = () => { $('#siteMenu').hidden = true; $('#siteBtn').classList.remove('open'); };
document.addEventListener('click', e => { if (!e.composedPath().some(n => n.classList?.contains('picker'))) closeMenu(); });
$('#searchForm').onsubmit = e => { e.preventDefault(); const q = $('#q').value.trim(); if (q) location.hash = '#/search/' + encodeURIComponent(q); };
addEventListener('scroll', () => $('#top').classList.toggle('solid', scrollY > 30));
addEventListener('hashchange', () => route({ nav: true }));

let heroTimer, pageTimer;
function newPage() {
  pageCtl.abort();
  pageCtl = new AbortController();
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
addEventListener('scroll', () => {
  if (scrollTick) return;
  scrollTick = requestAnimationFrame(() => {
    scrollTick = 0;
    const k = history.state?.sk;
    if (k && !scrollGuard) saveScroll(k, scrollY);
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
  let ro = null, timer = 0;
  const stop = () => {
    ro?.disconnect(); clearTimeout(timer);
    for (const ev of ['wheel', 'touchstart', 'keydown', 'mousedown']) removeEventListener(ev, stop, true);
    if (restoreCtl === stop) restoreCtl = null;
    scrollGuard = false;
  };
  restoreCtl = stop;
  const apply = () => {
    const max = document.documentElement.scrollHeight - innerHeight;
    scrollTo(0, Math.min(y, Math.max(0, max)));
    return max >= y - 2;
  };
  if (apply()) return stop();
  ro = new ResizeObserver(() => { if (apply()) stop(); });
  ro.observe(document.documentElement);
  timer = setTimeout(stop, 5000);                       // content never got that tall (list got shorter): give up
  for (const ev of ['wheel', 'touchstart', 'keydown', 'mousedown']) addEventListener(ev, stop, { capture: true, passive: true });
}

async function route(opts = {}) {
  clearInterval(heroTimer); clearInterval(pageTimer); view.onclick = null;
  newPage();
  const seq = ++routeSeq;
  view.classList.remove('restoring');
  let [, page, a, b, c] = location.hash.split('/');
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
  } else scrollTo(0, 0);
  try {
    if (page === 'live') return await renderLive();
    if (page === 'settings') return await renderSettings();
    if (page === 'downloads') return await renderDownloads();
    if (page === 'charts') return await renderCharts();
    if (!state.sites.length) return renderNoSites();
    if (page === 'history') return renderHistory();
    if (page === 'favorites') return renderFavorites();
    if (page === 'person') return await renderPerson(a, decodeURIComponent(b || ''));
    if (page === 'site') {
      const k = decodeURIComponent(a || '');
      if (state.sites.some(x => x.key === k)) { state.site = localStorage.site = k; state.cats = []; await loadSites(); }
      history.replaceState(null, '', '#/');
      return await renderHome();
    }
    if (page === 'search') return await renderSearch(decodeURIComponent(a || ''));
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
  const h = it.site && hist.get(it.site, it.id);
  const pct = h && h.dur ? Math.min(100, (h.t / h.dur) * 100) : 0;
  const href = it.douban ? `#/find/${encodeURIComponent(it.name)}` : vodHref(it.site, it.id);
  const pv = it.site === 'local' && /^\/media\/p\//.test(it.pic || '') ? ` data-pv="${esc(it.pic.replace('/media/p/', '/media/g/'))}"` : '';
  const data = it.douban ? `data-db="${esc(it.name)}"` : `data-site="${esc(it.site)}" data-id="${esc(it.id)}"${it.adult ? ` data-jav="${esc(javCode(it.name))}"` : ''}`;
  const rate = it.douban ? (it.rate ? `<span class="db">${esc(it.rate)}</span>` : '')
    : it.adult ? `<span class="db" hidden data-javfb data-n="${esc(it.name)}" data-y="${esc(it.year || '')}"></span>`
    : it.site === 'local' ? '' : `<span class="db" hidden data-n="${esc(it.name)}" data-y="${esc(it.year || '')}"></span>`;
  return `<a class="card${opts.rank ? ' top' : ''}" href="${esc(href)}" ${data}${pv}>${opts.rank ? `<span class="num">${opts.rank}</span>` : ''}${opts.removable ? `<button class="rm" data-rm="${opts.removable}" title="${opts.removable === 'fav' ? '取消收藏' : '从观看历史删除'}" aria-label="删除">✕</button>` : ''}
    <div class="img${it.pic ? '' : ' noimg'}">${it.pic ? posterImg(it.pic) : ''}<span class="ph">${esc(it.name)}</span>${it.remarks ? `<span class="badge">${esc(it.remarks)}</span>` : ''}${qChip(vodQ(it))}${rate}
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
  // Single click → detail (after 240 ms, so a second click can turn it into 直接播放); double click → play / resume at once.
  clearTimeout(cardClickT);
  if (cardClickEl === c && e.detail >= 2) { cardClickEl = null; return playDirect(c); }
  cardClickEl = c;
  cardClickT = setTimeout(() => { cardClickEl = null; if (c.dataset.db !== undefined) openByName(c.dataset.db); else openDetail(c.dataset.site, c.dataset.id); }, 240);
});
let cardClickT = 0, cardClickEl = null;
// Double-click on a card: no detail sheet. Resumes where this title was left (or starts at the first episode).
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
  return `<section class="row"><h2>${href ? `<a href="${href}">${esc(title)}</a>` : esc(title)}${opts.extra || ''}</h2>
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
async function renderHome() {
  if (!keepView) view.innerHTML = spinner;
  const site = state.site;
  const [latest, cats] = await Promise.all([api('list', { site }),
    state.cats.length ? { categories: state.cats } : api('categories', { site }).catch(() => ({ categories: [] }))]);
  state.cats = cats.categories;
  const sig = pageCtl.signal;
  const cont = hist.list().filter(h => state.sites.some(s => s.key === h.site)).slice(0, 20);
  const favList = favs.all().filter(f => state.sites.some(s => s.key === f.site)).slice(0, 30);
  const kids = state.level === 'kids';
  const own = site === 'local'; // 本地媒体: its own folders only, no 豆瓣
  const adultSite = !!state.sites.find(x => x.key === site)?.adult; // 成人源: no 豆瓣 rows either
  view.innerHTML = `
    <div class="hero" id="hero"></div>
    <div class="rows">
      ${cont.length ? row('继续观看', cont, '#/history', it => `${it.siteName} · ${it.epName || ''}`,
        { removable: 'hist', extra: '<button class="hclear" data-clear="hist">清空</button>' }) : ''}
      ${!kids && favList.length ? row('我的收藏', favList, '#/favorites', it => it.siteName, { removable: 'fav' }) : ''}
      ${row(kids ? '少儿精选' : '最新更新', latest.list, '#/cat//' + encodeURIComponent(kids ? '少儿精选' : '最新更新'))}
      <div id="dbRows"></div>
      <div id="more"></div>
      ${state.cats.length ? `<section class="row"><h2>全部分类</h2><div class="chips">${state.cats.map(c => `<a class="chip" href="#/cat/${encodeURIComponent(c.id)}/${encodeURIComponent(c.name)}">${esc(c.name)}</a>`).join('')}</div></section>` : ''}
    </div>`;
  hero(latest.list.slice(0, 6));
  observeRatings(view);
  if (!kids && !own && !adultSite) {
    // Which 豆瓣 rows to show is a per-browser setting (设置 → 首页豆瓣分类); only the enabled ones are fetched.
    const on = dbRows(), kinds = DB_ROWS.filter(([k]) => on[k]);
    Promise.all(kinds.map(([k]) => api('douban/hot', { type: k }).catch(() => ({ list: [] })))).then(res => {
      if (sig.aborted || !$('#dbRows')) return;
      $('#dbRows').innerHTML = kinds.map(([, title], i) => res[i].list.length ? row(title, res[i].list.map(x => ({ ...x, douban: 1 })), '#/charts') : '').join('');
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
        <div class="btns"><button class="btn play">▶ 播放</button><button class="btn more">ⓘ 详细信息</button></div></div>
      <div class="dots">${items.map((_, k) => `<i class="${k === i ? 'on' : ''}" data-k="${k}"></i>`).join('')}</div>`;
    el.querySelector('.play').onclick = () => openDetail(it.site, it.id, true);
    el.querySelector('.more').onclick = () => openDetail(it.site, it.id);
    $$('.dots i', el).forEach(d => d.onclick = () => { i = +d.dataset.k; show(); });
    const dbTag = r => { if (items[i] !== it) return; const t = el.querySelector('.dbtag'); if (t && r.rate) { t.textContent = '豆瓣 ' + r.rate; t.hidden = false; } };
    if (it.adult) {
      const code = javCode(it.name);
      if (code) javMeta(code).then(r => {
        if (items[i] !== it) return;
        if (r.found) {
          const p = el.querySelector('.poster'); if (p && r.cover) p.style.cssText = bgLayers(it.pic, r.cover, 'l');
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
      ${list.length ? '<button class="small feedgo" data-feed="hist">▶ 沉浸观看</button><button class="small" data-clear="hist">清空全部</button>' : ''}</div>
    <p class="empty hempty" ${list.length ? 'hidden' : ''}>还没有观看记录。</p>
    ${list.length ? `<div class="grid">${list.map(it => card(it, { removable: 'hist', sub: `${names[it.site] || it.siteName} · ${it.epName || ''}` })).join('')}</div>` : ''}</div>`;
  observeRatings(view);
  observeJav(view);
}
function renderFavorites() {
  if (kidsMode()) { view.innerHTML = '<div class="page"><h1>我的收藏</h1><p class="empty">儿童模式下收藏不可见。</p></div>'; return; }
  const list = favs.all();
  view.innerHTML = `<div class="page"><div class="pagehead"><h1>我的收藏</h1>
      ${list.length ? '<button class="small feedgo" data-feed="fav">▶ 沉浸观看</button><button class="small" data-clear="fav">清空全部</button>' : ''}</div>
    <p class="empty hempty" ${list.length ? 'hidden' : ''}>还没有收藏。打开影片，点「＋ 收藏」。</p>
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
async function renderPerson(role, name) {
  const label = role === 'director' ? '导演' : '演员';
  view.innerHTML = `<div class="page"><h1>${esc(name)} <span class="role">${label}</span></h1><p class="lan">在 ${state.sites.length} 个源里找作品…</p>${spinner}</div>`;
  const j = await api('person', { name, role });
  view.innerHTML = `<div class="page"><h1>${esc(name)} <span class="role">${label}</span></h1>
    <p class="lan">${j.list.length ? `${j.list.length} 部作品，按年份排序（只列出各源里能搜到、且演职员表里确实有这个名字的）` : ''}</p>
    ${j.list.length ? `<div class="grid">${j.list.map(it => card(it, { sub: [it.year, it.type, it.siteName].filter(x => x && x !== '0').join(' · ') })).join('')}</div>`
      : '<p class="empty">各源都没搜到。部分源的搜索只按片名匹配，不认演员。</p>'}</div>`;
  observeRatings(view);
}

// ---------- category grid (infinite scroll) ----------
async function renderCategory(t, name, siteKey) {
  const site = state.sites.some(x => x.key === siteKey) ? siteKey : state.site;
  const other = site !== state.site ? state.sites.find(x => x.key === site)?.name : '';
  const head = `<div class="page"><div class="pagehead"><h1>${esc(name || '全部')}${other ? ` <span class="role">${esc(other)}</span>` : ''}</h1><button class="small feedgo" data-feed="cat" data-t="${esc(t || '')}" data-name="${esc(name || '全部')}" data-site="${esc(site)}">▶ 沉浸观看</button></div><div class="grid" id="grid"></div><div id="tail">${spinner}</div></div>`;
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
        g.insertAdjacentHTML('beforeend', j.list.filter(it => !seen.has(it.id) && seen.add(it.id)).map(it => card(it)).join('') );
      }
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
    $('#grid')?.insertAdjacentHTML('beforeend', fresh.map(it => card(it)).join(''));
    if ($('#grid')) { observeRatings($('#grid')); observeJav($('#grid')); }
    if (pg >= count && $('#tail')) $('#tail').innerHTML = seen.size ? '' : '<div class="empty">这个分类是空的</div>';
    busy = false;
    // IntersectionObserver only reports changes: a tail that is still near (tall window, restored scroll position)
    // would never be reported again, so keep filling until it is out of reach.
    const tailEl = $('#tail');
    if (tailEl && pg < count && tailEl.getBoundingClientRect().top < innerHeight + 600) setTimeout(() => more().catch(() => { busy = false; }), 0);
  };
  if (!pg) await more();
  else if (pg < count) { const tailEl = $('#tail'); if (tailEl && tailEl.getBoundingClientRect().top < innerHeight + 600) await more(); }
  const sig = pageCtl.signal;
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
  addEventListener('scroll', onScroll, { passive: true });
  sig.addEventListener('abort', () => { removeEventListener('scroll', onScroll); cancelAnimationFrame(tick); });
}

// ---------- search (all sources) ----------
// Every title that matched (by name, or because a site's search also matched its 演员/导演), then the
// matching people as name tags that open their filmography.
async function renderSearch(q) {
  $('#q').value = q;
  view.innerHTML = `<div class="page"><h1>“${esc(q)}”</h1><p class="lan">正在搜索全部 ${state.sites.length} 个源（片名 / 演员 / 导演）…</p>${spinner}</div>`;
  const j = await api('search', { wd: q });
  const names = Object.fromEntries(state.sites.map(s => [s.key, s.name]));
  const order = Object.fromEntries(state.sites.map((s, i) => [s.key, i]));
  const nq = normName(q);
  const rank = it => it.name === q ? 0 : normName(it.name).includes(nq) ? 1 : 2;
  const res = j.results.sort((a, b) => rank(a) - rank(b) || order[a.site] - order[b.site]);
  const people = [...(j.actor || []).map(p => ({ ...p, role: 'actor', label: '演员' })), ...(j.director || []).map(p => ({ ...p, role: 'director', label: '导演' }))]
    .sort((a, b) => (b.name === q) - (a.name === q) || (b.count ?? b.list?.length ?? 0) - (a.count ?? a.list?.length ?? 0));
  view.innerHTML = `<div class="page"><div class="pagehead"><h1>“${esc(q)}”</h1>${res.length ? `<button class="small feedgo" data-feed="search" data-q="${esc(q)}">▶ 沉浸观看</button>` : ''}</div>
    <p class="lan">${state.sites.length} 个源，${res.length} 部影片${people.length ? `，${people.length} 位演职员` : ''}${j.failed.length ? `；${esc(j.failed.join(' / '))} 未响应` : ''}</p>
    ${res.length ? `<div class="grid">${res.map(it => card(it, { sub: names[it.site] || it.siteName })).join('')}</div>` : '<div class="empty">没有影片匹配，换个关键词（片名、演员或导演）</div>'}
    ${people.length ? `<h2 class="rtitle">演员 / 导演</h2><div class="ptags">${people.map(p =>
      `<a class="ptag" href="#/person/${p.role}/${encodeURIComponent(p.name)}"><b>${esc(p.name)}</b><span>${p.label} · ${p.count ?? p.list?.length ?? 0} 部</span></a>`).join('')}</div>` : ''}</div>`;
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
async function enqueue(d, line, eps) {
  await req('POST', '/api/downloads', { items: eps.map(i => ({ site: d.site, siteName: d.siteName, id: d.id, name: d.name, pic: d.pic, line, ep: i, epName: d.lines[line].episodes[i].name, url: d.lines[line].episodes[i].url })) });
  await refreshDownloads();
  toast(eps.length > 1 ? `已加入下载：${eps.length} 集` : '已加入下载');
  $('#modal')?.pollDl?.();
}

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
        ${anyActive ? '<button class="small" data-op="pause" data-all>全部暂停</button>' : ''}
        ${anyPaused ? '<button class="small" data-op="resume" data-all>全部开始</button>' : ''}
        ${totalSpeed ? `<span class="spd">${fmtSpeed(totalSpeed)}</span>` : ''}</div>
      <p class="lan">同时下载 ${j.maxJobs} 集，其余排队。保存在服务端 <code>${esc(j.dir)}</code>，局域网里任何设备都能播放。已用 ${fmtSize(total)}${j.free ? `，磁盘剩余 ${fmtSize(j.free)}` : ''}。</p>
      ${j.jobs.length ? `<div class="dls">${j.jobs.map(x => {
        const pct = x.pct || 0;
        return `<div class="dl ${x.status}" data-id="${esc(x.id)}">
          <div class="thumb" style="${bg(x.pic)}"></div>
          <div class="dinfo"><div><b>${esc(x.name)}</b> <span>${esc(x.epName)}</span></div>
            <div class="lan">${esc(x.siteName)} · ${status[x.status] || x.status}${x.status === 'queued' && x.qpos ? ` 第 ${x.qpos} 位` : ''}${['downloading', 'paused'].includes(x.status) ? ` ${pct}%` : ''} · ${fmtSize(x.bytes || 0)}${x.status === 'downloading' && x.speed ? ` · <b class="spd">${fmtSpeed(x.speed)}</b> · ${fmtEta(x.eta)}` : ''}${x.error ? ' · ' + esc(x.error) : ''}</div>
            <div class="bar"><i style="width:${x.status === 'done' ? 100 : pct}%"></i></div></div>
          <div class="dops">
            ${x.status === 'done' ? `<button class="btn play sm" data-op="play">▶ 播放</button><a class="small" href="/dl/${esc(x.id)}/save" download>保存到本机</a>` : ''}
            ${['queued', 'downloading'].includes(x.status) ? '<button class="small" data-op="pause">⏸ 暂停</button>' : ''}
            ${['paused', 'error'].includes(x.status) ? `<button class="small" data-op="resume">▶ ${x.status === 'error' ? '重试' : '继续'}</button>` : ''}
            ${(x.status === 'queued' && x.qpos > 1) || ['paused', 'error'].includes(x.status) ? '<button class="small" data-op="top" title="排到队首，下一个就下">⇡ 优先</button>' : ''}
            <button class="small" data-op="del">删除</button></div></div>`;
      }).join('')}</div>` : '<p class="empty">还没有下载。打开任意影片，点「⬇ 下载」再选集。</p>'}</div>`;
  };
  await draw();
  view.onclick = async e => {
    const op = e.target.dataset.op; if (!op) return;
    if (e.target.dataset.all !== undefined) { await req('PATCH', `/api/downloads?id=*&action=${op}`); return draw(); }
    const id = e.target.closest('.dl').dataset.id;
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
  m.innerHTML = `<div class="sheet">${spinner}</div>`;
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
            ${d.local ? '' : '<button class="btn more dlbtn" id="dlToggle">⬇ 下载</button>'}` : ''}
          ${canOpen && eps.length ? `<button class="btn more ico" id="extPlay" title="用系统默认播放器打开${eps.length > 1 ? ' ' + esc(eps[resumeIdx].name) : ''}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3h7v7h-2V6.4l-8.3 8.3-1.4-1.4L17.6 5H14zM5 5h6v2H5v12h12v-6h2v8H3V5z"/></svg>播放器</button><button class="btn more ico" id="extReveal" title="在文件夹中显示这个文件"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5.5A1.5 1.5 0 0 1 4.5 4h5.2c.4 0 .8.2 1.1.5L12.3 6H19.5A1.5 1.5 0 0 1 21 7.5v10A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z"/></svg>文件夹</button>` : ''}
          ${kidsMode() ? '' : `<button class="btn more fav ${favs.has(site, id) ? 'on' : ''}" id="favBtn">${favs.has(site, id) ? '✓ 已收藏' : '＋ 收藏'}</button>`}
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
    if (d.adult) {
      const code = javCode(d.name);
      if (code) javMeta(code).then(r => {
        if (!m.isConnected) return;
        if (!r.found) { dbRate(d.name, d.year).then(doubanDetail); return; }
        const h1 = $('.info h1', m);
        if (h1 && r.title && r.title !== d.name) h1.textContent = r.title;
        const p = $('.top .poster', m);
        if (p && r.cover) p.style.cssText = bgLayers(d.pic, r.cover, 'l');
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
    let label, p = 0;
    if (dlMode) label = '✓ 完成';
    else if (eps.length === 1) {
      const j = dlFor(site, id, eps[0].url);
      if (!j) label = '⬇ 下载';
      else if (j.status === 'done') label = '✓ 已下载';
      else if (j.status === 'queued') label = `⏳ 排队第 ${j.qpos} 位`;
      else if (j.status === 'downloading') { label = `⏸ ${j.pct}%${speed ? ' · ' + speed : ''}`; p = j.pct; }
      else if (j.status === 'paused') { label = `▶ 继续 ${j.pct}%`; p = j.pct; }
      else label = '⟳ 重新下载';
      b.title = j ? { downloading: '点一下暂停', queued: '点一下暂停', paused: '点一下继续' }[j.status] || '' : '';
    } else if (active.length) {
      const done = mine.filter(j => j.status === 'done').length;
      label = `⬇ ${done}/${mine.length} 集${speed ? ' · ' + speed : ''}`;
      p = Math.round(mine.reduce((n, j) => n + (j.status === 'done' ? 100 : j.pct || 0), 0) / mine.length);
    } else {
      const done = mine.filter(j => j.status === 'done').length;
      label = done ? `⬇ 下载 · 已下 ${done} 集` : '⬇ 下载';
    }
    b.textContent = label;
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
  api('search', { wd: d.name }, m.ctl.signal).catch(() => ({ results: [] })).then(j => {
    if (m.ctl.signal.aborted) return;
    alts = j.results.filter(r => r.name === d.name && !(r.site === site && r.id === id));
    paintAlts();
  });
  if (autoplay && typeof autoplay === 'object' && d.lines[autoplay.line]?.episodes[autoplay.ep]) {
    line = autoplay.line; render(); play(d, line, autoplay.ep);
  } else if (autoplay && d.lines.length) play(d, line, h0 && h0.line === line ? h0.ep : 0);
}
function people(label, role, list, max = 99) {
  if (!list?.length) return '';
  return `<div class="people ${list.length > max ? '' : 'all'}"><span class="plabel">${label}</span>${list.map((n, i) =>
    `<a class="pchip ${i >= max ? 'extra' : ''}" data-nav href="#/person/${role}/${encodeURIComponent(n)}">${esc(n)}</a>`).join('')}
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
const player = $('#player'), video = $('#video');
let hls, cur = null, idleTimer;
// 画中画: the small window keeps playing while the full-screen player steps aside and the page underneath
// comes back. "Back to tab" brings the player back; closing the small window stops playback.
let pipOn = false, pipSkip = false;
const playerOpen = () => !player.hidden && !pipOn;
video.addEventListener('enterpictureinpicture', () => {
  pipOn = true;
  player.classList.add('pip'); togglePlist(false);
  if (!$('#modal')) document.body.style.overflow = '';
  if (history.state?.player) { pipSkip = true; history.back(); }
});
video.addEventListener('leavepictureinpicture', () => {
  if (!pipOn) return;
  pipOn = false;
  player.classList.remove('pip');
  if (video.paused) return closePlayer();
  history.pushState({ player: 1 }, ''); document.body.style.overflow = 'hidden'; poke();
});

function play(d, line, ep) {
  cur = { kind: 'vod', d, line, ep, eps: d.lines[line].episodes, title: d.name };
  const h = hist.get(d.site, d.id);
  openPlayer(h && h.line === line && h.ep === ep && h.dur - h.t > 30 ? h.t : 0);
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
  $('[data-act=prev]').textContent = live ? '上一台' : '上一集';
  $('[data-act=next]').textContent = live ? '下一台' : '下一集';
  $('[data-act=list]').textContent = live ? '频道' : '选集';
  $('[data-act=prev]').hidden = cur.ep <= 0;
  $('[data-act=next]').hidden = cur.ep >= cur.eps.length - 1;
  $('[data-act=list]').hidden = cur.eps.length <= 1;
  $('[data-act=star]').hidden = !live;
  paintVodActs();
  $('[data-act=ext]').hidden = !(cur.kind === 'vod' && cur.d.local && serverInfo?.loopback);
  if (live) $('[data-act=star]').textContent = liveFavs.has(e.url) ? '★ 已收藏' : '☆ 收藏';
  renderPlist();
  const local = cur.kind === 'vod' ? dlFor(cur.d.site, cur.d.id, e.url) : null;
  const useLocal = cur.kind === 'local' || local?.status === 'done';
  $('.local').hidden = !useLocal;
  load(local?.status === 'done' ? local.play : e.url, startAt, false, useLocal || e.url.startsWith('/media/'));
  poke();
}
// 收藏 / 下载 inside the player (点播 only, not 本地媒体): same actions as the detail sheet, so a title opened by double-click
// can still be saved or downloaded without leaving the player.
function paintVodActs() {
  const v = cur?.kind === 'vod' && !cur.d.local;
  const fav = $('[data-act=vfav]'), dl = $('[data-act=dl]');
  fav.hidden = !v || kidsMode(); dl.hidden = !v;
  if (!v) return;
  fav.textContent = favs.has(cur.d.site, cur.d.id) ? '✓ 已收藏' : '＋ 收藏'; fav.classList.toggle('on', favs.has(cur.d.site, cur.d.id));
  const j = dlFor(cur.d.site, cur.d.id, cur.eps[cur.ep].url);
  dl.textContent = !j ? '⬇ 下载' : j.status === 'done' ? '✓ 已下载' : ACTIVE.includes(j.status) ? `⏳ ${j.pct || 0}%` : j.status === 'paused' ? '▶ 继续下载' : '⟳ 重试下载';
}
function msg(t) { $('.pmsg').textContent = t || ''; }
function load(url, startAt, viaProxy, isLocal) {
  if (hls) { hls.destroy(); hls = null; }
  const src = viaProxy ? '/hls?u=' + encodeURIComponent(url) : url;
  // 本地媒体 originals (/media/f/…) play natively; /media/h/… is a growing HLS playlist, start at its beginning.
  const direct = /\.mp4(\?|$)/i.test(url) || url.startsWith('/media/f/');
  playingSrc = { src, hls: !direct };
  pvReset();
  msg('加载中…');
  const seek = () => { if (startAt) video.currentTime = startAt; video.play().catch(() => msg('点一下播放')); };
  const retry = why => { if (!viaProxy && !isLocal) { msg('直连失败，改走中转…'); load(url, startAt, true); } else msg('播放失败：' + why + '。换一集/换个源试试'); };
  if (window.Hls && Hls.isSupported() && !direct) {
    hls = new Hls({ maxBufferLength: 30, enableWorker: true, ...(url.startsWith('/media/h/') ? { startPosition: startAt || 0 } : {}) });
    hls.on(Hls.Events.MANIFEST_PARSED, seek);
    hls.on(Hls.Events.ERROR, (_, data) => { if (data.fatal) retry(data.details); });
    hls.loadSource(src); hls.attachMedia(video);
  } else {
    video.src = src;
    video.onloadedmetadata = seek;
    video.onerror = () => retry('无法解码');
  }
}
video.addEventListener('playing', () => msg(''));
video.addEventListener('waiting', () => msg('缓冲中…'));
video.addEventListener('ended', () => { if (cur && cur.ep < cur.eps.length - 1) step(1); });
let lastSave = 0;
video.addEventListener('timeupdate', () => {
  if (!cur || cur.kind !== 'vod' || Date.now() - lastSave < 4000 || !video.duration) return;
  lastSave = Date.now();
  const { d, line, ep, eps } = cur;
  hist.put({ site: d.site, adult: d.adult ? 1 : 0, siteName: d.siteName, id: d.id, name: d.name, pic: d.pic, remarks: d.remarks, year: d.year,
    line, ep, epName: eps[ep].name, t: video.currentTime, dur: video.duration });
});
function step(n) { cur.ep = Math.max(0, Math.min(cur.eps.length - 1, cur.ep + n)); openPlayer(0); }
// Episode / channel picker. Live: numbered single column with a filter; 点播: compact grid.
// Picking closes the panel; click outside or Esc also closes it.
function renderPlist() {
  const box = $('.plist'), live = cur.kind === 'live';
  box.classList.toggle('live', live);
  box.innerHTML = `<div class="phead"><b>${live ? '频道' : '选集'}</b><span>${cur.ep + 1} / ${cur.eps.length}</span>
      <button class="icon sm" data-pclose title="关闭">✕</button></div>
    ${cur.eps.length > 20 ? `<input class="pfind" type="search" placeholder="${live ? '搜频道' : '搜集数'}">` : ''}
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
  box.hidden = !open;
  $('[data-act=list]').classList.toggle('on', open);
  if (open) { $('.pitems .on', box)?.scrollIntoView({ block: 'center' }); poke(); }
}
function closePlayer() {
  if (hls) { hls.destroy(); hls = null; }
  pvReset(); playingSrc = null;
  video.pause(); video.removeAttribute('src'); video.load();
  if (pipOn) { pipOn = false; player.classList.remove('pip'); document.exitPictureInPicture?.().catch(() => {}); }
  player.hidden = true; togglePlist(false); msg('');
  if (!$('#modal')) document.body.style.overflow = '';
  $('#modal')?.refresh?.();
  cur = null;
}
player.addEventListener('click', e => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'close') history.back();
  if (act === 'next') step(1);
  if (act === 'prev') step(-1);
  if (act === 'list') return togglePlist();
  if (act === 'ext') { video.pause(); return openLocal(cur.eps[cur.ep].url, 'play'); }
  if (act === 'vfav') { toast(favs.toggle(cur.d) ? '已收藏' : '已取消收藏'); return paintVodActs(); }
  if (act === 'dl') {
    const e = cur.eps[cur.ep], j = dlFor(cur.d.site, cur.d.id, e.url);
    if (j?.status === 'done') return toast('已下载，播放时会自动用本地文件');
    if (j) return req('PATCH', `/api/downloads?id=${j.id}&action=${ACTIVE.includes(j.status) ? 'pause' : 'resume'}`).then(() => refreshDownloads()).then(paintVodActs, err => toast(err.message));
    return enqueue(cur.d, cur.line, [cur.ep]).then(paintVodActs, err => toast(err.message));
  }
  if (act === 'star') { const c = cur.eps[cur.ep]; toast(liveFavs.toggle(c) ? '已收藏' : '已取消收藏'); $('[data-act=star]').textContent = liveFavs.has(c.url) ? '★ 已收藏' : '☆ 收藏'; return; }
  if (!$('.plist').hidden && !e.target.closest('.plist, .pbar')) togglePlist(false);
});
function poke() { player.classList.remove('idle'); clearTimeout(idleTimer); idleTimer = setTimeout(() => !video.paused && $('.plist').hidden && !scrubbing && !$('.ctrl').matches(':hover') && player.classList.add('idle'), 3000); }
player.addEventListener('mousemove', poke); player.addEventListener('touchstart', poke);

// ---------- player controls (mouse devices) ----------
// Native controls can't tell us where the pointer is on the timeline, so on hover-capable screens the
// player gets its own bar. Hovering the timeline seeks a second, muted, lowest-quality copy of the stream
// to that moment and shows its frame. Touch screens keep the native controls.
const fineCursor = matchMedia('(hover: hover) and (pointer: fine)').matches;
const ctrl = $('.ctrl'), tl = $('.tl'), tip = $('.tip'), seekV = $('.tip video');
let playingSrc = null, pvHls = null, pvKey = '', pvWant = null, pvBusy = false, pvTimer = 0, scrubbing = false;
video.controls = !fineCursor;
ctrl.hidden = !fineCursor;
const fmtT = s => { s = Math.max(0, Math.floor(s || 0)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = String(s % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`; };
const isVodTime = () => Number.isFinite(video.duration) && video.duration > 0;
function paintCtrl() {
  const d = video.duration, t = video.currentTime;
  player.classList.toggle('paused', video.paused);
  player.classList.toggle('muted', video.muted || video.volume === 0);
  $('.vol').value = video.muted ? 0 : video.volume;
  tl.hidden = !isVodTime();
  $('.time').textContent = isVodTime() ? `${fmtT(t)} / ${fmtT(d)}` : cur?.kind === 'live' ? '● 直播' : '';
  if (!isVodTime()) return;
  if (!scrubbing) tl.style.setProperty('--p', (t / d) * 100 + '%');
  let end = 0;
  for (let i = 0; i < video.buffered.length; i++) if (video.buffered.start(i) <= t + 1) end = Math.max(end, video.buffered.end(i));
  tl.style.setProperty('--b', (end / d) * 100 + '%');
}
for (const ev of ['timeupdate', 'durationchange', 'progress', 'play', 'pause', 'volumechange', 'loadedmetadata']) video.addEventListener(ev, paintCtrl);
const togglePlay = () => (video.paused ? video.play().catch(() => {}) : video.pause());
const toggleFs = () => (document.fullscreenElement ? document.exitFullscreen() : player.requestFullscreen().catch(() => {}));
const RATES = [1, 1.25, 1.5, 2, 0.75];
ctrl.addEventListener('click', e => {
  const c = e.target.closest('[data-c]')?.dataset.c; if (!c) return;
  e.stopPropagation(); poke();
  if (c === 'play') togglePlay();
  if (c === 'back') video.currentTime -= 10;
  if (c === 'fwd') video.currentTime += 10;
  if (c === 'mute') { video.muted = !video.muted; if (!video.muted && !video.volume) video.volume = 0.5; }
  if (c === 'fs') toggleFs();
  if (c === 'pip') (document.pictureInPictureElement ? document.exitPictureInPicture() : video.requestPictureInPicture()).catch(() => toast('这个浏览器不支持画中画'));
  if (c === 'rate') { video.playbackRate = RATES[(RATES.indexOf(video.playbackRate) + 1) % RATES.length]; e.target.closest('button').textContent = video.playbackRate + 'x'; }
});
$('.vol').oninput = e => { video.volume = +e.target.value; video.muted = video.volume === 0; };
if (fineCursor) {
  video.addEventListener('click', () => { if (!player.hidden && $('.plist').hidden) { togglePlay(); poke(); } });
  video.addEventListener('dblclick', toggleFs);
}

// Timeline: hover → time + frame, press/drag → seek.
const tlFrac = e => { const r = tl.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); };
function hoverAt(e) {
  if (!isVodTime()) return;
  const f = tlFrac(e), t = f * video.duration, r = tl.getBoundingClientRect();
  tl.style.setProperty('--h', f * 100 + '%');
  tip.hidden = false;
  $('span', tip).textContent = fmtT(t);
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
  video.currentTime = tlFrac(e) * video.duration;
  if (!tl.matches(':hover')) tip.hidden = true;
});

// The preview copy: same source the player ended up using (direct or relayed), lowest level, tiny buffer.
function previewAt(t) {
  if (!playingSrc) return;
  if (pvKey !== playingSrc.src) {
    pvReset();
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
  if (e.key === 'Escape' && !player.hidden && !$('.plist').hidden) { e.preventDefault(); return togglePlist(false); }
  if (e.target.matches('input, textarea')) return;
  if (e.key === 'Escape' && (playerOpen() || $('#modal'))) history.back();
  if (!playerOpen()) return;
  if (e.key === ' ') { e.preventDefault(); video.paused ? video.play() : video.pause(); }
  if (e.key === 'ArrowRight') video.currentTime += 10;
  if (e.key === 'ArrowLeft') video.currentTime -= 10;
  if (e.key === 'n' || e.key === 'PageDown') step(1);
  if (e.key === 'p' || e.key === 'PageUp') step(-1);
  if (e.key === 'f') toggleFs();
  if (e.key === 'm') video.muted = !video.muted;
  if (cur?.kind === 'live' && e.key === 'ArrowDown') { e.preventDefault(); step(1); }
  if (cur?.kind === 'live' && e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
});

// ---------- live ----------
let serverInfo = null;
const infoP = () => serverInfo ? Promise.resolve(serverInfo) : get('/api/info', null).then(j => (serverInfo = j), () => ({ urls: [], ffmpeg: false }));
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

// ---- 直播源 picker: one fixed-size button + a popover (desktop) / bottom sheet (phone). Search, tick rows, bulk delete. ----
const liveHealth = new Map();           // url -> { ok, text, at } | 'busy'
const lm = { cfg: [], sel: new Set(), q: '', busy: false };
const liveUrlOf = key => lm.cfg[Number(key)]?.url || '';
async function lmRefresh() { lm.cfg = (await get('/api/config', null)).lives || []; }
const lmVisible = () => { const q = lm.q.toLowerCase(); return state.lives.filter(l => !q || l.name.toLowerCase().includes(q)); };
// Status text of a row: running → 测速中, waiting in the queue → 排队中, else the last result.
function lmStatus(k) {
  const h = liveHealth.get(liveUrlOf(k));
  if (h === 'busy') return { cls: '', text: '测速中…' };
  if (lmQ.includes(k)) return { cls: '', text: '排队中' };
  return h ? { cls: h.ok ? 'ok' : 'bad', text: h.text } : null;
}
function lmRender() {
  const box = $('#llist'); if (!box) return;
  const cur = localStorage.live;
  const rows = lmVisible();
  box.innerHTML = rows.map(l => {
    const s = lmStatus(l.key), h = liveHealth.get(liveUrlOf(l.key));
    return `<div class="lpr ${l.key === cur ? 'on' : ''} ${h && h !== 'busy' && !h.ok ? 'dead' : ''} ${lm.sel.has(l.key) ? 'sel' : ''}" data-k="${esc(l.key)}">
      <label class="lck"><input type="checkbox" class="lsel" ${lm.sel.has(l.key) ? 'checked' : ''}></label><span class="nm" title="${esc(l.name)}">${esc(l.name)}</span>${s ? `<b class="hs ${s.cls}">${esc(s.text)}</b>` : ''}
      <em class="x" data-del="${esc(l.key)}" title="删除这个直播源">×</em></div>`;
  }).join('') || '<div class="lan" style="padding:10px">没有匹配的直播源</div>';
  lmSelUI();
  lmWatch();
}
// Ticking a row only touches the checkbox and the action bar (no re-render, the list never jumps).
function lmSelUI() {
  const n = lm.sel.size;
  $('#lmCount').textContent = `${state.lives.length} 个直播源`;
  $('#lmBar').hidden = !n;
  $('#lmSelN').textContent = `已选 ${n}`;
  const vis = lmVisible();
  $('#lmBar [data-lm=all]').textContent = vis.length && vis.every(l => lm.sel.has(l.key)) ? '取消全选' : '全选';
}
async function lmSave(mutate) {
  const curUrl = liveUrlOf(localStorage.live);
  const cfg = await get('/api/config', null);
  await req('PUT', '/api/config', { ...cfg, lives: mutate(cfg.lives) });
  await Promise.all([loadSites(), lmRefresh()]);
  const i = lm.cfg.findIndex(l => l.url === curUrl);
  localStorage.live = String(i >= 0 ? i : 0);
  lm.sel.clear();
  $('#lmName').textContent = state.lives.find(l => l.key === localStorage.live)?.name || '无直播源';
  lmRender();
  if (i < 0 && location.hash.startsWith('#/live')) loadLiveBody();
}
const LIVE_TTL = 5 * 60e3;
let lmIO = null, lmQ = [], lmRun = 0;
async function lmPingOne(k) {
  const url = liveUrlOf(k), name = state.lives.find(l => l.key === k)?.name || '';
  let j;
  for (let t = 0; t < 3; t++) {            // network blips: retry twice before calling a source dead
    if (t) await new Promise(ok => setTimeout(ok, 600 * t));
    j = await api('checklive', { url, name }, AbortSignal.timeout(25e3)).catch(e => ({ ok: false, error: e.message }));
    if (j.ok) break;
  }
  liveHealth.set(url, { ok: !!j.ok, text: j.channels ? `${j.channels}台 · ${j.alive}/${j.sampled}` : '不通', at: Date.now() });
}
// Rows scrolled into view are pinged (3 at a time, newest first), results are kept 5 min. A row that scrolls away
// before its turn leaves the queue, so what the user is looking at is always what gets tested next.
function lmQueue(k) {
  const url = liveUrlOf(k), h = liveHealth.get(url);
  if (!url || h === 'busy' || (h && Date.now() - h.at < LIVE_TTL)) return;
  lmQ = [k, ...lmQ.filter(x => x !== k)];
  lmMark(k); lmDrain();
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
  if (!hs) { hs = document.createElement('b'); row.insertBefore(hs, $('em.x', row)); }
  hs.className = 'hs ' + s.cls;
  hs.textContent = s.text;
  row.classList.toggle('dead', !!h && h !== 'busy' && !h.ok);
}
function lmWatch() {
  lmIO?.disconnect();
  const m = $('#liveMenu'); if (!m || m.hidden) return;
  lmIO = new IntersectionObserver(es => es.forEach(en => en.isIntersecting ? lmQueue(en.target.dataset.k) : lmUnqueue(en.target.dataset.k)), { root: $('#llist') });
  $$('#llist .lpr').forEach(r => lmIO.observe(r));
}
async function lmOp(op) {
  if (op === 'clear') { lm.sel.clear(); $$('#llist .lpr.sel').forEach(r => { r.classList.remove('sel'); $('.lsel', r).checked = false; }); return lmSelUI(); }
  if (op === 'all') {
    const vis = lmVisible(), all = vis.every(l => lm.sel.has(l.key));
    vis.forEach(l => all ? lm.sel.delete(l.key) : lm.sel.add(l.key));
    $$('#llist .lpr').forEach(r => { const on = lm.sel.has(r.dataset.k); r.classList.toggle('sel', on); $('.lsel', r).checked = on; });
    return lmSelUI();
  }
  if (op !== 'delsel' || lm.busy || !lm.sel.size) return;
  const drop = new Set([...lm.sel].map(Number)), n = drop.size;
  if (!confirm(`删除选中的 ${n} 个直播源？`)) return;
  try {
    lm.busy = true;
    await lmSave(lives => lives.filter((_, i) => !drop.has(i)));
    toast(`已删除 ${n} 个`);
  } catch (e) { toast(e.message); }
  finally { lm.busy = false; }
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
    view.innerHTML = `<div class="page"><div class="pagehead" id="liveHead"><h1>直播</h1>
      <div class="lpick"><button id="liveBtn" class="sitebtn lbtn" type="button"><span id="lmName"></span><svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        <div id="liveMenu" class="menu lmenu" hidden>
          <div class="lm-top"><input id="lmq" class="find" type="search" placeholder="搜直播源" autocomplete="off"></div>
          <div class="lm-bar" id="lmBar" hidden><span id="lmSelN"></span><i></i>
            <button class="small" data-lm="all">全选</button><button class="small dng" data-lm="delsel">删除</button><button class="small" data-lm="clear">取消</button></div>
          <div class="lm-list" id="llist"></div>
          <div class="lm-foot"><span id="lmCount" class="lan"></span><a href="#/settings" class="lan"><u>在设置里管理</u></a></div>
        </div></div>
      <input id="chq" class="find" type="search" placeholder="搜频道"></div>
      <div id="liveBody"></div></div>`;
    $('#liveBtn').onclick = async e => {
      e.stopPropagation();
      const m = $('#liveMenu'); m.hidden = !m.hidden; $('#liveBtn').classList.toggle('open', !m.hidden);
      if (!m.hidden) { lmRender(); await lmRefresh().catch(() => {}); lmRender(); $('.lpr.on', m)?.scrollIntoView({ block: 'nearest' }); }
    };
    $('#lmq').oninput = e => { lm.q = e.target.value.trim(); lm.sel.clear(); lmRender(); };
    $('#lmBar').onclick = e => { const b = e.target.closest('[data-lm]'); if (b) lmOp(b.dataset.lm); };
    $('#liveMenu').onclick = e => {
      const del = e.target.closest('[data-del]');
      if (del) {
        e.stopPropagation();
        const k = del.dataset.del, l = state.lives.find(x => x.key === k); if (!l) return;
        if (confirm(`删除直播源「${l.name}」？`)) lmSave(lives => lives.filter((_, i) => i !== Number(k))).then(() => toast(`已删除「${l.name}」`), err => toast(err.message));
        return;
      }
      const row = e.target.closest('.lpr'); if (!row) return;
      if (e.target.closest('.lck')) {                 // the tick box: select only, never switches source
        const k = row.dataset.k, on = e.target.closest('.lck').querySelector('input');
        if (e.target !== on) return;                  // the label forwards its click to the input: handle it once
        on.checked ? lm.sel.add(k) : lm.sel.delete(k);
        row.classList.toggle('sel', on.checked);
        return lmSelUI();
      }
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
// "played before" / "just failed" are remembered, and one preview exists at a time.
const lpvSeen = new Set(), lpvFail = new Map();
// Two animations on purpose: the shape grows with a soft start and a long settle, the fade-in is short and independent of it.
const LPV_GROW = { duration: 440, easing: 'cubic-bezier(.32,.72,0,1)', fill: 'forwards' };
const LPV_FADE = { duration: 180, easing: 'ease-out', fill: 'forwards' };
let lpv = null;
function startLocalPreview(el, url, box = el) {
  if (!url || !matchMedia('(hover: hover) and (pointer: fine)').matches) return;
  if (Date.now() - (lpvFail.get(url) || 0) < 90e3) return;
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
      lpvFail.set(url, Date.now()); if (lpvFail.size > 300) lpvFail.delete(lpvFail.keys().next().value);
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

// ---------- settings ----------
let installEvt = null;
addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; });
addEventListener('appinstalled', () => { installEvt = null; });
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone;
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
async function renderSettings() {
  const localP = get('/api/local'); // sent together with the rest, so it never queues behind speed tests
  localP.catch(() => {});
  const [cfg, info, safety] = await Promise.all([get('/api/config'), get('/api/info').catch(() => ({ urls: [] })), get('/api/safety')]);
  const flags = x => `<label class="flag"><input type="checkbox" class="kids" ${x.kids ? 'checked' : ''}>少儿</label><label class="flag"><input type="checkbox" class="adult" ${x.adult ? 'checked' : ''}>成人</label>`;
  const cacheOf = x => testCache.get(String(x.api || x.url || '').trim());
  const stOf = x => { const t = cacheOf(x); return t ? `<span class="${t.cls}" title="${esc(t.title)}">${esc(t.text)}</span>` : '<span class="status"></span>'; };
  const dragH = '<span class="drag" title="按住拖动排序">⋮⋮</span>';
  const rowHtml = (x, kind, i, parent) => x.members ? `<div class="srow grp" data-i="${i}" ${x.keep ? 'data-keep="1"' : ''} data-key="${esc(x.key)}" data-members="${esc(JSON.stringify(x.members))}">
      <label class="selcell">${dragH}<input type="checkbox" class="sel"><span class="lan">${i + 1}</span></label>
      <input class="nm" value="${esc(x.name)}" placeholder="名称">
      <input class="url" value="" readonly>
      <span class="ops"><span class="tagl">聚合源</span>${flags(x)}<button data-op="toggle"></button><button data-op="dissolve" title="解散：成员回到主列表，聚合源删除">解散</button><button data-op="up">↑</button><button data-op="down">↓</button><button data-op="del" title="删除聚合源和它的所有成员">删除</button></span></div>`
    : `<div class="srow${parent ? ' mem' : ''}" data-i="${i}" ${parent ? `data-parent="${esc(parent)}" hidden` : ''} ${x.key && kind === 'site' ? `data-key="${esc(x.key)}"` : ''} ${x.from ? `data-from="${esc(x.from)}"` : ''} ${x.categories ? `data-cats="${esc(JSON.stringify(x.categories))}"` : ''} ${cacheOf(x) ? `data-ok="${cacheOf(x).cls === 'status ok' ? 1 : 0}"${cacheOf(x).total !== undefined ? ` data-total="${cacheOf(x).total}"` : ''}` : ''}>
      <label class="selcell">${dragH}<input type="checkbox" class="sel"><span class="lan">${i + 1}</span></label>
      <input class="nm" value="${esc(x.name)}" placeholder="名称">
      <input class="url" value="${esc(kind === 'site' ? x.api : x.url)}" placeholder="${kind === 'site' ? 'https://example.com/api.php/provide/vod' : 'https://…/live.m3u / .m3u8 / .txt'}">
      <span class="ops">${kind === 'site' ? `${flags(x)}${stOf(x)}<button data-op="test">测速</button><button data-op="release" class="rel" title="移出聚合源，回到主列表">释放</button>` : `${String(x.url).startsWith('local:') ? '<span class="tagl">本地文本</span>' : ''}${stOf(x)}<button data-op="test">测速</button><button data-op="edit">编辑文本</button>`}
        <button data-op="up">↑</button><button data-op="down">↓</button><button data-op="del">删除</button></span></div>`;
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
      <button class="small" data-bulk="delbad">删除不通的</button>${kind === 'site' ? '<button class="small" data-bulk="delempty" title="删除能连上、但一部片都没有的点播源">删除 0 部的</button>' : ''}<button class="small" data-bulk="retry">重测不通的</button><button class="small" data-bulk="export">导出选中</button>
      <button class="small" data-bulk="merge" title="${kind === 'live' ? '把选中的直播源合成一个频道列表（同分组归并、相同地址去重）' : '把选中的点播源聚合成一个入口：搜索/浏览/播放线路同时覆盖所有成员，同名影片合并'}">${kind === 'live' ? '合并选中' : '聚合选中'}</button><span class="lan" data-bulk="count"></span></div>`;
  view.innerHTML = `<div class="page set"><h1>设置</h1>
    <p class="lan">修改保存在服务端，局域网里所有浏览器共享。${info.urls.length ? '其他设备打开：' + info.urls.map(u => `<code>${esc(u)}</code>`).join(' ') : ''}</p>
    ${installSection()}
    <section><h2>安全级别</h2><p class="hint">儿童：只显示勾了「少儿」的源，关闭直播和豆瓣热门；标准：隐藏勾了「成人」的源以及伦理/写真等分类；全部：不过滤。${safety.hasPin ? '已设家长 PIN。' : '可设家长 PIN，防止孩子自己改回来。'}</p>
      <div class="seg big">${Object.entries(LEVELS).map(([k, v]) => `<button data-level="${k}" class="${k === safety.level ? 'on' : ''}">${v}</button>`).join('')}</div>
    </section>
    <section><h2>封面卡片</h2><p class="hint">竖版：2:3 海报；宽卡：16:9，一屏能放更多标题，详情页和首页大图同步变成宽版。也可以点右上角的卡片图标快速切换。</p>
      <div class="seg big"><button data-cardmode="poster" class="${cardMode() === 'poster' ? 'on' : ''}">竖版海报</button><button data-cardmode="wide" class="${cardMode() === 'wide' ? 'on' : ''}">宽卡</button></div>
      <div class="actions"><button class="small" id="setPin">${safety.hasPin ? '修改 / 清除 PIN' : '设置 PIN'}</button></div></section>
    ${safety.level === 'kids' ? '' : `<section><h2>首页豆瓣分类</h2><p class="hint">在点播首页显示豆瓣热门榜单，只影响这个浏览器。儿童模式下不显示；本地媒体源也不显示。</p>
      <div class="field">${DB_ROWS.map(([k, t]) => `<label class="flag"><input type="checkbox" data-dbrow="${k}" ${dbRows()[k] ? 'checked' : ''}>${esc(t.replace('豆瓣热门', ''))}</label>`).join('')}</div></section>`}
    <section><h2>点播源</h2><p class="hint">苹果CMS 接口（<code>…/api.php/provide/vod</code>，返回 JSON）。需要 spider jar / 解析的 type 3 源浏览器跑不了，导入时会自动跳过。</p>
      ${fold('site', cfg.sites.length)}<div class="foldbox" data-fold="site" ${cfg.sites.length > FOLD_AT && !foldOpen.site ? 'hidden' : ''}>${bulk('site')}<div id="sites">${siteRowsHtml()}</div></div>
      <div class="actions"><button class="small" id="addSite">+ 添加点播源</button><button class="small" id="testAll">全部测速</button><button class="small" id="stopTest">停止测速</button></div></section>
    <section id="localSec"><h2>本地媒体 <span class="tagl">内置源</span></h2><p class="lan">加载中…</p></section>
    <section><h2>直播源</h2><p class="hint">支持 m3u / m3u8 频道列表、TVBox txt（<code>频道名,地址</code> + <code>分组,#genre#</code>），或者单条 .m3u8 播放地址。内置文件直接写文件名。「编辑文本」可以直接改频道列表。</p>
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
      <div class="actions"><button class="small" id="saveRaw">保存 JSON</button><button class="small" id="reset">恢复默认</button></div></section></div>`;

  const collect = (box, kind) => $$('.srow', box).map(r => {
    const name = $('.nm', r).value.trim(), url = $('.url', r).value.trim();
    if (r.dataset.members) return { key: r.dataset.key, name: name || r.dataset.key, type: 1, members: JSON.parse(r.dataset.members), api: 'group', ...($('.kids', r).checked ? { kids: 1 } : {}), ...($('.adult', r).checked ? { adult: 1 } : {}) };
    if (kind !== 'site') return { name: name || url, url, ...(r.dataset.from ? { from: r.dataset.from } : {}) };
    const s = { key: r.dataset.key || name || url, name: name || url, type: 1, api: url };
    if ($('.kids', r).checked) s.kids = 1;
    if ($('.adult', r).checked) s.adult = 1;
    if (r.dataset.cats) s.categories = JSON.parse(r.dataset.cats);
    return s;
  }).filter(x => (x.api || x.url));
  const current = () => ({ sites: collect($('#sites'), 'site'), lives: collect($('#lives'), 'live') });
  const dirty = () => { const d = $('#dirty'); if (d) d.textContent = '有未保存的修改'; };
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
    if (rerender) return renderSettings();
    // The server de-duplicates by link and may rename keys: drop rows it removed, keep every other row untouched.
    const keep = new Set((j.sites || []).map(x => x.key));
    $$('#sites .srow[data-key]').forEach(r => { if (!keep.has(r.dataset.key)) r.remove(); });
    renumber(); refreshCount();
    const d = $('#dirty'); if (d) d.textContent = '';
    const raw = $('#raw'); if (raw) raw.value = JSON.stringify(j, null, 2);
  };
  // Speed test: bounded concurrency (so hundreds of sources don't flood the network), auto retry on failure,
  // results cached per url so they survive deleting / reordering / re-rendering.
  const RETRIES = 2;
  let testGen = 0;
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
  };
  const test = async (r, gen = testGen) => {
    const st = $('.status', r), url = $('.url', r).value.trim(), live = r.parentElement.id === 'lives';
    if (!url || r.dataset.members) return;
    const stale = () => gen !== testGen || !r.isConnected;
    if (stale()) return restoreRow(r);
    st.className = 'status'; st.textContent = '测试中…';
    let res;
    for (let k = 0; k <= RETRIES; k++) {
      if (stale()) return restoreRow(r);
      if (k) { st.textContent = `重试 ${k}/${RETRIES}…`; await new Promise(ok => setTimeout(ok, 600 * k)); if (stale()) return restoreRow(r); }
      res = await testOnce(url, $('.nm', r).value.trim(), live);
      if (res.ok) break;
    }
    if (stale()) return restoreRow(r);
    const cls = 'status ' + (res.ok ? 'ok' : 'bad');
    st.className = cls; st.textContent = res.text; st.title = res.title;
    r.dataset.ok = res.ok ? '1' : '0';
    if (res.total !== undefined) r.dataset.total = res.total; else delete r.dataset.total;
    testCache.set(url, { cls, text: res.text, title: res.title, total: res.total });
  };
  // One pool for sites and lives together: at most 4 requests in flight, so page loads and /api/local are never starved
  // (browsers allow only 6 connections per host). Entries from an older generation drain instantly (test() bails out).
  const TEST_MAX = 4, testQ = []; let testRun = 0;
  const pump = () => {
    while (testRun < TEST_MAX && testQ.length) {
      const { r, gen, done } = testQ.shift(); testRun++;
      test(r, gen).catch(() => {}).finally(() => { testRun--; done(); pump(); });
    }
  };
  // Every row of the run says 排队中 right away; the pool turns them into 测试中… four at a time.
  const testMany = rows => Promise.all(rows.map(r => new Promise(done => {
    const st = $('.status', r);
    if (st && $('.url', r).value.trim() && !r.dataset.members) { st.className = 'status'; st.textContent = '排队中'; st.title = ''; }
    testQ.push({ r, gen: testGen, done }); pump();
  })));
  const editText = async r => {
    let url = $('.url', r).value.trim();
    const name = $('.nm', r).value.trim() || url;
    // On this machine the list opens in VS Code (a real editor); other devices get the in-page text box below.
    if ((await infoP()).loopback) {
      try {
        const j = await req('POST', '/api/live/edit', { url });
        if (!url.startsWith('local:')) { r.dataset.from = url; $('.url', r).value = url = j.url; await persist(current()); }
        if (j.ok) return toast('已在 VS Code 打开，保存文件即生效（频道列表每次都从这个文件读）');
        toast(j.error + '，改用网页里的编辑框');
      } catch (err) { toast(err.message); }
    }
    const m = document.createElement('div');
    m.className = 'modal'; m.id = 'textModal';
    m.innerHTML = `<div class="sheet editor"><div class="body"><h3>编辑「${esc(name)}」<span class="lan" id="chCount"></span></h3>
      <p class="hint">m3u（<code>#EXTINF:-1 group-title="分组" tvg-logo="…",频道名</code> 下一行写地址）或 TVBox txt（<code>分组,#genre#</code> / <code>频道名,地址</code>）。保存后存成服务端本地文件，不再拉原地址。</p>
      <textarea id="liveText" spellcheck="false">加载中…</textarea>
      <div class="actions"><button class="btn red" id="ltSave">保存</button><button class="small" id="ltCancel">取消</button></div></div></div>`;
    document.body.append(m); document.body.style.overflow = 'hidden';
    const close = () => { m.remove(); document.body.style.overflow = ''; };
    m.onclick = e => { if (e.target === m) close(); };
    $('#ltCancel').onclick = close;
    const j = await api('live/raw', { url }).catch(e => ({ text: '', error: e.message }));
    const ta = $('#liveText');
    ta.value = j.text || '#EXTM3U\n#EXTINF:-1 group-title="我的频道",频道名\nhttps://example.com/live.m3u8\n';
    const count = () => { $('#chCount').textContent = `${(ta.value.match(/^#EXTINF/gm) || []).length || ta.value.split('\n').filter(l => /,https?:\/\//.test(l)).length} 个频道`; };
    ta.oninput = count; count();
    $('#ltSave').onclick = async () => {
      try {
        const out = await req('PUT', '/api/live/raw', { url, text: ta.value });
        if (!url.startsWith('local:')) { r.dataset.from = url; $('.url', r).value = out.url; }
        close();
        await persist(current());
      } catch (err) { toast(err.message); }
    };
  };
  view.onclick = async e => {
    const cm = e.target.dataset.cardmode;
    if (cm) return setCardMode(cm);
    const lv = e.target.dataset.level;
    if (lv) {
      try { await req('POST', '/api/safety', { level: lv, pin: sessionStorage.pin || '' }); state.cats = []; await loadSites(); toast('安全级别：' + LEVELS[lv]); renderSettings(); }
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
    if (op === 'test') { testGen++; return test(r); }
    if (op === 'edit') return editText(r);
    if (op === 'del') return dropRows([r]);
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
      const sites = siteRows.map(r => {
        const s = { key: r.dataset.key || undefined, name: $('.nm', r).value.trim(), api: $('.url', r).value.trim() };
        if ($('.kids', r).checked) s.kids = 1;
        if ($('.adult', r).checked) s.adult = 1;
        if (r.dataset.cats) s.categories = JSON.parse(r.dataset.cats);
        return s;
      }).filter(s => s.api);
      const lives = [];
      for (const r of liveRows) {
        const l = { name: $('.nm', r).value.trim(), url: $('.url', r).value.trim() };
        if (!l.url) continue;
        if (!/^https?:\/\//.test(l.url)) {
          const j = await api('live/raw', { url: l.url });
          if (!j.text) continue;
          lives.push({ name: l.name, text: j.text });
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
    if (op === 'retry') {
      const bad = rows.filter(r => r.dataset.ok === '0');
      if (!bad.length) return toast('没有不通的源');
      testGen++; return testMany(bad);
    }
    if (op === 'delbad') {
      const todo = rows.filter(r => !r.dataset.ok && !r.dataset.members && $('.url', r).value.trim());
      if (todo.length) { toast(`还有 ${todo.length} 个没测过，先测速…`); testGen++; await testMany(todo); }
      const bad = $$('.srow', box).filter(r => r.dataset.ok === '0');
      if (!bad.length) return toast('没有不通的源');
      if (confirm(`删除 ${bad.length} 个不通的源？（已自动重试 ${RETRIES} 次；点「保存」后生效）`)) dropRows(bad);
      return;
    }
    if (op === 'delempty') {
      const todo = rows.filter(r => r.dataset.ok === undefined && !r.dataset.members && !r.dataset.cats && $('.url', r).value.trim());
      if (todo.length) { toast(`还有 ${todo.length} 个没测过，先测速…`); testGen++; await testMany(todo); }
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
  view.oninput = e => { if (e.target.closest('.srow:not(.lrow)')) dirty(); };
  view.onchange = e => { if (e.target.closest('.srow:not(.lrow)')) dirty(); };
  $('#setPin').onclick = async () => {
    const newPin = prompt(safety.hasPin ? '新 PIN（留空 = 清除 PIN）' : '设置家长 PIN（4 位以上数字）');
    if (newPin === null) return;
    try { await req('POST', '/api/safety', { pin: sessionStorage.pin || '', newPin }); sessionStorage.pin = newPin; toast(newPin ? 'PIN 已设置' : 'PIN 已清除'); renderSettings(); }
    catch (err) { toast(err.message); }
  };
  if ($('#installBtn')) $('#installBtn').onclick = async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice.catch(() => {}); installEvt = null; $('#installBtn').hidden = true; };
  $('#addSite').onclick = () => $('.nm', addRow('site', { name: '', api: '' })).focus();
  $('#addLive').onclick = () => $('.nm', addRow('live', { name: '', url: '' })).focus();
  $('#testAll').onclick = () => { testGen++; testMany($$('#sites .srow')); };
  $('#testLives').onclick = () => { testGen++; testMany($$('#lives .srow')); };
  $('#stopTest').onclick = () => { testGen++; $$('.srow').forEach(r => { if (/测试中|重试|排队/.test($('.status', r)?.textContent || '')) restoreRow(r); }); };
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
        if (y < top + edge * .4) scrollBy(0, -14); else if (y > innerHeight - edge) scrollBy(0, 14);
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
  renumber(); refreshCount();
  $('#save').onclick = () => persist(current()).catch(err => toast(err.message));
  $('#saveRaw').onclick = () => { let c; try { c = JSON.parse($('#raw').value); } catch { return toast('JSON 格式不对'); } persist(c, true).catch(err => toast(err.message)); };
  $('#reset').onclick = async () => {
    if (!confirm('恢复成内置的默认源？')) return;
    try { await req('POST', '/api/config/reset', {}); await loadSites(); toast('已恢复默认'); renderSettings(); } catch (err) { toast(err.message); }
  };
  $('#exportAll').onclick = () => exportSources($$('#sites .srow'), $$('#lives .srow'));
  $('#clipGo').onclick = () => { const t = $('#clipText').value.trim(); if (t) recognizeFlow(t); };
  $('#clipRead').onclick = async () => {
    try { const t = await navigator.clipboard.readText(); $('#clipText').value = t; if (t.trim()) recognizeFlow(t); }
    catch { toast('浏览器不让直接读剪贴板（局域网 http 页面的限制），请在框里粘贴'); $('#clipText').focus(); }
  };
  $('#imp').onclick = async () => {
    const url = $('#impUrl').value.trim(); if (!url) return;
    $('#imp').disabled = true; $('#imp').textContent = '导入中…';
    try {
      const j = await req('POST', '/api/config/import', { url, replace: $('#impReplace').checked });
      await loadSites(); toast(`导入 ${j.imported.sites} 个点播源、${j.imported.lives} 个直播源${j.imported.skippedEmpty ? `（跳过 ${j.imported.skippedEmpty} 个 0 部内容的）` : ''}`); renderSettings();
    } catch (err) { toast('导入失败：' + err.message); $('#imp').disabled = false; $('#imp').textContent = '导入'; }
  };
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
      ${j.urls.length ? `<p class="hint" style="margin-top:12px">电视上的 TVBox / FongMi 也能直接用：添加点播源，类型 1（苹果CMS JSON），地址 ${j.urls.map(u => `<code>${esc(u)}</code>`).join(' 或 ')}。电视端直接播原文件。</p>` : ''}`;
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

document.addEventListener('paste', e => {
  if (e.target instanceof Element && e.target.closest('input, textarea, [contenteditable]')) return;
  const t = e.clipboardData?.getData('text') || '';
  if (looksLikeSource(t)) { e.preventDefault(); recognizeFlow(t, true); }
});
addEventListener('focus', async () => {
  try {
    const p = await navigator.permissions.query({ name: 'clipboard-read' });
    if (p.state !== 'granted') return;
    const t = await navigator.clipboard.readText();
    if (!looksLikeSource(t) || localStorage.clipSeen === clipKey(t)) return;
    localStorage.clipSeen = clipKey(t);
    recognizeFlow(t, true);
  } catch {}
});

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.cssText = 'position:fixed;top:0;opacity:0'; document.body.append(ta); ta.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch {}
  ta.remove(); return ok;
}

async function recognizeFlow(text, quiet) {
  if ($('#clipModal')) return;
  localStorage.clipSeen = clipKey(text);
  const m = document.createElement('div');
  m.className = 'modal'; m.id = 'clipModal';
  m.innerHTML = `<div class="sheet editor"><div class="body"><h3>识别剪贴板</h3><div class="spinner"></div><p class="lan" style="text-align:center">逐个打开链接确认类型…</p></div></div>`;
  document.body.append(m); document.body.style.overflow = 'hidden';
  const close = () => { m.remove(); if (!$('#modal')) document.body.style.overflow = ''; };
  m.onclick = e => { if (e.target === m) close(); };
  let r;
  try { r = await req('POST', '/api/recognize', { text }); } catch (e) { close(); return toast('识别失败：' + e.message); }
  const all = [...r.sites.map(x => ({ ...x, kind: 'site' })), ...r.lives.map(x => ({ ...x, kind: 'live' }))];
  const fresh = all.filter(x => !x.exists);
  if (!all.length) { close(); return toast(r.unknown.length ? `剪贴板里 ${r.unknown.length} 个链接都不是点播/直播源` : '剪贴板里没识别到点播/直播源'); }
  if (!fresh.length) { close(); return toast(`识别到 ${all.length} 个源，都已存在`); }
  const rowHtml = (x, i) => `<label class="crow ${x.exists ? 'dim' : ''}">
      <input type="checkbox" data-i="${i}" ${x.exists ? 'disabled' : x.ok === false ? '' : 'checked'}>
      <input class="cname" data-i="${i}" value="${esc(x.name)}" ${x.exists ? 'disabled' : ''}>
      <span class="curl">${esc(x.kind === 'site' ? x.api : x.url || '粘贴的频道列表（存成本地文本）')}</span>
      <span class="cstat ${x.exists ? '' : x.ok === true ? 'ok' : x.ok === false ? 'bad' : ''}">${x.exists ? '已存在' : esc(x.info || (x.ok === false ? '不通' : '未验证'))}</span></label>`;
  const section = (title, kind) => {
    const items = all.map((x, i) => [x, i]).filter(([x]) => x.kind === kind);
    return items.length ? `<h4>${title} · 新 ${items.filter(([x]) => !x.exists).length} / 共 ${items.length}</h4>${items.map(([x, i]) => rowHtml(x, i)).join('')}` : '';
  };
  m.firstChild.innerHTML = `<div class="body"><h3>剪贴板里识别到 ${all.length} 个源</h3>
    <p class="hint">已存在的自动去重，不会再加。不通的默认不勾。名称可以直接改。</p>
    ${section('点播源', 'site')}${section('直播源', 'live')}
    ${r.unknown.length ? `<details class="lan"><summary>${r.unknown.length} 个链接没认出来</summary>${r.unknown.map(u => `<div class="curl">${esc(u)}</div>`).join('')}</details>` : ''}
    <div class="actions"><button class="btn red" id="clipAdd"></button><button class="small" id="clipCancel">取消</button></div></div>`;
  const count = () => { const n = $$('input[type=checkbox]:checked', m).length; $('#clipAdd').textContent = n ? `添加选中的 ${n} 个` : '没有选中'; $('#clipAdd').disabled = !n; };
  m.onchange = count; count();
  $('#clipCancel').onclick = close;
  $('#clipAdd').onclick = async () => {
    const pick = $$('input[type=checkbox]:checked', m).map(c => { const x = all[+c.dataset.i]; return { ...x, name: $(`.cname[data-i="${c.dataset.i}"]`, m).value.trim() || x.name }; });
    try {
      const j = await req('POST', '/api/config/add', { sites: pick.filter(x => x.kind === 'site'), lives: pick.filter(x => x.kind === 'live') });
      close(); await loadSites();
      toast(`已添加 ${j.added.sites} 个点播源、${j.added.lives} 个直播源${j.added.skippedEmpty ? `（跳过 ${j.added.skippedEmpty} 个 0 部内容的）` : ''}`);
      if (location.hash.startsWith('#/settings')) renderSettings();
    } catch (e) { toast(e.message); }
  };
}

loadSites().then(() => route({ nav: true }), e => { view.innerHTML = `<div class="page"><div class="err">连不上服务：${esc(e.message)}</div></div>`; });

$('#cardBtn').onclick = () => setCardMode(cardMode() === 'wide' ? 'poster' : 'wide');
applyCardMode();

setInterval(() => { if (cur?.kind === 'vod' && !player.hidden && state.downloads.some(j => ACTIVE.includes(j.status))) refreshDownloads().then(paintVodActs); }, 2000);
