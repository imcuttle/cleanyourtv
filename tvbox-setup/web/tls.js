// HTTPS 证书。手机上「系统分享面板」(navigator.share)、Service Worker、剪贴板等能力都只在安全上下文 (https / localhost) 里才有，
// 局域网里的 http://192.168.x.x 不算，所以服务启动时同时开 https：默认和 http 共用 PORT (按连接的第一个字节区分, 见 server.js 的 front)，
// 设了 HTTPS_PORT 且不等于 PORT 时才单独监听那个端口。
//   - 自己有证书：TVBOX_TLS_CERT=/path/fullchain.pem TVBOX_TLS_KEY=/path/privkey.pem  (域名证书，手机上不会有警告，推荐)
//   - 没有：用系统自带的 openssl 生成自签名证书，存在 data/tls/，包含 localhost / 本机局域网 IP / 主机名 (本机 IP 变了会自动重新生成)。
//     自签名证书浏览器第一次会提示「不安全」，手动继续即可；iOS 想完全无提示要把 data/tls/cert.pem 装成描述文件并在「证书信任设置」里打开。
//   - TVBOX_HTTPS=0 关闭 https。没有 openssl (比如 Windows) 又没给证书：只打印一行提示，http 照常。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const DATA = process.env.TVBOX_DATA || path.join(__dirname, 'data');
const DIR = path.join(DATA, 'tls');

const lanIps = () => Object.values(os.networkInterfaces()).flat()
  .filter(i => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.')).map(i => i.address);
const names = () => {
  const h = os.hostname().replace(/\.local$/i, '').replace(/[^\w-]/g, '');
  return ['localhost', ...(h ? [h, h + '.local'] : [])];
};

// → { cert, key, source: 'env' | 'self-signed' } | { error } | null (关闭)
function load() {
  if (process.env.TVBOX_HTTPS === '0') return null;
  const own = { cert: process.env.TVBOX_TLS_CERT, key: process.env.TVBOX_TLS_KEY };
  if (own.cert || own.key) {
    try { return { cert: fs.readFileSync(own.cert), key: fs.readFileSync(own.key), source: 'env' }; }
    catch (e) { return { error: 'TVBOX_TLS_CERT / TVBOX_TLS_KEY 读不了：' + e.message }; }
  }
  const sans = [...names().map(n => 'DNS:' + n), 'IP:127.0.0.1', 'IP:::1', ...lanIps().map(ip => 'IP:' + ip)];
  const certF = path.join(DIR, 'cert.pem'), keyF = path.join(DIR, 'key.pem'), sanF = path.join(DIR, 'sans.txt');
  const want = sans.join(',');
  const have = () => { try { return fs.readFileSync(sanF, 'utf8') === want && fs.existsSync(certF) && fs.existsSync(keyF); } catch { return false; } };
  if (!have()) {
    try {
      fs.mkdirSync(DIR, { recursive: true });
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '825',
        '-keyout', keyF, '-out', certF, '-subj', '/CN=TVBox', '-addext', 'subjectAltName=' + want, '-addext', 'keyUsage=digitalSignature',
        '-addext', 'extendedKeyUsage=serverAuth'], { stdio: 'pipe', windowsHide: true, timeout: 20e3 });
      try { fs.chmodSync(keyF, 0o600); } catch {}
      fs.writeFileSync(sanF, want);
    } catch (e) {
      return { error: e.code === 'ENOENT' ? '没找到 openssl，没法生成自签名证书；装上 openssl，或用 TVBOX_TLS_CERT / TVBOX_TLS_KEY 指定证书' : '生成证书失败：' + String(e.stderr || e.message).trim().split('\n').pop() };
    }
  }
  try { return { cert: fs.readFileSync(certF), key: fs.readFileSync(keyF), source: 'self-signed' }; }
  catch (e) { return { error: '读证书失败：' + e.message }; }
}

module.exports = { load, DIR };
