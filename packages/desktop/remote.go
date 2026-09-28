package main

import (
	"context"
	"errors"
	"time"
)

// remoteMenuState 只描述本机远程后台，不表示公网或远程入口已连通。
type remoteMenuState struct {
	Label   string
	Enabled bool
	Checked bool
}

func remoteMenuFor(status backendStatus, requested bool, failure string) remoteMenuState {
	if failure != "" || status.RemoteState == "failed" || status.RemoteError != "" || (requested && !status.RemoteEnabled && status.Phase == phaseFailed) {
		return remoteMenuState{Label: "远程服务启用失败（请退出并重新打开）"}
	}
	if status.Phase == phaseFailed || status.Phase == phaseOffline || status.Phase == phaseStopping {
		return remoteMenuState{Label: "远程服务不可用（后台未运行）"}
	}
	if status.RemoteState == "stopping" {
		return remoteMenuState{Label: "正在停止远程服务…"}
	}
	if status.Phase == phaseRemote || status.RemoteState == "starting" || (requested && !status.RemoteEnabled) {
		return remoteMenuState{Label: "正在启用远程服务…"}
	}
	if status.RemoteEnabled {
		return remoteMenuState{Label: "远程服务已启用", Checked: true}
	}
	if status.Phase == phaseReady {
		return remoteMenuState{Label: "启用远程服务", Enabled: true}
	}
	return remoteMenuState{Label: "启用远程服务（等待工作站就绪）"}
}

func (m *backendManager) RemoteMenu() remoteMenuState {
	if m == nil {
		return remoteMenuState{Label: "远程服务由开发栈管理"}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	state := remoteMenuFor(m.status, m.remoteRequested, m.remoteError)
	if m.remoteRequest != nil && m.remoteRequest.action != remoteStart &&
		(m.remoteError != "" || m.status.RemoteError != "" || m.status.RemoteState == "failed") {
		return remoteMenuState{Label: "远程服务" + m.remoteRequest.action.label() + "失败（请退出并重新打开）"}
	}
	if m.remoteRequested && m.remoteRequest != nil && m.remoteError == "" && m.status.RemoteError == "" &&
		m.status.RemoteState != "failed" && m.status.Phase != phaseFailed && m.status.Phase != phaseOffline && m.status.Phase != phaseStopping {
		return remoteMenuState{Label: "正在" + m.remoteRequest.action.label() + "远程服务…"}
	}
	return state
}

// StartRemote 在写管道前占位；菜单与远程管理入口共用，避免重复发送。
func (m *backendManager) StartRemote() error { return m.requestRemote(remoteStart) }

func (m *backendManager) remoteFailure(message string) error {
	m.mu.Lock()
	if m.remoteError == message {
		m.mu.Unlock()
		return errors.New(message)
	}
	m.remoteError = message
	snapshot := m.status
	m.notifyLocked()
	m.mu.Unlock()
	if m.onChange != nil {
		m.onChange(snapshot)
	}
	return errors.New(message)
}

var errRemoteStopped = errors.New("后台正在退出，已取消等待远程服务")

// waitForRemote 保留不带取消信号的兼容入口。
func (m *backendManager) waitForRemote(timeout time.Duration) (string, error) {
	return m.waitForRemoteContext(context.Background(), timeout)
}

// waitForRemoteContext 只接受 launcher 的链路就绪状态，不以 TCP 监听代替完整启动。
func (m *backendManager) waitForRemoteContext(ctx context.Context, timeout time.Duration) (string, error) {
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	timedOut := false
	for {
		observation, changed := m.Observe()
		status := observation.Status
		// 退出和取消优先于已记录的失败，避免正常关闭时弹窗。
		if ctx.Err() != nil || status.Phase == phaseStopping || status.Phase == phaseOffline {
			return "", errRemoteStopped
		}
		if observation.RemoteError != "" {
			return "", errors.New(observation.RemoteError)
		}
		if status.RemoteState == "failed" || status.RemoteError != "" {
			detail := status.RemoteError
			if detail == "" {
				detail = "远程服务启用失败"
			}
			return "", m.remoteFailure(detail)
		}
		if status.Phase == phaseFailed {
			detail := status.Detail
			if detail == "" {
				detail = "后台启动或运行失败"
			}
			return "", m.remoteFailure(detail)
		}
		if !observation.RemoteRequested && remoteReady(status) && status.HasURLs && status.URLs.Admin != "" {
			return status.URLs.Admin, nil
		}
		if timedOut {
			return "", m.remoteFailure("等待远程服务就绪超时，未收到后台确认")
		}
		select {
		case <-ctx.Done():
			return "", errRemoteStopped
		case <-changed:
		case <-timer.C:
			// 到期后再读一次，保留同时到达的退出或就绪状态。
			timedOut = true
		}
	}
}

func (m *backendManager) remoteActionMenu(action remoteAction) remoteMenuState {
	state := remoteMenuState{Label: action.label() + "远程服务"}
	if m == nil {
		return state
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	state.Enabled = !m.remoteRequested && m.remoteError == "" && m.status.RemoteError == "" &&
		m.status.Phase == phaseReady && m.status.RemoteState == "ready" && m.status.RemoteEnabled && m.cmd != nil && m.stdin != nil
	return state
}

func (m *backendManager) StopRemoteMenu() remoteMenuState { return m.remoteActionMenu(remoteStop) }
func (m *backendManager) RestartRemoteMenu() remoteMenuState {
	return m.remoteActionMenu(remoteRestart)
}

// 等待保留的请求结果，不会因另一个动作已改变当前快照而漏掉真实完成事件。
func (m *backendManager) waitForRemoteRequest(ctx context.Context, request *remoteRequest, timeout time.Duration) error {
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	timedOut := false
	for {
		observation, changed := m.Observe()
		status := observation.Status
		if ctx.Err() != nil || status.Phase == phaseStopping || status.Phase == phaseOffline {
			return errRemoteStopped
		}
		if observation.RemoteError != "" {
			return errors.New(observation.RemoteError)
		}
		if status.RemoteState == "failed" || status.RemoteError != "" || status.Phase == phaseFailed {
			detail := status.RemoteError
			if detail == "" {
				detail = status.Detail
			}
			if detail == "" {
				detail = "远程服务操作失败"
			}
			return m.remoteFailure(detail)
		}
		m.mu.Lock()
		completed := request.completed
		m.mu.Unlock()
		if completed {
			return nil
		}
		if timedOut {
			return m.remoteFailure("等待远程服务" + request.action.label() + "完成超时，未收到后台确认")
		}
		select {
		case <-ctx.Done():
			return errRemoteStopped
		case <-changed:
		case <-timer.C:
			timedOut = true
		}
	}
}
