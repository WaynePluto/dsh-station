package main

import (
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func newTestManager() *backendManager {
	return newBackendManager(desktopPayload{}, "token", nil)
}

func TestBackendLogsRedactTokenURLs(t *testing.T) {
	line := "[dsh] dsh web: http://127.0.0.1:3180/?token=private-token (LAN: unavailable)"
	if got := backendTokenPattern.ReplaceAllString(line, "${1}[redacted]"); contains(got, "private-token") || !contains(got, "?token=[redacted]") {
		t.Fatal("普通后台日志不能落盘浏览器 token")
	}
}

func TestApplyLineAcceptsStatusMessages(t *testing.T) {
	manager := newTestManager()
	manager.applyLine(`{"type":"status","protocol":1,"phase":"ready","detail":"就绪","urls":{"local":"http://127.0.0.1:30809/","admin":"http://127.0.0.1:30809/_admin","dsh":"http://127.0.0.1:3080/"},"adminReady":false,"dshToken":"tok_base64url","remoteEnabled":true}`)
	status := manager.Status()
	if status.Phase != phaseReady || !status.HasURLs || status.AdminReady {
		t.Fatalf("状态解析错误: %+v", status)
	}
	if status.URLs.Local != "http://127.0.0.1:30809/" || status.URLs.Admin != "http://127.0.0.1:30809/_admin" {
		t.Fatalf("URL 解析错误: %+v", status.URLs)
	}
	if status.DshToken != "tok_base64url" || !status.RemoteEnabled {
		t.Fatalf("本机模式字段解析错误: dshToken=%q remoteEnabled=%v", status.DshToken, status.RemoteEnabled)
	}
	// 非 ready 阶段不带 urls 时不得残留上一阶段的 URL。
	manager.applyLine(`{"type":"status","protocol":1,"phase":"restarting"}`)
	status = manager.Status()
	if status.HasURLs {
		t.Fatalf("无 URL 消息不应保留旧 URL: %+v", status)
	}
}

func TestApplyLineRejectsUnknownProtocol(t *testing.T) {
	manager := newTestManager()
	before := manager.Status()
	manager.applyLine(`{"type":"status","protocol":2,"phase":"ready"}`)
	after := manager.Status()
	if after.Phase != before.Phase {
		t.Fatalf("未知协议版本不得改变状态: %+v → %+v", before, after)
	}
}

func TestApplyLineHandlesStartupFailure(t *testing.T) {
	manager := newTestManager()
	manager.applyLine(`{"type":"exit","protocol":1,"message":"配置文件无效"}`)
	status := manager.Status()
	if status.Phase != phaseFailed || status.Detail != "配置文件无效" {
		t.Fatalf("启动失败未进入 failed: %+v", status)
	}
}

func TestStatusHandlerRedirectsWhenReady(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	manager := newTestManager()
	// 远程已按需启用（D25）且 relay 端口在监听：就绪后放行进 relay。
	manager.setStatus(backendStatus{
		Phase:         phaseReady,
		HasURLs:       true,
		RemoteEnabled: true,
		URLs:          backendURLs{Local: "http://" + listener.Addr().String() + "/", Admin: "http://" + listener.Addr().String() + "/_admin", Dsh: "http://127.0.0.1:3080/"},
	})
	handler := statusHandler(manager)
	request := httptest.NewRequest(http.MethodGet, "http://wails.localhost/", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusFound || response.Header().Get("Location") != "http://"+listener.Addr().String()+"/" {
		t.Fatalf("就绪后应 302 进本机 relay: %d %q", response.Code, response.Header().Get("Location"))
	}
}

func TestStatusHandlerRedirectsDirectInLocalMode(t *testing.T) {
	manager := newTestManager()
	// 本机模式（D25）：远程未启用，dsh 就绪且 token 已上报，
	// 初始导航直连 dsh 的 loopback 并代发一次 /?token= 交换。
	manager.setStatus(backendStatus{
		Phase:    phaseReady,
		HasURLs:  true,
		DshToken: "tok_base64url",
		URLs:     backendURLs{Local: "http://127.0.0.1:3080/", Admin: "http://127.0.0.1:30809/_admin", Dsh: "http://127.0.0.1:3080/"},
	})
	handler := statusHandler(manager)
	request := httptest.NewRequest(http.MethodGet, "http://wails.localhost/", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	want := "http://127.0.0.1:3080/?token=tok_base64url"
	if response.Code != http.StatusFound || response.Header().Get("Location") != want {
		t.Fatalf("本机模式应 302 直连 dsh 并携带 token: %d %q", response.Code, response.Header().Get("Location"))
	}
}

func TestStatusHandlerRendersFailurePageImmediately(t *testing.T) {
	manager := newTestManager()
	manager.setStatus(backendStatus{Phase: phaseFailed, Detail: "端口被占用"})
	handler := statusHandler(manager)
	request := httptest.NewRequest(http.MethodGet, "http://wails.localhost/", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("失败应立即返回状态页: %d", response.Code)
	}
	body := response.Body.String()
	if !contains(body, "后台异常") || !contains(body, "端口被占用") {
		t.Fatalf("状态页缺少失败信息: %s", body)
	}
	// 非 GET 请求与业务路径一律 404，AssetServer 不碰业务。
	request = httptest.NewRequest(http.MethodPost, "http://wails.localhost/", nil)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusNotFound {
		t.Fatalf("非 GET 应 404: %d", response.Code)
	}
}

func TestStatusHandlerHoldsUntilReady(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	manager := newTestManager()
	handler := statusHandler(manager)
	request := httptest.NewRequest(http.MethodGet, "http://wails.localhost/", nil)
	// 在持有期间后台完成远程启用并就绪：初始导航应被 302 放行进 relay。
	go func() {
		for i := 0; i < 10 && manager.Status().Phase != phaseRemote; i++ {
			time.Sleep(20 * time.Millisecond)
		}
		manager.setStatus(backendStatus{
			Phase:         phaseReady,
			HasURLs:       true,
			RemoteEnabled: true,
			URLs:          backendURLs{Local: "http://" + listener.Addr().String() + "/", Admin: "http://" + listener.Addr().String() + "/_admin", Dsh: "http://127.0.0.1:3080/"},
		})
	}()
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusFound || response.Header().Get("Location") != "http://"+listener.Addr().String()+"/" {
		t.Fatalf("持有期间就绪应 302 进 relay: %d %q", response.Code, response.Header().Get("Location"))
	}
}

func TestStatusHandlerRedirectsOnceRelayListens(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	manager := newTestManager()
	// 「启用远程服务」进行中（phaseRemote）：初始导航继续持有；
	// relay 端口监听且回到 ready 后立即放行，剩余等待由 relay 重试页承担。
	manager.setStatus(backendStatus{
		Phase:         phaseRemote,
		HasURLs:       true,
		RemoteEnabled: true,
		URLs:          backendURLs{Local: "http://" + listener.Addr().String() + "/", Admin: "http://" + listener.Addr().String() + "/_admin", Dsh: "http://127.0.0.1:3080/"},
	})
	handler := statusHandler(manager)
	request := httptest.NewRequest(http.MethodGet, "http://wails.localhost/", nil)
	response := httptest.NewRecorder()
	go func() {
		for i := 0; i < 10 && manager.Status().Phase != phaseRemote; i++ {
			time.Sleep(20 * time.Millisecond)
		}
		manager.setStatus(backendStatus{
			Phase:         phaseReady,
			HasURLs:       true,
			RemoteEnabled: true,
			URLs:          backendURLs{Local: "http://" + listener.Addr().String() + "/", Admin: "http://" + listener.Addr().String() + "/_admin", Dsh: "http://127.0.0.1:3080/"},
		})
	}()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusFound || response.Header().Get("Location") != "http://"+listener.Addr().String()+"/" {
		t.Fatalf("relay 监听后应 302 进本机 relay: %d %q", response.Code, response.Header().Get("Location"))
	}
}

func contains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && (haystack == needle || len(needle) == 0 || indexOf(haystack, needle) >= 0)
}

func indexOf(haystack, needle string) int {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return i
		}
	}
	return -1
}
