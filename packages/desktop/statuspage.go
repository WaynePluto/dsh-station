package main

import (
	"fmt"
	"html"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// bootstrapHoldSeconds 是初始导航在后台启动期间被持有的上限；
// 超过它（或后台失败）则回答状态页。上限必须低于浏览器引擎的
// 响应头超时（约 300s），并覆盖首次运行插件同步的耗时。
const bootstrapHoldSeconds = 150

// statusHandler 是独立模式下 AssetServer 的唯一处理器。
// webview 的初始导航是唯一能进入 dsh/relay 的入口：任何由页面发起的后续
// 跳转（meta-refresh、JS location）都会带 Sec-Fetch-Site: cross-site，
// 被入口的原始安全检查正确拒绝。因此这里「持有」初始请求，直到能给出
// 一个可用的入口再 302：本机模式（D25，远程未启用）在 dsh 就绪且 token
// 已上报时直连 dsh 的 loopback 并代发一次 /?token= 交换（与 relay 的
// 首页 token 重定向语义一致）；远程已启用时等 relay 端口开始监听再进
// relay（dsh/connector 就绪前的等待由 relay 自己的重试页承担）。后台
// 失败或超时才回答状态页，恢复方式是退出并重新打开。
func statusHandler(manager *backendManager) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.NotFound(w, r)
			return
		}
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		deadline := time.Now().Add(bootstrapHoldSeconds * time.Second)
		relayHost := ""
		for {
			status := manager.Status()
			if status.Phase == phaseFailed || status.Phase == phaseOffline {
				break
			}
			if status.Phase == phaseReady && status.HasURLs {
				if status.RemoteEnabled {
					// 远程已启用（或正在启用）：入口是 relay，等它开始监听；
					// dsh/connector 就绪前的等待由 relay 自己的重试页承担。
					if relayHost == "" {
						if parsed, err := url.Parse(status.URLs.Local); err == nil {
							relayHost = parsed.Host
						}
					}
					if relayHost != "" && tcpReachable(relayHost) {
						redirectToEntry(w, r, status.URLs.Local)
						return
					}
				} else if status.DshToken != "" {
					// 本机模式：直连 dsh 的 loopback，代发一次 /?token= 交换
					//（与 relay 的首页 token 重定向语义一致）；token 是
					// base64url 字符集，可直接拼进查询串。
					redirectToEntry(w, r, strings.TrimSuffix(status.URLs.Local, "/")+"/?token="+status.DshToken)
					return
				}
			}
			if !time.Now().Before(deadline) {
				break
			}
			time.Sleep(200 * time.Millisecond)
		}
		body := renderStatusPage(manager.Status(), "")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Content-Length", fmt.Sprint(len(body)))
		_, _ = w.Write(body)
	})
}

func redirectToEntry(w http.ResponseWriter, r *http.Request, local string) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	http.Redirect(w, r, local, http.StatusFound)
}

func phaseLabel(phase backendPhase) string {
	switch phase {
	case phaseConfig:
		return "正在准备配置"
	case phaseRelay:
		return "正在启动本机入口"
	case phaseDsh:
		return "正在启动 dsh"
	case phaseReady:
		return "就绪"
	case phaseRemote:
		return "正在启用远程服务"
	case phaseRestarting:
		return "正在按远程入口变更重启"
	case phaseStopping:
		return "正在停止后台"
	case phaseFailed:
		return "后台异常"
	case phaseOffline:
		return "后台未运行"
	}
	return string(phase)
}

func phaseAdvice(status backendStatus) string {
	switch status.Phase {
	case phaseFailed:
		return "请退出并重新打开应用。"
	case phaseOffline:
		return "请退出并重新打开应用。"
	case phaseStopping:
		return "后台正在按既有顺序回收子进程；完成后请退出并重新打开应用。"
	case phaseRestarting:
		return "远程入口变更会短暂重启 dsh；本机入口保持不变。"
	}
	return ""
}

// renderStatusPage 输出轻量的启动/故障页（只描述阶段与地址，不带凭据）。
// 页面绝不自刷新或用 JS 跳转：那类跳转进不了 relay（见 statusHandler 注释）。
// adviceOverride 用于没有后台管理器的 attach 模式给出开发栈专属指引。
func renderStatusPage(status backendStatus, adviceOverride string) []byte {
	var builder strings.Builder
	builder.WriteString(`<!doctype html><html lang="zh-CN"><meta charset="utf-8">` +
		`<title>DSH 工作站</title>` +
		`<style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font:14px/1.7 "Segoe UI","Microsoft YaHei",system-ui,sans-serif;background:#f5f5f5;color:#1f1f1f}
@media (prefers-color-scheme:dark){body{background:#1b1b1b;color:#e6e6e6}}
main{max-width:520px;padding:32px}
h1{font-size:18px;margin:0 0 4px;display:flex;align-items:center;gap:10px}
h1 .logo{display:flex}
h1 .logo svg{width:22px;height:22px}
.phase{font-weight:600;margin:14px 0 2px}
.detail{opacity:.75;margin:2px 0}
.urls{margin-top:16px;padding-top:12px;border-top:1px solid rgba(127,127,127,.35)}
.urls a{color:inherit}
small{opacity:.6}
</style><main><h1><span class="logo">` + chromebarLogoSVG + `</span>DSH 工作站</h1>`)

	phase := html.EscapeString(phaseLabel(status.displayPhase()))
	builder.WriteString(`<p class="phase">` + phase + `</p>`)
	if status.Detail != "" {
		builder.WriteString(`<p class="detail">` + html.EscapeString(status.Detail) + `</p>`)
	}
	advice := adviceOverride
	if advice == "" {
		advice = phaseAdvice(status)
	}
	if advice != "" {
		builder.WriteString(`<p class="detail">` + html.EscapeString(advice) + `</p>`)
	}
	if status.HasURLs && (status.Phase == phaseReady || status.Phase == phasePlugins || status.Phase == phaseDsh || status.Phase == phaseRelay) {
		builder.WriteString(`<div class="urls"><a href="` + html.EscapeString(status.URLs.Local) + `">在系统浏览器中打开</a>` +
			` · <a href="` + html.EscapeString(status.URLs.Admin) + `">远程管理</a>` +
			`<br><small>本机入口 <code>` + html.EscapeString(status.URLs.Local) + `</code></small></div>`)
	}
	builder.WriteString(`</main>`)
	return []byte(builder.String())
}
