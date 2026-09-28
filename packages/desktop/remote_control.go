package main

import (
	"errors"
	"fmt"
	"io"
	"time"
)

type remoteAction string

const (
	remoteStart   remoteAction = "start-remote"
	remoteStop    remoteAction = "stop-remote"
	remoteRestart remoteAction = "restart-remote"
)

// 重启包含两个子进程各最多10秒的停止，以及20秒链路探测，另留5秒管道余量。
const remoteRestartTimeout = 45 * time.Second

func (action remoteAction) timeout() time.Duration {
	if action == remoteRestart {
		return remoteRestartTimeout
	}
	return 25 * time.Second
}

func (action remoteAction) label() string {
	switch action {
	case remoteStop:
		return "停止"
	case remoteRestart:
		return "重启"
	default:
		return "启用"
	}
}

// 请求保留已接收的应答，避免合并广播或快速完成后丢失中间 stopping。
// 写入成功与 launcher 完成缺一不可；全部字段由 backendManager.mu 保护。
type remoteRequest struct {
	action       remoteAction
	stdin        io.WriteCloser
	acknowledged bool
	arrived      bool
	sent         bool
	completed    bool
}

func (m *backendManager) reserveRemote(action remoteAction) (*remoteRequest, bool, error) {
	if m == nil {
		return nil, false, errors.New("远程服务由外部栈管理，桌面不能控制")
	}
	m.mu.Lock()
	if m.remoteError != "" || m.status.RemoteError != "" || m.status.RemoteState == "failed" {
		message := m.remoteError
		if message == "" {
			message = m.status.RemoteError
		}
		if message == "" {
			message = "远程服务启用失败"
		}
		m.mu.Unlock()
		return nil, false, errors.New(message)
	}
	if m.remoteRequested {
		request := m.remoteRequest
		m.mu.Unlock()
		return request, false, nil
	}
	if action == remoteStart && (m.status.RemoteEnabled || m.status.Phase == phaseRemote || m.status.RemoteState == "starting") {
		m.mu.Unlock()
		return nil, false, nil
	}
	if m.cmd == nil || m.stdin == nil || m.status.Phase != phaseReady {
		m.mu.Unlock()
		return nil, false, fmt.Errorf("后台尚未就绪或已退出，无法%s远程服务", action.label())
	}
	if action != remoteStart && (!m.status.RemoteEnabled || m.status.RemoteState != "ready") ||
		action == remoteStart && m.status.RemoteState == "stopping" {
		m.mu.Unlock()
		return nil, false, fmt.Errorf("远程服务尚未就绪，无法%s", action.label())
	}
	request := &remoteRequest{action: action, stdin: m.stdin}
	m.remoteRequest = request
	m.remoteRequested = true
	snapshot := m.status
	m.notifyLocked()
	m.mu.Unlock()
	if m.onChange != nil {
		m.onChange(snapshot)
	}
	return request, true, nil
}

func (m *backendManager) sendRemote(request *remoteRequest) error {
	command := []byte(fmt.Sprintf("{\"type\":\"%s\"}\n", request.action))
	written, err := request.stdin.Write(command)
	if err == nil && written != len(command) {
		err = io.ErrShortWrite
	}
	if err != nil {
		return m.remoteFailure(fmt.Sprintf("无法向后台发送%s命令：%v", request.action.label(), err))
	}
	m.mu.Lock()
	request.sent = true
	completed := m.finishRemoteLocked(request)
	snapshot := m.status
	if completed {
		m.notifyLocked()
	}
	m.mu.Unlock()
	if completed && m.onChange != nil {
		m.onChange(snapshot)
	}
	return nil
}

func (m *backendManager) requestRemote(action remoteAction) error {
	request, send, err := m.reserveRemote(action)
	if err != nil || !send {
		return err
	}
	return m.sendRemote(request)
}

// StopRemote/RestartRemote 只控制远程链路，不停止本机工作台或导航当前页面。
func (m *backendManager) StopRemote() error    { return m.requestRemote(remoteStop) }
func (m *backendManager) RestartRemote() error { return m.requestRemote(remoteRestart) }

func remoteReady(status backendStatus) bool {
	return status.Phase == phaseReady && status.RemoteEnabled &&
		(status.RemoteState == "ready" || status.RemoteState == "")
}

// 只由后台状态更新调用；旧 ready 不能代替停止/重启的 stopping 应答。
func (m *backendManager) advanceRemoteLocked() {
	request := m.remoteRequest
	if request == nil || !m.remoteRequested {
		return
	}
	status := m.status
	if request.action == remoteStart || status.RemoteState == "stopping" {
		request.acknowledged = true
	}
	if request.acknowledged {
		if request.action == remoteStop {
			request.arrived = status.Phase == phaseReady && status.RemoteState == "idle" && !status.RemoteEnabled
		} else {
			request.arrived = remoteReady(status)
		}
	}
	m.finishRemoteLocked(request)
}

func (m *backendManager) finishRemoteLocked(request *remoteRequest) bool {
	if m.remoteRequest != request || !request.sent || !request.arrived || m.remoteError != "" ||
		m.status.RemoteError != "" || m.status.RemoteState == "failed" || request.completed {
		return false
	}
	request.completed = true
	m.remoteRequested = false
	m.remoteRequest = nil
	return true
}
