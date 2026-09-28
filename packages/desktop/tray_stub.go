//go:build !windows

package main

import "errors"

// 非 Windows 平台的托盘/单实例暂缺（S10 平台适配）：
// 窗口关闭直接退出应用并停止自有后台，避免窗口关掉后无处找回。

type desktopTrayCallbacks struct {
	onShow    func()
	onBrowser func()
	onAdmin   func()
	// onRemote 对应「启用远程服务」（D25）：按需补起 relay + connector。
	onRemote           func()
	onStopRemote       func()
	onRestartRemote    func()
	onQuit             func()
	remoteState        func() remoteMenuState
	stopRemoteState    func() remoteMenuState
	restartRemoteState func() remoteMenuState
}

type desktopTrayHandle struct{}

func (*desktopTrayHandle) Stop() {}

func (*desktopTrayHandle) SetTip(string) {}

func startWindowsTray(desktopTrayCallbacks) (*desktopTrayHandle, error) {
	return nil, errors.New("此平台还没有实现常驻托盘（计划 S10.2）")
}

func acquireSingleInstance(bool, string) (bool, func()) {
	return true, func() {}
}

// setWindowsTaskbarIcon 非 Windows 无任务栏图标重试语义，直接视为完成，
// 让 main.go 的后台重试循环立刻退出。
func setWindowsTaskbarIcon() bool { return true }

// focusMainWindow 非 Windows 没有 Win32 置前，恢复交给 wails 的
// WindowUnminimise/WindowShow 与窗口管理器。
func focusMainWindow() {}
