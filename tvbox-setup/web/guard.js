// 入口保护。三层：
//   supervise()   最外层看守进程：server.js 的主进程崩溃 / 被杀 / 卡死，就按退避间隔自动重新拉起。
//   Watchdog      主进程里盯着各个工作进程：心跳停了（事件循环卡死）就强杀，由主进程重启。
//   selfWatch()   工作进程自检：内存超限、事件循环持续变慢，就请主进程平滑换一个新的（先让出新连接、等在途请求处理完）。
// 所有阈值都可以用环境变量调（见各函数顶部）。
'use strict';
const os = require('os');
const { fork } = require('child_process');
const { monitorEventLoopDelay } = require('perf_hooks');

const num = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? v : d; };
const log = (...a) => console.log('  [保护]', ...a);

// ---- 最外层：把 server.js 当子进程跑，退出了（非主动停止）就重启 ----
//   TVBOX_NO_SUPERVISOR=1 关闭；快速连续崩溃时间隔 1s → 2s → 4s … 最长 30s；稳定运行 60s 后清零。
function supervise(entry) {
  let child = null, stopping = false, planned = false, crashes = 0, lastBeat = Date.now(), startedAt = 0, killTimer = null;
  const HANG = num('TVBOX_PRIMARY_HANG_MS', 90e3);
  const start = () => {
    startedAt = lastBeat = Date.now();
    child = fork(entry, process.argv.slice(2), { env: { ...process.env, TVBOX_SUPERVISED: '1' }, stdio: 'inherit' });
    child.on('message', m => { if (m && m.t === 'hb') lastBeat = Date.now(); else if (m && m.t === 'restart') { log('收到重启请求：' + (m.why || '')); planned = true; try { child.kill('SIGTERM'); } catch {} } });
    child.on('exit', (code, sig) => {
      clearInterval(killTimer);
      if (stopping) return process.exit(code || 0);
      const alive = Date.now() - startedAt;
      if (planned) { planned = false; crashes = 0; log('按请求重启中…'); return setTimeout(start, 500); }   // 主动重启 (管理员 / 自检): 不算崩溃, 不退避
      crashes = alive > 60e3 ? 1 : crashes + 1;
      const wait = Math.min(30e3, 1000 * 2 ** Math.min(crashes - 1, 5));
      log(`主进程退出（${sig || 'code ' + code}，运行了 ${Math.round(alive / 1000)} 秒），${Math.round(wait / 1000)} 秒后自动重启${crashes > 5 ? `（已连续异常 ${crashes} 次，请检查日志）` : ''}`);
      setTimeout(start, wait);
    });
    killTimer = setInterval(() => {
      if (child && Date.now() - lastBeat > HANG) { log(`主进程 ${Math.round((Date.now() - lastBeat) / 1000)} 秒没有心跳，强制重启`); try { child.kill('SIGKILL'); } catch {} lastBeat = Date.now(); }
    }, 5000).unref();
  };
  const stop = sig => { stopping = true; try { child?.kill(sig); } catch {} setTimeout(() => process.exit(0), 4000).unref(); };
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => stop(s));
  process.on('uncaughtException', e => log('看守进程异常（已忽略）：' + (e && e.message)));
  start();
}

// ---- 主进程里：工作进程心跳 ----
//   TVBOX_HANG_MS 心跳多久没来算卡死（默认 30 秒）
class Watchdog {
  constructor(kill) { this.kill = kill; this.beats = new Map(); this.hang = num('TVBOX_HANG_MS', 30e3); }
  beat(w) { this.beats.set(w.id, Date.now()); }
  forget(w) { this.beats.delete(w.id); }
  start(list) {
    this.t = setInterval(() => {
      const now = Date.now();
      for (const w of list()) {
        const at = this.beats.get(w.id); if (at === undefined) { this.beats.set(w.id, now); continue; }
        if (now - at > this.hang) { log(`进程 ${w.process.pid}（${w.role}）${Math.round((now - at) / 1000)} 秒没有响应，强制重启`); this.beats.set(w.id, now); this.kill(w); }
      }
    }, Math.min(5000, Math.max(500, this.hang / 4)));
    this.t.unref?.();
  }
}

// ---- 工作进程自检 ----
//   TVBOX_MAX_RSS_MB   内存上限（默认：物理内存的 20%，夹在 512MB – 2GB）
//   TVBOX_LAG_MS       事件循环 p99 延迟超过多少算「变慢」（默认 1500）
//   TVBOX_LAG_WINDOWS  连续多少个 5 秒窗口都变慢才重启（默认 4，即约 20 秒）
//   TVBOX_MIN_LIFE_MS  进程至少活这么久才允许被换掉（默认 60 秒），防止刚起来就反复重启
function selfWatch({ recycle, role = '' }) {
  const maxRss = num('TVBOX_MAX_RSS_MB', Math.max(512, Math.min(2048, Math.round(os.totalmem() / 1048576 * 0.2))));
  const lagMs = num('TVBOX_LAG_MS', 1500), lagWin = num('TVBOX_LAG_WINDOWS', 4), minLife = num('TVBOX_MIN_LIFE_MS', 60e3);
  const born = Date.now(), h = monitorEventLoopDelay({ resolution: 20 }); h.enable();
  let slow = 0, asked = false;
  const ask = why => { if (asked) return; asked = true; log(`${role ? role + ' ' : ''}进程 ${process.pid}：${why}，平滑重启`); recycle(why); };
  const t = setInterval(() => {
    const p99 = h.percentile(99) / 1e6, max = h.max / 1e6; h.reset();
    const rss = process.memoryUsage().rss / 1048576;
    stats.rssMB = Math.round(rss); stats.lagMs = Math.round(p99); stats.maxLagMs = Math.round(max);
    if (Date.now() - born < minLife) return;
    if (rss > maxRss) return ask(`内存 ${Math.round(rss)}MB 超过上限 ${maxRss}MB`);
    slow = p99 > lagMs ? slow + 1 : 0;
    if (slow >= lagWin) ask(`事件循环持续变慢（p99 ${Math.round(p99)}ms，连续 ${slow} 个窗口）`);
  }, 5000);
  t.unref();
  return { stop() { clearInterval(t); h.disable(); }, stats, limits: { maxRss, lagMs, lagWin, minLife } };
}
const stats = { rssMB: 0, lagMs: 0, maxLagMs: 0 };

module.exports = { supervise, Watchdog, selfWatch, stats };
