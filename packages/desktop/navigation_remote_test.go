package main

import (
	"errors"
	"strings"
	"testing"
	"testing/synctest"
	"time"
)

func TestNavigationRemoteControlsReserveImmediatelyAndDoNotNavigate(t *testing.T) {
	for _, action := range []remoteAction{remoteStop, remoteRestart} {
		synctest.Test(t, func(t *testing.T) {
			writer := &remoteCommandWriter{}
			manager := remoteTestManager(writer)
			manager.setStatus(remoteControlStatus("ready"))
			n := &desktopNavigation{manager: manager,
				open:   func(string, bool) { t.Error("托盘远程控制不能自动切换当前页面") },
				report: func(err error) { t.Errorf("合法生命周期不应报错：%v", err) },
			}
			defer n.Close()
			n.runRemote(action)
			assertRemoteControlsDisabled(t, manager)
			for range 10 {
				n.StartRemote()
				n.StopRemote()
				n.RestartRemote()
			}
			synctest.Wait()
			if len(writer.writes) != 1 {
				t.Fatal("协调器重复发送命令")
			}
			applyRemoteControlStatus(manager, remoteControlStatus("ready"))
			synctest.Wait()
			if !n.pending || n.remoteView().State != "starting" {
				t.Fatal("旧 ready 不能释放协调器或管理页")
			}
			applyRemoteControlStatus(manager, remoteControlStatus("stopping"))
			if action == remoteStop {
				applyRemoteControlStatus(manager, remoteControlStatus("idle"))
				// 在旧等待者清理之前立即操作，不能吞掉已重新可用的菜单点击。
				n.StartRemote()
			} else {
				applyRemoteControlStatus(manager, remoteControlStatus("starting"))
				applyRemoteControlStatus(manager, remoteControlStatus("ready"))
				n.StopRemote()
			}
			synctest.Wait()
			if len(writer.writes) != 2 || !n.pending {
				t.Fatal("新操作被旧等待者丢弃或覆盖")
			}
			if action == remoteStop {
				applyRemoteControlStatus(manager, remoteControlStatus("ready"))
			} else {
				applyRemoteControlStatus(manager, remoteControlStatus("stopping"))
				applyRemoteControlStatus(manager, remoteControlStatus("idle"))
			}
			synctest.Wait()
			if n.pending || manager.remoteRequested {
				t.Fatal("完成后协调器与后台占位都必须释放")
			}
		})
	}
}

func TestNavigationStopRestartReportPipeFailureAndTimeout(t *testing.T) {
	for _, action := range []remoteAction{remoteStop, remoteRestart} {
		for _, outcome := range []string{"pipe", "timeout", "close"} {
			t.Run(string(action)+"/"+outcome, func(t *testing.T) {
				synctest.Test(t, func(t *testing.T) {
					writer := &remoteCommandWriter{}
					if outcome == "pipe" {
						writer.failure = errors.New("broken pipe")
					}
					manager := remoteTestManager(writer)
					manager.setStatus(remoteControlStatus("ready"))
					var reports []error
					n := &desktopNavigation{manager: manager, report: func(err error) { reports = append(reports, err) }}
					defer n.Close()
					n.runRemote(action)
					synctest.Wait()
					if outcome == "timeout" {
						time.Sleep(action.timeout())
					}
					if outcome == "close" {
						n.Close()
					}
					synctest.Wait()
					if outcome == "close" {
						if len(reports) != 0 {
							t.Fatal("退出不应弹失败提示")
						}
						return
					}
					if len(reports) != 1 || !strings.Contains(reports[0].Error(), "无法"+action.label()+"远程服务") {
						t.Fatalf("缺少动作失败提示：%v", reports)
					}
					assertRemoteControlsDisabled(t, manager)
				})
			})
		}
	}
}

func TestRestartWaitAllowsStopAndReadinessBudgets(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		manager := remoteTestManager(&remoteCommandWriter{})
		manager.setStatus(remoteControlStatus("ready"))
		n := &desktopNavigation{manager: manager, report: func(err error) { t.Errorf("重启仍在合法时限内：%v", err) }}
		defer n.Close()
		n.RestartRemote()
		synctest.Wait()
		applyRemoteControlStatus(manager, remoteControlStatus("stopping"))
		time.Sleep(20 * time.Second)
		applyRemoteControlStatus(manager, remoteControlStatus("starting"))
		time.Sleep(19 * time.Second)
		applyRemoteControlStatus(manager, remoteControlStatus("ready"))
		synctest.Wait()
		if n.pending || !manager.RestartRemoteMenu().Enabled {
			t.Fatal("重启完成应释放操作占位")
		}
	})
}

type remoteNotifyingWriter struct {
	remoteCommandWriter
	sent chan string
}

func (writer *remoteNotifyingWriter) Write(data []byte) (int, error) {
	n, err := writer.remoteCommandWriter.Write(data)
	writer.sent <- string(data)
	return n, err
}

func expectRemoteCommand(t *testing.T, writer *remoteNotifyingWriter, action remoteAction) {
	t.Helper()
	select {
	case command := <-writer.sent:
		if command != "{\"type\":\""+string(action)+"\"}\n" {
			t.Fatalf("命令错误：%q", command)
		}
	case <-time.After(time.Second):
		t.Fatal("未发送远程命令")
	}
}

func TestAdminWaitsForStopOrRestartWithoutUsingOldReady(t *testing.T) {
	for _, action := range []remoteAction{remoteStop, remoteRestart} {
		t.Run(string(action), func(t *testing.T) {
			writer := &remoteNotifyingWriter{sent: make(chan string, 10)}
			manager := remoteTestManager(writer)
			manager.setStatus(remoteControlStatus("ready"))
			var pages []string
			var destinations []bool
			n := &desktopNavigation{manager: manager,
				open: func(address string, external bool) {
					pages = append(pages, address)
					destinations = append(destinations, external)
				},
				report: func(err error) { t.Errorf("合法管理竞争不能报错：%v", err) },
			}
			defer n.Close()
			n.runRemote(action)
			assertRemoteControlsDisabled(t, manager)
			n.OpenAdmin(false)
			n.OpenAdmin(true)
			if len(pages) != 2 || pages[0] != pages[1] || pages[0] == manager.Status().URLs.Admin || destinations[0] || !destinations[1] {
				t.Fatalf("管理入口必须立即共用加载页：%v", pages)
			}
			expectRemoteCommand(t, writer, action)
			client := adminLoadingTestClient(t)
			response, body := adminLoadingTestRequest(t, client, "GET", pages[0]+"/status", nil)
			if response.StatusCode != 200 || !strings.Contains(body, `"state":"starting"`) {
				t.Fatalf("旧 ready 不能交接到 relay：%s", body)
			}
			applyRemoteControlStatus(manager, remoteControlStatus("ready"))
			if n.remoteView().State != "starting" {
				t.Fatal("迟到旧状态误认为操作完成")
			}
			applyRemoteControlStatus(manager, remoteControlStatus("stopping"))
			select {
			case command := <-writer.sent:
				t.Fatalf("停止期间不能重复启用：%q", command)
			default:
			}
			if action == remoteStop {
				applyRemoteControlStatus(manager, remoteControlStatus("idle"))
				expectRemoteCommand(t, writer, remoteStart)
			}
			applyRemoteControlStatus(manager, remoteControlStatus("starting"))
			applyRemoteControlStatus(manager, remoteControlStatus("ready"))
			if _, err := manager.waitForRemote(time.Second); err != nil {
				t.Fatal(err)
			}
			response, body = adminLoadingTestRequest(t, client, "GET", pages[0]+"/status", nil)
			if response.StatusCode != 200 || !strings.Contains(body, `"state":"ready"`) {
				t.Fatalf("本次完成后管理页才可交接：%s", body)
			}
			if len(pages) != 2 {
				t.Fatal("后台完成不能自动导航正在使用的 WebView")
			}
			writer.mu.Lock()
			count := len(writer.writes)
			writer.mu.Unlock()
			want := 1
			if action == remoteStop {
				want = 2
			}
			if count != want {
				t.Fatalf("意外重复启用：%d", count)
			}
		})
	}
}

func TestAttachNavigationRemoteControlsAreReadOnly(t *testing.T) {
	var opened []string
	n := &desktopNavigation{resolve: func() (string, string) { return "http://127.0.0.1:31809/", "http://127.0.0.1:31809/_admin" },
		open:   func(address string, _ bool) { opened = append(opened, address) },
		report: func(err error) { t.Errorf("attach 无控制动作：%v", err) },
	}
	defer n.Close()
	n.StartRemote()
	n.StopRemote()
	n.RestartRemote()
	n.OpenAdmin(false)
	if len(opened) != 1 || opened[0] != "http://127.0.0.1:31809/_admin" || n.pending || n.loading != nil {
		t.Fatal("attach 管理导航不得取得生命周期控制")
	}
}
