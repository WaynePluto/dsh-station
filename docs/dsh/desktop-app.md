# 官方桌面应用启动结构

核实于 dsh-v0.2.0-rc.2（git `639ed01539`）。源码路径相对 dsh 仓库根。
本项目不依赖官方桌面版运行，本页只记录其启动时序的查证结论，作为
dsh-station 桌面启动优化的对照基线；行为变化在升级 dsh 时复核。

## 架构

- `apps/desktop`（`@deepseek-ai/dsh-desktop`）是 Electron 44 壳；真正的 dsh
  宿主是**同一个 Electron 二进制以 Node 模式运行的子进程**
  （`ELECTRON_RUN_AS_NODE=1`，`apps/desktop/src/node-environment.ts`），
  入口为 `apps/desktop-host`（`@deepseek-ai/dsh-desktop-host`）。
- 打包布局（实测 0.2.0-rc.2 安装目录）：**完整 dsh 运行时树（176 个包）整体
  打进 `resources/app.asar` 归档**（asar 头部 `dsh/node_modules/…`），只有
  原生模块等必须落盘的例外放在 `app.asar.unpacked/`（koffi、
  libreoffice-kit 等）。宿主装载插件树时经 Electron 的 asar 虚拟文件系统
  读取——单个大文件的偏移量读取替代数千次小文件的目录遍历与逐个打开，
  这是 Windows 上宿主启动明显快于散装 node_modules 的结构性原因
  （本机实测冷启动约 2.6s 到宿主端口监听）。**运行时零包管理器**：
  所有依赖打包时已就位，启动不做任何版本/内容校验；profile 里的
  `pnpm-workspace.yaml` 仅供用户经插件管理页安装第三方插件时使用。

## 启动时序（`apps/desktop/src/main.ts`）

1. `claimDesktopSingleInstance()` 后注册特权自定义协议 `dsh-app://`
   （`codeCache: true`，Chromium 对该协议 JS 启用 V8 代码缓存）。
2. 隐藏主窗口先 `navigateMain('dsh-app://app/')`：协议处理器对 `/`、
   `/assets/*` 直接 `readFile` 本地 `dsh-web-frontend/dist`
   （`apps/desktop/src/web-document.ts`），**不走网络、不等任何 server**；
   index 注入 `__DSH_BOOT_READY__` gate，页面立即渲染 BootPage。
3. `backend.start()` 随后**并行**：本地 profile 校验（不跑包管理器）→
   spawn 宿主进程 → 宿主 `runProfile` 装载插件树（约 150+ 行，
   Loader 以 `Promise.all` 并发 import，`vendor/loader/src/config/group.ts`）。
4. 宿主整树 settle 后经 **IPC 主动推送** `{type:'ready', url, injections}`
   （`apps/desktop-host/src/index.ts`）；壳用一次 loopback fetch 把
   token URL 换成 cookie（`web-document.ts` 的 `authenticateWebHost`）。
5. 渲染端 `dshDesktopBoot.ready()` IPC 拿注入表、resolve gate，
   前端继续装载浏览器插件；`/api` 与 WS 由协议转发到固定端口
   `127.0.0.1:19387`（宿主以 `--port 19387` 固定，无探测）。
6. 关窗即隐藏，宿主常驻；再次双击走 single-instance 只 focus
   （`main.ts` "Closing hides" 注释与 `single-instance.ts`）。

## 对 dsh-station 的对照结论

- 官方快 = `max(Electron 启动 + 本地前端加载, asar 内宿主 boot 约 2.6s) + 一次 IPC`，
  冷启动到可用约 3s（实测本机）；其中 asar 化的运行时树是散装布局没有的
  结构性加速，dsh 插件树装载本身两边同价（散装裸 profile 实测约 2.8s）。
- 可借鉴且已借鉴：介质一致性校验从「每次启动逐字节哈希」改为
  「打包期指纹清单」（本项目 `stamp.json`，见 [插件机制](plugins.md)）；
  配套升级只重装实际变化条目。
- 不可直接照搬：`--expose-internals` 的 ready IPC 是官方私有契约
  （本项目以 token 行 stdout 为上限，不能 fork dsh）；asar 归档访问依赖
  Electron 的虚拟文件系统，纯 Node 宿主（本项目 launcher spawn 的 dsh）
  不支持等价物——同等收益要等上游把 CLI/分发形态 bundle 化；
  `dsh-app://` 本地协议 + `/api`/WS 转发在 Wails/WebView2 下没有干净的
  WebSocket 转发路径，且会引入壳内代理与新 Origin 语义，未采纳。
