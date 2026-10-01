# DSH 工作站桌面应用（packages/desktop）

Wails v2.16.0 + Go 原生层的桌面壳：托管自己的 Node launcher 后台，内置 WebView，
并常驻托盘。开发桌面与发行桌面共用同一个 launcher 生命周期：

- **独立模式（默认）**：双击即用，默认**本机模式（D25）**——launcher 只启动 dsh 与
  项目插件（不启动 relay/connector）；发现随包载荷（`package/`）与随包/系统 Node 后，
  以 `--desktop` 拉起 launcher。AssetServer 立即 302 到壳的临时 loopback 加载页，显示动画
  与启动阶段；dsh 就绪后，固定顶层交接入口代发 `/?token=` 交换，与 relay 的首页 token
  重定向语义一致。业务流量不走 AssetServer 或加载服务。远程能力由托盘
  **「启用远程服务」** 按需启用：launcher 补起 relay + connector，确认本机转发链路就绪后本机入口切回 relay，
  退出即回收、下次启动仍是本机模式。托盘提供
  **显示 / 在浏览器中打开 → 工作台、远程管理 / 启用远程服务 / 停止远程服务 / 重启远程服务 / 退出**，悬停提示显示
  阶段与本机模式标注。退出（托盘）与崩溃（Windows Job Object KILL_ON_JOB_CLOSE）
  都会回收自有后台进程树。
- **受管开发模式（`pnpm dev:desktop` / `--dev-root <仓库>`）**：同样默认只起 dsh，
  relay/connector 按需启用。壳托管 `dev-desktop-backend.mjs`，准备隔离运行时、按指纹构建插件与
  后端，再运行同一 launcher；不再先启动或自动附着 `pnpm dev`。数据仍为
  `~/.dsh-station-dev` + `~/.dsh-dev`，端口 31809/3180，标题带「 (dev)」，与发行版单实例隔离。
- **显式 attach 诊断（`--attach`）**：仅连接已有开发栈，不管理进程，远程菜单只读。
  `pnpm dev`、CLI 与 Linux 服务版仍默认完整启动。开发/attach 不占用发行版的通知管道，
  桌面通知点击定位不可用，插件回落普通 toast。

> **已知安全边界（S1.3 未完成）：** Wails v2.16.0 的 WebView2 默认自动允许网页权限请求；
> 本壳没有原生网络/导航白名单，外站、iframe、WebSocket 和弹窗未隔离。`--relay-url` 只限定
> **初始入口**。现有 relay/dsh 认证和 Host/Origin 检查不变；原生隔离与安全补丁留待 S1.3
> 单独验收，未通过前不作为通过安全验收的发行版。

## 远程服务与托盘状态

这里的远程服务是 **relay（认证、管理页和转发）+ connector（连接本机 dsh 的隧道）**，
不是 Windows 远程桌面，也不是会话里的 services 插件。已启用仅表示本机转发链路可用，
不代表公网或某个远程入口已连通；外部访问仍需账号、网络与入口配置。

每次右键打开菜单读取最新状态：

| 状态 | 菜单与操作 |
|---|---|
| 发行或开发桌面，本机就绪 | 启用远程服务，可点击 |
| 命令已发送 / 正在启用、停止或重启 | 显示当前操作，三项控制均禁用，避免重复发送 |
| 本机转发链路就绪 | 远程服务已启用，勾选且禁用；停止与重启可点击 |
| 停止完成 | 恢复本机模式，可再次启用；停止与重启禁用 |
| 远程操作失败 | 显示失败并禁用；管理启用失败在加载页就地报错，纯托盘操作失败弹窗；本机 dsh 保留 |
| 工作站尚未就绪 / 后台退出 | 显示等待或不可用，禁用 |
| 显式 attach | 远程服务由开发栈管理，禁用，不发送启动命令 |

三个入口共用 `navigation.go` 的协调器：托盘「启用远程服务」只启用后台；桌面「转到 →
远程管理」和「在浏览器中打开 → 远程管理」**先立即打开加载页，再异步启用**，成功后
自动进入管理页。已有服务直接复用，重复点击不重复启动。

「停止远程服务」先停止 connector，再停止 relay；「重启远程服务」完成上述停止后重新启用并
等待链路就绪。两者均不重启 dsh、不清除账号或远程入口配置。停止会断开远程连接并关闭管理入口，
本机访问地址切回 dsh 直连。**内置窗口仍在远程管理或其他 relay 页面时，自动返回本机工作台**：
发送停止指令前先请求条件跳转，停止旧页面加载并阻止离开期间的点击/提交，用 `location.replace`
替换当前离线入口；停止后迟到的页面导航也会再次检查。直接使用已验证的 dsh 地址及原登录 token，
不经过即将关闭的 relay。原本就在直连工作台时不刷新、保留草稿；外部浏览器不强制切换。
管理页尚未提交的表单不会自动保存。
操作中打开管理页会先等待；若在停止期间明确打开管理页，则停止完成后按该管理请求重新启用。
未启用、工作站未就绪或启用失败时，停止与重启不可用。

加载页是壳按需创建的临时 `127.0.0.1` 随机端口服务：32 字节随机能力路径、只读状态接口、
CSP 哈希脚本与连续转圈；单次同源 `/events` 流推送安全状态，无定时查询、启用 HTTP 接口或 dsh token。
完成后保留 30 秒，最长 10 分钟，
退出壳立即关闭。手动输入尚未监听的 relay 地址不能唤起后台。

launcher 最多等待 20 秒，以现有本机首页确认 relay → connector → dsh，不读正文、不跟随
令牌重定向。**启用阶段失败仅清理本次 relay/connector，保留 dsh、会话和控制通道**；
不自动重试，失败后退出重开可再启用；正常停止后可直接再次启用。
壳等待启用/停止最多25秒，重启最多45秒（包含停止与重新探测），管理加载页最多等待45秒。
已就绪后的 connector 致命退出（含设备被移除）仍遵守整套
停机的安全语义；CLI/服务版不变。

## 命令

```powershell
pnpm dev:desktop                 # 受管开发桌面：默认本机 dsh，远程按需；保留壳与构建缓存
node scripts/dev-desktop.mjs --attach  # 显式附着已有 pnpm dev 栈；不接管进程
node scripts/dev-desktop.mjs -- --selfcheck  # 只检查参数，不创建窗口；避免 pnpm 版本间参数转发差异
pnpm release:win:lite            # 只打 Windows 桌面轻量版（setup + 便携 zip；不下载随包 Node）
pnpm release:win:full            # 只打 Windows 桌面完整版（首次下载随包 Node，之后走缓存）
pnpm release:mac:lite / :full    # 同理，macOS 桌面介质（DMG + .app 便携 zip）
pnpm release:linux:lite / :full  # Linux 桌面介质（deb + 便携 zip）+ 对应变体的服务版 zip
pnpm release:linux-server:lite / :full  # 只打 Linux 服务版 zip（任意平台可执行）
```

每个桌面平台分 setup（安装包）与 portable（便携 zip）两种形态（D22），命令按平台 ×
变体拆分。统一发布入口 `scripts/release.mjs`（`pnpm release` = 本机桌面版双变体 +
Linux 服务版）构建一次后串起 `pack-desktop.mjs` 与服务版打包。打包脚本只能在目标平台
上构建（Wails 依赖系统 WebView/CGO，不支持交叉编译）；mac/linux 桌面包由 CI 的原生
runner 产出。完整版的随包 Node 按 `packaging/desktop-node.json` 的官方 SHA-256 下载
验收，默认走 nodejs.org（GitHub CI）；国内本地打包设
`DSH_STATION_NODE_DIST_MIRROR=https://npmmirror.com/mirrors/node` 走镜像。
独立模式自检：

```powershell
dsh-station.exe --selfcheck          # 校验载荷发现（package/ + runtime/node 或系统 Node）
dsh-station.exe --app-dir <目录> --selfcheck   # 开发时校验自定义载荷目录
```

## 桌面 ↔ launcher 控制契约（S2 冻结的最小集）

launcher 以 `--desktop` 运行时（`packages/launcher/src/desktop-link.ts`）：

- 状态：stdout 每行 `@@DSH_STATION {json}`（protocol 1；phase = config/plugins/dsh/relay/
  remote/ready/restarting/stopping/failed，urls.local/admin/dsh，adminReady，dshToken
  （本机模式下壳代发 `/?token=` 交换，不落日志），remoteEnabled、remoteState、remoteError）。
  remoteState 为 idle/starting/ready/stopping/failed；启停中 `phase: remote`（dsh 信任重启时保留 restarting），真实就绪才置
  remoteEnabled=true 并切换 urls.local。启用失败回到 `phase: ready`，保留 dsh 直连地址，
  remoteState=failed 与错误原因独立于本机状态。停止成功回到 idle；重启走 stopping→starting→ready，
  不经过中间 idle。Go 镜像在 `backend.go`，由两端测试锁定。
- 来源握手：Wails 初始化前最多等待 5 秒取得 config 阶段的无凭据地址，不等待插件构建。
  只接受规范的 dsh/relay loopback URL，固定两者的精确 origin；后续状态不得换端口。
- 控制：stdin 逐行 JSON 命令：`{"type":"stop"}` 停止整套后台；
  `{"type":"start-remote"}`、`{"type":"stop-remote"}`、`{"type":"restart-remote"}`
  仅控制 relay + connector。壳先占位禁用菜单，停止/重启必须收到 stopping 应答后才接受完成态；
  写入失败、短写和超时不能假报成功。
- 实例锁：home 下 `launcher.lock`（pid 存活检查），先于插件同步与数据库写入获取。
- 通知管道：桌面壳监听 `127.0.0.1:30810`，首行必须携带共享令牌
  （桌面壳生成 `DSH_STATION_NOTIFY_TOKEN`，经 launcher → dsh 环境传给 notify 插件）；
  无令牌的客户端在握手前被拒绝。插件侧见 `packages/plugins/notify/src/desktop.ts`。

## 自绘标题栏（无边框）

窗口为 Wails `Frameless`，每次顶层导航后经 `OnDomReady` 向页面注入一条 36px 自绘标题栏
（`chromebar.go`）：logo + DSH 工作站 + 页面/应用 + ─ ❐ ✕；主题跟随页面 body 背景色。
标题栏观察管理页与原生dsh的主题属性，并响应系统配色及页面恢复可见；不观察整个DOM子树。
脚本带 `location.origin` 守卫，只在握手确认的 dsh/relay 页面注入；资产页和临时加载页不获得绑定。
`转到` 菜单含工作台/远程管理（页面内切换）与「在浏览器中打开」回退；`工作站` 菜单含
重新加载、隐藏到托盘、退出与「关于 DSH 工作站」（与状态页「远程管理」、托盘子菜单用词一致）。
「关于」弹出原生信息对话框，显示工作站/dsh/Node（随包或系统）/Wails/Go/操作系统版本
（`about.go` 首次打开时按需解析并缓存：载荷包根与 dsh 的 package.json、实际 node
可执行文件、Go 构建信息；attach 模式没有托管载荷，相应字段显示未知，Node 回退系统 PATH）。
窗口控制是「业务页零 Go
bindings」的书面例外：`Chrome` 绑定只有 Minimize/ToggleMaximize/Hide/Quit/
OpenHome/OpenAdmin/OpenExternalHome/OpenExternalAdmin/ShowAbout 九个无参方法，管理方法走同一按需
启动链。`BindingsAllowedOrigins` 使用握手中的 dsh/relay 精确来源，无通配符、不硬编码端口，
不接受任意 URL/命令/文件参数。Wails v2.16 的 `window.go` 只存在于资产服务器主页面，
因此标题栏经 WebView2 `window.chrome.webview.postMessage('C'+{...})` 发送固定格式的绑定调用；
升级 Wails 必须复核。

任务栏/Alt+Tab 图标经 `WM_SETICON` 使用 exe 资源；`logo.svg` 是
`packaging/dsh-station.svg` 的提交镜像（go:embed 不能引用模块外文件），
`chromebar_test.go` 防止两者漂移。外部浏览器 Cookie 不与内置 WebView 共用。

## 启动引导与后台状态页

壳在 `OnStartup`（WebView2 就绪）立即显示窗口；开发和发行桌面使用同一加载流程。
壳首次编译、Node 地址握手（最多 5 秒）与 WebView2 自身初始化仍有耗时，不承诺零延迟开窗。
插件准备与 dsh 启动不阻塞页面响应。

- 受管模式（`startup_loading.go`）：初始资产请求立即 302 到随机能力保护的 loopback 加载页。
  页面马上显示 HARNESS、连续转圈和准备运行环境/插件/启动 dsh 的阶段，不整页刷新。
  项目加载页只兜底后台等待：单次 HTTP 流订阅状态，收到 ready 立即导航同源 `/enter`，由 Go 返回无正文
  302 代发 dsh token，随后交换 cookie 进入真实 dsh；HTML/状态 JSON 不包含 token。
  此后由 dsh 原生 Loading plugins/工作台完全接管，不保留项目 overlay，不等动画完成或强制延时。
  原生加载若在首绘前结束仍可能看不到；已可用的本机 dsh 也不会被远程启用阻挡。
  全程不提前启动 relay。后台失败或等待超过 150 秒就在页面内显示固定安全提示；
  恢复方式仍为退出重开。加载服务复用管理加载页的连接、来源与生命周期限制。
  仅加载服务自身创建失败时停止后台并用 `statuspage.go` 输出资产故障页。
- Wails 资产 origin 的 HTML 仍不能自行跳转 dsh；先进入 `127.0.0.1` 加载文档后，
  再以同站顶层导航交接，不修改 Host/Origin 或放宽 fence。加载页不获得 Go bindings。
- attach 模式（`bootstrap.go`）：同样持有到 relay 监听再 302；超时渲染开发栈指引页
  （查 pnpm dev 终端或 dev-stack.log）。托盘可操作项只有显示 / 在浏览器中打开 / 退出，
  远程服务项只显示「由开发栈管理」。外部栈由启动它的终端管理，不由壳接管。
  默认 dev:desktop 不再走此分支。

首次插件准备使用有界的 8 路文件复制，后续未变化的启动仍走原快路径。复制或安装中断后，下次启动
会重新准备，不把半成品当成成功，也不补回用户已经卸载的插件。无需手动删除标准 `DSH_HOME`。
开发版额外复用运行时配置的成功校验摘要；每次仍重读根清单、workspace 与 lockfile 的完整字节，
变化即重新校验，缺失产物仍重建。runtime 准备合并到现有可取消的准备子进程，不影响停止/失败回收。
本轮仅加速开发入口，发行版沿用第一轮实现；数据见 [开发准备优化](../../docs/reference/startup-development-optimization.md)。

后台日志的 `插件准备耗时 [阶段]: Nms` 仅表示对应阶段完成：

| 阶段 | 内容 |
|---|---|
| `check` | 介质、版本、指纹与快路径检查 |
| `plugin-copy` | 插件本体与组合包组件复制 |
| `dependency-resolve` | 运行时依赖闭包与共享模块定位 |
| `dependency-copy` | 依赖文件复制与既有共享链接建立 |
| `install` | 官方插件管理器安装/升级调用 |
| `state-write` | 选择/指纹状态提交与中断标记清理 |

缓存命中时只输出 `check`；失败的阶段不会输出完成计时。这些日志不是 dsh 内部插件加载进度，
不改变加载页文案或 ready 判断。Windows 对照结果见 [首次准备优化](../../docs/reference/startup-copy-optimization.md)。

进入 relay 后，本机 loopback 启动 splash 保留 HARNESS 字标、24px 转圈和三元素布局。
转圈固定弧长、1 秒匀速循环，不模拟进度；CSP 哈希限定的固定脚本串行探测当前同源 URL，
每次完成后等待 200ms，单次请求最多 3 秒，等待期间不重载文档。探测不跟随或读取 token
重定向，就绪后重载当前页，由原有顶层导航完成认证交换；禁用脚本时才每秒整页刷新兜底。
远程访客仍得到无脚本、每秒刷新的离线指引页，登录与首次设置维持原有CSP。

管理页不再提供独立主题切换器，单向跟随当前工作站的dsh原生主题。壳级插件只读原生已提交偏好，
将三态投影到工作站home；relay通过有界文件读取与事件流更新页面，不改dsh配置、不轮询主题。
管理页CSP仅允许固定主题脚本哈希和同源连接；登录/首次设置的独立外观选择保留。
暂时断连保留上次颜色，无有效初值时跟随系统。插件或壳升级后需退出并重开工作站。

窗口出现不再等待 relay 监听或首次导航完成。失败状态页不携带任何凭据。

## 验证

常规：`go -C packages/desktop test ./...`、`go -C packages/desktop vet ./...`、
`pnpm --filter @dsh-station/launcher test`（含开发脚本测试）。
可选真后端验证先准备开发 runtime/构建产物，再在 PowerShell 设置
`$env:DSH_STATION_INTEGRATION='1'`，执行
`go -C packages/desktop test -run '^TestManagedRemoteIntegration$' -v`，结束后删除该环境变量。
测试使用临时 home，覆盖默认无 relay、启动加载页立即响应、顶层 token/cookie 交换、
远程启用成功、stop→start→restart→stop 的真实端口回收与原 dsh token/首页持续可用，
以及端口冲突后 dsh 存活。
`backend_events_test.go`、`loading_stream_test.go` 覆盖原子订阅、广播、流式安全/期限/回收；
`loading_client_test.go` 用 Node 执行实际页面客户端（单帧8KiB、UTF-8拆帧、取消与即时终态）。
隔离 WebView2 已验证一次 `/events`、零 `/status` 并成功进入真实 dsh；测量与边界见
[启动时序](../../docs/reference/startup-timing.md)。原生菜单状态/HTTP 自动测试不替代完整交互验收。

停止时的内置导航另有隔离 WebView2 回归：设置 `$env:DSH_STATION_WEBVIEW_INTEGRATION='1'` 后执行
`go -C packages/desktop test '-tags=production,wv2runtime.error' -run '^TestRemoteFallbackWebView$' -v`，
结束后删除该环境变量。测试使用隐藏的独立窗口、临时用户数据目录与模拟 HTTP 端点，验证管理页返回、
同站认证交换、返回后按钮响应，以及直连工作台不重新加载/不丢草稿，不接管日常实例。

## 平台

- Windows x64：WebView2 运行库（`wv2runtime.error` 构建标签禁止自动下载安装）；
  缺失时明确报错，不静默回退。
- macOS arm64 / Linux x64：编译依赖系统 WKWebView / WebKitGTK；CI 产物未实机验收
  （S10），不得宣传为已通过。非 Windows 平台暂无常驻托盘（`tray_stub.go`），
  关闭窗口即退出并停止自有后台。
