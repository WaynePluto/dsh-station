# DSH 工作站桌面应用（packages/desktop）

Wails v2.16.0 + Go 原生层的桌面壳：托管自己的 Node launcher 后台，内置 WebView，
并常驻托盘。两种运行模式：

- **独立模式（默认）**：双击即用，默认**本机模式（D25）**——launcher 只启动 dsh 与
  项目插件（不启动 relay/connector）；发现随包载荷（`package/`）与随包/系统 Node 后，
  以 `--desktop` 拉起 launcher，AssetServer 常驻「启动/故障状态页」，dsh 就绪且 token
  上报后对根路径一次 HTTP 302 直连 dsh 的 loopback（携带 `/?token=` 代发交换，与 relay
  的首页 token 重定向语义一致）；业务流量不走 AssetServer。远程能力由托盘
  **「启用远程服务」** 按需启用：launcher 补起 relay + connector，本机入口切回 relay，
  退出即回收、下次启动仍是本机模式。托盘提供
  **显示 / 在浏览器中打开 → 工作台、远程管理 / 启用远程服务 / 退出**，悬停提示显示
  阶段与本机模式标注。退出（托盘）与崩溃（Windows Job Object KILL_ON_JOB_CLOSE）
  都会回收自有后台进程树。
- **attach 开发模式（`--attach`）**：附着到已运行的 31809 开发栈（独立 home
  `~/.dsh-station-dev` + `~/.dsh-dev`，可与发行版实例同时运行），不管理它的进程；
  窗口与自绘条标题带「 (dev)」后缀以便和发行版实例区分；无通知管道令牌，
  桌面通知点击定位在开发模式不可用（插件回落普通 toast）。

> **已知安全边界（S1.3 未完成）：** Wails v2.16.0 的 WebView2 默认自动允许网页权限请求；
> 本壳没有原生网络/导航白名单，外站、iframe、WebSocket 和弹窗未隔离。`--relay-url` 只限定
> **初始入口**。现有 relay/dsh 认证和 Host/Origin 检查不变；原生隔离与安全补丁留待 S1.3
> 单独验收，未通过前不作为通过安全验收的发行版。

## 命令

```powershell
pnpm dev:desktop                 # attach 开发模式（31809 栈未运行时自动拉起开发栈；壳产物按源码 mtime 缓存、未变化不重新链接，WebView2 就绪即开窗，等待期显示窗口底色与 relay 进度页；壳退出时停掉自己拉起的栈，外部启动的栈不受影响）
pnpm dev:desktop -- --selfcheck  # 只检查参数，不创建窗口
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
  （本机模式下壳代发 `/?token=` 交换，不落日志），remoteEnabled）。Go 侧镜像在
  `backend.go`，两端由测试锁定（`tests/desktop-link.spec.ts` / `backend_test.go`）。
- 控制：stdin 逐行 JSON 命令：`{"type":"stop"}` 与
  `{"type":"start-remote"}`（D25 按需启用 relay + connector，幂等）；重启由桌面壳停止后重新拉起。
- 实例锁：home 下 `launcher.lock`（pid 存活检查），先于插件同步与数据库写入获取。
- 通知管道：桌面壳监听 `127.0.0.1:30810`，首行必须携带共享令牌
  （桌面壳生成 `DSH_STATION_NOTIFY_TOKEN`，经 launcher → dsh 环境传给 notify 插件）；
  无令牌的客户端在握手前被拒绝。插件侧见 `packages/plugins/notify/src/desktop.ts`。

## 自绘标题栏（无边框）

窗口为 Wails `Frameless`，每次顶层导航后经 `OnDomReady` 向页面注入一条 36px 自绘标题栏
（`chromebar.go`）：logo + DSH 工作站 + 页面/应用 + ─ ❐ ✕；主题跟随页面 body 背景色。
脚本带 `location.origin` 守卫，只在 relay 页面注入（独立模式的状态页不注入）。
`转到` 菜单含工作台/远程管理（页面内切换）与「在浏览器中打开」回退；`工作站` 菜单含
重新加载、隐藏到托盘与退出（与状态页「远程管理」、托盘子菜单用词一致）；窗口控制是「业务页零 Go
bindings」的唯一书面例外：`Chrome` 绑定只含 Minimize/ToggleMaximize/Hide/Quit/
OpenExternalHome/OpenExternalAdmin 六个无参方法，`BindingsAllowedOrigins` 仅追加本机
relay origin。Wails v2.16 运行时（`window.go`）只存在于资产服务器主页面，relay 页面上
不可用，因此自绘条经 WebView2 `window.chrome.webview.postMessage('C'+{...})` 直接发送
绑定调用——该消息格式固定于 Wails v2.16.0，升级 Wails 必须复核。独立模式下 relay 端口
若非默认 30809，自绘条的「在浏览器中打开」会静默失效（托盘入口不受影响）：
Go 不复制 launcher 的配置解析，BindingsAllowedOrigins 又无法运行时修改。

任务栏/Alt+Tab 图标经 `WM_SETICON` 使用 exe 资源；`logo.svg` 是
`packaging/dsh-station.svg` 的提交镜像（go:embed 不能引用模块外文件），
`chromebar_test.go` 防止两者漂移。外部浏览器 Cookie 不与内置 WebView 共用。

## 启动引导与后台状态页

Wails v2 在首次导航完成前不显示窗口，而进入 relay 只能靠这次初始导航（页面自己发起的
跳转会被 relay 的 cross-site 检查拒绝），因此两条模式都「持有」初始请求：

- 独立模式（`statuspage.go`）：后台在 `wails.Run` 之前就启动，与 WebView2/窗口初始化
  并行（与 attach 模式对齐：那边编排器先拉栈再起壳）。launcher 先启动 relay，其端口
  开始监听即对 `/` 发 302；之后 dsh/connector 就绪前的等待由 relay 自己的重试页承担
  （每秒自动重试，机器上线后 303 进 dsh；loopback 请求得到的启动 splash 复刻 dsh 自己
  的启动页——同样的 HARNESS 字标、20px 进度弧转圈与三元素布局，交接时视觉连续，像是
  同一页换了底部文字；远程访客仍得带指引的离线页）。后台失败或超过 150s 上限才渲染状态页：阶段、原因提示、本机入口与远程
  管理链接（仅 loopback 地址）；恢复方式是退出并重新打开（新壳取得新的初始导航），
  托盘不提供后台启停——退出重开即等价于重启。
- attach 模式（`bootstrap.go`）：同样持有到 relay 监听再 302；超时渲染开发栈指引页
  （查 pnpm dev 终端或 dev-stack.log）。托盘只有显示 / 在浏览器中打开 / 退出：
  后台启停已整体移除，开发栈本就属于 dev:desktop 编排器或外部终端
  （查 pnpm dev 终端或 dev-stack.log）。编排脚本 `dev-desktop.mjs` 因此不再等机器在线。

窗口的实际出现时刻 ≈ max(WebView2 初始化, relay 监听)（实测便携版约 2.2 秒，WebView2 初始化约占 2 秒）。状态页不携带任何凭据。

## 平台

- Windows x64：WebView2 运行库（`wv2runtime.error` 构建标签禁止自动下载安装）；
  缺失时明确报错，不静默回退。
- macOS arm64 / Linux x64：编译依赖系统 WKWebView / WebKitGTK；CI 产物未实机验收
  （S10），不得宣传为已通过。非 Windows 平台暂无常驻托盘（`tray_stub.go`），
  关闭窗口即退出并停止自有后台。
