import process from 'node:process'

/**
 * 桌面壳与 launcher 之间的有界控制通道（计划 S3.2 的最小实现）。
 *
 * launcher 以 `--desktop` 运行时：结构化状态以 NDJSON 行写到 stdout，
 * 每行带固定前缀，桌面壳只认前缀行，其余输出（banner、子进程日志）
 * 全部视作普通日志。控制命令从 stdin 逐行读入。两端只共享这一个
 * 模块里声明的消息形态；桌面壳在 Go 侧有自己的镜像类型（backend.go），
 * 改这里必须同步改那边，fixture 测试（tests/desktop-link.spec.ts）锁定字段。
 */

/** 状态行前缀；桌面壳按它过滤，普通日志绝不包含这个字节序列。 */
export const DESKTOP_LINE_PREFIX = '@@DSH_STATION '

/** 后台生命周期阶段；顺序即启动顺序（CLI 模式 relay 最先起，等待页由它承担）。 */
export type DesktopPhase =
  | 'config'
  | 'relay'
  | 'plugins'
  | 'dsh'
  | 'ready'
  /** 本机模式按需启用远程：补起 relay + connector（D25）。 */
  | 'remote'
  | 'restarting'
  | 'stopping'
  | 'failed'

export interface DesktopUrls {
  /** 本机入口（浏览器与内置窗口都用它）：远程未启用时是 dsh 直连地址，启用后是 relay。 */
  readonly local: string
  /** 本机管理控制台。 */
  readonly admin: string
  /** dsh 自己的 loopback 地址（诊断用）。 */
  readonly dsh: string
}

export type DesktopMessage =
  | {
    readonly type: 'status'
    readonly protocol: 1
    readonly phase: DesktopPhase
    readonly pid: number
    /** 阶段切换时的人读说明；不含凭据。 */
    readonly detail?: string | undefined
    /** ready 之后始终带上 URL；dsh 端口在 config 阶段即已知。 */
    readonly urls?: DesktopUrls | undefined
    /** 管理员是否已初始化（决定首次打开控制台显示设置向导还是登录页）。 */
    readonly adminReady?: boolean | undefined
    /**
     * dsh 本进程的登录 token：本机模式（远程未启用）时壳在初始导航 302 与
     * 「在浏览器中打开」时代发一次 `/?token=` 交换。只经 stdout 管道传输，
     * 与传给 connector 的 DSH_STATION_DSH_TOKEN 环境变量同级，不落日志。
     */
    readonly dshToken?: string | undefined
    /** 远程服务（relay + connector）是否已按需启用。 */
    readonly remoteEnabled?: boolean | undefined
  }
  | {
    readonly type: 'exit'
    readonly protocol: 1
    /** 桌面壳把它写进诊断；进程退出码本身由 Go 直接观察。 */
    readonly message: string
  }

export type DesktopCommand =
  | { readonly type: 'stop' }
  /** 托盘「启用远程服务」：补起 relay + connector（D25）；重复发送是幂等空操作。 */
  | { readonly type: 'start-remote' }

/** stdin 命令回调；解析失败的行静默忽略。 */
export type DesktopCommandHandler = (command: DesktopCommand) => void

/** IO 注入点：生产用 process.stdout/stdin，测试传内存实现。 */
export interface DesktopLinkIo {
  write(text: string): void
  /** 注册行回调（按 \n 切好的行，不含行尾）。 */
  listen(handler: (line: string) => void): void
  /** 释放输入端：stdin 是活跃 handle，不关会挂住事件循环。 */
  close(): void
}

export interface DesktopLink {
  readonly enabled: boolean
  emit(message: DesktopMessage): void
  /** 打开 stdin 命令读取；未知命令类型静默忽略。 */
  listen(handler: DesktopCommandHandler): void
  close(): void
}

const DISABLED: DesktopLink = {
  enabled: false,
  emit: () => undefined,
  listen: () => undefined,
  close: () => undefined,
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function processIo(): DesktopLinkIo {
  let buffered = ''
  return {
    write: (text) => {
      process.stdout.write(text)
    },
    listen: (onLine) => {
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', (chunk: string) => {
        buffered += chunk
        for (;;) {
          const newlineAt = buffered.indexOf('\n')
          if (newlineAt < 0) return
          onLine(buffered.slice(0, newlineAt))
          buffered = buffered.slice(newlineAt + 1)
        }
      })
      process.stdin.on('error', () => undefined)
      process.stdin.resume()
    },
    close: () => {
      process.stdin.destroy()
    },
  }
}

/** 以 `--desktop` 语义启用；`protocol` 固定为 1，升级时旧壳会响亮失败。 */
export function createDesktopLink(argv: readonly string[], io: DesktopLinkIo = processIo()): DesktopLink {
  if (!argv.includes('--desktop')) return DISABLED

  return {
    enabled: true,
    emit(message: DesktopMessage): void {
      io.write(`${DESKTOP_LINE_PREFIX}${JSON.stringify(message)}\n`)
    },
    listen(handler: DesktopCommandHandler): void {
      io.listen((rawLine) => {
        const line = rawLine.trim()
        if (line === '') return
        try {
          const parsed: unknown = JSON.parse(line)
          if (!isObject(parsed)) return
          if (parsed.type === 'stop') handler({ type: 'stop' })
          else if (parsed.type === 'start-remote') handler({ type: 'start-remote' })
        } catch {
          // 控制通道只接受完整 JSON 行；坏行忽略，不中断进程。
        }
      })
    },
    close(): void {
      // 释放 stdin（活跃 handle）：shutdown 路径依赖它退出事件循环。
      io.close()
    },
  }
}
