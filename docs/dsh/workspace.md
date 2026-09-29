# 技能、提示词与工作区文件

基线见 [源码依据](../02-dsh-facts.md)。以下路径相对 dsh 仓库根，项目实现明确标注。

## 技能目录

出处：`packages/skill/skill/src/index.ts`、`packages/skill/skill-filesystem/src/index.ts`。

| 方法 | 内容 |
|---|---|
| list(options) | SkillSummary 列表 |
| snapshot(options) | 列表与 complete，provider 失败时为 false |
| get(name,options) | 含 content、path 的完整 SkillDefinition |

options 必须带会话 cwd 与 ctx.agents.get(sessionId) 的 scope，否则只能看到全局层。
观察页使用 snapshot，不能把 provider 失败呈现为技能凭空消失。
list 的 summary 只有 resourceBase 目录，没有精确文件路径；get 会同时读正文，因此仅点击展开时 locate。

SkillSummary.source 是开放联合，必须保留未知来源兜底：

| 来源 | 根 |
|---|---|
| project-dsh | projectRoot/.dsh/skills |
| project-agents | projectRoot/.agents/skills |
| custom | 显式配置目录 |
| user-dsh | dshHome/skills |
| user-agents | agentsHome/skills |
| bundled | 内置技能 |
| runtime | 插件注册 |

## 已加载历史

出处：`packages/skill/tool-skill/src/index.ts`、`packages/core/session/src/types.ts`。

两条正文注入路径都持久化：模型 skill 工具对应 tool/call.arguments；用户 /技能名对应
user/message 的 source.kind:skill-invocation 和 source.name。

- 回放 session.snapshotEvents，覆盖整个会话含继承历史，重启不归零。
- arguments 是模型原始 JSON 字符串，JSON.parse 必须 try/catch，畸形记录不能使整页失败。
- 配对 tool/result 带 error 的加载不计；尚未配对的 call 暂计，避免正在加载时闪烁。
- 这是“历史上曾注入”的口径，不保证压缩后正文仍完整保留在当前上下文。
- 技能页只读，不注册技能/来源/工具、不 restrict/guard，也不提供加载按钮。

## 打开目标机器文件

出处：`packages/client/ui-open-in-app/src/client/{OpenInAppAction.tsx,controller.ts}`、
`packages/host/open-in-app/src/{catalog.ts,index.ts,resolver.ts}`、`packages/api/session-controller/src/index.ts`；
项目兼容见 `packages/plugins/remote-settings/src/{client/index.ts,workspace-directory.ts,windows-directory.ts}`。

- 对话顶部「在本地打开」不是 session Remote：原生浏览器调用 open-in-app 的 HTTP 路由，传 app id 与当前会话 cwd；
  宿主先做 connection trust/auth、绝对路径和真实目录检查。其它文件动作仍可使用
  `remote.session.canOpenWorkspacePath/openWorkspacePath`（0.1.7 起 Session Remote 提供打开/揭示与应用列表）。
- dsh 0.1.7 的 Windows 原生 opener 已改为直接 `explorer.exe` + 单一 file URI 参数（无 shell、无 PowerShell 中转），
  Explorer 交接退出码 1 视为成功；`Visible:false` 问题不再存在。原生实现等待交接应答，且不做窗口激活。
  remote-settings 仍用 `priority:-1` shadow
  `conversation.session.header.utilities` 的原生 `open-in-app` 项，保留原组件、菜单、store、inject 和 locale；
  仅 Explorer 转到认证私有通道 `/remote-settings/open-workspace-directory`，宿主复核绝对路径和现存目录后启动
  可见 Explorer：spawn 成功即响应（不等交接），并异步尝试置前；VS Code、Cursor、JetBrains 等其它 app
  仍调用原生路由。置前与立即返回相对原生实现的增益、以及是否改回原生，待实机验收后定。
- 动作发生在运行 dsh 的目标机器桌面，手机看不到；不按 Host 判断同机，不修改 relay。

## Agent 预设

dsh 0.1.7 起 Agent 预设改为 profile YAML 声明（上游 `d1e22a7e24`，包 `@deepseek-ai/dsh-agent-preset-registry`），
`settings/openAgentPresetDirectory` RPC、`agentPresets.resolve` 的 path/trust 概念均已移除；本项目原先针对
0.1.6-alpha.2 隐藏 PowerShell opener 的预设目录接管已随之删除。预设的创建、编辑与默认选择全部走原生 UI；
上游 Windows opener 行为见上节。

## 全局提示词

出处：`packages/context/agent-instructions/src/{files,render,config,index}.ts`。

discoverBaselineInstructionFiles 先收集 dshHome/AGENTS.md，再收集项目根到 cwd 的项目文件。
文件缺失是正常状态。显示路径为 ~/.dsh/AGENTS.md 或 $DSH_HOME/AGENTS.md。
USER_GLOBAL_FILE 定义在内部 render.ts，不在公开入口，插件只能保留对应常量。

项目 agents-md 只编辑这一份全局文件，不注册额外 agent-instructions 行、不把正文存入设置 namespace。
按 UTF-8 字节校验默认 1 MiB 上限，超过 maxSourceBytes 的文件会被 dsh 静默跳过。
两半共享 documentFault，临时文件加 rename 原子保存，失败保留草稿。

升级验证不能只测自己的常量：写入标记后调用 dsh 导出的 discoverBaselineInstructionFiles，
确认真实加载器认领了该文件，见 scripts/agents-md-check.mjs。

## 原生文件树与文档预览

出处：`packages/client/ui-sidebar-files/src/client/{index.ts,FilesBody.tsx,face.ts,store.ts}`、
`packages/client/ui-sidebar-documentpreview/src/client/{index.ts,TextPreview.tsx,document/contract.ts}`、
`packages/api/workspace-files/src/index.ts`。以下为当前基线的原生契约，项目增强范围见下一节。

- 原生树属于 `ui-sidebar-files`（页面 kind `files`），不是 `ui-sidebar-documentpreview`。
  树按层调用 `remote.workspaceFiles.list`，目录优先、自然排序，默认显示 dotfiles；
  点击文件通过当前 tab 的 `actions.openResource` 导航，默认落在该 tab 所在 pane。
- 原生树的 `Entry`/`Level` 是包内组件，没有行装饰子槽或自定义 onOpen prop。
  DOM 提供 `data-files-entry`、`data-files-path`，但这不等同于稳定的 Git 装饰 API。
- 文档预览为资源 tab（kind `text`），原生负责加载、渲染器切换、换行、刷新、变更提示与行号导航；
  提供纯文本、代码、Markdown、HTML、图片、PDF。它是预览，不提供编辑/保存。
- `sidebar.right.tab.document` 子槽用于注册正文渲染器，内容由原生 owner 准备，
  不是外部任意容器可直接调用的完整预览组件。两包 client 入口没有 FilesBody/TextPreview 值导出。
- `workspaceFiles` 的目录列举限制在 Session 工作区内；文件读取/stat/readRelated 接受
  绝对或相对路径，允许读取组合文件系统授权的工作区外文件。末端 lstat/普通文件检查
  不等同于项目 files 的逐段拒绝 symlink、读取前后身份复核。
- 原生 scope 从 live Session header 或持久层 header-only stat 解析，缺 cwd 时用 sandboxPolicy 根，
  不要求 live Agent。项目 Git 端点的 live Agent/cwd 边界不能因此被默认放宽。
- 默认文本页最多 2 MiB / 5000 行，完整字节读取最多 32 MiB，目录响应最多 2000 项；
  `list` 先 listDir 再截断响应，不保证目录枚举工作量有界。文本可继续分页，没有旧 files 的 1 MiB 整文件门槛。
- 文件变更来自 `fs/observed` 而非 OS watcher，不覆盖 shell/Git/外部编辑器的改动；
  不能用该流宣称 Git 状态实时准确。HTML 预览会在隔离 iframe 中执行脚本，并可请求外部资源。

### 原生图片缩放与项目增强

出处：`packages/client/ui-sidebar-documentpreview/src/client/{zoom/ZoomViewport.tsx,zoom/ZoomControls.tsx,image/ImageBody.tsx,image/ImageBody.module.css}`、
`src/client/document/contract.ts`（`src/client` 均属于同包）；已安装 `0.2.0-rc.2` 的 `lib/client.js`
包含 `ZoomViewport` / `ImageBody`。项目实现见 `packages/plugins/files/src/client/imageZoomOverlay.tsx`、`imagePan.ts`。

- 原生 `ImageBody` 使用共享 `ZoomViewport`，每个 tab 单独保存缩放偏好，默认「适应宽度」（仅缩小宽于视口的图片）；
  原生工具栏提供适应宽度和固定档位（25%、50%、100%、150%、200%），增减按钮及 Ctrl+滚轮可在 25%～400% 范围缩放；`scrollportRef` 报告其滚动容器。
  原生没有「适应窗口」（同时按宽高缩放）或 Space+鼠标拖动平移。
- 图片登记在 `sidebar.right.tab.document`，key 为 `@deepseek-ai/dsh-client-ui-sidebar-documentpreview/image`；
  该登记是 TextPreview entry 声明的 child slot。root `ctx.slots.entries` 不能直接重声明这个 child：重复声明 owner
  会失败，不能把它当作普通全局 slot shadow。
- child owner 提供 `content`（原生已读取的完整 bytes）、`resourceAddress`、`wrap`、`scrollportRef`，
  并提供 `useTabInfo`。`scrollportRef` 可报告 renderer 自有滚动容器，传 null 退回共享正文滚动面；项目不接管这个 child owner。
- 原生图片内部负责 Blob URL 创建/回收和加载/失败状态，DOM 标记为 `data-image-preview`；SVG 仅作为
  img Blob URL 显示，不内联为活动 SVG。项目在原生 title slot 生成附加 portal 控件，提供「适应窗口」、
  Ctrl/⌘+滚轮及按住 Space 再按鼠标左键拖动原生滚动容器平移；通过当前版本
  `data-textpreview-*`、`data-image-preview`、`data-document-zoom-scrollport` 定位原生已渲染元素，
  对原生 image frame 叠加 CSS zoom，不重读文件、复制字节缓存或改变 Blob/SVG 隔离。
- 该定位是版本受控局部契约；深浅主题、不同尺寸图片、resize/卸载及原生缩放交互仍需矩阵验收。
  如果上游改变这些 data 属性，应让检查失败而不是深层 import 或复制 ImageBody。

## 项目 files 增强层

出处：`packages/plugins/files/src/{index.ts,git.ts,shared.ts}`、
`packages/plugins/files/src/client/{nativeFilesAdapter.tsx,paneNavigation.ts,previewTabs.ts,previewTabTitle.tsx,imageZoomOverlay.tsx,tabContextActions.tsx,gitDecorations.ts,FileContextMenu.tsx,treePath.ts}`。

项目插件不再注册 `conversation.view`，不再提供目录/list/read 私有文件服务，也不再复制原生树或预览。
它通过 `sidebar.right.pane.tab` 的 priority shadow 包装 dsh `ui-sidebar-files` 登记项，保留原生
component、store、inject、locale 和原生 `files` guide；文件正文由 `ui-sidebar-documentpreview`
及 `workspaceFiles` 负责。插件不接管 `sidebar.right.tab.guide`，不注册 sentinel 或第二个用户可见文件入口；
「开始」页的工作区文件、新建终端与浏览器入口仍由 dsh 按实际注册的页面类型显示。

- 原生树行的 `data-files-entry` / `data-files-path` 仅用于当前版本的局部增强契约：插件写入 Git
  data marker、aria-label/title，并通过外层事件委托提供右键菜单；不插入或移动原生行 DOM。
- 首次文件点击通过 `sidebarRight.split` 建立目标 pane，再以 `tab.actions.openResource` 打开原生资源；
  单击由 `previewTabs` 维护每个 session + pane 一个斜体临时 tab，下一次单击通过原生 `replaceTab` 替换；
  双击文件或 title slot 使 tab 保留。若空间、用户布局或 pane 生命周期不允许，回退原生打开行为。
- 图片预览保留原生每 tab 的适应宽度/固定档位/Ctrl+滚轮。项目在原生 text title slot 生成
  document.body portal 附加控件，对当前选中 image preview 的 frame 叠加 CSS zoom，提供适应窗口与 Space+鼠标平移；
  不增加图片 RPC。title menu 通过 `sidebar.right.tab.menu.item` 追加「关闭其他」「关闭全部」，先按目标 tab
  的 dockkit DOM 只读核对分栏，只关闭该 pane 的快照，不影响另一个 pane。
- `/files/snapshot` 只接收经过长度/NUL 校验的 sessionId，根来自 live
  `ctx.agents.get(sessionId)?.session.header.cwd`，没有 live Agent 时返回 session-not-found；
  绝不回退 process.cwd。
- Git 使用无 shell 的 `status --porcelain=v2 -z --untracked-files=all -- .`，带
  `-c core.fsmonitor=false`、`--no-optional-locks`、`-C cwd`，并以 `rev-parse --show-prefix`
  把仓库根路径转换回 Session cwd。总预算为 3 秒、status stdout 1 MiB、最多投影 2000 项。
- Git 失败、超时、非仓库或截断只降级 Git 展示，不影响原生树、原生预览或复制路径菜单；Git 状态不承诺实时。
- 右键菜单只有复制绝对路径和复制工作区相对 slash 路径，不提供任何写入或 Git 修改动作。
- 原生读取边界、文件工作区外授权、文本/字节预算、HTML iframe 隔离和非事务性行为跟随上游，
  不能继续宣称旧插件的逐段 symlink 拒绝、工作区 containment 或读取前后身份复核。

## 预览组件

出处：`packages/client/ui-primitives/src/index.ts`、`ReadBlock.tsx`、
`markdown/MarkdownText.tsx`、`markdown/highlight.ts`、`packages/client/web/src/platform.ts`。

ReadBlock 提供行号、窗口提示与复制；MarkdownText 禁止原始 HTML 和不安全协议。
Shiki core 使用 JS regex engine，不带 Oniguruma WASM；部分常用 grammar 预载，其他按需加载，未知语言回退纯文本。
插件 external @deepseek-ai/dsh-client-ui-primitives，复用页面单例，不引入第二套编辑器或高亮库。