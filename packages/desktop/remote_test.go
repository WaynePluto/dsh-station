package main

import (
	"errors"
	"io"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestRemoteMenuStates(t *testing.T) {
	for _, test := range []struct {
		name      string
		status    backendStatus
		requested bool
		failure   string
		want      remoteMenuState
	}{
		{"local", backendStatus{Phase: phaseReady}, false, "", remoteMenuState{"启用远程服务", true, false}},
		{"request sent", backendStatus{Phase: phaseReady}, true, "", remoteMenuState{"正在启用远程服务…", false, false}},
		{"starting", backendStatus{Phase: phaseRemote}, true, "", remoteMenuState{"正在启用远程服务…", false, false}},
		{"ready", backendStatus{Phase: phaseReady, RemoteEnabled: true}, true, "", remoteMenuState{"远程服务已启用", false, true}},
		{"restart", backendStatus{Phase: phaseRestarting, RemoteEnabled: true}, true, "", remoteMenuState{"远程服务已启用", false, true}},
		{"failed", backendStatus{Phase: phaseFailed}, true, "", remoteMenuState{"远程服务启用失败（请退出并重新打开）", false, false}},
		{"failed after ready", backendStatus{Phase: phaseFailed, RemoteEnabled: true}, true, "", remoteMenuState{"远程服务不可用（后台未运行）", false, false}},
		{"write failed", backendStatus{Phase: phaseReady}, true, "broken pipe", remoteMenuState{"远程服务启用失败（请退出并重新打开）", false, false}},
		{"offline", backendStatus{Phase: phaseOffline}, false, "", remoteMenuState{"远程服务不可用（后台未运行）", false, false}},
		{"stopping", backendStatus{Phase: phaseStopping}, true, "", remoteMenuState{"远程服务不可用（后台未运行）", false, false}},
		{"booting", backendStatus{Phase: phaseDsh}, false, "", remoteMenuState{"启用远程服务（等待工作站就绪）", false, false}},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := remoteMenuFor(test.status, test.requested, test.failure); got != test.want {
				t.Fatalf("菜单状态 = %+v，期望 %+v", got, test.want)
			}
		})
	}
	var attach *backendManager
	if got := attach.RemoteMenu(); got != (remoteMenuState{Label: "远程服务由开发栈管理"}) {
		t.Fatalf("开发模式不能显示启用操作：%+v", got)
	}
}

type remoteCommandWriter struct {
	mu      sync.Mutex
	writes  []string
	failure error
}

func (writer *remoteCommandWriter) Write(data []byte) (int, error) {
	writer.mu.Lock()
	defer writer.mu.Unlock()
	writer.writes = append(writer.writes, string(data))
	if writer.failure != nil {
		return 0, writer.failure
	}
	return len(data), nil
}

func (*remoteCommandWriter) Close() error { return nil }

func remoteTestManager(writer io.WriteCloser) *backendManager {
	manager := newTestManager()
	manager.cmd = &exec.Cmd{}
	manager.stdin = writer
	manager.status = backendStatus{Phase: phaseReady}
	return manager
}

func TestRemoteRequestIsDeduplicatedBeforeAcknowledgement(t *testing.T) {
	writer := &remoteCommandWriter{}
	manager := remoteTestManager(writer)
	var workers sync.WaitGroup
	for i := 0; i < 20; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			if err := manager.StartRemote(); err != nil {
				t.Errorf("发送失败：%v", err)
			}
		}()
	}
	workers.Wait()
	if len(writer.writes) != 1 || writer.writes[0] != "{\"type\":\"start-remote\"}\n" {
		t.Fatalf("应只发送一个控制帧：%q", writer.writes)
	}
	if menu := manager.RemoteMenu(); menu.Enabled || menu.Checked || menu.Label != "正在启用远程服务…" {
		t.Fatalf("收到确认前即应禁用：%+v", menu)
	}
}

func TestRemoteRequestErrorsAreVisible(t *testing.T) {
	manager := newTestManager()
	if err := manager.StartRemote(); err == nil {
		t.Fatal("后台未运行不能静默成功")
	}
	writer := &remoteCommandWriter{failure: errors.New("broken pipe")}
	manager = remoteTestManager(writer)
	if err := manager.StartRemote(); err == nil || !strings.Contains(err.Error(), "broken pipe") {
		t.Fatalf("应保留管道错误：%v", err)
	}
	if menu := manager.RemoteMenu(); menu.Enabled || !strings.Contains(menu.Label, "失败") {
		t.Fatalf("应显示失败并禁用：%+v", menu)
	}
	if err := manager.StartRemote(); err == nil || len(writer.writes) != 1 {
		t.Fatal("失败后不得静默重复发送")
	}
}

func TestRemoteRequestDoesNotStartAlreadyEnabledServices(t *testing.T) {
	writer := &remoteCommandWriter{}
	manager := remoteTestManager(writer)
	manager.status.RemoteEnabled = true
	if err := manager.StartRemote(); err != nil || len(writer.writes) != 0 {
		t.Fatalf("已经启用时不应发送：%v", err)
	}
}

func TestRemoteWaitRequiresReadyStatusAndAdminURL(t *testing.T) {
	manager := remoteTestManager(&remoteCommandWriter{})
	if err := manager.StartRemote(); err != nil {
		t.Fatal(err)
	}
	result := make(chan string, 1)
	go func() {
		admin, err := manager.waitForRemote(time.Second)
		if err != nil {
			result <- err.Error()
		} else {
			result <- admin
		}
	}()
	manager.applyLine(`{"type":"status","protocol":1,"phase":"remote","remoteEnabled":false,"urls":{"local":"http://127.0.0.1:3080/","admin":"http://127.0.0.1:30809/_admin","dsh":"http://127.0.0.1:3080/"}}`)
	select {
	case got := <-result:
		t.Fatalf("启动中不能提前打开：%s", got)
	case <-time.After(20 * time.Millisecond):
	}
	manager.applyLine(`{"type":"status","protocol":1,"phase":"ready","remoteEnabled":true,"urls":{"local":"http://127.0.0.1:30809/","admin":"http://127.0.0.1:30809/_admin","dsh":"http://127.0.0.1:3080/"}}`)
	select {
	case got := <-result:
		if got != "http://127.0.0.1:30809/_admin" {
			t.Fatalf("管理地址错误：%s", got)
		}
	case <-time.After(time.Second):
		t.Fatal("状态管道更新应唤醒等待者")
	}
}

func TestRemoteWaitReportsFailureTimeoutAndStop(t *testing.T) {
	manager := newTestManager()
	manager.setStatus(backendStatus{Phase: phaseFailed, Detail: "relay 端口冲突"})
	if _, err := manager.waitForRemote(time.Second); err == nil || err.Error() != "relay 端口冲突" {
		t.Fatalf("具体错误丢失：%v", err)
	}
	manager = newTestManager()
	manager.setStatus(backendStatus{Phase: phaseRemote})
	if _, err := manager.waitForRemote(time.Millisecond); err == nil || !strings.Contains(err.Error(), "超时") {
		t.Fatalf("应有超时反馈：%v", err)
	}
	if !strings.Contains(manager.RemoteMenu().Label, "失败") {
		t.Fatal("超时后菜单应停止显示启动中")
	}
	manager.setStatus(backendStatus{Phase: phaseStopping})
	if _, err := manager.waitForRemote(time.Second); !errors.Is(err, errRemoteStopped) {
		t.Fatalf("主动退出不应弹失败对话框：%v", err)
	}
}

func TestBackendExitPreservesReportedFailure(t *testing.T) {
	// 只运行会立即退出的版本查询，不启动真实 launcher/dsh。
	command := exec.Command("go", "version")
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	manager := newTestManager()
	manager.cmd = command
	manager.setStatus(backendStatus{Phase: phaseRemote})
	exited := make(chan struct{})
	stdoutDone := make(chan struct{})
	go manager.awaitExit(command, exited, stdoutDone)
	select {
	case <-exited:
		t.Fatal("读完状态管道前不能抢先结算退出")
	case <-time.After(20 * time.Millisecond):
	}
	manager.applyLine(`{"type":"status","protocol":1,"phase":"failed","detail":"启用远程服务失败：relay 端口冲突"}`)
	close(stdoutDone)
	select {
	case <-exited:
	case <-time.After(time.Second):
		t.Fatal("进程退出等待未完成")
	}
	if got := manager.Status().Detail; got != "启用远程服务失败：relay 端口冲突" {
		t.Fatalf("退出不得覆盖具体错误：%s", got)
	}
}
