# 插件机制与界面

基线见 [源码依据](../02-dsh-facts.md)。产品装载规则见 [决策](../01-decisions.md)。
以下路径相对 dsh 仓库根，明确标注项目实现的除外。

## Bundle、Overlay 与第三方安装

出处：`apps/cli/src/profile-boot.ts`、`packages/boot/app-boot/src/index.ts`、`src/profile.ts`、
`apps/cli/src/plugin.ts`、`packages/boot/plugin-manager/src/index.ts`。

应用顺序为 Bundle → profile patch → home patch → `--patch`（argv 顺序），后者覆盖前者。
`--patch` 可重复传入；insert 中 `./` 或 `../` 开头的入口锚定到 patch 所在目录。裸包名相对
Bundle 自身解析，因此组合 Bundle 必须将组件声明为固定版本 dependencies，并从自己的安装目录
解析，不能依赖 launcher 工作区恰好存在同名包。

profile 的 `dependencies` 是第三方 Bundle 是否安装的事实，`dsh.profile.bundles` 是 Bundle 是否
启用的事实，profile patch 中目标行的 `disabled` 则是组件是否停用的事实，三者不能混用。
项目首次默认安装第三方 Bundle，配套升级只处理仍在 dependencies 中的包，并保留后两种状态；
卸载后不得仅凭“默认清单”重新加入 dependency 或 bundles。
升级判定用状态文件（`dsh-station-bundles-state.json`）记录的介质版本与内容指纹（目录树
路径+字节的 sha256）：两者与介质一致且 profile `node_modules` 链接完好时启动跳过介质物化
与 pnpm（快路径）；版本或内容变化、链接缺失、迁移走完整路径。指纹覆盖了开发栈每次构建
重写 `.dev/plugins` 的同版本变化，因此开发栈不再需要强制刷新参数；旧状态文件没有指纹，
升级后第一次运行会走一次完整路径补齐。

项目介质物化由 `packages/launcher/src/plugin-copy.ts` 以最多 8 路文件操作复制，普通依赖仍是
真实文件；仅 pi-ai/http-proxy 保持原有共享模块链接，不改变安装布局或依赖版本。
失败后停止派发并等待在途写入结束；profile 根的 `.dsh-station-plugin-media.pending` 在修改缓存前写入，
复制、官方安装和状态提交全部成功才移除。标记存在时禁止快路径，但保留旧 offered/停用/卸载状态，
避免重试自动补回用户已卸载的包。完成阶段耗时仅输出到 launcher 日志，不进入加载页状态协议。

profile patch 执行时，末尾 overlay 插入的行还不存在，所以覆盖普通项目插件 config 需要更靠后的 patch，
且目标行必须有稳定 id。用户可编辑的插件字段通过带 volatile Config 的插件行和 configForms 写入；
其他设置仍按其所属服务的契约处理。

插件管理页有三类槽位：`plugins.item` 是官方插件卡片 list；第三方 Bundle 配置使用 keyed
`plugins.bundle.config`（key 为 Bundle 完整包名），组件行配置使用 `plugins.row.config`。
0.1.7 的项目配置表单以插件行 entry id 寻址，写回该行的 volatile Config，而非独立设置命名空间。
槽位声明出处：`packages/client/ui-plugin-manager/src/client/{slot-contract.ts,PluginManagerPage.tsx}`。

## 原生「添加插件」与显示

出处：`packages/client/ui-plugin-manager/src/client/{presentation.ts,manager-store.ts,PluginManagerPage.tsx}`、
`packages/boot/plugin-manager/src/index.ts`。管理页行为应以当前安装版本为准。

- 「添加插件」支持包名/版本、Git、压缩包与宿主机器的本地绝对路径；目录应指向有
  `package.json` 且声明 `dsh.bundle.patch` 的包根。已在当前管理列表中的包会被拒为 already-installed。
- Web 安装先 inspect，再由官方包管理器写 profile dependency；安装完成后点「立即启用」才选入
  `dsh.profile.bundles`。直接关闭安装完成弹窗会保持已安装、未启用。
- 外部包列在「已安装」，标题按展示规则去掉常见包名前缀，简介来自 package.json 的
  `description`，不是 README；因此分发介质必须保留 manifest 的准确中文简介。
- Bundle 开关改有序 bundles 数组；行开关改 profile patch 的 disabled，两者不是同一种停用。
  没有 HMR 时需要重启 dsh 才应用运行时变更；管理页出现卡片不等于功能已经加载。
- 每个 Bundle `insert` 行必须给出跨重组稳定且全局唯一的 `id`。Cordis Loader 会给匿名行生成随机 ID，
  Profile HMR 全量重读 Bundle 后便会把未变化的匿名行当成新条目，并在旧条目仍存活时重复 import。
  这会使任意 Bundle 开关被无关插件的 `failed to import` 阻断；磁盘选择已保存但旧 fiber 未卸载，
  随后的卸载又会得到 `bundle-in-use`。进程重启只会掩盖问题，不能以“重启后正常”代替稳定 ID。

### dsh-station 分发约束

- 根 `plugin-catalog.json` 将 20 个功能组件映射为 4 个组合包与 6 个独立包。发行介质位于
  `plugins/`，开发介质位于 `.dev/plugins/`；两者都用本地绝对目录走上述官方安装流程。
- 组合包是安装/卸载/升级单位，其 `cordis.patch.yml` 仍为组件保留独立稳定行。组件从 Bundle
  内嵌依赖的相对路径装载，并用 Bundle 选择状态跳过 HMR 卸载阶段的瞬时残留行。普通组件可以
  单独 disabled；models-catalog 与 model-capabilities 共同构成 `llm-pi-ai` 启动屏障，不能只停一行。
- directory-picker-browse 需要 Bundle 层静态 override 原生 picker，因此必须是独立包，不能作为
  可单独停用的组合包组件。
- connection 的 webRuntime/webServer 注入和模型 HMR 启动屏障由壳级 remote-privileged
  以 `--patch` 常驻加载，不进入原生第三方插件安装、启停与卸载流程。模型组件在启动时把屏障
  挂到 root fiber；未选择模型增强时由壳提供占位屏障，避免 Bundle 切换重启 `llm-pi-ai`。

## 简洁模式预设 Bundle

出处：`packages/bundle/web-app/cordis.patch.yml`、`packages/preset/agent-preset-registry/src/index.ts`、
`packages/preset/agent-preset/src/index.ts`、`packages/preset/persona/src/index.ts`、
`packages/core/agent-tool-presentation/src/index.ts`、`packages/core/system-prompt/src/index.ts`；
项目定义见 `packages/plugins/concise-mode/cordis.patch.yml`。

dsh-web-app 提供 `agent-preset-registry` 与原生预设；concise-mode Bundle 排在其后，用 patch 直接
插入 `preset-concise` 和 `preset-concise-ptc` 两行 `@deepseek-ai/dsh-agent-preset`，
各行 `config.plugins` 内联声明 persona、工具与压缩插件。这里没有 preset root、locator entry
或以文件系统目录加载预设的逻辑；只在 dsh-station-web profile 增加这两个预设。

0.1.7-rc.1 不再支持旧版「复制预设 → 写入用户预设目录」：预设现在是 profile/Bundle 中的
`@deepseek-ai/dsh-agent-preset` 声明，原生设置页只提供「查看配置」（只读）及「让 Agent 帮我创建预设模式」。
后者进入创造模式，生成并安装声明预设的 Bundle；开启「新任务可选择模式」后才能点击。
上游提交 `d1e22a7e24`（`feat(preset): declare Agent compositions in profile YAML`，首次包含于 0.1.7-alpha.1）
直接删除了旧 UI 的 `beginCopy` / `CopyDialog`、旧注册表的 `@Remote('copy')` 及
`packages/preset/agent-presets/src/authoring.ts`；旧方案被归档于
`.agents/notes/archived/simplification/2026-08-08-copy-only-preset-authoring.zh.md`。
新版依据见 `packages/client/ui-agent-preset/src/client/AgentPresetSection.tsx`、
`packages/preset/agent-preset-registry/src/index.ts`。remote-settings 不接管预设页，也不恢复旧版写目录接口。

两个预设保留文件、搜索、技能、前台 shell、前台一次性子代理、用户提问、待办和压缩。
shell 与 subagent 的 enableRunInBackground 为 false，subagent 使用 one-shot。
profile 根层的 service_* 和 interactive_terminal 仍可继承。

- concise：complete:true、includeRuntimeContext:false，原生工具 schema。
- concise-ptc：complete:false、includeRuntimeContext:false，纯 ptc，模型协议只暴露 run_code。
- complete:true 会过滤 system-prompt section，连 tools:ptc-only 与 tools:sdk 一起过滤，不能用于纯 PTC 预设。
- PTC SDK、提示词、并发、worker、子调用日志均由 dsh 提供，不复制实现。
- PTC 内部调用记录 tool/ptc-dispatch，项目统计只使用顶层 tool/call。

## 客户端产物

出处：`packages/client/modules/src/index.ts`、`packages/client/tsdown.client.ts`、`packages/client/web/src/platform.ts`。

客户端扫描会从 --patch 的入口向上寻找 package.json，读取 dsh.client 与 exports["./client"]。
浏览器 bundle 使用 lazy CJS factory，由 window.__ModuleLoader__.load 注册，必须匹配页面模块表。
React、Cordis、store、slots、ui-primitives 等共享运行时保持 external，其他依赖按需内联。
跨插件通过 Cordis 服务协作，避免重复打包造成模块实例不一致。

缺失 dist/client.js 会导致客户端模块激活失败，可能使整个 Web UI 无法启动。
launcher、开发栈和打包脚本必须同时检查宿主与浏览器产物。

注册时 readFileSync 将 bundle 读成不可变快照，以 IMMUTABLE_CACHE 下发；只有 rebuilt() 会重读，
该回调由 HMR watch 触发。dsh-station-web 没有 HMR，任何插件改动都必须构建并重启 dsh。

## 原生客户端加载页

出处：`packages/client/web/src/boot-page.ts`、`src/boot.ts`、
`packages/client/ui-renderer/src/client/index.ts`；对照 0.2.0-rc.2 发布的 Web 前端产物确认。

`AppWebEntry` 构造时创建 `BootPage`（`Loading plugins…`），随后在当前浏览器文档里
预取、加载并激活客户端插件，最后交给 `uiRenderer` 挂载工作台；没有最短展示时间。
桌面 launcher 的 ready/token 只表示后台可进入，不代表浏览器插件已经加载完成。
壳的 loopback 加载页与原生 BootPage 是先后两份文档；前者不覆盖后者，也不能代替其加载阶段。
未观察到原生提示不等于流程被跳过。隔离 WebView2 实测：热缓存样本的 BootPage 在
130.4ms 被工作台替换，首次绘制为136ms，确实可能没有可见帧；冷缓存样本首绘后仍保留约165ms。
测量方法、三次结果及边界见 [启动时序调研](../reference/startup-timing.md)。

## index.html 注入

出处：`packages/host/webserver/src/index.ts`（`webserver/index-inject` 事件）、`src/injections.ts`。

宿主插件订阅 `webserver/index-inject`，向每次渲染重新收集的表追加结构化行；行是纯
JSON 数据，serve 形态渲染进 index.html 文本，静态 worker 形态由 boot payload 的页面解释器
按同一顺序执行。行类型：`global`（先于后续 script 行给 globalThis 赋值）、`script`
（内联经典脚本，text 不得含 `</script`）、`script-src`/`script-preload`、`style`、`html`。

head 位置的经典脚本 parser-blocking，先于页面 combo 模块求值。remote-settings 用
global 行注入 `__DSH_TRANSPORT__`；browser-compat 用 head script 行在旧 WebKit 上垫平
Iterator/AbortSignal/Promise 能力，并建立当前页面内存中的诊断桥（函数体 `toString()` 序列化，
必须自包含、不引用模块作用域）。client 半读取该桥显示临时日志，不向 Host 发 RPC。

原生启动页承担认证交接之后的浏览器插件加载等待（见上文「原生客户端加载页」）。
创建 DOM 不等于立即绘制；不能用 index 注入或 rAF 中看到该节点来保证用户一定看得到。

## 设置写入（dsh 0.1.7 重写）

出处：`packages/settings/settings/src/index.ts`（SettingsForms）、`packages/client/ui-settings/src/client/config-form.ts`（configForms 服务）、
`packages/client/ui-primitives/src/settings-form/`。

dsh 0.1.7 移除了 `settings.register` / `ctx.settingsScope` / `settings.plugin.item`，用户可改字段并入插件行的
composition Config：

- 宿主半导出 `Config`（z schema，可热改字段链 `.volatile()`）与同名 interface（`Volatile<T>` 字段）。
  `apply(ctx, config)` 收到解析后的 config；读值 `config.x.get()`（兼容 schema 直接解析出的普通值），
  响应热更新用 `ctx.on('loader/volatile-update', cb)`（事件名声明来自 `@deepseek-ai/cordis-plugin-loader`）。
- 跨字段校验挂 `ctx.on('internal/config', function (this: Fiber, _raw, next) {...})`：`next()` 取候选，
  `this !== ctx.fiber` 时放行；校验抛错即拒绝写入、不落盘。参考实现 `packages/plugins/proxy/src/index.ts`。
- 宿主 SettingsForms 仍提供跨命名空间 `describe()` / `mutate(ns, ops, expectedRevision?)`；
  表单命名空间是 profile 行的 entry id（`cordis.patch.yml` insert 行的 `id` 字段），不再与文案命名空间同串。
- 浏览器半 `ctx.configForms.get<T>(entryId)` 返回 ConfigForm（inject 用 `configForms`）：
  `getSnapshot()/subscribe()`、`mutate(ops)`、`set(field,v)`、`unset(field)`。**mutate/set/unset 返回
  Promise<boolean>，false 即宿主拒绝**——0.1.7 起无需写后回读比对。快照含 `value/status/writable/revision`。
- 插件配置页挂侧栏 Plugins 页三槽（`plugins.item` 官方页、`plugins.bundle.config` 按 bundle 包名、
  `plugins.row.config` 按包名#行id）；`settings.section` 槽仍在，本项目设置分区继续用它。
- schemastery 3.18.4 起 schema 常量不再写 `z<Config>` 显式注解（exactOptionalPropertyTypes 报错），
  常量不注解、interface 单独声明。

写入 UX 约定不变：保存前用宿主与浏览器共享的纯函数校验；mutate 返回 false 报错并保留草稿，
确认成功才清草稿和显示已保存；错误贴近字段，成功提交触发的刷新不能立即抹掉成功提示。

## 槽位与导航

出处：`packages/client/ui-slots/src/index.ts`、`packages/client/ui-settings-models/src/client/slot-contract.ts`、
`packages/client/ui-conversation/src/client/contract/slots.ts`。

- keyed/single/list 槽同一 cell 可以按 priority 影子覆盖，数值最小者渲染；同 cell + 同 priority 才冲突。
- 接管现有 renderer 使用 priority:-1；并列添加用 list 或插件定义的子槽。
- **设置导航是例外**：当前 `ui-settings-general/src/client/index.ts` 用原始 `slots.entries('settings.section')`
  投影导航，而不是 `entriesOfSlot`。同 id 的 priority shadow 虽然只渲染一个正文，却会生成两个菜单项。
  不应把 list 正文 shadow 当作无副作用的菜单增强。remote-settings 不注册或包装 Agent 预设页面，也不添加路径复制 UI。
- 普通 list 槽由标准 `renderSlot` 按 cell 选择 priority 最低的 winner。顶部
  `conversation.session.header.utilities/open-in-app` 没有另做 raw ledger 导航投影，因此 remote-settings 可用
  `priority:-1` 复用原 component/store/inject/locale，仅替换注入的 Explorer launch；其它 app 与其它 header 项保持原生。
- `ctx.slots.onEntryError` 观察被错误边界捕获的 slot renderer 异常；它只覆盖渲染边界，不等于全局
  （0.1.6 起回调参数是 StoredEntry | StoredFactory 联合，Factory 没有 options 字段，需 `'options' in entry` 收窄）
  `window.error` 或 Promise 拒绝监听。监听器随插件 fiber 清理，来源为 `packages/client/ui-renderer/src/client/registry.ts`。
- settings.models.provider-card 是 keyed，llm-pi-ai 的入口由 copilot-auth 负责组合。
  model-capabilities 使用其项目子槽，models-catalog 使用 settings.models.footer。
  0.1.6 起 ISessions.list 不再携带 current（SessionListState 只是目录）；根作用域组件要当前会话，订阅 ctx.uiSession.adapter.current 并读快照的 key。
- conversation.view 是 session-scoped list，label 必须是 thunk，才能随语言切换。
- conversation.chat.node 是 keyed；新增消息行需要自己的 ConversationNodeDefinition 和新 key。
- conversation.input.dock 是输入框上方的 list；conversation.composer.dock 在下方。
- conversation.chat.turnTail 是 chain，不适合保证多个插件并列显示。

settings.section 没有 icon 字段，导航 shell 按 id 选择图标，未知 id 为齿轮。
出处：`packages/client/ui-settings-general/src/client/SettingsRoot.tsx`。
项目的代理、通知、全局提示词和浏览器日志使用局部导航标记和注入样式，不替换 React 节点。
当前图标映射为 `IconGlobeOutlineMedium`、`IconAlarmClockOutlineMedium`、`IconListPenOutlineMedium` 和
`IconCodeOutlineMedium`；`settings.section` 没有 icon 字段，因此插件调用这些原生 component 并将
返回的 SVG element 序列化成导航 mask。已安装的 0.2.0-rc.2
`@deepseek-ai/dsh-client-ui-primitives/lib/index.js` 中，这些 component 返回的 React element
先以纯函数 Artwork 为 `type`，Artwork 再返回原生 `<svg>`；项目公共 helper 必须有界展开函数包装，
不能只接受 `type === 'svg'`，否则四个设置页插件启动即失败。
公共 helper 使用 dsh shell 已渲染的直接子 SVG 作为 mask 载体，并隐藏其原生子路径，避免伪元素在
React 重建或旧 WebKit flex 布局中丢失。升级检查包含 `navCell`/`navLabel` 的局部类名；不匹配时退回默认图标。

### 右侧 Sidebar 页面类型

出处：`packages/client/ui-sidebar-right/src/client/tab-registry.ts`、`contract/slots.ts`、`service.ts`，
文件树实例见 `packages/client/ui-sidebar-files/src/client/{definition,index,FilesBody}.ts`。

- 页面类型通过 `ctx.sidebarRightTabs.register({ id, kind, priority, title, guide })` 注册；不声明 `patterns` 的类型是页面，入口由 guide box 的 `id/order/title/description/icon` 提供（0.1.6 起 `id` 必填，为 provider 内稳定标识）。
- 页面正文必须以同一 `id` 注册 keyed slot `sidebar.right.pane.tab`；组件通过标准 props 的 `useTabInfo()` 读取当前 tab 与 `tab.actions`，并由 session scope 自动得到 `sessionId`。
- `ctx.sidebarRight.openTab(kind)` 打开页面；条目内部应使用 `tab.actions.openTab/openResource`，不要自己拼 `sidebar://` 地址。files 增强只 shadow 原生 `files` body，不另注册用户可见 kind；其他外部插件仍使用独立 kind，只有明确接管 builtin kind 时才用 `priority: 'extension'` 同 kind 注册。
- 页面包的 `package.json` 用 `dsh.client.inject` 声明对 `@deepseek-ai/dsh-client-ui-sidebar-right` 的模块关系；Cordis 运行时仍把 `sidebarRightTabs` 放进插件 `inject`，两者不是同一种依赖。

### 原生文件增强的复用边界

出处：`packages/client/ui-sidebar-right/src/client/{tab-registry.ts,service.ts,contract/slots.ts}`、
`packages/client/ui-renderer/src/client/registry.ts`、`packages/client/ui-slots/src/index.ts`、
`packages/client/web/src/platform.ts`。文件能力见 [工作区](workspace.md)。

- 同 kind 共存只允许一组 builtin + extension；原生 `files` 可以这样接管，guide 只列生效项，
  卸载 extension 后恢复 builtin。`text` 属于 fallback，不能用 extension 同 kind 重注册，二者会冲突。
- `ctx.sidebarRight.split(paneId)` 返回新 pane id 或 undefined；底层 dockkit 默认预算为四个 docked pane，
  当前 Sidebar controller 的 split 还在已有两个 docked pane 时拒绝分栏，并受空间与浮动状态约束。
  `tab.actions.openResource(address, { paneId })` 可指定目标 pane，但分栏本身不会改变原生树“在自己的 pane 打开文件”的行为。
- `FilesBody` 与 `TextPreview` 没有从各包 client 入口导出为运行时值，两包也不在平台共享模块表；
  不能仅添加 external 就假定浏览器能 import 它们。发布 files 列表也不包含源码，不能依赖 `./src/*` 导入。
- `slots.entries` 是登记快照，不是通用组件嵌入 API；files 增强在当前版本只把它作为版本受控的适配 seam：
  shadow 登记完整复用原 entry 的 component、store、inject、locale，并只在外层观察/事件委托。
  这不是对任意 dsh 组件的稳定承诺，原生登记契约变化必须由冒烟检查响亮失败。
- Slot 的子槽由唯一登记 owner 声明并持有 render 授权；对现有 cell 加 priority:-1 不会继承原登记项的 children。
  files 不重声明 `sidebar.right.tab.document`，不覆盖 `ui-sidebar-documentpreview` owner；ctx 级 renderSlot 只能渲染 root。
  因此不能把原生预览拆出来任意嵌入另一个 body。图片增强改在原生 text title slot 以 portal 控件定位已渲染 image frame，
  不复制 ImageBody 或通过 root 重新声明 document child slot。已安装 0.1.7 的 ZoomViewport 以
  `data-document-zoom-scrollport` 标识自身滚动容器；Space+鼠标平移只滚动当前图片的该容器，
  不移动原生 DOM。portal 内的交互控件必须同时阻止
  `pointerdown` 和 `click` 冒泡；dockkit 的原生 tab 会在 pointerdown 启动拖动/重建，若不阻止，浏览器可能把
  portal 按钮的后续 click 重定向到 tab。该行为与 `ui-dockkit` 的 TabMenu 处理一致，files 的图片工具栏遵循同一规则。

### 临时预览页签的可用接口

出处：`packages/client/ui-sidebar-right/src/client/{service.ts,tab-domain.ts,stores.ts,contract/slots.ts}`、
`packages/client/ui-sidebar-documentpreview/src/client/TextTitle.tsx`。
以下为当前基线源码事实，尚不表示项目 files 已实现临时页签。

- 原生没有临时/保留页签标志。`sidebar.right.pane.tab.title` keyed 槽可扩展标题，
  `useTabInfo()` 提供 tab id、panel id、navigation、actions、signal；原生 TextTitle 提供文件图标和名称。
- `ctx.sidebarRight.openResource(address, { replaceTab: tabId })` 可替换指定页签；tab 自身的
  `actions.openResource(address, { replaceTab: true })` 替换的是调用者自己，不能在文件树 tab 上直接调用后者。
- 替换是一次原子布局操作：借用旧 docked tab 的 pane 和 strip 位置，打开新 occurrence，再关闭旧 occurrence；
  不保证 tabId 不变。关闭会 abort 旧 signal，正文读取状态仍归原生预览管理，不手改 contentId。
- 原生资源按 `(kind, contentId)` 跨 pane 去重，默认 `revealIfOpened:true`。命中既有 tab 时也会关闭
  `replaceTab` 指定的另一 tab；因此“聚焦已打开文件”不应盲目附带 replaceTab。
- `openResource` 返回 void，没有公开的新 tabId 回调；增强需通过标题槽的 live 信息确认落点，不能猜 id
  或私读布局 store。tab signal 仅在 tab 消失/宿主插件卸载时 abort，切换 tab/会话或 body 卸载不等于关闭。
- 浮动 tab 的替换不继承浮动位置。移动/浮动后的临时页签需要明确策略，不能继续按旧 pane 关联替换。

### Sidebar 首次打开的默认页

出处：`packages/client/ui-sidebar-right/src/client/contract/seed.ts`、`tabs/guide/GuideBody.tsx`（同包 client 下）；
0.1.6 的子槽与终端定制入口另核对已安装包的 `@deepseek-ai/dsh-client-ui-sidebar-right/lib/client.js`、
`@deepseek-ai/dsh-client-ui-sidebar-terminal/lib/client.js`。

- `defaultSeed` 在仅有一个 guide 入口时直接选择该入口的页面 kind；零个或多个入口时选择 `guide`。
  不要为了强制显示 guide 增加虚假的页面类型与 guide 入口。
- guide 的原生正文从已登记的页面类型生成入口；`sidebar.right.tab.guide` 是 chain，非拒绝的
  插件项会**整体替换**原生正文，不会自动保留其它入口。已安装的 0.1.6 中每个入口还能经
  `sidebar.right.tab.guide.entry` keyed 子槽由登记方定制（新建终端有原生下拉），不能用单文件入口
  的整页替代品吞掉它。files 只增强原生文件树，不注册 guide chain/entry。
- guide 中选择入口通过该 guide tab 的 `actions.openTab(kind, { replaceTab:true })` 替换 guide 自身。

### 页签右键菜单与关闭范围

出处：`packages/client/ui-dockkit/src/components/{TabPanel.tsx,TabMenu.tsx}`、
`packages/client/ui-sidebar-right/src/client/{contract/slots.ts,stores.ts,shell/SidebarRight.tsx}`。

- 原生 TabMenu 提供关闭项，并在其后渲染 `sidebar.right.tab.menu.item` list 槽；该槽为 session scope，
  owner 提供右键目标 `tab` 与 `dismiss()`，没有 paneId 或分栏页签列表。动作必须自行 dismiss。
- 非激活页签的右键不会先激活它，故批量关闭必须以右键目标所在 pane 为准，不能使用 active pane 代替。
  `data-dockkit-pane`、`data-dockkit-tab` 可用于当前版本只读、局部归属核验，不是稳定的布局查询 API。
- 原生关闭拒绝不存在的 tab，并保护唯一 docked guide；关闭最后一个非 guide docked tab 会收起 Sidebar。
  增强应沿用关闭入口及布局规则，不直接删布局记录或循环清除新出现的默认页。
- 项目「关闭其他/关闭全部」仍为待实施方案：固定当前分栏 tabId 快照并逐项核对存活/归属，不越过分栏或会话边界。

## 主题与对齐

### 原生主题偏好的作用域

已按 0.2.0-rc.2 的 ui-theme、ui-settings、config-editor 源码核对；本地旧 checkout 不作为此结论基线。
出处：`packages/client/ui-theme/src/{index.ts,theme-settings.ts,boot-theme.ts,client/index.ts}`、
`packages/client/ui-settings/src/client/config-form.ts`、`packages/boot/config-editor/src/index.ts`。

- 三态为 `light/dark/system`，默认 `system`；宿主配置为原生 `ui-theme` 行的 volatile `config.preference`。
  ConfigEditor 写活动 profile 的 `cordis.patch.yml`，不是浏览器 localStorage；不由 relay 直接读写该文件。
- 客户端公开服务为 `ctx.theme`：`getTheme()` 读快照，`setTheme()` 改偏好，`theme/change` 通知变化；
  内部通过 `configForms.get('ui-theme')` 订阅配置。`setTheme()` 本身返回 void、先本地更新，不能当作持久化成功的回执。
- 可访问宿主设置的客户端共享同一宿主/profile 的持久化偏好；不是每个浏览器独立保存。
  缺少可写宿主设置时不能承诺跨客户端持久化同步。`system` 只共享选择，各设备自行按操作系统解析明暗。
- 宿主每次 index 渲染注入当前偏好与启动配色，刷新时不依赖浏览器存储恢复。
- 项目管理页按 D26 单向跟随此偏好；登录、首次设置和离线页仍使用独立 Cookie。
  公开 `/_theme` GET 只改 Cookie，不接入宿主设置写入，也不影响管理页。

### 工作站只读主题投影

项目实现：`packages/plugins/remote-privileged/theme-projection.mjs`、
`packages/protocol/src/theme-projection.ts`、`packages/relay/src/admin/{native-theme,theme-events,theme-client}.ts`。

- 壳级插件等 `ctx.loader.await()` 完成，从 `loader.entries()` 定位 include 下唯一活跃的 `ui-theme` 行，
  读 `fiber.config.preference.get()`；没有可用原生行时保留旧投影并输出固定诊断，不猜默认配置。
- 订阅 `app-boot/config-reload`：`reconcileProfilePatches` 完成活跃性校验后广播，ConfigEditor 持久化修改会经过此路径。
  原生 `settings.describe()` 返回完整描述列表，不接收 namespace 参数；不把定向 `loader/volatile-update` 当作全局事件。
  来源：`packages/boot/app-boot/src/profile.ts`、`packages/boot/config-editor/src/index.ts`；已核对0.2.0-rc.2源码。
- launcher/dev-stack 用 `DSH_STATION_THEME_FILE` 传绝对路径。插件原子写 `dsh-theme.json`，
  严格只有 `{version:1,preference:light|dark|system}`，最多1024 UTF-8字节；不携带原生配置、URL或凭据。
- relay 只读项目投影，以目录 `fs.watch` 覆盖原子替换，去重后通知管理页；坏文件/缺失保持进程内上次有效值，首次为system。
  管理 HTML 直接带初值，固定哈希脚本单向消费 NDJSON，认证/连接寿命限制见 [安全](../04-security.md#管理页只读主题流)。
- 隔离真实 dsh 原生 mutate 与 Chrome 管理页验证 dark→light→system、非法值拒绝；
  同一文档和一条流内更新，草稿不变，CSP无违规。升级须复核上述loader/重载提交点与原生theme字段。

### 视觉 token

出处：`packages/client/ui-theme/src/styles/design-platform.css`、
`packages/client/ui-primitives/src/icons/index.tsx`。

| 用途 | 正确 token 或规则 |
|---|---|
| 描边 | --dsw-alias-border-l1、--dsw-alias-border-l2，l 是字母 |
| 层背景 | --dsw-alias-bg-layer-2 |
| 文字 | --dsw-alias-label-primary、secondary、tertiary |
| 等宽 | var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace) |
| 抬升面 | --dsw-specific-tip |

浅色 bg-layer-1/2/3 都是白，bg-layer-4 无定义；内嵌容器不能只靠层背景表达边界。
--dsw-font-mono 虽被引用但未定义，必须提供完整字体栈。
token 拼写和实际值是两件事，需用真实页面 getComputedStyle 检查深浅主题。

图标与文字对齐先用嵌套 flex；外层 stretch，各块内部 align-items:center。
汉字墨迹中心与 SVG 几何中心仍可能相差约 1.5px，图标格可用 translateY(0.115em) 做光学补偿。
具体量法见 flex-centering skill；图标尺寸必须放入真实相邻导航行比较。

### 插件配置表单

出处：`packages/client/ui-settings-plugins/src/client/fields.module.css`、`fields.tsx`。
编写主题样式先加载项目 [dsh-theme skill](../../.agents/skills/dsh-theme/SKILL.md)，
其中包含级联、原生控件与深浅主题验证方法；新经验经验证后自动合并回技能。

- 字段使用 34px 内容高度、水平 12px padding、0.5px border-l4、8px 圆角、bg-layer-3，
  文字为 13px / 1.5 / label-primary；核对 content-box 与实际渲染高度，不能只抄 height。
- 内置字段 `:focus-visible` 取消 outline，只将原有边框改为 brand-primary，不叠加粗外圈。
  下拉触发按钮用 `:focus` 同时覆盖鼠标与键盘，`[aria-expanded='true']` 在菜单内获得焦点时保持边框色；
  不能移除轮廓后丢失可见焦点反馈。
- 默认与焦点/禁用态的 border、color 放在局部 CSS；inline border/color 会压过普通伪类规则。
  禁用态使用 label-tertiary、default cursor，同时保留原生 disabled 语义。
- `appearance:none` 不会自动移除 UA 焦点 outline，也不会统一 OS 原生 select 弹层的 hover。
  卡片 header 的 2px 键盘焦点圈不受字段规则影响。
- 设置 → 模型里的原生字段基准来自 `packages/client/ui-settings-models/src/client/ModelsSection.module.css`：
  `border-box`、32px、0.5px border-l4、8px、bg-layer-1、14px/22px、brand focus；select
  额外保留右侧 12px chevron。`model-capabilities` 的三个能力/协议 select 必须跟这个基准，
  不能退回 1px border-l1、透明背景或 UA focus。
- 设置 → 代理与全局提示词是项目自有原生 input/textarea；它们也必须给出局部 focus/disabled
  状态，避免实际页面出现黑色 UA outline。编辑器的等宽字体、较大高度和 textarea 语义可以保留。
  日志/终端输出等 code surface 则是有意的阅读容器，不按表单字段强行改成同一高度；终端实际输入框仍按 dsh
  字段处理，不能因为同在一个 dock 就沿用输出区的 l1/transparent 样式。

### 选项菜单

出处：`packages/client/locale/src/client/LanguageRow.tsx`、`packages/client/ui-primitives/src/Menu.tsx`、
`Menu.module.css`。选项菜单以 dsh external `Menu` 复用页面运行时。

- 选项 hover 使用 `--dsw-alias-interactive-bg-hover`，不要给原生 option 强套 CSS，或修改触发器背景来代替。
- 默认 `selection='check'` 以右侧勾号标记 `selectedId`，选中未 hover 时仍透明；`fill` 会常驻高亮，语义不同。
- 设置页使用 `portal` 避开滚动容器裁剪；Menu 的 `className` 仅给锚点 wrapper，不传给浮层。
- 当前 Menu 无选中项自动聚焦或方向键导航；替换原生 select 时由字段局部补齐箭头/Home/End、
  Enter/Space、Tab/Escape 和选择后焦点归还。外部点击关闭不抢焦点；禁用时关闭菜单并拒绝选择。
- Portal 首帧隐藏以测量尺寸；自动聚焦需等定位提交后（如可清理的下一帧），不能在同轮父 layout effect 中直接 focus。
- Portal 的 React 键盘事件仍到达字段 owner，局部 Escape 应阻止冒泡，避免同时关闭父设置窗口。

### 原生设置面板与桌面顶部留白

出处：`packages/client/ui-settings-general/src/client/SettingsRoot.module.css`；已对照
0.2.0-rc.2 源码核对本节公式。
设置 overlay 为 fixed 的居中 flex；面板高度为
`min(800px, calc(100vh - 2 * max(24px, var(--dsh-frame-overlay-top,24px))))`
（`--dsh-frame-overlay-top` 由 `packages/client/ui-layout/src/client/AppFrame.module.css` 发布：
桌面为 `--dsh-frame-top-clearance + 20px`，浏览器为 20px）；全屏 mask 顶部让出标题栏
（`inset: var(--dsh-frame-chrome-top,0px) 0 0`）。外部留白来自视口高度限制和居中，不是标题/header 的 padding。
项目 relay 管理页是顶部对齐的独立文档，不应复制整套 modal：其 `--dsh-station-page-top-gap`
保留24px（窄屏12px）页面留白；桌面 `chromebar.go` 将36px标题栏占位与该值叠加，不能覆盖它。
dsh 文档未定义该项目变量，沿用36px占位和border-box，不改变原生设置样式。

### Modal 弹窗

出处：`packages/client/ui-primitives/src/Modal.tsx`、`Modal.module.css`。

- 插件传给 Modal 的 `className` 落在 `.dialog` 卡片上：`position:relative`、`overflow:hidden`，
  Modal 不提供自定义 header 插槽；要在关闭按钮旁加自绘按钮，只能绝对定位在卡片内。
- header 布局：padding `22px 14px 12px 24px`，close 按钮 28×28、圆角 8、右侧 14px；
  紧贴其左侧的新按钮用 `top:22px; right:50px`（14+28+8），样式复刻 `.close`：
  transparent 背景、`--dsw-alias-label-secondary`、hover `--dsw-alias-interactive-bg-hover`，保留 UA 焦点轮廓。
- 自绘按钮必须压过插件自己的移动热区（z-index 2）与 resize 手柄（3），公共实现取 `z-index: 4`；全屏图标用
  `IconFullscreenOutline16`（仅有展开方向，无收缩图标，两种状态共用并切换 aria-label）。
- 全屏能力由 `packages/plugin-ui/src/dialog-fullscreen.ts` 提供：`useDialogFullscreen`（进入前保存几何、
  退出写回、窗口 resize 跟随、按 `open`/`identity` 复位）、`dialogFullscreenButtonRule`、`DialogFullscreenButton`。
  几何写入与拖动 resize 共用同一组 custom properties；全屏时插件隐藏拖动与八向手柄。
- 实例：services 日志弹窗（`packages/plugins/services/src/client/log-dialog.ts`）与
  turn-retry 原因弹窗（`packages/plugins/turn-retry/src/client/reason-dialog.ts`）共用同一实现，
  只有 dialog class、data 属性名和图标不同。

## Dock 约定

出处：`packages/client/ui-conversation/src/client/skeleton/TodoPanel.module.css`、`TodoPanel.tsx`、
`queue/QueueDock.module.css`。项目 dock 外观沿用官方 todo，不独立设计。

| 项目 | 规则 |
|---|---|
| 宽度 | margin:0 auto；width:calc(100% - 侧留白×2 - dock内缩×4)；max-width:calc(var(--dsh-composer-card-max-width) - dock内缩×4) |
| 背景与边框 | var(--dsw-specific-tip)；0.5px solid var(--dsw-alias-border-l1) |
| 圆角 | 12px |
| 表头 | 整行 button、aria-expanded、gap:10px、padding:8px 12px；嵌套 flex 居中 |
| 标题与摘要 | 13px，标题 500/primary，摘要 tertiary；ellipsis 放内层 span |
| 列表行 | 单行不换行；可变长文本给 `min-width:0` + ellipsis，行尾按钮组包在 `flex:none` 容器里不被压缩（实例：services 的 ServiceRow） |
| 图标 | ui-primitives 的 outline 图标；services 与 terminal 共用 IconApiOutlineMedium |
| 箭头 | 收起状态 IconChevronUpOutlineMedium，展开状态 IconChevronDownOutlineMedium |
| 滚动条 | --dsh-scrollbar-thumb 与 hover 使用 scrollbar-bg-l2、scrollbar-hover-l2 |

@deepseek-ai/dsh-client-ui-primitives 必须 external，复用页面已有组件与 CSS。
dsh `0.1.5-rc.2` 将通用文件图标统一为 `FileTypeIcon`（用 `path` 或 `kind` 选择类型），不再导出旧的
`DocumentFileIcon`；项目浏览器插件应使用新接口，并在需要时显式传 `size`。该包带 CSS，不能在 environment:node
单元测试中直接 import 含它的浏览器模块。

## 插件包约定（dsh 0.1.7）

- **peer 版本准入**：dsh 在 profile 装载时校验插件 `peerDependencies` 里的
  `@deepseek-ai/dsh*` 声明与运行时版本，不匹配即拒载整行（官方豁免通道是 profile
  `compatibility.json`）。本项目插件对 dsh 包只有类型引用，统一放 devDependencies，
  **不得**把它们声明成 peerDependencies。
- **显示元数据**：插件页/设置清单的标题与描述来自各包 `locale/{en,zh}.json` 的
  `meta.title/description`（exports 需含 `./package.json` 与 `./locale/*.json`，
  files 带 `locale`）。文案与 docs/plugins.md 词表一致；`icon` 暂不声明，用默认图。
- **Bundle 静默跳过**：dsh 0.1.7 对解析/清单/patch 失败的 Bundle 不再启动即败。0.1.7-rc.2 起
  profile 装载把跳过项收进 `Profile.skippedBundles`（装载过程本身不打印），CLI 装载完成后调用
  `reportSkippedBundles` 每次启动向 stderr 打一次 `dsh: skipping profile bundle "<包名>": <原因>`。
  launcher 在 dsh 输出行里检测该诊断并响亮警告（`skippedBundleFromLine`）；分发管线的
  「缺少宿主/浏览器产物」预检因此仍是必要的前置防线。
