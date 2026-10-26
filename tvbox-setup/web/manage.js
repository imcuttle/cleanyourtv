#!/usr/bin/env node
// TVBox 网页版 — 管理入口 (macOS: manage.command · Windows: manage.bat 双击打开)。
//   ↑↓ 选择，回车确认，默认停在上一次的操作；也可以直接带参数: node manage.js restart | update | check | stop | info
//   重启          已经有一个在跑就先停掉它 (覆盖), 没有就直接新启动
//   更新后重启    当前目录在 git 仓库里 -> git pull; 否则从 GitHub 下载默认分支最新 zip, 解压后替换程序文件
//                 (data/ 数据、.env 令牌、.tools/ 便携 Node 与 ffmpeg 保留不动)；更新逻辑和网页「管理员」页共用 updater.js
//   检查更新      只看有没有新版本 (结果带缓存), 不动任何文件
//   停止服务      停掉正在运行的实例
//   访问信息      打印访问地址、访问令牌和管理员令牌
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
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
  { key: 'restart', title: '重启', hint: '已有实例在运行就先停掉再启动 (覆盖); 没有就直接启动' },
  { key: 'update', title: '更新后重启', hint: '' },   // hint 在 render 时按 git / 非 git 现填
  { key: 'check', title: '检查更新', hint: '只看有没有新版本，不改任何文件' },
  { key: 'stop', title: '停止服务', hint: '停掉正在运行的实例' },
  { key: 'info', title: '访问信息', hint: '访问地址、访问令牌、管理员令牌' },
];
let MODE = 'git';
const updateHint = () => MODE === 'git' ? '检测到 git 仓库: git pull 更新后启动' : `不是 git 仓库: 下载 GitHub 仓库默认分支的最新 zip (${(() => { try { return updater.repoSlug(); } catch { return '?'; } })()}), 解压替换后启动`;

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
      out.push(`${C.d}↑↓ 选择 · 回车确认 · q 退出${defKey ? ` · 默认: ${ACTIONS.find(a => a.key === defKey)?.title || ''} (上次)` : ''}${C.x}`);
      process.stdout.write(out.map(l => '\x1b[2K' + l).join('\n') + '\n');
    };
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdout.write('\x1b[?25l');
    draw();
    const done = v => {
      process.stdin.removeListener('data', onKey);
      process.stdin.setRawMode(false); process.stdin.pause();
      process.stdout.write('\x1b[?25h');
      resolve(v);
    };
    const onKey = k => {
      if (k === '\x03' || k === 'q' || k === 'Q' || k === '\x1b') return done(null);
      if (k === '\x1b[A' || k === 'k') i = (i + ACTIONS.length - 1) % ACTIONS.length;
      else if (k === '\x1b[B' || k === 'j') i = (i + 1) % ACTIONS.length;
      else if (/^[1-9]$/.test(k) && +k <= ACTIONS.length) i = +k - 1;
      else if (k === '\r' || k === '\n' || k === ' ') return done(ACTIONS[i].key);
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
function procInfo(pid) {
  if (WIN) {
    const r = run('powershell', ['-NoProfile', '-Command', `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if($p){@{ppid=$p.ParentProcessId;cmd=$p.CommandLine}|ConvertTo-Json -Compress}`]);
    try { const j = JSON.parse(r.stdout); return { ppid: j.ppid, cmd: j.cmd || '' }; } catch { return null; }
  }
  const r = run('ps', ['-o', 'ppid=,command=', '-p', String(pid)]);
  const m = /^\s*(\d+)\s+(.*)$/.exec((r.stdout || '').trim());
  return m ? { ppid: +m[1], cmd: m[2] } : null;
}
const isOurs = cmd => /(^|[\s/\\"])server\.js\b/.test(cmd);
function findRunning() {
  const tops = new Set();
  let foreign = false;
  for (const pid of listenerPids()) {
    let cur = procInfo(pid);
    if (!cur || !isOurs(cur.cmd)) { foreign = true; continue; }
    let top = pid;
    for (let n = 0; n < 6; n++) {
      const up = procInfo(cur.ppid);
      if (!up || !isOurs(up.cmd)) break;
      top = cur.ppid; cur = up;
    }
    tops.add(top);
  }
  return { pids: [...tops], foreign };
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function stopRunning() {
  const { pids, foreign } = findRunning();
  if (!pids.length) {
    if (foreign) throw new Error(`端口 ${PORT} 被别的程序占用了 (不是 TVBox)，没有动它。换个端口: PORT=9989 再运行。`);
    ok('没有正在运行的实例');
    return;
  }
  step(`停止正在运行的实例 (进程 ${pids.join(', ')})…`);
  for (const pid of pids) {
    if (WIN) run('taskkill', ['/PID', String(pid), '/T', '/F']);
    else try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  for (let i = 0; i < 40 && pids.some(alive); i++) await sleep(250);
  if (!WIN) for (const pid of pids) if (alive(pid)) { warn(`进程 ${pid} 没有及时退出，强制结束`); try { process.kill(pid, 'SIGKILL'); } catch {} }
  for (let i = 0; i < 20 && listenerPids().length; i++) await sleep(250);
  if (listenerPids().length) throw new Error(`端口 ${PORT} 仍被占用，请手动结束后重试`);
  ok('已停止旧实例');
}

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

// ---------------- 启动 ----------------
function start() {
  step('启动 TVBox …  (关闭这个窗口 / Ctrl+C 即停止)');
  say('');
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, PORT: String(PORT) } });
  setTimeout(() => {
    const url = `http://localhost:${PORT}`;
    try {
      if (WIN) spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', windowsHide: true }).unref();
      else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore' }).unref();
    } catch {}
  }, 2000);
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => { try { child.kill(s); } catch {} });
  child.on('exit', code => process.exit(code || 0));
}

// ---------------- main ----------------
const waitEnter = msg => new Promise(r => { say(msg); process.stdin.resume(); process.stdin.once('data', () => { process.stdin.pause(); r(); }); });
(async () => {
  const st = loadState();
  let action = process.argv[2];
  if (action && !ACTIONS.some(a => a.key === action)) { bad('用法: node manage.js [restart|update|check|stop|info]'); process.exit(2); }
  MODE = (await updater.current().catch(() => ({ mode: 'zip' }))).mode;
  if (!action) {
    if (!process.stdin.isTTY) action = st.last || 'restart';
    else {
      action = await choose(st.last);
      if (!action) process.exit(0);
    }
  }
  saveState({ last: action });
  say('');
  const pause = async code => { if (process.stdin.isTTY && !process.argv[2]) await waitEnter('\n按回车退出'); process.exit(code); };
  try {
    if (action === 'check') { await doCheck(); return pause(0); }
    if (action === 'info') { doInfo(); return pause(0); }
    await stopRunning();                       // 先停: 更新要替换正在使用的文件
    if (action === 'stop') { ok('已停止'); return pause(0); }
    if (action === 'update') {
      try { await updater.apply(t => step(t)); ok('更新完成'); }
      catch (e) {
        bad(e.message);
        if (process.stdin.isTTY) await waitEnter('当前版本没有被破坏，按回车继续用当前版本启动，Ctrl+C 取消。');
        else process.exit(1);
      }
    }
    start();
  } catch (e) {
    bad(e.message);
    await pause(1);
  }
})();
