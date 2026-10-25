// ---------- 沉浸式看片 (full-screen vertical feed, Douyin-style) ----------
// One title per screen. Wheel / ↑↓ / swipe up-down switch titles; swipe left-right, ←→ or the bottom bar seek;
// tap pauses, double-tap likes, long-press plays at 2x. Three <video> slides (previous / current / next) are kept
// alive so a swipe lands on a picture that is already buffered, and the next few titles' details are fetched ahead
// (only titles that turned out playable ever enter the feed). Likes, skips and watch time feed a small taste profile
// that steers the 推荐 stream (kept in localStorage.feedProf, per browser).
(() => {
const ic = (d, extra = '') => `<svg viewBox="0 0 24 24" aria-hidden="true" ${extra}>${d}</svg>`;
const I = {
  close: ic('<path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>'),
  heart: ic('<path d="M12 21l-1.5-1.3C5.4 15.1 2 12 2 8.5A4.5 4.5 0 0 1 6.5 4c1.7 0 3.4.8 4.5 2.1C12.1 4.8 13.8 4 15.5 4A4.5 4.5 0 0 1 20 8.5c0 3.5-3.4 6.6-8.5 11.2z"/>'),
  star: ic('<path d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6L2.5 9.4l6.6-.8z"/>'),
  list: ic('<path d="M4 6h16v2H4zM4 11h16v2H4zM4 16h10v2H4z"/>'),
  info: ic('<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-6h2zm0-8h-2V7h2z"/>'),
  ban: ic('<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 2a8 8 0 0 1 6.3 12.9L7.1 5.7A7.9 7.9 0 0 1 12 4zM5.7 7.1l11.2 11.2A8 8 0 0 1 5.7 7.1z"/>'),
  vol: ic('<path d="M4 9v6h4l5 5V4L8 9z"/><path class="w" d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="2"/><path class="x" d="M16 9l6 6M22 9l-6 6" stroke="currentColor" stroke-width="2"/>'),
  fs: ic('<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" fill="none" stroke="currentColor" stroke-width="2.2"/>'),
  play: ic('<path d="M7 4.5v15l12-7.5z"/>'),
  up: ic('<path d="M5 15l7-7 7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>'),
  down: ic('<path d="M5 9l7 7 7-7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>'),
  caret: ic('<path d="M7 10l5 5 5-5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>'),
};
const touchUi = matchMedia('(hover: none), (pointer: coarse)').matches;

const root = document.createElement('div');
root.id = 'feed'; root.hidden = true;
root.innerHTML = `
  <div class="fd-slides"></div>
  <div class="fd-top">
    <button class="fd-ic" data-a="close" title="退出 (Esc)" aria-label="退出">${I.close}</button>
    <span class="fd-grow"></span>
    <button class="fd-mode" data-a="mode"><span></span>${I.caret}</button>
    <span class="fd-grow"></span>
    <button class="fd-ic" data-a="mute" title="静音 (m)" aria-label="静音">${I.vol}</button>
  </div>
  <div class="fd-rail">
    <button data-a="like" title="喜欢 (l)">${I.heart}<span>喜欢</span></button>
    <button data-a="fav" title="收藏 (s)">${I.star}<span>收藏</span></button>
    <button data-a="eps" title="选集 (e)">${I.list}<span>选集</span></button>
    <button data-a="detail" title="详情 (i)">${I.info}<span>详情</span></button>
    <button data-a="dislike" title="不感兴趣 (d)">${I.ban}<span>不想看</span></button>
  </div>
  <div class="fd-nav fd-fine"><button data-a="up" title="上一个 (↑)" aria-label="上一个">${I.up}</button><button data-a="down" title="下一个 (↓)" aria-label="下一个">${I.down}</button></div>
  <div class="fd-prog"><div class="rail"><i class="buf"></i><i class="played"></i><b class="knob"></b></div></div>
  <div class="fd-tip" hidden></div>
  <div class="fd-rate" hidden>2x 快进中</div>
  <div class="fd-boot">${spinner}<span>正在为你挑选…</span></div>
  <div class="fd-hint" hidden></div>
  <div class="fd-menu" hidden></div>
  <div class="fd-sheet" hidden></div>`;
document.body.append(root);
const q = s => root.querySelector(s);
const slidesBox = q('.fd-slides'), prog = q('.fd-prog'), tipEl = q('.fd-tip'), rateEl = q('.fd-rate'), menuEl = q('.fd-menu'), sheetEl = q('.fd-sheet'), bootEl = q('.fd-boot');

// ---------- taste profile ----------
// Flat map tag → score. Tags: t:类型 a:地区 y:年代 p:演员. Likes / long watches raise, quick skips / 不想看 lower.
const JUNK = /解说|资讯|新闻|预告|花絮|写真|福利/;
const sat = v => 4 * Math.tanh(v / 4);
const loadJson = (k, d) => { try { return JSON.parse(localStorage[k] || ''); } catch { return d; } };
let P = null, evt = 0, saveT = 0;
const tagsOf = (it, d) => {
  const tags = [];
  if (it.type) tags.push(['t:' + it.type, 1]);
  String(it.area || '').split(/[,，/、\s]+/).filter(Boolean).slice(0, 2).forEach(a => tags.push(['a:' + a, .6]));
  if (/^\d{4}/.test(it.year || '')) tags.push(['y:' + it.year.slice(0, 3) + '0', .3]);
  (d?.actors || []).slice(0, 3).forEach(a => tags.push(['p:' + a, .5]));
  return tags;
};
function profile() {
  if (P) return P;
  P = loadJson('feedProf', null);
  if (!P) {
    P = {};
    const add = (list, w) => list.slice(0, 30).forEach(it => tagsOf(it).forEach(([k, m]) => { P[k] = (P[k] || 0) + w * m; }));
    add(favs.list(), 2); add(hist.list(), 1);
  }
  return P;
}
function bump(it, d, w) {
  const p = profile();
  for (const [k, m] of tagsOf(it, d)) p[k] = Math.max(-8, Math.min(14, (p[k] || 0) + w * m));
  if (++evt % 25 === 0) for (const k of Object.keys(p)) { p[k] *= .9; if (Math.abs(p[k]) < .2) delete p[k]; }
  clearTimeout(saveT); saveT = setTimeout(() => { localStorage.feedProf = JSON.stringify(p); }, 800);
}
const scoreOf = it => tagsOf(it).reduce((s, [k, m]) => s + sat(profile()[k] || 0) * m, 0);

const seen = new Set(loadJson('feedSeen', []));
const keyOf = it => it.site + '|' + it.id;
const nameOf = it => normName(it.name) + '|' + (it.year || '');   // the same title on another source is still the same title
const markSeen = it => { seen.add(keyOf(it)); if (seen.size > 900) [...seen].slice(0, 100).forEach(k => seen.delete(k)); localStorage.feedSeen = JSON.stringify([...seen]); };
const likes = new Set(loadJson('feedLikes', []));
const saveLikes = () => { localStorage.feedLikes = JSON.stringify([...likes].slice(-500)); };

// ---------- state ----------
const F = { recN: 0, names: new Set(), gen: 0, mode: 'rec', extra: null, items: [], cand: [], keys: new Set(), idx: 0, done: false, pumping: false, started: false, empties: 0,
  pool: [], pcount: {}, cats: null, catsSite: '', catUsed: new Set(), catCount: 1, once: false, dir: 1,
  muted: localStorage.feedMuted === '1', autoMuted: false, userPaused: false };   // autoMuted: the browser refused sound-on autoplay, muted for now only
const AHEAD = 6;                                    // titles kept validated (detail fetched) beyond the current one

// ---------- slides ----------
// 横屏视频 (竖屏手机上): 画面往上提一些 (同抖音), 下面出一个「全屏观看」按钮
// 简介的行数: 竖屏 / 非横屏视频固定 2 行; 横屏视频 (画面上提, 下面空出一大块) 按可用高度多显示几行, 只要不压到视频和「全屏观看」按钮
function fitBlurb(s) {
  const info = s.el.querySelector('.fd-info'), p = s.blurb;
  let lines = 2;
  if (s.el.classList.contains('land') && p.textContent && !s.el.classList.contains('empty')) {
    const H = root.clientHeight, bottom = parseFloat(getComputedStyle(info).bottom) || 0;
    const top = (parseFloat(s.el.style.getPropertyValue('--lbtn')) || 0) + 28 + 10;      // 按钮下沿再留一点空隙
    const room = H - bottom - top - s.h2.offsetHeight - s.meta.offsetHeight - 14;        // 14 = 标题和元信息下面的间距
    lines = Math.max(2, Math.min(12, Math.floor(room / 19.5)));
  }
  p.style.webkitLineClamp = String(lines);
}
function layoutLand(s) {
  const v = s.video, W = root.clientWidth, H = root.clientHeight;
  if (!v.videoWidth || !W) return;   // 还不知道尺寸 (或沉浸层没显示): 保持原状, 不要把已有的上提取消掉
  const land = v.videoWidth > v.videoHeight * 1.15 && H > W * 1.2;
  s.el.classList.toggle('land', land);
  if (!land) { fitBlurb(s); return; }
  const vh = W * v.videoHeight / v.videoWidth, shift = H * .09;
  s.el.style.setProperty('--lshift', shift + 'px');
  s.el.style.setProperty('--lbtn', Math.round(H / 2 - shift + vh / 2 + 18) + 'px');
  fitBlurb(s);
}
function mkSlide() {
  const el = document.createElement('section');
  el.className = 'fd-slide empty';
  el.innerHTML = `<div class="fd-bg"></div><div class="fd-cover"></div><video playsinline webkit-playsinline preload="auto"></video><div class="fd-shade"></div>
    <div class="fd-wait"></div><div class="fd-pause">${I.play}</div>
    <button class="fd-full" data-a="full" aria-label="全屏观看">${I.fs}<span>全屏观看</span></button>
    <div class="fd-info"><h2></h2><div class="m"></div><p></p></div><div class="fd-msg"></div>`;
  slidesBox.append(el);
  const s = { el, video: el.querySelector('video'), bg: el.querySelector('.fd-bg'), cover: el.querySelector('.fd-cover'), h2: el.querySelector('h2'), meta: el.querySelector('.m'), blurb: el.querySelector('p'), msg: el.querySelector('.fd-msg'),
    i: -1, it: null, d: null, line: 0, ep: 0, eps: [], startAt: 0, hls: null, via: false, loading: false, pre: false, err: false, watched: 0, lastT: 0, judged: true, lastSave: 0 };
  const v = s.video;
  { const vol = parseFloat(localStorage.playerVolume); if (Number.isFinite(vol)) v.volume = Math.min(1, Math.max(0, vol)); }   // same level as the main player
  for (const ev of ['loadedmetadata', 'loadeddata', 'canplay', 'playing', 'resize']) v.addEventListener(ev, () => layoutLand(s));   // HLS 的画面尺寸有时晚一点才知道
  v.addEventListener('playing', () => { el.classList.remove('wait', 'paused'); });
  const framed = () => { if (v.readyState >= 2 && v.videoWidth) el.classList.add('framed'); };
  for (const ev of ['loadeddata', 'canplay', 'playing', 'seeked', 'timeupdate']) v.addEventListener(ev, framed);
  v.addEventListener('waiting', () => { if (s === cur()) el.classList.add('wait'); });
  v.addEventListener('canplay', () => el.classList.remove('wait'));
  v.addEventListener('progress', () => { if (s === cur() && aheadOf(v) >= 6) kick(); });
  v.addEventListener('play', () => el.classList.remove('paused'));
  v.addEventListener('pause', () => { if (s === cur() && !v.ended) el.classList.add('paused'); });
  v.addEventListener('ended', () => { if (s === cur()) onEnded(s); });
  v.addEventListener('timeupdate', () => {
    const dt = v.currentTime - s.lastT; s.lastT = v.currentTime;
    if (s !== cur()) return;
    if (dt > 0 && dt < 1.5 && !v.paused) s.watched += dt;
    if (Date.now() - s.lastSave > 4000 && v.duration) saveHist(s);
  });
  return s;
}
const slides = [mkSlide(), mkSlide(), mkSlide()];
// 缓冲圈不放在会滑动的画面里 (切换时会跟着上下移动): 全局只有一个, 钉在屏幕中央, 滑动中不显示
const spin = document.createElement('div'); spin.className = 'fd-spin'; spin.hidden = true; root.append(spin);
const paintSpin = () => {
  const s = ring[1]; if (!s) return;
  const show = s.el.classList.contains('wait') && !s.el.classList.contains('paused') && !s.el.classList.contains('empty') && !root.classList.contains('dragging') && !root.classList.contains('moving');
  spin.hidden = !show;
  spin.style.setProperty('--lshift', s.el.classList.contains('land') ? (s.el.style.getPropertyValue('--lshift') || '0px') : '0px');
};
{ const mo = new MutationObserver(paintSpin); [...slides.map(s => s.el), root].forEach(n => mo.observe(n, { attributes: true, attributeFilter: ['class'] })); }

let ring = slides.slice();                          // [previous, current, next]
const cur = () => ring[1];
const covered = () => !!$('#modal') || !player.hidden;

function saveHist(s) {
  if (!s.d || !s.video.duration || !isFinite(s.video.duration)) return;
  s.lastSave = Date.now();
  const d = s.d;
  hist.put({ site: d.site, adult: d.adult ? 1 : 0, siteName: d.siteName, id: d.id, name: d.name, pic: d.pic, remarks: d.remarks, year: d.year,
    line: s.line, ep: s.ep, epName: s.eps[s.ep]?.name || '', t: s.video.currentTime, dur: s.video.duration });
}

function teardown(s) {
  if (s.hls) { s.hls.destroy(); s.hls = null; }
  const v = s.video;
  v.onerror = null; v.onloadedmetadata = null;
  v.pause(); v.removeAttribute('src'); v.removeAttribute('poster'); v.load();
  s.lastT = 0; s.el.classList.remove('wait', 'paused', 'land', 'framed');   // 换片: 上一部的横屏上提不带到下一部
}

// What to play for a title: its saved place if it has one, else the first episode of the first line.
function pickStart(s) {
  const d = s.d, h = hist.get(d.site, d.id);
  s.line = h && d.lines[h.line] ? h.line : 0;
  s.eps = d.lines[s.line].episodes;
  s.ep = h && h.line === s.line && s.eps[h.ep] ? h.ep : 0;
  s.startAt = h && h.line === s.line && h.ep === s.ep && h.dur - h.t > 30 ? h.t : 0;
}
function paintInfo(s) {
  const { it, d } = s;
  s.h2.textContent = d.name || it.name;
  const epn = s.eps.length > 1 ? `${s.eps[s.ep].name} · 共 ${s.eps.length} 集` : '';
  s.meta.textContent = [epn, d.type || it.type, d.year || it.year, d.siteName || it.siteName].filter(Boolean).join(' · ');
  s.blurb.textContent = d.blurb || it.blurb || '';
  fitBlurb(s);
}
// Background + cover of a slide use the SAME picture the title's card shows (for 成人 titles that is javdb's cover when there is one).
function paintCover(s, it) {
  const pic = cardPic(it);
  s.bg.style.cssText = bg(dbSize(pic, 's') || pic);
  s.cover.style.cssText = pic && it.adult ? (dbSize(pic, 'l') || dbSize(pic, 'm') ? `background-image:${cssUrl(dbSize(pic, 'm') || pic)},${cssUrl(dbSize(pic, 's') || pic)}` : bg(pic)) : '';
  s.el.classList.toggle('hascover', !!pic && !!it.adult);
}
function bind(s, i) {
  teardown(s);
  const it = F.items[i] || null;
  Object.assign(s, { i, it, d: null, err: false, watched: 0, judged: !it, loading: false, via: false, pre: false });
  s.msg.textContent = '';
  s.el.classList.toggle('empty', !it);
  if (!it) { s.bg.style.cssText = ''; s.cover.style.cssText = ''; s.el.classList.remove('hascover'); return; }
  paintCover(s, it);
  // 成人: javdb knows the right cover for a 番号 (what the card swaps in) — repaint once it is known, cached after the first time
  if (it.adult && state.level === 'all') { const code = javCode(it.name); if (code) javMeta(code).then(r => { if (s.it === it && r.found && r.cover && javCoverWanted(it)) paintCover(s, it); }); }
  s.el.classList.remove('framed');
  s.h2.textContent = it.name; s.meta.textContent = ''; s.blurb.textContent = '';
  if (it._d) return ready(s, it._d);
  validate(it).then(d => { if (s.it !== it) return; if (!d) { s.err = true; s.msg.textContent = '这部暂时播不了'; return; } it._d = d; ready(s, d); });
}
function ready(s, d) {
  s.d = d; pickStart(s); paintInfo(s);
  const pic = cardPic(s.it);
  if (pic) s.video.poster = img(dbSize(pic, 'm') || pic);
  attach(s);
  if (s === cur()) syncRail(); else if (cur()?.d && aheadOf(cur().video) >= 6) startPre(s);
}

// ---------- playback ----------
const bufCfg = role => role === 0 ? { maxBufferLength: 30, maxMaxBufferLength: 60 } : { maxBufferLength: 4, maxMaxBufferLength: 6 };
function attach(s, viaProxy = false) {
  const url = s.eps[s.ep].url, role = ring.indexOf(s) - 1, v = s.video;
  const direct = /\.mp4(\?|$)/i.test(url) || url.startsWith('/media/f/');
  const src = viaProxy ? '/hls?u=' + encodeURIComponent(url) : url;
  s.via = viaProxy; s.err = false; s.msg.textContent = '';
  if (s.hls) { s.hls.destroy(); s.hls = null; }
  const startAt = s.startAt;
  let seeked = false;
  const onMeta = () => {
    if (!s.hls && startAt && !seeked) { seeked = true; v.currentTime = startAt; }
    if (s === cur()) tryPlay(s);
  };
  v.onerror = () => fail(s, '无法解码');
  if (window.Hls && Hls.isSupported() && !direct) {
    s.loading = role === 0 || s.pre;
    const h = s.hls = new Hls({ enableWorker: true, capLevelToPlayerSize: true, backBufferLength: 20, autoStartLoad: s.loading, startPosition: startAt || -1, ...bufCfg(role) });
    h.on(Hls.Events.MANIFEST_PARSED, onMeta);
    h.on(Hls.Events.ERROR, (_, data) => { if (data.fatal) fail(s, data.details); });
    h.loadSource(src); h.attachMedia(v);
  } else {
    v.preload = role === 0 || s.pre ? 'auto' : 'metadata';
    v.src = src; v.onloadedmetadata = onMeta;
  }
  if (s === cur()) { s.el.classList.add('wait'); tryPlay(s); }
}
function fail(s, why) {
  const url = s.eps[s.ep]?.url || '';
  if (!s.via && !url.startsWith('/media/')) { attach(s, true); return; }
  s.err = true; s.el.classList.remove('wait');
  s.msg.textContent = '这部播放失败了，已为你跳过';
  if (s === cur()) setTimeout(() => { if (s === cur() && s.err) go(F.dir); }, 1200);
}
// Only the current title loads at full speed. The neighbours stay idle until the current one has ~6 s buffered (kick), so
// they never fight it for bandwidth; after that they pre-buffer a few seconds each so a swipe lands on a ready picture.
const aheadOf = v => { let e = 0; for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= v.currentTime + 1) e = Math.max(e, v.buffered.end(i)); return e - v.currentTime; };
function startPre(s) {
  if (s.pre || !s.d) return;
  s.pre = true;
  if (s.hls) { if (!s.loading) { s.hls.startLoad(-1); s.loading = true; } } else s.video.preload = 'auto';
}
let kickT = 0;
function kick() { clearTimeout(kickT); ring.forEach(s => { if (s !== cur()) startPre(s); }); }
function setRole(s, role) {
  if (s.hls) {
    Object.assign(s.hls.config, bufCfg(role));
    if (role === 0) { if (!s.loading) { s.hls.startLoad(-1); s.loading = true; } }
    else if (role < 0 && s.loading) { s.hls.stopLoad(); s.loading = false; }
    else if (role > 0 && s.pre && !s.loading) { s.hls.startLoad(-1); s.loading = true; }
  } else s.video.preload = role === 0 || (s.pre && role > 0) ? 'auto' : 'metadata';
}
const paintMute = () => q('[data-a=mute]').classList.toggle('off', F.muted || F.autoMuted);
function setMuted(m, save = true) {
  F.muted = m; F.autoMuted = false;
  if (save) localStorage.feedMuted = m ? '1' : '0';
  ring.forEach(s => { s.video.muted = m; });
  paintMute();
}
// The user's mute choice is only ever changed by the speaker button. When the browser blocks autoplay with sound
// (NotAllowedError) the current video is muted temporarily and the sound comes back on the next tap / key press.
function unlockSound() {
  if (!F.autoMuted) return;
  F.autoMuted = false;
  ring.forEach(s => { s.video.muted = F.muted; });
  paintMute();
}
for (const ev of ['pointerdown', 'keydown', 'touchend']) addEventListener(ev, () => { if (!root.hidden) unlockSound(); }, true);
function tryPlay(s) {
  if (s !== cur() || F.userPaused || covered() || document.hidden || !s.d) return;
  const v = s.video;
  v.muted = F.muted || F.autoMuted;
  const p = v.play();
  if (p) p.catch(err => {
    if (err?.name === 'AbortError') {            // interrupted by a newer load / pause (a normal part of switching titles): not a sound problem
      if (s === cur() && !F.userPaused && !document.hidden) setTimeout(() => { if (s === cur() && v.paused) tryPlay(s); }, 150);
      return;
    }
    if (err?.name === 'NotAllowedError' && !v.muted) {
      F.autoMuted = true; v.muted = true; paintMute();   // preference untouched; sound returns at the next gesture
      v.play().catch(() => s.el.classList.add('paused'));
      toast('浏览器拦截了自动播放声音，已先静音，点一下屏幕就恢复');
    } else s.el.classList.add('paused');
  });
}
function togglePause() {
  const s = cur(); if (!s?.d) return;
  if (s.video.paused) { F.userPaused = false; tryPlay(s); } else { F.userPaused = true; s.video.pause(); }
}
function onEnded(s) {
  if (s.ep < s.eps.length - 1) { toast(`下一集：${s.eps[s.ep + 1].name}`); return switchEp(s, s.line, s.ep + 1); }
  if (F.idx < F.items.length - 1) return go(1);
  s.video.currentTime = 0; tryPlay(s);                 // last title of a finished list: loop it
}
function switchEp(s, line, ep, startAt = 0) {
  saveHist(s);
  s.line = line; s.eps = s.d.lines[line].episodes; s.ep = Math.max(0, Math.min(ep, s.eps.length - 1)); s.startAt = startAt;
  s.watched = 0; s.judged = false;
  paintInfo(s); attach(s);
  if (!sheetEl.hidden) renderSheet();
}

function activate() {
  ring.forEach((s, r) => { setRole(s, r - 1); if (r !== 1) s.video.pause(); });
  const s = cur();
  F.userPaused = false;
  if (!s.it) return;
  markSeen(s.it);
  syncRail();
  clearTimeout(kickT); kickT = setTimeout(kick, 7000);
  if (s.err) { s.msg.textContent = s.msg.textContent || '这部暂时播不了'; setTimeout(() => { if (s === cur() && s.err) go(F.dir); }, 800); return; }
  tryPlay(s);
}
// Leaving a title tells the profile what it was worth.
function leave(s) {
  if (!s.it) return;
  saveHist(s);
  if (s.judged) return; s.judged = true;
  const dur = s.video.duration;
  if (s.watched < 3) bump(s.it, s.d, -.8);
  else if (s.watched > 25 || (dur && isFinite(dur) && s.watched / dur > .5)) bump(s.it, s.d, 1.2);
}

// ---------- candidates ----------
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, bad) => setTimeout(() => bad(new Error('timeout')), ms))]);
async function validate(it) {
  try {
    const d = await withTimeout(api('detail', { site: it.site, id: it.id }, null), 10e3);
    return d && d.lines?.length && d.lines[0].episodes?.length ? d : null;
  } catch { return null; }
}
const wpick = (list, n, w) => {
  const bag = list.slice(), out = [];
  while (out.length < n && bag.length) {
    const ws = bag.map(w), sum = ws.reduce((a, b) => a + b, 0);
    let r = Math.random() * sum, k = 0;
    while (k < bag.length - 1 && (r -= ws[k]) > 0) k++;
    out.push(bag.splice(k, 1)[0]);
  }
  return out;
};
// 推荐 = random play with taste mixed in. Every batch of 6 is: 3 plain random titles (random categories, random pages, nothing
// weighs on them), 2 picked by taste (types / regions / eras you liked, saved or watched long) and 1 "more like what you
// saved" — a title with an actor you liked or saved. The order is interleaved so a liked kind never comes twice in a row.
const takeAt = (list, k) => list.splice(k, 1)[0];
const takeRandom = list => list.length ? takeAt(list, Math.floor(Math.random() * list.length)) : null;
const takeBest = list => {
  if (!list.length) return null;
  let k = 0, best = -1e9;
  list.forEach((it, i) => { const sc = scoreOf(it) + Math.random() * .8; if (sc > best) { best = sc; k = i; } });
  return takeAt(list, k);
};
// Actors (from 收藏 / 喜欢 / long watches) are searched by name across the sources: their other titles join the pool as 'fav'.
async function actorCands(gen) {
  const tops = Object.entries(profile()).filter(([k, v]) => k.startsWith('p:') && v >= 1.5).sort((x, y) => y[1] - x[1]).slice(0, 8);
  if (!tops.length) return [];
  const name = wpick(tops, 1, ([, v]) => v)[0][0].slice(2);
  const j = await api('person', { role: 'actor', name }, null).catch(() => null);
  if (!j || gen !== F.gen) return [];
  // 演员作品: the server keeps only titles whose credits really list the actor
  return (j.list || []).slice(0, 30).map(it => ({ ...it, _fav: 1 }));
}
async function recMore(gen) {
  const site = state.site;
  if (!F.cats || F.catsSite !== site) {
    const r = await api('categories', { site }, null).catch(() => ({ categories: [] }));
    F.cats = (r.categories || []).filter(c => !JUNK.test(c.name)); F.catsSite = site;
    if (!F.cats.length) F.cats = [{ id: '', name: '最新' }];
  }
  // 3 uniformly random categories + 1 taken from the liked types (weighted by how much they are liked; random when nothing is
  // liked yet); page numbers are uniform too.
  const liked = F.cats.filter(c => (profile()['t:' + c.name] || 0) >= 1);
  const picks = [...wpick(F.cats, 3, () => 1), ...(liked.length ? wpick(liked, 1, c => profile()['t:' + c.name]) : wpick(F.cats, 1, () => 1))];
  const res = await Promise.all([...picks.map(c => {
    const pk = site + '|' + c.id, n = F.pcount[pk];
    const pg = n ? 1 + Math.floor(Math.random() * Math.min(n, 40)) : 1;
    return api('list', { site, t: c.id, pg }, null).then(j => { F.pcount[pk] = j.pagecount; return j.list; }).catch(() => []);
  }), F.recN++ % 3 === 0 ? actorCands(gen) : []]);
  if (gen !== F.gen) return [];
  const inPool = new Set(F.pool.map(keyOf)), poolNames = new Set(F.pool.map(nameOf));
  for (const it of res.flat()) if (!seen.has(keyOf(it)) && !F.keys.has(keyOf(it)) && !inPool.has(keyOf(it)) && !F.names.has(nameOf(it)) && !poolNames.has(nameOf(it))) { F.pool.push(it); inPool.add(keyOf(it)); poolNames.add(nameOf(it)); }
  if (F.pool.length > 160) F.pool.splice(0, F.pool.length - 160);
  const plain = F.pool.filter(it => !it._fav), fav = F.pool.filter(it => it._fav), out = [];
  const take = it => { if (!it) return; F.pool.splice(F.pool.indexOf(it), 1); out.push(it); };
  const rest = () => F.pool.filter(it => !out.includes(it) && !it._fav);
  // R T R T R F  (any slot that cannot be filled falls back to a random one)
  take(takeRandom(plain)); take(takeBest(rest()));
  take(takeRandom(plain.filter(it => !out.includes(it)))); take(takeBest(rest()));
  take(takeRandom(plain.filter(it => !out.includes(it)))); take(fav.length ? takeRandom(fav) : takeRandom(rest()));
  fav.forEach(it => { if (!out.includes(it) && Math.random() < .5) F.pool.splice(F.pool.indexOf(it), 1); });   // unused actor titles do not pile up
  if (!out.length && seen.size) { seen.clear(); localStorage.feedSeen = '[]'; }   // everything seen: start over
  return out;
}
const poolAdd = list => {
  const keys = new Set(F.pool.map(keyOf)), names = new Set(F.pool.map(nameOf));
  for (const it of list) if (!F.keys.has(keyOf(it)) && !F.names.has(nameOf(it)) && !keys.has(keyOf(it)) && !names.has(nameOf(it))) { F.pool.push(it); keys.add(keyOf(it)); names.add(nameOf(it)); }
};
const drainPool = n => { const out = []; while (out.length < n && F.pool.length) out.push(out.length % 2 ? takeBest(F.pool) : takeRandom(F.pool)); return out; };
async function moreCands(gen) {
  const m = F.mode, fresh = list => list.filter(it => !F.keys.has(keyOf(it)));
  if (m === 'rec') return fresh(await recMore(gen));
  // 分类 / 搜索 的沉浸按钮: 随机播放 + 按喜好推荐 (一随机、一按口味, 交替); 从卡片右键进入的 'list' 则严格按列表顺序
  if (m === 'cat') {
    const x = F.extra;
    while (F.pool.length < 6 && F.catUsed.size < F.catCount) {
      let pg = 1;
      if (F.catUsed.size) do pg = 1 + Math.floor(Math.random() * F.catCount); while (F.catUsed.has(pg));
      F.catUsed.add(pg);
      const j = await api('list', { site: x.site, t: x.t, pg }, null);
      if (gen !== F.gen) return [];
      F.catCount = j.pagecount || 1;
      poolAdd(j.list || []);
    }
    return drainPool(6);
  }
  if (m === 'search') {
    if (!F.once) {
      F.once = true;
      const j = await api('search', { wd: F.extra.q, ...(F.extra.scope ? { site: F.extra.scope } : {}) }, null);
      if (gen !== F.gen) return [];
      poolAdd(j.results || []);
    }
    return drainPool(6);
  }
  if (m === 'fav' || m === 'hist') {
    if (!F.once) {
      F.once = true;
      const ok = it => state.sites.some(s => s.key === it.site);
      poolAdd((m === 'fav' ? favs : hist).list().filter(ok));
    }
    return drainPool(6);
  }
  if (F.once) return [];
  F.once = true;
  if (m === 'list') { const a = F.extra.items, k = F.extra.start || 0; return fresh(a.slice(k).concat(a.slice(0, k))); }
  return [];
}
// Keeps `AHEAD` validated titles in front of the viewer. Three details are fetched at a time and appended in order
// as soon as the earlier ones are in, so the first title shows up without waiting for the slowest.
async function pump() {
  if (F.pumping || F.done) return;
  F.pumping = true;
  const gen = F.gen;
  try {
    while (gen === F.gen && F.items.length < F.idx + AHEAD + 1) {
      if (F.cand.length < 3) {
        let more = [];
        try { more = await moreCands(gen); } catch (e) { if (gen === F.gen) toast('加载失败：' + e.message); }
        if (gen !== F.gen) return;
        if (!more.length) { if (++F.empties >= 2) { F.done = true; break; } continue; }
        F.empties = 0;
        more.forEach(it => { F.keys.add(keyOf(it)); F.names.add(nameOf(it)); });
        F.cand.push(...more);
      }
      const batch = F.cand.splice(0, 3), ps = batch.map(validate);
      for (let i = 0; i < batch.length; i++) {
        const d = await ps[i];
        if (gen !== F.gen) return;
        if (d) { batch[i]._d = d; F.items.push(batch[i]); onItems(); }
      }
    }
  } finally { F.pumping = false; }
  if (gen === F.gen && F.done && !F.items.length) { bootEl.querySelector('span').textContent = F.mode === 'rec' ? '这个源暂时没有可播放的内容，换个源试试' : '这里还没有内容'; bootEl.classList.add('empty'); }
}
function onItems() {
  root.classList.toggle('booting', !F.items.length);
  sync();
  if (!F.started && F.items.length) { F.started = true; activate(); showHint(); }
  else if (!cur().d && cur().it) { /* waiting for its own detail */ }
}
function sync() {
  ring.forEach((s, r) => {
    s.el.style.setProperty('--o', r - 1);
    const want = F.idx + r - 1;
    if (s.it !== (F.items[want] || null) || s.i !== want) bind(s, want);
  });
}
function warm() {
  for (let k = 1; k <= 3; k++) { const it = F.items[F.idx + k]; if (it?.pic) new Image().src = img(dbSize(it.pic, 'm') || it.pic); }
  for (let k = 0; k < F.idx - 12; k++) if (F.items[k]) F.items[k]._d = null;
  pump();
}

// ---------- navigation ----------
function go(dir) {
  const t = F.idx + dir;
  if (t < 0) return bounce();
  if (t >= F.items.length) { if (F.done) toast('没有更多了'); else { toast('正在加载…'); pump(); } return bounce(); }
  leave(cur());
  F.dir = dir; F.idx = t;
  root.classList.add('moving'); clearTimeout(go.mt); go.mt = setTimeout(() => { root.classList.remove('moving'); paintSpin(); }, 380);
  const recycled = dir > 0 ? ring[0] : ring[2];
  if (dir > 0) ring.push(ring.shift()); else ring.unshift(ring.pop());
  recycled.el.classList.add('nt');
  root.classList.remove('dragging'); root.style.setProperty('--dy', '0px');
  sync();
  void recycled.el.offsetWidth; recycled.el.classList.remove('nt');
  closeOverlays();
  activate(); warm();
}
function bounce() { root.classList.remove('dragging'); root.style.setProperty('--dy', '0px'); }

// ---------- modes ----------
function modeLabel() {
  const x = F.extra;
  if (F.mode === 'rec') return '推荐';
  if (F.mode === 'cat') return '分类 · ' + (x?.name || '全部');
  if (F.mode === 'search') return '搜索 · ' + (x?.q || '');
  if (F.mode === 'list') return x?.label || '列表';
  return { fav: '我的收藏', hist: '继续观看' }[F.mode];
}
function startMode(mode, extra) {
  F.names = new Set(); F.recN = 0;
  F.names = new Set();
  ring.forEach(s => { teardown(s); Object.assign(s, { i: -1, it: null, d: null }); s.el.classList.add('empty'); });
  Object.assign(F, { gen: F.gen + 1, mode, items: [], cand: [], keys: new Set(), idx: 0, done: false, pumping: false, started: false, empties: 0,
    pool: [], once: false, catUsed: new Set(), catCount: 1, userPaused: false });
  if (extra) F.extra = extra;
  root.classList.add('booting'); bootEl.classList.remove('empty'); bootEl.querySelector('span').textContent = '正在为你挑选…';
  closeOverlays();
  q('.fd-mode span').textContent = modeLabel();
  syncRail();
  pump();
}
function renderMenu() {
  const x = F.extra, kids = kidsMode();
  const entries = [['rec', '推荐 · ' + (state.sites.find(s => s.key === state.site)?.name || '')]];
  if (x && (x.mode === 'cat' || x.mode === 'search' || x.mode === 'list')) entries.push([x.mode, x.mode === 'cat' ? '分类 · ' + (x.name || '全部') : x.mode === 'search' ? '搜索 · ' + x.q : x.label || '列表']);
  if (!kids) entries.push(['fav', '我的收藏']);
  entries.push(['hist', '继续观看']);
  menuEl.innerHTML = entries.map(([k, n]) => `<button data-m="${k}" class="${k === F.mode ? 'on' : ''}">${esc(n)}</button>`).join('') + '<hr><button data-m="reset" class="dim">重置推荐偏好</button>';
}
menuEl.addEventListener('click', e => {
  const b = e.target.closest('[data-m]'); if (!b) return;
  const k = b.dataset.m;
  menuEl.hidden = true;
  if (k === 'reset') { P = {}; evt = 0; localStorage.feedProf = '{}'; seen.clear(); localStorage.feedSeen = '[]'; likes.clear(); saveLikes(); syncRail(); return toast('推荐偏好已重置'); }
  if (k !== F.mode) startMode(k);
});

// ---------- episodes sheet ----------
function renderSheet() {
  const s = cur(); if (!s.d) return;
  const d = s.d;
  sheetEl.innerHTML = `<div class="sh-head"><b>${esc(d.name)}</b><button class="fd-ic sm" data-sh="x" aria-label="关闭">${I.close}</button></div>
    ${d.lines.length > 1 ? `<div class="sh-lines">${d.lines.map((l, i) => `<button data-sl="${i}" class="${i === s.line ? 'on' : ''}">${esc(l.name)}</button>`).join('')}</div>` : ''}
    <div class="sh-eps">${s.eps.map((e, i) => `<button data-se="${i}" class="${i === s.ep ? 'on' : ''}">${esc(e.name)}</button>`).join('')}</div>`;
  // 不用 scrollIntoView: 它会把整个 #feed 容器也一起滚动, 界面整体上移错位。只滚动选集列表自己。
  const box = sheetEl.querySelector('.sh-eps'), on = sheetEl.querySelector('.on[data-se]');
  if (box && on) box.scrollTop = on.offsetTop - box.offsetTop - (box.clientHeight - on.offsetHeight) / 2;
  root.scrollTop = 0; root.scrollLeft = 0;
}
sheetEl.addEventListener('click', e => {
  const s = cur();
  if (e.target.closest('[data-sh]')) { sheetEl.hidden = true; return; }
  const l = e.target.closest('[data-sl]'), n = e.target.closest('[data-se]');
  if (l) { switchEp(s, +l.dataset.sl, s.ep); renderSheet(); }
  if (n) { switchEp(s, s.line, +n.dataset.se); sheetEl.hidden = true; }
});
function closeOverlays() { menuEl.hidden = true; sheetEl.hidden = true; }

// ---------- actions ----------
function syncRail() {
  const s = cur(), d = s?.d;
  const likeOn = !!s?.it && likes.has(keyOf(s.it));
  q('[data-a=like]').classList.toggle('on', likeOn);
  q('[data-a=fav]').classList.toggle('on', !!d && favs.has(d.site, d.id));
  q('[data-a=fav]').hidden = kidsMode();
  q('[data-a=eps]').hidden = !d || (s.eps.length < 2 && d.lines.length < 2);
  q('.fd-mode span').textContent = modeLabel();
  paintMute();
}
function doLike(on) {
  const s = cur(); if (!s?.it) return;
  const k = keyOf(s.it), has = likes.has(k);
  if (on === has) return;
  if (on) { likes.add(k); bump(s.it, s.d, 3); } else { likes.delete(k); bump(s.it, s.d, -3); }
  saveLikes(); syncRail();
}
function heartAt(x, y) {
  const h = document.createElement('div');
  h.className = 'fd-heart'; h.style.left = x + 'px'; h.style.top = y + 'px'; h.style.setProperty('--r', (Math.random() * 30 - 15) + 'deg');
  h.innerHTML = I.heart; root.append(h);
  setTimeout(() => h.remove(), 900);
}
function act(a) {
  const s = cur();
  if (a === 'close') { guardUntil = 0; return history.back(); }   // 主动退出: 不要被「拖动误触返回」的保护拦下
  if (a === 'mode') { if (menuEl.hidden) { renderMenu(); menuEl.hidden = false; sheetEl.hidden = true; } else menuEl.hidden = true; return; }
  if (a === 'mute') { setMuted(F.autoMuted ? false : !F.muted); if (!F.muted) tryPlay(s); return; }
  if (a === 'up') return go(-1);
  if (a === 'down') return go(1);
  if (!s?.it) return;
  if (a === 'full') {   // 「全屏观看」: 接着当前进度切到普通 (非沉浸) 播放器
    if (!s.d || !s.eps.length) return;
    const t = s.video.currentTime || 0;
    s.video.pause(); saveHist(s);
    return playAt(s.d, s.line, s.ep, t);
  }
  if (a === 'like') return doLike(!likes.has(keyOf(s.it)));
  if (a === 'fav') { if (!s.d || kidsMode()) return; const on = favs.toggle(s.d); if (on) bump(s.it, s.d, 2); toast(on ? '已收藏' : '已取消收藏'); return syncRail(); }
  if (a === 'eps') { if (!s.d) return; if (sheetEl.hidden) { renderSheet(); sheetEl.hidden = false; menuEl.hidden = true; } else sheetEl.hidden = true; return; }
  if (a === 'detail') { s.video.pause(); return openDetail(s.it.site, s.it.id); }
  if (a === 'dislike') { bump(s.it, s.d, -3); markSeen(s.it); toast('已减少这类推荐'); s.judged = true; return go(1); }
}
root.addEventListener('click', e => {
  const b = e.target.closest('[data-a]'); if (!b) return;
  e.stopPropagation(); act(b.dataset.a);
});

// ---------- gestures ----------
// iOS (13.4+) 的主屏幕应用: 手指从屏幕左 / 右边缘起手的横向滑动会被系统当作「返回 / 前进」。
// 在边缘的 touchstart 里 preventDefault 能把它拦下来 (必须 passive:false)。只在沉浸模式里、且没有弹层时拦。
root.addEventListener('touchstart', e => {
  if (root.hidden || $('#modal') || !player.hidden) return;
  const t = e.touches[0]; if (!t || e.target.closest('button, input, .fd-sheet, .fd-menu')) return;   // 按钮要保留点击
  if (t.clientX <= 24 || t.clientX >= innerWidth - 24) { if (e.cancelable) e.preventDefault(); }
}, { passive: false });
let g = null, lastTap = { t: 0, x: 0, y: 0 }, tapTimer = 0;
const H = () => root.clientHeight, W = () => root.clientWidth;
const IGNORE = 'button, .fd-prog, .fd-sheet, .fd-menu';
function showTip(text, sub) { tipEl.innerHTML = `${text}${sub ? `<small>${sub}</small>` : ''}`; tipEl.hidden = false; }
function setRate(r) { cur().video.playbackRate = r; rateEl.hidden = r === 1; }
root.addEventListener('pointerdown', e => {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (e.target.closest(IGNORE)) return;
  if (scrub) return;
  // nothing starts in the home-bar / screen-edge zones: iOS owns swipes there
  if (e.pointerType === 'touch' && e.clientY > innerHeight - 24) return;
  if (!menuEl.hidden || !sheetEl.hidden) { closeOverlays(); return; }
  if (g) return;
  const s = cur();
  g = { low: e.pointerType === 'touch' && e.clientY > root.getBoundingClientRect().bottom - 120, id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), axis: '', dx: 0, dy: 0, long: false, t0: s.video.currentTime || 0, target: 0,
    lp: setTimeout(() => { if (g && !g.axis && s.d) { g.long = true; setRate(2); } }, 450) };
  root.setPointerCapture(e.pointerId);
});
root.addEventListener('pointermove', e => {
  if (scrub || !g || e.pointerId !== g.id) return;
  g.dx = e.clientX - g.x; g.dy = e.clientY - g.y;
  if (!g.axis && Math.max(Math.abs(g.dx), Math.abs(g.dy)) > 8) {
    clearTimeout(g.lp);
    if (g.long) { g.axis = 'hold'; }
    else g.axis = g.low || Math.abs(g.dy) < Math.abs(g.dx) ? 'x' : 'y';   // 从屏幕下沿 (进度条一带) 起手的拖动只当作快进快退, 不会变成上下切换
    if (g.axis === 'y') root.classList.add('dragging');
  }
  if (g.axis === 'y') {
    let dy = g.dy;
    if ((dy > 0 && F.idx === 0) || (dy < 0 && F.idx >= F.items.length - 1)) dy *= .3;        // nothing there: rubber band
    root.style.setProperty('--dy', dy + 'px');
  } else if (g.axis === 'x') {
    const v = cur().video, dur = v.duration;
    if (!dur || !isFinite(dur)) return;
    const span = Math.min(Math.max(dur * .4, 60), 300);
    g.target = Math.max(0, Math.min(dur - .5, g.t0 + g.dx / W() * span));
    root.classList.add('scrubbing');
    root.style.setProperty('--p', g.target / dur);
    showTip(fmtT(g.target), `/ ${fmtT(dur)}`);
    liveSeek(g.target);
  }
});
function endGesture(e, cancelled) {
  if (!g || e.pointerId !== g.id) return;
  const x = g; g = null;
  clearTimeout(x.lp);
  if (x.long || x.axis === 'hold') { setRate(1); return; }
  if (x.axis === 'y') {
    const dt = Math.max(1, performance.now() - x.t), vel = x.dy / dt;
    if (!cancelled && (Math.abs(x.dy) > H() * .18 || Math.abs(vel) > .5)) return go(x.dy < 0 ? 1 : -1);
    return bounce();
  }
  if (x.axis === 'x') {
    root.classList.remove('scrubbing'); tipEl.hidden = true;
    seekWant = null;
    if (x.target) cur().video.currentTime = cancelled ? x.t0 : x.target;
    return;
  }
  if (cancelled) return;
  // a tap: second tap within 300 ms likes, a single one pauses
  const now = performance.now();
  if (now - lastTap.t < 300 && Math.hypot(x.x - lastTap.x, x.y - lastTap.y) < 60) {
    clearTimeout(tapTimer); lastTap.t = 0;
    heartAt(x.x, x.y); doLike(true);
  } else { lastTap = { t: now, x: x.x, y: x.y }; tapTimer = setTimeout(togglePause, 280); }
}
root.addEventListener('pointerup', e => { armGuard(); endGesture(e, false); });
root.addEventListener('pointercancel', e => { armGuard(); endGesture(e, true); });

// progress bar: drag to seek
// iPhone 主屏幕应用: 手指在进度条 / 屏幕上横向拖到边缘时, 系统可能把它当作「边缘返回」手势并触发 popstate。
// 拖动进行中、或刚结束 0.8 秒内收到的 popstate 一律视为误触: 补回历史记录, 留在沉浸模式。
let guardUntil = 0;
const touching = () => !!(scrub || g) || performance.now() < guardUntil;
const armGuard = () => { guardUntil = performance.now() + 800; };
let scrub = null;
// 拖动时画面跟着实时跳转: 节流 (上一次 seek 没完成就不再发), 手指抬起时再精确落到最终位置
let seekBusy = false, seekWant = null;
function liveSeek(t) {
  const v = cur()?.video; if (!v) return;
  seekWant = t;
  if (seekBusy) return;
  const go = () => { if (seekWant == null) return; seekBusy = true; const x = seekWant; seekWant = null; v.currentTime = x;
    const done = () => { v.removeEventListener('seeked', done); clearTimeout(tm); seekBusy = false; go(); };
    const tm = setTimeout(done, 400); v.addEventListener('seeked', done); };
  go();
}
const fracOf = e => { const r = prog.querySelector('.rail').getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); };
function scrubTo(e) {
  const v = cur().video; scrub.frac = fracOf(e);
  root.style.setProperty('--p', scrub.frac);
  showTip(fmtT(scrub.frac * v.duration), `/ ${fmtT(v.duration)}`);
  liveSeek(scrub.frac * v.duration);
}
prog.addEventListener('pointerdown', e => {
  const v = cur()?.video; if (!v || !v.duration || !isFinite(v.duration)) return;
  scrub = { id: e.pointerId, frac: 0, t0: v.currentTime };
  prog.setPointerCapture(e.pointerId); root.classList.add('scrubbing'); scrubTo(e); e.stopPropagation();
});
prog.addEventListener('pointermove', e => { if (scrub && e.pointerId === scrub.id) scrubTo(e); });
const scrubEnd = (e, ok) => {
  if (!scrub || e.pointerId !== scrub.id) return;
  const v = cur().video; seekWant = null; v.currentTime = ok ? scrub.frac * v.duration : scrub.t0;
  scrub = null; root.classList.remove('scrubbing'); tipEl.hidden = true;
};
prog.addEventListener('pointerup', e => { armGuard(); scrubEnd(e, true); });
prog.addEventListener('pointercancel', e => { armGuard(); scrubEnd(e, false); });

// wheel / trackpad: one title per gesture; inertia after the swipe is swallowed
let wAcc = 0, wLocked = false, wLockAt = 0, wTimer = 0;
root.addEventListener('wheel', e => {
  if (e.target.closest('.fd-sheet, .fd-menu')) return;
  e.preventDefault();
  const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? H() : 1;
  const dx = e.deltaX * k, dy = e.deltaY * k;
  clearTimeout(wTimer);
  wTimer = setTimeout(() => { if (performance.now() - wLockAt >= 400) { wLocked = false; wAcc = 0; } else wTimer = setTimeout(() => { wLocked = false; wAcc = 0; }, 400 - (performance.now() - wLockAt)); }, 130);
  if (Math.abs(dx) > Math.abs(dy)) { const v = cur().video; if (v.duration && isFinite(v.duration)) v.currentTime = Math.max(0, Math.min(v.duration, v.currentTime + dx * .08)); return; }
  if (wLocked) return;
  wAcc += dy;
  if (Math.abs(wAcc) >= 40) { wLocked = true; wLockAt = performance.now(); go(wAcc > 0 ? 1 : -1); wAcc = 0; }
}, { passive: false });

// keyboard
addEventListener('keydown', e => {
  if (root.hidden || e.target.matches?.('input, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
  if ($('#modal') || !player.hidden) return;
  const s = cur(), v = s?.video;
  const k = e.key;
  const used = () => { e.preventDefault(); e.stopImmediatePropagation(); };
  if (k === 'Escape') { if (!menuEl.hidden || !sheetEl.hidden) { used(); return closeOverlays(); } if (document.fullscreenElement) return; used(); guardUntil = 0; return history.back(); }
  if (k === 'ArrowDown' || k === 'j' || k === 'PageDown') { used(); return go(1); }
  if (k === 'ArrowUp' || k === 'k' || k === 'PageUp') { used(); return go(-1); }
  if (k === 'ArrowRight' && v?.duration) { used(); v.currentTime = Math.min(v.duration, v.currentTime + 5); return; }
  if (k === 'ArrowLeft' && v?.duration) { used(); v.currentTime = Math.max(0, v.currentTime - 5); return; }
  if (k === ' ') { used(); return togglePause(); }
  const map = { l: 'like', s: 'fav', e: 'eps', i: 'detail', d: 'dislike', m: 'mute', f: 'fs' };
  if (map[k]) { used(); return act(map[k]); }
  if ((k === ']' || k === '[') && s?.eps.length > 1) { used(); switchEp(s, s.line, s.ep + (k === ']' ? 1 : -1)); }
}, true);

// ---------- progress bar painting ----------
let raf = 0, lastP = -1, lastB = -1;
function tick() {
  if (root.hidden) return;
  raf = requestAnimationFrame(tick);
  const s = cur(), v = s?.video;
  const vod = !!v && v.duration > 0 && isFinite(v.duration);
  root.classList.toggle('live', !vod);
  if (!vod) return;
  const t = v.currentTime, d = v.duration;
  if (!scrub && !(g && g.axis === 'x')) {
    const p = t / d; if (Math.abs(p - lastP) > 1e-4) { lastP = p; root.style.setProperty('--p', p); }
  }
  let end = 0;
  for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= t + 1) end = Math.max(end, v.buffered.end(i));
  const b = end / d; if (Math.abs(b - lastB) > 1e-3) { lastB = b; root.style.setProperty('--b', b); }
}

// ---------- open / close ----------
function showHint() {
  if (localStorage.feedHint) return;
  localStorage.feedHint = '1';
  const h = q('.fd-hint');
  h.textContent = touchUi ? '上下滑动切换 · 左右滑动快进 · 双击喜欢 · 长按 2 倍速' : '滚轮 / ↑↓ 切换 · ←→ 快进 · 双击喜欢 · 空格暂停 · 拖动底部进度条';
  h.hidden = false; setTimeout(() => { h.hidden = true; }, 4500);
}
function openFeed(o = {}) {
  if (!root.hidden) return;
  if (!state.sites.length) return toast('还没有可用的点播源');
  const mode = o.mode === 'fav' && kidsMode() ? 'rec' : (o.mode || 'rec');
  history.pushState({ feed: 1 }, '');
  root.hidden = false; document.body.style.overflow = 'hidden';
  root.style.setProperty('--dy', '0px'); root.style.setProperty('--p', 0); root.style.setProperty('--b', 0);
  setMuted(F.muted, false);
  F.extra = o.mode === 'cat' || o.mode === 'search' || o.mode === 'list' ? o : null;
  startMode(mode);
  lastP = lastB = -1; cancelAnimationFrame(raf); raf = requestAnimationFrame(tick);
}
function hideFeed() {
  if (root.hidden) return;
  leave(cur());
  F.gen++;
  ring.forEach(s => { teardown(s); Object.assign(s, { i: -1, it: null, d: null }); s.el.classList.add('empty'); });
  root.hidden = true; closeOverlays(); tipEl.hidden = true; rateEl.hidden = true;
  root.classList.remove('scrubbing', 'dragging');
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  if (!$('#modal') && player.hidden) document.body.style.overflow = '';
  cancelAnimationFrame(raf);
  flushProfile();
}
const flushProfile = () => { if (P) localStorage.feedProf = JSON.stringify(P); };
addEventListener('popstate', () => {
  if (root.hidden) return;
  if (touching() && !$('#modal') && player.hidden) { history.pushState({ feed: 1 }, ''); return; }   // 拖动时误触发的系统返回
  const st = history.state || {};
  if (!st.feed && !st.modal && !st.player) return hideFeed();
  setTimeout(() => { if (!root.hidden && !covered()) tryPlay(cur()); }, 0);      // back from the detail sheet / player
});
document.addEventListener('visibilitychange', () => {
  if (root.hidden) return;
  if (document.hidden) cur().video.pause(); else tryPlay(cur());
});
addEventListener('pagehide', flushProfile);
addEventListener('resize', () => slides.forEach(layoutLand));

// entry points: any element with data-feed (category / search / 收藏 / 历史 pages)
document.addEventListener('click', e => {
  const b = e.target.closest('[data-feed]'); if (!b) return;
  e.preventDefault();
  const d = b.dataset;
  openFeed({ mode: d.feed, t: d.t || '', name: d.name || '', site: d.site || state.site, q: d.q || '', scope: d.scope || '' });
});
window.openFeed = openFeed;
})();
