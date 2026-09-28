package main

import (
	"context"
	"errors"
	"os/exec"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"
)

func assertBackendEvent(t *testing.T, changed <-chan struct{}, closed bool) {
	t.Helper()
	if changed == nil {
		t.Fatal("订阅信号不能为 nil")
	}
	select {
	case <-changed:
		if !closed {
			t.Fatal("没有新变化时不应广播")
		}
	default:
		if closed {
			t.Fatal("状态变化没有关闭旧订阅信号")
		}
	}
}

func runBackendEventAction(t *testing.T, action func() error) {
	t.Helper()
	done := make(chan error, 1)
	go func() { done <- action() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("状态回调重入读取时死锁")
	}
}

func TestBackendEventsMutationPathsAndReentrantCallbacks(t *testing.T) {
	for _, test := range []struct {
		name    string
		prepare func(*backendManager)
		mutate  func(*backendManager) error
		want    backendObservation
	}{
		{
			name: "setStatus",
			mutate: func(m *backendManager) error {
				m.setStatus(backendStatus{Phase: phaseDsh, Detail: "启动中"})
				return nil
			},
			want: backendObservation{Status: backendStatus{Phase: phaseDsh, Detail: "启动中"}},
		},
		{
			name: "applyLine status",
			mutate: func(m *backendManager) error {
				m.applyLine(`{"type":"status","protocol":1,"phase":"remote","remoteState":"starting"}`)
				return nil
			},
			want: backendObservation{Status: backendStatus{Phase: phaseRemote, RemoteState: "starting"}},
		},
		{
			name: "applyLine exit",
			mutate: func(m *backendManager) error {
				m.applyLine(`{"type":"exit","protocol":1,"message":"配置错误"}`)
				return nil
			},
			want: backendObservation{Status: backendStatus{Phase: phaseFailed, Detail: "配置错误"}},
		},
		{
			name:   "Stop without process",
			mutate: (*backendManager).Stop,
			want:   backendObservation{Status: backendStatus{Phase: phaseOffline}},
		},
		{
			name: "Stop running process",
			prepare: func(m *backendManager) {
				m.cmd = &exec.Cmd{}
				m.stdin = &remoteCommandWriter{}
				m.exited = make(chan struct{})
				close(m.exited)
			},
			mutate: (*backendManager).Stop,
			want:   backendObservation{Status: backendStatus{Phase: phaseStopping}},
		},
		{
			name: "StartRemote placeholder",
			prepare: func(m *backendManager) {
				m.cmd = &exec.Cmd{}
				m.stdin = &remoteCommandWriter{}
			},
			mutate: (*backendManager).StartRemote,
			want:   backendObservation{Status: backendStatus{Phase: phaseReady}, RemoteRequested: true},
		},
		{
			name: "remoteFailure",
			mutate: func(m *backendManager) error {
				err := m.remoteFailure("控制通道断开")
				if err == nil || err.Error() != "控制通道断开" {
					return errors.New("壳侧错误丢失")
				}
				return nil
			},
			want: backendObservation{Status: backendStatus{Phase: phaseReady}, RemoteError: "控制通道断开"},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			manager := newTestManager()
			manager.status = backendStatus{Phase: phaseReady}
			if test.prepare != nil {
				test.prepare(manager)
			}
			_, changed := manager.Observe()
			var callbackStatus backendStatus
			var callbackObservation backendObservation
			var calls int
			manager.onChange = func(status backendStatus) {
				_ = manager.Status()
				_ = manager.RemoteMenu()
				callbackObservation, _ = manager.Observe()
				callbackStatus = status
				calls++
			}
			runBackendEventAction(t, func() error { return test.mutate(manager) })
			assertBackendEvent(t, changed, true)
			observation, next := manager.Observe()
			assertBackendEvent(t, next, false)
			if next == changed || observation != test.want {
				t.Fatalf("广播后快照错误：%+v，期望 %+v", observation, test.want)
			}
			if calls != 1 || callbackStatus != test.want.Status || callbackObservation != test.want {
				t.Fatalf("回调应在解锁后执行一次并可读新状态：次数=%d 快照=%+v", calls, callbackObservation)
			}
		})
	}
}

func TestBackendEventsObserveBeforeWaitDoesNotLoseChanges(t *testing.T) {
	manager := remoteTestManager(&remoteCommandWriter{})
	if err := manager.StartRemote(); err != nil {
		t.Fatal(err)
	}
	before, changed := manager.Observe()
	// 刻意在读取快照之后、真正等待之前完成两次变化。
	manager.remoteFailure("broken pipe")
	manager.applyLine(`{"type":"status","protocol":1,"phase":"remote"}`)
	assertBackendEvent(t, changed, true)
	after, next := manager.Observe()
	if before != (backendObservation{Status: backendStatus{Phase: phaseReady}, RemoteRequested: true}) {
		t.Fatalf("旧快照不应被后续变化修改：%+v", before)
	}
	if after != (backendObservation{Status: backendStatus{Phase: phaseRemote}, RemoteRequested: true, RemoteError: "broken pipe"}) {
		t.Fatalf("新快照必须包含所有已发生的变化：%+v", after)
	}
	assertBackendEvent(t, next, false)
}

func TestBackendEventsObserveSupportsZeroValue(t *testing.T) {
	manager := &backendManager{}
	before, changed := manager.Observe()
	if before != (backendObservation{}) {
		t.Fatal("零值快照错误")
	}
	assertBackendEvent(t, changed, false)
	manager.setStatus(backendStatus{Phase: phaseConfig})
	assertBackendEvent(t, changed, true)
}

func TestBackendEventsNoopPathsDoNotBroadcast(t *testing.T) {
	manager := remoteTestManager(&remoteCommandWriter{})
	var calls int
	manager.onChange = func(backendStatus) { calls++ }
	if err := manager.StartRemote(); err != nil {
		t.Fatal(err)
	}
	_, changed := manager.Observe()
	if err := manager.StartRemote(); err != nil {
		t.Fatal(err)
	}
	manager.applyLine(`{"type":"unknown","protocol":1}`)
	manager.applyLine(`{"type":"status","protocol":2,"phase":"failed"}`)
	manager.applyLine(`not json`)
	assertBackendEvent(t, changed, false)
	manager.remoteFailure("broken pipe")
	_, changed = manager.Observe()
	for range 10 {
		manager.remoteFailure("broken pipe")
		if _, err := manager.waitForRemote(time.Second); err == nil || err.Error() != "broken pipe" {
			t.Fatalf("重复读取失败应保留原因：%v", err)
		}
	}
	assertBackendEvent(t, changed, false)
	if calls != 2 {
		t.Fatalf("占位与首次失败各广播一次，不能因重复读取而自旋：%d", calls)
	}
	manager = newTestManager()
	manager.setStatus(backendStatus{Phase: phaseOffline})
	_, changed = manager.Observe()
	if err := manager.Stop(); err != nil {
		t.Fatal(err)
	}
	assertBackendEvent(t, changed, false)
}

func TestBackendEventsStartBroadcastsAndClearsRemoteState(t *testing.T) {
	// go version 不接受 --desktop，会立即退出；这里只验证真实启动路径，不启动 dsh。
	manager := newBackendManager(desktopPayload{nodePath: "go", entry: "version"}, "", nil)
	manager.status = backendStatus{Phase: phaseOffline}
	manager.remoteRequested = true
	manager.remoteError = "上次失败"
	_, changed := manager.Observe()
	observations := make(chan backendObservation, 2)
	manager.onChange = func(backendStatus) {
		_ = manager.Status()
		_ = manager.RemoteMenu()
		observation, _ := manager.Observe()
		observations <- observation
	}
	runBackendEventAction(t, manager.Start)
	assertBackendEvent(t, changed, true)
	select {
	case started := <-observations:
		if started != (backendObservation{Status: backendStatus{Phase: phaseConfig, Detail: "后台进程已启动"}}) {
			t.Fatalf("启动应原子清理远程壳侧状态并广播：%+v", started)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("缺少启动回调")
	}
	select {
	case <-observations:
	case <-time.After(5 * time.Second):
		t.Fatal("短进程未正常收尾")
	}
}

func TestBackendEventsAwaitExitBroadcastsAllOutcomes(t *testing.T) {
	for _, initial := range []backendStatus{
		{Phase: phaseStopping},
		{Phase: phaseReady},
		{Phase: phaseFailed, Detail: "具体失败原因"},
	} {
		t.Run(string(initial.Phase), func(t *testing.T) {
			command := exec.Command("go", "version")
			if err := command.Start(); err != nil {
				t.Fatal(err)
			}
			manager := remoteTestManager(&remoteCommandWriter{})
			manager.cmd = command
			manager.status = initial
			_, changed := manager.Observe()
			exited := make(chan struct{})
			stdoutDone := make(chan struct{})
			close(stdoutDone)
			var observed backendObservation
			manager.onChange = func(backendStatus) {
				_ = manager.Status()
				_ = manager.RemoteMenu()
				observed, _ = manager.Observe()
			}
			runBackendEventAction(t, func() error {
				manager.awaitExit(command, exited, stdoutDone)
				return nil
			})
			assertBackendEvent(t, exited, true)
			assertBackendEvent(t, changed, true)
			if manager.cmd != nil || manager.stdin != nil {
				t.Fatal("退出后必须清理进程与控制管道")
			}
			want := backendStatus{Phase: phaseFailed, Detail: "后台进程意外退出"}
			if initial.Phase == phaseStopping {
				want = backendStatus{Phase: phaseOffline}
			} else if initial.Phase == phaseFailed {
				want = initial
			}
			if observed.Status != want {
				t.Fatalf("退出回调状态错误：%+v，期望 %+v", observed.Status, want)
			}
		})
	}
}

func TestBackendEventsWaitForChangeReturnsCurrentStatusOnTimeout(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		manager := newTestManager()
		manager.setStatus(backendStatus{Phase: phaseConfig})
		done := make(chan backendStatus, 1)
		go func() {
			status, changed := manager.WaitForChange(time.Second)
			if changed {
				t.Error("无广播的超时不能标为已收到事件")
			}
			done <- status
		}()
		synctest.Wait()
		// 故意绕过通知，只验证兼容接口的超时分支不会返回订阅时的旧快照。
		manager.mu.Lock()
		manager.status = backendStatus{Phase: phaseDsh}
		manager.mu.Unlock()
		time.Sleep(time.Second)
		synctest.Wait()
		if got := <-done; got.Phase != phaseDsh {
			t.Fatalf("超时必须重新读取状态：%+v", got)
		}
	})
}

type backendRemoteResult struct {
	admin string
	err   error
}

func startBackendRemoteWait(manager *backendManager, ctx context.Context, timeout time.Duration) <-chan backendRemoteResult {
	done := make(chan backendRemoteResult, 1)
	go func() {
		admin, err := manager.waitForRemoteContext(ctx, timeout)
		done <- backendRemoteResult{admin, err}
	}()
	return done
}

func takeBackendRemoteResult(t *testing.T, done <-chan backendRemoteResult) backendRemoteResult {
	t.Helper()
	select {
	case result := <-done:
		return result
	default:
		t.Fatal("等待者未由事件立即唤醒")
		return backendRemoteResult{}
	}
}

func TestBackendEventsRemoteWaitersWakeTogether(t *testing.T) {
	for _, outcome := range []string{"ready", "shell failure", "launcher failure", "pipe failure"} {
		t.Run(outcome, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				writer := &remoteCommandWriter{}
				manager := remoteTestManager(writer)
				var calls atomic.Int32
				manager.onChange = func(backendStatus) { calls.Add(1) }
				waiters := make([]<-chan backendRemoteResult, 32)
				for i := range waiters {
					waiters[i] = startBackendRemoteWait(manager, context.Background(), time.Minute)
				}
				synctest.Wait()
				_, changed := manager.Observe()
				wantError := ""
				switch outcome {
				case "ready":
					manager.applyLine(`{"type":"status","protocol":1,"phase":"ready","remoteEnabled":true,"urls":{"local":"http://127.0.0.1:30809/","admin":"http://127.0.0.1:30809/_admin","dsh":"http://127.0.0.1:3080/"}}`)
				case "shell failure":
					wantError = "壳侧控制通道失败"
					manager.remoteFailure(wantError)
				case "launcher failure":
					wantError = "relay 端口冲突"
					manager.applyLine(`{"type":"status","protocol":1,"phase":"ready","remoteState":"failed","remoteError":"relay 端口冲突"}`)
				case "pipe failure":
					writer.failure = errors.New("broken pipe")
					err := manager.StartRemote()
					if err == nil {
						t.Fatal("发送失败不能成功")
					}
					wantError = err.Error()
				}
				synctest.Wait()
				assertBackendEvent(t, changed, true)
				for _, waiter := range waiters {
					got := takeBackendRemoteResult(t, waiter)
					if wantError == "" {
						if got.err != nil || got.admin != "http://127.0.0.1:30809/_admin" {
							t.Fatalf("就绪地址错误：%+v", got)
						}
					} else if got.err == nil || got.err.Error() != wantError || got.admin != "" {
						t.Fatalf("失败信息错误：%+v，期望 %s", got, wantError)
					}
				}
				wantCalls := int32(1)
				if outcome == "launcher failure" || outcome == "pipe failure" {
					wantCalls = 2
				}
				if calls.Load() != wantCalls {
					t.Fatalf("多个等待者不能重复广播同一错误：%d", calls.Load())
				}
			})
		})
	}
}

func TestBackendEventsRemoteCancellationAndStop(t *testing.T) {
	for _, outcome := range []string{"cancel", "context deadline", "offline", "stopping"} {
		t.Run(outcome, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				manager := newTestManager()
				manager.setStatus(backendStatus{Phase: phaseRemote})
				ctx, cancel := context.WithTimeout(context.Background(), time.Second)
				defer cancel()
				done := startBackendRemoteWait(manager, ctx, time.Minute)
				synctest.Wait()
				switch outcome {
				case "cancel":
					cancel()
				case "context deadline":
					time.Sleep(time.Second)
				case "offline":
					if err := manager.Stop(); err != nil {
						t.Fatal(err)
					}
				case "stopping":
					manager.mu.Lock()
					manager.cmd = &exec.Cmd{}
					manager.exited = make(chan struct{})
					close(manager.exited)
					manager.mu.Unlock()
					if err := manager.Stop(); err != nil {
						t.Fatal(err)
					}
				}
				synctest.Wait()
				got := takeBackendRemoteResult(t, done)
				observation, _ := manager.Observe()
				if !errors.Is(got.err, errRemoteStopped) || got.admin != "" || observation.RemoteError != "" {
					t.Fatalf("退出或取消不能记录/弹出失败：结果=%+v 快照=%+v", got, observation)
				}
			})
		})
	}
}

func TestBackendEventsRemoteTimeoutIsFixedWithOrWithoutUpdates(t *testing.T) {
	for _, updates := range []bool{false, true} {
		synctest.Test(t, func(t *testing.T) {
			manager := newTestManager()
			manager.setStatus(backendStatus{Phase: phaseRemote})
			started := time.Now()
			done := startBackendRemoteWait(manager, context.Background(), 10*time.Second)
			synctest.Wait()
			for range 9 {
				time.Sleep(time.Second)
				if updates {
					manager.applyLine(`{"type":"status","protocol":1,"phase":"remote"}`)
				}
				synctest.Wait()
				select {
				case result := <-done:
					t.Fatalf("不能提前超时：%+v", result)
				default:
				}
			}
			time.Sleep(time.Second)
			synctest.Wait()
			got := takeBackendRemoteResult(t, done)
			observation, changed := manager.Observe()
			want := "等待远程服务就绪超时，未收到后台确认"
			if got.err == nil || got.err.Error() != want || observation.RemoteError != want || time.Since(started) != 10*time.Second {
				t.Fatalf("超时必须固定且保留原文：%+v，耗时 %s", got, time.Since(started))
			}
			manager.waitForRemote(time.Minute)
			assertBackendEvent(t, changed, false)
		})
	}
}

func TestBackendEventsRemoteCancellationPrecedesRecordedFailure(t *testing.T) {
	manager := newTestManager()
	manager.setStatus(backendStatus{Phase: phaseReady})
	manager.remoteFailure("已有失败")
	_, changed := manager.Observe()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := manager.waitForRemoteContext(ctx, time.Minute); !errors.Is(err, errRemoteStopped) {
		t.Fatalf("取消后不应报告已有错误：%v", err)
	}
	assertBackendEvent(t, changed, false)
}
