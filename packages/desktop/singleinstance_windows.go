//go:build windows

package main

import (
	"log"
	"syscall"
	"unsafe"
)

var (
	activationKernel32      = syscall.NewLazyDLL("kernel32.dll")
	activationCreateMutex   = activationKernel32.NewProc("CreateMutexW")
	activationUser32        = syscall.NewLazyDLL("user32.dll")
	activationFindWindow    = activationUser32.NewProc("FindWindowW")
	activationShowWindow    = activationUser32.NewProc("ShowWindow")
	activationSetForeground = activationUser32.NewProc("SetForegroundWindow")
	activationIsIconic      = activationUser32.NewProc("IsIconic")
)

const singleInstanceMutexName = `Local\dsh-station-desktop-single-instance`

const (
	activationSWRestore = 9
	activationSWShow    = 5
)

// acquireSingleInstance 抢占命名互斥体。重复启动时不启动第二套壳：
// 唤起已有窗口（还原 + 置前）后返回 false，调用方直接退出。
func acquireSingleInstance(development bool, windowTitle string) (bool, func()) {
	name := singleInstanceMutexName
	if development {
		name += "-dev"
	}
	mutexName, err := syscall.UTF16PtrFromString(name)
	if err != nil {
		// 名字是常量，永远到不了这里；防御性处理为「允许运行」。
		return true, func() {}
	}
	mutex, _, createErr := activationCreateMutex.Call(0, 0, uintptr(unsafe.Pointer(mutexName)))
	if mutex == 0 {
		log.Printf("创建单实例互斥体失败（%v），按首次启动继续", createErr)
		return true, func() {}
	}
	// 已有实例时 GetLastError 返回 ERROR_ALREADY_EXISTS（183）。
	if createErr == syscall.ERROR_ALREADY_EXISTS {
		_ = syscall.CloseHandle(syscall.Handle(mutex))
		activateExistingWindow(windowTitle)
		return false, func() {}
	}
	return true, func() { _ = syscall.CloseHandle(syscall.Handle(mutex)) }
}

// activateExistingWindow 按标题找到已有主窗口并唤起。
func activateExistingWindow(windowTitle string) {
	title, err := syscall.UTF16PtrFromString(windowTitle)
	if err != nil {
		return
	}
	hwnd, _, _ := activationFindWindow.Call(0, uintptr(unsafe.Pointer(title)))
	if hwnd == 0 {
		return
	}
	if iconic, _, _ := activationIsIconic.Call(hwnd); iconic != 0 {
		activationShowWindow.Call(hwnd, activationSWRestore)
	} else {
		activationShowWindow.Call(hwnd, activationSWShow)
	}
	activationSetForeground.Call(hwnd)
}
