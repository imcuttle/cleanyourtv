// 管理员令牌 TVBOX_ADMIN_TOKEN：web/.env 里没有就生成一个并写回 .env（只在缺的时候）。网页不再有「访问令牌」，打开不需要口令；
// 管理员令牌只用来把某个账号升为管理员、登录管理后台、重启 / 更新服务。
// start.command / start.bat 和 server.js 都调它，所以 `npm run web`、`node server.js` 直接启动也一样。
//   node -e "process.stdout.write(require('./auth').ensureToken().adminToken)"   → 打印管理员令牌（必要时先生成）
// 换令牌：删掉 .env 里的 TVBOX_ADMIN_TOKEN 那一行，重启即可。
// .env 里的其它 KEY=VALUE（PORT、HOST、WORKERS …）也会读进来，但不会覆盖已有的环境变量。
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ENV_FILE = process.env.TVBOX_ENV || path.join(__dirname, '.env');
const ADMIN_KEY = 'TVBOX_ADMIN_TOKEN';   // 管理员令牌：重启 / 更新服务。和访问令牌分开，没有就生成

function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue; // 空行 / # 注释
    let v = m[2];
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}

let cached = null;
// 在 .env 里补一行 KEY=value (已有同名行就替换)；返回 {persisted}
function writeKey(text, key, value, header) {
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const line = `${key}=${value}`;
  const re = new RegExp(`^(\\s*(?:export\\s+)?)${key}\\s*=.*$`, 'm');
  if (re.test(text)) text = text.replace(re, (_, p) => p + line);
  else {
    if (!text) text = header.join(nl) + nl;
    else if (!/\n$/.test(text)) text += nl;
    text += line + nl;
  }
  return text;
}
function ensureToken() {
  if (cached) return cached;
  let text = '';
  try { text = fs.readFileSync(ENV_FILE, 'utf8'); } catch {}
  const env = parseEnv(text);
  for (const [k, v] of Object.entries(env)) if (k !== 'TVBOX_TOKEN' && k !== ADMIN_KEY && process.env[k] === undefined) process.env[k] = v;   // 老 .env 里的 TVBOX_TOKEN (访问令牌) 已经不用了

  const header = ['# TVBox 网页版令牌。', '# TVBOX_ADMIN_TOKEN  管理员令牌：设置页「账号管理」里输入可把账号升为管理员；「管理后台」登录、重启 / 更新服务也用它。', '# 换令牌：删掉这一行，重启服务。'];
  let createdAdmin = false, dirty = false;
  let adminToken = (process.env[ADMIN_KEY] || env[ADMIN_KEY] || '').trim();
  if (!adminToken) { adminToken = crypto.randomBytes(24).toString('base64url'); createdAdmin = true; text = writeKey(text, ADMIN_KEY, adminToken, header); dirty = true; }
  let persisted = true;
  if (dirty) {
    try { fs.writeFileSync(ENV_FILE, text, { mode: 0o600 }); }
    catch (e) { persisted = false; console.error(`  [auth] 写不进 ${ENV_FILE}（${e.message}），这次的令牌只在本次运行有效`); }
    if (persisted) console.error(`  [auth] 已生成管理员令牌，保存在 ${ENV_FILE}`);
  }
  process.env[ADMIN_KEY] = adminToken;
  return (cached = { adminToken, createdAdmin, persisted, file: ENV_FILE });
}

// 换一个新令牌 (写回 .env)，返回新值；调用方负责重启让所有进程用上它。
function rotate(key) {
  if (key !== ADMIN_KEY) throw new Error('unknown key');
  let text = '';
  try { text = fs.readFileSync(ENV_FILE, 'utf8'); } catch {}
  const value = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(ENV_FILE, writeKey(text, key, value, ['# TVBox 网页版令牌。']), { mode: 0o600 });
  return value;
}

module.exports = { ensureToken, rotate, ENV_FILE, ADMIN_KEY };
