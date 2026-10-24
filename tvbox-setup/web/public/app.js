'use strict';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const view = $('#view');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// 豆瓣's image CDN refuses requests without its Referer → go through the server's /img relay.
const img = u => /^https?:\/\/[^/]*doubanio\.com\//.test(u || '') ? '/img?u=' + encodeURIComponent(u) : (u || '');
const bg = url => url ? `background-image:url('${esc(img(url)).replace(/'/g, '%27')}')` : '';
const ROWS = ['国产剧', '韩剧|韩国剧', '欧美剧', '动作片', '喜剧片', '科幻片', '日剧|日本剧', '国产动漫', '日韩动漫', '大陆综艺', '爱情片', '纪录片|记录片'];
const LEVELS = { kids: '儿童', standard: '标准', all: '全部' };

const state = { sites: [], lives: [], level: 'standard', site: localStorage.site || '', cats: [], downloads: [] };

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
const api = (route, params = {}, signal) => get(`/api/${route}?` + new URLSearchParams(params), signal);
function toast(msg) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  document.body.append(t); setTimeout(() => t.remove(), 2600);
}
const spinner = '<div class="spinner"></div>';
const fmtSize = b => b > 1e9 ? (b / 1e9).toFixed(2) + ' GB' : (b / 1e6).toFixed(0) + ' MB';

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
};

// ---------- favorites (hidden in 儿童 mode) ----------
const favs = {
  all: () => JSON.parse(localStorage.favs || '[]'),
  has: (site, id) => favs.all().some(f => f.site === site && f.id === id),
  toggle(d) {
    if (favs.has(d.site, d.id)) { favs.del(d.site, d.id); return false; }
    const { site, siteName, id, name, pic, remarks, year, type } = d;
    localStorage.favs = JSON.stringify([{ site, siteName, id, name, pic, remarks, year, type, at: Date.now() }, ...favs.all()].slice(0, 500));
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
const dbQueue = []; let dbActive = 0;
function dbRate(name, year) {
  const k = name + '|' + (year || '');
  const c = dbCache[k];
  if (c && Date.now() - c.at < 3 * 86400e3) return Promise.resolve(c);
  return new Promise(ok => { dbQueue.push({ name, year, k, ok }); dbPump(); });
}
function dbPump() {
  while (dbActive < 2 && dbQueue.length) {
    const { name, year, k, ok } = dbQueue.shift();
    dbActive++;
    api('douban/rating', { name, year: year || '' }).catch(() => ({ found: false, error: 1 })).then(r => {
      const v = { rate: r.rate || '', id: r.id || '', at: Date.now() };
      if (!r.error) { dbCache[k] = v; localStorage.douban = JSON.stringify(dbCache); }
      ok(v);
    }).finally(() => { dbActive--; dbPump(); });
  }
}
const dbIO = new IntersectionObserver(es => es.forEach(e => {
  if (!e.isIntersecting) return;
  const el = e.target; dbIO.unobserve(el);
  dbRate(el.dataset.n, el.dataset.y).then(r => { if (r.rate) { el.textContent = r.rate; el.hidden = false; } });
}), { rootMargin: '200px' });
function observeRatings(root = document) { $$('.db[data-n]', root).forEach(el => { if (!el.dataset.obs) { el.dataset.obs = 1; dbIO.observe(el); } }); }

// ---------- boot / source picker ----------
async function loadSites() {
  const j = await api('sites', {}, null);
  state.sites = j.sites; state.lives = j.live; state.level = j.level;
  if (!state.sites.some(s => s.key === state.site)) state.site = state.sites[0]?.key || '';
  const cur = state.sites.find(s => s.key === state.site);
  $('#siteName').textContent = cur ? cur.name : '无源';
  $('.picker').hidden = !state.sites.length;
  $('#levelTag').hidden = j.level === 'standard';
  $('[data-nav=favorites]').hidden = j.level === 'kids';
  $('#levelTag').textContent = j.level === 'kids' ? '儿童模式' : '无限制';
  $('#levelTag').className = 'level ' + j.level;
  $('#siteMenu').innerHTML = `<div class="mhead">点播源 · ${state.sites.length}</div>` + state.sites.map(s =>
    `<button data-k="${esc(s.key)}" class="${s.key === state.site ? 'on' : ''}"><span>${esc(s.name)}</span>${s.kids ? '<i>少儿</i>' : ''}</button>`).join('');
}
$('#siteBtn').onclick = e => { e.stopPropagation(); $('#siteMenu').hidden = !$('#siteMenu').hidden; $('#siteBtn').classList.toggle('open', !$('#siteMenu').hidden); };
$('#siteMenu').onclick = e => {
  const b = e.target.closest('button[data-k]'); if (!b) return;
  state.site = localStorage.site = b.dataset.k; state.cats = [];
  closeMenu();
  loadSites(); if (location.hash && location.hash !== '#/') location.hash = '#/'; else route();
};
const closeMenu = () => { $('#siteMenu').hidden = true; $('#siteBtn').classList.remove('open'); };
document.addEventListener('click', e => { if (!e.target.closest('.picker')) closeMenu(); });
$('#searchForm').onsubmit = e => { e.preventDefault(); const q = $('#q').value.trim(); if (q) location.hash = '#/search/' + encodeURIComponent(q); };
addEventListener('scroll', () => $('#top').classList.toggle('solid', scrollY > 30));
addEventListener('hashchange', route);

let heroTimer, pageTimer;
function newPage() {
  pageCtl.abort();
  pageCtl = new AbortController();
  dbQueue.length = 0;
  thumbQueue.length = 0;
  stopPreview();
}
async function route() {
  clearInterval(heroTimer); clearInterval(pageTimer); view.onclick = null;
  newPage();
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
  scrollTo(0, 0);
  try {
    if (page === 'live') return await renderLive();
    if (page === 'settings') return await renderSettings();
    if (page === 'downloads') return await renderDownloads();
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
    if (page === 'cat') return await renderCategory(a, decodeURIComponent(b || ''), decodeURIComponent(c || ''));
    return await renderHome();
  } catch (e) {
    if (isAbort(e)) return;
    view.innerHTML = `<div class="page"><div class="err">加载失败：${esc(e.message)}。右上角换个源试试，或去 <a href="#/settings"><u>设置</u></a> 检查。</div></div>`;
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
  const data = it.douban ? `data-db="${esc(it.name)}"` : `data-site="${esc(it.site)}" data-id="${esc(it.id)}"`;
  const rate = it.douban ? (it.rate ? `<span class="db">${esc(it.rate)}</span>` : '')
    : `<span class="db" hidden data-n="${esc(it.name)}" data-y="${esc(it.year || '')}"></span>`;
  return `<a class="card" href="${esc(href)}" ${data}>${opts.removable ? `<button class="rm" data-rm="${opts.removable}" title="${opts.removable === 'fav' ? '取消收藏' : '从观看历史删除'}" aria-label="删除">✕</button>` : ''}
    <div class="img">${it.pic ? `<img src="${esc(img(it.pic))}" loading="lazy" decoding="async" referrerpolicy="no-referrer" alt="" onload="this.classList.add('ok')" onerror="this.remove()">` : ''}${it.remarks ? `<span class="badge">${esc(it.remarks)}</span>` : ''}${rate}
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
  if (c.dataset.db !== undefined) return openByName(c.dataset.db);
  openDetail(c.dataset.site, c.dataset.id);
});
async function openByName(name) {
  toast(`在所有源里找「${name}」…`);
  const j = await api('search', { wd: name }).catch(() => ({ results: [] }));
  const hit = j.results.find(r => r.name === name);
  if (hit) openDetail(hit.site, hit.id); else location.hash = '#/search/' + encodeURIComponent(name);
}
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
  view.innerHTML = spinner;
  const site = state.site;
  const [latest, cats] = await Promise.all([api('list', { site }),
    state.cats.length ? { categories: state.cats } : api('categories', { site }).catch(() => ({ categories: [] }))]);
  state.cats = cats.categories;
  const sig = pageCtl.signal;
  const cont = hist.all().filter(h => state.sites.some(s => s.key === h.site)).slice(0, 20);
  const favList = favs.all().filter(f => state.sites.some(s => s.key === f.site)).slice(0, 30);
  const kids = state.level === 'kids';
  view.innerHTML = `
    <div class="hero" id="hero"></div>
    <div class="rows">
      ${cont.length ? row('继续观看', cont, '#/history', it => `${it.siteName} · ${it.epName || ''}`,
        { removable: 'hist', extra: '<button class="hclear" data-clear="hist">清空</button>' }) : ''}
      ${!kids && favList.length ? row('我的收藏', favList, '#/favorites', it => it.siteName, { removable: 'fav' }) : ''}
      ${row(kids ? '少儿精选' : '最新更新', latest.list, '#/cat//' + encodeURIComponent(kids ? '少儿精选' : '最新更新'))}
      <div id="dbRows"></div>
      <div id="more"></div>
      ${state.cats.length ? `<section class="row"><h2>全部分类</h2><div class="chips">${state.cats.map(c => `<a class="chip" href="#/cat/${esc(c.id)}/${encodeURIComponent(c.name)}">${esc(c.name)}</a>`).join('')}</div></section>` : ''}
    </div>`;
  hero(latest.list.slice(0, 6));
  observeRatings(view);
  if (!kids) {
    Promise.all(['tv', 'movie'].map(t => api('douban/hot', { type: t }).catch(() => ({ list: [] })))).then(([tv, mv]) => {
      if (sig.aborted || !$('#dbRows')) return;
      $('#dbRows').innerHTML = (tv.list.length ? row('豆瓣热门剧集', tv.list.map(x => ({ ...x, douban: 1 }))) : '')
        + (mv.list.length ? row('豆瓣热门电影', mv.list.map(x => ({ ...x, douban: 1 }))) : '');
    });
  }
  const isWhitelisted = kids || state.cats.length <= 8;
  const wanted = isWhitelisted ? state.cats.slice(0, 8) : ROWS.map(w => state.cats.find(c => w.split('|').includes(c.name))).filter(Boolean);
  const lists = await Promise.all(wanted.map(c => api('list', { site, t: c.id }).catch(() => ({ list: [] }))));
  if (sig.aborted || site !== state.site || !$('#more')) return;
  $('#more').innerHTML = wanted.map((c, i) => lists[i].list.length ? row(c.name, lists[i].list, `#/cat/${c.id}/${encodeURIComponent(c.name)}`) : '').join('');
  observeRatings($('#more'));
}

function hero(items) {
  const el = $('#hero'); if (!el || !items.length) return;
  let i = 0;
  const show = () => {
    const it = items[i];
    el.innerHTML = `<div class="bg" style="${bg(it.pic)}"></div><div class="poster" style="${bg(it.pic)}"></div>
      <div class="info"><h1>${esc(it.name)}</h1>
        <div class="meta"><span class="dbtag" hidden></span>${esc([it.year, it.area, it.type, it.remarks].filter(x => x && x !== '0').join('  ·  '))}</div>
        <p>${esc(it.blurb)}</p>
        <div class="btns"><button class="btn play">▶ 播放</button><button class="btn more">ⓘ 详细信息</button></div></div>
      <div class="dots">${items.map((_, k) => `<i class="${k === i ? 'on' : ''}" data-k="${k}"></i>`).join('')}</div>`;
    el.querySelector('.play').onclick = () => openDetail(it.site, it.id, true);
    el.querySelector('.more').onclick = () => openDetail(it.site, it.id);
    $$('.dots i', el).forEach(d => d.onclick = () => { i = +d.dataset.k; show(); });
    dbRate(it.name, it.year).then(r => { const t = el.querySelector('.dbtag'); if (t && r.rate) { t.textContent = '豆瓣 ' + r.rate; t.hidden = false; } });
  };
  show();
  heroTimer = setInterval(() => { if (!document.hidden && $('#player').hidden && !$('#modal')) { i = (i + 1) % items.length; show(); } }, 8000);
}

// ---------- watch history ----------
function renderHistory() {
  const list = hist.all();
  const names = Object.fromEntries(state.sites.map(s => [s.key, s.name]));
  view.innerHTML = `<div class="page"><div class="pagehead"><h1>观看历史</h1>
      ${list.length ? '<button class="small" data-clear="hist">清空全部</button>' : ''}</div>
    <p class="empty hempty" ${list.length ? 'hidden' : ''}>还没有观看记录。</p>
    ${list.length ? `<div class="grid">${list.map(it => card(it, { removable: 'hist', sub: `${names[it.site] || it.siteName} · ${it.epName || ''}` })).join('')}</div>` : ''}</div>`;
  observeRatings(view);
}
function renderFavorites() {
  if (kidsMode()) { view.innerHTML = '<div class="page"><h1>我的收藏</h1><p class="empty">儿童模式下收藏不可见。</p></div>'; return; }
  const list = favs.all();
  view.innerHTML = `<div class="page"><div class="pagehead"><h1>我的收藏</h1>
      ${list.length ? '<button class="small" data-clear="fav">清空全部</button>' : ''}</div>
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
  view.innerHTML = `<div class="page"><h1>${esc(name || '全部')}${other ? ` <span class="role">${esc(other)}</span>` : ''}</h1><div class="grid" id="grid"></div><div id="tail">${spinner}</div></div>`;
  let pg = 0, count = 1, busy = false;
  const seen = new Set();
  const more = async () => {
    if (busy || pg >= count || !$('#grid')) return;
    busy = true;
    const j = await api('list', { site, t, pg: pg + 1 });
    pg = j.page; count = j.pagecount;
    const fresh = j.list.filter(it => !seen.has(it.id) && seen.add(it.id));
    $('#grid')?.insertAdjacentHTML('beforeend', fresh.map(it => card(it)).join(''));
    if ($('#grid')) observeRatings($('#grid'));
    if (pg >= count && $('#tail')) $('#tail').innerHTML = seen.size ? '' : '<div class="empty">这个分类是空的</div>';
    busy = false;
  };
  await more();
  const sig = pageCtl.signal;
  const io = new IntersectionObserver(es => { if (es[0].isIntersecting) more().catch(() => { busy = false; }); }, { rootMargin: '600px' });
  io.observe($('#tail'));
  sig.addEventListener('abort', () => io.disconnect());
}

// ---------- search (all sources) ----------
async function renderSearch(q) {
  $('#q').value = q;
  view.innerHTML = `<div class="page"><h1>“${esc(q)}”</h1><p class="lan">正在搜索全部 ${state.sites.length} 个源…</p>${spinner}</div>`;
  const j = await api('search', { wd: q });
  const names = Object.fromEntries(state.sites.map(s => [s.key, s.name]));
  const order = Object.fromEntries(state.sites.map((s, i) => [s.key, i]));
  const res = j.results.sort((a, b) => (b.name === q) - (a.name === q) || order[a.site] - order[b.site]);
  view.innerHTML = `<div class="page"><h1>“${esc(q)}”</h1>
    <p class="lan">${state.sites.length} 个源，共 ${res.length} 条${j.failed.length ? `；${esc(j.failed.join(' / '))} 未响应` : ''}</p>
    ${res.length ? `<div class="grid">${res.map(it => card(it, { sub: names[it.site] || it.siteName })).join('')}</div>` : '<div class="empty">没搜到，换个关键词</div>'}</div>`;
  observeRatings(view);
}

// ---------- downloads ----------
async function refreshDownloads(signal) { state.downloads = (await api('downloads', {}, signal).catch(() => ({ jobs: state.downloads }))).jobs; return state.downloads; }
const dlFor = (site, id, url) => state.downloads.find(j => j.site === site && j.vid === id && j.url === url);
async function enqueue(d, line, eps) {
  await req('POST', '/api/downloads', { items: eps.map(i => ({ site: d.site, siteName: d.siteName, id: d.id, name: d.name, pic: d.pic, line, ep: i, epName: d.lines[line].episodes[i].name, url: d.lines[line].episodes[i].url })) });
  await refreshDownloads();
  toast(eps.length > 1 ? `已加入下载：${eps.length} 集` : '已加入下载');
}

async function renderDownloads() {
  const status = { queued: '排队中', downloading: '下载中', done: '已完成', error: '失败', paused: '已暂停' };
  const draw = async () => {
    const j = await api('downloads');
    state.downloads = j.jobs;
    if (!location.hash.startsWith('#/downloads')) return;
    const total = j.jobs.reduce((s, x) => s + (x.bytes || 0), 0);
    view.innerHTML = `<div class="page"><h1>下载</h1>
      <p class="lan">保存在服务端 <code>${esc(j.dir)}</code>，局域网里任何设备都能播放。已用 ${fmtSize(total)}${j.free ? `，磁盘剩余 ${fmtSize(j.free)}` : ''}。</p>
      ${j.jobs.length ? `<div class="dls">${j.jobs.map(x => {
        const pct = x.total ? Math.floor((x.done / x.total) * 100) : 0;
        return `<div class="dl ${x.status}" data-id="${esc(x.id)}">
          <div class="thumb" style="${bg(x.pic)}"></div>
          <div class="dinfo"><div><b>${esc(x.name)}</b> <span>${esc(x.epName)}</span></div>
            <div class="lan">${esc(x.siteName)} · ${status[x.status] || x.status}${['downloading', 'paused'].includes(x.status) ? ` ${pct}%` : ''} · ${fmtSize(x.bytes || 0)}${x.error ? ' · ' + esc(x.error) : ''}</div>
            <div class="bar"><i style="width:${x.status === 'done' ? 100 : pct}%"></i></div></div>
          <div class="dops">
            ${x.status === 'done' ? `<button class="btn play sm" data-op="play">▶ 播放</button><a class="small" href="/dl/${esc(x.id)}/save" download>保存到本机</a>` : ''}
            ${['queued', 'downloading'].includes(x.status) ? '<button class="small" data-op="pause">暂停</button>' : ''}
            ${['paused', 'error'].includes(x.status) ? '<button class="small" data-op="resume">继续</button>' : ''}
            <button class="small" data-op="del">删除</button></div></div>`;
      }).join('')}</div>` : '<p class="empty">还没有下载。打开任意影片，点「⬇ 下载」再选集。</p>'}</div>`;
  };
  await draw();
  view.onclick = async e => {
    const op = e.target.dataset.op; if (!op) return;
    const id = e.target.closest('.dl').dataset.id;
    const x = state.downloads.find(j => j.id === id);
    if (op === 'play') { cur = { kind: 'local', eps: [{ name: x.epName, url: x.play }], ep: 0, title: x.name }; return openPlayer(0); }
    if (op === 'del' && !confirm(`删除「${x.name} ${x.epName}」？`)) return;
    if (op === 'del') await req('DELETE', '/api/downloads?id=' + id);
    else await req('PATCH', `/api/downloads?id=${id}&action=${op}`);
    draw();
  };
  pageTimer = setInterval(() => { if (state.downloads.some(x => ['queued', 'downloading'].includes(x.status))) draw(); }, 2000);
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
  const h0 = hist.get(site, id);
  let line = h0 && d.lines[h0.line] ? h0.line : 0, dlMode = false, alts = null;
  const render = () => {
    const h = hist.get(site, id);
    const eps = d.lines[line]?.episodes || [];
    const resumeIdx = h && h.line === line && eps[h.ep] ? h.ep : 0;
    m.firstChild.innerHTML = `
      <div class="top"><div class="bg" style="${bg(d.pic)}"></div><div class="poster" style="${bg(d.pic)}"></div>
        <button class="close">✕</button>
        <div class="info"><h1>${esc(d.name)}</h1><div class="btns">
          ${eps.length ? `<a class="btn play" data-ep="${resumeIdx}" href="${esc(playHref(site, id, line, resumeIdx))}">▶ ${h && h.line === line ? '继续 ' + esc(eps[resumeIdx].name) : eps.length > 1 ? '播放 ' + esc(eps[0].name) : '播放'}</a>
            <button class="btn more" id="dlToggle">${dlMode ? '✓ 完成' : '⬇ 下载'}</button>` : ''}
          ${kidsMode() ? '' : `<button class="btn more fav ${favs.has(site, id) ? 'on' : ''}" id="favBtn">${favs.has(site, id) ? '✓ 已收藏' : '＋ 收藏'}</button>`}
        </div></div></div>
      <div class="body">
        <div class="metaRow"><a class="dbtag" id="dbtag" hidden target="_blank" rel="noreferrer"></a>
          <a class="tag" data-nav href="#/site/${encodeURIComponent(site)}" title="切换到这个源">${esc(d.siteName)}</a>
          ${d.type ? `<a class="tag cat" data-nav href="#/cat/${encodeURIComponent(d.typeId || '')}/${encodeURIComponent(d.type)}/${encodeURIComponent(site)}" title="看这个分类">${esc(d.type)} ›</a>` : ''}
          ${esc([d.year, d.area, d.lang, d.remarks].filter(x => x && x !== '0').join('  ·  '))}</div>
        ${d.blurb ? `<p class="desc">${esc(d.blurb)}</p>` : ''}
        ${people('导演', 'director', d.directors)}
        ${people('演员', 'actor', d.actors, 16)}
        ${d.lines.length ? `<h3>剧集 <span class="lines">${d.lines.map((l, i) => `<button data-line="${i}" class="${i === line ? 'on' : ''}">${esc(l.name)} (${l.episodes.length})</button>`).join('')}</span>
            ${dlMode ? `<span class="dlhint">点选要下载的集 <button class="small" id="dlAll">全部下载</button></span>` : ''}</h3>
          <div class="eps ${dlMode ? 'dlmode' : ''}">${eps.map((e, i) => {
            const dj = dlFor(site, id, e.url);
            const inner = `${dj ? `<em class="${dj.status}">${dj.status === 'done' ? '✓' : '⬇'}</em>` : ''}${esc(e.name)}`;
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
    $$('[data-dl]', m).forEach(b => b.onclick = () => enqueue(d, line, [+b.dataset.dl]).then(render, e => toast(e.message)));
    if ($('#dlToggle', m)) $('#dlToggle', m).onclick = () => { dlMode = !dlMode; render(); };
    if ($('#favBtn', m)) $('#favBtn', m).onclick = () => { toast(favs.toggle(d) ? '已收藏' : '已取消收藏'); render(); };
    $$('[data-more-people]', m).forEach(b => b.onclick = () => { b.parentElement.classList.add('all'); b.remove(); });
    if ($('#dlAll', m)) $('#dlAll', m).onclick = () => enqueue(d, line, eps.map((_, i) => i)).then(render, e => toast(e.message));
    dbRate(d.name, d.year).then(r => {
      const t = $('#dbtag', m); if (!t || !r.id) return;
      t.textContent = r.rate ? '豆瓣 ' + r.rate : '豆瓣 暂无评分'; t.href = `https://movie.douban.com/subject/${r.id}/`; t.hidden = false;
    });
    paintAlts();
  };
  const paintAlts = () => {
    const box = $('#alts', m); if (!box || !alts) return;
    box.innerHTML = alts.length ? alts.map(a => `<a href="${esc(vodHref(a.site, a.id))}" data-s="${esc(a.site)}" data-i="${esc(a.id)}">${esc(a.siteName)}<small>${esc(a.remarks)}</small></a>`).join('') : '<span class="lan">其他源没有同名的</span>';
    $$('a', box).forEach(b => b.onclick = e => { if (!plainClick(e)) return; e.preventDefault(); openDetail(b.dataset.s, b.dataset.i, false, true); });
  };
  m.refresh = () => refreshDownloads(m.ctl.signal).then(render);
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
  m.ctl?.abort();
  m.remove(); document.body.style.overflow = '';
}
addEventListener('popstate', () => { if (!$('#player').hidden) return closePlayer(); closeDetail(); });

// ---------- player ----------
const player = $('#player'), video = $('#video');
let hls, cur = null, idleTimer;

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
  if (player.hidden) { player.hidden = false; history.pushState({ player: 1 }, ''); document.body.style.overflow = 'hidden'; }
  $('.ptitle').textContent = cur.kind === 'live' ? e.name : (cur.eps.length > 1 ? `${cur.title} · ${e.name}` : cur.title);
  const live = cur.kind === 'live';
  $('[data-act=prev]').textContent = live ? '上一台' : '上一集';
  $('[data-act=next]').textContent = live ? '下一台' : '下一集';
  $('[data-act=list]').textContent = live ? '频道' : '选集';
  $('[data-act=prev]').hidden = cur.ep <= 0;
  $('[data-act=next]').hidden = cur.ep >= cur.eps.length - 1;
  $('[data-act=list]').hidden = cur.eps.length <= 1;
  $('[data-act=star]').hidden = !live;
  if (live) $('[data-act=star]').textContent = liveFavs.has(e.url) ? '★ 已收藏' : '☆ 收藏';
  renderPlist();
  const local = cur.kind === 'vod' ? dlFor(cur.d.site, cur.d.id, e.url) : null;
  const useLocal = cur.kind === 'local' || local?.status === 'done';
  $('.local').hidden = !useLocal;
  load(local?.status === 'done' ? local.play : e.url, startAt, false, useLocal);
  poke();
}
function msg(t) { $('.pmsg').textContent = t || ''; }
function load(url, startAt, viaProxy, isLocal) {
  if (hls) { hls.destroy(); hls = null; }
  const src = viaProxy ? '/hls?u=' + encodeURIComponent(url) : url;
  msg('加载中…');
  const seek = () => { if (startAt) video.currentTime = startAt; video.play().catch(() => msg('点一下播放')); };
  const retry = why => { if (!viaProxy && !isLocal) { msg('直连失败，改走中转…'); load(url, startAt, true); } else msg('播放失败：' + why + '。换一集/换个源试试'); };
  if (window.Hls && Hls.isSupported() && !/\.mp4(\?|$)/i.test(url)) {
    hls = new Hls({ maxBufferLength: 30, enableWorker: true });
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
  hist.put({ site: d.site, siteName: d.siteName, id: d.id, name: d.name, pic: d.pic, remarks: d.remarks, year: d.year,
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
  video.pause(); video.removeAttribute('src'); video.load();
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
  if (act === 'star') { const c = cur.eps[cur.ep]; toast(liveFavs.toggle(c) ? '已收藏' : '已取消收藏'); $('[data-act=star]').textContent = liveFavs.has(c.url) ? '★ 已收藏' : '☆ 收藏'; return; }
  if (!$('.plist').hidden && !e.target.closest('.plist, .pbar')) togglePlist(false);
});
function poke() { player.classList.remove('idle'); clearTimeout(idleTimer); idleTimer = setTimeout(() => !video.paused && $('.plist').hidden && player.classList.add('idle'), 3000); }
player.addEventListener('mousemove', poke); player.addEventListener('touchstart', poke);
addEventListener('keydown', e => {
  if (e.key === 'Escape' && !player.hidden && !$('.plist').hidden) { e.preventDefault(); return togglePlist(false); }
  if (e.target.matches('input, textarea')) return;
  if (e.key === 'Escape' && (!player.hidden || $('#modal'))) history.back();
  if (player.hidden) return;
  if (e.key === ' ') { e.preventDefault(); video.paused ? video.play() : video.pause(); }
  if (e.key === 'ArrowRight') video.currentTime += 10;
  if (e.key === 'ArrowLeft') video.currentTime -= 10;
  if (e.key === 'n' || e.key === 'PageDown') step(1);
  if (e.key === 'p' || e.key === 'PageUp') step(-1);
  if (e.key === 'f') document.fullscreenElement ? document.exitFullscreen() : player.requestFullscreen();
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

async function renderLive() {
  if (!state.lives.length) {
    view.innerHTML = `<div class="page"><h1>直播</h1><p class="empty">${state.level === 'kids' ? '儿童模式下直播已关闭。' : '没有直播源，去 <a href="#/settings"><u>设置</u></a> 添加。'}</p></div>`;
    return;
  }
  const src = state.lives.some(l => l.key === localStorage.live) ? localStorage.live : state.lives[0].key;
  view.innerHTML = `<div class="page"><div class="pagehead"><h1>直播</h1>
    <div class="seg">${state.lives.map(l => `<button data-src="${esc(l.key)}" class="${l.key === src ? 'on' : ''}">${esc(l.name)}</button>`).join('')}</div>
    <input id="chq" class="find" type="search" placeholder="搜频道"></div>
    <div id="liveBody">${spinner}</div></div>`;
  $$('[data-src]').forEach(b => b.onclick = () => { localStorage.live = b.dataset.src; newPage(); renderLive().catch(e => { if (!isAbort(e)) toast(e.message); }); });
  const [{ groups }, info] = await Promise.all([api('live', { src }), infoP()]);
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
async function renderSettings() {
  const [cfg, info, safety] = await Promise.all([get('/api/config'), get('/api/info').catch(() => ({ urls: [] })), get('/api/safety')]);
  const flags = x => `<label class="flag"><input type="checkbox" class="kids" ${x.kids ? 'checked' : ''}>少儿</label><label class="flag"><input type="checkbox" class="adult" ${x.adult ? 'checked' : ''}>成人</label>`;
  const rowsHtml = (list, kind) => list.map((x, i) => `<div class="srow" data-i="${i}" ${x.categories ? `data-cats="${esc(JSON.stringify(x.categories))}"` : ''}>
      <span class="lan">${i + 1}</span>
      <input class="nm" value="${esc(x.name)}" placeholder="名称">
      <input class="url" value="${esc(kind === 'site' ? x.api : x.url)}" placeholder="${kind === 'site' ? 'https://example.com/api.php/provide/vod' : 'https://…/live.m3u / .m3u8 / .txt'}">
      <span class="ops">${kind === 'site' ? `${flags(x)}<span class="status"></span><button data-op="test">测速</button>` : `${String(x.url).startsWith('local:') ? '<span class="tagl">本地文本</span>' : ''}<span class="status"></span><button data-op="test">测速</button><button data-op="edit">编辑文本</button>`}
        <button data-op="up">↑</button><button data-op="down">↓</button><button data-op="del">删除</button></span></div>`).join('');
  view.innerHTML = `<div class="page set"><h1>设置</h1>
    <p class="lan">修改保存在服务端，局域网里所有浏览器共享。${info.urls.length ? '其他设备打开：' + info.urls.map(u => `<code>${esc(u)}</code>`).join(' ') : ''}</p>
    <section><h2>安全级别</h2><p class="hint">儿童：只显示勾了「少儿」的源，关闭直播和豆瓣热门；标准：隐藏勾了「成人」的源以及伦理/写真等分类；全部：不过滤。${safety.hasPin ? '已设家长 PIN。' : '可设家长 PIN，防止孩子自己改回来。'}</p>
      <div class="seg big">${Object.entries(LEVELS).map(([k, v]) => `<button data-level="${k}" class="${k === safety.level ? 'on' : ''}">${v}</button>`).join('')}</div>
      <div class="actions"><button class="small" id="setPin">${safety.hasPin ? '修改 / 清除 PIN' : '设置 PIN'}</button></div></section>
    <section><h2>点播源</h2><p class="hint">苹果CMS 接口（<code>…/api.php/provide/vod</code>，返回 JSON）。需要 spider jar / 解析的 type 3 源浏览器跑不了，导入时会自动跳过。</p>
      <div id="sites">${rowsHtml(cfg.sites, 'site')}</div>
      <div class="actions"><button class="small" id="addSite">+ 添加点播源</button><button class="small" id="testAll">全部测速</button></div></section>
    <section><h2>直播源</h2><p class="hint">支持 m3u / m3u8 频道列表、TVBox txt（<code>频道名,地址</code> + <code>分组,#genre#</code>），或者单条 .m3u8 播放地址。内置文件直接写文件名。「编辑文本」可以直接改频道列表。</p>
      <div id="lives">${rowsHtml(cfg.lives, 'live')}</div>
      <div class="actions"><button class="small" id="addLive">+ 添加直播源</button><button class="small" id="testLives">全部测速</button></div></section>
    <div class="actions savebar"><button class="btn red" id="save">保存</button><span class="lan" id="dirty"></span></div>
    <section><h2>从剪贴板识别</h2><p class="hint">复制一段含源地址的文字（接口地址、m3u/txt 链接、直播流、TVBox 配置 JSON 或整段频道列表都行），在任意页面按 <code>Ctrl/⌘ + V</code>，或者粘到下面。识别后列出新源，确认后去重添加。</p>
      <div class="field"><textarea id="clipText" placeholder="粘贴到这里" style="min-height:110px"></textarea></div>
      <div class="actions"><button class="small" id="clipRead">读取剪贴板</button><button class="small" id="clipGo">识别</button></div></section>
    <section><h2>导入 TVBox 配置</h2><p class="hint">粘贴 TVBox 配置地址（单仓或多仓 <code>{"urls":[…]}</code>），把其中能直连的点播源和直播源合并进来。</p>
      <div class="field"><input id="impUrl" placeholder="https://…/config.json"><label class="lan"><input type="checkbox" id="impReplace"> 替换现有</label><button class="small" id="imp">导入</button></div></section>
    <section><h2>高级：直接编辑 JSON</h2><p class="hint">格式 <code>{"sites":[{"key","name","api","kids","adult","categories"}],"lives":[{"name","url"}]}</code>，可整份复制到别的设备。</p>
      <div class="field"><textarea id="raw" spellcheck="false">${esc(JSON.stringify(cfg, null, 2))}</textarea></div>
      <div class="actions"><button class="small" id="saveRaw">保存 JSON</button><button class="small" id="reset">恢复默认</button></div></section></div>`;

  const collect = (box, kind) => $$('.srow', box).map(r => {
    const name = $('.nm', r).value.trim(), url = $('.url', r).value.trim();
    if (kind !== 'site') return { name: name || url, url, ...(r.dataset.from ? { from: r.dataset.from } : {}) };
    const s = { key: name || url, name: name || url, type: 1, api: url };
    if ($('.kids', r).checked) s.kids = 1;
    if ($('.adult', r).checked) s.adult = 1;
    if (r.dataset.cats) s.categories = JSON.parse(r.dataset.cats);
    return s;
  }).filter(x => (x.api || x.url));
  const current = () => ({ sites: collect($('#sites'), 'site'), lives: collect($('#lives'), 'live') });
  const dirty = () => { $('#dirty').textContent = '有未保存的修改'; };
  const redraw = c => { $('#sites').innerHTML = rowsHtml(c.sites, 'site'); $('#lives').innerHTML = rowsHtml(c.lives, 'live'); dirty(); };
  const persist = async c => {
    await req('PUT', '/api/config', c);
    state.cats = []; await loadSites(); toast('已保存'); renderSettings();
  };
  const test = async r => {
    const st = $('.status', r); st.className = 'status'; st.textContent = '测试中…';
    const url = $('.url', r).value.trim();
    if (r.parentElement.id === 'lives') {
      const j = await api('checklive', { url, name: $('.nm', r).value.trim() }).catch(e => ({ ok: false, error: e.message }));
      st.className = 'status ' + (j.ok ? 'ok' : 'bad');
      st.textContent = j.channels ? `${j.ms}ms · ${j.channels}台 · 抽测${j.alive}/${j.sampled}` : '不通';
      st.title = j.error || '随机抽 8 个频道，能拿到数据的算可连';
      return;
    }
    const j = await api('check', { api: url }).catch(e => ({ ok: false, error: e.message }));
    st.className = 'status ' + (j.ok ? 'ok' : 'bad');
    st.textContent = j.ok ? `${j.ms}ms · ${j.total}部` : '不通';
    st.title = j.error || '';
  };
  const editText = async r => {
    const url = $('.url', r).value.trim(), name = $('.nm', r).value.trim() || url;
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
    const lv = e.target.dataset.level;
    if (lv) {
      try { await req('POST', '/api/safety', { level: lv, pin: sessionStorage.pin || '' }); state.cats = []; await loadSites(); toast('安全级别：' + LEVELS[lv]); renderSettings(); }
      catch (err) { toast(err.message); }
      return;
    }
    const op = e.target.dataset.op; if (!op) return;
    const r = e.target.closest('.srow'), kind = r.parentElement.id === 'sites' ? 'site' : 'live';
    if (op === 'test') return test(r);
    if (op === 'edit') return editText(r);
    const c = current(), list = kind === 'site' ? c.sites : c.lives, i = +r.dataset.i;
    if (op === 'del') list.splice(i, 1);
    if (op === 'up' && i > 0) [list[i - 1], list[i]] = [list[i], list[i - 1]];
    if (op === 'down' && i < list.length - 1) [list[i + 1], list[i]] = [list[i], list[i + 1]];
    redraw(c);
  };
  view.oninput = e => { if (e.target.closest('.srow')) dirty(); };
  view.onchange = e => { if (e.target.closest('.srow')) dirty(); };
  $('#setPin').onclick = async () => {
    const newPin = prompt(safety.hasPin ? '新 PIN（留空 = 清除 PIN）' : '设置家长 PIN（4 位以上数字）');
    if (newPin === null) return;
    try { await req('POST', '/api/safety', { pin: sessionStorage.pin || '', newPin }); sessionStorage.pin = newPin; toast(newPin ? 'PIN 已设置' : 'PIN 已清除'); renderSettings(); }
    catch (err) { toast(err.message); }
  };
  $('#addSite').onclick = () => { const c = current(); c.sites.push({ name: '', api: ' ' }); redraw(c); $('#sites .srow:last-child .nm').focus(); };
  $('#addLive').onclick = () => { const c = current(); c.lives.push({ name: '', url: ' ' }); redraw(c); $('#lives .srow:last-child .nm').focus(); };
  $('#testAll').onclick = () => $$('#sites .srow').forEach(test);
  $('#testLives').onclick = () => $$('#lives .srow').forEach(test);
  $('#save').onclick = () => persist(current()).catch(err => toast(err.message));
  $('#saveRaw').onclick = () => { let c; try { c = JSON.parse($('#raw').value); } catch { return toast('JSON 格式不对'); } persist(c).catch(err => toast(err.message)); };
  $('#reset').onclick = async () => {
    if (!confirm('恢复成内置的默认源？')) return;
    try { await req('POST', '/api/config/reset', {}); await loadSites(); toast('已恢复默认'); renderSettings(); } catch (err) { toast(err.message); }
  };
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
      await loadSites(); toast(`导入 ${j.imported.sites} 个点播源、${j.imported.lives} 个直播源`); renderSettings();
    } catch (err) { toast('导入失败：' + err.message); $('#imp').disabled = false; $('#imp').textContent = '导入'; }
  };
  if (cfg.sites.length) $('#testAll').click();
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
      toast(`已添加 ${j.added.sites} 个点播源、${j.added.lives} 个直播源`);
      if (location.hash.startsWith('#/settings')) renderSettings();
    } catch (e) { toast(e.message); }
  };
}

loadSites().then(route, e => { view.innerHTML = `<div class="page"><div class="err">连不上服务：${esc(e.message)}</div></div>`; });
