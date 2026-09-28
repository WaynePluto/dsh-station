package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func staticAdminObserver(snapshot func() remoteAdminView) remoteAdminObserver {
	return func() (remoteAdminView, <-chan struct{}) { return snapshot(), nil }
}

func adminLoadingTestServer(t *testing.T, snapshot func() remoteAdminView, lifetime, grace time.Duration) *adminLoadingServer {
	t.Helper()
	s, err := newAdminLoadingServerWithLifetime(staticAdminObserver(snapshot), lifetime, grace)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := s.Close(); err != nil {
			t.Errorf("Close: %v", err)
		}
	})
	return s
}

func adminLoadingTestClient(t *testing.T) *http.Client {
	t.Helper()
	transport := &http.Transport{Proxy: nil}
	t.Cleanup(transport.CloseIdleConnections)
	return &http.Client{Transport: transport, Timeout: time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
		return http.ErrUseLastResponse
	}}
}

func adminLoadingTestRequest(t *testing.T, client *http.Client, method, target string, headers http.Header) (*http.Response, string) {
	t.Helper()
	r, err := http.NewRequest(method, target, nil)
	if err != nil {
		t.Fatal(err)
	}
	r.Header = headers.Clone()
	if host := r.Header.Get("Host"); host != "" {
		r.Host = host
		r.Header.Del("Host")
	}
	response, err := client.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 32<<10))
	if err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]string{
		"Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
		"X-Frame-Options": "DENY", "Cross-Origin-Resource-Policy": "same-origin",
	} {
		if got := response.Header.Get(name); got != want {
			t.Errorf("%s = %q, want %q", name, got, want)
		}
	}
	if !strings.Contains(response.Header.Get("Content-Security-Policy"), "frame-ancestors 'none'") {
		t.Error("missing frame-ancestors")
	}
	for _, name := range []string{"Access-Control-Allow-Origin", "Access-Control-Allow-Credentials", "Set-Cookie", "Location"} {
		if response.Header.Get(name) != "" {
			t.Errorf("unexpected %s", name)
		}
	}
	return response, string(body)
}

func adminLoadingTestState(t *testing.T, client *http.Client, s *adminLoadingServer) adminLoadingPayload {
	t.Helper()
	response, body := adminLoadingTestRequest(t, client, "GET", s.URL()+"/status", http.Header{
		"Origin": {s.origin}, "Sec-Fetch-Site": {"same-origin"}, "Sec-Fetch-Mode": {"same-origin"}, "Sec-Fetch-Dest": {"empty"},
	})
	if response.StatusCode != 200 || response.Header.Get("Content-Type") != "application/json; charset=utf-8" {
		t.Fatalf("invalid state response: %d %s", response.StatusCode, body)
	}
	var payload adminLoadingPayload
	if err := json.Unmarshal([]byte(body), &payload); err != nil {
		t.Fatal(err)
	}
	return payload
}

func TestAdminLoadingPageIsImmediateAndDoesNotReadState(t *testing.T) {
	var calls atomic.Int32
	s, err := newAdminLoadingServer(staticAdminObserver(func() remoteAdminView {
		calls.Add(1)
		panic("page and construction must not read state")
	}))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	client := adminLoadingTestClient(t)
	for _, method := range []string{"GET", "HEAD"} {
		start := time.Now()
		response, body := adminLoadingTestRequest(t, client, method, s.URL(), nil)
		if response.StatusCode != 200 || time.Since(start) > 500*time.Millisecond {
			t.Fatalf("page must respond immediately: %d", response.StatusCode)
		}
		if response.ContentLength != int64(len(adminLoadingHTML)) {
			t.Fatal("HEAD and GET must advertise the same document length")
		}
		if method == "GET" && !strings.Contains(body, "正在启用远程服务…") {
			t.Fatal("missing immediate loading message")
		}
		if method == "HEAD" && body != "" {
			t.Fatal("HEAD has a body")
		}
	}
	if calls.Load() != 0 {
		t.Fatal("HTTP navigation or creation read the backend")
	}
}

func TestAdminLoadingCapabilityIsRandomAndPerService(t *testing.T) {
	seen := map[string]bool{}
	for range 8 {
		s := adminLoadingTestServer(t, func() remoteAdminView { return remoteAdminView{State: "starting"} }, time.Minute, time.Second)
		secret, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(s.path, "/"))
		if err != nil || len(secret) != 32 || seen[s.path] {
			t.Fatal("capability must contain 32 random bytes and be unique per service")
		}
		seen[s.path] = true
		if !strings.HasPrefix(s.URL(), "http://127.0.0.1:") {
			t.Fatalf("not an IPv4 loopback listener: %s", s.origin)
		}
	}
}

func TestAdminLoadingStateTransitionsNeverExposeRawDetail(t *testing.T) {
	var view atomic.Value
	view.Store(remoteAdminView{State: "starting", Detail: "secret-token", AdminURL: "http://127.0.0.1:9/?token=secret-token"})
	s := adminLoadingTestServer(t, func() remoteAdminView { return view.Load().(remoteAdminView) }, time.Minute, time.Second)
	client := adminLoadingTestClient(t)
	if got := adminLoadingTestState(t, client, s); got != (adminLoadingPayload{State: "starting"}) {
		t.Fatalf("unexpected starting state: %+v", got)
	}
	view.Store(remoteAdminView{State: "ready", AdminURL: "http://127.0.0.1:31809/_admin", Detail: "secret-token"})
	for range 4 {
		if got := adminLoadingTestState(t, client, s); got != (adminLoadingPayload{State: "ready", AdminURL: "http://127.0.0.1:31809/_admin"}) {
			t.Fatalf("multiple pages must be able to observe readiness: %+v", got)
		}
	}
	view.Store(remoteAdminView{State: "failed", Detail: "<script>alert(1)</script> token=secret-token", AdminURL: "http://127.0.0.1:9/?token=secret-token"})
	if got := adminLoadingTestState(t, client, s); got != (adminLoadingPayload{State: "failed", Detail: adminLoadingFailure}) {
		t.Fatalf("raw backend failure must be replaced: %+v", got)
	}
	response, body := adminLoadingTestRequest(t, client, "GET", s.URL(), nil)
	if response.StatusCode != 200 || body != adminLoadingHTML || strings.Contains(body, "secret-token") {
		t.Fatal("even terminal navigation must return the immediate fixed document")
	}
}

func TestAdminLoadingSecurityAndReadOnlyRoutes(t *testing.T) {
	var calls atomic.Int32
	s := adminLoadingTestServer(t, func() remoteAdminView {
		calls.Add(1)
		return remoteAdminView{State: "starting"}
	}, time.Minute, time.Second)
	client := adminLoadingTestClient(t)
	for _, test := range []struct {
		name, method, path string
		headers            http.Header
		want               int
	}{
		{"missing capability", "GET", "/", nil, 404},
		{"unknown capability", "GET", "/" + strings.Repeat("x", 43), nil, 404},
		{"bare status", "GET", "/status", nil, 404},
		{"unknown path", "GET", s.path + "/other", nil, 404},
		{"trailing slash", "GET", s.path + "/", nil, 404},
		{"query", "GET", s.path + "?token=secret", nil, 404},
		{"status query", "GET", s.path + "/status?next=evil", nil, 404},
		{"encoded capability", "GET", fmt.Sprintf("/%%%02X", s.path[1]) + s.path[2:], nil, 404},
		{"dot segment", "GET", s.path + "/../" + s.path[1:], nil, 404},
		{"double slash", "GET", "/" + s.path, nil, 404},
		{"wrong host", "GET", s.path, http.Header{"Host": {"localhost:12345"}}, 403},
		{"rebinding host", "GET", s.path, http.Header{"Host": {"attacker.example"}, "X-Forwarded-For": {"127.0.0.1"}}, 403},
		{"wrong port", "GET", s.path, http.Header{"Host": {"127.0.0.1:1"}}, 403},
		{"no port", "GET", s.path, http.Header{"Host": {"127.0.0.1"}}, 403},
		{"status HEAD", "HEAD", s.path + "/status", nil, 405},
		{"POST", "POST", s.path, nil, 405},
		{"PUT", "PUT", s.path + "/status", nil, 405},
		{"DELETE", "DELETE", s.path, nil, 405},
		{"TRACE", "TRACE", s.path, nil, 405},
		{"preflight", "OPTIONS", s.path + "/status", http.Header{"Origin": {"https://evil.example"}, "Access-Control-Request-Method": {"GET"}}, 405},
		{"foreign origin", "GET", s.path + "/status", http.Header{"Origin": {"http://127.0.0.1:1"}}, 403},
		{"origin suffix", "GET", s.path + "/status", http.Header{"Origin": {s.origin + "/"}}, 403},
		{"null origin", "GET", s.path + "/status", http.Header{"Origin": {"null"}}, 403},
		{"empty origin", "GET", s.path + "/status", http.Header{"Origin": {""}}, 403},
		{"duplicate origin", "GET", s.path + "/status", http.Header{"Origin": {s.origin, s.origin}}, 403},
		{"cross-site status", "GET", s.path + "/status", http.Header{"Origin": {s.origin}, "Sec-Fetch-Site": {"cross-site"}}, 403},
		{"same-site status", "GET", s.path + "/status", http.Header{"Sec-Fetch-Site": {"same-site"}}, 403},
		{"status navigation", "GET", s.path + "/status", http.Header{"Sec-Fetch-Site": {"same-origin"}, "Sec-Fetch-Mode": {"navigate"}, "Sec-Fetch-Dest": {"document"}}, 403},
		{"duplicate metadata", "GET", s.path + "/status", http.Header{"Sec-Fetch-Site": {"same-origin", "same-origin"}}, 403},
		{"iframe", "GET", s.path, http.Header{"Sec-Fetch-Site": {"same-origin"}, "Sec-Fetch-Mode": {"navigate"}, "Sec-Fetch-Dest": {"iframe"}}, 403},
		{"cross-site fetch", "GET", s.path, http.Header{"Sec-Fetch-Site": {"cross-site"}, "Sec-Fetch-Mode": {"cors"}, "Sec-Fetch-Dest": {"empty"}}, 403},
		{"cross-site incomplete", "GET", s.path, http.Header{"Sec-Fetch-Site": {"cross-site"}}, 403},
		{"websocket", "GET", s.path, http.Header{"Connection": {"Upgrade"}, "Upgrade": {"websocket"}}, 400},
	} {
		t.Run(test.name, func(t *testing.T) {
			response, _ := adminLoadingTestRequest(t, client, test.method, s.origin+test.path, test.headers)
			if response.StatusCode != test.want {
				t.Fatalf("status = %d, want %d", response.StatusCode, test.want)
			}
		})
	}
	for _, site := range []string{"none", "same-origin", "same-site", "cross-site"} {
		response, _ := adminLoadingTestRequest(t, client, "GET", s.URL(), http.Header{
			"Origin": {"http://wails.localhost"}, "Sec-Fetch-Site": {site}, "Sec-Fetch-Mode": {"navigate"}, "Sec-Fetch-Dest": {"document"},
		})
		if response.StatusCode != 200 {
			t.Fatalf("top-level navigation from dsh or shell rejected: %s", site)
		}
	}
	if calls.Load() != 0 {
		t.Fatal("navigation and rejected HTTP requests must not invoke snapshot or enable remote")
	}
	adminLoadingTestState(t, client, s)
	adminLoadingTestRequest(t, client, "GET", s.URL()+"/status", nil)
	if calls.Load() != 2 {
		t.Fatal("only validated GET status requests may read the snapshot")
	}
}

func TestAdminLoadingRejectsNonLoopbackSocketEvenWithForwardedHeaders(t *testing.T) {
	s := adminLoadingTestServer(t, func() remoteAdminView { t.Fatal("unexpected snapshot"); return remoteAdminView{} }, time.Minute, time.Second)
	for _, peer := range []string{"192.0.2.1:40000", "malformed", "[2001:db8::1]:40000"} {
		r := httptest.NewRequest("GET", s.URL(), nil)
		r.RequestURI, r.RemoteAddr = s.path, peer
		r.Header.Set("X-Forwarded-For", "127.0.0.1")
		w := httptest.NewRecorder()
		s.serveHTTP(w, r)
		if w.Code != 403 {
			t.Fatalf("non-loopback socket accepted: %s", peer)
		}
	}
}

func TestAdminLoadingTargetsAreStrictAndFailClosed(t *testing.T) {
	valid := []string{"http://127.0.0.1:1/_admin", "http://127.0.0.1:80/_admin", "http://127.0.0.1:31809/_admin", "http://127.0.0.1:65535/_admin"}
	invalid := []string{
		"", "http://127.0.0.1/_admin", "http://localhost:80/_admin", "http://127.1:80/_admin", "http://2130706433:80/_admin",
		"http://[::1]:80/_admin", "https://127.0.0.1:80/_admin", "HTTP://127.0.0.1:80/_admin", "//127.0.0.1:80/_admin",
		"http://127.0.0.1:0/_admin", "http://127.0.0.1:65536/_admin", "http://127.0.0.1:080/_admin", "http://127.0.0.1:+80/_admin",
		"http://127.0.0.1:-1/_admin", "http://127.0.0.1:8a/_admin", "http://user@127.0.0.1:80/_admin", "http://127.0.0.1:80@evil.example/_admin",
		"http://127.0.0.1:80/_admin/", "http://127.0.0.1:80/_admin?", "http://127.0.0.1:80/_admin?token=secret-token",
		"http://127.0.0.1:80/_admin#", "http://127.0.0.1:80/_admin#secret-token", "http://127.0.0.1:80/_admin\n",
		" http://127.0.0.1:80/_admin", "http://127.0.0.1:80/%5Fadmin", "http://127.0.0.1:80/other/../_admin",
		"http://127.0.0.1:80/", "javascript:alert(1)", "http://evil.example:80/_admin", "http://127.0.0.1:80\\@evil.example/_admin",
	}
	for _, target := range valid {
		if !validAdminLoadingTarget(target) {
			t.Errorf("valid target rejected: %q", target)
		}
	}
	var view atomic.Value
	view.Store(remoteAdminView{State: "ready"})
	s := adminLoadingTestServer(t, func() remoteAdminView { return view.Load().(remoteAdminView) }, time.Minute, 10*time.Second)
	client := adminLoadingTestClient(t)
	for _, target := range invalid {
		if validAdminLoadingTarget(target) {
			t.Errorf("invalid target accepted: %q", target)
		}
		view.Store(remoteAdminView{State: "ready", AdminURL: target, Detail: "secret-token"})
		if got := adminLoadingTestState(t, client, s); got != (adminLoadingPayload{State: "failed", Detail: adminLoadingBadURL}) {
			t.Fatalf("invalid target must never be serialized: %+v", got)
		}
	}
}

func TestAdminLoadingUnknownAndPanickingSnapshotsAreSafe(t *testing.T) {
	for _, snapshot := range []func() remoteAdminView{
		func() remoteAdminView { return remoteAdminView{State: "secret-token", Detail: "secret-token"} },
		func() remoteAdminView { panic("secret-token") },
	} {
		s := adminLoadingTestServer(t, snapshot, time.Minute, time.Second)
		if got := adminLoadingTestState(t, adminLoadingTestClient(t), s); got != (adminLoadingPayload{State: "failed", Detail: adminLoadingFailure}) {
			t.Fatalf("snapshot failure leaked: %+v", got)
		}
	}
}

func TestAdminLoadingCSPAndScriptStyleContracts(t *testing.T) {
	s := adminLoadingTestServer(t, func() remoteAdminView { return remoteAdminView{} }, time.Minute, time.Second)
	response, body := adminLoadingTestRequest(t, adminLoadingTestClient(t), "GET", s.URL(), nil)
	csp := response.Header.Get("Content-Security-Policy")
	for _, tag := range []string{"script", "style"} {
		_, rest, ok := strings.Cut(body, "<"+tag+">")
		if !ok {
			t.Fatalf("missing %s", tag)
		}
		content, _, ok := strings.Cut(rest, "</"+tag+">")
		if !ok {
			t.Fatalf("unclosed %s", tag)
		}
		hash := sha256.Sum256([]byte(content))
		want := tag + "-src 'sha256-" + base64.StdEncoding.EncodeToString(hash[:]) + "'"
		if !strings.Contains(csp, want) {
			t.Fatalf("CSP hash does not match served %s bytes", tag)
		}
	}
	if strings.Contains(csp, "unsafe-") || !strings.Contains(csp, "connect-src 'self'") {
		t.Fatal("CSP must restrict scripts and connections")
	}
	for _, forbidden := range []string{"location.reload", "setInterval", "setTimeout(poll", "'/status'", "innerHTML", "http-equiv=\"refresh\"", "<script src=", "<iframe", "fetch(location.href"} {
		if strings.Contains(body, forbidden) {
			t.Errorf("unexpected page behavior: %s", forbidden)
		}
	}
	for _, contract := range []string{
		"location.pathname + '/events'", "setTimeout(fail, 155000)", "response.body.getReader()", "reader.read()", "frameBytes > 8192",
		"credentials: 'omit'", "mode: 'same-origin'", "redirect: 'error'", "location.replace(value.adminURL)",
		"Number(match[1]) > 65535", "match[0] !== value.adminURL", "clearTimeout(deadline)", "controller.abort()", "classList.add('stopped')", ".textContent =",
		"@media(prefers-color-scheme:dark)", "@media(prefers-reduced-motion:reduce)", "animation:admin-loading-spin 1s linear infinite",
		"width:24px;height:24px", ".spin.stopped{animation:none", "rgb(249,250,251)", "rgb(21,21,23)",
	} {
		if !strings.Contains(body, contract) {
			t.Errorf("missing static contract: %s", contract)
		}
	}
}

func TestAdminLoadingCloseIsConcurrentIdempotentAndBounded(t *testing.T) {
	s := adminLoadingTestServer(t, func() remoteAdminView { return remoteAdminView{State: "starting"} }, time.Minute, time.Second)
	conn, err := net.Dial("tcp4", strings.TrimPrefix(s.origin, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_, _ = io.WriteString(conn, "GET / HTTP/1.1\r\n")
	var workers sync.WaitGroup
	for range 16 {
		workers.Go(func() {
			if err := s.Close(); err != nil {
				t.Errorf("Close: %v", err)
			}
		})
	}
	finished := make(chan struct{})
	go func() { workers.Wait(); close(finished) }()
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("Close leaked or waited for an idle/partial request")
	}
	adminLoadingTestClosed(t, s)
}

func adminLoadingTestClosed(t *testing.T, s *adminLoadingServer) {
	t.Helper()
	for _, done := range []chan struct{}{s.serveDone, s.lifecycleDone} {
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatal("server-owned goroutine did not exit")
		}
	}
	conn, err := net.DialTimeout("tcp4", strings.TrimPrefix(s.origin, "http://"), 100*time.Millisecond)
	if err == nil {
		conn.Close()
		t.Fatal("closed service is still listening")
	}
}

func TestAdminLoadingLifecycleHardLimitAndCompletionGrace(t *testing.T) {
	t.Run("hard limit without HTTP", func(t *testing.T) {
		s := adminLoadingTestServer(t, func() remoteAdminView { t.Error("expiry must not poll"); return remoteAdminView{} }, 50*time.Millisecond, time.Second)
		adminLoadingTestClosed(t, s)
	})
	for _, state := range []string{"ready", "failed"} {
		t.Run(state+" grace", func(t *testing.T) {
			s := adminLoadingTestServer(t, func() remoteAdminView {
				return remoteAdminView{State: state, AdminURL: "http://127.0.0.1:31809/_admin"}
			}, 10*time.Second, 150*time.Millisecond)
			client := adminLoadingTestClient(t)
			for range 3 {
				if got := adminLoadingTestState(t, client, s); got.State != state {
					t.Fatalf("early completion close: %+v", got)
				}
			}
			adminLoadingTestClosed(t, s)
		})
	}
	t.Run("grace cannot extend hard limit", func(t *testing.T) {
		s := adminLoadingTestServer(t, func() remoteAdminView { return remoteAdminView{State: "failed"} }, 150*time.Millisecond, 10*time.Second)
		adminLoadingTestState(t, adminLoadingTestClient(t), s)
		adminLoadingTestClosed(t, s)
	})
	for _, durations := range [][2]time.Duration{{0, time.Second}, {time.Second, 0}, {-1, time.Second}} {
		if _, err := newAdminLoadingServerWithLifetime(staticAdminObserver(func() remoteAdminView { return remoteAdminView{} }), durations[0], durations[1]); err == nil {
			t.Fatal("unbounded lifetime accepted")
		}
	}
	if _, err := newAdminLoadingServer(nil); err == nil {
		t.Fatal("nil snapshot accepted")
	}
}

func TestAdminLoadingRawHTTPBounds(t *testing.T) {
	var calls atomic.Int32
	s := adminLoadingTestServer(t, func() remoteAdminView { calls.Add(1); return remoteAdminView{State: "starting"} }, time.Minute, time.Second)
	authority := strings.TrimPrefix(s.origin, "http://")
	for _, test := range []struct {
		name, request string
		want          int
	}{
		{"unread body", "GET " + s.path + "/status HTTP/1.1\r\nHost: " + authority + "\r\nContent-Length: 1048576\r\n\r\n", 400},
		{"chunked body", "GET " + s.path + "/status HTTP/1.1\r\nHost: " + authority + "\r\nTransfer-Encoding: chunked\r\n\r\n", 400},
		{"large headers", "GET " + s.path + " HTTP/1.1\r\nHost: " + authority + "\r\nX-Large: " + strings.Repeat("a", 20<<10) + "\r\n\r\n", 431},
		{"absolute URI", "GET " + s.URL() + " HTTP/1.1\r\nHost: " + authority + "\r\n\r\n", 404},
	} {
		t.Run(test.name, func(t *testing.T) {
			conn, err := net.Dial("tcp4", authority)
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			_ = conn.SetDeadline(time.Now().Add(time.Second))
			_, _ = io.WriteString(conn, test.request)
			response, err := http.ReadResponse(bufio.NewReader(conn), nil)
			if err != nil {
				t.Fatalf("must reject without waiting for body: %v", err)
			}
			defer response.Body.Close()
			if response.StatusCode != test.want {
				t.Fatalf("status = %d, want %d", response.StatusCode, test.want)
			}
		})
	}
	if calls.Load() != 0 {
		t.Fatal("malformed HTTP read state")
	}
	if s.server.ReadHeaderTimeout <= 0 || s.server.ReadTimeout <= 0 || s.server.WriteTimeout <= 0 || s.server.IdleTimeout <= 0 || s.server.MaxHeaderBytes > 8<<10 {
		t.Fatal("HTTP resource limits missing")
	}
}

func TestAdminLoadingConnectionLimitAndHeaderTimeout(t *testing.T) {
	s := adminLoadingTestServer(t, func() remoteAdminView { return remoteAdminView{} }, time.Minute, time.Second)
	authority := strings.TrimPrefix(s.origin, "http://")
	for range adminLoadingMaxConns {
		conn, err := net.Dial("tcp4", authority)
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(time.Second))
		_, _ = fmt.Fprintf(conn, "HEAD %s HTTP/1.1\r\nHost: %s\r\n\r\n", s.path, authority)
		response, err := http.ReadResponse(bufio.NewReader(conn), &http.Request{Method: "HEAD"})
		if err != nil || response.StatusCode != 200 {
			t.Fatalf("connection within capacity failed: %v", err)
		}
		response.Body.Close()
	}
	conn, err := net.Dial("tcp4", authority)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(time.Second))
	_, _ = fmt.Fprintf(conn, "GET %s HTTP/1.1\r\nHost: %s\r\n\r\n", s.path, authority)
	if _, err := http.ReadResponse(bufio.NewReader(conn), nil); err == nil {
		t.Fatal("connection above capacity was accepted")
	} else if timeout, ok := err.(net.Error); ok && timeout.Timeout() {
		t.Fatal("excess connection must be closed, not queued indefinitely")
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	adminLoadingTestClosed(t, s)

	s = adminLoadingTestServer(t, func() remoteAdminView { return remoteAdminView{} }, time.Minute, time.Second)
	conn, err = net.Dial("tcp4", strings.TrimPrefix(s.origin, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(4 * time.Second))
	_, _ = io.WriteString(conn, "G")
	response, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err == nil {
		defer response.Body.Close()
		if response.StatusCode != http.StatusBadRequest {
			t.Fatalf("partial request must be rejected: %d", response.StatusCode)
		}
	} else if timeout, ok := err.(net.Error); ok && timeout.Timeout() {
		t.Fatal("server did not enforce its header timeout")
	}
}
