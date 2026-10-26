// 更新：检查是否有新版本 / 应用更新。网页管理员页面 (server.js) 和 manage.js 共用。
//   git 仓库       检查 = git fetch 后比较 HEAD 和上游；更新 = git pull --ff-only
//   非 git (zip)   检查 = GitHub API 取默认分支最新提交；更新 = 下载该提交的 zip → 解压 → 校验 → 带回滚地替换程序文件
// 下载加速 (国内 codeload.github.com 很慢): 默认先走国内 GitHub 加速镜像 (按顺序，一条不行换下一条)，最后才直连 GitHub；带进度 (已下载 / 总大小 / 速度 / 来源)。
//   镜像是第三方，所以走镜像下载的内容必须通过校验才会用：向 GitHub API 取这个提交的完整文件树 (每个文件的 git blob SHA-1)，
//   逐个文件比对，多一个 / 少一个 / 改一个字节都不行；校验不过或镜像失败就换下一条，最后直连 (直连走 GitHub 自己的 HTTPS，不校验)。
//   镜像列表: 环境变量 TVBOX_MIRRORS=前缀1,前缀2 (例 https://ghfast.top/)，设成空字符串 = 不用镜像。
// 保留不动：data/ (数据)、.env (令牌)、.tools/ (便携 Node / ffmpeg)、node_modules/。
// 临时文件只放在 data/.update-tmp/ ，每次更新结束 (成功或失败) 都清掉，服务启动时也会清一次。
// 检查成功的结果缓存在 data/.update-check.json (6 小时)；失败不缓存。
'use strict';
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const WIN = process.platform === 'win32';
const DATA = process.env.TVBOX_DATA || path.join(ROOT, 'data');
const TMP = path.join(DATA, '.update-tmp');
const VER_FILE = path.join(DATA, '.version.json');
const CHECK_FILE = path.join(DATA, '.update-check.json');
const MANAGE_FILE = path.join(DATA, '.manage.json');
const DEFAULT_REPO = 'imcuttle/cleanyourtv';   // 非 git 的拷贝默认从这个仓库更新；TVBOX_REPO=owner/repo 可改
const KEEP = new Set(['data', '.env', '.tools', 'node_modules']);
const CACHE_MS = 6 * 3600e3;      // 检查结果缓存多久
const MIN_GAP = 20e3;             // 手动检查的最小间隔 (防连点)
const UA = 'tvbox-updater';
const DEFAULT_MIRRORS = ['https://ghfast.top/', 'https://gh-proxy.com/'];
const mirrors = () => process.env.TVBOX_MIRRORS === undefined ? DEFAULT_MIRRORS : process.env.TVBOX_MIRRORS.split(',').map(x => x.trim()).filter(x => /^https:\/\/.+\/$/.test(x));
const STALL_MS = 20e3;        // 这么久没收到任何数据就当这条线路挂了
const FIRST_BYTE_MS = 15e3;   // 这么久还没出第一个数据就放弃这条线路

const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const writeJson = (f, v) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v)); } catch {} };
const CANCELLED = '已取消';
const checkAbort = signal => { if (signal?.aborted) throw new Error(CANCELLED); };
const short = s => String(s || '').slice(0, 7);

function sh(cmd, args, { cwd = ROOT, timeout = 60e3, signal } = {}) {
  return new Promise(ok => {
    let out = '', err = '', done = false;
    const fin = r => { if (!done) { done = true; clearTimeout(t); ok(r); } };
    let p;
    try { p = spawn(cmd, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } }); }
    catch (e) { return ok({ status: -1, stdout: '', stderr: e.message }); }
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} fin({ status: -2, stdout: out, stderr: err + '\n超时' }); }, timeout);
    if (signal) { const ab = () => { try { p.kill('SIGKILL'); } catch {} fin({ status: -3, stdout: out, stderr: err + '\n已取消' }); }; if (signal.aborted) ab(); else signal.addEventListener('abort', ab, { once: true }); }
    p.stdout.on('data', d => { if (out.length < 1e6) out += d; });
    p.stderr.on('data', d => { if (err.length < 1e6) err += d; });
    p.on('error', e => fin({ status: -1, stdout: out, stderr: e.message }));
    p.on('close', code => fin({ status: code, stdout: out, stderr: err }));
  });
}
const lastLines = (s, n = 3) => String(s || '').trim().split(/\r?\n/).slice(-n).join(' ');

function repoSlug() {
  const raw = String(process.env.TVBOX_REPO || (readJson(MANAGE_FILE) || {}).repo || (readJson(VER_FILE) || {}).repo || DEFAULT_REPO).trim();
  const m = /(?:github\.com[/:])?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(raw);
  if (!m) throw new Error('仓库地址看不懂: ' + raw + ' (写成 owner/repo)');
  return `${m[1]}/${m[2]}`;
}

// ---------- 当前版本 ----------
async function gitInfo() {
  const top = await sh('git', ['rev-parse', '--show-toplevel']);
  if (top.status !== 0) return null;
  const cwd = top.stdout.trim();
  const g = async a => (await sh('git', a, { cwd })).stdout.trim();
  const up = await sh('git', ['rev-parse', '--abbrev-ref', '@{u}'], { cwd });
  return { top: cwd, sha: await g(['rev-parse', 'HEAD']), branch: await g(['rev-parse', '--abbrev-ref', 'HEAD']),
    subject: await g(['log', '-1', '--format=%s']), upstream: up.status === 0 ? up.stdout.trim() : '',
    dirty: !!(await g(['status', '--porcelain', '--untracked-files=no'])) };
}
async function current() {
  const g = await gitInfo();
  if (g) return { mode: 'git', sha: g.sha, short: short(g.sha), branch: g.branch, subject: g.subject, dirty: g.dirty, upstream: g.upstream };
  const v = readJson(VER_FILE) || {};
  let repo = ''; try { repo = repoSlug(); } catch {}
  return { mode: 'zip', sha: v.sha || '', short: short(v.sha), at: v.at || 0, repo };
}

// ---------- 检查 ----------
async function ghLatest(slug) {
  const h = { 'User-Agent': UA, Accept: 'application/vnd.github+json' };
  const tk = process.env.GITHUB_TOKEN || process.env.GH_TOKEN; if (tk) h.Authorization = 'Bearer ' + tk;
  const r = await fetch(`https://api.github.com/repos/${slug}/commits/HEAD`, { headers: h, signal: AbortSignal.timeout(15e3) });
  if (r.status === 403 || r.status === 429) throw new Error('GitHub 接口限流了，稍后再试 (设置 GITHUB_TOKEN 可放宽)');
  if (!r.ok) throw new Error(`GitHub 返回 HTTP ${r.status} (${slug})`);
  const j = await r.json();
  return { sha: j.sha, subject: String(j.commit?.message || '').split('\n')[0], date: j.commit?.committer?.date || '' };
}
async function checkRemote() {
  const cur = await current();
  if (cur.mode === 'git') {
    const g = await gitInfo();
    const remote = g.upstream ? g.upstream.split('/')[0] : 'origin';
    const f = await sh('git', ['fetch', '--quiet', remote], { cwd: g.top, timeout: 90e3 });
    if (f.status !== 0) throw new Error('git fetch 失败: ' + (lastLines(f.stderr) || '未知错误'));
    const target = g.upstream || `${remote}/${g.branch}`;
    const v = await sh('git', ['rev-parse', '--verify', '--quiet', target], { cwd: g.top });
    if (v.status !== 0) throw new Error(`远端没有分支 ${target}，无法比较`);
    const num = async a => Number((await sh('git', a, { cwd: g.top })).stdout.trim()) || 0;
    const behind = await num(['rev-list', '--count', `HEAD..${target}`]);
    const ahead = await num(['rev-list', '--count', `${target}..HEAD`]);
    const log = (await sh('git', ['log', '--format=%h\t%s', '-n', '8', `HEAD..${target}`], { cwd: g.top })).stdout.trim();
    return { mode: 'git', current: cur.short, latest: short(v.stdout.trim()), available: behind > 0, behind, ahead, dirty: g.dirty, target,
      commits: log ? log.split('\n').map(l => { const [h, ...s] = l.split('\t'); return { id: h, subject: s.join('\t') }; }) : [] };
  }
  const slug = repoSlug(), l = await ghLatest(slug);
  const unknown = !cur.sha;
  return { mode: 'zip', repo: slug, current: cur.short, latest: short(l.sha), latestSha: l.sha, available: unknown || l.sha !== cur.sha, unknown,
    commits: [{ id: short(l.sha), subject: l.subject, date: l.date }] };
}
let inflight = null;
// -> { ...result, at, cached }. 成功才写缓存；当前版本变了 (刚更新过) 缓存自动作废。
async function check({ force = false } = {}) {
  const cur = await current();
  const c = readJson(CHECK_FILE);
  const same = c && c.result && c.curSha === cur.sha && c.mode === cur.mode;
  if (same && (!force ? Date.now() - c.at < CACHE_MS : Date.now() - c.at < MIN_GAP)) return { ...c.result, at: c.at, cached: true };
  if (!inflight) inflight = checkRemote().finally(() => { inflight = null; });
  const result = await inflight;
  const at = Date.now();
  writeJson(CHECK_FILE, { at, mode: cur.mode, curSha: cur.sha, result });
  return { ...result, at, cached: false };
}
const cachedCheck = () => {
  const c = readJson(CHECK_FILE);
  return c && c.result ? { ...c.result, at: c.at, cached: true } : null;
};

// ---------- 应用 ----------
const rmrf = p => fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
function cleanup() { try { rmrf(TMP); } catch {} }
function move(a, b) {
  try { fs.renameSync(a, b); }
  catch (e) { if (e.code !== 'EXDEV') throw e; fs.cpSync(a, b, { recursive: true }); rmrf(a); }
}

async function gitApply(g, log, signal) {
  log('git pull …');
  const pull = args => sh('git', args, { cwd: g.top, timeout: 180e3, signal });
  let r = await pull(['pull', '--ff-only']);
  if (r.status !== 0 && /no tracking information|has no upstream/i.test(r.stderr)) r = await pull(['pull', '--ff-only', 'origin', g.branch]);
  if (r.status === -3) throw new Error(CANCELLED);
  if (r.stdout.trim()) log(r.stdout.trim());
  if (r.status !== 0) throw new Error('git pull 失败: ' + (lastLines(r.stderr) || lastLines(r.stdout) || '未知错误') + '（本地改动冲突时先处理: git status）');
  const after = (await sh('git', ['rev-parse', 'HEAD'], { cwd: g.top })).stdout.trim();
  log(g.sha === after ? '已经是最新' : `已更新 ${short(g.sha)} → ${short(after)}`);
  return { from: short(g.sha), to: short(after), changed: g.sha !== after };
}

async function extractZip(zip, dir) {
  let r = await sh('tar', ['-xf', zip, '-C', dir], { timeout: 120e3 });     // bsdtar: macOS / Windows 10+ 自带
  if (r.status === 0) return;
  r = WIN ? await sh('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dir}' -Force`], { timeout: 180e3 })
    : await sh('unzip', ['-q', '-o', zip, '-d', dir], { timeout: 120e3 });
  if (r.status !== 0) throw new Error('解压失败: ' + lastLines(r.stderr));
}
function findWebDir(dir, depth) {
  if (fs.existsSync(path.join(dir, 'server.js')) && fs.existsSync(path.join(dir, 'public'))) return dir;
  if (depth <= 0) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) { const f = findWebDir(path.join(dir, e.name), depth - 1); if (f) return f; }
  return null;
}
// ---------- 下载: 单线路 + 进度 (调用方按顺序逐条尝试；传多条才会竞速) ----------
// 候选线路同时发起请求，第一个收到数据的赢，其余中断。onProgress({ done, total, speed, via })，total 可能为 0 (服务器没给大小)。
async function raceDownload(cands, dest, onProgress, signal) {
  checkAbort(signal);
  const ctrls = cands.map(() => new AbortController());
  const abortAll = () => ctrls.forEach(c => c.abort());
  signal?.addEventListener('abort', abortAll, { once: true });
  try { return await raceInner(cands, dest, onProgress, signal, ctrls); }
  catch (e) { if (signal?.aborted) throw new Error(CANCELLED); throw e; }
  finally { signal?.removeEventListener('abort', abortAll); }
}
async function raceInner(cands, dest, onProgress, signal, ctrls) {
  const tries = cands.map(async (c, i) => {
    const t = setTimeout(() => ctrls[i].abort(), FIRST_BYTE_MS);
    try {
      const r = await fetch(c.url, { redirect: 'follow', headers: { 'User-Agent': UA }, signal: ctrls[i].signal });
      if (!r.ok || !r.body) throw new Error('HTTP ' + r.status);
      const reader = r.body.getReader();
      const first = await reader.read();
      if (first.done || !first.value?.length) throw new Error('空响应');
      return { i, c, r, reader, first: first.value };
    } finally { clearTimeout(t); }
  });
  let win;
  try { win = await Promise.any(tries); }
  catch (e) { throw new Error('所有下载线路都失败了: ' + (e.errors || []).map(x => x.message).join(' / ')); }
  cands.forEach((_, i) => { if (i !== win.i) ctrls[i].abort(); });
  const exact = Number(win.r.headers.get('content-length')) || 0;
  const total = exact || Number((readJson(VER_FILE) || {}).size) || 0;   // codeload 不给大小：用上次下载的大小估个进度 (approx)
  const t0 = Date.now(); let done = 0, lastP = 0;
  const fh = await fs.promises.open(dest, 'w');
  const emit = force => {
    const now = Date.now();
    if (!force && now - lastP < 300) return;
    lastP = now;
    onProgress?.({ approx: !exact, done, total: total && !exact ? Math.max(total, done + 1) : total, speed: done / Math.max(0.3, (now - t0) / 1000), via: win.c.name });
  };
  try {
    let chunk = win.first;
    for (;;) {
      await fh.write(chunk); done += chunk.length; emit(false);
      const stall = setTimeout(() => ctrls[win.i].abort(), STALL_MS);
      let rd;
      try { rd = await win.reader.read(); } catch { throw new Error(`下载中断（${STALL_MS / 1000} 秒没有数据，已下载 ${(done / 1048576).toFixed(1)} MB）`); } finally { clearTimeout(stall); }
      if (rd.done) break;
      chunk = rd.value;
    }
  } finally { await fh.close(); }
  if (exact && done !== exact) throw new Error(`下载不完整（${done} / ${total} 字节）`);
  emit(true);
  return { via: win.c.name, mirror: !!win.c.mirror, size: done };
}

// ---------- 校验: 对着 GitHub 给的文件树逐个比对 git blob SHA-1 ----------
async function ghTree(slug, sha) {
  const h = { 'User-Agent': UA, Accept: 'application/vnd.github+json' };
  const tk = process.env.GITHUB_TOKEN || process.env.GH_TOKEN; if (tk) h.Authorization = 'Bearer ' + tk;
  const r = await fetch(`https://api.github.com/repos/${slug}/git/trees/${sha}?recursive=1`, { headers: h, signal: AbortSignal.timeout(30e3) });
  if (!r.ok) throw new Error('文件树 HTTP ' + r.status);
  const j = await r.json();
  if (j.truncated) throw new Error('文件树太大被截断');
  return new Map((j.tree || []).filter(x => x.type === 'blob').map(x => [x.path, x.sha]));
}
const sha1blob = buf => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
// git archive 会按 .gitattributes 把 text 文件转成 eol=crlf (如 .bat)，blob 里存的是 LF：原样和 CRLF→LF 两种都认。
function blobMatches(file, want) {
  const buf = fs.readFileSync(file);
  if (sha1blob(buf) === want) return true;
  if (buf.includes(13)) { const lf = Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1'); return sha1blob(lf) === want; }
  return false;
}
function verifyAgainstTree(tree, topDir, src) {
  const prefix = path.relative(topDir, src).split(path.sep).filter(Boolean).join('/');
  const pre = prefix ? prefix + '/' : '';
  const seen = new Set();
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { walk(path.join(dir, e.name), r); continue; }
      const want = tree.get(pre + r);
      if (!want) throw new Error('压缩包里有仓库没有的文件: ' + r);
      if (!blobMatches(path.join(dir, e.name), want)) throw new Error('文件内容和仓库不一致: ' + r);
      seen.add(pre + r);
    }
  };
  walk(src, '');
  for (const k of tree.keys()) if (k.startsWith(pre) && !seen.has(k)) throw new Error('压缩包缺少文件: ' + k.slice(pre.length));
}

async function zipApply(log, onProgress, signal) {
  const slug = repoSlug();
  let sha = '';
  checkAbort(signal);
  try { sha = (await ghLatest(slug)).sha; } catch (e) { log('取不到最新提交号，只能直连下载默认分支 (' + e.message + ')'); }
  const from = short((readJson(VER_FILE) || {}).sha);
  const direct = { name: '直连 GitHub', url: `https://codeload.github.com/${slug}/zip/${sha || 'HEAD'}`, mirror: false };
  const mir = sha ? mirrors().map(m => ({ name: m.replace(/^https:\/\//, '').replace(/\/$/, ''), url: m + direct.url, mirror: true })) : [];
  const treeP = mir.length ? ghTree(slug, sha).catch(e => { log('取不到文件树，不使用镜像 (' + e.message + ')'); return null; }) : Promise.resolve(null);
  cleanup();
  const work = path.join(TMP, String(Date.now()));
  fs.mkdirSync(work, { recursive: true });
  try {
    const zip = path.join(work, 'src.zip');
    const out = path.join(work, 'x');
    const unpack = async () => {
      fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out);
      await extractZip(zip, out);
      const src = findWebDir(out, 4);
      if (!src) throw new Error('压缩包里没找到 web 程序目录 (server.js + public)');
      const tops = fs.readdirSync(out);
      const top = tops.length === 1 && fs.statSync(path.join(out, tops[0])).isDirectory() ? path.join(out, tops[0]) : out;
      return { src, top };
    };
    const tree = await treeP;
    // 默认走国内加速镜像 (按列表顺序，一条失败再换下一条)，直连 GitHub 只做最后兜底；不竞速。
    // 镜像是第三方：内容必须通过文件树校验才会用，校验不过同样换下一条。
    const cands = tree ? [...mir, direct] : [direct];
    log(`下载 ${slug} ${sha ? short(sha) : '默认分支最新代码'}（${cands.length > 1 ? `优先国内镜像，失败再换，最后直连 GitHub` : '直连 GitHub'}）…`);
    let got = null, found = null;
    const errs = [];
    for (const c of cands) {
      checkAbort(signal);
      try {
        log(`线路 ${c.name} …`);
        got = await raceDownload([c], zip, onProgress, signal);
        log(`已下载 ${(got.size / 1048576).toFixed(1)} MB，解压 …`);
        found = await unpack();
        if (c.mirror) {
          checkAbort(signal);
          log('校验文件 (对照 GitHub 文件树) …');
          verifyAgainstTree(tree, found.top, found.src);
          log('校验通过');
        }
        break;
      } catch (e) {
        if (signal?.aborted || e.message === CANCELLED) throw e;
        errs.push(`${c.name}：${e.message}`);
        got = found = null;
        if (c !== cands[cands.length - 1]) log(`${c.name} 不可用 (${e.message})，换下一条 …`);
      }
    }
    if (!found) throw new Error('所有下载线路都失败了: ' + errs.join(' / '));
    const { src } = found;
    checkAbort(signal);
    const chk = await sh(process.execPath, ['--check', path.join(src, 'server.js')]);
    if (chk.status !== 0) throw new Error('新版 server.js 没通过语法检查，已放弃更新: ' + lastLines(chk.stderr));
    checkAbort(signal);                              // 这是最后一个可以取消的点：开始替换文件后不再响应取消，免得停在半新半旧
    log('替换程序文件 (data / .env / .tools 保留) …');
    const backup = path.join(work, 'old');
    fs.mkdirSync(backup);
    const oldNames = fs.readdirSync(ROOT).filter(n => !KEEP.has(n) && !n.startsWith('.'));
    const newNames = fs.readdirSync(src).filter(n => !KEEP.has(n) && !n.startsWith('.'));
    const moved = [], placed = [];
    try {
      for (const n of oldNames) { move(path.join(ROOT, n), path.join(backup, n)); moved.push(n); }
      for (const n of newNames) { move(path.join(src, n), path.join(ROOT, n)); placed.push(n); }
    } catch (e) {                                   // 中途失败: 撤回新文件, 放回旧文件
      for (const n of placed) { try { rmrf(path.join(ROOT, n)); } catch {} }
      for (const n of moved) { try { move(path.join(backup, n), path.join(ROOT, n)); } catch {} }
      throw new Error('替换文件失败，已恢复旧版本: ' + e.message);
    }
    if (!WIN) for (const f of fs.readdirSync(ROOT)) if (f.endsWith('.command')) { try { fs.chmodSync(path.join(ROOT, f), 0o755); } catch {} }
    writeJson(VER_FILE, { sha, repo: slug, at: Date.now(), size: got.size });
    log('代码已替换为最新版本');
    return { from, to: short(sha), changed: true };
  } finally { cleanup(); }
}

// -> { from, to, changed }
async function apply(log = () => {}, onProgress, signal) {
  const g = await gitInfo();
  const r = g ? await gitApply(g, log, signal) : await zipApply(log, onProgress, signal);
  try { fs.rmSync(CHECK_FILE, { force: true }); } catch {}
  return r;
}

module.exports = { _t: { raceDownload, ghTree, verifyAgainstTree, extractZip, findWebDir }, CANCELLED, current, check, cachedCheck, apply, cleanup, repoSlug, TMP };
