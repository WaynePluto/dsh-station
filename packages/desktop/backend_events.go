package main

import "time"

// backendObservation 将后台快照与壳侧远程请求状态作为一个整体读取。
type backendObservation struct {
	Status          backendStatus
	RemoteRequested bool
	RemoteError     string
}

// Observe 同锁读取快照和下一次变更信号，避免先读状态再订阅时漏掉更新。
// 信号关闭后应重新 Observe；多次变更可以合并，但快照始终包含最新状态。
func (m *backendManager) Observe() (backendObservation, <-chan struct{}) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.change == nil {
		m.change = make(chan struct{})
	}
	return backendObservation{
		Status:          m.status,
		RemoteRequested: m.remoteRequested,
		RemoteError:     m.remoteError,
	}, m.change
}

// notifyLocked 调用者必须持有 m.mu；关闭旧信号可同时唤醒所有等待者。
// onChange 必须由调用者解锁后执行，以允许回调重新读取状态。
func (m *backendManager) notifyLocked() {
	if m.change != nil {
		close(m.change)
	}
	m.change = make(chan struct{})
}

// WaitForChange 保留兼容接口；需要先判断状态再等待的调用者应使用 Observe。
// 超时也读取当前状态，第二个返回值仅表示是否收到变更信号。
func (m *backendManager) WaitForChange(timeout time.Duration) (backendStatus, bool) {
	_, wait := m.Observe()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-wait:
		return m.Status(), true
	case <-timer.C:
		return m.Status(), false
	}
}
