// ---------- 字幕渲染: 自己画 (取代 <track> 的 ::cue) ----------
// 为什么不继续用 <track> 直接显示:
//   1. ::cue 能改的东西很少, iOS Safari 只认颜色 / 字体的一部分, 字号和位置各浏览器规则又不一样,
//      做不到「同一套设置在哪看起来都一样」;
//   2. 字幕要贴在「画面」的底部。上下有黑边 (letterbox) 时, ::cue 只会贴在 <video> 元素底部, 也就是黑边上;
//   3. 沉浸播放同时挂着三个 <video> (上一屏 / 这一屏 / 下一屏), 多轨 cue 的显示时机在移动端很容易出岔子。
// 现在: 取回同一份 WebVTT (服务端已经把 srt / ass / ssa 转好), 自己解析成 cue 列表, 在画面区域内自己排版 —
// 字号按画面高度算, 位置按画面高度算, 字体 / 颜色 / 描边都可调。时间跟着 video.currentTime 走:
// 播放时 rAF 逐帧对 (只在 cue 变化时写 DOM), 暂停 / 拖动 / 换源时各补一次。
// 另外仍保留一个 mode='hidden' 的 <track>: iPhone 上按全屏时走的是系统原生全屏 (DOM 浮层看不见),
// 那时把它切成 showing, 由系统来画字幕。
(() => {
'use strict';
const KEY = 'subStyle';
// size2: 副字幕 (一段字幕里第二行及之后的行, 双语文件常见) 相对主字幕的字号比例, 0 = 不展示副字幕。
// 默认 100: 和以前一样每行一样大, 用户想区分主次再往下调。
const DEF = { font: 'sans', size: 100, size2: 100, color: '#ffffff', edge: 'shadow', bottom: 7 };
// 字体: 系统黑体 / 宋体 / 圆体 / 楷体 / 等宽。iOS 上有苹方 / 宋体 / 圆体 / 楷体, 安卓和桌面回落到各自最接近的
const FONTS = {
  sans: '-apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif',
  serif: '"Songti SC", "Source Han Serif SC", "Noto Serif CJK SC", SimSun, Georgia, serif',
  round: '"Yuanti SC", "Hiragino Maru Gothic ProN", "PingFang SC", "Microsoft YaHei", sans-serif',
  kai: '"Kaiti SC", "STKaiti", KaiTi, "Songti SC", serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
};
const EDGES = ['shadow', 'outline', 'box', 'none'];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const norm = st => {
  const s = { ...DEF, ...(st && typeof st === 'object' ? st : {}) };
  s.font = FONTS[s.font] ? s.font : DEF.font;
  s.size = clamp(parseFloat(s.size) || DEF.size, 60, 200);
  s.size2 = clamp(parseFloat(s.size2), 0, 100);      // 0 是合法值 (关掉副字幕), 不能像上面那样用 || 兜底
  if (!Number.isFinite(s.size2)) s.size2 = DEF.size2;
  s.bottom = clamp(parseFloat(s.bottom), 0, 40);
  if (!Number.isFinite(s.bottom)) s.bottom = DEF.bottom;
  s.color = /^#[0-9a-f]{6}$/i.test(s.color || '') ? s.color : DEF.color;
  s.edge = EDGES.includes(s.edge) ? s.edge : DEF.edge;
  return s;
};

// ---------- 偏好 (跟账号走: UD, 见 acct.js; 没登录 / 预览页退回本机) ----------
function store() {
  if (window.UD) return window.UD;
  return { get: k => localStorage.getItem(k), set: (k, v) => localStorage.setItem(k, v) };
}
let cache = null;
function style() {
  if (cache) return cache;
  let raw = null;
  try { raw = JSON.parse(store().get(KEY) || 'null'); } catch { raw = null; }
  return (cache = norm(raw));
}
function setStyle(patch) {
  const next = norm({ ...style(), ...patch });
  cache = next;
  try { store().set(KEY, JSON.stringify(next)); } catch {}
  refresh();
  paintPreviews();
  return next;
}
const resetStyle = () => setStyle({ ...DEF });

// ---------- WebVTT 解析 ----------
// 服务端已经把 srt / ass / ssa 统一转成 WebVTT, 这里只管 WebVTT (顺带兼容 srt: 序号行会被跳过)。
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', lrm: '', rlm: '', ensp: ' ', emsp: ' ' };
function clean(line) {
  return String(line)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')                                     // <i> <c.yellow> <v 名字> <00:00:01.000> 之类全去掉 (不带样式, 只留字)
    .replace(/\{\\[^}]*\}/g, '')                                 // ass 的位置 / 颜色覆盖: {\an8}{\c&H00FFFF&}
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, g) => {
      if (g[0] === '#') { const n = g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : +g.slice(1); return Number.isFinite(n) && n < 0x110000 ? String.fromCodePoint(n) : m; }
      const v = ENT[g.toLowerCase()];
      return v === undefined ? m : v;
    });
}
const secs = (h, m, s, ms) => (h ? parseInt(h, 10) : 0) * 3600 + (+m) * 60 + (+s) + (+String(ms).padEnd(3, '0').slice(0, 3)) / 1000;
const TIME = '(?:(\\d{1,3}):)?(\\d{1,3}):(\\d{1,2})[.,](\\d{1,3})';
const SYNC = new RegExp('^\\s*' + TIME + '\\s*-->\\s*' + TIME);
function parse(text) {
  const cues = [];
  const s = String(text || '').replace(/^\uFEFF/, '').replace(/^WEBVTT[^\n]*\n/, '\n').replace(/\r\n?/g, '\n');
  for (const block of s.split(/\n{2,}/)) {
    const lines = block.split('\n');
    let i = lines[0] && /-->/.test(lines[0]) ? 0 : 1;             // 有 cue id / srt 序号: 跳一行
    if (i === 1 && !SYNC.test(lines[1] || '')) continue;          // NOTE / STYLE / REGION / 片头信息: 不要
    const m = SYNC.exec(lines[i] || '');
    if (!m) continue;
    const st = secs(m[1], m[2], m[3], m[4]), en = secs(m[5], m[6], m[7], m[8]);
    const t = lines.slice(i + 1).map(clean).join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (t && en > st) cues.push({ s: st, e: en, t });
  }
  cues.sort((a, b) => a.s - b.s);
  // 同一时间段重复的 cue (双语字幕文件常见) 只留一条, 不然后面会显示两遍
  return cues.filter((c, i) => !i || c.s !== cues[i - 1].s || c.t !== cues[i - 1].t);
}

// ---------- 取字幕 (同一个地址只下载 / 解析一次) ----------
const vtt = new Map();           // url -> cues
const pending = new Map();       // url -> Promise
function loadVtt(url) {
  if (vtt.has(url)) return Promise.resolve(vtt.get(url));
  if (pending.has(url)) return pending.get(url);
  const { api } = window;
  const p = fetch(url, { credentials: 'same-origin' })
    .then(r => (r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status))))
    .then(t => { const cues = parse(t); if (vtt.size > 24) vtt.delete(vtt.keys().next().value); vtt.set(url, cues); return cues; })
    .catch(e => { console.warn('[sub] 字幕加载失败', e); return []; })
    .finally(() => pending.delete(url));
  pending.set(url, p);
  return p;
}

// ---------- 每个 <video> 的叠加层 ----------
const entries = new Map();
function mkOverlay(video, after) {
  const ov = document.createElement('div');
  ov.className = 'subov';
  ov.hidden = true;          // 第一次 layout 算准画面之前先别露面, 免得拿 CSS 默认字号 (20px) 闪一帧
  ov.innerHTML = '<div class="subcap"><span class="subtx"></span><span class="subtx2"></span></div>';
  (after && after.parentElement === video.parentElement ? after : video).after(ov);
  return ov;
}
// 副字幕 = 一段字幕里第二行及之后的行 (双语字幕文件常见: 中文 / 英文各占一行)。字号按比例跟着主字幕走, 0 = 不展示。
function applyVars(ov, st, fs, gap) {
  ov.dataset.edge = st.edge;
  ov.dataset.s2 = st.size2 > 0 ? 'on' : 'off';
  ov.style.setProperty('--subfs', fs.toFixed(1) + 'px');
  ov.style.setProperty('--subfs2', Math.max(0, fs * st.size2 / 100).toFixed(1) + 'px');
  ov.style.setProperty('--subfont', FONTS[st.font]);
  ov.style.setProperty('--subcolor', st.color);
  ov.style.setProperty('--subgap', Math.round(gap) + 'px');
}
// 元素在自己容器里的位置 (本地坐标)。不用 getBoundingClientRect: 全屏可以用 CSS 旋转 90° 装成横屏
// (#player.rot), 屏幕坐标和元素自己的坐标轴对不上, 本地坐标在旋转 / 平移下都是对的
function box(el, host) {
  let x = 0, y = 0, n = el;
  while (n && n !== host) { x += n.offsetLeft; y += n.offsetTop; n = n.offsetParent; }
  return { x, y, w: el.clientWidth, h: el.clientHeight };
}
// 放大镜的当前状态 (zoom.js 写的是 <video> 的 translate / scale 属性: 以元素中心为原点缩放 / 平移)。
// 老浏览器不支持这两个独立属性时它退回写 transform, 那时整个矩阵都是缩放 / 平移, 样式里的位移已经被顶掉了。
function zoomOf(v) {
  const st = v.style;
  if (st.scale || st.translate) {
    const s = parseFloat(st.scale), t = String(st.translate || '').trim().split(/\s+/);
    return { s: Number.isFinite(s) && s > 0 ? s : 1, x: parseFloat(t[0]) || 0, y: parseFloat(t[1]) || 0, inline: false };
  }
  if (st.transform && st.transform !== 'none') {
    try { const m = new DOMMatrixReadOnly(st.transform); return { s: m.a > 0 ? m.a : 1, x: m.e, y: m.f, inline: true }; } catch {}
  }
  return { s: 1, x: 0, y: 0, inline: false };
}
// 画面区域 (不含黑边) 在「叠加层父元素」坐标系里的位置; 也顺手算好字号和字幕距画面底部的距离
function layout(e) {
  const v = e.video, ov = e.ov;
  if (!ov || !ov.isConnected) return;
  const host = ov.parentElement;
  const b = box(v, host);
  const HW = host.clientWidth, HH = host.clientHeight;
  if (!b.w || !b.h || !HW || !HH) { ov.hidden = true; e.sig = ''; return; }
  const fit = getComputedStyle(v).objectFit || 'contain';
  const vw = v.videoWidth, vh = v.videoHeight;
  // contain 时画面在元素里居中, 得等 loadedmetadata 拿到真实宽高比才算得准。元数据没到时 videoWidth /
  // videoHeight 是 0, 以前会退化成「整个元素都算画面」: 沉浸页横屏片在竖屏手机上元素高 844px, 字幕按
  // 40.5px 排版、留白 114px (真实是 14px / 15px) —— 播放开头字幕会巨大地闪一下, 元数据到了才收回去。
  // 画面都还没出来就先不画字幕; bind 里的 loadedmetadata / resize / 500ms 兜底会补这次 layout。
  if (fit === 'contain' && !(vw > 0 && vh > 0)) { ov.hidden = true; e.sig = ''; return; }
  let cw = b.w, ch = b.h;
  if (vw && vh && fit === 'contain') { const k = Math.min(b.w / vw, b.h / vh); cw = vw * k; ch = vh * k; }   // contain: 画面居中, 四周是黑边
  let left = b.x + (b.w - cw) / 2, top = b.y + (b.h - ch) / 2;
  const z = zoomOf(v);
  // 样式本身带的位移 (沉浸页的横屏片上提是写在 <video> 的 transform 上的); 放大镜占了 transform 时以它为准
  let ox = 0, oy = 0;
  if (!z.inline) {
    const tf = getComputedStyle(v).transform;
    if (tf && tf !== 'none') { try { const m = new DOMMatrixReadOnly(tf); ox = m.e; oy = m.f; } catch {} }
  }
  // 放大镜 (zoom.js 的 translate / scale 属性): 浏览器是围着 <video> 元素中心 (transform-origin 50% 50%) 变的,
  // 画面在元素里不居中时 (沉浸页横屏片整体上提、上下有黑边) 会连同这段偏移一起被推到别处。
  // 顺序照 CSS 来: 先 transform (上提 / 位移) → 再以元素中心缩放 → 最后 translate。按这个算, 放大后字幕才和画面严丝合缝。
  // (以前拿「画面中心」当缩放原点, 画面偏离元素中心时越放大偏得越多, 横屏片上字幕会掉到画面下面去。)
  left += ox; top += oy;
  if (z.s !== 1 || z.x || z.y) {
    const ex = b.x + b.w / 2, ey = b.y + b.h / 2;
    left = ex + (left - ex) * z.s + z.x;
    top = ey + (top - ey) * z.s + z.y;
    cw *= z.s; ch *= z.s;
  }
  // 只画在容器看得见的那一块里: 画面放大到屏幕外时, 字幕跟着画面走, 但不会被 overflow 裁掉、也不会跑到画面外看不见。
  // 画面没被裁时这块就是画面本身, 和以前的算法完全一样。
  const x0 = Math.max(0, left), y0 = Math.max(0, top);
  const bw = Math.min(HW, left + cw) - x0, bh = Math.min(HH, top + ch) - y0;
  if (bw < 12 || bh < 12) { ov.hidden = true; e.sig = ''; return; }
  ov.hidden = false;
  const st = style();
  // 字号跟画面高度走 (横屏片在竖屏手机上画面只有 200 多 px 高, 再兜一个按屏幕短边算的下限, 不然小得没法读)。
  // 放大镜放大时用「没放大前的画面高度」算基准再乘倍数: 直接拿放大后的高度算的话, 那个按屏幕短边的下限会原地不动,
  // 把比例吃掉 (横屏片 2× 时字号只长到 1.5×), 放大后字和画面就对不上了。
  const ch0 = ch / z.s;
  const fs = clamp(Math.max(ch0 * 0.048, Math.min(HW, HH) * 0.036) * st.size / 100, 11, 96) * z.s;
  // 底部留白: 位置设置 (% 画面高度) + 调用方要求的避让 (普通播放器的控制条 / 沉浸页底部的标题, 见 app.js、feed.js)
  let gap = ch * st.bottom / 100;
  if (e.reserve) { try { const r = +e.reserve({ x: x0, y: y0, w: bw, h: bh }); if (r > 0) gap += r; } catch {} }
  // 画面放大到画面底边出了屏幕 (叠加层被裁到容器底边): 留白按放大倍数一起变大就没边了 (6× 时能飘到半屏),
  // 这时候收到可见高度的 18%; 画面底边还在屏幕里时一分不改, 比例始终是准的。
  if (top + ch > HH) gap = Math.min(gap, bh * 0.18);
  gap = Math.min(gap, bh * 0.72);
  // 什么都没变就不碰 DOM (tick 里每 500ms 会重算一次, 免得白白触发样式重算)
  const sig = [x0, y0, bw, bh, fs, gap].map(n => Math.round(n * 10)).join() + '|' + [st.font, st.size, st.size2, st.color, st.edge, st.bottom].join();
  if (sig === e.sig) return;
  e.sig = sig;
  // 放大 / 平移的过程中位置每帧都在变: 把「跟着控制条平滑下移」那条过渡关掉, 不然字幕会慢半拍、看着像飘了
  ov.dataset.zoom = z.s !== 1 || z.x || z.y ? '1' : '0';
  ov.style.left = x0 + 'px'; ov.style.top = y0 + 'px';
  ov.style.width = bw + 'px'; ov.style.height = bh + 'px';
  applyVars(ov, st, fs, gap);
}
function text(e, s) {
  // 同一行出现两遍 (滚动式字幕 / 双语文件里同一条 cue 被写了两遍) 只留一份: 否则画面底部会多出一块一模一样的字幕
  if (s) s = [...new Set(s.split('\n'))].join('\n');
  if (!e.cap || e.txt === s) return;
  e.txt = s;
  // 一段字幕里的换行就是「主 / 副」的分界: 第一行是主字幕, 第二行及之后是副字幕 (双语文件常见)。
  // 副字幕字号由 --subfs2 (主字幕 × 比例) 决定, 比例设 0 时 CSS 直接把那一块藏掉, 只剩第一行。
  const lines = s ? s.split('\n') : [];
  e.tx.textContent = lines[0] || '';
  e.tx2.textContent = lines.length > 1 ? lines.slice(1).join('\n') : '';
  e.cap.hidden = !s;
}
function paint(e) {
  if (e.off) return;
  const v = e.video, cues = e.cues;
  if (!cues.length) return text(e, '');
  const t = v.currentTime;
  let lo = 0, hi = cues.length - 1, idx = -1;                    // 最后一条 start <= t 的 cue
  while (lo <= hi) { const m = (lo + hi) >> 1; if (cues[m].s <= t) { idx = m; lo = m + 1; } else hi = m - 1; }
  if (idx < 0) return text(e, '');
  const on = [];
  for (let i = idx, n = 0; i >= 0 && n < 8; i--, n++) { if (cues[i].e > t) on.unshift(cues[i].t); }
  text(e, on.join('\n'));
}
function tick(e) {
  e.raf = 0;
  if (e.off || document.hidden) return;
  paint(e);
  // 尺寸 / 缩放 / 全屏旋转的变化大部分由 ResizeObserver 和 MutationObserver 报进来; 这里兜一道底,
  // 免得漏了什么 (每 500ms 一次, 算出来没变化就不会写 DOM)
  if (e.dirty || Date.now() - e.at > 500) { e.dirty = false; e.at = Date.now(); layout(e); }
  if (!e.video.paused && !e.video.ended) e.raf = requestAnimationFrame(() => tick(e));
}
function kick(e) {
  if (e.off) return;
  paint(e); layout(e);
  if (!e.raf && !e.video.paused && !e.video.ended) e.raf = requestAnimationFrame(() => tick(e));
}
function bind(e) {
  const v = e.video;
  const on = (n, f) => v.addEventListener(n, f);
  on('play', () => kick(e)); on('playing', () => kick(e));
  on('pause', () => { paint(e); }); on('ended', () => paint(e));
  on('seeked', () => kick(e)); on('seeking', () => paint(e));
  on('timeupdate', () => paint(e));                              // rAF 之外的兜底 (有些浏览器静音播放不派帧)
  on('durationchange', () => layout(e));
  on('loadedmetadata', () => layout(e));
  on('resize', () => layout(e));                                  // 画面宽高比变了
  // iPhone 系统原生全屏: DOM 浮层看不见, 把那条 hidden 的 <track> 交给系统去画
  on('webkitbeginfullscreen', () => { try { if (e.tr?.track) e.tr.track.mode = 'showing'; } catch {} });
  on('webkitendfullscreen', () => { try { if (e.tr?.track) e.tr.track.mode = 'hidden'; } catch {} });
  if (window.ResizeObserver) { e.ro = new ResizeObserver(() => { e.dirty = true; }); e.ro.observe(v); if (v.parentElement) e.ro.observe(v.parentElement); }
  // zoom.js 的双指放大写的是 <video> 的 style, 沉浸页的横屏上提是给它换 class: 两样都不派事件, 盯着属性变化重排
  if (window.MutationObserver) {
    e.mo = new MutationObserver(() => { if (e.off) return; e.dirty = false; e.at = Date.now(); layout(e); });
    e.mo.observe(v, { attributes: true, attributeFilter: ['style'] });
    if (v.parentElement) e.mo.observe(v.parentElement, { attributes: true, attributeFilter: ['class', 'style'] });
  }
  addEventListener('orientationchange', () => { e.dirty = true; setTimeout(() => layout(e), 150); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) kick(e); });
}
function ensure(e, url) {
  const v = e.video;
  if (!e.ov || !e.ov.isConnected) { e.ov = mkOverlay(v, e.anchor); e.cap = e.ov.querySelector('.subcap'); e.tx = e.ov.querySelector('.subtx'); e.tx2 = e.ov.querySelector('.subtx2'); e.dirty = true; e.sig = ''; }
  // 原生全屏兜底用的 <track>: 平时 hidden (只加载不显示, 屏幕上由 .subov 画), 系统全屏时才交出去
  let tr = v.querySelector('track[data-sub]');
  if (!tr) { tr = document.createElement('track'); tr.dataset.sub = '1'; tr.kind = 'subtitles'; tr.srclang = 'zh'; tr.label = '字幕'; v.appendChild(tr); }
  e.tr = tr;
  if (!tr.src.endsWith(url)) tr.src = url;
  const hide = () => { try { if (tr.track && tr.track.mode !== 'showing') tr.track.mode = 'hidden'; } catch {} };
  tr.onload = hide; setTimeout(hide, 0);
}
function mount(video, opt) {
  const o = typeof opt === 'string' ? { url: opt } : (opt || {});
  const url = o.url || '';
  if (!video || !url) return unmount(video);
  let e = entries.get(video);
  if (!e) {
    e = { video, ov: null, tr: null, cap: null, tx: null, tx2: null, cues: [], txt: null, raf: 0, gen: 0, url: '', reserve: null, anchor: null, dirty: true, at: 0, off: true, sig: '' };
    entries.set(video, e); bind(e);
  }
  e.off = false;
  e.reserve = typeof o.reserve === 'function' ? o.reserve : null;
  e.anchor = o.anchor || null;
  ensure(e, url);
  if (e.url === url && e.cues.length) { kick(e); return; }
  e.url = url; e.cues = []; e.txt = null;
  const gen = ++e.gen;
  loadVtt(url).then(cues => { if (e.gen !== gen || e.url !== url) return; e.cues = cues; e.dirty = true; kick(e); });
}
function unmount(video) {
  const e = video && entries.get(video);
  if (!e || e.off) return;
  e.off = true;
  if (e.raf) { cancelAnimationFrame(e.raf); e.raf = 0; }
  e.cues = []; e.url = ''; e.gen++;
  e.video.querySelector('track[data-sub]')?.remove(); e.tr = null;
  e.ov?.remove(); e.ov = e.cap = e.tx = e.tx2 = null; e.sig = '';
}
const unmountAll = () => [...entries.keys()].forEach(unmount);
// 把「字体 / 颜色」挂到 <html> 上: iPhone 系统原生全屏时字幕由系统画 (DOM 浮层看不见),
// style.css 里那条 video::cue 靠这几个变量尽量跟设置对齐 (字号 / 位置系统自己有主张, 动不了)
function paintRoot(st) {
  const r = document.documentElement.style;
  r.setProperty('--subfont', FONTS[st.font]);
  r.setProperty('--subcolor', st.color);
}
function refresh() { paintRoot(style()); for (const e of entries.values()) { e.dirty = true; layout(e); } }

// ---------- 设置页的实时预览 ----------
// 预览框里那块「画面」按比例缩, 字号 / 位置照着真播放器的算法算, 所见即所得
const previews = new Set();
function preview(ov) { if (ov) previews.add(ov); for (const x of previews) if (!x.isConnected) previews.delete(x); }
function paintPreviews() {
  for (const ov of previews) {
    if (!ov.isConnected) { previews.delete(ov); continue; }
    const box = ov.parentElement, st = style();
    const w = box.clientWidth || 320, h = box.clientHeight || 180;
    applyVars(ov, st, clamp(Math.min(w, h) * 0.075 * st.size / 100, 9, 40), h * st.bottom / 100);
  }
}
addEventListener('resize', paintPreviews);
paintRoot(style());   // 首屏就把字体 / 颜色挂到 <html> 上, 原生全屏的 ::cue 从一开始就是对的

window.SUB = { DEF, FONTS, EDGES, get: style, set: setStyle, reset: resetStyle, mount, unmount, unmountAll, refresh, parse, preview, paintPreviews, box };
})();
