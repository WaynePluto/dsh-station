# 04 · 安全与认证

## 1. 威胁模型

能通过 relay 操作 dsh 的人，可以以 dsh 进程用户的权限执行命令、读写文件和读取凭据。
Linux systemd 部署默认让 dsh 进程用户就是指定的个人普通用户，因此这个边界接近该用户通过 SSH 登录后的权限，
不是多租户隔离系统。relay 登录是远程访问的主要防线；dsh 自带 cookie 认证与 Host/Origin fence 是附加防护。

dsh 永远只监听 127.0.0.1。connector 主动拨出，不需要在目标机器开放 dsh 入站端口。
每台机器的 relay 仍需按其监听地址、防火墙和 TLS 配置保护，不能把“connector 拨出”理解为整台机器没有攻击面。

## 2. 认证

### 设备

- connector 生成 Ed25519 密钥，私钥存于 dsh-station home 的 device.key，POSIX 0600，Windows 收紧 ACL。
- 管理员签发一次性注册令牌，固定 5 分钟有效，数据库只保存哈希。
- 首次注册提交令牌、公钥和机器名；之后使用随机挑战签名认证。
- 管理页“停止 X 并移除”会立即断开该机器；connector 致命退出，launcher 关闭整套进程。
- 独立 CLI 修改数据库不负责断开已建立连接；需要即时断开时使用运行中 relay 的管理页。

### 浏览器

| 项目 | 当前实现 |
|---|---|
| 管理员 | 单管理员，关闭开放注册 |
| 密码 | 至少 6 字符，大写、小写、数字、其他字符四类中至少三类 |
| 密码哈希 | Node 内置 scrypt，参数由 password.ts 定义 |
| 二次验证 | TOTP，首次使用完成绑定 |
| 会话 | 15 分钟 JWT；30 天可吊销 refresh cookie |
| Cookie | 公网 HTTPS 使用 HttpOnly、SameSite=Lax、Secure、__Secure- 前缀和共享 Domain；真实 loopback HTTP 使用独立的 host-only、非 Secure 辅助 Cookie |
| 限流 | 按 IP 与账号双维度，5 次失败锁定 15 分钟 |
| 账号恢复 | 有数据库访问权的操作者可重置密码或 TOTP，现有会话随之吊销 |

实现见 [password.ts](../packages/relay/src/auth/password.ts)、[session.ts](../packages/relay/src/auth/session.ts)、
[cookies.ts](../packages/relay/src/auth/cookies.ts)。

### Loopback 豁免

只有 TCP socket 来源是 loopback，且原始 Host 的 hostname 也是 loopback 时免登录。
不信任 X-Forwarded-For 来决定豁免。局域网 IP、反代后的域名请求都必须登录。
首次设置向导还要求数据库中尚无管理员，非 loopback 访问不能抢先初始化。

IP 模式使用 host-only cookie；域名模式的公网会话使用 Cookie Domain 共享子域登录态。
域名模式的本机 `http://127.0.0.1:<端口>` 不依赖公网会话：relay 按原始 loopback socket + Host 选择独立的非 Secure、host-only Cookie，用于 CSRF、主题和本机表单；公网 Cookie 不会被降级或复制到本机。
cookie 不区分端口，同一主机的机器端口共享登录。Domain cookie 不能使用 __Host- 前缀。

## 3. 请求检查

顺序固定为：认证 → 原始 Host/Origin 与 sec-fetch-site 校验 → 隧道转发。
WebSocket upgrade 遵守同样的顺序。

- Host 必须属于已配置的管理入口或有效机器路由；配置的裸域名只进入 `/_admin`，不会隐式指向入口机器 dsh。
- 带 Origin 的公网请求必须使用配置的 HTTPS scheme 并与原始目标 authority 匹配；真实 loopback 请求使用 HTTP scheme 并与 loopback authority 匹配；cross-site 请求拒绝。
- 管理接口采用 CSRF 防护；转发请求同时保留 relay 和 dsh 的信任检查。
- relay 不重写 Host/Origin；目标 dsh 通过 trustedHosts 声明信任。

### dsh Token

仅在浏览器已通过 relay 认证且 dsh 对 GET 首页返回 401 时，发送一次 token 重定向。
已有 token 参数时不重定向；API 401 原样透传。响应使用 no-referrer 与 no-store。
token 只保存在当前控制信道的内存状态中，不写数据库或日志。
协议依据见 [传输事实](dsh/transport.md)。

### 公开静态资源

除登录与首次设置等认证入口外，以下固定资源不要求登录：

| 路径 | 内容 |
|---|---|
| /manifest.webmanifest | 构建期固定 manifest |
| /_icon/dsh-station.svg、.ico、.png | 构建期固定图标 |

这些资源不读数据库、不反射机器状态、不进隧道。图标不占用 dsh 的 favicon 路径。
新增公开资源前必须确认内容不会因用户、机器或配置变化。

### 本机启动页的脚本例外

登录、首次设置与远程离线页维持 `default-src 'none'` 的无脚本策略；管理页仅增加下述只读主题脚本例外。loopback socket +
loopback Host 的启动 splash 使用独立 CSP：`script-src` 只允许构建内容的 SHA-256 哈希，
`connect-src 'self'` 只允许同源探测；不使用 `unsafe-inline` 放开脚本，不增加公开状态接口。
固定脚本串行 GET 当前 URL，不解析 dsh 协议、不跟随或读取 token 重定向，收到成功或重定向
后重载当前页，由原有导航完成 cookie 交换。探测仍经过认证与 Host/Origin/sec-fetch-site 检查。
等待期间保留原文档以避免转圈重置；禁用脚本时退回每秒刷新。

### 管理页只读主题流

- 管理三页、确认页忽略独立主题 Cookie，首屏使用本机 `dsh-theme.json` 安全投影；
  壳级插件从原生已提交配置产生此文件，relay 只读工作站自有协议，不读取或修改原生profile。
- 管理页 CSP 仅额外允许固定脚本的 SHA-256 与 `connect-src 'self'`；不放开任意内联脚本、CORS或Go绑定来源。
  脚本只修改根节点 `data-theme`，不访问Cookie、不提交设置、不重载页面或触碰表单草稿。
- `GET /_admin/theme/events` 位于既有管理认证后，单独复核合法Host与精确同源Origin；
  无Origin时要求same-origin Fetch Metadata。拒绝same-site/cross-site、错误scheme/端口、查询串、非GET与非NDJSON Accept。
  loopback豁免仍要求socket与Host双成立，并核对实际端口。未认证流返回401，不跳转登录。
- NDJSON只含版本与三态主题；no-store、nosniff、禁止代理缓冲。最多32条流、同用户/loopback来源最多8条；
  每帧128字节、队列1024字节、写入3秒上限，背压立即关闭。单连接5分钟，到期重新认证续租。
- 25秒空行保活不查询原生主题或读取文件；发送主题或保活前复核数据库会话有效期、吊销、用户禁用及TOTP状态，
  流内不旋转凭据。退出/断开释放订阅和timer，停止期间拒绝新流。
- 客户端6分钟兜底取消；断线1~30秒退避重连，401/403/404或坏帧停止并保留颜色。
  pagehide取消、bfcache恢复重连；无主题状态轮询。关闭dsh或投影异常不抹去有效缓存，初始无缓存时system。
- 登录/首次设置的公开 `/_theme` 仍只修改本浏览器Cookie，绝不能由它写入宿主主题。

### 桌面启动与按需管理加载页

`dev:desktop` 与桌面发行版在启动期间，以及用户选择打开管理页时，由壳创建临时
`127.0.0.1:0` HTTP 服务。启动加载服务不启动 relay/connector。
32 字节随机能力路径保护只读页面/状态；校验 socket、精确 Host，状态接口要求同源
Origin/Fetch Metadata，不提供 CORS、启用/重试/执行接口或业务代理。能力页面允许顶层导航，
拒绝 iframe/跨站子资源；HTTP 访问本身绝不触发远程启用。仅菜单通过既有 stdin 控制通道启用。

页面使用固定脚本/样式 CSP 哈希、no-store/no-referrer，状态只返回安全错误分类与严格校验的
`http://127.0.0.1:<端口>/_admin` 目标，不包含 dsh token 或原始日志。服务限制 32 个连接与
请求超时，最长 10 分钟，完成后 30 秒关闭，壳退出立即回收。它不是常驻浏览器唤起服务。

加载页仅发起一次 `/events` 同源 fetch，以 NDJSON 状态流接收事件；保留 credentials:omit、
redirect:error、no-store/no-referrer，不自动重连或轮询。单帧上限8KiB，UTF-8/JSON/状态类型严格校验；
保留 `/status` 仅供只读诊断。流式路由空闲期间解除普通3秒写期限，每次写入/flush仍限3秒，
启动/管理流分别有150/45秒总期限；客户端155秒兜底。页面取消、终态及服务退出均关闭流。
快照与变更信号同锁获取，壳侧失败也广播；推送前只投影安全视图，绝不序列化包含token的完整后台快照。

启动页的状态只包含固定阶段/错误文案，不下发 URL 或 token。资产入口先立即 302 到 loopback
加载文档；就绪后脚本仅导航同源能力路径下的 `/enter`，Go 复核状态与既有配置地址后以无正文
302 代发 dsh token。该入口仅允许 GET 顶层导航，拒绝跨站/跨端口发起、iframe、fetch 与查询串；
不接受调用方指定目标，不写入状态、不代理请求。跳到 dsh 是同站顶层导航，认证与 fence 原样执行。
启动等待上限 150 秒；失败保留安全提示，原始日志不进入页面。

Wails 无参管理导航绑定仅允许启动配置握手中确认的 dsh/relay 精确 origin，不使用端口通配符。
托盘停止/重启仅经 stdin 控制受管 relay/connector，不新增 HTTP 控制接口、清除认证配置或重启 dsh。
关闭远程前，壳通过原有 WindowExecJS 对内置页面执行精确 relay origin 检查，仅匹配时返回已校验的
本机 dsh 认证入口；停止后导航完成时再次检查迟到页面。token 不进入日志、管理 HTML 或状态流，
不新增页面绑定或放宽来源白名单；直连工作台与外部浏览器不强制导航。
启用阶段失败仅回收本次 relay/connector；已就绪后 connector 致命退出（含设备移除）、dsh
故障及 CLI/服务版仍遵守整套停机语义。首次本机认证与所有非 loopback 访问认证边界不变。

## 4. 部署要求

- 公网必须 HTTPS/WSS。relay 监听 loopback，由 Caddy/nginx 终结 TLS并保留原始 Host；反向代理只匹配配置的裸域名与泛子域名，并拒绝以 loopback/IP Host 命中公网站点，避免外部请求被误认为 loopback。
- 泛域名证书使用 DNS-01；配置 HSTS：max-age=31536000、includeSubDomains。
- Linux systemd 使用个人普通用户运行，不使用 root；个人模式有意不启用 `ProtectHome`、`NoNewPrivileges`、`ProtectSystem` 和 `ReadWritePaths`，
  因而 dsh 看到该用户本来能看到的家目录与系统路径。systemd 配置和迁移步骤见 [部署说明](../deploy/README.md)。
- 定期备份 `~/.dsh-station`、设备密钥及 `~/.dsh`；SQLite WAL 模式要求 relay 数据库目录可写。
- sudo 由系统 sudoers 决定权限和凭据缓存；密码只由用户在交互终端输入，dsh-station 不保存、不自动续期、不配置免密 sudo。
- 明文局域网 HTTP 仅用于显式开发联调，会使用非 Secure cookie并打印高风险警告；域名模式下本机 loopback HTTP 是独立的本机管理入口，不等于允许局域网访问。
  同网段监听者可能取得密码与会话，不应作为公网部署方式。
- 发行包排除 pnpm 的 .modules.yaml 与 .pnpm/lock.yaml 等 registry 账本，避免泄露内网镜像地址。
  更换镜像或打包方式后，检查解压产物中的内部域名。

## 5. 审计

relay 的安全事件写入两处：SQLite audit_log 表与带 audit:true 的 pino JSON 日志。
事件包括管理员初始化、密码/TOTP 变更、登录成败、退出、设备注册与认证、停止并移除、远程入口关系变化。
完整词表见 [events.ts](../packages/relay/src/audit/events.ts)。

audit_log 不自动过期；清理属于显式运维动作。没有审计页面，查询方式见 relay-audit skill。
禁止记录密码、TOTP secret、私钥及 bearer token。

dsh 的 approval/asked、approval/decided 等审批事件属于 dsh 会话日志，
不属于 relay 的 audit_log；relay 不解析会话业务协议。

## 6. 显式接受的风险

| 风险 | 边界与缓解 |
|---|---|
| relay 账号或服务器失守 | 等价于目标机器用户权限下的 shell；依靠登录、TOTP、限流、TLS 与审计 |
| 6 字符密码下限 | 组成规则不等同于长密码强度；TOTP 必开、公网 TLS、双维度限流；不复用密码 |
| 固定 YOLO | 自动允许合法权限请求，模型误判、注入、删除、覆盖、安装或读取凭据不会被权限卡拦下 |
| ownsHost 固定为 true | 允许已认证用户编辑设置，也开放在目标机器桌面打开文件的能力；Agent 预设目录动作沿用原生能力；顶部 Explorer 私有通道沿用原生 Open In… 的浏览器路径能力，只接受绝对且已存在的目录 |
| Explorer 尝试置前 | 已认证的远程点击会异步尝试抢占目标机器焦点；固定 helper 只匹配已验证目录，路径以 base64 数据传递，失败不升级权限或改变打开结果 |
| dsh token 出现在 URL | 同源交换、no-referrer、HttpOnly cookie；仅向已登录用户发放 |
| relay 可见明文业务流量 | relay 属于可信部署组件，TLS 在其前端终结；控制与数据隧道使用 WSS |
| 常驻服务独立于会话和 dsh | 服务直接 spawn，受限沙箱模式下 start/restart 必须获得 allowed-once；面板不能创建服务 |
| 交互终端可以输入 shell 文本 | 仅模型能通过 interactive_terminal/start 创建终端；网页通道只有 list/read/send/interrupt；输入框默认遮罩，用户可在同一管理员任务内复用系统 sudo 缓存，但不主动建立 root shell |
| 个人用户部署的文件边界 | 默认 YOLO 下 AI 可读写个人用户本来有权限访问的家目录、凭据和项目；需要管理员权限时由用户明确输入 sudo，不能把个人用户模式当成沙箱隔离 |
| 文件浏览读取边界 | files 插件不再自行读取文件；原生 workspaceFiles 负责目录/文件授权、分页和 HTML iframe 隔离，项目插件只通过认证 dsh 通道读取 Git snapshot；右键菜单不提供写入 |
| alpha 依赖 | 只对明确选择的 dsh 族及 workspace 配置列明的依赖豁免 release-age；保留固定版本和完整性校验 |

固定 YOLO 详情见 [插件说明](../packages/plugins/yolo-mode/README.md)。停用并重启后才恢复原生权限服务，
已有会话仍保留策略历史，需重新选择原生权限预设。
固定 YOLO 与远程设置属于首次默认安装的第三方插件（D20）：用户可在 dsh 插件页停用——
停用固定 YOLO 即恢复 dsh 原生权限审批；重新启用仍是主动的提权动作，不会由配套升级改变。
卸载后 launcher 不自动补回，需要从随附 `plugins/` 目录重新安装。停用远程设置（ownsHost）则
经 relay 地址访问时设置页回到受限形态，包括本机 127.0.0.1 的 relay 入口。
常驻服务的 approvalInConfinedSandbox 配置可以关闭受限模式批准门，意味着显式接受该服务的沙箱逃逸。
默认 YOLO 下使用 danger-full-access，服务无需人工批准。

## 7. 使用须知

开启 TOTP、不复用密码、公用设备用完退出登录；及时停止并移除不用的机器。
怀疑异常时到运行 relay 的机器上查询日志和 relay.db，而不是依赖页面状态判断安全。