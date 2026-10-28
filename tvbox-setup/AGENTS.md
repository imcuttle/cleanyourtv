# AGENTS.md

## iOS PWA（主屏幕模式）底部 tab 栏与空隙

小屏 web（`web/public/`）里，底部 tab 栏要贴到屏幕最底。在 iOS 主屏幕 PWA 里这件事踩过很多坑，改相关代码前先看这里。

### 现象与根因
- 某些环境（模拟器、旧安装、旋转全屏后）PWA 的 web view 比屏幕矮：`innerHeight` 873，`screen.height` 932，差 59pt（等于顶部安全区）。`position: fixed` 被裁在 873pt 内，tab 栏下面多出一条黑底。
- `100lvh` 仍是 932，所以 `html, body { height: 100lvh }`（`style.css` 的 `@media (display-mode: standalone)`）下的 `absolute` 元素能画到屏幕最底。
- 视口高度不稳定：重载后会变回偏矮；`vshort` 一开，`innerHeight` 本身还会在 873 / 932 之间来回跳。

### 当前方案
- `app.js` 里的 `fit()`（搜 `vlatch`）：
  - 算 `--sab`：视口已让出安全区时归零。
  - 检测到「主屏幕 + 竖屏 + 视口比屏幕矮 20pt 以上」就给 `<html>` 加 `vshort`，并**锁存**，只有 `innerWidth` 变了（旋转）才重判。
  - 在加载后 50ms / 250ms / 800ms / 2s / 4s，以及 `load`、`pageshow`、`focus`、`visibilitychange`、`visualViewport.resize` 时都重算。
- `style.css` 里的 `html.vshort`：
  - `header`、`nav` 改 `position: absolute`。
  - `nav` 用 `top: calc(100lvh - var(--tab) - var(--sab))`。
  - `html` 和 `body` 设 `overflow: hidden`，不让文档被拖动。

### 不要再走的弯路
- 不要用 `bottom: -差值` 把 `fixed` 的 tab 栏往下挪：它会被裁掉，只是把黑底挪个位置。
- 不要按当前 `innerHeight` 实时开关 `vshort`：会形成反馈循环，tab 栏一闪一闪（黑块忽有忽无）。必须锁存。
- `fit()` 不能只跑一次：重载时视口和安全区还没稳定。
- 这类问题别凭猜改：在页面里临时加调试条（显示 `innerHeight`、`screen.height`、`100lvh`、`visualViewport`、nav 的位置，并记录变化历史），在模拟器里截图读数据再改，修完删掉。

### 发布 / 缓存
- 改了 `style.css` 或 `app.js`，要同时升 `index.html` 里的 `?v=` 和 `sw.js` 的 `CACHE` 名，否则 PWA 拿到旧文件，看起来「没生效」。
- 验证 PWA 时，先上滑杀掉再重新打开；还不对就删掉主屏幕图标，用 Safari 重新添加。
