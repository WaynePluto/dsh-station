package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// backendPhase 与 launcher 的 desktop-link.ts DesktopPhase 对齐（S2 冻结的最小契约）。
// 改任一侧必须同步另一侧，并由 tests/desktop-link.spec.ts 与后端解析测试锁定。
type backendPhase string

const (
	phaseConfig     backendPhase = "config"
	phasePlugins    backendPhase = "plugins"
	phaseDsh        backendPhase = "dsh"
	phaseRelay      backendPhase = "relay"
	phaseReady      backendPhase = "ready"
	phaseRemote     backendPhase = "remote"
	phaseRestarting backendPhase = "restarting"
	phaseStopping   backendPhase = "stopping"
	phaseFailed     backendPhase = "failed"
	// phaseOffline 桌面壳本地状态：后台进程不存在（从未启动/已退出/被停止）。
	phaseOffline backendPhase = "offline"
)

// backendLinePrefix 是 launcher 桌面模式状态行的固定前缀（desktop-link.ts DESKTOP_LINE_PREFIX）。
const backendLinePrefix = "@@DSH_STATION "

// backendStopGrace 是优雅停止的等待上限；超时后按平台兜底杀死进程树。
const backendStopGrace = 10 * time.Second

type backendURLs struct {
	Local string `json:"local"`
	Admin string `json:"admin"`
	Dsh   string `json:"dsh"`
}

type backendWireMessage struct {
	Type       string       `json:"type"`
	Protocol   int          `json:"protocol"`
	Phase      backendPhase `json:"phase"`
	Detail     string       `json:"detail"`
	Urls       backendURLs  `json:"urls"`
	AdminReady bool         `json:"adminReady"`
	Message    string       `json:"message"`
	// DshToken 只经 stdout 管道传输；本机模式下壳在顶层认证交接
	// 与「在浏览器中打开」时代发一次 dsh 的 /?token= 交换（D25）。
	DshToken string `json:"dshToken"`
	// PluginStage 是 plugins 阶段的子步骤标记（copy/deps/install）；
	// 只映射为加载页固定文案，未知值视同缺省。
	PluginStage string `json:"pluginStage"`
	// RemoteEnabled 表示按需启用的本机转发链路已就绪；启用中仍为 false，成功后 Local 指向 relay。
	RemoteEnabled bool   `json:"remoteEnabled"`
	RemoteState   string `json:"remoteState"`
	RemoteError   string `json:"remoteError"`
}

// backendStatus 是 tray/状态页消费的快照；字段全部只读。
type backendStatus struct {
	Phase       backendPhase
	Detail      string
	PluginStage string
	HasURLs     bool
	URLs        backendURLs
	AdminReady  bool
	DshToken    string
	// RemoteEnabled 且 relay 可达时走 relay 入口；否则 ready + DshToken 直连 dsh。
	RemoteEnabled bool
	RemoteState   string
	RemoteError   string
}

func (s backendStatus) displayPhase() backendPhase {
	if s.Phase == "" {
		return phaseOffline
	}
	return s.Phase
}

// backendManager 托管一个 launcher 子进程：以 --desktop 运行、解析结构化状态行、
// 提供启停控制。它只理解 desktop-link 契约，不解析 launcher 的人类输出。
type backendManager struct {
	mu      sync.Mutex
	payload desktopPayload
	token   string // 通知管道共享令牌；launcher → dsh → notify 插件逐级传递
	status  backendStatus
	cmd     *exec.Cmd
	stdin   io.WriteCloser
	exited  chan struct{} // 每次 Start 重建；awaitExit 在进程退出时关闭
	// change 通知配置握手、就绪探测与远程服务的等待者。
	change   chan struct{}
	onChange func(backendStatus)
	// startGuard 防止 Start 并发重入；Stop 幂等，对未运行的后台是空操作。
	startGuard bool
	// 远程请求先占位，再等待 launcher 的真实就绪；失败保留供托盘显示。
	remoteRequested bool
	remoteRequest   *remoteRequest
	remoteError     string
	// 首次握手锁定 dsh/relay 精确来源，后续状态不得悄悄换端口。
	urlConfig *backendURLs
}

func newBackendManager(payload desktopPayload, token string, onChange func(backendStatus)) *backendManager {
	return &backendManager{payload: payload, token: token, change: make(chan struct{}), onChange: onChange}
}

func (m *backendManager) Status() backendStatus {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.status
}

func (m *backendManager) running() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.cmd != nil
}

func (m *backendManager) setStatus(status backendStatus) {
	m.mu.Lock()
	m.status = status
	m.advanceRemoteLocked()
	m.notifyLocked()
	m.mu.Unlock()
	if m.onChange != nil {
		m.onChange(status)
	}
}

// Start 拉起 launcher（--desktop）。已在运行或正在启动时是幂等空操作。
func (m *backendManager) Start() error {
	m.mu.Lock()
	if m.startGuard {
		m.mu.Unlock()
		return nil
	}
	if m.cmd != nil {
		m.mu.Unlock()
		return nil
	}
	m.startGuard = true
	m.mu.Unlock()
	err := m.startLocked()
	m.mu.Lock()
	m.startGuard = false
	m.mu.Unlock()
	return err
}

func (m *backendManager) startLocked() error {
	entry := m.payload.entry
	if entry == "" {
		entry = filepath.Join(m.payload.packageDir, "dist", "index.js")
	}
	command := exec.Command(m.payload.nodePath, entry, "--desktop")
	command.Dir = m.payload.packageDir
	command.Stderr = os.Stderr
	stdin, err := command.StdinPipe()
	if err != nil {
		return fmt.Errorf("无法建立后台控制通道：%w", err)
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		return fmt.Errorf("无法读取后台状态输出：%w", err)
	}
	// 通知管道令牌经环境传给 launcher → dsh → notify 插件；
	// 没有它插件不会连桌面壳，Web/CLI 行为完全不变。
	command.Env = append(os.Environ(), "DSH_STATION_NOTIFY_TOKEN="+m.token)
	applyChildWindowPolicy(command)

	if err := command.Start(); err != nil {
		return fmt.Errorf("后台启动失败：%w", err)
	}
	// Windows 上把进程加入 Job Object：桌面壳异常退出时由系统回收整棵
	// 后台进程树，避免孤儿 dsh/relay 抢占端口。
	if err := adoptBackendProcess(command.Process); err != nil {
		log.Printf("进程树托管失败（桌面壳退出时可能留下孤儿后台）：%v", err)
	}

	exited := make(chan struct{})
	m.mu.Lock()
	m.cmd = command
	m.stdin = stdin
	m.exited = exited
	m.status = backendStatus{Phase: phaseConfig, Detail: "后台进程已启动"}
	m.remoteRequested = false
	m.remoteRequest = nil
	m.remoteError = ""
	m.notifyLocked()
	snapshot := m.status
	m.mu.Unlock()

	if m.onChange != nil {
		m.onChange(snapshot)
	}
	stdoutDone := make(chan struct{})
	go func() {
		defer close(stdoutDone)
		m.pump(stdout)
	}()
	go m.awaitExit(command, exited, stdoutDone)
	return nil
}

var backendTokenPattern = regexp.MustCompile(`([?&]token=)[^&\s)]+`)

// pump 逐行扫描 launcher 的 stdout，只处理桌面状态前缀行。
func (m *backendManager) pump(stdout io.Reader) {
	scanner := bufio.NewScanner(stdout)
	// banner 与个别子进程行可能很长，放大缓冲避免误判为错误。
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, backendLinePrefix) {
			log.Printf("[后台] %s", backendTokenPattern.ReplaceAllString(line, "${1}[redacted]"))
			continue
		}
		m.applyLine(line[len(backendLinePrefix):])
	}
	if err := scanner.Err(); err != nil {
		log.Printf("后台状态流读取失败：%v", err)
	}
}

func (m *backendManager) applyLine(payload string) {
	var message backendWireMessage
	if err := json.Unmarshal([]byte(payload), &message); err != nil {
		log.Printf("忽略无法解析的后台状态行：%v", err)
		return
	}
	if message.Protocol != 1 {
		log.Printf("忽略未知协议版本的后台状态行：%d", message.Protocol)
		return
	}
	m.mu.Lock()
	switch message.Type {
	case "status":
		status := backendStatus{
			Phase:         message.Phase,
			Detail:        message.Detail,
			PluginStage:   message.PluginStage,
			AdminReady:    message.AdminReady,
			DshToken:      message.DshToken,
			RemoteEnabled: message.RemoteEnabled,
			RemoteState:   message.RemoteState,
			RemoteError:   message.RemoteError,
		}
		if message.Urls.Local != "" {
			if err := validateBackendURLs(message.Urls); err != nil || (m.urlConfig != nil &&
				(message.Urls.Admin != m.urlConfig.Admin || message.Urls.Dsh != m.urlConfig.Dsh)) {
				status = backendStatus{Phase: phaseFailed, Detail: "后台上报了无效或变化的本机入口，已拒绝导航"}
			} else {
				status.HasURLs = true
				status.URLs = message.Urls
				if m.urlConfig == nil {
					urls := message.Urls
					m.urlConfig = &urls
				}
			}
		}
		m.status = status
	case "exit":
		// run() 顶层抛出的启动失败；进程随即退出，awaitExit 兜底收尾。
		m.status = backendStatus{Phase: phaseFailed, Detail: message.Message}
	default:
		m.mu.Unlock()
		return
	}
	m.advanceRemoteLocked()
	snapshot := m.status
	m.notifyLocked()
	m.mu.Unlock()
	if m.onChange != nil {
		m.onChange(snapshot)
	}
}

func (m *backendManager) awaitExit(command *exec.Cmd, exited chan struct{}, stdoutDone <-chan struct{}) {
	// 先读完状态管道，避免 Wait 关闭 StdoutPipe 或退出兜底抢先覆盖最后一条失败原因。
	<-stdoutDone
	_ = command.Wait()
	m.mu.Lock()
	m.cmd = nil
	m.stdin = nil
	planned := m.status.Phase == phaseStopping
	if planned {
		m.status = backendStatus{Phase: phaseOffline}
	} else if m.status.Phase != phaseFailed {
		// launcher 已上报的具体失败原因不能被退出兜底文案覆盖。
		m.status = backendStatus{Phase: phaseFailed, Detail: "后台进程意外退出"}
	}
	snapshot := m.status
	m.notifyLocked()
	m.mu.Unlock()
	close(exited)
	if m.onChange != nil {
		m.onChange(snapshot)
	}
}

// Stop 请求后台优雅退出，超过宽限期按平台兜底杀死进程树。幂等。
func (m *backendManager) Stop() error {
	m.mu.Lock()
	command := m.cmd
	stdin := m.stdin
	exited := m.exited
	if command == nil {
		if m.status.Phase != phaseOffline {
			m.status = backendStatus{Phase: phaseOffline}
			m.notifyLocked()
			snapshot := m.status
			m.mu.Unlock()
			if m.onChange != nil {
				m.onChange(snapshot)
			}
			return nil
		}
		m.mu.Unlock()
		return nil
	}
	if m.status.Phase != phaseStopping && m.status.Phase != phaseOffline {
		m.status = backendStatus{Phase: phaseStopping}
		m.notifyLocked()
		snapshot := m.status
		m.mu.Unlock()
		if m.onChange != nil {
			m.onChange(snapshot)
		}
	} else {
		m.mu.Unlock()
	}
	if stdin != nil {
		// 优雅路径：桌面壳下发改停命令，launcher 按既有顺序回收子进程。
		_, _ = stdin.Write([]byte("{\"type\":\"stop\"}\n"))
	}

	select {
	case <-exited:
		return nil
	case <-time.After(backendStopGrace):
	}
	log.Printf("后台未在 %s 内退出，强制结束进程树", backendStopGrace)
	return killBackendTree(command)
}

// Restart = 停止 + 重新启动；停止失败不阻断重新启动（兜底已杀死进程树）。
func (m *backendManager) Restart() error {
	if err := m.Stop(); err != nil {
		log.Printf("重启后台时的停止失败：%v", err)
	}
	return m.Start()
}

// StopAndWait 退出应用前的收尾：确保后台已停止。
func (m *backendManager) StopAndWait() {
	_ = m.Stop()
}
