---
name: dsh-source
description: 定位并查证 DeepSeek Harness (dsh) 的本地源码与官方文档。当需要确认 dsh 的实际行为（Web 传输协议、/api 的 Host/Origin 校验、Cordis 插件机制、审批与权限、web server 配置、CLI 命令、官方 SDK）时先加载本 skill，它给出本地源码根路径和常用文件位置。不适用于 dsh-station 自身的架构决策（那些在 docs/01、docs/03）。
---

# dsh 源码查证入口

本仓库（dsh-station）中**唯一**记录 dsh 本地源码路径的地方。其他文档、代码注释一律使用**相对于 dsh 仓库根**的路径（如 `packages/client/connection/src/api-request-trust.ts`），需要落到磁盘时来这里取根路径。

## 源码根路径

```
D:\github\deepseek-harness
```

- 若该路径不存在，**先问用户**新位置，不要在别处猜测或搜索。
- 本仓库的结论文档（`docs/02-dsh-facts.md`）当前核实于 `git 639ed01539` / tag `dsh-v0.2.0-rc.2`；本地 checkout 可能已经更新（用 `git -C D:\github\deepseek-harness rev-parse --short HEAD` 确认）。**版本不一致时，以源码为准，并提示用户回写 `docs/02-dsh-facts.md`。**

```powershell
# 确认版本
git -C D:\github\deepseek-harness rev-parse --short HEAD
git -C D:\github\deepseek-harness branch --show-current
```

## 切换到指定版本

需要把源码切到某个新 tag（如升级前核对）时，**优先**用精确拉取单个 tag 再分离切换：

```powershell
git -C D:\github\deepseek-harness fetch origin tag <tag>   # 只拉该 tag，不动远端跟踪分支
git -C D:\github\deepseek-harness switch --detach <tag>    # detached HEAD 停在 tag 上，不建本地分支
```

- tag 命名为 `dsh-v<版本号>`，如 `dsh-v0.1.7-rc.1`。
- 切换前确认 `git status --porcelain` 为空，工作区有残留先处理，不要强切。

## 常用位置（相对 dsh 仓库根）

| 想知道什么 | 去哪看 |
|---|---|
| Web 传输层协议 | `packages/client/connection/README.md` + `packages/client/connection/src/` |
| `/api` 的 Host / Origin 校验规则 | `packages/client/connection/src/api-request-trust.ts` |
| dsh 自带的浏览器认证（token → cookie） | `packages/client/connection/src/browser-auth.ts`、`src/rpc-host.ts` |
| 下行 WebSocket（`/api/remote.mux`） | `packages/api/gateway/src/stream-protocol.ts`、`packages/api/gateway/src/index.ts` |
| 前端插件机制 | `docs/subsystems/client-modules.md`、`docs/cookbook/adding-a-settings-card.md` |
| 插件打包 / 客户端构建 | `packages/client/tsdown.client.ts` |
| Profile 与 bundle | `docs/architecture.md`、`packages/boot/app-boot/README.md` |
| 写第一个 Cordis 插件 | `docs/cordis-tutorial/01-first-plugin.md` |
| `dsh plugin` CLI 行为 | `apps/cli/src/plugin.ts` |
| 设置页扩展（`installSettingsSection`） | `packages/settings/settings/src/index.ts`、`packages/client/ui-settings-general/src/client/index.ts` |
| 审批与权限 | `docs/subsystems/approval.md`、`docs/subsystems/permission-presets.md` |
| Web server 配置 | `docs/subsystems/web-server.md`、`packages/host/webserver/` |
| 官方 TS SDK（备用路线） | `packages/sdk/{protocol,client,server}/` |
| 全部 UI 插件 | `packages/client/ui-*`（37 个） |

## 使用约定

- **只读。** 铁律 1：不改 dsh 源码、不 fork dsh（见 `AGENTS.md`）。
- dsh 行为**必须读源码确认**，不要凭记忆或猜测。
- 查证结论回写到 `docs/dsh/` 对应主题，并标注**相对路径**出处；`docs/02-dsh-facts.md` 只维护基线、导航与检查入口。不要在结论里写绝对路径。

```powershell
# 在 dsh 源码里搜索（示例）
Select-String -Path 'D:\github\deepseek-harness\packages\client\connection\src\*.ts' -Pattern 'trustedHost'
```
