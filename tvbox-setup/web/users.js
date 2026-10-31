// 账号 (SQLite)：用户名 + 密码注册，多账号切换；观看历史 / 进度、收藏、直播收藏、推荐偏好都按账号隔离。
// 用 Node 自带的 node:sqlite (Node >= 22.13 不用加参数)，零依赖。数据库 data/users.sqlite，只由 leader 进程读写
// (其它 worker 通过 rpc 找它)，所以没有多进程抢写的问题。Node 太旧 / 没有 node:sqlite 时账号功能整体关闭，网页退回「访客」模式。
//
// 接口 (都在 /api/acct/ 下，会话令牌放 X-Session 请求头)：
//   GET  status            -> { enabled, register }            不需要登录
//   POST register          {username, password, import?}       -> { user, token }
//   POST login             {username, password}                -> { user, token }
//   POST logout                                                -> { ok }
//   GET  me                                                    -> { user, stats }
//   GET  sync                                                  -> { user, history, favs, liveFavs, kv }
//   POST ops               {ops:[…]}                           -> { ok, applied }   (客户端的改动队列，按顺序执行)
//   POST import            {history, favs, liveFavs, kv}       -> { ok, stats }      (把访客数据并入当前账号)
//   POST password          {old, next}                         -> { ok }
//   POST clear             {what: history|favs|liveFavs|kv|all}-> { ok, stats }
//   POST delete            {password}                          -> { ok }
'use strict';
const crypto = require('crypto');
const path = require('path');

const NAME_RE = /^[\p{L}\p{N}_-]{2,20}$/u;
const MIN_PW = 6, MAX_PW = 64;
const HIST_KEEP = 100, FAV_KEEP = 800, LFAV_KEEP = 800;
const KV_KEYS = new Set(['feedProf', 'feedSeen', 'feedLikes', 'recentSearches', 'favCols']);   // favCols: 收藏合集 [{id,name,at}]; 哪部片在哪些合集里写在收藏条目自己的 cols 字段里
const KV_MAX = 200e3;
const ENTRY_MAX = 8e3;
const SESSION_DAYS = 365;
const MAX_USERS = 200;

const str = v => (v === undefined || v === null ? '' : String(v));
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const scrypt = (pw, salt) => new Promise((ok, bad) => crypto.scrypt(pw, salt, 32, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? bad(e) : ok(k))));

function loadSqlite() {
  // node:sqlite 在 22.x 里还会打一条 ExperimentalWarning，对用户没用，吞掉这一条。
  const emit = process.emitWarning;
  process.emitWarning = function (w, ...a) { if (/SQLite/i.test(str(w && w.message || w))) return; return emit.call(process, w, ...a); };
  try { return require('node:sqlite'); } catch { return null; } finally { process.emitWarning = emit; }
}

module.exports = function createUsers({ file, allowRegister = true }) {
  const sqlite = loadSqlite();
  if (!sqlite) {
    const off = { code: 501, body: { enabled: false, error: '服务端的 Node 太旧（需要 22.13 以上，带 node:sqlite），账号功能没有开启' } };
    return { enabled: false, handle: async ({ sub }) => (sub === 'status' ? { body: { enabled: false } } : off) };
  }
  let db = null;
  const open = () => {
    if (db) return db;
    db = new sqlite.DatabaseSync(file);
    db.exec(`
      PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS users(
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, name_lc TEXT NOT NULL UNIQUE,
        salt BLOB NOT NULL, hash BLOB NOT NULL, created INTEGER NOT NULL, last_seen INTEGER);
      CREATE TABLE IF NOT EXISTS sessions(
        token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created INTEGER NOT NULL, last_used INTEGER NOT NULL, ua TEXT);
      CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
      CREATE TABLE IF NOT EXISTS history(
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, site TEXT NOT NULL, vid TEXT NOT NULL,
        at INTEGER NOT NULL, t REAL, dur REAL, data TEXT NOT NULL, PRIMARY KEY(user_id, site, vid));
      CREATE INDEX IF NOT EXISTS history_at ON history(user_id, at DESC);
      CREATE TABLE IF NOT EXISTS favorites(
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, site TEXT NOT NULL, vid TEXT NOT NULL,
        at INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(user_id, site, vid));
      CREATE INDEX IF NOT EXISTS favorites_at ON favorites(user_id, at DESC);
      CREATE TABLE IF NOT EXISTS live_favs(
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, url TEXT NOT NULL,
        at INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(user_id, url));
      CREATE TABLE IF NOT EXISTS kv(
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, k TEXT NOT NULL, v TEXT NOT NULL,
        at INTEGER NOT NULL, PRIMARY KEY(user_id, k));
    `);
    return db;
  };
  const q = (sql, ...a) => open().prepare(sql).all(...a);
  const one = (sql, ...a) => open().prepare(sql).get(...a);
  const run = (sql, ...a) => open().prepare(sql).run(...a);
  const tx = fn => { open().exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; } };

  const fail = (code, error, extra = {}) => ({ code, body: { error, ...extra } });
  const userView = u => ({ id: u.id, name: u.name, created: u.created });
  const stats = uid => ({
    history: one('SELECT COUNT(*) n FROM history WHERE user_id=?', uid).n,
    favs: one('SELECT COUNT(*) n FROM favorites WHERE user_id=?', uid).n,
    liveFavs: one('SELECT COUNT(*) n FROM live_favs WHERE user_id=?', uid).n,
    lastSeen: one('SELECT last_seen s FROM users WHERE id=?', uid)?.s || 0,
  });

  // ---- 登录失败限速 (用户名 + 来源各自计数)：5 分钟内错 8 次，锁 5 分钟 ----
  const tries = new Map();
  const tryKey = (name, ip) => name.toLowerCase() + '|' + ip;
  const locked = k => { const t = tries.get(k); return !!t && t.n >= 8 && t.until > Date.now(); };
  const miss = k => { const t = tries.get(k); const x = t && t.until > Date.now() ? t : { n: 0, until: Date.now() + 5 * 60e3 }; x.n++; tries.set(k, x); if (tries.size > 2000) tries.delete(tries.keys().next().value); };
  const hit = k => tries.delete(k);

  async function hashPw(pw) { const salt = crypto.randomBytes(16); return { salt, hash: await scrypt(pw, salt) }; }
  async function checkPw(u, pw) { const h = await scrypt(pw, u.salt); return h.length === u.hash.length && crypto.timingSafeEqual(h, u.hash); }

  function newSession(uid, ua) {
    const token = 'tv_' + crypto.randomBytes(32).toString('base64url'), now = Date.now();
    run('INSERT INTO sessions(token_hash, user_id, created, last_used, ua) VALUES(?,?,?,?,?)', sha(token), uid, now, now, str(ua).slice(0, 200));
    return token;
  }
  // 会话 -> 用户。一年没用的会话作废；last_used 每小时最多写一次
  function auth(token) {
    token = str(token);
    if (!token || token.length > 200) return null;
    const s = one('SELECT s.token_hash h, s.last_used lu, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?', sha(token));
    if (!s) return null;
    const now = Date.now();
    if (now - s.lu > SESSION_DAYS * 864e5) { run('DELETE FROM sessions WHERE token_hash=?', s.h); return null; }
    if (now - s.lu > 3600e3) { run('UPDATE sessions SET last_used=? WHERE token_hash=?', now, s.h); run('UPDATE users SET last_seen=? WHERE id=?', now, s.id); }
    return s;
  }

  // ---- 数据条目的检查 ----
  const text = (v, n = 300) => str(v).slice(0, n);
  function cleanEntry(e) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return null;
    const j = JSON.stringify(e);
    if (j.length > ENTRY_MAX) return null;
    return j;
  }
  const atOf = e => (Number.isFinite(+e.at) && +e.at > 0 ? Math.min(+e.at, Date.now() + 864e5) : Date.now());

  const put = {
    hist(uid, e) {
      const data = cleanEntry(e); if (!data || !text(e.site) || !text(e.id)) return;
      run(`INSERT INTO history(user_id, site, vid, at, t, dur, data) VALUES(?,?,?,?,?,?,?)
           ON CONFLICT(user_id, site, vid) DO UPDATE SET at=excluded.at, t=excluded.t, dur=excluded.dur, data=excluded.data`,
      uid, text(e.site), text(e.id), atOf(e), +e.t || 0, +e.dur || 0, data);
      run(`DELETE FROM history WHERE user_id=? AND rowid NOT IN (SELECT rowid FROM history WHERE user_id=? ORDER BY at DESC LIMIT ${HIST_KEEP})`, uid, uid);
    },
    fav(uid, e) {
      const data = cleanEntry(e); if (!data || !text(e.site) || !text(e.id)) return;
      run(`INSERT INTO favorites(user_id, site, vid, at, data) VALUES(?,?,?,?,?)
           ON CONFLICT(user_id, site, vid) DO UPDATE SET at=excluded.at, data=excluded.data`, uid, text(e.site), text(e.id), atOf(e), data);
      run(`DELETE FROM favorites WHERE user_id=? AND rowid NOT IN (SELECT rowid FROM favorites WHERE user_id=? ORDER BY at DESC LIMIT ${FAV_KEEP})`, uid, uid);
    },
    lfav(uid, e) {
      const data = cleanEntry(e); if (!data || !/^[^\s]{1,1000}$/.test(str(e.url))) return;
      run(`INSERT INTO live_favs(user_id, url, at, data) VALUES(?,?,?,?)
           ON CONFLICT(user_id, url) DO UPDATE SET at=excluded.at, data=excluded.data`, uid, str(e.url), atOf(e), data);
      run(`DELETE FROM live_favs WHERE user_id=? AND rowid NOT IN (SELECT rowid FROM live_favs WHERE user_id=? ORDER BY at DESC LIMIT ${LFAV_KEEP})`, uid, uid);
    },
    kv(uid, k, v) {
      if (!KV_KEYS.has(k)) return;
      v = str(v); if (v.length > KV_MAX) return;
      run(`INSERT INTO kv(user_id, k, v, at) VALUES(?,?,?,?) ON CONFLICT(user_id, k) DO UPDATE SET v=excluded.v, at=excluded.at`, uid, k, v, Date.now());
    },
  };
  function applyOp(uid, o) {
    if (!o || typeof o !== 'object') return false;
    switch (o.t) {
      case 'hist.put': put.hist(uid, o.e); return true;
      case 'hist.del': run('DELETE FROM history WHERE user_id=? AND site=? AND vid=?', uid, text(o.site), text(o.id)); return true;
      case 'hist.clear': run('DELETE FROM history WHERE user_id=?', uid); return true;
      case 'fav.put': put.fav(uid, o.e); return true;
      case 'fav.del': run('DELETE FROM favorites WHERE user_id=? AND site=? AND vid=?', uid, text(o.site), text(o.id)); return true;
      case 'fav.clear': run('DELETE FROM favorites WHERE user_id=?', uid); return true;
      case 'lfav.put': put.lfav(uid, o.e); return true;
      case 'lfav.del': run('DELETE FROM live_favs WHERE user_id=? AND url=?', uid, str(o.url)); return true;
      case 'kv.set': put.kv(uid, text(o.k, 40), o.v); return true;
      case 'kv.del': run('DELETE FROM kv WHERE user_id=? AND k=?', uid, text(o.k, 40)); return true;
    }
    return false;
  }
  // 访客数据并入账号：同一部片取较新的一条
  function importData(uid, b) {
    const newer = (table, site, id, at) => { const r = one(`SELECT at FROM ${table} WHERE user_id=? AND site=? AND vid=?`, uid, site, id); return !r || r.at < at; };
    for (const e of (Array.isArray(b.history) ? b.history : []).slice(0, HIST_KEEP)) if (e && newer('history', text(e.site), text(e.id), atOf(e))) put.hist(uid, e);
    for (const e of (Array.isArray(b.favs) ? b.favs : []).slice(0, FAV_KEEP)) if (e && newer('favorites', text(e.site), text(e.id), atOf(e))) put.fav(uid, e);
    for (const e of (Array.isArray(b.liveFavs) ? b.liveFavs : []).slice(0, LFAV_KEEP)) if (e) put.lfav(uid, { ...e, at: e.at || Date.now() });
    const kv = b.kv && typeof b.kv === 'object' ? b.kv : {};
    for (const k of KV_KEYS) if (typeof kv[k] === 'string' && !one('SELECT 1 x FROM kv WHERE user_id=? AND k=?', uid, k)) put.kv(uid, k, kv[k]);
  }
  const parse = r => { try { return JSON.parse(r.data); } catch { return null; } };
  function snapshot(uid) {
    return {
      history: q('SELECT data FROM history WHERE user_id=? ORDER BY at DESC', uid).map(parse).filter(Boolean),
      favs: q('SELECT data FROM favorites WHERE user_id=? ORDER BY at DESC', uid).map(parse).filter(Boolean),
      liveFavs: q('SELECT data FROM live_favs WHERE user_id=? ORDER BY at DESC', uid).map(parse).filter(Boolean),
      kv: Object.fromEntries(q('SELECT k, v FROM kv WHERE user_id=?', uid).map(r => [r.k, r.v])),
    };
  }

  async function handle({ sub, method, body = {}, session = '', ip = '', ua = '' }) {
    try { open(); } catch (e) { return fail(500, '账号数据库打不开：' + e.message); }
    const write = method !== 'GET';
    if (sub === 'status') return { body: { enabled: true, register: allowRegister, users: one('SELECT COUNT(*) n FROM users').n } };

    if (sub === 'register' && write) {
      if (!allowRegister) return fail(403, '这台服务器没有开放注册（环境变量 TVBOX_ALLOW_REGISTER=0）');
      const name = str(body.username).normalize('NFKC').trim(), pw = str(body.password);
      if (!NAME_RE.test(name)) return fail(400, '用户名 2~20 个字：中英文、数字、下划线或减号');
      if (pw.length < MIN_PW || pw.length > MAX_PW) return fail(400, `密码 ${MIN_PW}~${MAX_PW} 位`);
      const k = tryKey('reg', ip);
      if (locked(k)) return fail(429, '操作太频繁，稍后再试');
      if (one('SELECT COUNT(*) n FROM users').n >= MAX_USERS) return fail(403, `账号数量到上限了（${MAX_USERS}）`);
      if (one('SELECT 1 x FROM users WHERE name_lc=?', name.toLowerCase())) { miss(k); return fail(409, '这个用户名已经有人用了'); }
      const { salt, hash } = await hashPw(pw);
      let uid, token;
      try {
        tx(() => {
          const now = Date.now();
          uid = Number(run('INSERT INTO users(name, name_lc, salt, hash, created, last_seen) VALUES(?,?,?,?,?,?)', name, name.toLowerCase(), salt, hash, now, now).lastInsertRowid);
          if (body.import && typeof body.import === 'object') importData(uid, body.import);
          token = newSession(uid, ua);
        });
      } catch (e) { return fail(/UNIQUE/i.test(e.message) ? 409 : 500, /UNIQUE/i.test(e.message) ? '这个用户名已经有人用了' : '注册失败：' + e.message); }
      return { body: { user: userView(one('SELECT * FROM users WHERE id=?', uid)), token, stats: stats(uid) } };
    }

    if (sub === 'login' && write) {
      const name = str(body.username).normalize('NFKC').trim(), pw = str(body.password), k = tryKey(name, ip);
      if (locked(k)) return fail(429, '密码错误次数太多，5 分钟后再试');
      const u = one('SELECT * FROM users WHERE name_lc=?', name.toLowerCase());
      // 用户不存在也走一遍 scrypt，响应时间不泄露「有没有这个用户」
      const ok = u ? await checkPw(u, pw) : (await scrypt(pw, Buffer.alloc(16)), false);
      if (!ok) { miss(k); return fail(401, '用户名或密码不对', { login: true }); }
      hit(k);
      run('UPDATE users SET last_seen=? WHERE id=?', Date.now(), u.id);
      return { body: { user: userView(u), token: newSession(u.id, ua), stats: stats(u.id) } };
    }

    // ---- 以下都要会话 ----
    const me = auth(session || body.session);
    if (!me) return fail(401, '登录已失效，请重新登录', { session: false });

    if (sub === 'logout' && write) { run('DELETE FROM sessions WHERE token_hash=?', sha(str(session || body.session))); return { body: { ok: true } }; }
    if (sub === 'me') return { body: { user: userView(me), stats: stats(me.id) } };
    if (sub === 'sync') return { body: { user: userView(me), ...snapshot(me.id), stats: stats(me.id) } };

    if (sub === 'ops' && write) {
      const ops = (Array.isArray(body.ops) ? body.ops : []).slice(0, 300);
      let n = 0;
      tx(() => { for (const o of ops) if (applyOp(me.id, o)) n++; });
      return { body: { ok: true, applied: n } };
    }
    if (sub === 'import' && write) { tx(() => importData(me.id, body)); return { body: { ok: true, stats: stats(me.id), ...snapshot(me.id) } }; }
    if (sub === 'clear' && write) {
      const what = str(body.what);
      tx(() => {
        if (what === 'history' || what === 'all') run('DELETE FROM history WHERE user_id=?', me.id);
        if (what === 'favs' || what === 'all') { run('DELETE FROM favorites WHERE user_id=?', me.id); run("DELETE FROM kv WHERE user_id=? AND k='favCols'", me.id); }
        if (what === 'liveFavs' || what === 'all') run('DELETE FROM live_favs WHERE user_id=?', me.id);
        if (what === 'kv' || what === 'all') run('DELETE FROM kv WHERE user_id=?', me.id);
      });
      return { body: { ok: true, stats: stats(me.id) } };
    }
    if (sub === 'password' && write) {
      const next = str(body.next);
      if (next.length < MIN_PW || next.length > MAX_PW) return fail(400, `新密码 ${MIN_PW}~${MAX_PW} 位`);
      const k = tryKey(me.name, ip);
      if (locked(k)) return fail(429, '密码错误次数太多，5 分钟后再试');
      if (!await checkPw(me, str(body.old))) { miss(k); return fail(403, '旧密码不对'); }
      hit(k);
      const { salt, hash } = await hashPw(next);
      tx(() => { run('UPDATE users SET salt=?, hash=? WHERE id=?', salt, hash, me.id); run('DELETE FROM sessions WHERE user_id=? AND token_hash<>?', me.id, me.h); });
      return { body: { ok: true } };
    }
    if (sub === 'delete' && write) {
      const k = tryKey(me.name, ip);
      if (locked(k)) return fail(429, '密码错误次数太多，5 分钟后再试');
      if (!await checkPw(me, str(body.password))) { miss(k); return fail(403, '密码不对'); }
      hit(k);
      run('DELETE FROM users WHERE id=?', me.id);   // 外键级联：会话、历史、收藏、偏好一起删
      return { body: { ok: true } };
    }
    return fail(404, 'unknown api');
  }
  return { enabled: true, handle, file };
};
module.exports.defaultFile = dataDir => path.join(dataDir, 'users.sqlite');
