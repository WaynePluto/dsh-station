# 05 · 当前进度

只记录当前能力和下一步任务。完成一项立即勾选；自动测试与用户实机验收分开记录。
功能说明见 [插件索引](plugins.md)，测试步骤见 [联调验收](reference/acceptance.md)。

## 已实现

- [x] HTTP/WebSocket 反向隧道，原样转发 Host/Origin，断线退避重连。
- [x] Ed25519 设备注册与认证、一次性注册令牌、停止机器并移除。
- [x] 密码与 TOTP、JWT/refresh cookie、登录限流、会话吊销和安全审计。
- [x] 每台机器运行 dsh、relay、connector，支持远程入口与多机器端口路由。
- [x] dsh 首页 token 交换，远程设置与网页内目录选择。
- [x] 共用标准 DSH_HOME，专属 dsh-station-web profile 与插件产物检查。
- [x] Windows 托盘、浏览器初始化、开机自启动与日志轮转。
- [x] Windows Wails v2 桌面应用：独立模式托管自有后台（launcher `--desktop` 状态行契约、实例锁、随包/系统 Node 发现、Job Object 崩溃回收），attach 开发模式保留；自绘标题栏、托盘（含后台启停/壳自重启恢复）、通知管道（共享令牌握手）与 dsh-station 图标已实现。原生网络/权限隔离（S1.3）仍未完成，不得作为通过安全验收的发行版。
- [x] 桌面独立模式 Windows 实机验收（2026-09-25，隔离数据 + 随包 Node）：双击启动 → 状态持有 → dsh Web UI 完整渲染（token 交换、工作区、模型选择器）；强制杀壳后 Job Object 4 秒回收全部 4 个后台子进程；重复启动被单实例互斥拒绝。托盘交互（右键/双击/启动/停止/重启后台、Explorer 重启恢复）与通知点击定位会话仍待手动验收。
- [x] 首次免设置（D23）：relay 未初始化时 loopback 业务直达 dsh，仅管理页（`/_admin`）与登录页被引导到设置向导；非 loopback 访问仍一律拒绝。已在桌面独立模式实机验证（无管理员首次打开直接进入 dsh）。
- [x] 项目改名 dsh-station（D24）：包名、profile（dsh-station-web）、数据目录（~/.dsh-station）、Go module、图标与用户文案（DSH 工作站）完成迁移；不保留对旧 dsh-remote 数据目录/配置文件名的运行时迁移（一次性事件，用户手动搬移）；relay.db 迁移合并为单一 CREATE 且版本号归一为 1（旧库 user_version 2–4 手工执行 PRAGMA user_version = 1，schema 逐列一致）。
- [x] Linux x64 服务版 zip（原绿色包）与构建检查；win/mac 绿色包随 D22 介质收敛退役。
- [x] 桌面版打包管线（S8 最小集）：`scripts/pack-desktop.mjs` 产出 win NSIS setup + 便携 zip、mac DMG + .app 便携 zip、linux deb + 便携 zip，每平台 setup/portable 两形态、各含 lite/full 变体；完整版附带固定版本 Node（官方 SHA-256 校验清单 `packaging/desktop-node.json`）。Windows 双变体已实打并通过自检；mac/linux 由 CI 原生 runner 构建，实机验收待 S10。统一发布入口 `scripts/release.mjs`：`release` 出本机全部，各平台按变体拆为 `release:win|mac|linux:lite|full` 六个命令（linux 两变体均含服务版 zip），另有 `release:linux-server:lite|full` 只打服务版 zip（任意平台可执行）；CI release 工作流三路原生 runner + 汇总发布。
- [x] manifest 与应用图标。
- [x] 20 个功能组件，按 4 个组合包与 6 个独立包随发行版提供，功能入口见插件索引。
- [x] concise 与 concise-ptc 两个简洁预设，PTC 复用官方工具执行链。
- [x] 固定 YOLO，用户提问保留人工回答。
- [x] dsh 0.1.7 能力吸收：25 个插件包补显示元数据（locale/{en,zh}.json 的 meta + exports/files）；launcher 检测 dsh Bundle 静默跳过诊断并响亮警告；peer 准入与打包约定写入 docs/dsh/plugins.md。
- [x] dsh 0.1.7-rc.1 适配：代码迁移与各冒烟 check 已完成，真实链路验收（登录 → 发消息 → 流式输出）于 2026-09-24 在桌面预览壳内置窗口实测通过（会话日志记录完整轮次，流式经 relay 长连接），复核入口见 [源码依据](02-dsh-facts.md)。
- [x] dsh 0.1.7-rc.2 升级（2026-09-26）：传输/认证/插件契约逐条核对无破坏，favorite-models 补 `ModelDirectoryState.pending` 字段；14 个冒烟 check 与全仓 test/typecheck/build 通过，开发栈实测启动正常。rc.2 下真实链路（登录 → 发消息 → 流式输出）待用户复测。
- [x] 启动体验修复（2026-09-26，二轮）：弹终端与启动慢双双修复。空 cmd 根因是 dev 栈以 DETACHED_PROCESS 拉起、pnpm 的 cmd.exe 只能新建可见控制台，改 windowsHide 隐藏控制台后消失；Wails v2 首次导航完成前不显示窗口且进 relay 只能靠初始导航 302，因此把 relay 提到一切构建/同步之前（launcher 与 dev 栈都重排），等待页改为 relay 自己的重试页（每秒 meta refresh，机器上线 303 进 dsh；本机 loopback 是复刻 dsh 启动页的 splash——HARNESS 字标+进度弧转圈+三元素布局，与 dsh 的「Loading plugins…」页视觉连续，远程访客保留带指引的离线页）；插件快路径以介质内容指纹替代开发栈 forceRefresh。实测：dev:desktop 开窗约 4 秒（原 25+）、机器在线约 12 秒；便携版开窗约 2.1–2.6 秒、dsh 可用约 6.2 秒（dsh 插件树加载为上游成本），全程 0 个控制台窗口。
- [x] 启动并行化与开发链提速（2026-09-26，三轮）：独立模式后台在 `wails.Run` 前启动、与 WebView2 初始化并行（实测 relay 提前约 0.25s，窗口仍卡 WebView2 初始化约 2.2s）；dev 栈入口拆为「运行时准备 + 栈主体」两段（修复全新克隆/依赖变更时 local-config 读到过期 runtime.json 的顺序隐患）；插件构建链按源码指纹跳过（src/配置/清单/lockfile 哈希，26 包约 33ms；未变化时跳过 tsdown 构建与介质复制约 5s）；dev-desktop 直接以 tsx 拉栈并内置 syso 检查（去掉 pnpm 与 desktop:prepare 两层）。attach 模式实测开窗 2.5s。
- [x] 托盘收敛与 splash 对齐（2026-09-27）：托盘移除启动/停止/重启后台三项（退出重开即等价于重启；失败/离线状态页指引改为「请退出并重新打开」，壳自重启路径 shellRestart/spawnShellReplacement 一并删除）；启动 splash 与 dsh 启动页逐像素对齐——转圈外径修正为 24px（dsh 启动页无 box-sizing reset，20px 内容+2px 边框的外径是 24），旋转周期取 1s 与 meta refresh 间隔一致（重载时恰好转满整数圈，相位归零无跳变）。
- [x] 启动速度第四轮（2026-09-28）：壳窗口不再等首次导航完成——Wails 默认等初始导航 302 放行且首个页面加载完才显示窗口（冷启动数秒「点了没反应」），改为 `OnStartup`（WebView2 就绪）立即 `WindowShow`，等待期间展示与 dsh 启动页浅色 page 同值的窗口底色 rgb(249,250,251)；dev:desktop 以 mtime 缓存桌面壳产物替代每次 `go run` 链接（全缓存命中实测 1.7s，selfcheck 缓存命中 0.28s）；splash 的 meta refresh 由每秒改为每 0.2 秒（旋转周期保持 1s：0.2s 重载会截断动画、弧在起始角附近小幅步进，是缩短上线延迟的取舍；远程访客离线页仍为每秒）。Go vet/test、relay typecheck/test、dev:desktop selfcheck 两次（构建/缓存命中）通过；窗口提前显示的实机观感待用户复测。
- [x] 桌面版本机模式（D25，2026-09-28）：独立模式默认只启动 dsh 与项目插件，不常驻 relay/connector；托盘新增「启用远程服务」，launcher 收 `start-remote` 后补起 relay + connector（幂等、退出回收、不记忆状态），本机入口随之切回 relay；本机入口由壳直连 dsh 的 loopback——dsh 登录 token 经 desktop-link 状态行上报（不落日志），初始导航 302 时代发一次 `/?token=` 交换，与 relay 代发的认证语义一致。CLI 与服务版仍全量启动。desktop-link 契约扩展（`remote` phase、`dshToken`/`remoteEnabled` 字段、`start-remote` 命令、`close` 关 stdin）；顺带修复 launcher --desktop 停止后因 stdin 活跃 handle 挂住事件循环不退出的问题（shutdown 显式关闭控制通道）。隔离环境端到端验证通过（状态流无 relay 阶段、直连交换 303、start-remote 后 relay 约 0.9s 监听、connector 退避重连自动注册、stop 后 2.6s 干净退出）；launcher 192 测试、desktop go test、selfcheck 通过。实机验收（托盘启用远程、双主题观感）待用户复测。
- [x] dsh 启动 3~4 秒构成分析（2026-09-28，CDP 外部采样 + 裸 profile 对照，隔离 dev home 实测）：全量 20 插件端口监听 3.46s、token 就绪 3.96s；官方 bundle 裸对照 2.80s/2.89s——项目插件增量 +0.65s/+1.05s。CPU 采样构成（覆盖自约 100ms）：模块解析与文件 IO 约 55–60%（node:fs 21%、package_json_reader 13%、esm resolve/loader/utils 13%、cjs loader 5%、path/url 4%），worker 传输 13.5%，cordis+plugin-loader 约 7%，app-boot 3%。dsh 以散装 node_modules ESM 运行，启动是磁盘 IO bound：NODE_COMPILE_CACHE 实测无收益（3797→3885ms，V8 编译非瓶颈）；不改 dsh 的可压缩空间很小，环境侧仅剩杀软扫描排除（fs 占比高的放大空间），根治要靠上游 bundle 化分发。HTTP 面非瓶颈：SPA 约 1.5MB 资产本机传输全部 <60ms，WebView2/浏览器侧成本是 1.4MB JS 的解析执行。
- [ ] 上游已知问题：dsh 0.1.7-rc.1 停用 yolo-mode Bundle 时 session-controller 重挂载竞态（file-upload Agent resolver 二次注册失败，重启可恢复；concise-mode-check 已按签名精确豁免并标注）。等上游修复后移除豁免。
- [ ] 实机对比验收 dsh 0.1.7 原生 Open In… Explorer（`openWorkspacePath`，等待交接应答、不置前）与 remote-settings 现有通道（spawn 即返回 + 异步置前）：按结果决定收敛或保留置前兼容层（见 [工作区](dsh/workspace.md)）。
- [x] 插件第三方化与组合分发（D20）代码已完成：20 个功能组件分为 4 个组合包与 6 个独立包，首次默认安装；配套升级所有仍安装项并保留 Bundle/组件停用，卸载后不补回，可从发行版 `plugins/` 或开发 `.dev/plugins/` 重装。directory-picker 独立；模型组两个启动屏障组件不可单独停用；connection 注入与模型 HMR 屏障仍为壳级 overlay。10 个 Bundle 的在线停用/启用自动检查与隔离启动已通过，实机界面验收仍见下一项及 [计划](plugin-optional-plan.md)。
- [ ] 插件生命周期实机验收：组合包/组件停用后重启仍保持，卸载后 launcher 不补回，从随附目录重装当前版本；影子型插件（user-message-fork、files）层序生效，并检查深浅主题与中英文界面。
- [x] 插件使用说明归属各包 README，docs 按主题组织且每篇不超过 600 行。

## 优先验收

- [ ] 远程入口重连：取消后「远程入口」页出现重连卡片，一键恢复不需要新令牌；
  对已「停止并移除」本机的入口点重连时降回卡片而不是停机，重新签令牌可再次加入。
- [ ] 从入口唤醒断开的机器：hub「机器」页显示「已断开 · 可唤醒/离线」两种状态，
  点「请求上线」约一个探测周期内机器自动重连并恢复远程访问；离线机器的「移除」
  确认页如实说明送不到对方。
- [ ] 远程入口自动重启：粘命令加入新入口后 dsh 自动重启并信任新地址，远程页面自动恢复；
  「远程入口」页正确显示进行中/完成/失败三种状态；取消远程入口同样触发重启。
- [ ] 手机端完整流程：登录、目录选择、发消息、流式输出、切换会话、设置和提问卡片。
- [ ] 页面保持 30 分钟以上，/api/remote.mux 稳定；断网、切 App、锁屏后恢复。
- [ ] 图片附件上传，并验证目标模型实际接收到图片。
- [ ] 公网 HTTPS/WSS、泛域名证书与共享 cookie 的真实链路。
- [ ] 登录连续失败触发 15 分钟限流，用独立测试账号环境避免锁住日常管理员。
- [ ] Linux 真机解压运行 start.sh；跨平台构建成功不等于目标系统运行验收。

## 插件实机验收

以下保留用户确认项，不因实现或单元测试完成而自动勾选。修改插件后先重启 dsh。

- [x] chat-scroll：消息开头与返回底部均有滚动动效，历史会话首击、底部状态和自动跟随已由用户实机确认。
- [x] files：原生增强基本使用已由用户验收通过；图片缩放、临时预览页签与手机/边界矩阵仍单独待确认。

| 插件 | 待确认 |
|---|---|
| remote-settings | 远程模型与插件设置可以加载、保存；Agent 预设保持唯一原生菜单、无路径复制 UI；Windows 预设目录兼容已由真实 Chrome 确认可见；顶部「在本地打开」已由真实 Chrome 确认走私有通道并出现可见 `xdip` Explorer；两个 Explorer 动作已改为 spawn 成功即响应，工作区私有 RPC 经本机 relay 单次实测约 12 ms 且窗口可见；异步 best-effort 置前已由本机 relay 实测确认 Explorer 成为前台；远程目标及复制预设后的自动动作仍待复测；组件停用后经 relay 访问设置页回到受限形态，重新启用后恢复 |
| copilot-auth | 设备码登录成功，凭据持久化，账号模型可使用 |
| proxy | 跟随环境（默认）、使用插件代理地址、强制直连三态：测试 URL、原生 fetch 模型请求和官方网页抓取按所选策略出网；不以子进程或独立网络库作验收前提 |
| models-catalog | 检查、选择、应用与重启持久化已实机通过，保留了原有 `gpt-6-astra`；GPT-6 Sol 的 Default/Low 真实请求成功，Grok 4.7 的 Default/Low 均由 Copilot 端点返回 400；撤销与其余新增模型仍待实机确认 |
| favorite-models | 输入框筛选、全部失效回退、当前模型不跳转，/model 目录完整 |
| model-capabilities | 协议覆盖生效；图片支持后向实际端点发送图片 |
| turn-retry | 失败重试、停止继续、错误详情；有排队消息时不发送或修改队列；详情弹窗全屏（含深色主题）待实机确认 |
| services | 启动、就绪、日志、停止；重启 dsh 后服务存活并能认领；dock 单行省略与日志弹窗全屏（含深浅主题）待实机确认 |
| terminal | 人类直接输入，默认密码遮罩；忙碌时保留草稿，中断有效；Linux sudo 任务复用系统缓存待实机确认 |
| files | 基本验收通过；「开始」页三入口恢复已修复并有自动回归检查，待重启后实机复测；图片缩放与 Space + 鼠标左键拖动平移、临时预览/双击保留、当前分栏关闭其他/全部方案待实机确认；手机及边界矩阵待验收 |
| chat-scroll | 每个消息按钮只定位自己的消息，深浅主题、减少动态效果与触控尺寸正常 |
| user-message-fork | 子会话只继承前置历史，草稿可编辑，原会话不变 |
| concise-mode | 简洁 PTC 会话多步任务以 run_code 执行，项目工具可用 |
| yolo-mode | 用户提问正常，常驻服务可启动；停用重启后原生权限可恢复 |
| browser-compat | AbortSignal/Promise/Iterator 垫片、能力清单和临时浏览器日志页已实现；仍需 iOS 16.6 真机验证目录选择、启动报错捕获和复制回退 |

## 后续任务

- [ ] 根据手机实测决定移动端布局调整范围。
- [ ] 完善 PWA service worker 与 iOS 添加到主屏幕引导。
- [ ] Web Push：VAPID、锁屏通知及点击跳转会话；与 Windows 桌面通知分开验收。
- [ ] 多用户与邀请流程。
- [ ] 按需增加 OIDC 或 Passkey 登录。
- [ ] Windows 代码签名、自动更新及 Linux/macOS 桌面启动体验。
- [x] 介质矩阵切换完成（D22，2026-09-25 用户决定提前执行，不等 mac/linux 桌面版实机验收）：
  win/mac 仅桌面版（setup + portable），Linux 桌面版 + 服务版 zip，共四个发布端、
  各 lite/full；mac/linux 桌面版实机验收仍按 S10 待办，验收结论不再影响介质矩阵。
- [ ] 决定 `packaging/win-launcher` 托盘程序与遗留 `start.ps1` 的去留：win 服务版退役后
  已无介质携带 exe（syso 资源仍被桌面壳复用），确认无保留价值后整体清理。
