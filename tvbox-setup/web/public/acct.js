// ---------- 账号：用户名 + 密码，多账号切换，数据按账号隔离 ----------
// 在 app.js 之前加载。三件事：
//  1. UD：「属于某个账号的」数据（观看历史 / 进度、收藏、直播收藏、沉浸推荐偏好、最近搜索）的读写口。访客直接用原来的 localStorage 键
//     (和升级前完全一样)；登录了某个账号就换成 u<账号id>: 前缀的键，各账号互不可见。
//  2. 同步：账号数据以服务端 SQLite 为准。本地是读缓存，每次改动进一个队列 (outbox)，合并后批量发给服务端；打开页面 / 切回来时拉一次。
//     队列存在 localStorage 里，断网、关页面都不会丢。
//  3. 界面：顶栏的账号头像 (快速切换) 和设置页的「账号管理」。
// 同一台设备可以同时登录多个账号 (会话令牌存在本机，点一下就能切)，切换后整页刷新，所有缓存重新按新账号读取。
// 预览页 (?pv=) 什么都不存、不同步。服务端没有 node:sqlite 时整套功能自动隐藏，退回访客模式。
(() => {
'use strict';
const PV = new URLSearchParams(location.search).get('pv');
const ls = window.localStorage;
const LIST = 'tvbox_accts', ACTIVE = 'tvbox_acct', LOST = 'tvbox_acct_lost', ON = 'tvbox_acct_on';
const KV = new Set(['feedProf', 'feedSeen', 'feedLikes', 'recentSearches']);
const rj = (k, d) => { try { const v = JSON.parse(ls.getItem(k)); return v ?? d; } catch { return d; } };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));

let accts = rj(LIST, []).filter(a => a && a.id && a.token);
let me = accts.find(a => a.id === Number(ls.getItem(ACTIVE))) || null;
if (!me) ls.setItem(ACTIVE, '0');
const saveList = () => ls.setItem(LIST, JSON.stringify(accts));
const pre = id => 'u' + id + ':';
const ns = () => (me ? pre(me.id) : '');

// ---------- UD: 账号数据的读写 ----------
const mem = {};   // 预览页：只放内存
const UD = {
  get(k) { return PV ? (mem[k] ?? null) : ls.getItem(ns() + k); },
  set(k, v) {
    v = String(v);
    if (PV) { mem[k] = v; return; }
    ls.setItem(ns() + k, v);
    if (me && KV.has(k)) queue({ t: 'kv.set', k, v });
  },
  del(k) {
    if (PV) { delete mem[k]; return; }
    ls.removeItem(ns() + k);
    if (me && KV.has(k)) queue({ t: 'kv.del', k });
  },
  json(k, d) { try { const v = JSON.parse(UD.get(k)); return v ?? d; } catch { return d; } },
};

// ---------- 改动队列 ----------
let box = me ? rj(ns() + 'outbox', []) : [];
const persist = () => { if (me) { try { box.length ? ls.setItem(ns() + 'outbox', JSON.stringify(box)) : ls.removeItem(ns() + 'outbox'); } catch {} } };
// 同一部片的多次改动只留最后一次；清空操作之前的同类改动作废；偏好按键合并
function compact(ops) {
  const out = [], seen = new Set(), cleared = new Set();
  for (let i = ops.length - 1; i >= 0; i--) {
    const o = ops[i], [grp, kind] = String(o.t).split('.');
    let key;
    if (kind === 'clear') { if (cleared.has(grp)) continue; cleared.add(grp); out.push(o); continue; }
    if (cleared.has(grp)) continue;
    key = grp === 'kv' ? 'kv|' + o.k : grp + '|' + (o.e ? (o.e.site ?? '') + '|' + (o.e.id ?? o.e.url) : (o.site ?? '') + '|' + (o.id ?? o.url ?? ''));
    if (seen.has(key)) continue;
    seen.add(key); out.push(o);
  }
  return out.reverse();
}
function queue(op) {
  if (!me || PV) return;
  box.push(op); persist(); schedule();
}
let ftimer = 0, flushing = null;
function schedule(ms = 2500) { if (ftimer) return; ftimer = setTimeout(() => { ftimer = 0; flush(); }, ms); }
async function call(sub, method = 'GET', body, token, keepalive = false) {
  const json = body === undefined ? undefined : JSON.stringify(body);
  const r = await fetch('/api/acct/' + sub, { method, headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Session': token } : {}) }, body: json, keepalive: keepalive && (json || '').length < 60000 });
  const j = await r.json().catch(() => ({ error: 'HTTP ' + r.status }));
  return { ok: r.ok, status: r.status, j };
}
function flush(keepalive = false) {
  if (!me || PV) return Promise.resolve(true);
  if (flushing) return flushing;
  box = compact(box); persist();
  if (!box.length) return Promise.resolve(true);
  const who = me, ops = box.slice(), n = ops.length;
  flushing = (async () => {
    try {
      const r = await call('ops', 'POST', { ops }, who.token, keepalive);
      if (r.status === 401 && r.j.session === false) { lost(who); return false; }
      if (!r.ok && !(r.status >= 400 && r.status < 500 && r.status !== 429)) throw new Error(r.j.error || r.status);   // 服务端 5xx / 限速：留着重试；其它 4xx 是这批数据本身有问题，丢掉免得卡死
      box.splice(0, n); persist();
      return true;
    } catch { schedule(20000); return false; }
    finally { flushing = null; if (box.length) schedule(5000); }
  })();
  return flushing;
}
addEventListener('pagehide', () => { clearTimeout(ftimer); ftimer = 0; flush(true); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { clearTimeout(ftimer); ftimer = 0; flush(true); }
  else if (me && Date.now() - lastPull > 120e3) pull();
});

// ---------- 拉取 ----------
let lastPull = 0;
async function pull() {
  if (!me || PV) return false;
  const who = me;
  if (box.length && !(await flush())) return false;
  let r;
  try { r = await call('sync', 'GET', undefined, who.token); } catch { return false; }
  if (r.status === 401 && r.j.session === false) { lost(who); return false; }
  if (!r.ok || box.length || me !== who) return false;   // 拉的过程中用户又改了东西：这次不覆盖，下次再拉
  const j = r.j, p = pre(who.id);
  try {
    ls.setItem(p + 'history', JSON.stringify((j.history || []).slice(0, 40)));
    ls.setItem(p + 'favs', JSON.stringify((j.favs || []).slice(0, 500)));
    ls.setItem(p + 'liveFavs', JSON.stringify(j.liveFavs || []));
    for (const k of KV) (j.kv && typeof j.kv[k] === 'string') ? ls.setItem(p + k, j.kv[k]) : ls.removeItem(p + k);
  } catch {}
  if (j.user && j.user.name !== who.name) { who.name = j.user.name; saveList(); }
  lastPull = Date.now();
  return true;
}

// ---------- 账号状态 ----------
function wipeLocal(id) {
  const p = pre(id);
  for (const k of Object.keys(ls)) if (k.startsWith(p)) ls.removeItem(k);
}
// 会话失效（服务端删了账号 / 重装了数据库）：这个账号从本机拿掉，回到访客
function lost(who) {
  if (!who || !accts.some(a => a.id === who.id)) return;
  ls.setItem(LOST, who.name);
  accts = accts.filter(a => a.id !== who.id); saveList(); wipeLocal(who.id);
  if (me && me.id === who.id) { ls.setItem(ACTIVE, '0'); location.reload(); }
}
async function switchTo(id) {
  if (PV) return;
  if (me) await Promise.race([flush(true), sleep(1500)]);
  ls.setItem(ACTIVE, String(id || 0));
  location.hash = '#/';
  location.reload();
}
function enroll({ user, token }) {
  accts = accts.filter(a => a.id !== user.id);
  accts.push({ id: user.id, name: user.name, token });
  saveList(); ls.setItem(ON, '1');
  return switchTo(user.id);
}
const guestSnapshot = () => ({
  history: rj('history', []), favs: rj('favs', []), liveFavs: rj('liveFavs', []),
  kv: Object.fromEntries([...KV].map(k => [k, ls.getItem(k)]).filter(([, v]) => typeof v === 'string')),
});
const guestHasData = () => { const g = guestSnapshot(); return g.history.length + g.favs.length + g.liveFavs.length > 0; };

let statusP = null;
const status = () => statusP || (statusP = call('status').then(r => {
  if (r.status === 404) return { enabled: false, stale: true };   // 服务端还是没有账号接口的老版本：重启一次就有
  const on = !!r.j.enabled; if (on) ls.setItem(ON, '1'); else ls.removeItem(ON);
  return r.j;
}, () => ({ enabled: ls.getItem(ON) === '1', offline: true })));

const API = {
  get me() { return me; }, get list() { return accts.slice(); }, UD, status, guestHasData,
  op: queue, flush, pull,
  ready: null,
  async register(username, password, withGuest) {
    const r = await call('register', 'POST', { username, password, import: withGuest && guestHasData() ? guestSnapshot() : undefined });
    if (!r.ok) throw new Error(r.j.error || '注册失败');
    return enroll(r.j);
  },
  async login(username, password) {
    const r = await call('login', 'POST', { username, password });
    if (!r.ok) throw new Error(r.j.error || '登录失败');
    return enroll(r.j);
  },
  switchTo,
  async remove(id) {
    const a = accts.find(x => x.id === id); if (!a) return;
    call('logout', 'POST', {}, a.token).catch(() => {});
    accts = accts.filter(x => x.id !== id); saveList(); wipeLocal(id);
    if (me && me.id === id) return switchTo(0);
  },
  async info() { if (!me) return null; const r = await call('me', 'GET', undefined, me.token); if (r.status === 401 && r.j.session === false) { lost(me); return null; } return r.ok ? r.j : null; },
  async importGuest() {
    if (!me) return null;
    const r = await call('import', 'POST', guestSnapshot(), me.token);
    if (!r.ok) throw new Error(r.j.error || '导入失败');
    box = []; persist(); await pull(); return r.j.stats;
  },
  async clear(what) {
    if (!me) return null;
    await flush();
    const r = await call('clear', 'POST', { what }, me.token);
    if (!r.ok) throw new Error(r.j.error || '清空失败');
    box = []; persist(); await pull(); return r.j.stats;
  },
  async password(old, next) { const r = await call('password', 'POST', { old, next }, me.token); if (!r.ok) throw new Error(r.j.error || '修改失败'); },
  async destroy(password) {
    const who = me;
    const r = await call('delete', 'POST', { password }, who.token);
    if (!r.ok) throw new Error(r.j.error || '删除失败');
    accts = accts.filter(x => x.id !== who.id); saveList(); wipeLocal(who.id);
    ls.setItem(ACTIVE, '0'); location.hash = '#/'; location.reload();
  },
};
// 启动时：登录了账号就先拉一次最新数据 (最多等 0.9 秒，服务慢就先用本地缓存，不拖慢首屏)
API.ready = me && !PV ? Promise.race([pull().catch(() => false), sleep(900)]) : Promise.resolve(false);
window.ACCT = API; window.UD = UD;
if (box.length) schedule(3000);   // 上次没发完的改动 (关页面时来不及) 补发

// ---------- 界面 ----------
const hue = s => { let h = 0; for (const c of String(s)) h = (h * 31 + c.codePointAt(0)) % 360; return h; };
const avatar = (name, cls = '') => `<span class="av ${cls}" style="--h:${hue(name)}">${esc([...String(name)][0] || '?').toUpperCase()}</span>`;
const guestAv = '<span class="av guest"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 12a4.2 4.2 0 1 0 0-8.4 4.2 4.2 0 0 0 0 8.4zM4 21c0-4.4 3.6-7.4 8-7.4s8 3 8 7.4z"/></svg></span>';
const say = (m, sticky) => (typeof window.toast === 'function' ? window.toast(m, sticky) : alert(m));

// 顶栏头像 + 快速切换菜单
let wrap = null, menu = null, btn = null;
function paintBtn() {
  if (!btn) return;
  btn.innerHTML = me ? avatar(me.name) : guestAv;
  btn.title = me ? '账号：' + me.name : '访客（本机）· 点击登录 / 切换账号';
}
function paintMenu() {
  menu.innerHTML = `<div class="mhead">切换账号</div>
    <button type="button" data-id="0" class="${me ? '' : 'on'}">${guestAv}<span>访客（本机）</span>${me ? '' : '<i>当前</i>'}</button>
    ${accts.map(a => `<button type="button" data-id="${a.id}" class="${me && me.id === a.id ? 'on' : ''}">${avatar(a.name)}<span>${esc(a.name)}</span>${me && me.id === a.id ? '<i>当前</i>' : ''}</button>`).join('')}`;
}
function mountHeader() {
  if (wrap || PV) return;
  const right = document.querySelector('header .right'); if (!right) return;
  wrap = document.createElement('div'); wrap.className = 'picker acctwrap'; wrap.hidden = true;
  wrap.innerHTML = '<button id="acctBtn" class="acctbtn" type="button" aria-haspopup="true"></button><div class="menu acctmenu" hidden></div>';
  right.append(wrap);
  btn = wrap.querySelector('button'); menu = wrap.querySelector('.menu');
  paintBtn();
  // 小屏从底部上拉 + 遮罩, 大屏头像下面的浮窗: 都由 app.js 的 Pop 统一处理 (点外面 / 遮罩 / Esc / 换页 / 再点一次按钮 都会收起)
  btn.onclick = e => {
    e.stopPropagation();
    if (!Pop.isOpen(menu)) paintMenu();
    Pop.attach(menu, { anchor: btn });
  };
  menu.onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    Pop.close();
    const id = Number(b.dataset.id);
    if ((me ? me.id : 0) !== id) switchTo(id);
  };
  status().then(s => { wrap.hidden = !s.enabled; });
  if (ls.getItem(ON) === '1' || accts.length) wrap.hidden = false;
}
mountHeader();
if (ls.getItem(LOST)) { const n = ls.getItem(LOST); ls.removeItem(LOST); setTimeout(() => say(`账号「${n}」的登录已失效，请重新登录`), 600); }

// ---------- 设置页「账号管理」 ----------
const fmtDate = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const hint = (ok, text) => `<span class="acct-msg ${ok ? 'ok' : ''}">${esc(text)}</span>`;
async function mountSettings(el) {
  if (!el || PV) return;
  const st = await status();
  if (!el.isConnected) return;
  if (!st.enabled) {
    el.innerHTML = `<h2>账号管理</h2><p class="hint">${st.offline ? '连不上服务，稍后再试。' : st.stale ? '服务端还没更新到带账号功能的版本，重启一次服务就有了（设置页下面的「管理员」里可以重启）。' : '服务端的 Node 版本太旧（需要 22.13 以上，自带 node:sqlite），账号功能没有开启。升级 Node 后重启服务即可。'}当前是访客模式，数据只存在这个浏览器里。</p>`;
    return;
  }
  let tab = 'login', sub = '', info = me ? await API.info().catch(() => null) : null;
  if (!el.isConnected) return;
  const render = () => {
    const stats = info && info.stats;
    const rows = [{ id: 0, name: '访客（本机）', guest: 1 }, ...accts].map(a => `
      <div class="acct-row ${((me ? me.id : 0) === a.id) ? 'cur' : ''}">${a.guest ? guestAv : avatar(a.name)}
        <div class="nm"><b>${esc(a.name)}</b><small>${a.guest ? '不登录，数据只存在这个浏览器里' : '已登录 · 数据在服务端'}</small></div>
        ${((me ? me.id : 0) === a.id) ? '<span class="acct-tag">当前</span>' : `<button class="small" data-sw="${a.id}">切换</button>`}
        ${a.guest ? '' : `<button class="small ghost" data-rm="${a.id}" title="从这台设备上退出这个账号（数据仍保留在服务端，下次输密码即可登录）">退出</button>`}</div>`).join('');
    const subForm = {
      pw: `<form class="acct-sub" data-f="pw"><input type="password" name="old" placeholder="旧密码" autocomplete="current-password" required><input type="password" name="next" placeholder="新密码（6 位以上）" autocomplete="new-password" minlength="6" required><button class="small" type="submit">保存</button><button class="small ghost" type="button" data-sub="">取消</button></form>`,
      del: `<form class="acct-sub" data-f="del"><span class="acct-warn">会删除这个账号的全部观看历史、收藏和偏好，不可恢复。</span><input type="password" name="pw" placeholder="输入密码确认" autocomplete="current-password" required><button class="small danger" type="submit">永久删除</button><button class="small ghost" type="button" data-sub="">取消</button></form>`,
    }[sub] || '';
    el.innerHTML = `<h2>账号管理</h2>
      <p class="hint">用用户名和密码注册账号，观看历史、播放进度、收藏、沉浸推荐偏好都归账号所有，账号之间互不可见。同一台设备可以登录多个账号随时切换；换一台设备登录同一个账号，进度和收藏跟着走。</p>
      <div class="acct-now">${me ? avatar(me.name, 'lg') : guestAv.replace('class="av guest"', 'class="av guest lg"')}
        <div class="nm"><b>${me ? esc(me.name) : '访客（本机）'}</b><small>${me ? `注册于 ${info ? fmtDate(info.user.created) : '…'}` : '还没登录：数据只存在这个浏览器里，登录后才会同步、才能跨设备'}</small></div>
        ${stats ? `<div class="acct-stats"><span><b>${stats.history}</b>观看记录</span><span><b>${stats.favs}</b>收藏</span><span><b>${stats.liveFavs}</b>直播收藏</span></div>` : ''}</div>
      <div class="acct-list">${rows}</div>
      <div class="acct-box">
        <div class="seg"><button type="button" data-tab="login" class="${tab === 'login' ? 'on' : ''}">登录</button><button type="button" data-tab="reg" class="${tab === 'reg' ? 'on' : ''}">注册新账号</button></div>
        <form class="acct-form" id="acctForm" autocomplete="on">
          <input name="username" placeholder="用户名（2~20 个字）" autocomplete="username" autocapitalize="off" spellcheck="false" required>
          <input name="password" type="password" placeholder="密码${tab === 'reg' ? '（6 位以上）' : ''}" autocomplete="${tab === 'reg' ? 'new-password' : 'current-password'}" required>
          ${tab === 'reg' ? '<input name="again" type="password" placeholder="再输一次密码" autocomplete="new-password" required>' : ''}
          ${tab === 'reg' && guestHasData() ? '<label class="flag acct-imp"><input type="checkbox" name="imp" checked>把这个浏览器里的观看记录和收藏带到新账号</label>' : ''}
          <button class="small primary" type="submit">${tab === 'reg' ? '注册并登录' : '登录'}</button><span class="acct-msg" aria-live="polite"></span>
        </form></div>
      ${me ? `<div class="actions acct-acts">
        <button class="small" data-sub="pw">修改密码</button>
        ${guestHasData() ? '<button class="small" data-act="imp" title="把这个浏览器作为访客时留下的记录并入当前账号（同一部片取较新的一条）">导入访客数据</button>' : ''}
        <button class="small" data-act="clr-hist">清空观看历史</button><button class="small" data-act="clr-favs">清空收藏</button>
        <button class="small danger" data-sub="del">删除账号</button></div>${subForm}` : ''}`;
    bind();
  };
  const msg = (ok, text) => { const m = el.querySelector('.acct-form .acct-msg'); if (m) { m.className = 'acct-msg ' + (ok ? 'ok' : ''); m.textContent = text; } };
  async function refresh() { info = await API.info().catch(() => null); render(); }
  function bind() {
    el.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { tab = b.dataset.tab; render(); });
    el.querySelectorAll('[data-sw]').forEach(b => b.onclick = () => switchTo(Number(b.dataset.sw)));
    el.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { if (confirm('从这台设备上退出这个账号？数据仍保留在服务端，下次输入密码即可登录。')) API.remove(Number(b.dataset.rm)); });
    el.querySelectorAll('[data-sub]').forEach(b => b.onclick = () => { sub = b.dataset.sub; render(); });
    const form = el.querySelector('#acctForm');
    form.onsubmit = async e => {
      e.preventDefault();
      const f = new FormData(form), u = String(f.get('username') || '').trim(), p = String(f.get('password') || '');
      if (tab === 'reg' && p !== f.get('again')) return msg(false, '两次密码不一样');
      const go = form.querySelector('button[type=submit]'); go.disabled = true; msg(true, '请稍候…');
      try { tab === 'reg' ? await API.register(u, p, !!f.get('imp')) : await API.login(u, p); }
      catch (err) { go.disabled = false; msg(false, err.message); }
    };
    el.querySelector('[data-act=imp]')?.addEventListener('click', async () => { try { const s = await API.importGuest(); say(`已导入：观看记录 ${s.history} 条，收藏 ${s.favs} 部`); refresh(); } catch (err) { say(err.message); } });
    const clr = (act, what, ask, done) => el.querySelector(`[data-act=${act}]`)?.addEventListener('click', async () => { if (!confirm(ask)) return; try { await API.clear(what); say(done); refresh(); } catch (err) { say(err.message); } });
    clr('clr-hist', 'history', `清空「${me && me.name}」的全部观看历史？`, '观看历史已清空');
    clr('clr-favs', 'favs', `清空「${me && me.name}」的全部收藏？`, '收藏已清空');
    el.querySelector('[data-f=pw]')?.addEventListener('submit', async e => {
      e.preventDefault(); const f = new FormData(e.target);
      try { await API.password(String(f.get('old')), String(f.get('next'))); sub = ''; say('密码已修改，其它设备需要重新登录'); render(); } catch (err) { say(err.message); }
    });
    el.querySelector('[data-f=del]')?.addEventListener('submit', async e => {
      e.preventDefault();
      try { await API.destroy(String(new FormData(e.target).get('pw'))); } catch (err) { say(err.message); }
    });
  }
  render();
  if (!st.register) msg(false, '这台服务器没有开放注册，只能登录已有账号');
}
API.mountSettings = mountSettings;
API.paint = () => { paintBtn(); };
})();
