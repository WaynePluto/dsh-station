package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

// 托盘控制与管理入口共享本机状态和请求去重；HTTP 加载页永远只有读权限。
type desktopNavigation struct {
	manager *backendManager
	resolve func() (string, string)
	open    func(string, bool)
	report  func(error)
	// 停止指令前让内置 relay 文档退出；回调自行核对当前来源，不控制外部浏览器。
	beforeRemoteStop func(backendStatus)
	mu               sync.Mutex
	loading          *adminLoadingServer
	pending          bool
	active           *remoteRequest
	wantAdmin        bool
	closed           bool
	cancel           context.CancelFunc
}

func (n *desktopNavigation) remoteView() remoteAdminView {
	view, _ := n.observeRemote()
	return view
}

func (n *desktopNavigation) observeRemote() (remoteAdminView, <-chan struct{}) {
	observation, changed := n.manager.Observe()
	return remoteAdminViewFor(observation), changed
}

func remoteAdminViewFor(observation backendObservation) remoteAdminView {
	status := observation.Status
	failure := observation.RemoteError
	if failure == "" {
		failure = status.RemoteError
	}
	if failure != "" || status.RemoteState == "failed" || status.Phase == phaseFailed || status.Phase == phaseOffline || status.Phase == phaseStopping {
		if failure == "" {
			failure = status.Detail
		}
		return remoteAdminView{State: "failed", Detail: failure}
	}
	if !observation.RemoteRequested && remoteReady(status) && status.HasURLs {
		return remoteAdminView{State: "ready", AdminURL: status.URLs.Admin}
	}
	return remoteAdminView{State: "starting"}
}

// 加载页在启用命令前打开，哪怕后台尚未监听，也有立即可见的操作反馈。
func (n *desktopNavigation) OpenAdmin(external bool) {
	n.mu.Lock()
	if n.closed {
		n.mu.Unlock()
		return
	}
	if n.manager == nil {
		_, admin := n.resolve()
		n.mu.Unlock()
		n.open(admin, external)
		return
	}
	if view := n.remoteView(); view.State == "ready" && validAdminLoadingTarget(view.AdminURL) {
		n.mu.Unlock()
		n.open(view.AdminURL, external)
		return
	}
	if n.loading != nil {
		stale := !time.Now().Before(n.loading.page.deadline)
		select {
		case <-n.loading.done:
			stale = true
		case <-n.loading.terminal:
			stale = true
		default:
		}
		if stale {
			// 上一次加载已结束；新一轮操作不能复用过期的等待期限。
			old := n.loading
			n.loading = nil
			go old.Close()
		}
	}
	if n.loading == nil {
		server, err := newAdminLoadingServer(n.observeRemote)
		if err != nil {
			n.mu.Unlock()
			n.report(fmt.Errorf("无法打开远程管理加载页：%w", err))
			return
		}
		n.loading = server
	}
	address := n.loading.URL()
	n.wantAdmin = true
	n.mu.Unlock()
	n.open(address, external)
	n.StartRemote()
}

func (n *desktopNavigation) StartRemote()   { n.runRemote(remoteStart) }
func (n *desktopNavigation) StopRemote()    { n.runRemote(remoteStop) }
func (n *desktopNavigation) RestartRemote() { n.runRemote(remoteRestart) }

func (n *desktopNavigation) runRemote(action remoteAction) {
	if n.manager == nil {
		return
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.closed {
		return
	}
	if n.pending {
		n.manager.mu.Lock()
		completed := n.active != nil && n.active.completed
		n.manager.mu.Unlock()
		if !completed {
			return
		}
	}
	n.beginRemoteLocked(action)
}

// 在返回调用者之前占位，异步部分只负责管道写入与事件等待。
func (n *desktopNavigation) beginRemoteLocked(action remoteAction) {
	n.pending = true
	ctx, cancel := context.WithCancel(context.Background())
	n.cancel = cancel
	request, send, reserveErr := n.manager.reserveRemote(action)
	n.active = request
	if request != nil {
		action = request.action
	}
	go func() {
		defer cancel()
		err := reserveErr
		if ctx.Err() != nil {
			err = errRemoteStopped
		} else if err == nil && send {
			if action != remoteStart && n.beforeRemoteStop != nil {
				n.beforeRemoteStop(n.manager.Status())
			}
			if ctx.Err() != nil {
				err = errRemoteStopped
			} else {
				err = n.manager.sendRemote(request)
			}
		}
		if err == nil {
			if request != nil {
				err = n.manager.waitForRemoteRequest(ctx, request, action.timeout())
			} else {
				_, err = n.manager.waitForRemoteContext(ctx, remoteStart.timeout())
			}
		} else if !errors.Is(err, errRemoteStopped) {
			n.manager.remoteFailure(err.Error())
		}
		n.mu.Lock()
		if n.active != request {
			// 完成后用户已开始下一动作，旧等待者不能清理新请求。
			n.mu.Unlock()
			return
		}
		n.active = nil
		n.pending = false
		n.cancel = nil
		showError := !n.closed && (action != remoteStart || n.loading == nil)
		openAfterStop := !n.closed && err == nil && action == remoteStop && n.wantAdmin
		n.wantAdmin = false
		if openAfterStop {
			// 只有用户在停止期间明确打开管理页，才在真实 idle 后重新启用。
			n.beginRemoteLocked(remoteStart)
		}
		n.mu.Unlock()
		if showError && err != nil && !errors.Is(err, errRemoteStopped) {
			n.report(fmt.Errorf("无法%s远程服务：%w", action.label(), err))
		}
	}()
}

func (n *desktopNavigation) Close() {
	n.mu.Lock()
	n.closed = true
	loading, cancel := n.loading, n.cancel
	n.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if loading != nil {
		_ = loading.Close()
	}
}

func bindingOrigin(address string) (string, error) {
	parsed, err := parseLoopbackRelayURL(address)
	if err != nil {
		return "", err
	}
	return strings.TrimSuffix(parsed.relay, "/"), nil
}

func validateBackendURLs(urls backendURLs) error {
	if _, err := bindingOrigin(urls.Dsh); err != nil {
		return err
	}
	if !validAdminLoadingTarget(urls.Admin) {
		return errors.New("invalid loopback admin URL")
	}
	relay := strings.TrimSuffix(urls.Admin, "_admin")
	if urls.Local != urls.Dsh && urls.Local != relay {
		return errors.New("local URL is not the configured dsh or relay")
	}
	return nil
}

func backendBindingOrigins(urls backendURLs) (string, error) {
	if err := validateBackendURLs(urls); err != nil {
		return "", err
	}
	dsh := strings.TrimSuffix(urls.Dsh, "/")
	relay := strings.TrimSuffix(urls.Admin, "/_admin")
	if dsh == relay {
		return dsh, nil
	}
	return dsh + "," + relay, nil
}

// 只等待启动初期的无凭据地址握手，不等待插件构建或 dsh 就绪。
func (m *backendManager) waitForURLConfig(timeout time.Duration) (backendURLs, error) {
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	timedOut := false
	for {
		observation, changed := m.Observe()
		status := observation.Status
		if status.Phase == phaseFailed {
			return backendURLs{}, errors.New(status.Detail)
		}
		if status.HasURLs {
			return status.URLs, validateBackendURLs(status.URLs)
		}
		if status.Phase == phaseStopping || status.Phase == phaseOffline {
			return backendURLs{}, errRemoteStopped
		}
		if timedOut {
			return backendURLs{}, errors.New("后台未在启动时限内上报本机入口配置")
		}
		select {
		case <-changed:
		case <-timer.C:
			timedOut = true
		}
	}
}
