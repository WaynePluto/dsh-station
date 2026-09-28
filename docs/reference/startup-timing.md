# 桌面启动时序与事件通知调研

本页记录 2026-09-28 的实测与现行实现。启动/远程管理加载页已改为单次 HTTP 状态流，
项目加载页仅兜底后台等待；认证入口就绪后立即交给 dsh 原生页面，不等动画或客户端插件加载完成。

## 原生 Loading plugins 为什么可能看不见

### 实测方法

使用当前官方 `dsh@0.1.7-rc.2`、项目默认分发插件和 Wails v2.16.0 / WebView2。
隔离壳复用生产的 backend、startup_loading、admin_loading 与标题栏代码；独立 DSH_HOME、
station home、端口和 WebView2 数据目录，不停止用户开发实例。

临时宿主插件通过 `webserver/index-inject` 的 head script 安装只读采样：

- MutationObserver 记录 `[data-dsh-boot]` 加入/移除及工作台接管；记录时刻为回调观测时间。
- PerformanceObserver 记录 first-paint / first-contentful-paint。
- requestAnimationFrame 只记录 BootPage 是否仍存在与 computed visibility，不把回调当作已显示的证据。
- Resource Timing 记录资源传输量，不保存 URL、token、cookie 或页面正文。

首次正常导航后连续重载两次。以下时间均从 **dsh 文档 navigationStart** 起算，不是从命令启动起算。

| 样本 | BootPage 加入 | BootPage 移除 | 首次绘制 / FCP | 插件资源 |
|---|---:|---:|---:|---|
| 首次加载、冷缓存 | 102.6ms | 444.9ms | 280ms | 实际传输 |
| 第一次重载、热缓存 | 42.3ms | 180.8ms | 180ms | transferSize=0 |
| 第二次重载、热缓存 | 34.2ms | 130.4ms | 136ms | transferSize=0 |

第三个样本中 BootPage 在首次绘制前已被替换，因而没有机会作为新文档内容呈现。
第二个样本的可见时间窗口也不足一帧。冷缓存样本则在首绘后仍保留约 165ms。
三个样本均观察到原生 BootPage 创建、插件加载和工作台接管，没有跳过加载流程。

这证实了用户反馈的一种实际成因，不是对所有机器或每次启动时长的保证。
rAF 中观察到 DOM 不等于该状态已完成绘制；Wails `OnDomReady` 在 Windows 实际挂在
WebView2 NavigationCompleted，不能据此推断原生 BootPage 的首帧时机。
本次没有修改 dsh 源码，也没有为原生加载页添加最低停留时间。

源码依据：`packages/client/web/src/boot-page.ts`、`src/boot.ts`、
`packages/client/ui-renderer/src/client/index.ts`，并对照当前发布的 Web 前端产物。

## 现行加载反馈与原生交接

- `startup_loading.go` 与 `admin_loading.go` 的页面通过 `loading_client.go` 各建立一次 `/events` 请求，
  不再调用定时查询；`/status` 仅保留为只读诊断快照。
- 1 秒是 CSS 转圈周期，不是强制等待时间；ready 帧立即导航，不等整圈、不添加最低展示时间。
- `backend_events.go` 的 Observe 同锁返回快照与 change channel；launcher 阶段、进程退出和
  壳侧远程失败均广播。`remote.go`、`navigation.go` 的等待只 select 事件/取消/单次总期限。
- 项目加载页不覆盖或复制原生 BootPage；顶层认证交接后整份文档由 dsh 接管。
  本机已可用时也不等待并行的远程启用完成。原生阶段短于首绘时仍可能看不到，不强制拖长。
- launcher 的 TCP / relay 链路探测属于真实就绪检测，仍然保留，不以 spawn 成功冒充业务就绪。

## 一次只读 HTTP 流式订阅

```text
launcher 阶段变化
  → stdout 状态行
  → Go 更新状态并广播
  → 已建立的同源 HTTP 流推送安全状态
  → 页面更新文案，或导航固定 /enter
```

两种加载页共用流式传输实现，各自投影启动/远程状态。连接建立时立即发送当前状态，
随后只在变化时发送；完成、失败、取消即关闭。不再定时发 HTTP 请求，也无需为了 loopback
链路发送周期心跳。保留单次总超时与资源回收计时器，它们不是轮询或最低展示时间。

使用 **streaming fetch + 逐行 JSON 状态帧**：保留现有 `mode:'same-origin'`、
`credentials:'omit'`、`redirect:'error'`、no-store/no-referrer 与 AbortController。
状态帧是服务端生成的单行 JSON，客户端有界累积、逐行解析，只识别固定状态字段。
不引入业务协议解析或第二套 dsh 插件加载机制。

### 为什么不直接套其它 API

| 选项 | 结论 |
|---|---|
| Wails EventsEmit / EventsOn | 原生窗口有此 API，但通知调用 `window.wails.EventsNotify`；当前 loopback 页面不带该运行时，外部系统浏览器也不能使用。为此补桥接会分裂两种入口并扩大耦合。 |
| EventSource / SSE | 原生 API 成熟，但不能直接保留当前 fetch 的 omit/error 请求策略；默认同源凭据与自动重连也需要重新设计边界。HTTP 流式推送不必绑定 EventSource。 |
| 事件驱动长轮询 | 比 200ms 定时查询好，但每次响应仍要建立下一次订阅；单条状态流更直接。 |
| WebSocket | 单向、短生命周期的状态通知不需要额外升级协议和双向通道。 |

Wails 依据：v2.16.0 的 `pkg/runtime/events.go`、
`internal/frontend/desktop/windows/frontend.go` 的 Notify / navigationCompleted。

### 边界与验证

- 状态快照与订阅原子获取，Start/Stop/请求占位/管道失败均广播，重复失败不自旋。
- `loading_stream.go` 每帧最多 8KiB（含换行），相同安全视图不重复发送；无心跳或重连。
  空闲等待解除短写期限，每次写入与 flush 单独限时3秒，服务仍限制32连接、10分钟寿命和完成后30秒宽限。
- 启动流总期限150秒、管理流25秒，客户端155秒兜底不随帧续期；超时不是最低显示时长。
  ready/failed、页面离开、断流或壳退出均终止读取并清理定时器。
- 保留随机能力路径、socket/Host/Origin/Fetch Metadata 与 CSP `connect-src 'self'`；
  流中不接受启用命令、不含 token，认证仍只由固定顶层交接入口完成。
- Go 测试覆盖漏通知窗口、多客户端、壳侧失败、无变更超时、超过3秒空闲、取消和关闭；
  Node 执行实际客户端脚本验证拆分UTF-8、超长/坏帧、提前断流与终态立即交接。
- 隔离真实后端验证两类流、原生认证交换和远程失败隔离；隔离 WebView2 实测成功进入 dsh，
  启动加载仅1次 `/events`、0次 `/status`。未停止用户开发实例。

该实现消除加载反馈的查询等待，不改变 dsh 插件初始化成本或强制原生加载页的展示时长。
