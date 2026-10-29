// Service worker：PWA 外壳离线可用 + 冷启动不等网络；/api/sites 和批量接口里的首页数据做 stale-while-revalidate。
// /hls /img /dl /media 永远走网络。所有缓存操作都可能失败（存储空间不足 / 被系统清理 / 缓存损坏）：失败一律退回「直接走网络」，绝不让缓存问题影响页面。
const CACHE = 'tvbox-shell-v89', API_CACHE = 'tvbox-api-v3';
const SHELL = ['./', 'style.css', 'acct.js', 'app.js', 'feed.js', 'vendor/hls.min.js', 'icon.svg', 'icons/icon-192.png'];

// ---------- 过期策略 ----------
// 写入时在响应头里记时间。超过 TTL 的数据不再「先给页面看」（不会冷启动先看到一周前的首页），
// 但留着：网络出错（离线 / 服务挂了）时当兜底，总比白屏好；超过 TTL × GRACE 才真正删除。
const DAY = 864e5, TTL = { sites: 7 * DAY, list: 7 * DAY, categories: 7 * DAY, 'douban/hot': 2 * DAY }, GRACE = 4;
const SWR_MAX = 300;          // 条数上限，超出删最早写入的
const REVAL_MS = 30e3;        // 缓存已全部命中时，后台更新最多等这么久（没人在等它，别挂着）
const REVAL_MIN = 60e3;       // 写入不到这么久的条目不再向服务端确认（连续刷新首页不该每次都打一遍上游）
const AT = 'X-SWR-At';
const jsonHead = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
const jsonRes = text => new Response(text, { headers: jsonHead });
const wrap = text => new Response(text, { headers: { ...jsonHead, [AT]: String(Date.now()) } });
// 写入时间无效（没有 / 在未来很久以后：系统时间被调回过）一律按过期算
const ageOf = res => { const at = Number(res.headers.get(AT)); if (!at) return Infinity; const age = Date.now() - at; return age < -36e5 ? Infinity : age; };
const routeOf = url => { const p = new URL(url).pathname; return p === '/api/sites' ? 'sites' : p.split('/').slice(3).join('/'); };
const openApi = () => caches.open(API_CACHE).catch(() => null);

// 读一条：{ text, fresh } / null（没有、读失败）
async function read(c, key, route) {
  try {
    const m = await c.match(key);
    if (!m) return null;
    const text = await m.text();
    const age = ageOf(m);
    return { text, age, fresh: age <= (TTL[route] || 0) };
  } catch { return null; }
}
// 写一条。存储空间不足（QuotaExceededError）就先腾掉一半最旧的再试一次，还不行就放弃——调用方照常把网络结果交给页面。
async function save(c, key, text) {
  for (let i = 0; i < 2; i++) {
    try { await c.put(key, wrap(text)); return true; }
    catch { if (i) return false; await evict(c, 0.5); }
  }
  return false;
}
async function evict(c, frac) { try { const ks = await c.keys(); for (const k of ks.slice(0, Math.ceil(ks.length * frac))) await c.delete(k); } catch {} }
// 清掉所有 SWR 数据（令牌失效 / 源设置改了 / 安全级别改了）
async function dropAll() { const c = await openApi(); if (!c) return; try { for (const k of await c.keys()) await c.delete(k); } catch {} }
// 删掉彻底过期的，再按条数上限删最早的。最多每 10 分钟做一次。
let pruned = 0;
async function prune(c, force) {
  if (!force && Date.now() - pruned < 6e5) return;
  pruned = Date.now();
  try {
    let ks = await c.keys();
    for (const k of ks) { const m = await c.match(k); if (!m || ageOf(m) > (TTL[routeOf(k.url)] || 0) * GRACE) await c.delete(k); }
    ks = await c.keys();
    for (const k of ks.slice(0, Math.max(0, ks.length - SWR_MAX))) await c.delete(k);
  } catch {}
}
const validJson = t => { try { JSON.parse(t); return true; } catch { return false; } };

// ---------- 外壳 ----------
// The server writes the login state into <html data-auth> of the entry page. Cache it without that attribute,
// so an offline copy never claims a state it can't know (the page then verifies by itself).
// The injected window.__BOOT__ (the /api/sites payload) is dropped too: a cached copy would carry stale sources / safety level.
async function put(cache, req, res) {
  if (/text\/html/.test(res.headers.get('content-type') || '')) {
    const t = (await res.text()).replace(/ data-auth="[^"]*"/, '').replace(/<script>window\.__BOOT__=[^\n]*<\/script>\n?/, '');
    res = new Response(t, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
  return cache.put(req, res);
}
self.addEventListener('install', e => {
  // 预缓存入口页，并顺带缓存它引用的带版本号的 js / css（缓存键含 ?v=，和页面实际请求的 URL 一致）。任何一步失败（包括空间不足）都不能让安装失败。
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    const urls = new Set(SHELL.filter(u => u !== './'));
    try {
      const r = await fetch('./', { cache: 'reload' });
      if (r.ok) {
        const html = await r.clone().text();
        for (const m of html.matchAll(/(?:src|href)="([^"]+\.(?:js|css)(?:\?[^"]*)?)"/g)) urls.add(m[1]);
        await put(c, './', r);
      }
    } catch {}
    await Promise.all([...urls].map(u => fetch(u).then(r => r.ok && put(c, u, r)).catch(() => {})));
  })().catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    try { await Promise.all((await caches.keys()).filter(k => k !== CACHE && k !== API_CACHE).map(k => caches.delete(k))); } catch {}
    const c = await openApi(); if (c) await prune(c, true);
    await self.clients.claim();
  })());
});

// ---------- /api/sites（点播源列表 + 安全级别）：stale-while-revalidate ----------
// 有没过期的缓存：先回它，后台拉最新写回缓存，内容变了就通知页面重新读。
// 没有 / 已过期：走网络；网络失败或服务端出错（5xx）时，退而用过期的缓存。
// 页面明确要最新的（cache: 'no-store'）直接走网络，结果同样写回缓存。401（令牌失效）清掉缓存，不再把旧列表给没登录的人。
async function sitesSWR(e, r) {
  const c = await openApi();
  if (!c) return fetch(r);
  const KEY = '/api/sites', fresh = r.cache === 'no-store' || r.cache === 'reload';
  const old = fresh ? null : await read(c, KEY, 'sites');
  const ok = old && validJson(old.text);
  const usable = ok && old.fresh;
  const net = fetch(r).then(async res => {
    try {
      if (res.status === 401) await dropAll();
      else if (res.ok) {
        const text = await res.clone().text();
        if (validJson(text)) {
          await save(c, KEY, text);
          prune(c);
          if (usable && old.text !== text) (await self.clients.matchAll({ type: 'window' })).forEach(w => w.postMessage({ type: 'sites-updated' }));
        }
      }
    } catch {}
    return res;
  });
  if (usable) { net.catch(() => {}); e.waitUntil(net.catch(() => {})); return jsonRes(old.text); }
  try {
    const res = await net;
    if (res.ok || res.status === 401 || !ok) return res;
  } catch (err) { if (!ok) throw err; }
  return jsonRes(old.text);
}

// ---------- POST /api/batch（首页 / 分类 / 豆瓣的数据都走它）----------
// SW 能拦 POST，只是 Cache API 不能拿 POST 当 key，所以按批里的每个子请求拼一个合成地址
// /__swr/<安全级别>/<route>?<排序后的参数> 当 key，一条一条缓存（只缓存 SWR_ROUTES，详情 / 搜索这类不缓存）。
// 命中且没过期的，先立刻吐一行 {stale:1}（页面马上有内容），再等网络：
//   内容没变 → 什么都不发；
//   变了 → 先写进缓存，再补一行 {fresh:1}（只有信号），页面收到后发一个 cache-first 的 GET /__swr/... 取刚写入的数据，
//          当场更新依赖它的视图。写缓存失败（空间不足）时这行直接带上数据，页面照样能更新；
//   没命中 → 照常转发；
//   网络失败 / 服务端出错 → 有过期的缓存就用它兜底，没有才报错（503）。
const SWR_ROUTES = /^(list|categories|douban\/hot)$/;
const swrKey = (lvl, q) => {
  if (!lvl || !q || typeof q.route !== 'string' || !SWR_ROUTES.test(q.route)) return null;
  const p = new URLSearchParams(q.q && typeof q.q === 'object' ? q.q : {});
  for (const k of p.keys()) if (k.startsWith('pv')) return null;     // 预览页的内容不缓存
  p.sort();
  return new Request(location.origin + '/__swr/' + encodeURIComponent(lvl) + '/' + q.route + '?' + p);
};
async function batchSWR(e, r) {
  let body;
  try { body = await r.clone().json(); } catch { return fetch(r); }
  const reqs = Array.isArray(body.requests) ? body.requests : [], lvl = String(body.lvl || '');
  const keys = reqs.map(q => swrKey(lvl, q));
  if (!keys.some(Boolean)) return fetch(r);
  const c = await openApi();
  if (!c) return fetch(r);
  const hit = [], late = [];             // hit: 没过期，先给页面；late: 过期了，只在网络出错时兜底
  (await Promise.all(keys.map((k, i) => k ? read(c, k, reqs[i].route) : null))).forEach((g, i) => {
    if (!g) return;
    let b; try { b = JSON.parse(g.text); } catch { c.delete(keys[i]).catch(() => {}); return; }   // 缓存损坏：当没有
    (g.fresh ? hit : late)[i] = { text: g.text, body: b, age: g.age };
  });
  const anyHit = hit.some(Boolean), anyLate = late.some(Boolean);
  // 全部命中时没人在等网络，后台更新别挂太久
  const allHit = keys.every((k, i) => k && hit[i]);
  // 只问服务端「需要问」的：没缓存的、过期的、不缓存的路由，以及写入已超过 REVAL_MIN 的。刚写入的不用再确认。
  const need = reqs.map((_, i) => i).filter(i => !(keys[i] && hit[i] && hit[i].age < REVAL_MIN));
  if (!need.length) return pipe(e, c, reqs, keys, hit, late, Promise.resolve(null), null);
  const sub = need.length < reqs.length;
  // 后台更新不能跟着页面走：用户刷新 / 切页会取消页面这边的请求，但这次更新要做完，下次打开才是新的
  const sig = AbortSignal.timeout ? AbortSignal.timeout(allHit ? REVAL_MS : 60e3) : undefined;
  const init = sub ? { method: 'POST', headers: r.headers, credentials: r.credentials, body: JSON.stringify({ ...body, requests: need.map(i => reqs[i]) }) } : null;
  const net = fetch(sub ? new Request(r.url, { ...init, ...(sig ? { signal: sig } : {}) }) : sig ? new Request(r, { signal: sig }) : r);
  net.catch(() => {});
  if (anyHit) return pipe(e, c, reqs, keys, hit, late, net, sub ? need : null);
  // 没有可先给页面的：先看网络
  const res = await net.catch(() => null);
  if (res && res.status === 401) await dropAll();
  if (res && !res.ok && !anyLate) return res;      // 出错且没有兜底：原样交给页面（401 / 429 的登录蒙层逻辑靠它）
  return pipe(e, c, reqs, keys, hit, late, Promise.resolve(res), sub ? need : null);
}
function pipe(e, c, reqs, keys, hit, late, source, map) {
  const enc = new TextEncoder(), dec = new TextDecoder();
  let rd = null, gone = false, finish;
  const done = new Promise(ok => { finish = ok; });
  e.waitUntil(done);
  const stream = new ReadableStream({
    async start(ctl) {
      const send = o => { if (!gone) try { ctl.enqueue(enc.encode(JSON.stringify(o) + '\n')); } catch { gone = true; } };
      const got = new Set();
      const fallback = i => { if (!late[i]) return false; send({ i, status: 200, body: late[i].body, stale: 1 }); return true; };
      try {
        hit.forEach((h, i) => { if (h) send({ i, status: 200, body: h.body, stale: 1 }); });
        let res = null;
        try { res = await source; } catch {}
        if (res && res.status === 401) await dropAll();
        if (res && res.ok && res.body) {
          rd = res.body.getReader();
          let buf = '';
          const line = async t => {
            if (!t) return;
            let m; try { m = JSON.parse(t); } catch { return; }
            if (map) { if (!(m.i in map)) return; m.i = map[m.i]; }   // 只问了一部分：把子请求的序号换回原来的
            const k = keys[m.i];
            got.add(m.i);
            if (!k) return send(m);                                  // 不缓存的路由：原样转发
            if (m.status === 200 && m.body && !m.body.error) {
              const text = JSON.stringify(m.body), saved = await save(c, k, text);
              if (hit[m.i]) {
                if (hit[m.i].text === text) return;                  // 没变化：页面已经是最新的
                return send(saved ? { i: m.i, status: 200, fresh: 1 } : { ...m, fresh: 1 });
              }
              return send(m);
            }
            if (!hit[m.i] && !fallback(m.i)) send(m);                // 出错：有旧内容就留旧内容，没有才把错误交给页面
          };
          for (;;) {
            const { done: end, value } = await rd.read();
            if (end) break;
            buf += dec.decode(value, { stream: true });
            for (let nl; (nl = buf.indexOf('\n')) >= 0;) { await line(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
          }
          await line(buf + dec.decode());
        }
      } catch {}
      // 网络没给的：有过期的缓存就用它，没有就报错
      reqs.forEach((_, i) => { if (!hit[i] && !got.has(i) && !fallback(i)) send({ i, status: 503, body: { error: '连不上服务' } }); });
      try { ctl.close(); } catch {}
      await prune(c);
      finish();
    },
    cancel() { gone = true; }   // 页面走了也把后台更新读完、写进缓存，不取消
  });
  return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' } });
}
// cache-first：只读 SWR 写入的、没过期的数据，不碰网络
async function swrOnly(r) {
  try {
    const c = await openApi();
    const g = c && await read(c, r.url, routeOf(r.url));
    if (g && g.fresh && validJson(g.text)) return jsonRes(g.text);
  } catch {}
  return new Response('', { status: 404 });
}
// 源设置 / 安全级别改了：缓存里的首页数据可能已经不对（比如换了源的 api、调了级别），先清掉再把响应交给页面
const WRITES = /^\/api\/(config|safety|local|classify|recognize)(\/|$)/;
async function afterWrite(r) {
  const res = await fetch(r);
  if (res.ok) await dropAll();
  return res;
}

self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (u.origin !== location.origin) return;
  if (r.method === 'POST' && u.pathname === '/api/batch') { const raw = r.clone(); return e.respondWith(batchSWR(e, r).catch(() => fetch(raw))); }
  if (r.method === 'GET' && u.pathname.startsWith('/__swr/')) return e.respondWith(swrOnly(r));
  if (r.method !== 'GET') { if (WRITES.test(u.pathname)) e.respondWith(afterWrite(r)); return; }
  if (u.pathname === '/api/sites' && !u.search) return e.respondWith(sitesSWR(e, r).catch(() => fetch(r)));
  if (/^\/(api|hls|img|dl|media)\//.test(u.pathname) || r.headers.has('range')) return;
  const nav = r.mode === 'navigate';
  if (nav && u.pathname !== '/' && u.pathname !== '/index.html') return;
  // 外壳：缓存优先 + 后台更新（PWA 冷启动不用等网络，白屏的主因）。带 ?v= 的资源换版本后 URL 变了，自然不会命中旧缓存；入口页晚一次启动生效。
  e.respondWith((async () => {
    let c = null, hit = null;
    try { c = await caches.open(CACHE); hit = nav ? await c.match('./') : await c.match(r); } catch {}
    const net = fetch(r).then(res => { if (res.ok && c) put(c, nav ? './' : r, res.clone()).catch(() => {}); return res; });
    if (hit) { net.catch(() => {}); e.waitUntil(net.catch(() => {})); return hit; }
    return net.catch(async () => (c && await c.match(nav ? './' : r, { ignoreSearch: true }).catch(() => null)) || Response.error());
  })());
});
