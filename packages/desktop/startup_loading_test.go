package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func startupTestServer(t *testing.T, manager *backendManager) *adminLoadingServer {
	t.Helper()
	s, err := newStartupLoadingServer(manager)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func startupReadyStatus() backendStatus {
	return backendStatus{Phase: phaseReady, HasURLs: true, DshToken: "private_token",
		URLs: backendURLs{Local: "http://127.0.0.1:3180/", Dsh: "http://127.0.0.1:3180/", Admin: "http://127.0.0.1:31809/_admin"}}
}

func TestStartupPagePrecedesReadinessAndContainsNoCredentials(t *testing.T) {
	manager := newTestManager()
	manager.setStatus(backendStatus{Phase: phaseConfig, Detail: "private_token"})
	s := startupTestServer(t, manager)
	handler := startupAssetHandler(s.URL())
	w := httptest.NewRecorder()
	start := time.Now()
	handler.ServeHTTP(w, httptest.NewRequest("GET", "http://wails.localhost/", nil))
	if w.Code != 302 || w.Header().Get("Location") != s.URL() || time.Since(start) > 500*time.Millisecond {
		t.Fatal("初始导航不得等待 dsh 就绪")
	}
	client := adminLoadingTestClient(t)
	response, body := adminLoadingTestRequest(t, client, "GET", s.URL(), nil)
	if response.StatusCode != 200 || body != startupLoadingHTML || strings.Contains(body, "private_token") {
		t.Fatal("后台尚未就绪也必须立即返回无凭据的加载页")
	}
	for _, phase := range []backendPhase{phaseConfig, phasePlugins, phaseDsh, phaseReady, phaseFailed} {
		status := startupReadyStatus()
		status.Phase, status.Detail = phase, "private_token"
		manager.setStatus(status)
		_, body := adminLoadingTestRequest(t, client, "GET", s.URL()+"/status", nil)
		var payload startupLoadingPayload
		if err := json.Unmarshal([]byte(body), &payload); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(body, "private_token") || strings.Contains(body, "http:") || strings.Contains(body, "token") {
			t.Fatal("状态不能返回凭据或交接地址")
		}
		if payload != startupLoadingState(status, false) {
			t.Fatal("阶段没有同步")
		}
	}
	if manager.running() || manager.remoteRequested {
		t.Fatal("HTTP 请求不能启动任何后台")
	}
}

func TestStartupEntryOnlyRedirectsReadyTopLevelNavigation(t *testing.T) {
	manager := newTestManager()
	manager.setStatus(backendStatus{Phase: phasePlugins})
	s := startupTestServer(t, manager)
	client := adminLoadingTestClient(t)
	response, _ := adminLoadingTestRequest(t, client, "GET", s.URL()+"/enter", nil)
	if response.StatusCode != 503 {
		t.Fatal("后台未就绪不得认证交接")
	}
	manager.setStatus(startupReadyStatus())
	for _, headers := range []http.Header{
		{"Sec-Fetch-Site": {"cross-site"}, "Sec-Fetch-Mode": {"navigate"}, "Sec-Fetch-Dest": {"document"}},
		{"Sec-Fetch-Site": {"same-site"}, "Sec-Fetch-Mode": {"navigate"}, "Sec-Fetch-Dest": {"document"}},
		{"Sec-Fetch-Site": {"same-origin"}, "Sec-Fetch-Mode": {"cors"}, "Sec-Fetch-Dest": {"empty"}},
		{"Origin": {"null"}},
		{"Origin": {s.origin, s.origin}},
		{"Sec-Fetch-Site": {"same-origin"}, "Sec-Fetch-Mode": {"navigate"}, "Sec-Fetch-Dest": {"iframe"}},
	} {
		response, _ = adminLoadingTestRequest(t, client, "GET", s.URL()+"/enter", headers)
		if response.StatusCode != 403 {
			t.Fatalf("拒绝交接：%v", headers)
		}
	}
	for _, remote := range []bool{false, true} {
		status := startupReadyStatus()
		status.RemoteEnabled = remote
		want := status.URLs.Dsh + "?token=" + status.DshToken
		if remote {
			status.URLs.Local = "http://127.0.0.1:31809/"
			want = status.URLs.Local
		}
		manager.setStatus(status)
		r, _ := http.NewRequest("GET", s.URL()+"/enter", nil)
		r.Header = http.Header{"Sec-Fetch-Site": {"same-origin"}, "Sec-Fetch-Mode": {"navigate"}, "Sec-Fetch-Dest": {"document"}}
		response, err := client.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(response.Body)
		response.Body.Close()
		if response.StatusCode != 302 || response.Header.Get("Location") != want || len(body) != 0 {
			t.Fatal("只允许固定目标的无正文顶层302")
		}
		if response.Header.Get("Cache-Control") != "no-store" || response.Header.Get("Referrer-Policy") != "no-referrer" {
			t.Fatal("交接不得缓存或泄露来源")
		}
	}
}

func TestStartupStateFailsClosed(t *testing.T) {
	for _, phase := range []backendPhase{phaseFailed, phaseOffline, phaseStopping} {
		status := startupReadyStatus()
		status.Phase = phase
		if startupLoadingState(status, false).State != "failed" {
			t.Fatal("停止或异常状态不能交接")
		}
	}
	status := startupReadyStatus()
	if startupLoadingState(status, true).Detail != startupLoadingTimeout {
		t.Fatal("必须有等待上限")
	}
	status.DshToken = ""
	if startupLoadingState(status, false).State != "starting" {
		t.Fatal("只有ready阶段但无token不能交接")
	}
	status = startupReadyStatus()
	status.URLs.Dsh = "http://evil.example/"
	if startupLoadingState(status, false).State != "failed" {
		t.Fatal("不可信地址必须拒绝")
	}
	status = startupReadyStatus()
	status.HasURLs = false
	if startupLoadingState(status, false).State != "starting" {
		t.Fatal("地址尚未公布不能交接")
	}
	status = backendStatus{Phase: "private_token", Detail: "private_token"}
	if got := startupLoadingState(status, false); strings.Contains(got.Phase+got.Detail, "private_token") {
		t.Fatal("未知阶段不能泄露")
	}
	if _, err := newStartupLoadingServer(nil); err == nil {
		t.Fatal("缺少manager必须报错")
	}
}

func TestStartupPluginStageLabels(t *testing.T) {
	cases := []struct {
		stage string
		want  string
	}{
		{"", "正在准备插件…"},
		{"copy", "正在复制插件文件…"},
		{"deps", "正在准备插件依赖…"},
		{"install", "正在安装插件…"},
		{"unknown-stage", "正在准备插件…"},
	}
	for _, item := range cases {
		status := backendStatus{Phase: phasePlugins, PluginStage: item.stage}
		got := startupLoadingState(status, false)
		if got.State != "starting" || got.Phase != item.want {
			t.Fatalf("plugins+%q 文案错误: got %q want %q", item.stage, got.Phase, item.want)
		}
		if !strings.Contains(startupLoadingScript, "'"+item.want+"'") {
			t.Fatalf("加载页脚本的 labels 数组缺少文案 %q", item.want)
		}
	}
	// 子步骤标记只属于 plugins 阶段；其他阶段携带时沿用阶段默认文案。
	dsh := backendStatus{Phase: phaseDsh, PluginStage: "install"}
	if got := startupLoadingState(dsh, false); got.Phase != "正在启动 dsh…" {
		t.Fatalf("非 plugins 阶段不得使用插件子步骤文案: %q", got.Phase)
	}
	// 所有阶段的固定文案都必须出现在加载页脚本的 labels 数组里，
	// 否则浏览器端会静默回退到第一项文案。
	for _, phase := range []backendPhase{phaseConfig, phasePlugins, phaseDsh, phaseReady, phaseRelay, phaseRemote, phaseRestarting} {
		label := startupLoadingState(backendStatus{Phase: phase}, false).Phase
		if !strings.Contains(startupLoadingScript, "'"+label+"'") {
			t.Fatalf("加载页脚本的 labels 数组缺少阶段 %s 的文案 %q", phase, label)
		}
	}
}

func TestStartupRoutesAndContentPolicy(t *testing.T) {
	manager := newTestManager()
	manager.setStatus(startupReadyStatus())
	s := startupTestServer(t, manager)
	client := adminLoadingTestClient(t)
	for _, path := range []string{"/", "/enter", s.path + "/enter?next=http://evil.example", s.path + "/enter/", s.path + "/status?token=private_token"} {
		response, _ := adminLoadingTestRequest(t, client, "GET", s.origin+path, nil)
		if response.StatusCode != 404 {
			t.Fatal("额外路径和查询串必须拒绝")
		}
	}
	for _, method := range []string{"HEAD", "POST", "OPTIONS"} {
		response, _ := adminLoadingTestRequest(t, client, method, s.URL()+"/enter", nil)
		if response.StatusCode != 405 {
			t.Fatal("交接只允许 GET")
		}
	}
	response, body := adminLoadingTestRequest(t, client, "GET", s.URL(), nil)
	csp := response.Header.Get("Content-Security-Policy")
	if !strings.Contains(csp, adminLoadingHash(startupLoadingScript)) || !strings.Contains(csp, adminLoadingHash(adminLoadingStyle)) || strings.Contains(csp, "unsafe-inline") {
		t.Fatal("加载页只允许固定脚本和样式哈希")
	}
	for _, forbidden := range []string{"http-equiv=\"refresh\"", "location.reload", "window.go", "private_token"} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("不允许：%s", forbidden)
		}
	}
	if !strings.Contains(body, "location.replace(location.pathname + '/enter')") || !strings.Contains(body, "1s linear infinite") || !strings.Contains(body, "prefers-reduced-motion") {
		t.Fatal("必须保持动画、减少动态效果与固定顶层交接")
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Get(s.URL()); err == nil {
		t.Fatal("关闭壳必须回收加载监听")
	}
}
