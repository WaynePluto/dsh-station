---
name: dsh-theme
description: 编写或调整 dsh 插件的主题样式，处理表单焦点、边框、背景、深浅主题、卡片、菜单与原生 UI 一致性。涉及 dsh UI/CSS/主题 token 时先加载；完成后自动将本次已验证、可复用的新经验合并回本技能。不适用于业务逻辑、独立于 dsh 的 relay 页面；图标文字对齐同时加载 flex-centering。
---

# dsh 主题样式

目标：插件看起来属于当前 dsh，而不是独立设计一套皮肤。保留语义、键盘可达性和既有业务行为。

## 开始前

1. 读取本仓库根的 `AGENTS.md`、`docs/dsh/plugins.md`、目标插件 README。
   本技能目录向上三级即仓库根；以上路径相对仓库根。
2. 加载相邻的 `../dsh-source/SKILL.md`，从中获取唯一的上游源码根与版本。
   下文所有 `packages/client/...` 路径相对 **dsh 源码根**，不是本仓库。
3. 找到用户对照的**同一类控件**的 TSX、CSS 和实际 DOM，再动手；不要凭截图颜色猜 token。
   通用 `Input`、插件配置字段、卡片 header 的焦点方案并不相同。
4. 涉及图标/文字对齐时加载 `../flex-centering/SKILL.md`，不要复制其量法或随意补位移。

## 官方样式查证入口

| 目标 | 上游相对路径 |
|---|---|
| 主题 token 的定义与主题覆盖 | `packages/client/ui-theme/src/styles/design-platform.css` |
| 插件设置表单（本次修复基准） | `packages/client/ui-settings-plugins/src/client/fields.module.css`、`fields.tsx` |
| 插件卡片与 header 焦点 | `packages/client/ui-settings-plugins/src/client/PluginCard.module.css`、`PluginCard.tsx` |
| 模型设置字段与原生 select | `packages/client/ui-settings-models/src/client/ModelsSection.module.css`、`ModelsSection.tsx` |
| 通用输入框 | `packages/client/ui-primitives/src/Input.module.css`、`Input.tsx` |
| 菜单与图标 | `packages/client/ui-primitives/src/Menu.tsx`、`Menu.module.css`、`icons/index.tsx` |
| 语言下拉（选项 hover 基准） | `packages/client/locale/src/client/LanguageRow.tsx` |
| Dock 样式基准 | `packages/client/ui-conversation/src/client/skeleton/TodoPanel.module.css`、`TodoPanel.tsx` |

当前表单结论核实于 `@deepseek-ai/dsh@0.1.5-rc.2` / `fb2c4b9e69`。升级需重新读对应源码，不能把数值当永久契约。

## 实施顺序

### 1. 复用组件，不跨包偷取私有 CSS

- 已有合适的公共 primitive 就复用。`@deepseek-ai/dsh-client-ui-primitives` 保持 external，
  让实际 dsh 页面提供组件与 CSS；不要把其运行时/CSS 再打一份进插件。
- 没有公共组件时，用插件命名空间 class 或 CSS module 复现该控件的最小样式契约。
  不引用上游构建后哈希类名，不全局覆盖 `input`、`select`、`button` 或 `:focus`。
- Node 单元测试不能直接 import 带上游 CSS 的浏览器模块；静态契约测试只作防退化检查，不宣称验证了视觉。

### 2. 区分默认、焦点、展开、禁用状态

`appearance: none` **不等于**移除 UA 焦点轮廓。
没有显式焦点规则的控件可能叠一圈粗黑边，而 dsh 插件字段仅变细边框颜色。
下拉触发按钮采用字段边框，选项弹层复用官方 `Menu`；二者不能混为同一层样式。

`plugins.bundle.config` 已经渲染在 Bundle 详情页自己的配置 section 中；该槽的组件应直接输出字段、状态和操作区，不要再套一张完整卡片、重复标题或折叠 header。`plugins.item` 才是需要自行提供 summary/page 内容的官方分组入口。依据：`packages/client/ui-plugin-manager/src/client/PluginManagerPage.tsx`。

官方插件配置字段契约：

| 属性 | 值 |
|---|---|
| 内容高度 / 水平 padding | `34px` / `12px` |
| 默认边框 | `0.5px solid var(--dsw-alias-border-l4)` |
| 圆角 / 背景 | `8px` / `var(--dsw-alias-bg-layer-3)` |
| 文字 | `font: inherit`，`13px`，`line-height: 1.5`，`--dsw-alias-label-primary` |
| 焦点 | `outline: none` + `border-color: var(--dsw-alias-brand-primary)`，不改变边框宽度 |
| 禁用 | `--dsw-alias-label-tertiary`、`cursor: default`，同时使用真正的 `disabled` |

官方文本字段使用 `:focus-visible`；下拉触发按钮需同时覆盖点击展开与键盘聚焦，使用 `:focus`，
并在 `[aria-expanded='true']` 保持主题色边框（菜单项获得焦点后触发按钮已不再 focus）。
不能只关 outline 而没有可见的替代焦点反馈。卡片 header 仍保留官方的 2px 键盘焦点轮廓，
不要把表单的「无外圈」规则扩散到按钮、卡片或整页。

- **状态属性不要写死在 React inline style。** 普通 class 的 `border-color`、`color` 覆盖不了
  inline `border`、`color`；把默认值与状态规则放在同一局部 CSS 中，不用 `!important` 补救。
  本次审计在 proxy 的 input/textarea、agents-md 的 textarea 和 terminal dock 的输入框实测到 1px border-l1/透明背景
  或黑色 UA outline；这与 dsh 主题字段不一致。移除 inline 的 border/background/color，让局部 class 同时管理默认、focus、disabled。
  terminal 的输出 `<pre>`/日志框仍是有意的 code surface，不应误套输入框高度；同一个 dock 内也要按交互语义区分。
- 模型设置页是另一套已核实的字段基准，不能把插件字段的 34px 直接套过去：
  `ModelsSection.module.css` 的 `.input` 为 `border-box`、32px、0.5px border-l4、8px、
  bg-layer-1、14px/22px；`.input:focus` 用 brand-primary，`.selectInput` 右侧 12px SVG chevron。
  插件注入模型设置的 select（如 model-capabilities）先对照这一套，再决定是否使用 Menu。
- 高度要连同 `box-sizing` 检查。官方此处是 content-box；直接给 border-box 控件写 `height:34px`
  并不等高。自定义字段须用 flex 分配宽度、`min-width:0` 和 content-box，避免 padding 撑出父容器。
  `0.5px` 可能按 DPR/缩放取整，不要拿截图物理像素反推 CSS 宽度。本次 Chromium DPR=1
  的真实 dsh 页面中，两者均测得 36px 外高、1px 渲染边框；深浅主题的字体、底色、默认/焦点颜色一致。
- 右侧原生 outline 图标留足 padding；图标 `pointer-events:none`，不要截走点击。
- 保留标签关联、当前值、禁用语义；换组件时不能仅保留外观而丢失键盘可用性。

### 3. 选项 hover：先区分 OS 弹层与 dsh Menu

用户反馈「下拉 hover 太深」，先看截图指的是**触发器**还是**展开后的选项行**。
只修输入框的焦点边框不能解决后者；原生 `<select>` 弹层受浏览器/OS 控制，
`option:hover`、`appearance:none`、给 select 换背景都不能可靠地统一其高亮。

以语言菜单为基准时，直接复用 external `Menu`，不复制一套选项 DOM / CSS：

- `items` 提供内容，`selectedId` 标记当前草稿值；默认 `selection='check'` 是右侧勾号，
  非 hover 时选中行仍透明。不要用 `selection='fill'` 伪装 hover，否则选中项会一直染底色。
- 菜单项 hover 由 `Menu.module.css` 的 `.item:hover:not(:disabled)` 提供，token 为
  `--dsw-alias-interactive-bg-hover`：当前浅色 `rgba(38,49,72,0.06)`，深色 `rgba(255,255,255,0.08)`。
  值仅用于核验，不硬编码覆盖；浮层背景、阴影、圆角也沿用 Menu。不要改触发按钮色来补偿选项色。
- 设置页有滚动裁剪时用 `portal`，跟语言菜单一样让 dsh 定位浮层、限制视口并处理滚动/resize；
  `className` 只作用于 Menu 的 anchor wrapper，不会传给 portaled list。
- **Menu 不等于完整的 select 行为。** 当前源码只提供原生可聚焦 menuitem 按钮、
  点击选择、外部点击/Escape 关闭；不自动聚焦选中项、不实现方向键导航、不自动归还焦点。
  换掉原生 select 后，在字段组件局部补齐 Enter/Space 打开、箭头/Home/End、Tab、选择/取消焦点归还。
- **Portal 的首帧是 `visibility:hidden` 测量态。** 父组件在同轮 layout effect 直接 `.focus()` 会失败，
  即使 ref 已经存在；应等 Menu 完成定位提交后再聚焦，例如可清理的 `requestAnimationFrame`。
  关闭/卸载时取消待执行帧，浏览器测试也要等待实际焦点，而不是只断言菜单已经渲染。
- Portal 的 React 键盘事件仍冒泡到字段所属组件。局部消费 Escape 并 `stopPropagation()`，
  防止关闭菜单同时触发宿主 document 的设置窗口关闭；外部点击关闭不能强行抢回焦点。
  不挂全页拦截器，不移动上游 React DOM，也不根据哈希类名查找菜单项。
- 禁用时关闭弹层，trigger 与 items 都禁用，`onSelect` 再拦一次；选择仍只更新草稿，保存语义不变。

已安装 dsh 的语言菜单与插件菜单共用 `Menu`：选中未 hover 时保持透明。
后续仍需在实际页面检查键盘焦点返回、滚动定位和父设置窗口是否仍在；静态 CSS 检查不能替代这些测试。

### 4. 用 token，但也检查真实值

- `border-l1/l2/l4` 的 `l` 是字母，不是数字 `1`；不能盲目选最淡的 `l1` 给所有表单。
  实际 CSS `0.5px` 在 Chromium DPR=1 可能显示成 1px；应比较 computed token/宽高，不要把渲染取整误判成代码写了 1px。
- `--dsw-alias-brand-primary` 随主题变化；不要为了浅色截图把焦点色写死为黑色。
- 浅色 `bg-layer-1/2/3` 都是白，`bg-layer-4` 无定义；嵌套面需要边框等额外层次，不靠虚构 token。
- 抬升面用 `--dsw-specific-tip`；文字按 primary/secondary/tertiary 层级。
- 等宽字体用 `var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)`；
  `--dsw-font-mono` 可能没有定义。
- 已有 Dock 规则以仓库根 `docs/dsh/plugins.md` 为准，图标光学补偿须先量后改。

### 设置导航与正文覆盖

当前 `settings.section` 的 priority shadow 只影响正文 renderer；`ui-settings-general/src/client/index.ts`
直接用原始 `slots.entries` 投影菜单，会把原条目和 shadow 条目都显示出来。增强现有页面时不能假定
“同 id 只出现一个菜单”，测试必须连同导航登记检查；不需要页面定制时不要添加登记项。
remote-settings 仅保留宿主 ownsHost 注入，没有浏览器菜单扩展。
此导航例外核对于 0.1.6-alpha.2 产物，0.1.7-rc.1 待复测；不代表所有 list 槽的 owner 都有同样行为。

### 设置导航的插件图标

当前 dsh `settings.section` 没有 icon 字段，`ui-settings-general` 在导航 cell 内直接渲染一个 SVG。
若插件必须补充语义图标，优先把这个现有 SVG 作为 16px mask 载体，隐藏其子路径，再用
`currentColor` 填充 mask；不要只依赖 `::before` 伪元素，否则 React 重建导航行或旧 WebKit 的
flex 计算可能留下空的图标盒。图标应直接调用 dsh primitives 的对应 component，再把返回的
SVG element 序列化为 mask；项目实例是 `packages/plugin-ui/src/navigation-glyph.ts`，上游依据为
`packages/client/ui-settings-general/src/client/SettingsRoot.tsx`。
0.1.7-rc.1 的 Medium 图标先返回以纯函数 Artwork 为 `type` 的 React element，再由 Artwork 返回 `<svg>`：
序列化时只对受控图标有界展开函数包装，不能直接把第一层当 SVG；递归包装须拒绝，避免页面插件激活失败。
依据为已安装 `@deepseek-ai/dsh-client-ui-primitives/lib/index.js` 与本仓库 `browser-compat/tests/plugin.spec.ts`；
Chrome 实测四个相关插件恢复激活，图标深浅主题的视觉效果仍需单独验收。

### Native Sidebar tab 标题包装层的对齐

原生 dock 的 `TabTitle` 本身已经是 `display:flex; align-items:center; gap:5px`，但插件若在 title slot 外包一层
用于斜体、双击或其它状态，新增的 wrapper 会变成外层 flex 的单个 item；不能继续让 SVG 和文本在普通 inline 行盒中按 baseline 对齐。
正确规则是 wrapper 自己 `display:inline-flex; align-items:center; gap:5px; min-width:0; max-width:100%; overflow:hidden;
line-height:1.4; white-space:nowrap`，SVG `display:block; flex:none`。这样既保持原生图标/标题间距，也不让 wrapper 的 inline baseline
把图标顶高或把标题压低。当前 files 实例是 `packages/plugins/files/src/client/styles.ts` 的
`.dsh-files-preview-tab-title`；真实 dsh Chromium 页面测得 wrapper 18.2px，16px 图标 y=16..32，标题墨迹行盒
14.9..32.5，中心差约 0.3px，无需额外 `translateY`。若换字体/字号或出现新的 CJK 残差，仍按 flex-centering 的截图量法复核，
不要直接加 margin/top。

### Sidebar tab body 的高度

右侧 Sidebar 的 tab body 不能默认当作普通 flex 子项：上游 `ui-dockkit/src/components/TabPanel.tsx` 的 `paneBody` 子节点通过 `display: contents` wrapper 放入，`ui-dockkit/src/components/dockkit.module.css` 的 `.paneBody` 自身是带 `overflow:auto` 的 flex item，但不是 flex 容器。现象是 body 根节点若写 `height:0; flex:1`，实际页面中会得到零高度，内容只能溢出到不可滚动的区域。

正确规则：Sidebar 自有 body 的根节点给 `height:100%`、`min-height:0`，内部再用自己的 flex/grid 和滚动面；如果需要 `height:0` 的 flex 填充模型，先包一层明确的 `display:flex; flex-direction:column` 容器。用真实页面的 `getBoundingClientRect()` 同时核对根节点和主内容区高度，不要只看文字是否出现。本仓库 `packages/plugins/files/src/client/styles.ts` 的 `.dsh-files-root` 是实例；本次用临时 dsh 页面验证根节点与树/预览区域均填满 Sidebar。

### 可滚动预览中的固定表头

需要让预览路径/操作栏在内容滚动时留在顶部时，`position: sticky; top: 0` 必须写在实际滚动容器的后代上，并配不透明的 `var(--dsw-alias-bg-base)` 背景和足够的 `z-index`，否则正文会穿过表头。滚动容器在表头上方不要保留 padding：sticky 会停在 padding edge，正文仍可能从表头上方露出；把上方留白移到 sticky 表头自身的 `padding-top`。不要改成 `position: fixed`，那会脱离 Sidebar pane 的滚动坐标和宽度。实例是 `packages/plugins/files/src/client/styles.ts` 的 `.dsh-files-preview` / `.dsh-files-preview-head`；真实 dsh 页面滚动预览区 500px 后，表头 `getBoundingClientRect().top` 与滚动容器顶部一致。

### 桌面标题栏占位与页面外留白

先区分卡片外部留白与标题内部 padding。0.1.7-rc.2 原生设置采用 fixed 居中 overlay，面板高度
`min(800px, calc(100vh - 2 * max(24px, var(--dsh-frame-top-clearance,24px))))`；
依据是 `packages/client/ui-settings-general/src/client/SettingsRoot.module.css`，已按当前发布包复核，本地旧 checkout 可能没有 clearance 变量。
独立 relay 管理文档仍需顶部对齐，不能照搬整套居中 modal；壳注入36px标题栏时也不能直接覆盖页面24px padding。
项目实例用 `--dsh-station-page-top-gap`（窄屏12px）与标题栏占位 calc 相加，未定义变量的dsh回退0；
不要一次读取 computed padding 后写死，否则响应式切换会丢失。保留border-box，防止height:100%链底部裁切。
真实Chrome + relay页面/实际标题栏脚本验证：宽屏卡片top60、条底36，窄屏top48、条底36；
普通浏览器仍为24/12px，深浅主题不变、无横向溢出。不代表所有原生弹窗都共享设置面板的高度公式。

### 桌面标题栏的主题跟随

主题偏好和解析后的配色不是同一状态：`system` 不应被保存成当时的light/dark。
原生dsh使用根节点 `data-ds-theme-source` 与body的 `data-ds-dark-theme`；relay管理页使用根节点 `data-theme`。
标题栏取body计算背景色时，须分别观察根节点/body自身的主题属性，并订阅 `matchMedia` 与 `visibilitychange`；
不能只看根节点class/style，也不应观察整个子树，否则标题栏自身写样式会触发回环。
Chrome后台页可能已匹配新的系统CSS，却延迟派发媒体事件；重新可见时需重算。隔离真dsh→relay页面验证了
原生dark/light/system事件更新、标题栏明暗与草稿不变；背景页媒体事件延迟、激活后派发也已观察。
实例：`packages/desktop/chromebar.go`。宿主主题持久化与只读投影契约见 `docs/dsh/plugins.md`，不要用DOM乐观变化认定设置已保存。

### Modal 弹窗内自绘头部按钮

dsh Modal（`packages/client/ui-primitives/src/Modal.tsx`）没有自定义 header 插槽；插件传的
`className` 落在 `.dialog` 卡片上（`position:relative; overflow:hidden`）。要在关闭按钮旁加按钮，
只能作为 Modal children 绝对定位：close 按钮是 28×28、右距 14、header padding-top 22
（`Modal.module.css` 的 `.header`/`.close`），紧贴其左侧即 `top:22px; right:50px`（14+28+8）。
按钮样式复刻 `.close`：transparent 背景、`--dsw-alias-label-secondary` 图标色、hover 用
`--dsw-alias-interactive-bg-hover`（浅色实测 rgba(38,49,72,0.06)、深色 rgba(255,255,255,0.08)），不写死颜色、保留 UA 焦点轮廓；
base 与 :hover 放同一局部 stylesheet 规则，不用 inline style。若卡片上还有自绘移动热区
（z-index 2）与 resize 手柄（3），按钮要取更高层才能先收到点击（公共实现用 4）。dsh 图标集只有
`IconFullscreenOutline16`（展开方向），无收缩图标，两种状态共用图标、切换 aria-label 即可。
**第二次复用时就该提取**：services 与 turn-retry 的弹窗结构相同，全屏能力现由
`packages/plugin-ui/src/dialog-fullscreen.ts` 提供（`useDialogFullscreen` 负责保存/写回几何、
窗口 resize 跟随、按 `open`/`identity` 复位；`dialogFullscreenButtonRule` 生成样式；`DialogFullscreenButton`
接收调用方传入的图标，本包不依赖 dsh primitives）。插件只保留自己的 dialog class、data 属性名与 class 前缀。
真实页面实测两个弹窗按钮均与关闭按钮逐像素同高（28×28）、全屏 1872×815 对应 viewport−48、
退出后精确恢复原尺寸与位移，深浅主题下图标色跟随 `--dsw-alias-label-secondary`。

### Dock 列表行的单行省略

dock 列表行要保证任何内容长度下都单行：行容器去掉 `flexWrap`，可变长文本格给
`min-width:0` + `overflow:hidden; text-overflow:ellipsis; white-space:nowrap`；行尾按钮组必须
包一层 `flex:none` 容器——dsh `Button`（`Button.module.css`）没有 `flex-shrink:0`，直接平铺
会被长文本压缩导致按钮文字换行。悬停全文用 `title` 补充。实例：
`packages/plugins/services/src/client/ServiceRow.tsx`、`styles.ts` 的 `rowActionsStyle`；
真实页面实测长命令行 28px 单行、facts scrollWidth 1045 > clientWidth 641 出省略号。

## 验证闭环

1. 运行目标插件 test/typecheck/build 和仓库 lint；读实际 diff，确认没有改业务写入逻辑。
2. **构建后重启对应 dsh，再刷新页面。** dsh-station-web 没有 HMR，浏览器硬刷新也不会让
   宿主重读不可变客户端 bundle。先查服务管理器；用户管理的运行实例不要擅自停掉。
   可启动独立 loopback 验证实例，结束时清理，并明确提醒用户重启日常实例。
3. 在真实 dsh 页面并排比较内置控件与插件，不用孤立 HTML 预览代替宿主环境。
   用浏览器技能读 DOM、定位元素，再用 `getComputedStyle`/`getBoundingClientRect` 取值：

   ```javascript
   const css = getComputedStyle(element);
   const rect = element.getBoundingClientRect();
   ({
     height: rect.height, width: rect.width, boxSizing: css.boxSizing,
     border: css.border, outline: css.outline, boxShadow: css.boxShadow,
     background: css.backgroundColor, color: css.color,
     font: css.font, padding: css.padding, radius: css.borderRadius,
     brand: css.getPropertyValue('--dsw-alias-brand-primary').trim(),
     focused: element.matches(':focus'), focusVisible: element.matches(':focus-visible')
   });
   ```

4. 深色和浅色分别验证：默认 → 鼠标聚焦/展开 → 失焦、Tab 键盘聚焦 → 方向键/Enter/Escape、
   禁用/只读；看激活前后有无尺寸抖动、额外 outline/shadow、文字或箭头遮挡。
5. 检查窄屏无横向溢出，且剩余文字区仍可读；宿主导航挤占宽度时，仅控件不溢出不能算移动端通过。
   主题切换后颜色仍有层次；必要时截同一缩放、DPR 的真实页面图。
   不要把模拟禁用 DOM 的样式测试称为宿主只读权限验收，也不要为视觉测试写入用户设置。
6. 回答中区分构建/静态测试、真实浏览器自动检查、用户实机验收；未完成项如实列出。

## 自动吸收新经验（每次样式任务收尾执行）

这是编码助手的任务流程，不是后台监听器；以后命中本技能的任务，无需用户再次提醒即执行：

1. 判断本次是否出现**新且可复用**的主题、组件、CSS 级联、对齐或验证结论。
2. 只有读过源码或真实页面验证的结论才写入。记录「现象/原因 → 正确规则 → 上游相对路径或
   本仓库实例 → 验证方式与适用边界」，不能把猜测写成铁律。
3. 直接编辑本 `SKILL.md` 的对应章节，合并重复规则；修正过时结论，不追加流水账或失败尝试历史。
   对齐专属知识回写 `../flex-centering/SKILL.md`，这里保留入口，避免两份规则互相矛盾。
4. 若发现新的上游契约，同时更新仓库根 `docs/dsh/plugins.md` 对应主题；不把本地 dsh 绝对路径、
   token、cookie 或私密截图数据写进技能。产品边界/架构变化仍先与用户确认。
5. 无新增就不制造文档改动；有新增则在最终回复简述吸收了什么。确需拆分时在本文件明确链接，
   保持现行规则精简可加载。
