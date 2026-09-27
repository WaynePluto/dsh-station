package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"net/url"
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

// enableRemoteThenOpenAdmin 触发按需启用远程（D25），等 relay 端口开始监听后
// 在系统浏览器打开管理控制台；超时按当前已知地址打开，由用户自行重试。
func enableRemoteThenOpenAdmin(ctx context.Context, manager *backendManager) {
	manager.StartRemote()
	admin := manager.Status().URLs.Admin
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		status := manager.Status()
		if !status.HasURLs {
			break
		}
		admin = status.URLs.Admin
		if status.RemoteEnabled {
			if parsed, err := url.Parse(admin); err == nil && tcpReachable(parsed.Host) {
				break
			}
		}
		time.Sleep(200 * time.Millisecond)
	}
	runtime.BrowserOpenURL(ctx, admin)
}

// bindingOrigin 返回追加进 BindingsAllowedOrigins 的页面来源。
// 这只放行 Go 绑定调用（自绘条的外部打开等），不是导航白名单。
// attach 模式用实际的开发栈地址；独立模式的 relay 端口由后台运行后
// 才上报，这里固定追加默认端口来源——用户改过 relay 端口时自绘条的
// 「在浏览器中打开」按钮会静默失效（托盘菜单入口不受影响），
// 换来的是 Go 不复制 launcher 的配置解析（计划 §5.1）。
func bindingOrigin(relayURL string) (string, error) {
	parsed, err := url.Parse(relayURL)
	if err != nil {
		return "", err
	}
	if parsed.Scheme != "http" || parsed.Hostname() != "127.0.0.1" {
		return "", fmt.Errorf("绑定来源必须是大机 loopback relay：%q", relayURL)
	}
	return parsed.Scheme + "://" + parsed.Host, nil
}

// assetServerOrigin 是 Wails 内置资产服务器在本机页面的来源。
// 状态页驻留在这里；后台停止/失败时把窗口从 relay 页面导航回这里。
// Windows/Linux 用 http://wails.localhost/，macOS 的 wails:// 形式留待 S10 实测。
func assetServerOrigin() string {
	if goruntime.GOOS == "darwin" {
		return "wails://wails/"
	}
	return "http://wails.localhost/"
}

// assetHandler 选择内置资产服务器的行为：attach 模式维持一次 302 引导，
// 独立模式常驻状态页（就绪后对根路径 302 进真实 relay origin）。
func assetHandler(manager *backendManager, attachRelayURL string) http.Handler {
	if manager != nil {
		return statusHandler(manager)
	}
	return bootstrapHandler(attachRelayURL)
}

// trayTipText 是托盘悬停提示；本机模式（D25）显式标注远程未启用。
func trayTipText(status backendStatus) string {
	suffix := ""
	if status.Phase != phaseFailed && status.Phase != phaseOffline && !status.RemoteEnabled {
		suffix = " · 本机模式"
	}
	if status.HasURLs {
		return fmt.Sprintf("DSH 工作站 · %s · %s%s", phaseLabel(status.displayPhase()), status.URLs.Local, suffix)
	}
	return "DSH 工作站 · " + phaseLabel(status.displayPhase()) + suffix
}

func managerStatus(manager *backendManager) backendStatus {
	if manager == nil {
		return backendStatus{}
	}
	return manager.Status()
}

func main() {
	config, err := parseRunOptions(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	if config.selfCheck {
		if config.mode == modeAttach {
			fmt.Println("dsh-station 桌面（attach 开发模式）参数有效；未启动窗口或后台")
			return
		}
		payload, discoveryErr := discoverPayload(config.appDir)
		if discoveryErr != nil {
			fmt.Fprintf(os.Stderr, "自检失败：%v\n", discoveryErr)
			os.Exit(1)
		}
		fmt.Printf("dsh-station 桌面自检通过：载荷 %s；Node %s（随包=%v）\n",
			payload.packageDir, payload.nodePath, payload.bundledNode)
		return
	}

	var window atomic.Value
	currentWindow := func() context.Context {
		if value := window.Load(); value != nil {
			return value.(context.Context)
		}
		return nil
	}
	var stopTray atomic.Value

	var (
		manager     *backendManager
		relayURL    string
		adminURL    string
		bindingsURL string
		notifyToken string
	)
	// 开发壳用标题后缀与发行版实例区分：同名窗口会让托盘/任务栏激活
	// 与单实例 FindWindow 定位混淆。
	windowTitle := "DSH 工作站"
	barTitleSuffix := ""
	// 载荷发现失败的原因要原样进状态页，不能被后续启动失败覆盖。
	var discoveryFailure error
	if config.mode == modeAttach {
		windowTitle = "DSH 工作站 (dev)"
		barTitleSuffix = " (dev)"
		relayURL = config.relayURL
		adminURL = config.adminURL
		bindingsURL = relayURL
	} else {
		// 独立模式：默认入口按 launcher 的默认 relay 端口声明（见 bindingOrigin）。
		relayURL = "http://127.0.0.1:30809/"
		adminURL = "http://127.0.0.1:30809/_admin"
		bindingsURL = relayURL
		payload, discoveryErr := discoverPayload(config.appDir)
		discoveryFailure = discoveryErr
		notifyToken = newNotifyToken()
		manager = newBackendManager(payload, notifyToken, nil)
		if discoveryErr != nil {
			manager.setStatus(backendStatus{Phase: phaseFailed, Detail: discoveryErr.Error()})
			log.Printf("载荷发现失败：%v", discoveryErr)
		}
	}
	chrome := &Chrome{currentWindow: currentWindow, resolve: func() (string, string) {
		if manager != nil {
			if status := manager.Status(); status.HasURLs {
				home := status.URLs.Local
				// 本机模式（D25）：浏览器打开 dsh 直连地址需要代发一次 token
				// 交换，否则是 dsh 自己的 401（loopback 也不豁免）。
				if !status.RemoteEnabled && status.DshToken != "" {
					home = strings.TrimSuffix(home, "/") + "/?token=" + status.DshToken
				}
				return home, status.URLs.Admin
			}
		}
		return relayURL, adminURL
	}}

	origin, err := bindingOrigin(bindingsURL)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}

	if config.mode == modeStandalone {
		ok, release := acquireSingleInstance()
		if !ok {
			// 重复启动：已唤起既有窗口，直接退出，绝不跑第二套壳+后台。
			return
		}
		defer release()
	}

	// 阶段状态变化：更新托盘提示；就绪/失败时确保窗口可见。
	// 进入 relay 只能靠 webview 初始导航经 AssetServer 302（statusHandler
	// 持有它直到就绪）；页面发起的任何跳转都会被 relay 按 cross-site 拒绝。
	lastPhase := phaseOffline
	if manager != nil {
		manager.onChange = func(status backendStatus) {
			if status.Phase != lastPhase {
				if status.Phase == phaseReady || status.Phase == phaseFailed || status.Phase == phaseOffline {
					if ctx := currentWindow(); ctx != nil {
						runtime.WindowShow(ctx)
					}
				}
				lastPhase = status.Phase
			}
			if value := stopTray.Load(); value != nil {
				value.(*desktopTrayHandle).SetTip(trayTipText(status))
			}
		}
	}

	// 独立模式：后台与 WebView2/窗口初始化并行启动（与 attach 模式对齐——
	// 那边编排器先拉栈再起壳，栈启动同样与壳初始化重叠）。窗口出现时刻是
	// max(WebView2 就绪, relay 监听)，launcher 约 1~2 秒的启动被这段初始化
	// 重叠掉。失败路径不变：phaseFailed 让初始导航落到状态页；wails.Run 失败
	// 直接退出时由 Job Object 回收已拉起的后台。载荷发现失败则不启动，
	// 保留发现原因作为状态页信息。
	if manager != nil && discoveryFailure == nil {
		if err := manager.Start(); err != nil {
			log.Printf("启动后台失败：%v", err)
			manager.setStatus(backendStatus{Phase: phaseFailed, Detail: err.Error()})
		}
	}

	if err := wails.Run(&options.App{
		Title: windowTitle,
		// 等待 relay/后台期间的窗口底色：与 dsh 启动页浅色 --page 同值（relay
		// splash 的 rgb(249,250,251)），避免提前显示的窗口闪白刺眼。深色系统下
		// 这层底色仍是浅色——它只覆盖初始导航被 hold 的短暂窗口。
		BackgroundColour: &options.RGBA{R: 249, G: 250, B: 251, A: 255},
		// 默认窗口取黄金比例（1618:1000≈1.618），在 1080p 下留出任务栏与边距；
		// 页面以 body zoom=(高-36)/高 完整布局进自绘条以下区域。
		Width:                  1360,
		Height:                 962,
		MinWidth:               960,
		MinHeight:              880,
		HideWindowOnClose:      true,
		Frameless:              true,
		Bind:                   []interface{}{chrome},
		BindingsAllowedOrigins: origin,
		AssetServer:            &assetserver.Options{Handler: assetHandler(manager, relayURL)},
		OnStartup: func(ctx context.Context) {
			window.Store(ctx)
			// Wails 默认等首次导航完成（statusHandler/bootstrapHandler 放行
			// 302 且首个页面加载完）才显示窗口，冷启动下用户会有数秒「点了
			// 没反应」。WebView2 环境在本回调前已就绪，这里立即显示：hold
			// 期间展示 BackgroundColour，之后由 relay 的进度页接管。
			runtime.WindowShow(ctx)
			installNotifyActivation(currentWindow)
			if config.mode == modeStandalone {
				startNotifyPipe(notifyToken, func(event notifyEvent) {
					showNotifyToast(event)
				})
			}
			// 窗口显示晚于首次 OnDomReady，图标设置改为后台重试直到枚举到窗口，
			// 否则任务栏按钮、hover 预览和 Alt+Tab 会一直显示系统默认图标。
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
				onShow: func() {
					runtime.WindowUnminimise(ctx)
					runtime.WindowShow(ctx)
				},
				onBrowser: func() {
					home, _ := chrome.resolve()
					runtime.BrowserOpenURL(ctx, home)
				},
				onAdmin: func() {
					// 远程未启用时先按需补起（D25），等 relay 监听后再打开，
					// 避免浏览器先吃到连接拒绝。
					if manager != nil && !manager.Status().RemoteEnabled {
						go enableRemoteThenOpenAdmin(ctx, manager)
						return
					}
					_, admin := chrome.resolve()
					runtime.BrowserOpenURL(ctx, admin)
				},
				onRemote: func() {
					if manager != nil {
						manager.StartRemote()
					}
				},
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
			trayHandle.SetTip(trayTipText(managerStatus(manager)))
		},
		// 每次顶层导航（主页/管理互切、状态页 302、引导 302）后重建自绘标题栏并校正任务栏图标。
		OnDomReady: func(ctx context.Context) {
			setWindowsTaskbarIcon()
			home, admin := chrome.resolve()
			injectChromeBar(ctx, home, admin, barTitleSuffix)
		},
		OnShutdown: func(_ context.Context) {
			if value := stopTray.Load(); value != nil {
				value.(*desktopTrayHandle).Stop()
			}
			if manager != nil {
				manager.StopAndWait()
			}
		},
	}); err != nil {
		log.Fatal(err)
	}
}
