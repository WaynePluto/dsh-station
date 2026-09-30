package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"sync/atomic"
	"time"

	goruntime "runtime"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

func assetServerOrigin() string {
	if goruntime.GOOS == "darwin" {
		return "wails://wails/"
	}
	return "http://wails.localhost/"
}

// AssetServer 只负责初次导航，业务始终使用真实 dsh/relay origin。
func assetHandler(manager *backendManager, attachRelayURL string) http.Handler {
	if manager != nil {
		return statusHandler(manager)
	}
	return bootstrapHandler(attachRelayURL)
}

func trayTipText(status backendStatus) string {
	suffix := ""
	if status.Phase != phaseFailed && status.Phase != phaseOffline && !status.RemoteEnabled {
		suffix = " · 本机模式"
	}
	if status.RemoteState == "failed" {
		suffix += " · 远程操作失败"
	}
	label := phaseLabel(status.displayPhase())
	if status.Phase == phaseRemote && status.RemoteState == "stopping" {
		label = "正在停止远程服务"
	}
	if status.HasURLs {
		return fmt.Sprintf("DSH 工作站 · %s · %s%s", label, status.URLs.Local, suffix)
	}
	return "DSH 工作站 · " + label + suffix
}

func main() {
	config, err := parseRunOptions(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	if config.selfCheck {
		if config.mode == modeAttach {
			fmt.Println("dsh-station 桌面（attach 诊断模式）参数有效；未启动窗口或后台")
			return
		}
		payload, discoveryErr := payloadFor(config)
		if discoveryErr != nil {
			fmt.Fprintf(os.Stderr, "自检失败：%v\n", discoveryErr)
			os.Exit(1)
		}
		fmt.Printf("dsh-station 桌面自检通过：载荷 %s；Node %s（随包=%v）\n",
			payload.packageDir, payload.nodePath, payload.bundledNode)
		return
	}

	// 启动计时只写日志，不参与任何启动决策；用于定位“双击到进入工作台”的耗时分布。
	startupStarted := time.Now()

	var window, stopTray atomic.Value
	currentWindow := func() context.Context {
		if value := window.Load(); value != nil {
			return value.(context.Context)
		}
		return nil
	}
	windowTitle, barTitleSuffix := "DSH 工作站", ""
	if config.devRoot != "" || config.mode == modeAttach {
		windowTitle += " (dev)"
		barTitleSuffix = " (dev)"
	}
	if config.mode == modeStandalone {
		ok, release := acquireSingleInstance(config.devRoot != "", windowTitle)
		if !ok {
			return
		}
		defer release()
	}
	log.Printf("[启动计时] 单实例检查完成 +%v", time.Since(startupStarted).Round(time.Millisecond))

	var manager *backendManager
	var discoveryFailure error
	notifyToken := ""
	relayURL, adminURL := config.relayURL, config.adminURL
	if config.mode == modeStandalone {
		relayURL, adminURL = "http://127.0.0.1:30809/", "http://127.0.0.1:30809/_admin"
		payload, discoveryErr := payloadFor(config)
		discoveryFailure = discoveryErr
		// 开发与发行可同时运行，不争抢发行版的通知管道端口。
		if config.devRoot == "" {
			notifyToken = newNotifyToken()
		}
		manager = newBackendManager(payload, notifyToken, nil)
		if discoveryErr != nil {
			manager.setStatus(backendStatus{Phase: phaseFailed, Detail: discoveryErr.Error()})
		}
	}
	chrome := &Chrome{currentWindow: currentWindow, resolve: func() (string, string) {
		if manager != nil {
			if status := manager.Status(); status.HasURLs {
				home := status.URLs.Local
				if !status.RemoteEnabled && status.DshToken != "" {
					home = strings.TrimSuffix(home, "/") + "/?token=" + status.DshToken
				}
				return home, status.URLs.Admin
			}
		}
		return relayURL, adminURL
	}}

	var lastPhase atomic.Value
	lastPhase.Store(phaseOffline)
	if manager != nil {
		manager.onChange = func(status backendStatus) {
			if status.Phase != lastPhase.Swap(status.Phase).(backendPhase) {
				log.Printf("[启动计时] 后台阶段 %s +%v", status.Phase, time.Since(startupStarted).Round(time.Millisecond))
				if status.Phase == phaseReady || status.Phase == phaseFailed || status.Phase == phaseOffline {
					if ctx := currentWindow(); ctx != nil {
						runtime.WindowShow(ctx)
					}
				}
			}
			if value := stopTray.Load(); value != nil {
				value.(*desktopTrayHandle).SetTip(trayTipText(status))
			}
		}
	}

	// 只等待启动初期的精确地址握手；构建和 dsh 启动仍与 WebView2 初始化并行。
	origin := ""
	initialURLs := backendURLs{}
	if manager == nil {
		origin, _ = bindingOrigin(relayURL)
		initialURLs = backendURLs{Local: relayURL, Dsh: relayURL, Admin: adminURL}
	} else if discoveryFailure == nil {
		if startErr := manager.Start(); startErr != nil {
			manager.setStatus(backendStatus{Phase: phaseFailed, Detail: startErr.Error()})
		} else {
			defer manager.StopAndWait()
			log.Printf("[启动计时] 后台进程已拉起 +%v", time.Since(startupStarted).Round(time.Millisecond))
			urls, handshakeErr := manager.waitForURLConfig(5 * time.Second)
			if handshakeErr != nil {
				manager.StopAndWait()
				manager.setStatus(backendStatus{Phase: phaseFailed, Detail: handshakeErr.Error()})
			} else {
				initialURLs = urls
				origin, _ = backendBindingOrigins(urls)
				log.Printf("[启动计时] 地址握手完成 +%v", time.Since(startupStarted).Round(time.Millisecond))
			}
		}
	}

	navigation := &desktopNavigation{
		manager: manager, resolve: chrome.resolve,
		beforeRemoteStop: func(status backendStatus) {
			if ctx := currentWindow(); ctx != nil {
				returnRemotePageToLocal(ctx, status)
			}
		},
		open: func(address string, external bool) {
			if ctx := currentWindow(); ctx != nil {
				if external {
					runtime.BrowserOpenURL(ctx, address)
				} else {
					navigateWindow(ctx, address)
				}
			}
		},
		report: func(err error) {
			if ctx := currentWindow(); ctx != nil {
				_, _ = runtime.MessageDialog(ctx, runtime.MessageDialogOptions{
					Type: runtime.ErrorDialog, Title: "远程服务操作失败",
					Message: err.Error() + "\n\n请检查后台状态；需要重试远程服务时，请退出并重新打开工作站。",
				})
			}
		},
	}
	defer navigation.Close()
	chrome.admin = navigation.OpenAdmin

	initialHandler := assetHandler(manager, relayURL)
	if manager != nil {
		loading, loadingErr := newStartupLoadingServer(manager)
		if loadingErr != nil {
			manager.StopAndWait()
			manager.setStatus(backendStatus{Phase: phaseFailed, Detail: "无法创建本机启动加载页，请退出并重新打开。"})
			log.Printf("启动加载页创建失败：%v", loadingErr)
		} else {
			defer loading.Close()
			initialHandler = startupAssetHandler(loading.URL())
		}
	}

	if err := wails.Run(&options.App{
		Title: windowTitle,
		// 与本机启动页的浅色背景一致，避免初次导航等待期间闪白。
		BackgroundColour: &options.RGBA{R: 249, G: 250, B: 251, A: 255},
		Width:            1360, Height: 962, MinWidth: 960, MinHeight: 880,
		HideWindowOnClose: true, Frameless: true,
		Bind: []interface{}{chrome}, BindingsAllowedOrigins: origin,
		AssetServer: &assetserver.Options{Handler: initialHandler},
		OnStartup: func(ctx context.Context) {
			log.Printf("[启动计时] WebView2 就绪 +%v", time.Since(startupStarted).Round(time.Millisecond))
			window.Store(ctx)
			runtime.WindowShow(ctx)
			installNotifyActivation(currentWindow)
			if config.mode == modeStandalone && config.devRoot == "" {
				startNotifyPipe(notifyToken, func(event notifyEvent) { showNotifyToast(event) })
			}
			go func() {
				for i := 0; i < 60; i++ {
					if setWindowsTaskbarIcon() {
						return
					}
					time.Sleep(500 * time.Millisecond)
				}
				log.Println("警告：未能设置任务栏图标（60 次重试失败）")
			}()
			trayHandle, trayErr := startWindowsTray(desktopTrayCallbacks{
				remoteState:        func() remoteMenuState { return manager.RemoteMenu() },
				stopRemoteState:    func() remoteMenuState { return manager.StopRemoteMenu() },
				restartRemoteState: func() remoteMenuState { return manager.RestartRemoteMenu() },
				onShow: func() {
					runtime.WindowUnminimise(ctx)
					runtime.WindowShow(ctx)
				},
				onBrowser:       chrome.OpenExternalHome,
				onAdmin:         func() { navigation.OpenAdmin(true) },
				onRemote:        navigation.StartRemote,
				onStopRemote:    navigation.StopRemote,
				onRestartRemote: navigation.RestartRemote,
				onQuit: func() {
					if manager != nil {
						manager.StopAndWait()
					}
					runtime.Quit(ctx)
				},
			})
			if trayErr != nil {
				log.Printf("创建桌面托盘失败：%v", trayErr)
				return
			}
			stopTray.Store(trayHandle)
			if manager == nil {
				trayHandle.SetTip("DSH 工作站 (attach) · 远程服务由外部栈管理")
			} else {
				trayHandle.SetTip(trayTipText(manager.Status()))
			}
		},
		OnDomReady: func(ctx context.Context) {
			// 启动前两分钟内记录每次导航就绪，覆盖加载页与交接后的真实工作台。
			if elapsed := time.Since(startupStarted); elapsed < 2*time.Minute {
				log.Printf("[启动计时] 页面就绪（OnDomReady） +%v", elapsed.Round(time.Millisecond))
			}
			setWindowsTaskbarIcon()
			if manager != nil {
				status := manager.Status()
				if status.RemoteState == "stopping" || status.RemoteState == "idle" {
					// 停止前已在途的管理导航或历史返回也不能留在离线 relay 文档。
					returnRemotePageToLocal(ctx, status)
				}
			}
			// 标题栏不携带 token，来源固定为配置握手中的 dsh/relay。
			injectChromeBar(ctx, initialURLs.Dsh, initialURLs.Admin, barTitleSuffix)
		},
		OnShutdown: func(_ context.Context) {
			navigation.Close()
			if value := stopTray.Load(); value != nil {
				value.(*desktopTrayHandle).Stop()
			}
			if manager != nil {
				manager.StopAndWait()
			}
		},
	}); err != nil {
		log.Printf("桌面窗口启动失败：%v", err)
	}
}
