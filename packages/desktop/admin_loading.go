package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

type remoteAdminView struct {
	State    string
	Detail   string
	AdminURL string
}

const (
	adminLoadingLifetime = 10 * time.Minute
	adminLoadingGrace    = 30 * time.Second
	adminLoadingMaxConns = 32
	adminLoadingFailure  = "远程服务启用失败。请返回本机工作台；需要重试时，请退出并重新打开 DSH 工作站。"
	adminLoadingBadURL   = "远程管理地址无效，已停止跳转。请返回本机工作台。"
	adminLoadingPortBusy = "远程服务端口已被占用。本机工作台仍可使用；请检查占用后退出并重新打开。"
	adminLoadingTimeout  = "远程服务未能在时限内就绪。本机工作台仍可使用；请检查后台日志后退出并重新打开。"
)

type adminLoadingPayload struct {
	State    string `json:"state"`
	Detail   string `json:"detail,omitempty"`
	AdminURL string `json:"adminURL,omitempty"`
}

// 两种加载页共用传输边界；额外入口只能由壳内固定处理器提供。
type loadingPageHandlers struct {
	html, csp     string
	observe       func(bool) loadingUpdate
	failure       loadingUpdate
	deadline      time.Time
	finishOnReady bool
	enter         func(http.ResponseWriter, *http.Request) bool
}

type remoteAdminObserver func() (remoteAdminView, <-chan struct{})

type adminLoadingServer struct {
	page          loadingPageHandlers
	server        *http.Server
	origin        string
	path          string
	done          chan struct{}
	serveDone     chan struct{}
	lifecycleDone chan struct{}
	terminal      chan struct{}
	terminalOnce  sync.Once
	closeOnce     sync.Once
	closeErr      error
}

// 仅用户管理动作创建服务；observe 必须原子返回只读视图和变更信号。
func newAdminLoadingServer(observe remoteAdminObserver) (*adminLoadingServer, error) {
	return newAdminLoadingServerWithLifetime(observe, adminLoadingLifetime, adminLoadingGrace)
}

func newAdminLoadingServerWithLifetime(observe remoteAdminObserver, lifetime, grace time.Duration) (*adminLoadingServer, error) {
	if observe == nil {
		return nil, errors.New("missing remote observer")
	}
	page := loadingPageHandlers{
		html: adminLoadingHTML, csp: adminLoadingCSP, deadline: time.Now().Add(remoteRestartTimeout), finishOnReady: true,
		failure: loadingUpdate{state: "failed", payload: adminLoadingPayload{State: "failed", Detail: adminLoadingFailure}},
		observe: func(expired bool) loadingUpdate {
			view, changed := observe()
			payload := adminLoadingState(view)
			if expired && payload.State == "starting" {
				payload = adminLoadingPayload{State: "failed", Detail: adminLoadingTimeout}
			}
			return loadingUpdate{payload: payload, state: payload.State, changed: changed}
		},
	}
	return newLoadingServer(page, lifetime, grace)
}

func newLoadingServer(page loadingPageHandlers, lifetime, grace time.Duration) (*adminLoadingServer, error) {
	if page.observe == nil || page.deadline.IsZero() || page.html == "" || page.csp == "" || lifetime <= 0 || grace <= 0 {
		return nil, errors.New("invalid admin loading server configuration")
	}
	var capability [32]byte
	if _, err := rand.Read(capability[:]); err != nil {
		return nil, err
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	s := &adminLoadingServer{
		origin: "http://" + listener.Addr().String(),
		path:   "/" + base64.RawURLEncoding.EncodeToString(capability[:]),
		page:   page, done: make(chan struct{}), serveDone: make(chan struct{}),
		lifecycleDone: make(chan struct{}), terminal: make(chan struct{}),
	}
	s.server = &http.Server{
		Handler: http.HandlerFunc(s.serveHTTP), ReadHeaderTimeout: 2 * time.Second,
		ReadTimeout: 3 * time.Second, WriteTimeout: 3 * time.Second, IdleTimeout: 5 * time.Second,
		MaxHeaderBytes: 8 << 10, ErrorLog: log.New(io.Discard, "", 0),
	}
	bounded := &adminLoadingListener{Listener: listener, slots: make(chan struct{}, adminLoadingMaxConns)}
	go func() {
		defer close(s.serveDone)
		_ = s.server.Serve(bounded)
		s.stop()
	}()
	go s.expire(lifetime, grace)
	return s, nil
}

func (s *adminLoadingServer) URL() string { return s.origin + s.path }

func (s *adminLoadingServer) Close() error {
	s.stop()
	<-s.serveDone
	<-s.lifecycleDone
	return s.closeErr
}

func (s *adminLoadingServer) stop() {
	s.closeOnce.Do(func() {
		close(s.done)
		s.closeErr = s.server.Close()
	})
}

func (s *adminLoadingServer) expire(lifetime, grace time.Duration) {
	defer close(s.lifecycleDone)
	hard := time.NewTimer(lifetime)
	defer hard.Stop()
	select {
	case <-s.done:
		return
	case <-hard.C:
	case <-s.terminal:
		// 完成后保留宽限期供其他已打开页面读取，硬上限不会被延长。
		soft := time.NewTimer(grace)
		defer soft.Stop()
		select {
		case <-s.done:
			return
		case <-hard.C:
		case <-soft.C:
		}
	}
	s.stop()
}

func (s *adminLoadingServer) serveHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Content-Security-Policy", s.page.csp)
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
	peer, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil || !net.ParseIP(peer).IsLoopback() || r.Host != strings.TrimPrefix(s.origin, "http://") {
		adminLoadingReject(w, r, http.StatusForbidden)
		return
	}
	// 使用原始 URI 精确匹配，不接受编码、查询串、代理绝对地址或路径归一化。
	events := r.RequestURI == s.path+"/events"
	status := r.RequestURI == s.path+"/status" || events
	enter := s.page.enter != nil && r.RequestURI == s.path+"/enter"
	if !status && !enter && r.RequestURI != s.path {
		adminLoadingReject(w, r, http.StatusNotFound)
		return
	}
	allow := "GET, HEAD"
	if status || enter {
		allow = "GET"
	}
	if r.Method != http.MethodGet && (status || enter || r.Method != http.MethodHead) {
		w.Header().Set("Allow", allow)
		adminLoadingReject(w, r, http.StatusMethodNotAllowed)
		return
	}
	if r.ContentLength != 0 || len(r.TransferEncoding) != 0 || r.Header.Get("Expect") != "" || r.Header.Get("Upgrade") != "" {
		adminLoadingReject(w, r, http.StatusBadRequest)
		return
	}
	if !s.trustedBrowserRequest(r, status) {
		adminLoadingReject(w, r, http.StatusForbidden)
		return
	}
	if enter {
		// 认证交接只允许同源页面的顶层导航；不能被跨站导航或 fetch 读取。
		site := r.Header.Get("Sec-Fetch-Site")
		origins := r.Header.Values("Origin")
		if (site != "" && site != "none" && site != "same-origin") || (len(origins) > 0 && origins[0] != s.origin) {
			adminLoadingReject(w, r, http.StatusForbidden)
			return
		}
		if s.page.enter(w, r) {
			s.terminalOnce.Do(func() { close(s.terminal) })
		}
		return
	}
	if !status {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Content-Length", strconv.Itoa(len(s.page.html)))
		w.WriteHeader(http.StatusOK)
		if r.Method != http.MethodHead {
			_, _ = io.WriteString(w, s.page.html)
		}
		return
	}
	if events {
		s.serveEvents(w, r)
		return
	}
	// 保留只读快照供诊断；页面只使用一次 /events 订阅，不反复查询。
	update := s.readUpdate(!time.Now().Before(s.page.deadline))
	s.noteCompletion(update.state)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(update.payload)
}

func adminLoadingReject(w http.ResponseWriter, r *http.Request, status int) {
	// 不读取或排空攻击者正文，也不复用被拒绝的连接。
	r.Close = true
	w.Header().Set("Connection", "close")
	http.Error(w, http.StatusText(status), status)
}

func (s *adminLoadingServer) trustedBrowserRequest(r *http.Request, status bool) bool {
	for _, name := range []string{"Origin", "Sec-Fetch-Site", "Sec-Fetch-Mode", "Sec-Fetch-Dest"} {
		if len(r.Header.Values(name)) > 1 {
			return false
		}
	}
	site, mode, dest := r.Header.Get("Sec-Fetch-Site"), r.Header.Get("Sec-Fetch-Mode"), r.Header.Get("Sec-Fetch-Dest")
	if status {
		origin := r.Header.Values("Origin")
		return (len(origin) == 0 || origin[0] == s.origin) &&
			(site == "" || site == "same-origin") &&
			(mode == "" || mode == "same-origin" || mode == "cors") &&
			(dest == "" || dest == "empty")
	}
	// 能力页面允许其他端口或壳发起顶层导航，但不是跨站子资源或 iframe。
	if site == "" && mode == "" && dest == "" {
		return true
	}
	return (site == "" || site == "none" || site == "same-origin" || site == "same-site" || site == "cross-site") &&
		mode == "navigate" && dest == "document"
}

func adminLoadingState(view remoteAdminView) adminLoadingPayload {
	payload := adminLoadingPayload{State: "failed", Detail: adminLoadingFailure}
	// 原始错误可能含路径或 token；只映射到固定原因文案，绝不原样下发。
	if strings.Contains(view.Detail, "EADDRINUSE") {
		payload.Detail = adminLoadingPortBusy
	} else if strings.Contains(view.Detail, "超时") || strings.Contains(view.Detail, "未就绪") {
		payload.Detail = adminLoadingTimeout
	}
	switch view.State {
	case "starting":
		return adminLoadingPayload{State: "starting"}
	case "ready":
		if validAdminLoadingTarget(view.AdminURL) {
			return adminLoadingPayload{State: "ready", AdminURL: view.AdminURL}
		}
		return adminLoadingPayload{State: "failed", Detail: adminLoadingBadURL}
	default:
		return payload
	}
}

func validAdminLoadingTarget(target string) bool {
	port, ok := strings.CutPrefix(target, "http://127.0.0.1:")
	if !ok {
		return false
	}
	port, ok = strings.CutSuffix(port, "/_admin")
	if !ok || len(port) == 0 || len(port) > 5 {
		return false
	}
	number, err := strconv.Atoi(port)
	return err == nil && number > 0 && number <= 65535 && strconv.Itoa(number) == port
}

// 在 net/http 创建请求 goroutine 之前限制连接数，超额连接直接关闭。
type adminLoadingListener struct {
	net.Listener
	slots chan struct{}
}

func (l *adminLoadingListener) Accept() (net.Conn, error) {
	for {
		conn, err := l.Listener.Accept()
		if err != nil {
			return nil, err
		}
		select {
		case l.slots <- struct{}{}:
			return &adminLoadingConn{Conn: conn, release: func() { <-l.slots }}, nil
		default:
			_ = conn.Close()
		}
	}
}

type adminLoadingConn struct {
	net.Conn
	once    sync.Once
	release func()
}

func (c *adminLoadingConn) Close() error {
	err := c.Conn.Close()
	c.once.Do(c.release)
	return err
}

func adminLoadingHash(source string) string {
	hash := sha256.Sum256([]byte(source))
	return "'sha256-" + base64.StdEncoding.EncodeToString(hash[:]) + "'"
}

var adminLoadingCSP = "default-src 'none'; script-src " + adminLoadingHash(adminLoadingScript) +
	"; style-src " + adminLoadingHash(adminLoadingStyle) +
	"; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

const adminLoadingScript = `(() => {
` + loadingStreamClient + `
  const failure = '` + adminLoadingFailure + `';
  const badURL = '` + adminLoadingBadURL + `';
  const reasons = [failure, badURL, '` + adminLoadingPortBusy + `', '` + adminLoadingTimeout + `'];
  const back = document.getElementById('back');
  back.hidden = history.length < 2;
  back.onclick = () => history.back();
  function fail(detail) {
    document.getElementById('spinner').classList.add('stopped');
    document.getElementById('status').textContent = '远程服务启用失败';
    document.getElementById('detail').textContent = reasons.includes(detail) ? detail : failure;
  }
  consumeLoadingStream(value => {
    if (value.state === 'starting') return false;
    if (value.state === 'ready') {
      const match = typeof value.adminURL === 'string'
        && /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/_admin$/.exec(value.adminURL);
      if (!match || match[0] !== value.adminURL || Number(match[1]) > 65535) { fail(badURL); return true; }
      location.replace(value.adminURL);
    } else {
      fail(value.detail);
    }
    return true;
  }, () => fail(failure));
})();`

// 独立壳页面沿用 relay splash 配色、24px 固定弧与系统主题，不覆盖 dsh 样式。
const adminLoadingStyle = `:root{color-scheme:light dark;--page:rgb(249,250,251);--line:rgba(0,0,0,.1);--ink:rgb(15,17,21);--ink-3:rgb(129,133,140)}
@media(prefers-color-scheme:dark){:root{--page:rgb(21,21,23);--line:rgba(255,255,255,.12);--ink:rgb(249,250,251);--ink-3:rgb(173,178,184)}}
*{box-sizing:border-box}
html,body{min-height:100%;margin:0}
body{min-height:100vh;min-height:100dvh;display:grid;place-items:center;padding:24px 16px;background:var(--page);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Helvetica Neue",Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
.card{display:flex;flex-direction:column;align-items:center;gap:16px;width:min(100%,440px);text-align:center}
.wordmark{font-size:16px;line-height:24px;font-weight:600;letter-spacing:.08em}
.hint{font-size:12px;line-height:18px;color:var(--ink-3);overflow-wrap:anywhere}
p{margin:0}
button{font:inherit;color:var(--ink);background:transparent;border:1px solid var(--line);border-radius:8px;padding:8px 14px;cursor:pointer}
#detail:empty{display:none}
.spin{width:24px;height:24px;border-radius:50%;border:2px solid var(--line);border-top-color:var(--ink);animation:admin-loading-spin 1s linear infinite}
.spin.stopped{animation:none;visibility:hidden}
@keyframes admin-loading-spin{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){.spin{animation:none}}`

const adminLoadingHTML = `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>远程管理 · DSH 工作站</title>
<style>` + adminLoadingStyle + `</style>
</head><body><main class="card">
<div class="wordmark">HARNESS</div>
<div id="spinner" class="spin" aria-hidden="true"></div>
<div class="hint" role="status" aria-live="polite"><p id="status">正在启用远程服务…</p><p id="detail"></p></div>
<button id="back" type="button" hidden>返回上一页</button>
<noscript><p class="hint">此加载页需要 JavaScript。请返回工作站查看远程服务状态。</p></noscript>
</main><script>` + adminLoadingScript + `</script></body></html>`
