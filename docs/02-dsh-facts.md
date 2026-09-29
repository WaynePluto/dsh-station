# 02 · dsh 源码依据

当前适配基线：`@deepseek-ai/dsh@0.2.0-rc.2`，对应 git `639ed01539`。
本目录保留当前实现依赖的契约与已有核实结论，不表示每次文档整理都重新运行过所有实机检查。
升级 dsh 时加载 `dsh-source` skill，按主题复核；源码路径均相对于 dsh 仓库根。

| 主题 | 内容 |
|---|---|
| [传输与认证](dsh/transport.md) | HTTP/WS、trustedHosts、dsh cookie、ownsHost、目录选择 |
| [插件机制与界面](dsh/plugins.md) | Bundle/overlay、客户端产物、设置写入、槽位、主题与 dock |
| [模型与代理](dsh/models.md) | Copilot、models.dev、能力声明、目录扩展与全局 dispatcher |
| [会话与消息](dsh/conversation.md) | 重试、投影、原生过程分组、滚动、分叉与通知时序 |
| [工具与进程](dsh/runtime.md) | 工具注册表、YOLO、常驻服务、PTY、Windows 进程树 |
| [技能与文件](dsh/workspace.md) | 技能加载历史、全局提示词、工作区边界与只读预览 |

## 升级检查

先运行项目测试、typecheck 和构建，再按改动影响运行对应脚本。
这些脚本位于仓库根 scripts，运行前阅读脚本的环境与产物要求，不在本文重复测试数量。

| 主题 | 检查入口 |
|---|---|
| 传输 | relay/connector 集成测试；[联调验收](reference/acceptance.md) |
| 简洁模式 | node scripts/concise-mode-check.mjs |
| 模型 | node scripts/copilot-auth-check.mjs；node scripts/favorite-models-check.mjs |
| 代理 | node scripts/proxy-check.mjs |
| 重试与消息 | node scripts/turn-retry-check.mjs；node scripts/user-message-fork-check.mjs；node scripts/chat-scroll-check.mjs |
| 通知 | node scripts/notify-check.mjs |
| 权限与进程 | node scripts/yolo-mode-check.mjs；node scripts/services-check.mjs；node scripts/terminal-check.mjs |
| 只读视图 | node scripts/tools-inspector-check.mjs；node scripts/skills-inspector-check.mjs；node scripts/files-check.mjs |
| 全局提示词 | node scripts/agents-md-check.mjs |

没有独立冒烟脚本的插件运行各包 test/typecheck/build，并完成其 README 中的浏览器验收。
插件用途与入口见 [插件索引](plugins.md)；产品和安全约定分别见 [决策](01-decisions.md)、[安全](04-security.md)。