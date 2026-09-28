//go:build windows

package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	goruntime "runtime"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// 每个场景使用独立测试进程、WebView2目录和随机端口，不接管用户桌面实例。
func TestRemoteFallbackWebView(t *testing.T) {
	if os.Getenv("DSH_STATION_WEBVIEW_INTEGRATION") != "1" {
		t.Skip("设置 DSH_STATION_WEBVIEW_INTEGRATION=1，使用 production,wv2runtime.error 构建标签")
	}
	for _, page := range []string{"admin", "local"} {
		t.Run(page, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 40*time.Second)
			defer cancel()
			command := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestRemoteFallbackWebViewChild$", "-test.v")
			command.Env = append(os.Environ(), "DSH_STATION_WEBVIEW_CHILD="+page)
			command.Cancel = func() error { return killBackendTree(command) }
			applyChildWindowPolicy(command)
			if output, err := command.CombinedOutput(); err != nil {
				t.Fatalf("WebView2导航回归失败：%v\n%s", err, output)
			}
		})
	}
}

func TestRemoteFallbackWebViewChild(t *testing.T) {
	mode := os.Getenv("DSH_STATION_WEBVIEW_CHILD")
	if mode != "admin" && mode != "local" {
		t.Skip("仅由隔离父测试调用")
	}
	// Go测试不在Wails初始化过的主线程运行，须为本测试UI线程初始化COM。
	goruntime.LockOSThread()
	defer goruntime.UnlockOSThread()
	ole32 := syscall.NewLazyDLL("ole32.dll")
	hr, _, _ := ole32.NewProc("CoInitializeEx").Call(0, 2)
	if hr != 0 && hr != 1 {
		t.Fatalf("CoInitializeEx失败：%x", hr)
	}
	defer ole32.NewProc("CoUninitialize").Call()
	var localLoads atomic.Int32
	dsh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("token") == "fixture-token" {
			http.SetCookie(w, &http.Cookie{Name: "fixture-auth", Value: "yes", Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode})
			http.Redirect(w, r, "/", http.StatusSeeOther)
			return
		}
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		if cookie, err := r.Cookie("fixture-auth"); err != nil || cookie.Value != "yes" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		localLoads.Add(1)
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, `<html><body><input id="draft" value="unsent"><button id="probe" onclick="this.textContent='ok'">test</button></body></html>`)
	}))
	defer dsh.Close()
	relay := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, `<html><body><a href="/_admin/machines">remote management</a></body></html>`)
	}))
	defer relay.Close()
	status := backendStatus{Phase: phaseReady, HasURLs: true, DshToken: "fixture-token", RemoteState: "ready", RemoteEnabled: true,
		URLs: backendURLs{Local: relay.URL + "/", Admin: relay.URL + "/_admin", Dsh: dsh.URL + "/"}}
	manager := remoteTestManager(nil)
	manager.setStatus(status)
	stopped := make(chan struct{})
	manager.stdin = &remoteReplyWriter{write: func(data []byte) (int, error) {
		status.RemoteState, status.RemoteEnabled, status.URLs.Local = "stopping", false, status.URLs.Dsh
		manager.setStatus(status)
		relay.Close()
		status.RemoteState = "idle"
		manager.setStatus(status)
		close(stopped)
		return len(data), nil
	}}
	initial := status.URLs.Admin
	if mode == "local" {
		initial = dsh.URL + "/?token=fixture-token"
	}
	var started, success atomic.Bool
	var nav *desktopNavigation
	err := wails.Run(&options.App{
		Title: "DSH isolated navigation check", Width: 640, Height: 480, StartHidden: true,
		Windows:                &windows.Options{WebviewUserDataPath: t.TempDir()},
		BindingsAllowedOrigins: dsh.URL + "," + relay.URL,
		AssetServer:            &assetserver.Options{Handler: startupAssetHandler(initial)},
		OnStartup: func(ctx context.Context) {
			nav = &desktopNavigation{manager: manager,
				beforeRemoteStop: func(s backendStatus) { returnRemotePageToLocal(ctx, s) },
				report:           func(err error) { t.Error(err); runtime.Quit(ctx) },
			}
			runtime.EventsOn(ctx, "fixture-loaded", func(_ ...interface{}) {
				if !started.Swap(true) {
					nav.StopRemote()
				}
				go func() {
					<-stopped
					// 本机文档里执行一次点击，确认回退后渲染器与输入处理仍可用。
					runtime.WindowExecJS(ctx, `(() => {
					  const button = document.getElementById('probe');
					  if (!button) return;
					  button.click();
					  window.chrome.webview.postMessage('EE'+JSON.stringify({name:'fixture-probe',data:[button.textContent==='ok' && document.getElementById('draft').value==='unsent']}));
					})();`)
				}()
			})
			runtime.EventsOn(ctx, "fixture-probe", func(data ...interface{}) {
				if len(data) == 1 && data[0] == true {
					success.Store(true)
				}
				runtime.Quit(ctx)
			})
			timer := time.AfterFunc(25*time.Second, func() { runtime.Quit(ctx) })
			t.Cleanup(func() { timer.Stop() })
		},
		OnDomReady: func(ctx context.Context) {
			s := manager.Status()
			if s.RemoteState == "idle" || s.RemoteState == "stopping" {
				returnRemotePageToLocal(ctx, s)
			}
			runtime.WindowExecJS(ctx, `window.chrome.webview.postMessage('EE'+JSON.stringify({name:'fixture-loaded',data:[]}));`)
		},
		OnShutdown: func(context.Context) { nav.Close() },
	})
	if err != nil {
		t.Fatal(err)
	}
	if !success.Load() || localLoads.Load() != 1 || !started.Load() {
		t.Fatalf("回退或保留本机文档失败：mode=%s success=%v localLoads=%d", mode, success.Load(), localLoads.Load())
	}
	if manager.Status().RemoteState != "idle" || !strings.HasPrefix(manager.Status().URLs.Local, dsh.URL) {
		t.Fatal("停止未完成")
	}
}
