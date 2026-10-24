// Forgot the 家长 PIN? Run this on the computer that runs the server:   node reset-pin.js
// It clears the PIN in data/safety.json (the 安全级别 stays as it is). Restart the server afterwards.
const fs = require('fs'), path = require('path');
const file = path.join(process.env.TVBOX_DATA || path.join(__dirname, 'data'), 'safety.json');
let s = { level: 'standard', pin: '' };
try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
if (!s.pin) { console.log('当前没有设置 PIN。'); process.exit(0); }
s.pin = '';
fs.writeFileSync(file, JSON.stringify(s, null, 1));
console.log('PIN 已清除（安全级别仍是「' + s.level + '」）。请重启服务后生效。');
