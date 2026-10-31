// 播放画面的手势缩放 / 平移，普通播放器 (app.js) 和沉浸看片 (feed.js) 共用。
//   · 双指捏合缩放 (围着两指中点)，同时拖动 = 平移；一根手指留下继续拖不会跳；
//   · 放大后单指 / 鼠标拖动平移，松手带惯性，拖过边缘有橡皮筋、松手弹回；缩小到 1 以下松手回弹到 1；
//   · 放大时双击还原 (没放大时双击还是原来的：快进 / 暂停 / 点赞)；右上的小标签显示倍数，点一下还原；
//   · 电脑: 触控板捏合 (Ctrl+滚轮 / Safari 手势) 缩放，放大后滚轮 / 双指滑动平移；
//   · 变换只写在 <video> 的 translate / scale 属性上 (不碰它原有的 transform)，由 rAF 合并成每帧一次写入。
// 没放大 (≤1) 时单指的事件原样交给页面，只有第二根手指落下才接管 (并给第一根手指补一个 pointercancel，让页面放弃手头的手势)。
(() => {
  const MAX = 6, EPS = 1.02;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const rub = (x, dim) => (1 - 1 / (x * .55 / dim + 1)) * dim;                        // iOS 式橡皮筋: 拉得越远越拉不动
  const hasProps = !!(window.CSS && CSS.supports && CSS.supports('scale', '1') && CSS.supports('translate', '1px'));

  window.VZoom = function (o) {
    const box = o.box;
    const point = o.point || (e => ({ x: e.clientX, y: e.clientY }));
    const rectOf = o.rect || (() => box.getBoundingClientRect());
    const getEl = o.el || (() => box.querySelector('video'));
    const enabled = o.enabled || (() => true);
    // ignore: 这些地方 (控制条 / 进度条 / 面板) 的触点完全不管；soft: 画面上的小按钮 (中间的播放键、「全屏观看」…) 点它是点它，
    // 但手指落在上面也能当捏合的一根手指 —— 单指时原样交给按钮，第二根手指落下才接管 (按钮收到 pointercancel，不会误触发)。
    const ignore = (o.ignore ? o.ignore + ', ' : '') + '.zoomtag', softSel = o.soft || 'button';
    let el = null, s = 1, tx = 0, ty = 0, raf = 0, anim = null, G = null, pinching = false, synth = false;
    let suppressUntil = 0, lastTap = null, tapT = 0, gs = null, started = false;
    const pts = new Map();                                                             // pointerId -> 触点 (最多两个)

    // ---- 画面几何 ----
    // 坐标都是「相对容器中心」的本地坐标 (转屏的全屏下 point / rect 由调用方换算好)。
    const rel = e => { const p = point(e), r = rectOf(); return { x: p.x - (r.left + r.width / 2), y: p.y - (r.top + r.height / 2) }; };
    function geo() {
      const v = el, W = v.clientWidth || 1, H = v.clientHeight || 1;
      let cw = W, ch = H;
      if (v.videoWidth && v.videoHeight) { const f = Math.min(W / v.videoWidth, H / v.videoHeight); cw = v.videoWidth * f; ch = v.videoHeight * f; }   // object-fit: contain 之后真正有画面的区域
      let ox = 0, oy = 0;                                                              // 样式里本来就有的偏移 (沉浸的横屏片会整体上提)
      if (hasProps) { const t = getComputedStyle(v).transform; if (t && t !== 'none') { try { const m = new DOMMatrixReadOnly(t); ox = m.e; oy = m.f; } catch {} } }
      return { W, H, cw, ch, ox, oy };
    }
    // 平移的允许范围 (T = translate): 画面比屏幕大时, 边缘不能离开屏幕边; 比屏幕小时留在原位 (A > B 的那种)。
    function limits(sv) {
      const g = geo();
      const one = (V, c, off) => {
        const A = V / 2 - off - sv * c / 2, B = -V / 2 - off + sv * c / 2, sh = off * (1 - sv);
        if (A <= B) return [A + sh, B + sh];
        // 画面还没撑满屏幕: 不能拖, 停在「静止位置」—— 刚放大时在原位, 越接近撑满越往屏幕正中靠 (横屏片在沉浸里是上提的, 放大后慢慢回到正中)
        const sFit = V / c, k = sFit > 1 ? clamp((sv - 1) / (sFit - 1), 0, 1) : 1;
        const p = clamp(-off * k, B, A) + sh; return [p, p];
      };
      return { x: one(g.W, g.cw, g.ox), y: one(g.H, g.ch, g.oy), W: g.W, H: g.H };
    }
    const rubT = (v, [lo, hi], dim) => v < lo ? lo - rub(lo - v, dim) : v > hi ? hi + rub(v - hi, dim) : v;
    const rubS = raw => clamp(raw > MAX ? MAX + rub(raw - MAX, MAX * .4) : raw < 1 ? 1 - rub(1 - raw, .5) : raw, .45, MAX * 1.5);

    // ---- 写样式 ----
    const tag = document.createElement('button');
    tag.type = 'button'; tag.className = 'zoomtag'; tag.hidden = true; box.append(tag);
    tag.addEventListener('pointerdown', e => e.stopPropagation());
    tag.addEventListener('pointerup', e => e.stopPropagation());
    tag.addEventListener('click', e => { e.stopPropagation(); reset(false); });
    function paint() {
      raf = 0;
      if (!el) return;
      const on = Math.abs(s - 1) > .0005 || Math.abs(tx) > .05 || Math.abs(ty) > .05;
      if (!on) { el.style.translate = ''; el.style.scale = ''; el.style.willChange = ''; if (!hasProps) el.style.transform = ''; }
      else if (hasProps) { el.style.willChange = 'transform'; el.style.translate = `${tx.toFixed(2)}px ${ty.toFixed(2)}px`; el.style.scale = s.toFixed(4); }
      else { el.style.willChange = 'transform'; el.style.transform = `translate3d(${tx.toFixed(2)}px, ${ty.toFixed(2)}px, 0) scale(${s.toFixed(4)})`; }
      const z = s >= EPS;
      if (tag.hidden === z) tag.hidden = !z;
      box.classList.toggle('zoomed', z);
      if (z) { const t = s.toFixed(1); if (tag._t !== t) { tag._t = t; tag.textContent = `${t}×  还原`; } }
    }
    const draw = () => { if (!raf) raf = requestAnimationFrame(paint); };
    function hard() {                                                                  // 立刻回到原样
      stopAnim(); clearTimeout(tapT); lastTap = null; gs = null;
      s = 1; tx = ty = 0; G = null; pinching = false;
      pts.forEach(p => { p.in = false; });
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      if (el) { paint(); el = null; }
      tag.hidden = true; box.classList.remove('zoomed'); started = false;
    }
    function stopAnim() { if (anim) { cancelAnimationFrame(anim.id); anim = null; } }

    // ---- 松手后的动画: 惯性 + 越界弹回 + 缩放回弹 / 还原 ----
    function startLoop(vx, vy, goal) {
      stopAnim();
      anim = { vx, vy, goal: goal || null, last: performance.now(), id: 0 };
      anim.id = requestAnimationFrame(step);
    }
    function step(now) {
      const a = anim; if (!a || !el) { anim = null; return; }
      const dt = clamp(now - a.last, 1, 34); a.last = now;
      let busy = false;
      if (a.goal) {
        const k = 1 - Math.exp(-dt / 95), g = a.goal;
        s += (g.s - s) * k; tx += (g.x - tx) * k; ty += (g.y - ty) * k;
        if (Math.abs(s - g.s) < .002 && Math.abs(tx - g.x) < .4 && Math.abs(ty - g.y) < .4) { s = g.s; tx = g.x; ty = g.y; } else busy = true;
      } else {
        if (a.vx || a.vy) {
          tx += a.vx * dt; ty += a.vy * dt;
          const d = Math.exp(-dt / 230); a.vx *= d; a.vy *= d;
          if (Math.hypot(a.vx, a.vy) < .03) a.vx = a.vy = 0; else busy = true;
        }
        const sc = clamp(s, 1, MAX);
        if (s !== sc) { s += (sc - s) * (1 - Math.exp(-dt / 85)); if (Math.abs(s - sc) < .001) s = sc; else busy = true; }
        const L = limits(s);
        for (const ax of ['x', 'y']) {
          const [lo, hi] = L[ax], v = ax === 'x' ? tx : ty, c = clamp(v, lo, hi), over = v - c;
          if (!over) continue;
          let nv;
          if (Math.abs(over) < .3) nv = c; else { nv = c + over * Math.exp(-dt / 65); busy = true; if (ax === 'x') a.vx *= Math.exp(-dt / 40); else a.vy *= Math.exp(-dt / 40); }
          if (ax === 'x') tx = nv; else ty = nv;
        }
      }
      paint();
      if (busy) a.id = requestAnimationFrame(step);
      else { anim = null; if (s < 1.0005) hard(); }
    }
    function release(vx, vy) {
      if (!el) return;
      if (s < EPS) return startLoop(0, 0, { s: 1, x: 0, y: 0 });
      startLoop(vx, vy, null);
    }
    function reset(instant) {
      clearTimeout(tapT); lastTap = null;
      if (!el) return;
      if (instant) return hard();
      pts.forEach(p => { p.in = false; }); G = null; pinching = false;
      startLoop(0, 0, { s: 1, x: 0, y: 0 });
    }

    // ---- 手势 ----
    const parts = () => [...pts.values()].filter(p => p.in);
    function place(f, q, raw) {                                                         // 围着 f 缩放: 保持画面上 q 那一点留在 f 下面
      s = rubS(raw);
      const L = limits(s);
      tx = rubT(f.x - s * q.x, L.x, L.W); ty = rubT(f.y - s * q.y, L.y, L.H);
    }
    function rebase() {
      const ps = parts();
      if (ps.length >= 2) {
        const [a, b] = ps;
        G = { k: 'pinch', f0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, d0: Math.max(Math.hypot(a.x - b.x, a.y - b.y), 24), s0: s, q: { x: ((a.x + b.x) / 2 - tx) / s, y: ((a.y + b.y) / 2 - ty) / s } };
      } else if (ps.length === 1) G = { k: 'pan', p0: { x: ps[0].x, y: ps[0].y }, t0: { x: tx, y: ty }, hist: [{ t: performance.now(), x: tx, y: ty }] };
      else G = null;
    }
    function update() {
      if (!G || !el) return;
      const ps = parts();
      if (G.k === 'pinch' && ps.length >= 2) {
        const [a, b] = ps, f = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, d = Math.hypot(a.x - b.x, a.y - b.y);
        place(f, G.q, G.s0 * d / G.d0);
      } else if (G.k === 'pan' && ps.length >= 1) {
        const L = limits(s), p = ps[0];
        tx = rubT(G.t0.x + p.x - G.p0.x, L.x, L.W); ty = rubT(G.t0.y + p.y - G.p0.y, L.y, L.H);
        const now = performance.now(); G.hist.push({ t: now, x: tx, y: ty });
        while (G.hist.length > 2 && now - G.hist[0].t > 120) G.hist.shift();
      }
      draw();
    }
    function velocity() {                                                               // 松手时的速度 (px/ms)，手指停住再抬起就没有惯性
      if (!G || G.k !== 'pan') return [0, 0];
      const h = G.hist, last = h[h.length - 1], first = h[0], now = performance.now();
      if (h.length < 2 || now - last.t > 70) return [0, 0];
      const dt = Math.max(16, last.t - first.t);
      return [clamp((last.x - first.x) / dt, -3, 3), clamp((last.y - first.y) / dt, -3, 3)];
    }
    function cancelPassed(p) {                                                          // 给已经交给页面的那根手指补一个 pointercancel
      synth = true;
      try { p.target.dispatchEvent(new PointerEvent('pointercancel', { pointerId: p.id, pointerType: p.type, isPrimary: true, bubbles: true, composed: true })); } catch {}
      synth = false;
    }
    function onStart() { if (!started) { started = true; o.onStart && o.onStart(); } }

    box.addEventListener('pointerdown', e => {
      if (synth || !enabled() || e.target.closest(ignore)) return;
      const soft = !!e.target.closest(softSel);
      if (e.pointerType === 'mouse' && (e.button !== 0 || s < EPS)) return;   // 鼠标只在放大后拖动平移
      if (pts.size >= 2) return;
      const v = getEl(); if (!v) return;
      if (el && el !== v) hard();
      el = v; v.style.touchAction = 'none';
      const r = rel(e);
      const p = { id: e.pointerId, type: e.pointerType, x: r.x, y: r.y, x0: r.x, y0: r.y, t0: performance.now(), target: e.target, in: false, passed: false, moved: false, multi: false };
      if (pts.size === 0) {
        stopAnim();
        if (s >= EPS && !soft) { p.in = true; e.stopPropagation(); pts.set(p.id, p); rebase(); }
        else { p.passed = true; pts.set(p.id, p); }
        return;
      }
      const first = [...pts.values()][0];
      if (first.type === 'mouse' || p.type === 'mouse') return;
      stopAnim();
      if (first.passed) { first.passed = false; cancelPassed(first); }
      first.in = p.in = first.multi = p.multi = true;
      pts.set(p.id, p); pinching = true;
      e.stopPropagation(); onStart(); rebase(); draw();
    }, true);
    box.addEventListener('pointermove', e => {
      const p = pts.get(e.pointerId); if (!p) return;
      const r = rel(e); p.x = r.x; p.y = r.y;
      if (!p.moved && Math.hypot(p.x - p.x0, p.y - p.y0) > 8) p.moved = true;
      if (p.in) { e.stopPropagation(); update(); }
    }, true);
    const end = e => {
      if (synth) return;
      const p = pts.get(e.pointerId); if (!p) return;
      pts.delete(e.pointerId);
      if (!p.in) return;
      e.stopPropagation();
      const rest = [...pts.values()];
      if (pinching && rest.length) {                                                    // 抬起一根: 剩下那根接着平移
        rest[0].in = true; pinching = false; rebase(); return;
      }
      pinching = false;
      const cancelled = e.type === 'pointercancel';
      const mouseNative = p.type === 'mouse' && o.nativeClick;
      suppressUntil = performance.now() + (mouseNative ? (p.moved ? 350 : 0) : 450);    // 手指抬起后的 click 由这里自己处理 (单击 / 双击)
      const [vx, vy] = velocity();
      G = null;
      if (!cancelled && !p.moved && !p.multi && !mouseNative && performance.now() - p.t0 < 400 && tap(p)) return;   // 双击还原: 动画已经起了, 别再被松手的惯性顶掉
      release(vx, vy);
    };
    box.addEventListener('pointerup', end, true);
    box.addEventListener('pointercancel', end, true);
    function tap(p) {
      const now = performance.now();
      if (lastTap && now - lastTap.t < 320 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 70) { clearTimeout(tapT); lastTap = null; reset(false); return true; }
      lastTap = { t: now, x: p.x, y: p.y };
      clearTimeout(tapT);
      tapT = setTimeout(() => { lastTap = null; o.onTap && o.onTap(p.type); }, 300);
      return false;
    }
    box.addEventListener('click', e => {
      if (performance.now() < suppressUntil && !e.target.closest(ignore)) { e.stopPropagation(); e.preventDefault(); }
    }, true);
    // 放大后的单击 / 拖动不该让页面把浏览器的默认动作 (选中文字、拖拽图片) 带出来
    box.addEventListener('dragstart', e => { if (s >= EPS) e.preventDefault(); }, true);

    // ---- 电脑: 触控板捏合 / Ctrl+滚轮 / 放大后滚轮平移 ----
    box.addEventListener('wheel', e => {
      if (!enabled() || e.target.closest(ignore)) return;
      const v = getEl(); if (!v) return;
      const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      if (e.ctrlKey) {
        e.preventDefault(); e.stopPropagation();
        const ns = clamp(s * Math.exp(-e.deltaY * k * (Math.abs(e.deltaY * k) >= 50 ? .0025 : .012)), 1, MAX);
        if (ns === s) return;                                                           // 已经到头 (1× 还往小缩 / 最大还往大放): 吞掉, 不让页面跟着缩放
        if (el && el !== v) hard();
        el = v; stopAnim(); onStart();
        const f = rel(e), q = { x: (f.x - tx) / s, y: (f.y - ty) / s };
        s = ns; const L = limits(s);
        tx = clamp(f.x - s * q.x, ...L.x); ty = clamp(f.y - s * q.y, ...L.y);
        if (s < 1.004) { s = 1; tx = ty = 0; }
        paint();
        if (s === 1) hard();
      } else if (s >= EPS && el === v) {
        e.preventDefault(); e.stopPropagation(); stopAnim();
        const L = limits(s);
        tx = clamp(tx - e.deltaX * k, ...L.x); ty = clamp(ty - e.deltaY * k, ...L.y);
        draw();
      }
    }, { capture: true, passive: false });
    // Safari (macOS 触控板): gesture 事件。iOS 上手指已经走 pointer 了, 这里只在没有触点时处理。
    for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) box.addEventListener(ev, e => {
      if (!enabled()) return;
      e.preventDefault();
      if (pts.size) return;
      const v = getEl(); if (!v) return;
      if (ev === 'gesturestart') {
        if (el && el !== v) hard();
        el = v; stopAnim(); onStart();
        const f = rel(e); gs = { s0: s, q: { x: (f.x - tx) / s, y: (f.y - ty) / s } };
      } else if (ev === 'gesturechange' && gs) { place(rel(e), gs.q, gs.s0 * e.scale); draw(); }
      else if (ev === 'gestureend' && gs) { gs = null; release(0, 0); }
    }, { passive: false });

    return {
      reset,
      resetFor(v) { if (el && el === v) hard(); },                                      // 这个 video 换了片源 / 被回收: 不管它缩放到哪, 立刻还原
      refit() { if (!el) return; if (s < EPS) return hard(); const L = limits(s); tx = clamp(tx, ...L.x); ty = clamp(ty, ...L.y); stopAnim(); paint(); },
      zoomed: () => s >= EPS,
    };
  };
})();
