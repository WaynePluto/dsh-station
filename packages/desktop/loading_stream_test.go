package main

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func openLoadingStream(t *testing.T, s *adminLoadingServer, timeouts ...time.Duration) (*http.Response, *bufio.Reader) {
	t.Helper()
	transport := &http.Transport{Proxy: nil}
	t.Cleanup(transport.CloseIdleConnections)
	timeout := 6 * time.Second
	if len(timeouts) > 0 {
		timeout = timeouts[0]
	}
	client := &http.Client{Transport: transport, Timeout: timeout}
	request, _ := http.NewRequest("GET", s.URL()+"/events", nil)
	request.Header = http.Header{"Origin": {s.origin}, "Sec-Fetch-Site": {"same-origin"}, "Sec-Fetch-Mode": {"same-origin"}, "Sec-Fetch-Dest": {"empty"}}
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { response.Body.Close() })
	if response.StatusCode != 200 || response.Header.Get("Content-Type") != "application/x-ndjson; charset=utf-8" {
		t.Fatal("不是状态流")
	}
	for _, header := range []string{"Location", "Set-Cookie", "Access-Control-Allow-Origin", "Content-Length"} {
		if response.Header.Get(header) != "" {
			t.Fatalf("不应设置%s", header)
		}
	}
	if response.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("状态流不可缓存")
	}
	return response, bufio.NewReader(response.Body)
}

func readLoadingFrame(t *testing.T, reader *bufio.Reader) map[string]any {
	t.Helper()
	line, err := reader.ReadBytes('\n')
	if err != nil {
		t.Fatal(err)
	}
	if len(line) > loadingFrameLimit {
		t.Fatal("状态帧超长")
	}
	var result map[string]any
	if json.Unmarshal(line, &result) != nil {
		t.Fatal("状态帧不是单行JSON")
	}
	if strings.Contains(string(line), "private_token") || strings.Contains(string(line), "dshToken") {
		t.Fatal("状态帧泄露token")
	}
	return result
}

func TestLoadingStreamInitialSnapshotAndImmediateChanges(t *testing.T) {
	manager := newTestManager()
	manager.setStatus(backendStatus{Phase: phaseConfig})
	s := startupTestServer(t, manager)
	var calls atomic.Int32
	observe := s.page.observe
	s.page.observe = func(expired bool) loadingUpdate { calls.Add(1); return observe(expired) }
	response, reader := openLoadingStream(t, s)
	if readLoadingFrame(t, reader)["state"] != "starting" {
		t.Fatal("应立即推送当前快照")
	}
	time.Sleep(250 * time.Millisecond)
	if calls.Load() != 1 {
		t.Fatal("没有事件时不应再次查询")
	}
	manager.setStatus(backendStatus{Phase: phasePlugins})
	if readLoadingFrame(t, reader)["phase"] != "正在准备插件…" {
		t.Fatal("阶段事件丢失")
	}
	manager.setStatus(startupReadyStatus())
	if readLoadingFrame(t, reader)["state"] != "ready" {
		t.Fatal("ready事件丢失")
	}
	if _, err := reader.ReadByte(); err != io.EOF {
		t.Fatalf("终态必须结束流：%v", err)
	}
	response.Body.Close()
	select {
	case <-s.terminal:
		t.Fatal("启动ready不能先于认证交接回收服务")
	default:
	}
}

func TestLoadingStreamClosesRaceBetweenSnapshotAndWait(t *testing.T) {
	manager := newTestManager()
	manager.setStatus(backendStatus{Phase: phaseConfig})
	s := startupTestServer(t, manager)
	observe := s.page.observe
	var calls atomic.Int32
	s.page.observe = func(expired bool) loadingUpdate {
		update := observe(expired)
		if calls.Add(1) == 1 {
			manager.setStatus(startupReadyStatus())
		}
		return update
	}
	_, reader := openLoadingStream(t, s)
	if readLoadingFrame(t, reader)["state"] != "starting" || readLoadingFrame(t, reader)["state"] != "ready" {
		t.Fatal("订阅空窗丢失ready")
	}
}

func TestLoadingStreamMultipleClientsAndShellFailure(t *testing.T) {
	manager := newTestManager()
	manager.setStatus(startupReadyStatus())
	navigation := &desktopNavigation{manager: manager}
	s, err := newAdminLoadingServer(navigation.observeRemote)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	readers := make([]*bufio.Reader, 4)
	for i := range readers {
		_, readers[i] = openLoadingStream(t, s)
		if readLoadingFrame(t, readers[i])["state"] != "starting" {
			t.Fatal("初始状态错误")
		}
	}
	manager.remoteFailure("EADDRINUSE private_token")
	for _, reader := range readers {
		payload := readLoadingFrame(t, reader)
		if payload["state"] != "failed" || payload["detail"] != adminLoadingPortBusy {
			t.Fatal("壳侧失败未推送或未脱敏")
		}
	}
}

func TestLoadingStreamAlreadyReadyAndIdleBeyondWriteTimeout(t *testing.T) {
	t.Run("already ready", func(t *testing.T) {
		manager := newTestManager()
		manager.setStatus(startupReadyStatus())
		s := startupTestServer(t, manager)
		_, reader := openLoadingStream(t, s)
		if readLoadingFrame(t, reader)["state"] != "ready" {
			t.Fatal("初始ready被遗漏")
		}
	})
	t.Run("idle remains open", func(t *testing.T) {
		manager := newTestManager()
		manager.setStatus(backendStatus{Phase: phaseDsh})
		s := startupTestServer(t, manager)
		_, reader := openLoadingStream(t, s)
		readLoadingFrame(t, reader)
		time.Sleep(loadingWriteTimeout + 100*time.Millisecond)
		manager.setStatus(startupReadyStatus())
		if readLoadingFrame(t, reader)["state"] != "ready" {
			t.Fatal("长流被3秒写超时中断")
		}
	})
}

func TestLoadingStreamDeadlineCancelAndServerClose(t *testing.T) {
	t.Run("deadline without change", func(t *testing.T) {
		manager := newTestManager()
		manager.setStatus(backendStatus{Phase: phaseDsh})
		s := startupTestServer(t, manager)
		s.page.deadline = time.Now().Add(60 * time.Millisecond)
		_, reader := openLoadingStream(t, s)
		readLoadingFrame(t, reader)
		value := readLoadingFrame(t, reader)
		if value["state"] != "failed" || value["detail"] != startupLoadingTimeout {
			t.Fatal("总期限必须推送终态")
		}
	})
	t.Run("close with stream", func(t *testing.T) {
		manager := newTestManager()
		manager.setStatus(backendStatus{Phase: phaseDsh})
		s := startupTestServer(t, manager)
		_, reader := openLoadingStream(t, s)
		readLoadingFrame(t, reader)
		s.Close()
		if _, err := reader.ReadByte(); err == nil {
			t.Fatal("关闭服务未终止流")
		}
	})
	t.Run("client cancels", func(t *testing.T) {
		manager := newTestManager()
		manager.setStatus(backendStatus{Phase: phaseDsh})
		s := startupTestServer(t, manager)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		req, _ := http.NewRequestWithContext(ctx, "GET", s.URL()+"/events", nil)
		client := adminLoadingTestClient(t)
		response, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		readLoadingFrame(t, bufio.NewReader(response.Body))
		cancel()
		_, err = io.ReadAll(response.Body)
		response.Body.Close()
		if err == nil {
			t.Fatal("客户端取消没有中止流")
		}
		manager.setStatus(startupReadyStatus())
		_, reader := openLoadingStream(t, s)
		if readLoadingFrame(t, reader)["state"] != "ready" {
			t.Fatal("旧客户端取消影响新订阅")
		}
	})
}

func TestLoadingStreamRejectsUnsafeRequestsAndOversizedFrames(t *testing.T) {
	manager := newTestManager()
	manager.setStatus(startupReadyStatus())
	s := startupTestServer(t, manager)
	client := adminLoadingTestClient(t)
	for _, test := range []struct {
		method, path string
		headers      http.Header
		want         int
	}{
		{"GET", s.path + "/events?target=evil", nil, 404},
		{"POST", s.path + "/events", nil, 405},
		{"HEAD", s.path + "/events", nil, 405},
		{"GET", s.path + "/events", http.Header{"Origin": {"https://evil.example"}}, 403},
		{"GET", s.path + "/events", http.Header{"Sec-Fetch-Site": {"same-site"}}, 403},
		{"GET", s.path + "/events", http.Header{"Sec-Fetch-Site": {"same-origin"}, "Sec-Fetch-Mode": {"navigate"}, "Sec-Fetch-Dest": {"iframe"}}, 403},
		{"GET", s.path + "/events", http.Header{"Host": {"evil.example"}}, 403},
	} {
		response, _ := adminLoadingTestRequest(t, client, test.method, s.origin+test.path, test.headers)
		if response.StatusCode != test.want {
			t.Fatalf("事件路由检查：%d，期望%d", response.StatusCode, test.want)
		}
	}
	s.page.observe = func(bool) loadingUpdate {
		return loadingUpdate{state: "ready", payload: map[string]string{"state": "ready", "detail": strings.Repeat("x", loadingFrameLimit)}}
	}
	response, err := client.Get(s.URL() + "/events")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if len(body) != 0 {
		t.Fatal("超长帧不应部分写出")
	}
}

func TestStartupRemoteEnableDoesNotDelayNativeEntry(t *testing.T) {
	status := startupReadyStatus()
	status.Phase = phaseRemote
	if startupLoadingState(status, false).State != "ready" {
		t.Fatal("本机已可用时不能因远程启用推迟原生交接")
	}
}
