// 访问令牌：web/.env 里的 TVBOX_TOKEN。没有就生成一个并写回 .env（只在第一次）。
// start.command / start.bat 和 server.js 都调它，所以 `npm run web`、`node server.js` 直接启动也一样。
//   node -e "process.stdout.write(require('./auth').ensureToken().token)"   → 打印令牌（必要时先生成）
// 换令牌：删掉 .env 里的 TVBOX_TOKEN 那一行，重启即可（所有浏览器要重新输入一次）。
// .env 里的其它 KEY=VALUE（PORT、HOST、WORKERS …）也会读进来，但不会覆盖已有的环境变量。
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ENV_FILE = process.env.TVBOX_ENV || path.join(__dirname, '.env');
const KEY = 'TVBOX_TOKEN';

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
function ensureToken() {
  if (cached) return cached;
  let text = '';
  try { text = fs.readFileSync(ENV_FILE, 'utf8'); } catch {}
  const env = parseEnv(text);
  for (const [k, v] of Object.entries(env)) if (k !== KEY && process.env[k] === undefined) process.env[k] = v;

  let token = (process.env[KEY] || env[KEY] || '').trim();
  let created = false, persisted = true;
  if (!token) {
    token = crypto.randomBytes(24).toString('base64url'); // 32 个字符，URL 安全
    created = true;
    const nl = text.includes('\r\n') ? '\r\n' : '\n';
    const line = `${KEY}=${token}`;
    if (new RegExp(`^\\s*(?:export\\s+)?${KEY}\\s*=.*$`, 'm').test(text)) {
      text = text.replace(new RegExp(`^(\\s*(?:export\\s+)?)${KEY}\\s*=.*$`, 'm'), (_, p) => p + line);
    } else {
      if (!text) text = `# TVBox 网页版访问令牌。浏览器第一次打开要输入它，之后会一直记住。${nl}# 换令牌：删掉下面这一行，重启服务。${nl}`;
      else if (!/\n$/.test(text)) text += nl;
      text += line + nl;
    }
    try { fs.writeFileSync(ENV_FILE, text, { mode: 0o600 }); }
    catch (e) { persisted = false; console.error(`  [auth] 写不进 ${ENV_FILE}（${e.message}），这次的令牌只在本次运行有效`); }
    if (persisted) console.error(`  [auth] 第一次启动：已生成访问令牌，保存在 ${ENV_FILE}`);
  }
  process.env[KEY] = token;
  return (cached = { token, created, persisted, file: ENV_FILE });
}

module.exports = { ensureToken, ENV_FILE, KEY };
