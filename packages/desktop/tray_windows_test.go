//go:build windows

package main

import (
	"runtime"
	"syscall"
	"testing"
	"time"
	"unsafe"
)

func TestRemoteMenuUpdatesNativeLabelFlagsAndPreservesAdmin(t *testing.T) {
	// 仅创建未显示的原生菜单，验证 Win32 状态，不安装托盘图标或影响焦点。
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	menu, _, callErr := desktopTrayCreatePopupMenu.Call()
	if menu == 0 {
		t.Fatal(desktopTrayError("CreatePopupMenu", callErr))
	}
	defer desktopTrayDestroyMenu.Call(menu)
	if err := appendDesktopTrayMenu(menu, desktopTrayMFString, desktopTrayStartRemote, "启用远程服务"); err != nil {
		t.Fatal(err)
	}
	for _, item := range []struct {
		id    uintptr
		label string
	}{
		{desktopTrayStopRemote, "停止远程服务"}, {desktopTrayRestartRemote, "重启远程服务"},
	} {
		if err := appendDesktopTrayMenu(menu, desktopTrayMFString, item.id, item.label); err != nil {
			t.Fatal(err)
		}
	}
	if err := appendDesktopTrayMenu(menu, desktopTrayMFString, desktopTrayAdmin, "远程管理"); err != nil {
		t.Fatal(err)
	}
	getState := desktopTrayUser32.NewProc("GetMenuState")
	getLabel := desktopTrayUser32.NewProc("GetMenuStringW")
	for _, state := range []remoteMenuState{
		{Label: "启用远程服务", Enabled: true},
		{Label: "正在启用远程服务…"},
		{Label: "远程服务已启用", Checked: true},
		{Label: "远程服务启用失败（请退出并重新打开）"},
		{Label: "远程服务由开发栈管理"},
		{Label: "启用远程服务", Enabled: true},
	} {
		tray := desktopTrayState{menu: menu, remoteState: func() remoteMenuState { return state }}
		if err := tray.updateRemoteMenu(); err != nil {
			t.Fatal(err)
		}
		var text [128]uint16
		getLabel.Call(menu, desktopTrayStartRemote, uintptr(unsafe.Pointer(&text[0])), uintptr(len(text)), 0)
		if got := syscall.UTF16ToString(text[:]); got != state.Label {
			t.Fatalf("原生菜单文案 = %q，期望 %q", got, state.Label)
		}
		flags, _, _ := getState.Call(menu, desktopTrayStartRemote, 0)
		if (flags&desktopTrayMFGrayed == 0) != state.Enabled || (flags&desktopTrayMFChecked != 0) != state.Checked {
			t.Fatalf("原生菜单 flags = %x，期望 %+v", flags, state)
		}
		adminFlags, _, _ := getState.Call(menu, desktopTrayAdmin, 0)
		if adminFlags != 0 {
			t.Fatalf("不应禁用远程管理入口：%x", adminFlags)
		}
	}
}

func TestRemoteCommandRechecksStateBeforeDispatch(t *testing.T) {
	called := make(chan struct{}, 1)
	state := remoteMenuState{Label: "远程服务由开发栈管理"}
	tray := desktopTrayState{
		remoteState: func() remoteMenuState { return state },
		onRemote:    func() { called <- struct{}{} },
	}
	tray.invoke(desktopTrayStartRemote)
	select {
	case <-called:
		t.Fatal("开发模式不得执行空启用操作")
	case <-time.After(20 * time.Millisecond):
	}
	state = remoteMenuState{Label: "启用远程服务", Enabled: true}
	tray.invoke(desktopTrayStartRemote)
	select {
	case <-called:
	case <-time.After(time.Second):
		t.Fatal("可用菜单应执行启用回调")
	}
}

func TestStopRestartNativeMenuStatesAndLabels(t *testing.T) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	menu, _, callErr := desktopTrayCreatePopupMenu.Call()
	if menu == 0 {
		t.Fatal(desktopTrayError("CreatePopupMenu", callErr))
	}
	defer desktopTrayDestroyMenu.Call(menu)
	for _, item := range []struct {
		id    uintptr
		label string
	}{
		{desktopTrayStartRemote, "启用远程服务"}, {desktopTrayStopRemote, "停止远程服务"},
		{desktopTrayRestartRemote, "重启远程服务"}, {desktopTrayAdmin, "远程管理"},
	} {
		if err := appendDesktopTrayMenu(menu, desktopTrayMFString, item.id, item.label); err != nil {
			t.Fatal(err)
		}
	}
	manager := remoteTestManager(&remoteCommandWriter{})
	tray := desktopTrayState{menu: menu,
		remoteState:        func() remoteMenuState { return manager.RemoteMenu() },
		stopRemoteState:    func() remoteMenuState { return manager.StopRemoteMenu() },
		restartRemoteState: func() remoteMenuState { return manager.RestartRemoteMenu() },
	}
	getState := desktopTrayUser32.NewProc("GetMenuState")
	getLabel := desktopTrayUser32.NewProc("GetMenuStringW")
	for _, state := range []string{"idle", "ready", "starting", "stopping", "failed", "trust", "exited", "placeholder", "attach"} {
		t.Run(state, func(t *testing.T) {
			manager = remoteTestManager(&remoteCommandWriter{})
			manager.setStatus(remoteControlStatus(state))
			switch state {
			case "trust":
				status := remoteControlStatus("ready")
				status.Phase = phaseRestarting
				manager.setStatus(status)
			case "exited":
				manager.setStatus(backendStatus{Phase: phaseOffline})
			case "placeholder":
				manager.setStatus(remoteControlStatus("ready"))
				if err := manager.RestartRemote(); err != nil {
					t.Fatal(err)
				}
			case "attach":
				manager = nil
			}
			if err := tray.updateRemoteMenu(); err != nil {
				t.Fatal(err)
			}
			for _, id := range []uintptr{desktopTrayStartRemote, desktopTrayStopRemote, desktopTrayRestartRemote} {
				var text [128]uint16
				length, _, _ := getLabel.Call(menu, id, uintptr(unsafe.Pointer(&text[0])), uintptr(len(text)), 0)
				want := tray.actionMenu(id)
				if length == 0 || syscall.UTF16ToString(text[:]) != want.Label {
					t.Fatalf("原生菜单文字不匹配：%q / %+v", syscall.UTF16ToString(text[:]), want)
				}
				flags, _, _ := getState.Call(menu, id, 0)
				if uint32(flags) == ^uint32(0) || (flags&desktopTrayMFGrayed == 0) != want.Enabled || (flags&desktopTrayMFChecked != 0) != want.Checked {
					t.Fatalf("原生菜单状态错误：%x / %+v", flags, want)
				}
				if id != desktopTrayStartRemote && want.Enabled != (state == "ready") {
					t.Fatal("停止/重启只可在远程就绪时启用")
				}
			}
			flags, _, _ := getState.Call(menu, desktopTrayAdmin, 0)
			if flags != 0 {
				t.Fatal("远程控制不能禁用管理加载入口")
			}
		})
	}
}

func TestStopRestartNativeDispatchRechecksAndReservesSynchronously(t *testing.T) {
	for _, id := range []uintptr{desktopTrayStopRemote, desktopTrayRestartRemote} {
		manager := remoteTestManager(&remoteCommandWriter{})
		manager.setStatus(remoteControlStatus("idle"))
		calls := 0
		tray := desktopTrayState{
			stopRemoteState: manager.StopRemoteMenu, restartRemoteState: manager.RestartRemoteMenu,
			onStopRemote:    func() { calls++; _ = manager.StopRemote() },
			onRestartRemote: func() { calls++; _ = manager.RestartRemote() },
		}
		tray.invoke(id)
		if calls != 0 {
			t.Fatal("展开菜单后状态变化必须再次拒绝")
		}
		manager.setStatus(remoteControlStatus("ready"))
		tray.invoke(id)
		if calls != 1 {
			t.Fatal("动作必须同步占位，不能在返回消息循环后才禁用")
		}
		tray.invoke(id)
		if calls != 1 {
			t.Fatal("重复分发不得重复执行")
		}
		tray.stopRemoteState, tray.restartRemoteState = nil, nil
		tray.invoke(id)
		if calls != 1 {
			t.Fatal("无控制状态时必须只读")
		}
	}
}
