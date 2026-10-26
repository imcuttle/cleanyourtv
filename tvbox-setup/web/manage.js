#!/usr/bin/env node
// TVBox 网页版 — 管理入口 (macOS: manage.command · Windows: manage.bat 双击打开)。
//   ↑↓ 选择，回车确认，默认停在上一次的操作；也可以直接带参数: node manage.js restart | update | check | stop | info
//   重启          已经有一个在跑就先停掉它 (覆盖), 没有就直接新启动
//   更新后重启    当前目录在 git 仓库里 -> git pull; 否则从 GitHub 下载默认分支最新 zip, 解压后替换程序文件
//                 (data/ 数据、.env 令牌、.tools/ 便携 Node 与 ffmpeg 保留不动)；更新逻辑和网页「管理员」页共用 updater.js
//   检查更新      只看有没有新版本 (结果带缓存), 不动任何文件
//   停止服务      停掉正在运行的实例
//   运行状态 / 查看日志   服务在后台运行 (关掉这个窗口不影响)，日志写在 data/server.log
//   访问信息      打印访问地址、访问令牌和管理员令牌
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const ROOT = __dirname;
const WIN = process.platform === 'win32';
const PORT = Number(process.env.PORT) || 9988;
const STATE = path.join(ROOT, 'data', '.manage.json');
const updater = require('./updater');

const C = process.stdout.isTTY ? { b: '\x1b[1m', d: '\x1b[2m', g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', c: '\x1b[36m', x: '\x1b[0m', inv: '\x1b[7m' }
  : { b: '', d: '', g: '', y: '', r: '', c: '', x: '', inv: '' };
const say = (...a) => console.log(...a);
const ok = t => say(`${C.g}✔${C.x} ${t}`);
const warn = t => say(`${C.y}!${C.x} ${t}`);
const bad = t => say(`${C.r}✘${C.x} ${t}`);
const step = t => say(`${C.c}›${C.x} ${t}`);

const loadState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } };
const saveState = patch => {
  try { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify({ ...loadState(), ...patch }, null, 2)); } catch {}
};

const run = (cmd, args, opt = {}) => spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', windowsHide: true, ...opt });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------- 菜单 ----------------
const ACTIONS = [
  { key: 'restart', title: '重启', hint: '已有实例在运行就先停掉再在后台启动 (覆盖); 没有就直接启动' },
  { key: 'update', title: '更新后重启', hint: '' },   // hint 在 render 时按 git / 非 git 现填
  { key: 'check', title: '检查更新', hint: '只看有没有新版本，不改任何文件' },
  { key: 'stop', title: '停止服务', hint: '停掉正在运行的实例' },
  { key: 'status', title: '运行状态', hint: '是否在运行、进程号、访问地址' },
  { key: 'logs', title: '查看日志', hint: '服务在后台运行，输出写在 data/server.log (q 退出查看)' },
  { key: 'info', title: '访问信息', hint: '访问地址、访问令牌、管理员令牌' },
];
let MODE = 'git';
const updateHint = () => MODE === 'git' ? '检测到 git 仓库: git pull 更新后启动' : `不是 git 仓库: 下载 GitHub 仓库默认分支的最新 zip (${(() => { try { return updater.repoSlug(); } catch { return '?'; } })()}), 解压替换后启动`;

// 退出只有一种方式: 3 秒内连按两次 Ctrl+C。第一次只提示。(查看日志时 q / Esc / Ctrl+C 是回到菜单)
let ccAt = 0;
const ccPending = () => Date.now() - ccAt < 3000;
function ctrlC() {
  if (ccPending()) { process.stdout.write('\x1b[?25h\n'); process.exit(0); }
  ccAt = Date.now();
  return false;
}
function choose(defKey) {
  return new Promise(resolve => {
    let i = Math.max(0, ACTIONS.findIndex(a => a.key === defKey));
    const hints = Object.fromEntries(ACTIONS.map(a => [a.key, a.key === 'update' ? updateHint() : a.hint]));
    const lines = ACTIONS.length + 4;
    let first = true;
    const draw = () => {
      if (!first) process.stdout.write(`\x1b[${lines}A`);
      first = false;
      const out = [];
      out.push(`${C.b}TVBox 管理${C.x}  ${C.d}${ROOT}${C.x}`);
      out.push('');
      ACTIONS.forEach((a, k) => out.push(`${k === i ? `${C.inv} ▶ ${a.title} ${C.x}` : `   ${a.title}`}  ${C.d}${k === i ? hints[a.key] : ''}${C.x}`));
      out.push('');
      out.push(ccPending() ? `${C.y}再按一次 Ctrl+C 退出${C.x}` : `${C.d}↑↓ 选择 · 回车确认 · Ctrl+C 两次退出${defKey ? ` · 默认: ${ACTIONS.find(a => a.key === defKey)?.title || ''} (上次)` : ''}${C.x}`);
      process.stdout.write(out.map(l => '\x1b[2K' + l).join('\n') + '\n');
    };
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdout.write('\x1b[?25l');
    draw();
    let ccT = 0;
    const done = v => {
      clearTimeout(ccT);
      process.stdin.removeListener('data', onKey);
      process.stdin.setRawMode(false); process.stdin.pause();
      process.stdout.write('\x1b[?25h');
      resolve(v);
    };
    const onKey = chunk => { for (const k of String(chunk).match(/\x1b\[[0-9;]*[A-Za-z~]|[\s\S]/g) || []) { if (key(k) === 'done') return; } };   // 一次读到几个按键 (连按 / 粘贴) 要拆开
    const key = k => {
      if (k === '\x03') { ctrlC(); clearTimeout(ccT); ccT = setTimeout(draw, 3100); draw(); return; }
      if (k === '\x1b') return;
      if (k === '\x1b[A' || k === 'k') i = (i + ACTIONS.length - 1) % ACTIONS.length;
      else if (k === '\x1b[B' || k === 'j') i = (i + 1) % ACTIONS.length;
      else if (/^[1-9]$/.test(k) && +k <= ACTIONS.length) i = +k - 1;
      else if (k === '\r' || k === '\n' || k === ' ') { done(ACTIONS[i].key); return 'done'; }
      draw();
    };
    process.stdin.on('data', onKey);
  });
}

// ---------------- 找到并停掉正在运行的实例 ----------------
// 端口上的监听者 -> 顺着父进程一路找到最外层的 server.js (看守进程); 只杀它, 不然它会把子进程又拉起来。
function listenerPids() {
  if (WIN) {
    const r = run('netstat', ['-ano', '-p', 'tcp']);
    const pids = new Set();
    for (const l of (r.stdout || '').split(/\r?\n/)) {
      const m = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(l);
      if (m && +m[1] === PORT) pids.add(+m[2]);
    }
    return [...pids];
  }
  const r = run('lsof', ['-nP', `-iTCP:${PORT}`, '-sTCP:LISTEN', '-t']);
  return [...new Set((r.stdout || '').split(/\s+/).filter(Boolean).map(Number))];
}
// Windows 一次取整张进程表 (比逐个查快，也不用在命令行里嵌双引号)；PowerShell 不行就退回 wmic。
let winTable = null;
function winProcs() {
  if (winTable) return winTable;
  const map = new Map();
  const add = (pid, ppid, name, cmd) => { if (pid) map.set(+pid, { ppid: +ppid || 0, name: String(name || '').toLowerCase(), cmd: cmd || '' }); };
  const r = run('powershell', ['-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress"], { timeout: 20000 });
  try {
    let j = JSON.parse(r.stdout); if (!Array.isArray(j)) j = [j];
    for (const x of j) add(x.ProcessId, x.ParentProcessId, x.Name, x.CommandLine);
  } catch {}
  if (!map.size) {
    const w = run('wmic', ['process', 'get', 'ProcessId,ParentProcessId,Name,CommandLine', '/format:csv'], { timeout: 20000 });
    for (const l of (w.stdout || '').split(/\r?\n/)) {      // Node,CommandLine,Name,ParentProcessId,ProcessId
      const m = /^[^,]*,(.*),([^,]*),(\d+),(\d+)\s*$/.exec(l);
      if (m) add(m[4], m[3], m[2], m[1]);
    }
  }
  return (winTable = map);
}
function procInfo(pid) {
  if (WIN) { const p = winProcs().get(pid); return p ? { ppid: p.ppid, cmd: p.cmd, name: p.name } : null; }
  const r = run('ps', ['-o', 'ppid=,command=', '-p', String(pid)]);
  const m = /^\s*(\d+)\s+(.*)$/.exec((r.stdout || '').trim());
  return m ? { ppid: +m[1], cmd: m[2], name: '' } : null;
}
const isOurs = cmd => /(^|[\s/\\"])server\.js\b/.test(cmd);
const isNode = info => !!info && (/^node(\.exe)?$/.test(info.name) || /node(\.exe)?"?\s/i.test(info.cmd));

// 端口上到底是不是 TVBox: 直接问它。TVBox 的 /api/ 没带令牌会回 401 + X-Auth-Required: 1 (或带令牌回健康信息)。
// 比看进程命令行可靠 (Windows 上命令行经常取不到 / 带引号 / 路径形式不一样)。注意: 请求不带令牌, 所以一定得到 401。
function isTvboxOnPort() {
  return new Promise(resolve => {
    const rq = http.get({ host: '127.0.0.1', port: PORT, path: '/api/health', timeout: 2500 }, res => {
      res.resume(); resolve(res.statusCode === 401 && res.headers['x-auth-required'] === '1');   // 不带令牌访问 /api/* 一定是 401 + 这个头；别的 HTTP 服务不会有
    });
    rq.on('timeout', () => { rq.destroy(); resolve(false); });
    rq.on('error', () => resolve(false));
  });
}
const PIDFILE = path.join(ROOT, 'data', '.server.pid');
const readPid = () => { try { const n = +fs.readFileSync(PIDFILE, 'utf8').trim(); return n > 0 ? n : 0; } catch { return 0; } };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

// 要停掉的最外层进程 (看守进程): 只杀它整棵树, 否则它会把子进程又拉起来。
async function findRunning() {
  winTable = null;
  const listeners = listenerPids();
  const tops = new Set();
  const unknown = [];
  for (const pid of listeners) {
    let cur = procInfo(pid);
    if (!cur || !(isOurs(cur.cmd) || (WIN && isNode(cur)))) { unknown.push(pid); continue; }
    let top = pid;
    for (let n = 0; n < 8; n++) {                       // 一路往上找: 父进程也是 node 跑的 server.js (或 Windows 上命令行取不到的 node.exe)
      const up = procInfo(cur.ppid);
      if (!up || !(isOurs(up.cmd) || (WIN && isNode(up) && !up.cmd.trim()))) break;
      top = cur.ppid; cur = up;
    }
    tops.add(top);
  }
  const probe = listeners.length ? await isTvboxOnPort() : false;
  const saved = readPid();
  if (listeners.length && probe && saved && alive(saved)) tops.add(saved);      // 本脚本启动时记下的看守进程
  if (probe) for (const pid of unknown.splice(0)) tops.add(pid);               // 命令行认不出来, 但端口上确实是 TVBox: 照样停
  return { pids: [...tops], foreign: unknown.length > 0 || (listeners.length > 0 && !probe && !tops.size), listeners };
}
function killTree(pid, force) {
  if (WIN) run('taskkill', ['/PID', String(pid), '/T', '/F']);
  else try { process.kill(pid, force ? 'SIGKILL' : 'SIGTERM'); } catch {}
}
async function stopRunning() {
  const { pids, foreign } = await findRunning();
  if (!pids.length) {
    if (foreign) throw new Error(`端口 ${PORT} 被别的程序占用了 (不是 TVBox)，没有动它。换个端口: PORT=9989 再运行。`);
    ok('没有正在运行的实例');
    try { fs.rmSync(PIDFILE, { force: true }); } catch {}
    return;
  }
  step(`停止正在运行的实例 (进程 ${pids.join(', ')})…`);
  for (const pid of pids) killTree(pid, false);
  for (let i = 0; i < 40 && pids.some(alive); i++) await sleep(250);
  for (const pid of pids) if (alive(pid)) { warn(`进程 ${pid} 没有及时退出，强制结束`); killTree(pid, true); }
  for (let i = 0; i < 20 && listenerPids().length; i++) await sleep(250);
  // 还有进程占着端口: 如果端口上还是 TVBox (比如看守进程没杀到、工作进程被重新拉起), 连同它们和父进程一起强杀
  for (let round = 0; round < 3 && listenerPids().length && await isTvboxOnPort(); round++) {
    winTable = null;
    for (const pid of listenerPids()) { const up = procInfo(pid); if (up && isNode(up) && up.ppid) killTree(up.ppid, true); killTree(pid, true); }
    for (let i = 0; i < 12 && listenerPids().length; i++) await sleep(250);
  }
  if (listenerPids().length) throw new Error(`端口 ${PORT} 仍被占用，请手动结束后重试`);
  try { fs.rmSync(PIDFILE, { force: true }); } catch {}
  ok('已停止旧实例');
}

// ---------------- 可取消的耗时操作 ----------------
// 更新 / 检查更新 进行中，按 q / Esc / Ctrl+C 取消并回到菜单 (不计入「Ctrl+C 两次退出」)。
let busyCtl = null;
async function cancellable(fn) {
  const ctl = busyCtl = new AbortController();
  const raw = !!process.stdin.isTTY;
  if (raw) process.stdin.setRawMode(true);
  process.stdin.resume(); process.stdin.setEncoding('utf8');
  const onKey = k => { if (/[qQ\x03\x1b]/.test(String(k))) ctl.abort(); };
  process.stdin.on('data', onKey);
  say(`${C.d}（q / Esc / Ctrl+C 取消，回到菜单）${C.x}`);
  const gone = new Promise((_, no) => ctl.signal.addEventListener('abort', () => no(new Error(updater.CANCELLED)), { once: true }));
  try { return await Promise.race([fn(ctl.signal), gone]); }
  finally {
    busyCtl = null;
    process.stdin.removeListener('data', onKey);
    if (raw) process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}
const isCancel = e => e && e.message === updater.CANCELLED;

// ---------------- 下载进度 ----------------
const mb = n => (n / 1048576).toFixed(1);
let progShown = false;
function showProgress(p) {
  const w = 24, f = p.total ? Math.min(1, p.done / p.total) : 0;
  const bar = p.total ? `${p.approx ? '约 ' : ''}[${'█'.repeat(Math.round(f * w))}${'░'.repeat(w - Math.round(f * w))}] ${(f * 100).toFixed(0)}%  ${mb(p.done)} / ${mb(p.total)} MB` : `${mb(p.done)} MB`;
  const eta = p.total && p.speed > 0 ? `  剩余 ${Math.max(0, Math.ceil((p.total - p.done) / p.speed))} 秒` : '';
  process.stdout.write(`\r\x1b[2K  ${bar}  ${(p.speed / 1048576).toFixed(2)} MB/s${eta}  ${C.d}${p.via}${C.x}`);
  progShown = true;
}
function clearLine() { if (progShown) { process.stdout.write('\r\x1b[2K'); progShown = false; } }

// ---------------- 其它操作 ----------------
async function doCheck() {
  step('检查更新 …');
  const u = await updater.check({ force: true });
  if (!u.available) return ok(`已是最新 (${u.current})${u.mode === 'git' && u.ahead ? `，本地领先 ${u.ahead} 个提交` : ''}`);
  warn(`有新版本: ${u.current || '版本未知'} → ${u.latest}${u.behind ? `（落后 ${u.behind} 个提交）` : ''}`);
  for (const c of u.commits || []) say(`   ${C.d}${c.id}${C.x} ${c.subject || ''}`);
}
function doInfo() {
  const a = require('./auth').ensureToken();
  const lan = Object.values(os.networkInterfaces()).flat().filter(x => x && x.family === 'IPv4' && !x.internal).map(x => x.address);
  say(`本机      http://localhost:${PORT}`);
  for (const ip of lan) say(`局域网    http://${ip}:${PORT}`);
  say(`\n访问令牌    ${a.token}`);
  say(`管理员令牌  ${a.adminToken}   ${C.d}(设置页「管理员」里用)${C.x}`);
  say(`${C.d}令牌存在 ${a.file}${C.x}`);
}

// ---------------- 启动 (后台) ----------------
// 服务以脱离终端的后台进程运行，输出写进 data/server.log；这个脚本启动完就退出，关窗口 / 退出脚本都不影响服务。
const LOG = path.join(ROOT, 'data', 'server.log');
const urlOf = () => `http://localhost:${PORT}`;
function openBrowser() {
  try {
    if (WIN) spawn('cmd', ['/c', 'start', '', urlOf()], { stdio: 'ignore', windowsHide: true }).unref();
    else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [urlOf()], { stdio: 'ignore' }).unref();
  } catch {}
}
async function start() {
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  try { if (fs.statSync(LOG).size > 5 * 1048576) fs.renameSync(LOG, LOG + '.old'); } catch {}   // 日志超过 5MB 就换一个新文件，只留一份旧的
  const fd = fs.openSync(LOG, 'a');
  fs.writeSync(fd, `\n===== ${new Date().toLocaleString()} 启动 (manage.js) =====\n`);
  step('在后台启动 TVBox …');
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, detached: true, windowsHide: true, stdio: ['ignore', fd, fd], env: { ...process.env, PORT: String(PORT) } });
  child.unref();
  fs.closeSync(fd);
  try { fs.writeFileSync(PIDFILE, String(child.pid)); } catch {}
  let early = null; child.on('exit', c => { early = c; });
  for (let i = 0; i < 60 && !listenerPids().length && early === null; i++) await sleep(500);
  if (early !== null || !listenerPids().length) {
    bad(`启动失败${early !== null ? ` (退出码 ${early})` : '，等了 30 秒端口还没开'}。最后几行日志:`);
    say(C.d + tail(LOG, 12).join('\n') + C.x);
    throw new Error('服务没有起来，完整日志: ' + LOG);
  }
  ok(`已在后台运行 (进程 ${child.pid})  ${urlOf()}`);
  say(`${C.d}日志: ${LOG}${C.x}`);
  say(`${C.d}关掉这个窗口不影响服务；再次运行本脚本可重启 / 更新 / 停止 / 看日志。${C.x}`);
  if (process.env.TVBOX_NO_OPEN !== '1') openBrowser();
}
function tail(file, n) {
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(-n); } catch { return []; }
}
async function doStatus() {
  const { pids, foreign } = await findRunning();
  if (!pids.length) { say(foreign ? `${C.y}!${C.x} 端口 ${PORT} 被别的程序占用 (不是 TVBox)` : `${C.r}●${C.x} 没有在运行`); return; }
  say(`${C.g}●${C.x} 运行中  进程 ${pids.join(', ')}  ${urlOf()}`);
  const lan = Object.values(os.networkInterfaces()).flat().filter(x => x && x.family === 'IPv4' && !x.internal).map(x => x.address);
  for (const ip of lan) say(`   局域网 http://${ip}:${PORT}`);
  say(`${C.d}日志: ${LOG}${C.x}`);
}
function doLogs() {
  if (!fs.existsSync(LOG)) { warn('还没有日志 (服务没有用本脚本启动过)'); return Promise.resolve(); }
  say(`${C.d}--- ${LOG}  (q / Esc / Ctrl+C 回到菜单) ---${C.x}`);
  say(tail(LOG, 40).join('\n'));
  return new Promise(resolve => {
    let pos = fs.statSync(LOG).size;
    const timer = setInterval(() => {
      let st; try { st = fs.statSync(LOG); } catch { return; }
      if (st.size < pos) pos = 0;                      // 日志被换了新文件
      if (st.size === pos) return;
      const fd = fs.openSync(LOG, 'r'), buf = Buffer.alloc(st.size - pos);
      fs.readSync(fd, buf, 0, buf.length, pos); fs.closeSync(fd);
      pos = st.size; process.stdout.write(buf.toString('utf8'));
    }, 500);
    const raw = !!process.stdin.isTTY;
    if (raw) process.stdin.setRawMode(true);
    process.stdin.resume(); process.stdin.setEncoding('utf8');
    const end = () => {
      clearInterval(timer); process.stdin.removeListener('data', onKey); process.removeListener('SIGINT', end);
      if (raw) process.stdin.setRawMode(false);
      process.stdin.pause(); resolve();
    };
    const onKey = k => { if (/^(q|Q|\x1b|\x03)$/.test(String(k)) || /[qQ\x03]/.test(String(k))) end(); };
    process.stdin.on('data', onKey);
    process.on('SIGINT', end);
  });
}

// ---------------- main ----------------
// 交互 (TUI) 下做完一个操作回到菜单，只有选 q / Esc / Ctrl+C 才退出；带参数 (node manage.js restart) 是一次性命令，做完退出。
const readLine = msg => new Promise(r => { process.stdout.write(msg); process.stdin.resume(); process.stdin.setEncoding('utf8'); process.stdin.once('data', d => { process.stdin.pause(); r(String(d).trim()); }); });
let viewing = false;   // 查看日志时 Ctrl+C 只是回到菜单，不计入「按两次退出」
const waitEnter = msg => readLine(msg + '\n').then(() => {});

// 返回 true = 做完了
async function perform(action, interactive) {
  if (action === 'check') return cancellable(() => doCheck());
  if (action === 'info') return doInfo();
  if (action === 'status') return doStatus();
  if (action === 'logs') return doLogs();
  if (action === 'update') {
    // 先更新再停服务: 下载 / 校验期间服务照常运行，中途取消或失败不会让服务白白停掉。
    try { await cancellable(signal => updater.apply(t => { if (!signal.aborted) { clearLine(); step(t); } }, p => { if (!signal.aborted) showProgress(p); }, signal)); clearLine(); ok('更新完成'); }
    catch (e) {
      clearLine();
      if (isCancel(e)) { warn('已取消，没有改动任何文件'); return; }
      bad(e.message);
      if (!interactive) throw e;
      const a = await readLine('当前版本没有被破坏。回车 = 用当前版本重启，n + 回车 = 回到菜单: ');
      if (/^n/i.test(a)) return;
    }
  }
  await stopRunning();
  if (action === 'stop') return ok('已停止');
  await start();
}

(async () => {
  MODE = (await updater.current().catch(() => ({ mode: 'zip' }))).mode;
  const arg = process.argv[2];
  if (arg && !ACTIONS.some(a => a.key === arg)) { bad('用法: node manage.js [restart|update|check|stop|status|logs|info]'); process.exit(2); }
  if (arg || !process.stdin.isTTY) {          // 一次性命令 / 没有终端: 做一次就退出
    const action = arg || loadState().last || 'restart';
    saveState({ last: action });
    try { await perform(action, false); process.exit(0); } catch (e) { bad(e.message); process.exit(1); }
  }
  process.on('SIGINT', () => { if (viewing) return; if (busyCtl) { busyCtl.abort(); return; } if (ctrlC()) return; process.stdout.write(`\n${C.y}再按一次 Ctrl+C 退出${C.x}\n`); });   // 菜单以外 (等回车 / 执行中) 的 Ctrl+C
  for (;;) {
    const action = await choose(loadState().last);
    saveState({ last: action });
    say('');
    viewing = action === 'logs';
    try { await perform(action, true); } catch (e) { if (isCancel(e)) warn('已取消'); else bad(e.message); }
    viewing = false;
    if (action !== 'logs') await waitEnter(`\n${C.d}按回车回到菜单${C.x}`);
    say('');
  }
})();
