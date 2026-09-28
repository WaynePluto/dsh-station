# AGENTS.md

适用于本仓库中的 AI 编码助手。本项目 dsh-station（用户文案「DSH 工作站」）是官方
DeepSeek Harness (dsh) 的完整封装工作站：桌面应用与绿色/服务介质内置并托管 dsh，
带认证的反向隧道提供远程能力；`remote` 一词只指远程能力（远程入口、remote-* 插件），
不再是项目名。

## 开始前

1. 读 [当前进度](docs/05-roadmap.md)，确认本次任务与待验收项。
2. 读 [决策](docs/01-decisions.md)，遵守现行产品边界与术语。
3. 涉及 dsh 行为先读 [源码依据索引](docs/02-dsh-facts.md) 对应主题；查上游源码前加载 dsh-source skill。
   dsh 本地路径只记在 [.agents/skills/dsh-source/SKILL.md](.agents/skills/dsh-source/SKILL.md)。

## 铁律

- 不修改或 fork dsh 源码，扩展只能写插件。
- relay 只搬运 HTTP/WebSocket 字节，不解析 dsh 业务协议；首页 401 的一次 token 重定向是唯一例外。
- dsh 始终 bind 127.0.0.1。relay 原样转发 Host/Origin，通过 --trusted-host 声明信任。
- 所有非 loopback 浏览器访问必须认证；仅 loopback socket + loopback Host 同时成立才免登录。
- 一台机器独立 origin，公网用子域名，局域网可用每机器端口，不能挂子路径。
- launcher、connector、relay 不引入原生模块，持久化用 node:sqlite，密码哈希用 node:crypto scrypt。
- 优先成熟依赖，所有直接依赖固定版本，不使用范围、dist-tag 或隐式升级。
- 与官方 dsh 共用标准 DSH_HOME，仅在 dsh-station-web profile 安装项目功能插件。
  不写 home 级 patch、不修改官方 web profile，不实现第二套插件管理器。
- 普通插件位于 packages/plugins/<名字>，包名 @dsh-station/dsh-plugin-<名字>，
  包根 overlay 用 ./dist/index.js；launcher、dev-stack、pack 都要检查宿主和浏览器产物。
- 20 个功能组件按 `plugin-catalog.json` 分发为 4 个组合包和 6 个独立包：首次默认安装，后续配套升级仍安装项并保留 Bundle/组件停用状态，卸载后不自动补回；开发与发行介质分别位于 `.dev/plugins/` 和 `plugins/`。
- `remote-privileged` 的 connection/webServer 注入、模型 HMR 启动屏障与原生主题只读投影作为不可卸载的壳级基础设施；模型屏障服务挂在 root fiber，避免 Bundle 在线启停重启 `llm-pi-ai`。管理页主题单向消费工作站自有投影，不读写原生profile或通过公开主题GET回写宿主。
- concise-mode（用户文案「简洁模式」）是独立第三方 Profile Bundle，位于 dsh-web-app 后；patch 内联声明两个 `@deepseek-ai/dsh-agent-preset` 行，不加载 preset root 或 locator entry；子代理深度沿用 dsh 原生配置（默认 1）。
- 中文文案使用决策中的词表，页面使用机器真名；hub、membership、slug 等代码标识符不随文案改名。
- 完成 roadmap 条目立即勾选，未做实机验收不能按自动测试结果勾选。

## 环境与检查

Windows，PowerShell 7；使用 PowerShell 语法。Node 最低 22.19.0，本地 pnpm 使用已安装版本，CI 固定 10.17.0。
TypeScript + ESM + pnpm workspace，构建 tsdown，开发 tsx，测试 Vitest。
技术选型见 [架构](docs/03-architecture.md)，不要随意替换。
项目模块架构见 [ARCHITECTURE.md](ARCHITECTURE.md)；修改模块结构后请更新该文件。

常用检查：pnpm check:dependencies、pnpm lint、pnpm typecheck、pnpm build、pnpm test。
依赖更新加载 update-dependencies skill；版本发布（预发布/正式、清理旧预发布）加载 release-version skill；
提交前钩子检查固定版本并清理 lockfile 内部镜像 tarball 地址。

## 按任务阅读

| 改动 | 必须阅读 | 关键约束 |
|---|---|---|
| 转发、登录、目录选择 | [传输](docs/dsh/transport.md)、[安全](docs/04-security.md) | 认证 → 原始安全检查 → 隧道；HTTP 用 node:http；upgrade 单独处理 |
| 插件装载、设置、界面 | [插件机制](docs/dsh/plugins.md) | mutate 返回 boolean（false 即拒绝），失败保留草稿；同 cell 同 priority 冲突；primitives external |
| 模型与代理 | [模型](docs/dsh/models.md) | 保留用户条目、只清理插件溯源；混合协议先恢复同一 pi-ai map；代理唯一配置源 |
| 重试、滚动、分叉、通知 | [会话](docs/dsh/conversation.md) | 保护 nextTurn 队列；不移动 React DOM；保持 turn-tail 最后；idle 去抖 |
| 权限、服务、PTY、工具统计 | [运行时](docs/dsh/runtime.md) | 不 append 自定义事件；统计回放历史；进程身份复核；交互终端仅用于人类输入 |
| 技能、提示词、文件浏览 | [工作区](docs/dsh/workspace.md) | scope/cwd 来自 live Agent；有界读取；只读视图不改变模型能力 |

插件功能与入口见 [插件索引](docs/plugins.md)，具体实现前读对应包 README。
升级与冒烟脚本入口统一在源码依据索引，各包 test/typecheck/build 仍需按改动范围运行。

## 高风险约束

- 设置写入走插件行 volatile Config：宿主半 loader/volatile-update + internal/config 校验钩子，浏览器半 configForms。mutate/set/unset 返回 boolean，false 即宿主拒绝；两半共享校验，失败保留草稿并就地报错（契约见 docs/dsh/plugins.md）。
- 插件不能 append 自定义 Session 事件，否则持久化加载会拒绝会话；projection 只折叠已知事件，
  无关事件返回同一引用。工具/技能历史使用 snapshotEvents，查询 scope 必须传 live Agent。
- yolo-mode 固定 danger-full-access + ask，合法 approval 自动 allowed-once，用户提问不自动回答。
  schema 与执行/展示参数都过滤提权字段；升级运行 yolo-mode-check，任何契约变化必须响亮失败。
- services 在沙箱外 spawn，受限模式 start/restart 必须批准；终端沿用 dsh PTY 沙箱。
  interactive_terminal 只用于预期用户直接输入，普通 Git、构建、测试和长任务用 pwsh/bash；
  Linux sudo 管理任务的命令统一走交互终端，可在同一终端内复用系统缓存，但不建立持续 root shell。
- Windows 杀进程树用 taskkill /T /F；常驻服务用两级启动器并记录 L2 pid，不以 detached:true 保证存活。
- 全局提示词只保存 DSH_HOME/AGENTS.md，UTF-8 字节上限 1 MiB、原子写入，冒烟由 dsh 加载器反向认领。
- files 插件的 Git 根只取 live session.header.cwd，Git 采集无 shell且有界；文件树、读取与预览跟随 dsh 原生 workspaceFiles/UI，目录右键只复制绝对/相对路径；
  不增写入接口、不递归预扫、不挂 watcher、不引第二套预览编辑器。

## 界面约束

编写或调整 dsh UI/CSS/主题样式前，必须加载 [dsh-theme skill](.agents/skills/dsh-theme/SKILL.md)。
任务收尾时自动将本次已验证、可复用的新样式经验合并回该技能（无需用户再次提醒）；
有新上游契约同步更新 docs/dsh/plugins.md，不记录未经验证的猜测或重复流水账。

任何图标文字对齐先加载 flex-centering skill。dock 必须沿用 dsh todo 风格：specific-tip 背景、
0.5px border-l1、12px 圆角、13px 标题、原生 outline 图标、整行 button 与 aria-expanded、共享宽度轴。
表头嵌套 flex，图标必要时 translateY(0.115em)，摘要省略号在内层 span。
箭头收起用 IconChevronUpOutlineMedium，展开用 IconChevronDownOutlineMedium（dsh 0.1.7 起数字后缀改为 Medium/Regular），不用文本箭头。
services 与 terminal 共用 IconApiOutlineMedium。

深浅主题都验收；border-l1 的 l 是字母，浅色 bg-layer-1/2/3 都为白，font-mono 要完整 fallback 栈。

## 文档与运行

- 插件使用说明放包根 README，docs/plugins.md 做索引；源码契约按 docs/dsh 的主题归属维护。
- docs 每个文件最多 600 行，只保留现行行为与明确待办，不追加旧方案或调试过程。
- 修改插件任何一半后都要构建并重启 dsh，dsh-station-web 没有 HMR，刷新页面不会更新产物。
- 安全活动写 relay.db 的 audit_log 与 pino，没有管理页面；查询加载 relay-audit skill。
- 上游源码引用使用相对 dsh 根路径，不在其他文件记录本地绝对路径。
- 未记录的架构决策先向用户确认，不猜 dsh 行为。