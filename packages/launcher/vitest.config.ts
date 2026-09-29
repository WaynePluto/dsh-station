import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts', '../../scripts/dev-desktop.spec.ts'],
    // 就绪探测等用例依赖亚秒级事件循环响应；测试文件并行会在低核 CI
    // runner 上互相抢占 CPU，使探测的墙钟定时器先于网络事件执行。串行消除这一抖动源。
    fileParallelism: false,
  },
})
