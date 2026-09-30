package main

import (
	"errors"
	"net/http"
	"net/url"
	"time"
)

const startupLoadingFailure = "工作站启动失败。请查看后台日志，退出并重新打开应用。"
const startupLoadingTimeout = "工作站未在启动时限内就绪。请查看后台日志，退出并重新打开应用。"

type startupLoadingPayload struct {
	State  string `json:"state"`
	Phase  string `json:"phase"`
	Detail string `json:"detail,omitempty"`
}

func startupLoadingState(status backendStatus, expired bool) startupLoadingPayload {
	failed := startupLoadingPayload{State: "failed", Phase: "启动失败", Detail: startupLoadingFailure}
	switch status.Phase {
	case phaseFailed, phaseOffline, phaseStopping:
		return failed
	}
	if expired {
		failed.Detail = startupLoadingTimeout
		return failed
	}
	if status.HasURLs && validateBackendURLs(status.URLs) != nil {
		return failed
	}
	if (status.Phase == phaseReady || status.Phase == phaseRemote) && status.HasURLs {
		if status.RemoteEnabled || status.DshToken != "" {
			return startupLoadingPayload{State: "ready", Phase: "正在进入工作台…"}
		}
	}
	// 阶段只映射固定文案，未知值和原始日志均不得进入浏览器。
	label := "正在准备运行环境…"
	switch status.Phase {
	case phasePlugins:
		label = "正在准备插件…"
	case phaseDsh, phaseReady:
		label = "正在启动 dsh…"
	case phaseRelay, phaseRemote:
		label = "正在准备本机入口…"
	case phaseRestarting:
		label = "正在重启 dsh…"
	}
	// 插件同步慢路径的子步骤；只认 launcher 状态行的固定标记，未知值沿用阶段默认文案。
	if status.Phase == phasePlugins {
		switch status.PluginStage {
		case "copy":
			label = "正在复制插件文件…"
		case "deps":
			label = "正在准备插件依赖…"
		case "install":
			label = "正在安装插件…"
		}
	}
	return startupLoadingPayload{State: "starting", Phase: label}
}

// 初始资产导航先进入 loopback 文档；后续交接为同站导航，不改 Host/Origin fence。
func newStartupLoadingServer(manager *backendManager) (*adminLoadingServer, error) {
	if manager == nil {
		return nil, errors.New("startup loading requires a backend manager")
	}
	deadline := time.Now().Add(bootstrapHoldSeconds * time.Second)
	page := loadingPageHandlers{
		html: startupLoadingHTML, csp: startupLoadingCSP, deadline: deadline,
		failure: loadingUpdate{state: "failed", payload: startupLoadingPayload{State: "failed", Phase: "启动失败", Detail: startupLoadingFailure}},
		observe: func(expired bool) loadingUpdate {
			observation, changed := manager.Observe()
			state := startupLoadingState(observation.Status, expired)
			// ready 不立即回收，必须等顶层认证交接再开始宽限期。
			return loadingUpdate{payload: state, state: state.State, changed: changed}
		},
		enter: func(w http.ResponseWriter, _ *http.Request) bool {
			status := manager.Status()
			state := startupLoadingState(status, time.Now().After(deadline))
			if state.State != "ready" {
				w.Header().Set("Content-Type", "text/html; charset=utf-8")
				w.WriteHeader(http.StatusServiceUnavailable)
				_, _ = w.Write([]byte(startupLoadingHTML))
				return state.State == "failed"
			}
			target := status.URLs.Local
			if !status.RemoteEnabled {
				target = status.URLs.Dsh + "?" + url.Values{"token": {status.DshToken}}.Encode()
			}
			// token 只在顶层 Location 内出现，不用 http.Redirect 生成含 token 的 HTML。
			w.Header().Set("Location", target)
			w.WriteHeader(http.StatusFound)
			return true
		},
	}
	return newLoadingServer(page, adminLoadingLifetime, adminLoadingGrace)
}

func startupAssetHandler(target string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if (r.Method != http.MethodGet && r.Method != http.MethodHead) || r.URL.Path != "/" || r.URL.RawQuery != "" {
			http.NotFound(w, r)
			return
		}
		redirectToEntry(w, r, target)
	})
}

var startupLoadingCSP = "default-src 'none'; script-src " + adminLoadingHash(startupLoadingScript) +
	"; style-src " + adminLoadingHash(adminLoadingStyle) +
	"; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

const startupLoadingScript = `(() => {
` + loadingStreamClient + `
  const failure = '` + startupLoadingFailure + `';
  const timeoutMessage = '` + startupLoadingTimeout + `';
  const status = document.getElementById('status');
  const labels = ['正在准备运行环境…', '正在准备插件…', '正在复制插件文件…', '正在准备插件依赖…', '正在安装插件…', '正在启动 dsh…', '正在准备本机入口…', '正在重启 dsh…'];
  function fail(detail) {
    document.getElementById('spinner').classList.add('stopped');
    status.textContent = '启动失败';
    document.getElementById('detail').textContent = detail === timeoutMessage ? timeoutMessage : failure;
  }
  consumeLoadingStream(value => {
    if (value.state === 'starting') {
      status.textContent = labels.includes(value.phase) ? value.phase : labels[0];
      return false;
    }
    if (value.state === 'ready') {
      status.textContent = '正在进入工作台…';
      // 后台可进入即交接；不等待动画、首帧或浏览器插件加载完毕。
      location.replace(location.pathname + '/enter');
    } else { fail(value.detail); }
    return true;
  }, () => fail(failure));
})();`

const startupLoadingHTML = `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>正在启动 · DSH 工作站</title><style>` + adminLoadingStyle + `</style>
</head><body><main class="card">
<div class="wordmark">HARNESS</div>
<div id="spinner" class="spin" aria-hidden="true"></div>
<div class="hint" role="status" aria-live="polite"><p id="status">正在准备运行环境…</p><p id="detail"></p></div>
<noscript><p class="hint">此加载页需要 JavaScript。请通过托盘退出并重新打开工作站。</p></noscript>
</main><script>` + startupLoadingScript + `</script></body></html>`
