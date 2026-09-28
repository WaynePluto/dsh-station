package main

import (
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// 显式开启的真后端检查；使用临时 station/dsh home，不触碰日常会话与远程关系。
func TestManagedRemoteIntegration(t *testing.T) {
	if os.Getenv("DSH_STATION_INTEGRATION") != "1" {
		t.Skip("设置 DSH_STATION_INTEGRATION=1 并先准备开发 runtime/构建产物")
	}
	root, _ := filepath.Abs("../..")
	descriptor, err := os.ReadFile(filepath.Join(root, ".dev", "runtime.json"))
	if err != nil {
		t.Fatal(err)
	}
	var runtimeInfo struct{ Runtime string }
	if err := json.Unmarshal(descriptor, &runtimeInfo); err != nil {
		t.Fatal(err)
	}
	node, err := lookPathNode()
	if err != nil {
		t.Fatal(err)
	}
	previousLog := log.Writer()
	log.SetOutput(io.Discard)
	defer log.SetOutput(previousLog)
	for _, fail := range []bool{false, true} {
		name := "success"
		if fail {
			name = "port-conflict-keeps-dsh"
		}
		t.Run(name, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("DSH_HOME", filepath.Join(home, "dsh"))
			t.Setenv("DSH_STATION_DEV_RUNTIME", runtimeInfo.Runtime)
			dshListener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			relayListener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				dshListener.Close()
				t.Fatal(err)
			}
			defer relayListener.Close()
			dshPort := dshListener.Addr().(*net.TCPAddr).Port
			relayPort := relayListener.Addr().(*net.TCPAddr).Port
			dshListener.Close()
			if !fail {
				relayListener.Close()
			}
			config, _ := json.Marshal(map[string]any{
				"home":  filepath.Join(home, "station"),
				"dsh":   map[string]any{"port": dshPort},
				"relay": map[string]any{"host": "127.0.0.1", "port": relayPort},
			})
			if err := os.WriteFile(filepath.Join(home, "dsh-station.config.json"), config, 0600); err != nil {
				t.Fatal(err)
			}
			manager := newBackendManager(desktopPayload{
				packageDir: home, nodePath: node, entry: filepath.Join(root, "packages", "launcher", "dist", "index.js"),
			}, "", nil)
			if err := manager.Start(); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(manager.StopAndWait)
			startup := startupTestServer(t, manager)
			startupClient := adminLoadingTestClient(t)
			started := time.Now()
			startupResponse, startupBody := adminLoadingTestRequest(t, startupClient, "GET", startup.URL(), nil)
			if startupResponse.StatusCode != 200 || time.Since(started) > 500*time.Millisecond || !strings.Contains(startupBody, "正在准备运行环境") {
				t.Fatal("真实后台启动期间必须立即显示加载页")
			}
			startupStream, frames := openLoadingStream(t, startup, 120*time.Second)
			for {
				frame := readLoadingFrame(t, frames)
				if frame["state"] == "ready" {
					break
				}
				if frame["state"] != "starting" {
					t.Fatal("真实后台启动失败")
				}
			}
			startupStream.Body.Close()
			assertStartupDshHandoff(t, startupClient, startup, manager.Status().URLs.Dsh)
			if manager.Status().RemoteEnabled || manager.Status().RemoteState != "idle" {
				t.Fatal("默认不得启用远程")
			}
			if !fail && tcpReachable("127.0.0.1:"+strconv.Itoa(relayPort)) {
				t.Fatal("默认启动不得监听 relay 端口")
			}
			client := adminLoadingTestClient(t)
			var page string
			navigation := &desktopNavigation{
				manager: manager,
				open: func(address string, external bool) {
					page = address
					started := time.Now()
					response, body := adminLoadingTestRequest(t, client, "GET", address, nil)
					if response.StatusCode != http.StatusOK || time.Since(started) > 500*time.Millisecond || !strings.Contains(body, "正在启用远程服务") {
						t.Fatal("加载页没有立即呈现")
					}
					if manager.Status().RemoteEnabled {
						t.Fatal("必须先开页面再启动远程")
					}
				},
				report: func(err error) { t.Errorf("不应弹窗：%v", err) },
			}
			defer navigation.Close()
			navigation.OpenAdmin(fail)
			remoteStream, remoteFrames := openLoadingStream(t, navigation.loading, 30*time.Second)
			var terminal map[string]any
			for {
				terminal = readLoadingFrame(t, remoteFrames)
				if terminal["state"] != "starting" {
					break
				}
			}
			remoteStream.Body.Close()
			admin, remoteErr := manager.waitForRemote(25 * time.Second)
			if fail {
				if remoteErr == nil || manager.Status().Phase != phaseReady || manager.Status().RemoteState != "failed" {
					t.Fatalf("失败必须只影响远程：%v phase=%s state=%s", remoteErr, manager.Status().Phase, manager.Status().RemoteState)
				}
				if !tcpReachable("127.0.0.1:" + strconv.Itoa(dshPort)) {
					t.Fatal("远程失败停止了 dsh")
				}
			} else if remoteErr != nil || !validAdminLoadingTarget(admin) {
				t.Fatalf("远程链路未就绪：%v", remoteErr)
			}
			if terminal["state"] != manager.Status().RemoteState {
				t.Fatal("状态流未交付远程终态")
			}
			response, body := adminLoadingTestRequest(t, client, "GET", page+"/status", nil)
			if response.StatusCode != http.StatusOK || !strings.Contains(body, manager.Status().RemoteState) {
				t.Fatalf("加载页与真实后台状态不一致：%s", body)
			}
			if !fail {
				assertRemoteControlIntegration(t, manager, relayPort)
			}
			t.Logf("启动/管理各一条事件流交付就绪；顶层302→dsh交换303→首页200；默认仅dsh；最终remoteState=%s，dsh保持运行", manager.Status().RemoteState)
		})
	}
}
