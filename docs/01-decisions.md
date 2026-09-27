# 01 · 需求与决策

## 1. 产品目标

通过手机或异地电脑的浏览器操作目标机器上的 DeepSeek Harness（dsh），查看进度、发送指令和回应提问。
文件读写与命令执行发生在目标机器上；入口机器负责认证和转发。
单机使用不要求部署公网服务器。默认固定 YOLO 自动执行，用户提问仍需人工回答。

## 2. 已确认的决策

| 编号 | 决策 | 依据 |
|---|---|---|
| D1 | 使用官方 dsh 运行时 | 用户指定，复用其 Agent、工具和会话能力 |
| D2 | 不 fork、不改 dsh 源码 | 扩展通过插件完成，升级时核对依赖的上游契约 |
| D3 | 反向隧道只搬运 HTTP/WebSocket 字节 | relay 不解析 dsh 业务协议；首页 token 重定向是唯一例外 |
| D4 | 复用 dsh Web UI | 会话、模型、设置等界面由 dsh 与插件提供 |
| D5 | 轻量版与服务版 zip 使用用户安装的 Node，不携带 Node 二进制；仅桌面版完整版附带固定版本 Node 运行时 | Node 最低版本为 22.19.0；内置 Node 版本纳入固定版本清单 |
| D6 | 提供双击启动器，不自动打开浏览器 | Windows 托盘菜单和终端输出提供访问入口 |
| D7 | 每台机器独立 origin，域名部署使用子域名 | dsh 使用绝对 `/api`，不支持挂子路径 |
| D8 | 浏览器流量经过 relay | 所有非 loopback 访问统一认证 |
| D9 | 隧道使用 Node 与 ws，不要求额外网络客户端 | 保持部署组件精简 |
| D10 | 移动端增强以实机验收为依据 | manifest 与图标已具备，其余见路线图 |
| D11 | 优先成熟第三方依赖 | 保持直接依赖版本固定 |
| D12 | 声明 `trustedHosts`，relay 原样转发 Host/Origin | 使用官方 browser-trust fence；远程设置由插件提供 |
| D13 | dsh 作为 launcher 的 npm 依赖分发 | 绿色包保留真实 node_modules，用户不必另装 dsh |
| D14 | 共用标准 DSH_HOME，仅隔离 dsh-station-web profile | 共享 settings、credentials、sessions 与用户全局 patch |
| D15 | 非 loopback 浏览器请求统一登录 | 仅 loopback socket 与 loopback Host 同时成立才免登录 |
| D16 | 每台机器运行 dsh、relay、connector | 任意机器可作为远程入口，关系单向且每机最多一个入口 |
| D17 | 扩展放在 `packages/plugins`，各包自行说明 | 功能组件通过 4 个组合 Bundle 与 6 个独立 Bundle 第三方分发；connection 注入和模型 HMR 启动屏障保留在同一个壳级 overlay |
| D18 | Linux systemd 以个人普通用户运行整套 dsh-station | 默认 `~/.dsh-station` 保存 relay 运行数据，`~/.dsh` 保存官方 dsh 数据；普通操作使用用户权限，管理员操作由用户在交互终端输入 sudo，保留系统缓存；不主动建立 root shell |
| D19 | 公网使用泛子域名，本机保留 loopback，裸域名只进管理入口 | `https://<机器名>.<域名>` 保持每台机器独立 origin；`http://127.0.0.1:<端口>` 始终是本机入口；域名模式默认关闭成员端口，新增机器不改 DNS、证书或 TLS 反代；域名模式的公网 Cookie 与本机 HTTP 的 host-only 辅助 Cookie 分开 |
| D20 | 功能插件作为随发行版提供、首次默认安装的第三方插件分发 | 20 个功能组件组合为 4 个组合包与 6 个独立包；launcher 配套升级所有仍安装的包并保留 Bundle/组件停用状态，用户卸载后不自动补回，可从发行版 `plugins/` 或开发目录 `.dev/plugins/` 重装。网页目录选择独立分发；模型组两个启动屏障组件不可单独停用；connection 注入与稳定的模型启动屏障仍是壳级常驻 overlay。详见 [插件分发计划](plugin-optional-plan.md) |
| D21 | 发行版本分为轻量版（lite）与完整版（full）：lite 不内置 Office 预览引擎，full 把引擎直接打进安装包，不做按需下载 | 两者是同一个程序的两个体积档；引擎压缩后每平台约多 58～121 MB，轻量版面向不需要 Office 预览的用户 |
| D22 | 发行介质收敛为四个发布端：win/mac/linux 桌面版（每端 setup 安装包 + portable 便携 zip 两形态）与 Linux 服务版 zip（原绿色包，始终用系统 Node）；win/mac 不再提供绿色包。发布命令按发布端 × 变体拆分：`release`（本机全部）、`release:win\|mac\|linux:lite\|full`（linux 两变体均含服务版 zip，CI 的 linux 作业靠一条命令出全部 Linux 介质）与 `release:linux-server:lite\|full`（只打服务版 zip，可从任意平台交叉打包），统一入口 `scripts/release.mjs` | 会解压绿色包的用户必有 Node 或能自装；需要开箱即用的用户走桌面版，其中完整版附带 Node。原计划按平台实机验收后切换，2026-09-25 用户决定提前执行；mac/linux 桌面版实机验收仍按 S10 推进，不影响介质矩阵 |
| D23 | 首次使用不强制创建管理员：本机 loopback 的 dsh 页面按免登录语义直接可用；只有首次打开管理控制台（远程能力入口）时才引导创建账号、密码与 TOTP。未初始化期间非 loopback 访问仍一律拒绝 | 远程只是工作站的一个能力，不使用远程就不该被设置向导挡住；认证边界不变（非 loopback 必须等设置完成且登录） |
| D24 | 项目名 dsh-station（用户文案「DSH 工作站」）：数据目录默认 `~/.dsh-station`，dsh profile `dsh-station-web`；`remote` 一词只指远程能力（远程入口、remote-* 插件、/api/remote.mux） | 不保留对旧 dsh-remote 数据目录/配置文件名的运行时迁移（改名是一次性事件，历史数据由用户手动搬移）；relay.db 迁移合并为单一 CREATE 且版本号归一为 1，旧库（user_version 2–4，schema 与 v1 逐列一致）手工执行 PRAGMA user_version = 1 即可继续使用 |

## 2.05 术语

中文用户文案统一使用下表。代码标识符保持现有英文名称。

| 概念 | 用户可见名称 |
|---|---|
| 提供浏览器地址的机器 | 入口机器 |
| 该机器提供的访问地址 | 远程入口 |
| 挂在入口机器上的目标 | 通过 X 开放的机器 |
| 建立开放关系 | 把 X 挂到 Y 上；通过 Y 对外开放 |
| 目标机器自己取消关系 | 取消远程入口 |
| 入口机器取消目标资格 | 停止 X 并移除 |
| DNS 标签，如 pc2 | 机器名 |
| 页面中的当前机器 | 机器真名，如 pc1 |
| 发行版本的两种配置 | 轻量版（lite）、完整版（full） |
| Linux 绿色包 zip | 服务版 |

`hub`、`MembershipHub`、`membership.json`、`slug`、`revoke` 等代码与 CLI 名称保持不变。
“吊销”用于登录会话和令牌。对机器使用“停止并移除”，因为它会令目标 connector 致命退出，
launcher 随之停掉 dsh 与 relay；恢复需要重新签发注册令牌。

> 每台机器都跑着自己的 dsh，AI 读写文件、执行命令都发生在那台机器上。
> 打开 pc2 的页面就是指挥 pc2；pc1 只负责转发。
> 把 pc2 挂到 pc1 上，表示可以从 pc1 的地址打开 pc2，反方向不成立。

## 2.1 拓扑与路由

relay 按以下顺序解析目标：子域名 → 持久化的每机器端口 → `directSlug`。
裸 `publicDomain` 只提供统一管理入口并跳转到 `/_admin`，不指向任何 dsh；子域名适合公网 HTTPS；每机器端口适合无域名的局域网；`directSlug` 指向入口机器自己的 dsh。
域名模式下 `directSlug` 仍由本机 loopback 地址提供，使用 `http://127.0.0.1:<relay-port>`，不改变本机控制台和 dsh 的访问方式。

`directSlug` 路由也经过 connector 控制信道，因此 relay 在 `serve` 启动时把本机挂到它自己
身上：membership.json 中写入带 `selfManaged` 标记的自挂条目并附一次性注册令牌，connector
拨 loopback 注册后，本机与局域网地址才能直达这台机器的 dsh。自挂条目由 relay 维护
（每次启动刷新；「取消远程入口」后由 relay 重建而不是清空），不属于操作员设置的远程入口，
launcher 的 banner 与 `--trusted-host` 都按「没有远程入口」处理它。

「取消远程入口」不会失忆：relay 把当时的 hub（去掉已用的一次性令牌）保存为 membership.json
的 `lastHub`，「远程入口」页据此提供一键「重新连接」。恢复不需要令牌——设备密钥仍在两侧，
hub 还认识这台机器时 connector 直接用密钥认证。重连被拒（设备已被入口「停止并移除」）时
connector 把条目降回 `lastHub` 并继续运行，而不是让整台机器停机；只有曾经认证成功后被吊销
仍整体退出，那正是「停止并移除」的既定语义。重新连接或设置新入口都会清掉 `lastHub`。

断开（含本机自挂之外没有入口）的机器以 `PROBE_INTERVAL_MS`（60 秒）周期向 `lastHub` 发送
带 probe 标记的唤醒探测：不承载流量、不进在线名单；入口有操作员「请求上线」（devices 表的
`wakeup_requested_at`，24 小时过期）时回 `reconnect-offer`，connector 恢复 `lastHub` 并由
launcher 自动重启 dsh。这补齐了入口与被断开机器之间唯一的唤醒通道，也让「机器」页能区分
「已断开·可唤醒」（近期有探测）与「离线」（探测也消失——关机或挂去了别的入口，无法区分）。
机器已「停止并移除」或 lastHub 被拒绝时探测停止并遗忘该入口。

端口不在 cookie 作用域内，因此同一主机不同端口共享登录态；配置 Cookie Domain 时子域也共享登录态。
域名模式的公网会话使用 `Domain=.<域名>` 的 Secure Cookie；真实 loopback 请求使用独立的非 Secure、host-only 辅助 Cookie，确保本机 HTTP 的 CSRF、主题和管理表单不依赖公网会话。
系统按同一管理员控制这些机器设计，不将端口当作用户隔离边界。

转发到目标 dsh 的 Host 是浏览器访问的机器 authority，目标 dsh 必须通过 `--trusted-host` 信任它。
域名模式下，connector 的控制地址使用公网裸域名（如 `wss://dsh.example.com`），目标 dsh 信任对应机器子域名（如 `pc2.dsh.example.com`）；从入口机器本机控制台签发命令时也必须生成这个可达的公网地址，不能把 `127.0.0.1` 打进命令。
入口地址变化后由 launcher 自动重启目标 dsh（连带 connector 上报新 token，relay 不动），并把进度写进
dsh-restart-status.json 供「远程入口」页展示；不需要操作员重启整个程序。

## 2.2 Profile 与插件装载

`dsh-station-web` profile 初始只写入 `dsh-base` 与 `dsh-web-app`。功能扩展随后通过 dsh
官方插件管理器安装为第三方 Bundle；`plugin-catalog.json` 是分发包名、组件、顺序和源码位置的
唯一清单。发行版从根目录 `plugins/` 安装，开发栈从 `.dev/plugins/` 安装，安装逻辑相同。

20 个功能组件对外分发为 10 个包：远程体验、模型增强、会话增强、开发工具 4 个组合包，
以及网页目录选择、出网代理、简洁模式、全局提示词、文件浏览、固定 YOLO 6 个
独立包。组合包是安装、卸载与配套升级单位；组件仍保留独立行，除模型增强中的
models-catalog 与 model-capabilities 共同参与 `llm-pi-ai` 启动屏障、不可单独停用外，
其他无硬启动耦合的组件可在插件详情中单独停用。网页目录选择必须静态覆盖原生服务，故独立分发。

首次提供某个分发包时 launcher 默认安装并启用。以后每次 dsh-station 配套升级都会升级所有仍在
profile dependencies 中的随附包，包括停用的 Bundle；Bundle 是否选中以及组件行的 disabled
状态保持不变。用户在官方插件管理器卸载包后，launcher 只记录该选择，不自动补回；需要恢复时，
在 dsh「添加插件」中选择当前发行版 `plugins/<目录>` 或源码开发环境 `.dev/plugins/<目录>` 的
绝对路径，再启用该 Bundle。Windows 上若介质与 profile 跨盘，launcher 提供的 pnpm 代理会把这次
本地安装映射到 profile 内的同盘介质镜像；页面输入和安装日志仍使用用户选择的 `.dev/plugins` 路径。
既有 profile 中属于当前清单的组件迁移时保留 Bundle 与组件停用选择，已明确卸载的
files 不会被重新安装。清单外的既有插件不会由 launcher 自动卸载；需要清理时应由用户在
dsh 官方插件管理器手动操作，不触碰项目外的 DSH_HOME。

concise-mode Bundle patch 内联声明两个 `@deepseek-ai/dsh-agent-preset` 行，不插入 locator entry，
也不使用 preset root；子代理深度交给 dsh 原生设置（默认 1，可由用户调整）。
宿主或浏览器构建产物缺失时，介质生成或启动必须响亮失败。

壳内唯一保留的 `--patch` overlay 是 remote-privileged 包。它随 launcher 常驻传入、不可停用，
既为 connection 注入 webRuntime/webServer，作为所有插件 RPC 通道的地基，也固定
`llm-pi-ai` 的模型启动屏障：模型增强随进程启动时由两个组件完成真实初始化后提供屏障，未随
进程启动时由壳提供占位屏障。屏障挂在 root fiber 上，使运行中停用模型增强无需热重启
`llm-pi-ai`；功能组件和界面仍随 Bundle 正常卸载。该 overlay 不进入第三方插件安装、停用或卸载生命周期。

出网代理默认跟随 dsh 环境策略，也可选择插件代理地址或强制直连；覆盖原生 fetch 和官方
网页抓取，不承诺统一接管子进程或独立网络库。

远程浏览器设置由 remote-settings（ownsHost）注入开放；它不替代 relay 认证，
不修改请求头。Agent 预设的打开目录动作保持 dsh 原生行为，不增加同机判定或路径复制 UI。
顶部「在本地打开」沿用原生 Open In… 的浏览器 cwd 能力；Windows Explorer 项经 dsh 认证后
由插件宿主复核绝对现存目录，启动成功即返回，并异步 best-effort 尝试置前，其余应用继续走原生路由。
不改 relay。用户明确接受远程点击可能抢占目标机器当前焦点。
目标必须有可用图形桌面；无 opener 的回显路径、非 Windows 行为仍由原生 dsh 处理。

## 3. 持续关注

- dsh 升级可能改变插件契约，按 [源码依据](02-dsh-facts.md) 和各插件检查脚本复核。
- relay 登录相当于取得目标机器用户权限下的 shell，风险与部署要求见 [安全](04-security.md)。
- 移动端真实长连接、后台恢复和附件上传需要实机验收，不能用单元测试代替。
