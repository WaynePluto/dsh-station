package main

import (
	"encoding/json"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestManagedDevelopmentOptionsAndPayload(t *testing.T) {
	root, _ := filepath.Abs("../..")
	config, err := parseRunOptions([]string{"--dev-root", root, "--selfcheck"})
	if err != nil || config.mode != modeStandalone || config.devRoot != root || !config.selfCheck {
		t.Fatalf("开发模式必须使用受管生命周期：%+v %v", config, err)
	}
	payload, err := payloadFor(config)
	if err != nil || payload.entry != filepath.Join(root, "scripts", "dev-desktop-backend.mjs") || payload.nodePath == "" {
		t.Fatalf("开发后端入口错误：%+v %v", payload, err)
	}
	for _, args := range [][]string{{"--dev-root", root, "--attach"}, {"--dev-root", root, "--app-dir", root}} {
		if _, err := parseRunOptions(args); err == nil {
			t.Fatalf("必须拒绝冲突模式：%v", args)
		}
	}
}

func TestBindingHandshakeUsesOnlyExactConfiguredOrigins(t *testing.T) {
	urls := backendURLs{Local: "http://127.0.0.1:43180/", Dsh: "http://127.0.0.1:43180/", Admin: "http://127.0.0.1:43189/_admin"}
	origins, err := backendBindingOrigins(urls)
	if err != nil || origins != "http://127.0.0.1:43180,http://127.0.0.1:43189" {
		t.Fatalf("不能使用硬编码端口或通配符：%q %v", origins, err)
	}
	for _, address := range []string{"http://localhost:3180/", "http://127.0.0.1:3180/?token=secret", "http://127.0.0.1:3180@other/", "http://127.0.0.1:03180/"} {
		bad := urls
		bad.Local, bad.Dsh = address, address
		if _, err := backendBindingOrigins(bad); err == nil {
			t.Fatalf("错误接受来源：%s", address)
		}
	}
	manager := newTestManager()
	message := backendWireMessage{Type: "status", Protocol: 1, Phase: phaseConfig, Urls: urls}
	line, _ := json.Marshal(message)
	manager.applyLine(string(line))
	if got, err := manager.waitForURLConfig(time.Second); err != nil || got != urls {
		t.Fatalf("配置阶段就应完成握手：%+v %v", got, err)
	}
	message.Urls.Admin = "http://127.0.0.1:43190/_admin"
	line, _ = json.Marshal(message)
	manager.applyLine(string(line))
	if manager.Status().Phase != phaseFailed || manager.Status().HasURLs {
		t.Fatal("首次握手后不得变更导航来源")
	}
}

func TestAdminOpensLoadingBeforeSendingRemoteCommand(t *testing.T) {
	writer := &remoteCommandWriter{}
	manager := remoteTestManager(writer)
	manager.status.HasURLs = true
	manager.status.URLs = backendURLs{Local: "http://127.0.0.1:3180/", Dsh: "http://127.0.0.1:3180/", Admin: "http://127.0.0.1:31809/_admin"}
	manager.status.DshToken = "never-expose-this-token"
	var opened []string
	var destinations []bool
	navigation := &desktopNavigation{
		manager: manager,
		open: func(address string, external bool) {
			writer.mu.Lock()
			if len(opened) == 0 && len(writer.writes) != 0 {
				t.Error("打开加载页必须早于启动命令")
			}
			writer.mu.Unlock()
			opened = append(opened, address)
			destinations = append(destinations, external)
			response, err := http.Get(address)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			body, _ := io.ReadAll(response.Body)
			if response.StatusCode != 200 || !strings.Contains(string(body), "正在启用远程服务") || strings.Contains(string(body), manager.status.DshToken) {
				t.Fatal("后台未监听时加载页必须可立即返回且不泄露 token")
			}
		},
		report: func(err error) { t.Errorf("管理入口应就地报错而不是弹窗：%v", err) },
	}
	defer func() { navigation.Close(); manager.setStatus(backendStatus{Phase: phaseStopping}) }()
	navigation.OpenAdmin(false)
	navigation.OpenAdmin(true)
	if len(opened) != 2 || opened[0] != opened[1] || destinations[0] || !destinations[1] {
		t.Fatal("内外浏览器应立即打开同一个受控加载入口")
	}
	deadline := time.Now().Add(time.Second)
	for {
		writer.mu.Lock()
		count := len(writer.writes)
		writer.mu.Unlock()
		if count == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("启用命令数量错误：%d", count)
		}
		time.Sleep(time.Millisecond)
	}
	manager.setStatus(backendStatus{Phase: phaseReady, RemoteState: "failed", RemoteError: "EADDRINUSE", HasURLs: true, URLs: manager.Status().URLs})
	if view := navigation.remoteView(); view.State != "failed" || manager.Status().Phase != phaseReady {
		t.Fatal("远程失败与本机 dsh 状态必须独立")
	}
	response, err := http.Get(opened[0] + "/status")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	if !strings.Contains(string(body), "端口已被占用") || !strings.Contains(manager.RemoteMenu().Label, "失败") {
		t.Fatalf("失败页与菜单应解释当前状态：%s", body)
	}
}

func TestChromeAdminActionsUseSharedCoordinator(t *testing.T) {
	var external []bool
	chrome := &Chrome{admin: func(value bool) { external = append(external, value) }}
	chrome.OpenAdmin()
	chrome.OpenExternalAdmin()
	if len(external) != 2 || external[0] || !external[1] {
		t.Fatal("两个标题栏入口必须走同一启用/加载页流程")
	}
	script := buildChromeBarScript("http://127.0.0.1:3180/", "http://127.0.0.1:31809/_admin", " (dev)")
	if !strings.Contains(script, "call('OpenAdmin')") || strings.Contains(script, "location.assign(ADMIN)") {
		t.Fatal("管理菜单不能直接跳往尚未监听的 relay")
	}
	if !strings.Contains(script, "location.origin !== 'http://127.0.0.1:3180'") || !strings.Contains(script, "location.origin !== 'http://127.0.0.1:31809'") {
		t.Fatal("本机模式与管理页都应有标题栏，但不能匹配其他来源")
	}
}
