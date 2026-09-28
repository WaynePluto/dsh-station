# 壳级基础设施

此包由 launcher 通过 `--patch dsh-overlay.yml` 常驻加载，不进入可卸载的功能 Bundle。

- 为 connection 注入 webRuntime/webServer，保持统一 RPC 宿主上下文。
- 模型增强未在启动时加载时，提供 root fiber 上的占位启动屏障。
- 将 dsh 原生主题单向投影给工作站管理页，不修改任何原生设置。

## 主题投影

`theme-projection.mjs` 为无外部依赖的宿主插件。launcher 和开发栈通过环境变量
`DSH_STATION_THEME_FILE` 指定工作站 home 下 `dsh-theme.json` 的绝对路径；未指定则不启用。

插件等待 loader 就绪，读取顶层活跃 `ui-theme` 行的 volatile `preference`，订阅
`app-boot/config-reload` 的成功提交点。原子输出严格的 `{version:1,preference}`，
值限 `light/dark/system`，最多1024 UTF-8字节，不写入URL、凭据或原生配置正文。

相同主题不重写；失败保留旧文件并输出固定诊断。插件释放时取消订阅和待执行工作，
不删除最后投影。relay仅通过有界读取和目录watch消费此项目文件；没有回写通道。
`system`由实际浏览设备解析，不同工作站独立。登录和首次设置页不接入此同步。

## 检查

- `pnpm --filter @dsh-station/dsh-plugin-remote-privileged test`
- `pnpm --filter @dsh-station/protocol test`
- `pnpm --filter @dsh-station/relay test`
- 升级dsh时复核loader entry/config形状与重载提交事件，并用隔离profile验证原生
  light/dark/system修改→投影→管理页事件更新；非法配置拒绝后投影应保持不变。
- overlay及两个 `.mjs` 文件由launcher、开发栈和发行包清单检查，不依赖浏览器构建产物。

源码契约与安全边界见 [插件机制](../../../docs/dsh/plugins.md#工作站只读主题投影)
和 [管理页主题流](../../../docs/04-security.md#管理页只读主题流)。
