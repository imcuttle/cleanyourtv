// 自动识别片头 / 片尾 / 每集都插的同一条广告：把相邻两集的开头和结尾各一段音频做指纹，找出两集里「一模一样」的片段。
// 片头曲、片尾曲、固定贴片广告每集都重复，正片内容不会，所以不需要任何人工标记。
// 只有 ffmpeg 可用时才工作；结果按集缓存在 data/skipmarks.json。
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const SR = 8000, N = 2048, HOP = 512, SEC = HOP / SR;      // 一帧 256ms，步长 64ms (步长小才不怕两集的帧没对齐)
const BANDS = 33, HEAD_WIN = 480, TAIL_WIN = 360;
const MIN_RUN = 10, GAP = 12, MAX_DIST = 9, MIN_RMS = 40;

// ---------- 指纹 ----------
const win = new Float64Array(N).map((_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)));
const edges = Array.from({ length: BANDS + 1 }, (_, i) => Math.round(77 * Math.pow(870 / 77, i / BANDS)));
const rev = (() => { const r = new Uint16Array(N), b = Math.log2(N); for (let i = 0; i < N; i++) { let x = i, y = 0; for (let k = 0; k < b; k++) { y = (y << 1) | (x & 1); x >>= 1; } r[i] = y; } return r; })();
const cosT = new Float64Array(N / 2).map((_, i) => Math.cos(-2 * Math.PI * i / N)), sinT = new Float64Array(N / 2).map((_, i) => Math.sin(-2 * Math.PI * i / N));
function fft(re, im) {
  for (let i = 0; i < N; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1, step = N / size;
    for (let s = 0; s < N; s += size) for (let k = 0; k < half; k++) {
      const a = s + k, b = a + half, wr = cosT[k * step], wi = sinT[k * step];
      const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
      re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
    }
  }
}
// pcm: Int16 little-endian mono 8 kHz → { fp: Int32Array, ok: Uint8Array }
async function fingerprint(buf) {
  const n = Math.floor(buf.length / 2), frames = Math.max(0, Math.floor((n - N) / HOP) + 1);
  const fp = new Int32Array(frames), ok = new Uint8Array(frames);
  const re = new Float64Array(N), im = new Float64Array(N);
  let prev = new Float64Array(BANDS), cur = new Float64Array(BANDS);
  for (let f = 0; f < frames; f++) {
    if ((f & 31) === 0) await tick();
    const o = f * HOP;
    let sq = 0;
    for (let i = 0; i < N; i++) { const v = buf.readInt16LE((o + i) * 2); sq += v * v; re[i] = v * win[i]; im[i] = 0; }
    fft(re, im);
    for (let b = 0; b < BANDS; b++) { let e = 0; for (let k = edges[b]; k < Math.max(edges[b] + 1, edges[b + 1]); k++) e += re[k] * re[k] + im[k] * im[k]; cur[b] = e; }
    if (f > 0) {
      let bits = 0;
      for (let b = 0; b < BANDS - 1; b++) if ((cur[b] - cur[b + 1]) - (prev[b] - prev[b + 1]) > 0) bits |= 1 << b;
      fp[f] = bits; ok[f] = Math.sqrt(sq / N) >= MIN_RMS ? 1 : 0;
    }
    [prev, cur] = [cur, prev];
  }
  return { fp, ok };
}
// 让出事件循环: 指纹 / 比对是纯计算，在主进程里分片跑，每片不超过几毫秒，不挡正常请求
let slice = 0;
const tick = async () => { if (Date.now() - slice > 6) { await new Promise(r => setImmediate(r)); slice = Date.now(); } };
const pop = x => { x -= (x >>> 1) & 0x55555555; x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; };

// 沿一条偏移线 (A[i] 对 B[i - lag]) 找连续匹配的片段
function scanLag(A, B, lag, runs, minRun) {
  const nA = A.fp.length, nB = B.fp.length, i0 = Math.max(0, lag), i1 = Math.min(nA, nB + lag);
  let start = -1, last = -1;
  const close = () => { if (start >= 0 && (last - start + 1) * SEC >= minRun) runs.push({ i0: start, i1: last, lag, len: last - start + 1 }); start = -1; };
  for (let i = i0; i < i1; i++) {
    if (start >= 0 && i - last > GAP) close();
    const j = i - lag;
    if (A.ok[i] && B.ok[j] && pop(A.fp[i] ^ B.fp[j]) <= MAX_DIST) { if (start < 0) start = i; last = i; }
  }
  close();
}
function toRanges(runs) {
  runs.sort((x, y) => y.len - x.len);
  const keep = [];
  for (const r of runs) if (!keep.some(k => r.i0 < k.i1 && k.i0 < r.i1)) keep.push(r);   // 相邻的偏移会各报一遍，只留最长的
  keep.sort((x, y) => x.i0 - y.i0);
  return keep.map(r => ({ a: [r.i0 * SEC, (r.i1 + 1) * SEC + (N - HOP) / SR], b: [(r.i0 - r.lag) * SEC, (r.i1 - r.lag + 1) * SEC + (N - HOP) / SR] }));
}
// 在两段指纹里找重复的片段 → [{ a:[s,e], b:[s,e] }] (秒，相对各自窗口起点)。每条偏移线都扫: 适合几分钟的窗口
async function common(A, B, minRun = MIN_RUN) {
  const runs = [];
  for (let lag = -(B.fp.length - 1); lag < A.fp.length; lag++) {
    if ((lag & 15) === 0) await tick();
    scanLag(A, B, lag, runs, minRun);
  }
  return toRanges(runs);
}
// 间隔不到 20 秒的碎片并成一段, 再留最长的 keep 段 (多留一段: 客户端会把其中是广告的剔掉, 再收到 片头 2 段 / 片尾 1 段), 按时间排好; 旧缓存里的多段也在这里收拾
function pick(list, keep, dur, tail) {
  const a = (list || []).map(r => [...r]).sort((x, y) => x[0] - y[0]), cl = [];
  for (const r of a) { const c = cl[cl.length - 1]; if (c && r[0] - c[1] < 20) c[1] = Math.max(c[1], r[1]); else cl.push(r); }
  const best = cl.sort((x, y) => (y[1] - y[0]) - (x[1] - x[0])).slice(0, keep).sort((x, y) => x[0] - y[0]);
  return best.map(c => [Math.round(c[0] * 10) / 10, Math.round((tail && dur - c[1] < 20 ? dur : c[1]) * 10) / 10]);
}
module.exports = function ({ ffmpeg, ua, file }) {
  // 持久 LRU: Map 的插入顺序就是新旧顺序, 命中时挪到最后, 超过上限从最旧的丢。落盘走临时文件 + 改名, 停手几秒后才写。
  const MAX = 2000;
  const cache = (() => { try { return new Map(Object.entries(JSON.parse(fs.readFileSync(file, 'utf8'))).slice(-MAX)); } catch { return new Map(); } })();
  let saveT = 0, dirty = false;
  const flush = () => {
    clearTimeout(saveT); if (!dirty) return; dirty = false;
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(Object.fromEntries(cache))); fs.renameSync(file + '.tmp', file); } catch {}
  };
  const touch = () => { dirty = true; clearTimeout(saveT); saveT = setTimeout(flush, 5000); saveT.unref?.(); };
  const put = (k, v) => { cache.delete(k); cache.set(k, v); while (cache.size > MAX) cache.delete(cache.keys().next().value); touch(); };
  const get = k => { const v = cache.get(k); if (v) { cache.delete(k); cache.set(k, v); touch(); } return v; };
  process.once('exit', flush);
  const key = u => crypto.createHash('md5').update(u).digest('hex');
  const base = ['-hide_banner', '-nostdin', '-user_agent', ua, '-rw_timeout', '15000000'];

  const duration = u => new Promise(ok => {
    const p = spawn(ffmpeg, [...base, '-i', u], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = ''; const t = setTimeout(() => p.kill('SIGKILL'), 30000);
    p.stderr.on('data', d => { if (err.length < 20000) err += d; });
    p.on('close', () => { clearTimeout(t); const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(err); ok(m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 0); });
    p.on('error', () => { clearTimeout(t); ok(0); });
  });
  const pcm = (u, ss, t) => new Promise((ok, bad) => {
    const p = spawn(ffmpeg, [...base, '-loglevel', 'error', ...(ss > 0 ? ['-ss', String(Math.floor(ss))] : []), '-t', String(t), '-i', u, '-vn', '-sn', '-ac', '1', '-ar', String(SR), '-f', 's16le', '-'],
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    try { os.setPriority(p.pid, 15); } catch {}   // 后台活, 让位给正常播放 / 请求
    const chunks = []; const to = setTimeout(() => p.kill('SIGKILL'), 240000);
    p.stdout.on('data', d => chunks.push(d));
    p.on('close', () => { clearTimeout(to); const b = Buffer.concat(chunks); b.length > SR * 2 * 30 ? ok(b) : bad(new Error('no audio')); });
    p.on('error', e => { clearTimeout(to); bad(e); });
  });

  // 一对相邻两集 → 各自的片头 / 片尾区间
  async function pair(u, v) {
    const [du, dv] = await Promise.all([duration(u), duration(v)]);
    if (du < 300 || dv < 300) return null;                 // 太短 (预告 / 短片) 不处理
    const hw = Math.min(HEAD_WIN, du * .4, dv * .4), tw = Math.min(TAIL_WIN, du * .3, dv * .3);
    const out = { u: { dur: du, head: [], tail: [] }, v: { dur: dv, head: [], tail: [] } };
    const round = a => a.map(x => [Math.round(x[0] * 10) / 10, Math.round(x[1] * 10) / 10]);
    const done = () => { for (const k of ['u', 'v']) for (const f of ['head', 'tail']) out[k][f] = round(out[k][f]); };
    const [hu, hv] = await Promise.all([pcm(u, 0, hw), pcm(v, 0, hw)]);
    for (const r of await common(await fingerprint(hu), await fingerprint(hv))) {
      if (r.a[0] > hw - 5 || r.a[1] - r.a[0] > 300) continue;
      out.u.head.push(r.a); out.v.head.push(r.b);
    }
    const su = du - tw, sv = dv - tw;
    const [tu, tv] = await Promise.all([pcm(u, su, tw), pcm(v, sv, tw)]);
    for (const r of await common(await fingerprint(tu), await fingerprint(tv))) {
      if (r.a[1] - r.a[0] > 300) continue;
      const a = [su + r.a[0], su + r.a[1]], b = [sv + r.b[0], sv + r.b[1]];
      if (du - a[1] < 20) a[1] = du;                          // 贴着结尾: 直接跳到片尾 → 触发下一集
      if (dv - b[1] < 20) b[1] = dv;
      out.u.tail.push(a); out.v.tail.push(b);
    }
    done();
    return out;
  }

  const busy = new Map(); let running = false; const queue = [];
  function pump() {
    if (running || !queue.length) return;
    running = true;
    const { u, n, k } = queue.shift(), nk = key(n);
    pair(u, n).then(r => {
      if (r) { put(k, { dur: r.u.dur, head: r.u.head, tail: r.u.tail }); put(nk, { dur: r.v.dur, head: r.v.head, tail: r.v.tail }); }
      else put(k, { none: 1, at: Date.now() });                 // 太短 / 没音轨: 一周内不再试
    }).catch(() => { retry.set(k, Date.now()); }).finally(() => { busy.delete(k); running = false; pump(); });
  }
  const retry = new Map();   // 本次运行里失败过的 (网络 / 源不通): 10 分钟内不再试, 不落盘

  // u: 这一集的原始地址, n: 相邻一集 (下一集, 没有就用上一集)。从不等计算: 没好就回 pending
  // peek: 只看缓存, 没有就回 none, 绝不启动计算 (自动跳过关着时只为了在进度条上标出位置)
  return function marks(u, n, peek) {
    if (!ffmpeg || !/^https?:\/\//.test(u) || !/^https?:\/\//.test(n || '')) return { status: 'none' };
    const k = key(u), hit = get(k);
    if (hit?.none && Date.now() - hit.at < 7 * 86400e3) return { status: 'none' };
    if (hit && !hit.none) return { status: 'ready', head: pick(hit.head, 3, hit.dur, false), tail: pick(hit.tail, 2, hit.dur, true), dur: hit.dur };
    if (peek) return { status: 'none' };
    if (busy.has(k)) return { status: 'pending' };
    if (Date.now() - (retry.get(k) || 0) < 600e3) return { status: 'none' };
    if (queue.length >= 8) return { status: 'none' };             // 排队太多就先不接新的
    busy.set(k, 1); queue.push({ u, n, k }); pump();
    return { status: 'pending' };
  };
};
module.exports.fingerprint = fingerprint;
module.exports.common = common;
