// TVBOX 管理后台 (Vue 3, 不用构建: vue.global.prod.js 带模板编译器, 组件直接写模板字符串)。
// 谁能进: 管理员账号 (登录后 Cookie tvbox_sess) 或带管理员令牌的浏览器 (Cookie tvbox_admin)。接口都在 /api/console/ 下, 服务端逐个校验。
// 手机优先: 底部标签栏 + 上拉弹层; 宽屏变成左侧栏。
'use strict';
const { createApp, ref, reactive, computed, onMounted, onBeforeUnmount, watch, nextTick } = Vue;

// ---------- 接口 ----------
async function api(method, path, body) {
  const r = await fetch('/api/' + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({ error: 'HTTP ' + r.status }));
  if (!r.ok || j.error) { const e = new Error(j.error || 'HTTP ' + r.status); e.status = r.status; e.body = j; throw e; }
  return j;
}
const get = p => api('GET', p);
const post = (p, b) => api('POST', p, b || {});

// 和前台共用同一份账号登记 (acct.js 的 localStorage 键), 在这里登录前台也跟着登录
const LIST = 'tvbox_accts', ACTIVE = 'tvbox_acct', ON = 'tvbox_acct_on';
function setSessCookie(tok) {
  document.cookie = `tvbox_sess=${tok ? encodeURIComponent(tok) : ''}; Path=/; Max-Age=${tok ? 31536000 : 0}; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
}
function enroll(user, token) {
  let list = []; try { list = JSON.parse(localStorage.getItem(LIST) || '[]'); } catch {}
  list = list.filter(a => a && a.id !== user.id); list.push({ id: user.id, name: user.name, token });
  localStorage.setItem(LIST, JSON.stringify(list)); localStorage.setItem(ACTIVE, String(user.id)); localStorage.setItem(ON, '1');
  setSessCookie(token);
}
function leaveAccount() { localStorage.setItem(ACTIVE, '0'); setSessCookie(''); }

const LV = { kids: '儿童', standard: '标准', all: '全部' };
const hue = s => { let h = 0; for (const c of String(s)) h = (h * 31 + c.codePointAt(0)) % 360; return h; };
const fmtDate = t => { if (!t) return '—'; const d = new Date(t); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
const ago = t => { if (!t) return '从未'; const s = Math.max(0, (Date.now() - t) / 1000); return s < 90 ? '刚刚' : s < 3600 ? Math.round(s / 60) + ' 分钟前' : s < 86400 ? Math.round(s / 3600) + ' 小时前' : Math.round(s / 86400) + ' 天前'; };
const fmtSize = b => !b ? '0' : b > 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB';
const fmtUp = s => s < 90 ? s + ' 秒' : s < 5400 ? Math.round(s / 60) + ' 分钟' : s < 172800 ? (s / 3600).toFixed(1) + ' 小时' : (s / 86400).toFixed(1) + ' 天';

// ---------- 全局提示 / 对话框 ----------
const toastState = reactive({ text: '', err: false, t: 0 });
function toast(text, err = false) { toastState.text = text; toastState.err = err; clearTimeout(toastState.t); toastState.t = setTimeout(() => { toastState.text = ''; }, err ? 4500 : 2200); }
const oops = e => toast(e && e.message || String(e), true);

const dlg = reactive({ open: false, kind: '', title: '', text: '', value: '', placeholder: '', type: 'text', okText: '确定', danger: false, resolve: null });
function ask(opts) { return new Promise(resolve => { Object.assign(dlg, { open: true, kind: 'confirm', title: '', text: '', value: '', placeholder: '', type: 'text', okText: '确定', danger: false }, opts, { resolve }); }); }
const confirmBox = (title, text, okText = '确定', danger = false) => ask({ kind: 'confirm', title, text, okText, danger });
const promptBox = (title, placeholder, type = 'text', text = '') => ask({ kind: 'prompt', title, placeholder, type, text });
function dlgDone(ok) { const r = dlg.resolve; dlg.open = false; dlg.resolve = null; r && r(dlg.kind === 'prompt' ? (ok ? dlg.value : null) : ok); }

// ---------- 小组件 ----------
const Avatar = { props: ['name'], setup: p => ({ hue, ch: computed(() => ([...String(p.name || '?')][0] || '?').toUpperCase()) }), template: '<span class="av" :style="{ \'--h\': hue(name) }">{{ ch }}</span>' };
const Sheet = { props: ['title'], emits: ['close'], template: `<div class="mask" @click.self="$emit('close')"><div class="sheet" role="dialog"><h3 v-if="title">{{ title }}</h3><slot /></div></div>` };

// ---------- 概览 ----------
const Overview = {
  emits: ['go'],
  setup(_, { emit }) {
    const d = ref(null);
    const load = () => get('console/overview').then(v => { d.value = v; }, oops);
    onMounted(load);
    return { d, emit, LV };
  },
  template: `<div v-if="d">
    <h2>概览</h2>
    <div class="stats">
      <div class="stat"><small>账号</small><b>{{ d.users }}<i>个</i></b></div>
      <div class="stat"><small>管理员</small><b>{{ d.admins }}<i>个</i></b></div>
      <div class="stat"><small>点播源</small><b>{{ d.sites }}<i>{{ d.groups ? '+ ' + d.groups + ' 聚合' : '个' }}</i></b></div>
      <div class="stat"><small>直播源</small><b>{{ d.lives }}<i>个</i></b></div>
    </div>
    <div class="card">
      <div class="row gap"><b>账号按安全级别</b><span class="muted small">访客固定是「标准」, 不在这里</span></div>
      <div class="row gap" style="margin-top:10px">
        <span class="tag green">儿童 {{ d.byLevel.kids }}</span><span class="tag">标准 {{ d.byLevel.standard }}</span><span class="tag red">全部 {{ d.byLevel.all }}</span>
        <span class="tag" :class="d.register ? 'green' : 'amber'">{{ d.register ? '开放注册' : '已关闭注册' }}</span>
      </div>
    </div>
    <div class="card">
      <div class="row gap"><b>源的标记</b></div>
      <div class="row gap" style="margin-top:10px"><span class="tag red">成人源 {{ d.adultSites }}</span><span class="tag green">少儿源 {{ d.kidsSites }}</span></div>
    </div>
    <div class="card">
      <div class="row gap"><b>账号数据</b></div>
      <div class="row gap" style="margin-top:10px"><span class="tag">登录会话 {{ d.sessions }}</span><span class="tag">观看记录 {{ d.history }}</span><span class="tag">收藏 {{ d.favs }}</span></div>
    </div>
    <div class="row gap">
      <button class="btn" @click="emit('go','users')">管理账号</button>
      <button class="btn" @click="emit('go','vod')">管理点播源</button>
      <a class="btn ghost" href="/">回到网站</a>
    </div>
  </div>
  <div v-else class="muted">加载中…</div>`
};

// ---------- 账号 ----------
const Users = {
  props: ['me'],
  components: { Avatar, Sheet },
  setup(props) {
    const users = ref(null), reg = ref(true), busy = ref(false);
    const form = reactive({ open: false, username: '', password: '', level: 'standard', admin: false });
    const load = () => get('console/users').then(v => { users.value = v.users; reg.value = v.register; }, oops);
    onMounted(load);
    const isMe = u => props.me.user && props.me.user.id === u.id;
    const act = async (fn, okMsg) => { if (busy.value) return; busy.value = true; try { await fn(); if (okMsg) toast(okMsg); await load(); } catch (e) { oops(e); } finally { busy.value = false; } };
    const setLevel = (u, level) => level !== u.level && act(() => post('console/users/update', { id: u.id, level }), `「${u.name}」的安全级别改成${LV[level]}`);
    const setAdmin = async (u, on) => {
      if (!await confirmBox(on ? '设为管理员？' : '取消管理员？', on ? `「${u.name}」将能管理账号、修改源数据、使用「全部」级别。` : `「${u.name}」将失去管理权限${u.level === 'all' ? '，安全级别会降回「标准」' : ''}。`, '确定')) return;
      act(() => post('console/users/update', { id: u.id, admin: on }), on ? '已设为管理员' : '已取消管理员');
    };
    const resetPw = async u => {
      const pw = await promptBox(`重置「${u.name}」的密码`, '新密码（6 位以上）', 'password', '其它设备上的登录会失效, 需要用新密码重新登录。');
      if (pw) act(() => post('console/users/password', { id: u.id, password: pw }), '密码已重置');
    };
    const kick = async u => { if (await confirmBox('让所有设备下线？', `「${u.name}」在所有设备上的登录会失效。`)) act(() => post('console/users/kick', { id: u.id }), '已下线'); };
    const del = async u => { if (await confirmBox('删除账号？', `会删除「${u.name}」的全部观看历史、收藏和偏好, 不可恢复。`, '永久删除', true)) act(() => post('console/users/delete', { id: u.id }), '已删除'); };
    const create = () => act(async () => {
      await post('console/users/create', { username: form.username, password: form.password, level: form.level, admin: form.admin });
      form.open = false; Object.assign(form, { username: '', password: '', level: 'standard', admin: false });
    }, '账号已创建');
    watch(() => form.admin, v => { if (!v && form.level === 'all') form.level = 'standard'; });
    return { users, reg, busy, form, isMe, setLevel, setAdmin, resetPw, kick, del, create, LV, ago, fmtDate };
  },
  template: `<div>
    <div class="row" style="margin-bottom:6px"><h2 class="grow" style="margin:0">账号</h2><button class="btn red sm" @click="form.open = true">＋ 新建账号</button></div>
    <p class="muted small" style="margin-top:0">安全级别属于账号: 访客固定「标准」; 非管理员只能是「儿童」或「标准」; 只有管理员账号能用「全部」。注册{{ reg ? '已开放' : '已关闭' }}。</p>
    <div v-if="!users" class="muted">加载中…</div>
    <div v-else class="users">
      <div class="card user" v-for="u in users" :key="u.id">
        <div class="head"><Avatar :name="u.name" />
          <div class="grow"><div class="nm">{{ u.name }}<span class="tag blue" v-if="u.admin">管理员</span><span class="tag" v-if="isMe(u)">我</span></div>
            <div class="meta">注册 {{ fmtDate(u.created).slice(0, 10) }} · 最近 {{ ago(u.lastSeen) }} · 历史 {{ u.history }} · 收藏 {{ u.favs }} · {{ u.sessions }} 个会话</div></div></div>
        <div class="ops"><span class="lbl">安全级别</span>
          <div class="seg"><button v-for="(n, k) in LV" :key="k" :class="{ on: u.level === k }" :disabled="busy || (k === 'all' && !u.admin)" @click="setLevel(u, k)">{{ n }}</button></div></div>
        <div class="ops"><span class="lbl">管理员</span><button class="switch" :class="{ on: u.admin }" :disabled="busy || (isMe(u) && u.admin)" @click="setAdmin(u, !u.admin)" :aria-pressed="u.admin"></button>
          <span class="grow"></span>
          <button class="btn sm" @click="resetPw(u)" :disabled="busy">重置密码</button>
          <button class="btn sm" @click="kick(u)" :disabled="busy">踢下线</button>
          <button class="btn sm danger" @click="del(u)" :disabled="busy || isMe(u)">删除</button></div>
      </div>
    </div>
    <p v-if="users && !users.length" class="muted">还没有账号。</p>
    <Sheet v-if="form.open" title="新建账号" @close="form.open = false">
      <label class="fld"><span>用户名（2~20 个字）</span><input type="text" v-model.trim="form.username" autocomplete="off"></label>
      <label class="fld"><span>密码（6 位以上）</span><input type="password" v-model="form.password" autocomplete="new-password"></label>
      <div class="row gap" style="margin-bottom:12px"><span class="muted small">管理员</span><button class="switch" :class="{ on: form.admin }" @click="form.admin = !form.admin"></button></div>
      <div class="row gap" style="margin-bottom:12px"><span class="muted small">安全级别</span>
        <div class="seg"><button v-for="(n, k) in LV" :key="k" :class="{ on: form.level === k }" :disabled="k === 'all' && !form.admin" @click="form.level = k">{{ n }}</button></div></div>
      <div class="acts"><button class="btn" @click="form.open = false">取消</button><button class="btn red" :disabled="busy || !form.username || form.password.length < 6" @click="create">创建</button></div>
    </Sheet>
  </div>`
};

// ---------- 点播源 / 直播源 (共用) ----------
// 整份配置读出来, 在本地改, 点「保存」时整份写回 (服务端 normalize 去重、整理)。聚合源只显示, 成员请到前台设置里调整。
const config = reactive({ loaded: false, data: null, orig: '' });
async function loadConfig() { const c = await get('console/config'); config.data = c; config.orig = JSON.stringify(c); config.loaded = true; }
const dirty = computed(() => config.loaded && JSON.stringify(config.data) !== config.orig);
async function saveConfig() { await api('PUT', 'console/config', config.data); await loadConfig(); }

const Sources = {
  props: ['kind'],
  components: { Sheet },
  setup(props) {
    const q = ref(''), filter = ref('all'), sel = reactive(new Set()), edit = ref(null), saving = ref(false);
    onMounted(() => { if (!config.loaded) loadConfig().catch(oops); });
    const isVod = computed(() => props.kind === 'vod');
    const list = computed(() => (config.data ? (isVod.value ? config.data.sites : config.data.lives) : []));
    const key = x => isVod.value ? x.key : x._i;
    const rows = computed(() => list.value.map((x, i) => ({ x, i })).filter(({ x }) => {
      if (q.value && !(`${x.name || ''} ${x.api || x.url || ''}`.toLowerCase().includes(q.value.toLowerCase()))) return false;
      return filter.value === 'all' ? true : filter.value === 'adult' ? !!x.adult : filter.value === 'kids' ? !!x.kids : filter.value === 'hidden' ? !!x.hidden : !(x.adult || x.kids);
    }));
    const counts = computed(() => ({ all: list.value.length, adult: list.value.filter(x => x.adult).length, kids: list.value.filter(x => x.kids).length, hidden: list.value.filter(x => x.hidden).length, std: list.value.filter(x => !(x.adult || x.kids)).length }));
    const flag = (x, k, v) => { if (v) x[k] = 1; else delete x[k]; };
    const toggleSel = i => { sel.has(i) ? sel.delete(i) : sel.add(i); };
    const selAll = () => { if (rows.value.every(r => sel.has(r.i))) rows.value.forEach(r => sel.delete(r.i)); else rows.value.forEach(r => sel.add(r.i)); };
    const bulk = async what => {
      const idx = [...sel]; if (!idx.length) return;
      const arr = list.value;
      if (what === 'del') {
        if (!await confirmBox('删除选中的源？', `共 ${idx.length} 个, 点「保存」后才真正生效。`, '删除', true)) return;
        const drop = new Set(idx); const keep = arr.filter((_, i) => !drop.has(i)); arr.splice(0, arr.length, ...keep); sel.clear(); return;
      }
      for (const i of idx) {
        const x = arr[i]; if (!x) continue;
        if (what === 'adult') { flag(x, 'adult', 1); flag(x, 'kids', 0); }
        else if (what === 'kids') { flag(x, 'kids', 1); flag(x, 'adult', 0); }
        else if (what === 'std') { flag(x, 'adult', 0); flag(x, 'kids', 0); }
        else if (what === 'hide') flag(x, 'hidden', 1);
        else if (what === 'show') flag(x, 'hidden', 0);
      }
    };
    const open = (x, i) => { edit.value = { i, isNew: i < 0, name: x.name || '', url: x.api || x.url || '', cats: (x.categories || []).join(','), group: !!x.members, members: x.members ? x.members.length : 0 }; };
    const add = () => open({}, -1);
    const applyEdit = async () => {
      const e = edit.value; const arr = list.value;
      const url = e.url.trim(), name = e.name.trim();
      if (!e.group && !/^https?:\/\//.test(url) && !/^local:/.test(url)) return toast(isVod.value ? '接口地址要以 http(s):// 开头' : '直播源地址要以 http(s):// 开头（或 local:文件）', true);
      if (e.isNew) {
        const x = isVod.value ? { key: name || url, name: name || url, type: 1, api: url } : { name: name || url, url };
        if (isVod.value && e.cats.trim()) x.categories = e.cats.split(/[,，]/).map(s => s.trim()).filter(Boolean);
        arr.push(x);
      } else {
        const x = arr[e.i]; if (!x) return;
        x.name = name || x.name;
        if (!e.group) { if (isVod.value) { x.api = url; if (e.cats.trim()) x.categories = e.cats.split(/[,，]/).map(s => s.trim()).filter(Boolean); else delete x.categories; } else x.url = url; }
      }
      edit.value = null;
    };
    const removeOne = async () => {
      const e = edit.value; if (e.isNew) { edit.value = null; return; }
      if (!await confirmBox('删除这个源？', '点「保存」后才真正生效。', '删除', true)) return;
      list.value.splice(e.i, 1); sel.clear(); edit.value = null;
    };
    const save = async () => { saving.value = true; try { await saveConfig(); sel.clear(); toast('已保存'); } catch (e) { oops(e); } finally { saving.value = false; } };
    const revert = async () => { if (await confirmBox('放弃未保存的修改？', '', '放弃')) { config.data = JSON.parse(config.orig); sel.clear(); } };
    return { q, filter, sel, rows, counts, isVod, edit, saving, dirty, config, flag, toggleSel, selAll, bulk, open, add, applyEdit, removeOne, save, revert };
  },
  template: `<div>
    <div class="row" style="margin-bottom:6px"><h2 class="grow" style="margin:0">{{ isVod ? '点播源' : '直播源' }}</h2><button class="btn red sm" @click="add">＋ 添加</button></div>
    <p class="muted small" style="margin-top:0">改动先留在本页, 点底部「保存」才写入服务端。成人 / 少儿 标记决定哪个安全级别看得到它。{{ isVod ? '聚合源的成员、排序、测速、导入请到网站的「设置」里操作。' : '' }}</p>
    <div v-if="!config.loaded" class="muted">加载中…</div>
    <template v-else>
      <div class="toolbar"><input type="search" v-model="q" placeholder="搜名称或地址"></div>
      <div class="chips" style="margin-bottom:10px">
        <button class="chip" :class="{ on: filter === 'all' }" @click="filter = 'all'">全部 {{ counts.all }}</button>
        <button class="chip" :class="{ on: filter === 'std' }" @click="filter = 'std'">标准 {{ counts.std }}</button>
        <button class="chip" :class="{ on: filter === 'adult' }" @click="filter = 'adult'">成人 {{ counts.adult }}</button>
        <button class="chip" :class="{ on: filter === 'kids' }" @click="filter = 'kids'">少儿 {{ counts.kids }}</button>
        <button class="chip" :class="{ on: filter === 'hidden' }" @click="filter = 'hidden'">隐藏 {{ counts.hidden }}</button>
      </div>
      <div class="bulk" v-if="sel.size">
        <b>已选 {{ sel.size }}</b>
        <button class="btn sm" @click="bulk('std')">标准</button><button class="btn sm" @click="bulk('adult')">成人</button><button class="btn sm" @click="bulk('kids')">少儿</button>
        <button class="btn sm" @click="bulk('hide')">隐藏</button><button class="btn sm" @click="bulk('show')">取消隐藏</button><button class="btn sm danger" @click="bulk('del')">删除</button>
        <span class="grow"></span><button class="btn sm ghost" @click="sel.clear()">取消选择</button>
      </div>
      <div class="list" v-if="rows.length">
        <div class="src" v-for="r in rows" :key="r.i">
          <input type="checkbox" class="chk" :checked="sel.has(r.i)" @change="toggleSel(r.i)" aria-label="选择">
          <div class="info" @click="open(r.x, r.i)" style="cursor:pointer">
            <div class="nm">{{ r.x.name || '(未命名)' }}
              <span class="tag blue" v-if="r.x.members">聚合 {{ r.x.members.length }}</span>
              <span class="tag red" v-if="r.x.adult">成人</span><span class="tag green" v-if="r.x.kids">少儿</span><span class="tag amber" v-if="r.x.hidden">隐藏</span></div>
            <div class="url">{{ r.x.members ? '成员: ' + r.x.members.join('、') : (r.x.api || r.x.url) }}</div>
          </div>
          <button class="btn sm ghost" @click="open(r.x, r.i)">编辑</button>
        </div>
      </div>
      <p v-else class="muted">没有符合条件的源。</p>
      <div class="row" style="margin-top:10px" v-if="rows.length"><button class="btn sm ghost" @click="selAll">全选 / 取消全选当前列表</button></div>
      <div class="savebar" v-if="dirty"><span class="grow">有未保存的修改</span><button class="btn ghost" @click="revert">放弃</button><button class="btn red" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存' }}</button></div>
    </template>
    <Sheet v-if="edit" :title="edit.isNew ? '添加' + (isVod ? '点播源' : '直播源') : '编辑'" @close="edit = null">
      <label class="fld"><span>名称</span><input type="text" v-model="edit.name" autocomplete="off"></label>
      <label class="fld" v-if="!edit.group"><span>{{ isVod ? '接口地址（苹果CMS，…/api.php/provide/vod）' : '地址（m3u / m3u8 / txt）' }}</span><textarea v-model="edit.url" rows="2" spellcheck="false"></textarea></label>
      <p class="muted small" v-else>聚合源（{{ edit.members }} 个成员）: 这里只能改名称, 成员请到网站设置里调整。</p>
      <label class="fld" v-if="isVod && !edit.group"><span>只保留这些分类（逗号分隔, 留空 = 不限）</span><input type="text" v-model="edit.cats" autocomplete="off"></label>
      <div class="row gap" v-if="!edit.isNew" style="margin-bottom:12px">
        <label class="row"><input type="checkbox" class="chk" :checked="!!config.data[isVod ? 'sites' : 'lives'][edit.i].adult" @change="flag(config.data[isVod ? 'sites' : 'lives'][edit.i], 'adult', $event.target.checked)"> 成人</label>
        <label class="row"><input type="checkbox" class="chk" :checked="!!config.data[isVod ? 'sites' : 'lives'][edit.i].kids" @change="flag(config.data[isVod ? 'sites' : 'lives'][edit.i], 'kids', $event.target.checked)"> 少儿</label>
        <label class="row"><input type="checkbox" class="chk" :checked="!!config.data[isVod ? 'sites' : 'lives'][edit.i].hidden" @change="flag(config.data[isVod ? 'sites' : 'lives'][edit.i], 'hidden', $event.target.checked)"> 隐藏</label>
      </div>
      <div class="acts"><button class="btn danger" v-if="!edit.isNew" @click="removeOne" style="margin-right:auto">删除</button><button class="btn" @click="edit = null">取消</button><button class="btn red" @click="applyEdit">{{ edit.isNew ? '添加' : '完成' }}</button></div>
    </Sheet>
  </div>`
};

// ---------- 系统 ----------
const System = {
  setup() {
    const st = ref(null), busy = ref(''), checkErr = ref('');
    let timer = 0;
    const load = async () => { try { st.value = await get('admin/status'); } catch (e) { if (e.status === 403) st.value = { authed: false }; } };
    const running = computed(() => { const j = st.value && st.value.job; return !!j && (j.status === 'running' || j.status === 'restarting'); });
    const loop = () => { clearTimeout(timer); timer = setTimeout(async () => { await load(); loop(); }, running.value ? 1200 : 6000); };
    onMounted(async () => { await load(); loop(); });
    onBeforeUnmount(() => clearTimeout(timer));
    const run = async (path, body, label) => { busy.value = label; try { const r = await post('admin/' + path, body); if (r.job && st.value) st.value.job = r.job; } catch (e) { oops(e); } finally { busy.value = ''; load(); } };
    const check = async () => { busy.value = '检查更新'; checkErr.value = ''; try { const r = await post('admin/check', { force: true }); checkErr.value = r.checkError || ''; await load(); if (!checkErr.value) toast(st.value.update && st.value.update.available ? '有新版本' : '已是最新'); } catch (e) { oops(e); } finally { busy.value = ''; } };
    const update = async () => { if (await confirmBox('更新并重启？', '重启期间页面会短暂断开。', '更新')) run('update', {}, '更新'); };
    const restart = async () => { if (await confirmBox('重启服务？', '重启期间页面会短暂断开。', '重启')) run('restart', {}, '重启'); };
    const clear = async what => { if (await confirmBox(what === 'covers' ? '清理封面和图片缓存？' : '清理转码缓存？', what === 'covers' ? '会自动重启服务, 封面按需重新生成。' : '正在转码的会停掉, 下次播放时重新转。', '清理')) run('clear', { what }, '清理'); };
    const ver = computed(() => { const v = st.value && st.value.ver; return !v ? '' : v.mode === 'git' ? `git · ${v.branch} @ ${v.short}${v.subject ? ' · ' + v.subject.slice(0, 50) : ''}${v.dirty ? '（有未提交的改动）' : ''}` : (v.version || v.mode || ''); });
    return { st, busy, checkErr, running, check, update, restart, clear, ver, fmtSize, fmtUp };
  },
  template: `<div>
    <h2>系统</h2>
    <div v-if="!st" class="muted">加载中…</div>
    <div v-else-if="st.authed === false" class="card">需要管理员权限。</div>
    <template v-else>
      <div class="card"><div class="kv">
        <span>版本</span><div>{{ ver || '—' }}</div>
        <span>更新</span><div>{{ st.update ? (st.update.available ? '有新版本' + (st.update.latest ? ' ' + st.update.latest : '') : '已是最新') : '未检查' }}<span class="muted small" v-if="checkErr"> · {{ checkErr }}</span></div>
        <span>运行</span><div>已运行 {{ fmtUp(st.uptime) }} · {{ st.workers }} 个进程 · Node {{ st.node }} · {{ st.ffmpeg ? 'ffmpeg ✓' : '无 ffmpeg' }}<span v-if="!st.canRestart" class="tag amber" style="margin-left:6px">不能自动重启</span></div>
        <span>缓存</span><div>转码 {{ fmtSize(st.caches.transcode) }} · 封面图片 {{ fmtSize(st.caches.covers) }}</div>
      </div></div>
      <div class="row gap">
        <button class="btn" :disabled="running || !!busy" @click="check">检查更新</button>
        <button class="btn red" :disabled="running || !!busy" @click="update">更新并重启</button>
        <button class="btn" :disabled="running || !!busy || !st.canRestart" @click="restart">重启服务</button>
      </div>
      <h3>清理缓存</h3>
      <div class="row gap"><button class="btn" :disabled="running || !!busy" @click="clear('transcode')">清理转码缓存</button><button class="btn" :disabled="running || !!busy || !st.canRestart" @click="clear('covers')">清理封面缓存（会重启）</button></div>
      <template v-if="st.job">
        <h3>任务</h3>
        <div class="card"><b>{{ ({ update: '更新', restart: '重启', clear: '清理缓存', rotate: '换令牌' })[st.job.kind] || st.job.kind }}</b> · <span :class="st.job.status === 'error' ? 'tag red' : 'tag'">{{ st.job.status }}</span>
          <div class="bar" v-if="st.job.progress && st.job.progress.total"><i :style="{ width: Math.min(100, st.job.progress.done / st.job.progress.total * 100) + '%' }"></i></div>
          <pre class="log" v-if="st.job.log && st.job.log.length">{{ st.job.log.join('\\n') }}</pre></div>
      </template>
    </template>
  </div>`
};

// ---------- 登录门 ----------
const Gate = {
  props: ['me'],
  emits: ['done'],
  setup(props, { emit }) {
    const f = reactive({ username: '', password: '', token: '' }), busy = ref(false), mode = ref(props.me.user ? 'claim' : 'login');
    const run = async fn => { busy.value = true; try { await fn(); } catch (e) { oops(e); } finally { busy.value = false; } };
    const login = () => run(async () => { const r = await post('acct/login', { username: f.username, password: f.password }); enroll(r.user, r.token); emit('done'); });
    const tokenLogin = () => run(async () => { await post('admin/login', { token: f.token }); emit('done'); });
    const claim = () => run(async () => { await post('acct/claim', { token: f.token }); toast('已升为管理员'); emit('done'); });
    const other = () => { leaveAccount(); mode.value = 'login'; emit('done'); };
    return { f, busy, mode, login, tokenLogin, claim, other };
  },
  template: `<div class="gate">
    <div class="logo">TVBOX</div><div class="sub">管理后台</div>
    <div class="card" v-if="me.user">
      <p style="margin-top:0">当前登录的是「<b>{{ me.user.name }}</b>」, 它还不是管理员。</p>
      <label class="fld"><span>输入管理员令牌, 把它升为管理员</span><input type="password" v-model="f.token" placeholder="管理员令牌" autocomplete="off" @keyup.enter="claim"></label>
      <div class="row"><button class="btn red" :disabled="busy || !f.token" @click="claim">升为管理员</button><button class="btn ghost" @click="other">换个账号</button><a class="btn ghost" href="/">回到网站</a></div>
      <p class="muted small">管理员令牌在服务启动窗口里显示, 也存在 web/.env 的 TVBOX_ADMIN_TOKEN。</p>
    </div>
    <template v-else>
      <div class="seg" style="margin-bottom:12px"><button :class="{ on: mode === 'login' }" @click="mode = 'login'">管理员账号</button><button :class="{ on: mode === 'token' }" @click="mode = 'token'">管理员令牌</button></div>
      <div class="card" v-if="mode === 'login'">
        <label class="fld"><span>用户名</span><input type="text" v-model.trim="f.username" autocomplete="username" autocapitalize="off"></label>
        <label class="fld"><span>密码</span><input type="password" v-model="f.password" autocomplete="current-password" @keyup.enter="login"></label>
        <div class="row"><button class="btn red" :disabled="busy || !f.username || !f.password" @click="login">登录</button><a class="btn ghost" href="/">回到网站</a></div>
        <p class="muted small">用管理员账号登录。还没有管理员？先在网站里注册账号, 再到「设置 → 账号管理」用管理员令牌升级。</p>
      </div>
      <div class="card" v-else>
        <label class="fld"><span>管理员令牌</span><input type="password" v-model="f.token" autocomplete="off" @keyup.enter="tokenLogin"></label>
        <div class="row"><button class="btn red" :disabled="busy || !f.token" @click="tokenLogin">进入</button><a class="btn ghost" href="/">回到网站</a></div>
        <p class="muted small">令牌方式没有账号身份: 能管理账号和源, 但不能改自己的级别。</p>
      </div>
    </template>
  </div>`
};

// ---------- 根 ----------
const TABS = [
  ['overview', '概览', '<path d="M4 13h6V4H4zM14 20h6V4h-6zM4 20h6v-3H4z"/>'],
  ['users', '账号', '<circle cx="12" cy="8" r="3.6"/><path d="M5 20c0-3.6 3-6 7-6s7 2.4 7 6"/>'],
  ['vod', '点播源', '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 9.5v5l4.5-2.5z"/>'],
  ['live', '直播源', '<circle cx="12" cy="12" r="2"/><path d="M7.5 7.5a6.4 6.4 0 0 0 0 9M16.5 7.5a6.4 6.4 0 0 1 0 9M4.5 4.5a10.5 10.5 0 0 0 0 15M19.5 4.5a10.5 10.5 0 0 1 0 15"/>'],
  ['system', '系统', '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/>'],
];
const App = {
  components: { Overview, Users, Sources, System, Gate, Avatar },
  setup() {
    const me = ref(null), tab = ref((location.hash || '#overview').slice(1));
    if (!TABS.some(t => t[0] === tab.value)) tab.value = 'overview';
    const load = async () => { try { me.value = await get('console/me'); } catch (e) { me.value = { admin: false, error: e.message }; } };
    onMounted(load);
    watch(tab, v => { history.replaceState(null, '', '#' + v); window.scrollTo(0, 0); });
    window.addEventListener('hashchange', () => { const h = location.hash.slice(1); if (h !== tab.value && TABS.some(t => t[0] === h)) tab.value = h; });
    window.addEventListener('beforeunload', e => { if (dirty.value) { e.preventDefault(); e.returnValue = ''; } });
    const go = t => { if (t === tab.value) return; if (dirty.value && /^(vod|live)$/.test(tab.value) && !/^(vod|live)$/.test(t)) toast('源的修改还没保存', true); tab.value = t; };
    const logout = async () => { await post('admin/logout').catch(() => {}); if (me.value.user) leaveAccount(); location.reload(); };
    return { me, tab, TABS, go, load, logout, toast: toastState, dlg, dlgDone, LV, hue };
  },
  template: `
  <div v-if="!me" class="boot">加载中…</div>
  <Gate v-else-if="!me.admin" :me="me" @done="load" />
  <div v-else class="shell">
    <header class="top"><h1>TV<b>BOX</b> 管理后台</h1><span class="grow"></span>
      <div class="who"><span v-if="me.user">{{ me.user.name }} · {{ LV[me.level] }}</span><span v-else>管理员令牌</span><a class="btn sm ghost" href="/">网站</a><button class="btn sm ghost" @click="logout">退出</button></div></header>
    <nav class="tabs"><button v-for="t in TABS" :key="t[0]" :class="{ on: tab === t[0] }" @click="go(t[0])"><svg viewBox="0 0 24 24" v-html="t[2]"></svg><span>{{ t[1] }}</span></button></nav>
    <main>
      <Overview v-if="tab === 'overview'" @go="go" />
      <Users v-else-if="tab === 'users'" :me="me" />
      <Sources v-else-if="tab === 'vod'" kind="vod" />
      <Sources v-else-if="tab === 'live'" kind="live" />
      <System v-else-if="tab === 'system'" />
    </main>
  </div>
  <div class="toast" :class="{ err: toast.err }" v-if="toast.text">{{ toast.text }}</div>
  <div class="mask" v-if="dlg.open" @click.self="dlgDone(false)"><div class="sheet" role="dialog">
    <h3 v-if="dlg.title">{{ dlg.title }}</h3><p v-if="dlg.text" class="muted" style="margin-top:0">{{ dlg.text }}</p>
    <input v-if="dlg.kind === 'prompt'" :type="dlg.type" v-model="dlg.value" :placeholder="dlg.placeholder" autocomplete="off" @keyup.enter="dlgDone(true)" autofocus>
    <div class="acts"><button class="btn" @click="dlgDone(false)">取消</button><button class="btn" :class="dlg.danger ? 'danger' : 'red'" @click="dlgDone(true)">{{ dlg.okText }}</button></div>
  </div></div>`
};

createApp(App).mount('#app');
