package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"
)

func remoteControlStatus(state string) backendStatus {
	urls := backendURLs{Local: "http://127.0.0.1:3180/", Dsh: "http://127.0.0.1:3180/", Admin: "http://127.0.0.1:31809/_admin"}
	if state == "ready" {
		urls.Local = "http://127.0.0.1:31809/"
	}
	return backendStatus{Phase: phaseReady, HasURLs: true, URLs: urls, RemoteState: state, RemoteEnabled: state == "ready", DshToken: "private-token"}
}

func applyRemoteControlStatus(manager *backendManager, status backendStatus) {
	line, _ := json.Marshal(backendWireMessage{Type: "status", Protocol: 1, Phase: status.Phase,
		Urls: status.URLs, RemoteState: status.RemoteState, RemoteEnabled: status.RemoteEnabled, DshToken: status.DshToken, RemoteError: status.RemoteError})
	manager.applyLine(string(line))
}

func assertRemoteControlsDisabled(t *testing.T, manager *backendManager) {
	t.Helper()
	if manager.RemoteMenu().Enabled || manager.StopRemoteMenu().Enabled || manager.RestartRemoteMenu().Enabled {
		t.Fatalf("操作中或错误状态必须禁用全部远程控制：%+v / %+v / %+v", manager.RemoteMenu(), manager.StopRemoteMenu(), manager.RestartRemoteMenu())
	}
}

func TestTrayTipDescribesRemoteStopping(t *testing.T) {
	status := remoteControlStatus("stopping")
	status.Phase = phaseRemote
	if tip := trayTipText(status); !strings.Contains(tip, "正在停止远程服务") || strings.Contains(tip, "正在启用") {
		t.Fatalf("停止期间悬停文案错误：%s", tip)
	}
}

func TestStopRestartRemoteMenuAndEligibility(t *testing.T) {
	for _, test := range []struct {
		name    string
		phase   backendPhase
		remote  string
		error   string
		process bool
		want    bool
	}{
		{"local", phaseReady, "idle", "", true, false},
		{"remote ready", phaseReady, "ready", "", true, true},
		{"starting", phaseRemote, "starting", "", true, false},
		{"remote stopping", phaseReady, "stopping", "", true, false},
		{"trust restarting", phaseRestarting, "ready", "", true, false},
		{"booting", phaseDsh, "idle", "", true, false},
		{"remote failure", phaseReady, "failed", "", true, false},
		{"reported error", phaseReady, "ready", "relay failed", true, false},
		{"offline", phaseOffline, "ready", "", false, false},
		{"failed backend", phaseFailed, "ready", "", false, false},
		{"exiting", phaseStopping, "ready", "", true, false},
		{"no process", phaseReady, "ready", "", false, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			for _, action := range []remoteAction{remoteStop, remoteRestart} {
				writer := &remoteCommandWriter{}
				manager := remoteTestManager(writer)
				status := remoteControlStatus(test.remote)
				status.Phase, status.RemoteError = test.phase, test.error
				manager.setStatus(status)
				if !test.process {
					manager.cmd, manager.stdin = nil, nil
				}
				if manager.StopRemoteMenu().Enabled != test.want || manager.RestartRemoteMenu().Enabled != test.want {
					t.Fatal("菜单可操作性与后台状态不符")
				}
				err := manager.requestRemote(action)
				if (err == nil) != test.want {
					t.Fatalf("请求可操作性错误：%v", err)
				}
				if !test.want && len(writer.writes) != 0 {
					t.Fatal("不可操作时不能写管道")
				}
			}
		})
	}
	var attach *backendManager
	assertRemoteControlsDisabled(t, attach)
	for _, action := range []remoteAction{remoteStart, remoteStop, remoteRestart} {
		if err := attach.requestRemote(action); err == nil {
			t.Fatal("attach 不能拥有后台控制权")
		}
	}
}

func TestRemoteControlDeduplicatesAndRetainsAcknowledgement(t *testing.T) {
	for _, action := range []remoteAction{remoteStop, remoteRestart} {
		t.Run(string(action), func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				writer := &remoteCommandWriter{}
				manager := remoteTestManager(writer)
				manager.setStatus(remoteControlStatus("ready"))
				_, changed := manager.Observe()
				if err := manager.requestRemote(action); err != nil {
					t.Fatal(err)
				}
				assertBackendEvent(t, changed, true)
				request := manager.remoteRequest
				assertRemoteControlsDisabled(t, manager)
				var workers sync.WaitGroup
				for range 30 {
					workers.Add(1)
					go func() { defer workers.Done(); _ = manager.requestRemote(action); _ = manager.StartRemote() }()
				}
				workers.Wait()
				if len(writer.writes) != 1 || writer.writes[0] != "{\"type\":\""+string(action)+"\"}\n" {
					t.Fatalf("重复命令：%q", writer.writes)
				}
				done := make(chan error, 1)
				go func() { done <- manager.waitForRemoteRequest(context.Background(), request, time.Minute) }()
				synctest.Wait()
				applyRemoteControlStatus(manager, remoteControlStatus("ready"))
				// 即使旧 ready 在本次写入后才到达，也不是应答。
				synctest.Wait()
				assertRemoteControlsDisabled(t, manager)
				select {
				case err := <-done:
					t.Fatalf("旧 ready 提前完成：%v", err)
				default:
				}
				applyRemoteControlStatus(manager, remoteControlStatus("stopping"))
				if manager.Status().URLs.Local != manager.Status().URLs.Dsh {
					t.Fatal("停止应答应保留 launcher 切回的本机地址")
				}
				if action == remoteRestart {
					applyRemoteControlStatus(manager, remoteControlStatus("starting"))
					assertRemoteControlsDisabled(t, manager)
					trust := remoteControlStatus("ready")
					trust.Phase = phaseRestarting
					applyRemoteControlStatus(manager, trust)
					assertRemoteControlsDisabled(t, manager)
					applyRemoteControlStatus(manager, remoteControlStatus("ready"))
				} else {
					// 停止中 remoteEnabled=false 不等于已经回收远程链路。
					synctest.Wait()
					select {
					case err := <-done:
						t.Fatalf("idle 前提前完成：%v", err)
					default:
					}
					applyRemoteControlStatus(manager, remoteControlStatus("idle"))
				}
				synctest.Wait()
				if err := <-done; err != nil {
					t.Fatal(err)
				}
				observation, _ := manager.Observe()
				if observation.RemoteRequested {
					t.Fatal("完成后占位标记必须复位")
				}
				if action == remoteStop && !manager.RemoteMenu().Enabled {
					t.Fatal("停止后应恢复启用")
				}
				if action == remoteRestart && (!manager.StopRemoteMenu().Enabled || !manager.RestartRemoteMenu().Enabled) {
					t.Fatal("重启后应恢复停止和重启")
				}
			})
		})
	}
}

func TestRemoteCanStartAgainAfterStop(t *testing.T) {
	manager := remoteTestManager(&remoteCommandWriter{})
	manager.setStatus(remoteControlStatus("idle"))
	for range 3 {
		if err := manager.StartRemote(); err != nil {
			t.Fatal(err)
		}
		applyRemoteControlStatus(manager, remoteControlStatus("starting"))
		applyRemoteControlStatus(manager, remoteControlStatus("ready"))
		if manager.remoteRequested {
			t.Fatal("启用完成必须清理旧占位")
		}
		if err := manager.StopRemote(); err != nil {
			t.Fatal(err)
		}
		applyRemoteControlStatus(manager, remoteControlStatus("stopping"))
		applyRemoteControlStatus(manager, remoteControlStatus("idle"))
		if manager.remoteRequested || !manager.RemoteMenu().Enabled {
			t.Fatal("停止完成必须恢复启用")
		}
	}
}

type remoteReplyWriter struct{ write func([]byte) (int, error) }

func (w *remoteReplyWriter) Write(data []byte) (int, error) { return w.write(data) }
func (*remoteReplyWriter) Close() error                     { return nil }

func TestRemoteWriteMustSucceedEvenIfRepliesArriveFirst(t *testing.T) {
	for _, action := range []remoteAction{remoteStop, remoteRestart} {
		for _, failure := range []error{errors.New("broken pipe"), io.ErrShortWrite, nil} {
			manager := remoteTestManager(nil)
			manager.setStatus(remoteControlStatus("ready"))
			writes := 0
			manager.stdin = &remoteReplyWriter{write: func(data []byte) (int, error) {
				writes++
				assertRemoteControlsDisabled(t, manager)
				applyRemoteControlStatus(manager, remoteControlStatus("stopping"))
				if action == remoteStop {
					applyRemoteControlStatus(manager, remoteControlStatus("idle"))
				} else {
					applyRemoteControlStatus(manager, remoteControlStatus("ready"))
				}
				assertRemoteControlsDisabled(t, manager)
				if failure == io.ErrShortWrite {
					return 1, nil
				}
				if failure != nil {
					return 0, failure
				}
				return len(data), nil
			}}
			err := manager.requestRemote(action)
			if failure == nil {
				if err != nil || manager.remoteRequested {
					t.Fatalf("合法先应答后写成功未完成：%v", err)
				}
			} else {
				if err == nil || !strings.Contains(err.Error(), failure.Error()) {
					t.Fatalf("管道失败不能假报成功：%v", err)
				}
				assertRemoteControlsDisabled(t, manager)
				if err := manager.requestRemote(action); err == nil || writes != 1 {
					t.Fatal("管道失败不能重发")
				}
			}
		}
	}
}

func TestRemoteControlWaitTimeoutFailureAndCancellation(t *testing.T) {
	for _, action := range []remoteAction{remoteStop, remoteRestart} {
		for _, outcome := range []string{"timeout", "failed", "exit", "cancel"} {
			t.Run(string(action)+"/"+outcome, func(t *testing.T) {
				synctest.Test(t, func(t *testing.T) {
					manager := remoteTestManager(&remoteCommandWriter{})
					manager.setStatus(remoteControlStatus("ready"))
					if err := manager.requestRemote(action); err != nil {
						t.Fatal(err)
					}
					ctx, cancel := context.WithCancel(context.Background())
					defer cancel()
					done := make(chan error, 1)
					request := manager.remoteRequest
					go func() { done <- manager.waitForRemoteRequest(ctx, request, time.Second) }()
					synctest.Wait()
					switch outcome {
					case "timeout":
						time.Sleep(time.Second)
					case "failed":
						manager.setStatus(backendStatus{Phase: phaseReady, RemoteState: "failed", RemoteError: "relay failed"})
					case "exit":
						manager.setStatus(backendStatus{Phase: phaseFailed, Detail: "backend exited"})
					case "cancel":
						cancel()
					}
					synctest.Wait()
					err := <-done
					if err == nil {
						t.Fatal("未成功操作必须反馈")
					}
					if outcome == "cancel" {
						if !errors.Is(err, errRemoteStopped) {
							t.Fatal(err)
						}
					} else {
						if outcome == "timeout" && !strings.Contains(err.Error(), "超时") {
							t.Fatal(err)
						}
						assertRemoteControlsDisabled(t, manager)
					}
				})
			})
		}
	}
}
