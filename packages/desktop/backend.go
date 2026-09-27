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
	// DshToken 只经 stdout 管道传输；本机模式（远程未启用）下壳在初始导航
	// 302 与「在浏览器中打开」时代发一次 dsh 的 /?token= 交换（D25）。
	DshToken string `json:"dshToken"`
	// RemoteEnabled 表示 relay + connector 已按需启用；此后 URLs.Local 指向 relay。
	RemoteEnabled bool `json:"remoteEnabled"`
}

// backendStatus 是 tray/状态页消费的快照；字段全部只读。
type backendStatus struct {
	Phase      backendPhase
	Detail     string
	HasURLs    bool
	URLs       backendURLs
	AdminReady bool
	DshToken   string
	// RemoteEnabled 且 relay 可达时走 relay 入口；否则 ready + DshToken 直连 dsh。
	RemoteEnabled bool
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
	// change 通知所有等待者「状态变了」；statusHandler 用它实现初始导航持有。
	change   chan struct{}
	onChange func(backendStatus)
	// startGuard 防止 Start 并发重入；Stop 幂等，对未运行的后台是空操作。
	startGuard bool
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
	close(m.change)
	m.change = make(chan struct{})
	m.mu.Unlock()
	if m.onChange != nil {
		m.onChange(status)
	}
}

// WaitForChange 等待下一次状态变更（或超时），返回当时的快照。
// 超时返回当前状态且第二个返回值为 false。
func (m *backendManager) WaitForChange(timeout time.Duration) (backendStatus, bool) {
	m.mu.Lock()
	wait := m.change
	snapshot := m.status
	m.mu.Unlock()
	select {
	case <-wait:
		return m.Status(), true
	case <-time.After(timeout):
		return snapshot, false
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
	entry := filepath.Join(m.payload.packageDir, "dist", "index.js")
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
	m.change = make(chan struct{})
	m.status = backendStatus{Phase: phaseConfig, Detail: "后台进程已启动"}
	snapshot := m.status
	m.mu.Unlock()

	if m.onChange != nil {
		m.onChange(snapshot)
	}
	go m.pump(stdout)
	go m.awaitExit(command, exited)
	return nil
}

// pump 逐行扫描 launcher 的 stdout，只处理桌面状态前缀行。
func (m *backendManager) pump(stdout io.Reader) {
	scanner := bufio.NewScanner(stdout)
	// banner 与个别子进程行可能很长，放大缓冲避免误判为错误。
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, backendLinePrefix) {
			log.Printf("[后台] %s", line)
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
			AdminReady:    message.AdminReady,
			DshToken:      message.DshToken,
			RemoteEnabled: message.RemoteEnabled,
		}
		if message.Urls.Local != "" {
			status.HasURLs = true
			status.URLs = message.Urls
		}
		m.status = status
	case "exit":
		// run() 顶层抛出的启动失败；进程随即退出，awaitExit 兜底收尾。
		m.status = backendStatus{Phase: phaseFailed, Detail: message.Message}
	default:
		m.mu.Unlock()
		return
	}
	snapshot := m.status
	m.mu.Unlock()
	if m.onChange != nil {
		m.onChange(snapshot)
	}
}

func (m *backendManager) awaitExit(command *exec.Cmd, exited chan struct{}) {
	_ = command.Wait()
	m.mu.Lock()
	m.cmd = nil
	m.stdin = nil
	planned := m.status.Phase == phaseStopping
	if planned {
		m.status = backendStatus{Phase: phaseOffline}
	} else {
		m.status = backendStatus{Phase: phaseFailed, Detail: "后台进程意外退出"}
	}
	snapshot := m.status
	m.mu.Unlock()
	close(exited)
	if m.onChange != nil {
		m.onChange(snapshot)
	}
}

// StartRemote 请求按需启用远程服务（D25）：launcher 补起 relay + connector。
// 后台不在运行时是空操作（托盘项只在后台存活时可用）。
func (m *backendManager) StartRemote() {
	m.mu.Lock()
	command := m.cmd
	stdin := m.stdin
	m.mu.Unlock()
	if command == nil || stdin == nil {
		return
	}
	_, _ = stdin.Write([]byte("{\"type\":\"start-remote\"}\n"))
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
