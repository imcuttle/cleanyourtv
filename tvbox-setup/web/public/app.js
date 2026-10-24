'use strict';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const view = $('#view');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const bg = url => url ? `background-image:url('${esc(url).replace(/'/g, '%27')}')` : '';
const ROWS = ['国产剧', '韩剧|韩国剧', '欧美剧', '动作片', '喜剧片', '科幻片', '日剧|日本剧', '国产动漫', '日韩动漫', '大陆综艺', '爱情片', '纪录片|记录片'];
const LEVELS = { kids: '儿童', standard: '标准', all: '全部' };

const state = { sites: [], lives: [], level: 'standard', site: localStorage.site || '', cats: [], downloads: [] };

// ---------- http ----------
async function req(method, path, body, retried) {
  const headers = { 'Content-Type': 'application/json' };
  if (sessionStorage.pin) headers['X-Pin'] = sessionStorage.pin;
  const r = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (r.status === 403 && j.pin && !retried) {
    const pin = prompt('需要家长 PIN');
    if (pin === null) throw new Error('已取消');
    sessionStorage.pin = pin;
    if (body && typeof body === 'object' && 'pin' in body) body.pin = pin;
    return req(method, path, body, true);
  }
  if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
const get = path => req('GET', path);
const api = (route, params = {}) => get(`/api/${route}?` + new URLSearchParams(params));
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
  while (dbActive < 3 && dbQueue.length) {
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
  const j = await api('sites');
  state.sites = j.sites; state.lives = j.live; state.level = j.level;
  if (!state.sites.some(s => s.key === state.site)) state.site = state.sites[0]?.key || '';
  const cur = state.sites.find(s => s.key === state.site);
  $('#siteName').textContent = cur ? cur.name : '无源';
  $('.picker').hidden = !state.sites.length;
  $('#levelTag').hidden = j.level === 'standard';
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
async function route() {
  clearInterval(heroTimer); clearInterval(pageTimer); view.onclick = null;
  const [, page, a, b] = location.hash.split('/');
  $$('nav a').forEach(n => n.classList.toggle('on', n.dataset.nav === (page || 'home')));
  scrollTo(0, 0);
  try {
    if (page === 'live') return await renderLive();
    if (page === 'settings') return await renderSettings();
    if (page === 'downloads') return await renderDownloads();
    if (!state.sites.length) return renderNoSites();
    if (page === 'search') return await renderSearch(decodeURIComponent(a || ''));
    if (page === 'cat') return await renderCategory(a, decodeURIComponent(b || ''));
    return await renderHome();
  } catch (e) {
    view.innerHTML = `<div class="page"><div class="err">加载失败：${esc(e.message)}。右上角换个源试试，或去 <a href="#/settings"><u>设置</u></a> 检查。</div></div>`;
  }
}

function renderNoSites() {
  view.innerHTML = `<div class="page"><h1>没有可用的点播源</h1><p class="empty">${state.level === 'kids' ? '当前是儿童模式，只显示标记为「少儿」的源。' : ''}去 <a href="#/settings"><u>设置</u></a> 添加源或调整安全级别。</p></div>`;
}

// ---------- cards & rows ----------
function card(it, opts = {}) {
  const h = it.site && hist.get(it.site, it.id);
  const pct = h && h.dur ? Math.min(100, (h.t / h.dur) * 100) : 0;
  const data = it.douban ? `data-db="${esc(it.name)}"` : `data-site="${esc(it.site)}" data-id="${esc(it.id)}"`;
  const rate = it.douban ? (it.rate ? `<span class="db">${esc(it.rate)}</span>` : '')
    : `<span class="db" hidden data-n="${esc(it.name)}" data-y="${esc(it.year || '')}"></span>`;
  return `<a class="card" href="javascript:" ${data}>
    <div class="img">${it.pic ? `<img src="${esc(it.pic)}" loading="lazy" decoding="async" referrerpolicy="no-referrer" alt="" onload="this.classList.add('ok')" onerror="this.remove()">` : ''}${it.remarks ? `<span class="badge">${esc(it.remarks)}</span>` : ''}${rate}
      ${pct ? `<div class="prog" style="width:${pct}%"></div>` : ''}</div>
    <div class="name">${esc(it.name)}</div>${opts.sub ? `<div class="sub">${esc(opts.sub)}</div>` : ''}</a>`;
}
document.addEventListener('click', e => {
  const c = e.target.closest('#view .card'); if (!c) return;
  if (c.dataset.db !== undefined) return openByName(c.dataset.db);
  openDetail(c.dataset.site, c.dataset.id);
});
async function openByName(name) {
  toast(`在所有源里找「${name}」…`);
  const j = await api('search', { wd: name }).catch(() => ({ results: [] }));
  const hit = j.results.find(r => r.name === name);
  if (hit) openDetail(hit.site, hit.id); else location.hash = '#/search/' + encodeURIComponent(name);
}
function row(title, items, href, sub) {
  return `<section class="row"><h2>${href ? `<a href="${href}">${esc(title)}</a>` : esc(title)}</h2>
    <div class="track"><button class="arrow l">‹</button>
    <div class="scroller">${items.map(it => card(it, { sub: sub?.(it) })).join('')}</div>
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
  const cont = hist.all().filter(h => state.sites.some(s => s.key === h.site)).slice(0, 20);
  const kids = state.level === 'kids';
  view.innerHTML = `
    <div class="hero" id="hero"></div>
    <div class="rows">
      ${cont.length ? row('继续观看', cont, '', it => `${it.siteName} · ${it.epName || ''}`) : ''}
      ${row(kids ? '少儿精选' : '最新更新', latest.list, '#/cat//' + encodeURIComponent(kids ? '少儿精选' : '最新更新'))}
      <div id="dbRows"></div>
      <div id="more"></div>
      ${state.cats.length ? `<section class="row"><h2>全部分类</h2><div class="chips">${state.cats.map(c => `<a class="chip" href="#/cat/${esc(c.id)}/${encodeURIComponent(c.name)}">${esc(c.name)}</a>`).join('')}</div></section>` : ''}
    </div>`;
  hero(latest.list.slice(0, 6));
  observeRatings(view);
  if (!kids) {
    Promise.all(['tv', 'movie'].map(t => api('douban/hot', { type: t }).catch(() => ({ list: [] })))).then(([tv, mv]) => {
      if (!$('#dbRows')) return;
      $('#dbRows').innerHTML = (tv.list.length ? row('豆瓣热门剧集', tv.list.map(x => ({ ...x, douban: 1 }))) : '')
        + (mv.list.length ? row('豆瓣热门电影', mv.list.map(x => ({ ...x, douban: 1 }))) : '');
    });
  }
  const isWhitelisted = kids || state.cats.length <= 8;
  const wanted = isWhitelisted ? state.cats.slice(0, 8) : ROWS.map(w => state.cats.find(c => w.split('|').includes(c.name))).filter(Boolean);
  const lists = await Promise.all(wanted.map(c => api('list', { site, t: c.id }).catch(() => ({ list: [] }))));
  if (site !== state.site || !$('#more')) return;
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

// ---------- category grid (infinite scroll) ----------
async function renderCategory(t, name) {
  view.innerHTML = `<div class="page"><h1>${esc(name || '全部')}</h1><div class="grid" id="grid"></div><div id="tail">${spinner}</div></div>`;
  let pg = 0, count = 1, busy = false;
  const seen = new Set();
  const more = async () => {
    if (busy || pg >= count || !$('#grid')) return;
    busy = true;
    const j = await api('list', { site: state.site, t, pg: pg + 1 });
    pg = j.page; count = j.pagecount;
    const fresh = j.list.filter(it => !seen.has(it.id) && seen.add(it.id));
    $('#grid')?.insertAdjacentHTML('beforeend', fresh.map(it => card(it)).join(''));
    if ($('#grid')) observeRatings($('#grid'));
    if (pg >= count && $('#tail')) $('#tail').innerHTML = seen.size ? '' : '<div class="empty">这个分类是空的</div>';
    busy = false;
  };
  await more();
  const io = new IntersectionObserver(es => { if (es[0].isIntersecting) more().catch(() => { busy = false; }); }, { rootMargin: '600px' });
  io.observe($('#tail'));
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
async function refreshDownloads() { state.downloads = (await api('downloads').catch(() => ({ jobs: [] }))).jobs; return state.downloads; }
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
  document.body.append(m); document.body.style.overflow = 'hidden';
  if (!replace) history.pushState({ modal: 1 }, '');
  let d;
  try { [d] = await Promise.all([api('detail', { site, id }), refreshDownloads()]); }
  catch (e) { m.firstChild.innerHTML = `<button class="close">✕</button><div class="body"><div class="err">详情加载失败：${esc(e.message)}</div></div>`; m.querySelector('.close').onclick = () => history.back(); return; }
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
          ${eps.length ? `<button class="btn play" data-ep="${resumeIdx}">▶ ${h && h.line === line ? '继续 ' + esc(eps[resumeIdx].name) : eps.length > 1 ? '播放 ' + esc(eps[0].name) : '播放'}</button>
            <button class="btn more" id="dlToggle">${dlMode ? '✓ 完成' : '⬇ 下载'}</button>` : ''}
        </div></div></div>
      <div class="body">
        <div class="metaRow"><a class="dbtag" id="dbtag" hidden target="_blank" rel="noreferrer"></a><span class="tag">${esc(d.siteName)}</span>${esc([d.year, d.area, d.type, d.remarks].filter(x => x && x !== '0').join('  ·  '))}</div>
        ${d.blurb ? `<p class="desc">${esc(d.blurb)}</p>` : ''}
        ${d.actor ? `<p class="credit">主演：<b>${esc(d.actor)}</b></p>` : ''}
        ${d.director ? `<p class="credit">导演：<b>${esc(d.director)}</b></p>` : ''}
        ${d.lines.length ? `<h3>剧集 <span class="lines">${d.lines.map((l, i) => `<button data-line="${i}" class="${i === line ? 'on' : ''}">${esc(l.name)} (${l.episodes.length})</button>`).join('')}</span>
            ${dlMode ? `<span class="dlhint">点选要下载的集 <button class="small" id="dlAll">全部下载</button></span>` : ''}</h3>
          <div class="eps ${dlMode ? 'dlmode' : ''}">${eps.map((e, i) => {
            const dj = dlFor(site, id, e.url);
            return `<button data-${dlMode ? 'dl' : 'ep'}="${i}" class="${h && h.line === line && i <= h.ep ? 'seen' : ''}" title="${esc(e.name)}">${dj ? `<em class="${dj.status}">${dj.status === 'done' ? '✓' : '⬇'}</em>` : ''}${esc(e.name)}</button>`;
          }).join('')}</div>`
          : '<p class="err">这个源没有可直接播放的地址，看看下面的其他源。</p>'}
        <h3>其他源</h3><div class="alts" id="alts"><span class="lan">在所有源里搜索中…</span></div>
      </div>`;
    m.querySelector('.close').onclick = () => history.back();
    $$('[data-line]', m).forEach(b => b.onclick = () => { line = +b.dataset.line; render(); });
    $$('[data-ep]', m).forEach(b => b.onclick = () => play(d, line, +b.dataset.ep));
    $$('[data-dl]', m).forEach(b => b.onclick = () => enqueue(d, line, [+b.dataset.dl]).then(render, e => toast(e.message)));
    if ($('#dlToggle', m)) $('#dlToggle', m).onclick = () => { dlMode = !dlMode; render(); };
    if ($('#dlAll', m)) $('#dlAll', m).onclick = () => enqueue(d, line, eps.map((_, i) => i)).then(render, e => toast(e.message));
    dbRate(d.name, d.year).then(r => {
      const t = $('#dbtag', m); if (!t || !r.id) return;
      t.textContent = r.rate ? '豆瓣 ' + r.rate : '豆瓣 暂无评分'; t.href = `https://movie.douban.com/subject/${r.id}/`; t.hidden = false;
    });
    paintAlts();
  };
  const paintAlts = () => {
    const box = $('#alts', m); if (!box || !alts) return;
    box.innerHTML = alts.length ? alts.map(a => `<button data-s="${esc(a.site)}" data-i="${esc(a.id)}">${esc(a.siteName)}<small>${esc(a.remarks)}</small></button>`).join('') : '<span class="lan">其他源没有同名的</span>';
    $$('button', box).forEach(b => b.onclick = () => openDetail(b.dataset.s, b.dataset.i, false, true));
  };
  m.refresh = () => refreshDownloads().then(render);
  render();
  api('search', { wd: d.name }).catch(() => ({ results: [] })).then(j => {
    alts = j.results.filter(r => r.name === d.name && !(r.site === site && r.id === id));
    paintAlts();
  });
  if (autoplay && d.lines.length) play(d, line, h0 && h0.line === line ? h0.ep : 0);
}
function closeDetail() {
  const m = $('#modal'); if (!m) return;
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
  cur = { kind: 'live', eps: channels.map(c => ({ name: c.name, url: c.url })), ep: idx };
  openPlayer(0);
}
function openPlayer(startAt) {
  const e = cur.eps[cur.ep];
  if (player.hidden) { player.hidden = false; history.pushState({ player: 1 }, ''); document.body.style.overflow = 'hidden'; }
  $('.ptitle').textContent = cur.kind === 'live' ? e.name : (cur.eps.length > 1 ? `${cur.title} · ${e.name}` : cur.title);
  $('[data-act=prev]').hidden = cur.ep <= 0;
  $('[data-act=next]').hidden = cur.ep >= cur.eps.length - 1;
  $('[data-act=list]').hidden = cur.eps.length <= 1;
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
function renderPlist() {
  const box = $('.plist');
  box.innerHTML = cur.eps.map((e, i) => `<button data-i="${i}" class="${i === cur.ep ? 'on' : ''}" title="${esc(e.name)}">${esc(e.name)}</button>`).join('');
  $$('button', box).forEach(b => b.onclick = () => { cur.ep = +b.dataset.i; openPlayer(0); });
}
function closePlayer() {
  if (hls) { hls.destroy(); hls = null; }
  video.pause(); video.removeAttribute('src'); video.load();
  player.hidden = true; $('.plist').hidden = true; msg('');
  if (!$('#modal')) document.body.style.overflow = '';
  $('#modal')?.refresh?.();
  cur = null;
}
player.addEventListener('click', e => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'close') history.back();
  if (act === 'next') step(1);
  if (act === 'prev') step(-1);
  if (act === 'list') { $('.plist').hidden = !$('.plist').hidden; $('.plist .on')?.scrollIntoView({ block: 'center' }); }
});
function poke() { player.classList.remove('idle'); clearTimeout(idleTimer); idleTimer = setTimeout(() => !video.paused && player.classList.add('idle'), 3000); }
player.addEventListener('mousemove', poke); player.addEventListener('touchstart', poke);
addEventListener('keydown', e => {
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
const infoP = () => serverInfo ? Promise.resolve(serverInfo) : get('/api/info').then(j => (serverInfo = j), () => ({ urls: [], ffmpeg: false }));
const thumbIO = new IntersectionObserver(es => es.forEach(e => {
  if (!e.isIntersecting) return;
  const el = e.target; thumbIO.unobserve(el);
  const img = new Image();
  img.onload = () => { el.style.backgroundImage = `url('${img.src}')`; el.classList.add('has'); };
  img.src = '/api/live/thumb?u=' + encodeURIComponent(el.dataset.u);
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
  $$('[data-src]').forEach(b => b.onclick = () => { localStorage.live = b.dataset.src; renderLive(); });
  const [{ groups }, info] = await Promise.all([api('live', { src }), infoP()]);
  let gi = 0;
  const paint = () => {
    const q = $('#chq').value.trim().toLowerCase();
    const chans = q ? groups.flatMap(g => g.channels).filter(c => c.name.toLowerCase().includes(q)) : groups[gi]?.channels || [];
    $('#liveBody').innerHTML = `<div class="live"><div class="groups">${groups.map((g, i) => `<button data-g="${i}" class="${i === gi && !q ? 'on' : ''}">${esc(g.name)}<span>${g.channels.length}</span></button>`).join('')}</div>
      <div class="channels">${chans.map((c, i) => `<button class="ch" data-c="${i}">
          <div class="cover" data-u="${esc(c.url)}"><div class="logo2" style="${bg(c.logo)}">${c.logo ? '' : '📺'}</div><span class="live-dot">LIVE</span></div>
          <span class="chname">${esc(c.name)}</span></button>`).join('') || '<div class="empty">没有频道</div>'}</div></div>`;
    $$('[data-g]', $('#liveBody')).forEach(b => b.onclick = () => { gi = +b.dataset.g; $('#chq').value = ''; paint(); });
    $$('.ch', $('#liveBody')).forEach(b => {
      b.onclick = () => { stopPreview(); playLive(chans, +b.dataset.c); };
      b.onmouseenter = () => startPreview($('.cover', b), info.ffmpeg);
      b.onmouseleave = stopPreview;
    });
    $$('.cover', $('#liveBody')).forEach(el => thumbIO.observe(el));
  };
  $('#chq').oninput = paint;
  paint();
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
          c.width = 480; c.height = Math.round(480 * v.videoHeight / v.videoWidth);
          try {
            c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
            const data = c.toDataURL('image/jpeg', 0.7);
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
  pv.img?.remove();
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

loadSites().then(route, e => { view.innerHTML = `<div class="page"><div class="err">连不上服务：${esc(e.message)}</div></div>`; });
