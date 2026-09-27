//go:build windows

package main

import (
	"fmt"
	"log"
	"runtime"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"
)

var (
	desktopTrayKernel32 = syscall.NewLazyDLL("kernel32.dll")
	desktopTrayUser32   = syscall.NewLazyDLL("user32.dll")
	desktopTrayShell32  = syscall.NewLazyDLL("shell32.dll")

	desktopTrayGetModuleHandle       = desktopTrayKernel32.NewProc("GetModuleHandleW")
	desktopTrayRegisterClass         = desktopTrayUser32.NewProc("RegisterClassExW")
	desktopTrayUnregisterClass       = desktopTrayUser32.NewProc("UnregisterClassW")
	desktopTrayCreateWindow          = desktopTrayUser32.NewProc("CreateWindowExW")
	desktopTrayDestroyWindow         = desktopTrayUser32.NewProc("DestroyWindow")
	desktopTrayDefWindowProc         = desktopTrayUser32.NewProc("DefWindowProcW")
	desktopTrayGetMessage            = desktopTrayUser32.NewProc("GetMessageW")
	desktopTrayTranslateMessage      = desktopTrayUser32.NewProc("TranslateMessage")
	desktopTrayDispatchMessage       = desktopTrayUser32.NewProc("DispatchMessageW")
	desktopTrayPostQuitMessage       = desktopTrayUser32.NewProc("PostQuitMessage")
	desktopTrayPostMessage           = desktopTrayUser32.NewProc("PostMessageW")
	desktopTrayRegisterWindowMessage = desktopTrayUser32.NewProc("RegisterWindowMessageW")
	desktopTrayLoadIcon              = desktopTrayUser32.NewProc("LoadIconW")
	desktopTrayLoadImage             = desktopTrayUser32.NewProc("LoadImageW")
	desktopTrayDestroyIcon           = desktopTrayUser32.NewProc("DestroyIcon")
	desktopTrayGetSystemMetrics      = desktopTrayUser32.NewProc("GetSystemMetrics")
	desktopTrayCreatePopupMenu       = desktopTrayUser32.NewProc("CreatePopupMenu")
	desktopTrayAppendMenu            = desktopTrayUser32.NewProc("AppendMenuW")
	desktopTrayDestroyMenu           = desktopTrayUser32.NewProc("DestroyMenu")
	desktopTraySetMenuDefaultItem    = desktopTrayUser32.NewProc("SetMenuDefaultItem")
	desktopTraySetForegroundWindow   = desktopTrayUser32.NewProc("SetForegroundWindow")
	desktopTrayGetCursorPos          = desktopTrayUser32.NewProc("GetCursorPos")
	desktopTrayTrackPopupMenu        = desktopTrayUser32.NewProc("TrackPopupMenu")
	desktopTrayEnumWindows           = desktopTrayUser32.NewProc("EnumWindows")
	desktopTraySendMessage           = desktopTrayUser32.NewProc("SendMessageW")
	desktopTrayIsWindowVisible       = desktopTrayUser32.NewProc("IsWindowVisible")
	desktopTrayGetWindowThreadPID    = desktopTrayUser32.NewProc("GetWindowThreadProcessId")
	desktopTraySetClassLongPtr       = desktopTrayUser32.NewProc("SetClassLongPtrW")
	desktopTrayNotifyIcon            = desktopTrayShell32.NewProc("Shell_NotifyIconW")

	desktopTrayClassNumber atomic.Uint64
	desktopTrayWindows     sync.Map
	desktopTrayCallback    = syscall.NewCallback(desktopTrayWndProc)
	desktopTrayEnumProc    = syscall.NewCallback(desktopTrayIconEnumProc)
)

const (
	desktopTrayWMClose       = 0x0010
	desktopTrayWMDestroy     = 0x0002
	desktopTrayWMNCDestroy   = 0x0082
	desktopTrayWMNull        = 0x0000
	desktopTrayWMContextMenu = 0x007b
	desktopTrayWMLButtonDbl  = 0x0203
	desktopTrayWMRButtonUp   = 0x0205
	desktopTrayWMCallback    = 0x8001
	desktopTrayWMSetIcon     = 0x0080

	desktopTrayNIMAdd     = 0
	desktopTrayNIMModify  = 1
	desktopTrayNIMDelete  = 2
	desktopTrayNIFMessage = 1
	desktopTrayNIFIcon    = 2
	desktopTrayNIFTip     = 4

	desktopTrayMFString        = 0
	desktopTrayMFPopup         = 0x0010
	desktopTrayMFSeparator     = 0x0800
	desktopTrayTPMRightButton  = 0x0002
	desktopTrayTPMBottomAlign  = 0x0020
	desktopTrayTPMNonNotify    = 0x0080
	desktopTrayTPMReturnCmd    = 0x0100
	desktopTrayIDIApplication  = 32512
	desktopTrayImageIcon       = 1
	desktopTraySmallIconWidth  = 49
	desktopTraySmallIconHeight = 50
	desktopTrayAppIconResource = 1
	desktopTrayIconBig         = 1
	desktopTrayIconSmall       = 0
	desktopTrayLargeIconWidth  = 11
	desktopTrayLargeIconHeight = 12
	desktopTrayClassIconBig    = ^uintptr(13) // GCLP_HICON = -14
	desktopTrayClassIconSmall  = ^uintptr(33) // GCLP_HICONSM = -34
)

const (
	desktopTrayShow = iota + 1
	desktopTrayBrowser
	desktopTrayAdmin
	desktopTrayStartRemote
	desktopTrayQuit
)

// desktopTrayCallbacks 是托盘菜单触发的全部动作。后台启停不在托盘：
// 退出重开即等价于重启，失败页文案直接引导（见 statuspage.go）。
// 「启用远程服务」是本机模式（D25）按需补起 relay + connector 的唯一入口。
type desktopTrayCallbacks struct {
	onShow    func()
	onBrowser func()
	onAdmin   func()
	onRemote  func()
	onQuit    func()
}

type desktopTrayPoint struct {
	x, y int32
}

type desktopTrayMessage struct {
	hwnd    uintptr
	message uint32
	wParam  uintptr
	lParam  uintptr
	time    uint32
	pt      desktopTrayPoint
}

type desktopTrayWindowClass struct {
	cbSize     uint32
	style      uint32
	wndProc    uintptr
	clsExtra   int32
	wndExtra   int32
	instance   uintptr
	icon       uintptr
	cursor     uintptr
	background uintptr
	menuName   *uint16
	className  *uint16
	iconSmall  uintptr
}

type desktopTrayIconData struct {
	cbSize          uint32
	hwnd            uintptr
	id              uint32
	flags           uint32
	callbackMessage uint32
	icon            uintptr
	tip             [128]uint16
	state           uint32
	stateMask       uint32
	info            [256]uint16
	version         uint32
	infoTitle       [64]uint16
	infoFlags       uint32
	guid            [16]byte
	balloonIcon     uintptr
}

type desktopTrayState struct {
	hwnd           uintptr
	instance       uintptr
	className      *uint16
	classReady     bool
	menu           uintptr
	icon           uintptr
	iconOwned      bool
	iconAdded      bool
	destroyed      bool
	closeMu        sync.Mutex
	closed         bool
	running        bool
	taskbarCreated uint32
	mu             sync.Mutex
	tipText        [128]uint16
	onShow         func()
	onBrowser      func()
	onAdmin        func()
	onRemote       func()
	onQuit         func()
}

func desktopTrayError(operation string, callErr error) error {
	if callErr == nil || callErr == syscall.Errno(0) {
		return fmt.Errorf("%s 失败（Windows 未提供错误码）", operation)
	}
	return fmt.Errorf("%s 失败：%w", operation, callErr)
}

func (tray *desktopTrayState) iconData() desktopTrayIconData {
	data := desktopTrayIconData{
		hwnd: tray.hwnd, id: 1, callbackMessage: desktopTrayWMCallback, icon: tray.icon,
	}
	data.cbSize = uint32(unsafe.Sizeof(data))
	copy(data.tip[:], tray.tipText[:])
	return data
}

func (tray *desktopTrayState) addIcon() error {
	tray.mu.Lock()
	if tray.tipText[0] == 0 {
		defaultTip, _ := syscall.UTF16FromString("DSH 工作站")
		copy(tray.tipText[:], defaultTip)
	}
	tray.mu.Unlock()
	data := tray.iconData()
	data.flags = desktopTrayNIFMessage | desktopTrayNIFIcon | desktopTrayNIFTip
	ok, _, callErr := desktopTrayNotifyIcon.Call(desktopTrayNIMAdd, uintptr(unsafe.Pointer(&data)))
	if ok == 0 {
		return desktopTrayError("Shell_NotifyIconW(NIM_ADD)", callErr)
	}
	tray.iconAdded = true
	return nil
}

// 清理只在独立的消息线程执行；初始化失败时不向线程队列投递 WM_QUIT。
func (tray *desktopTrayState) cleanup() {
	tray.running = false
	if tray.iconAdded {
		data := tray.iconData()
		desktopTrayNotifyIcon.Call(desktopTrayNIMDelete, uintptr(unsafe.Pointer(&data)))
		tray.iconAdded = false
	}
	if tray.hwnd != 0 {
		if !tray.destroyed {
			desktopTrayDestroyWindow.Call(tray.hwnd)
		}
		desktopTrayWindows.Delete(tray.hwnd)
		tray.hwnd = 0
	}
	if tray.menu != 0 {
		desktopTrayDestroyMenu.Call(tray.menu)
		tray.menu = 0
	}
	if tray.iconOwned && tray.icon != 0 {
		desktopTrayDestroyIcon.Call(tray.icon)
		tray.icon = 0
		tray.iconOwned = false
	}
	if tray.classReady {
		desktopTrayUnregisterClass.Call(uintptr(unsafe.Pointer(tray.className)), tray.instance)
		tray.classReady = false
	}
}

func appendDesktopTrayMenu(menu, flags, id uintptr, label string) error {
	text, err := syscall.UTF16PtrFromString(label)
	if err != nil {
		return fmt.Errorf("菜单文字无效：%w", err)
	}
	ok, _, callErr := desktopTrayAppendMenu.Call(menu, flags, id, uintptr(unsafe.Pointer(text)))
	if ok == 0 {
		return desktopTrayError("AppendMenuW", callErr)
	}
	return nil
}

func (tray *desktopTrayState) init() (err error) {
	defer func() {
		if err != nil {
			tray.cleanup()
		}
	}()

	instance, _, callErr := desktopTrayGetModuleHandle.Call(0)
	if instance == 0 {
		return desktopTrayError("GetModuleHandleW", callErr)
	}
	tray.instance = instance
	name := fmt.Sprintf("DshStationDesktopTray_%d_%d", syscall.Getpid(), desktopTrayClassNumber.Add(1))
	tray.className, err = syscall.UTF16PtrFromString(name)
	if err != nil {
		return err
	}
	class := desktopTrayWindowClass{wndProc: desktopTrayCallback, instance: instance, className: tray.className}
	class.cbSize = uint32(unsafe.Sizeof(class))
	registered, _, callErr := desktopTrayRegisterClass.Call(uintptr(unsafe.Pointer(&class)))
	if registered == 0 {
		return desktopTrayError("RegisterClassExW", callErr)
	}
	tray.classReady = true

	title, _ := syscall.UTF16PtrFromString("dsh-station 桌面预览版")
	hwnd, _, callErr := desktopTrayCreateWindow.Call(
		0, uintptr(unsafe.Pointer(tray.className)), uintptr(unsafe.Pointer(title)),
		0, 0, 0, 0, 0, 0, 0, instance, 0,
	)
	if hwnd == 0 {
		return desktopTrayError("CreateWindowExW", callErr)
	}
	tray.hwnd = hwnd
	desktopTrayWindows.Store(hwnd, tray)

	created, _ := syscall.UTF16PtrFromString("TaskbarCreated")
	message, _, callErr := desktopTrayRegisterWindowMessage.Call(uintptr(unsafe.Pointer(created)))
	if message == 0 {
		return desktopTrayError("RegisterWindowMessageW", callErr)
	}
	tray.taskbarCreated = uint32(message)
	width, _, _ := desktopTrayGetSystemMetrics.Call(desktopTraySmallIconWidth)
	height, _, _ := desktopTrayGetSystemMetrics.Call(desktopTraySmallIconHeight)
	tray.icon, _, _ = desktopTrayLoadImage.Call(instance, desktopTrayAppIconResource, desktopTrayImageIcon, width, height, 0)
	if tray.icon != 0 {
		tray.iconOwned = true
	} else {
		tray.icon, _, callErr = desktopTrayLoadIcon.Call(0, desktopTrayIDIApplication)
		if tray.icon == 0 {
			return desktopTrayError("LoadIconW", callErr)
		}
	}

	tray.menu, _, callErr = desktopTrayCreatePopupMenu.Call()
	if tray.menu == 0 {
		return desktopTrayError("CreatePopupMenu", callErr)
	}
	openMenu, _, callErr := desktopTrayCreatePopupMenu.Call()
	if openMenu == 0 {
		return desktopTrayError("CreatePopupMenu", callErr)
	}
	if err = appendDesktopTrayMenu(tray.menu, desktopTrayMFString, desktopTrayShow, "显示"); err != nil {
		desktopTrayDestroyMenu.Call(openMenu)
		return err
	}
	if err = appendDesktopTrayMenu(openMenu, desktopTrayMFString, desktopTrayBrowser, "工作台"); err != nil {
		desktopTrayDestroyMenu.Call(openMenu)
		return err
	}
	if err = appendDesktopTrayMenu(openMenu, desktopTrayMFString, desktopTrayAdmin, "远程管理"); err != nil {
		desktopTrayDestroyMenu.Call(openMenu)
		return err
	}
	if err = appendDesktopTrayMenu(tray.menu, desktopTrayMFPopup, openMenu, "在浏览器中打开"); err != nil {
		desktopTrayDestroyMenu.Call(openMenu)
		return err
	}
	if ok, _, callErr := desktopTrayAppendMenu.Call(tray.menu, desktopTrayMFSeparator, 0, 0); ok == 0 {
		desktopTrayError("AppendMenuW", callErr)
	}
	if err = appendDesktopTrayMenu(tray.menu, desktopTrayMFString, desktopTrayStartRemote, "启用远程服务"); err != nil {
		return err
	}
	if ok, _, callErr := desktopTrayAppendMenu.Call(tray.menu, desktopTrayMFSeparator, 0, 0); ok == 0 {
		desktopTrayError("AppendMenuW", callErr)
	}
	if err = appendDesktopTrayMenu(tray.menu, desktopTrayMFString, desktopTrayQuit, "退出"); err != nil {
		return err
	}
	desktopTraySetMenuDefaultItem.Call(tray.menu, desktopTrayShow, 0)
	if err = tray.addIcon(); err != nil {
		return err
	}
	return nil
}

func (tray *desktopTrayState) invoke(id uintptr) {
	var callback func()
	switch id {
	case desktopTrayShow:
		callback = tray.onShow
	case desktopTrayBrowser:
		callback = tray.onBrowser
	case desktopTrayAdmin:
		callback = tray.onAdmin
	case desktopTrayStartRemote:
		callback = tray.onRemote
	case desktopTrayQuit:
		callback = tray.onQuit
	}
	if callback != nil {
		go callback()
	}
}

func (tray *desktopTrayState) showMenu() {
	var cursor desktopTrayPoint
	if ok, _, _ := desktopTrayGetCursorPos.Call(uintptr(unsafe.Pointer(&cursor))); ok == 0 {
		return
	}
	// 菜单的前台所有者与 WM_NULL 缺一不可，否则点击菜单外无法可靠收起。
	desktopTraySetForegroundWindow.Call(tray.hwnd)
	selected, _, _ := desktopTrayTrackPopupMenu.Call(
		tray.menu,
		desktopTrayTPMRightButton|desktopTrayTPMBottomAlign|desktopTrayTPMNonNotify|desktopTrayTPMReturnCmd,
		uintptr(cursor.x), uintptr(cursor.y), 0, tray.hwnd, 0,
	)
	if !tray.destroyed {
		desktopTrayPostMessage.Call(tray.hwnd, desktopTrayWMNull, 0, 0)
		tray.invoke(selected)
	}
}

func desktopTrayWndProc(hwnd uintptr, message uint32, wParam, lParam uintptr) uintptr {
	stored, found := desktopTrayWindows.Load(hwnd)
	if found {
		tray := stored.(*desktopTrayState)
		switch message {
		case desktopTrayWMCallback:
			switch uint32(lParam & 0xffff) {
			case desktopTrayWMRButtonUp, desktopTrayWMContextMenu:
				tray.showMenu()
			case desktopTrayWMLButtonDbl:
				tray.invoke(desktopTrayShow)
			}
			return 0
		case desktopTrayWMClose:
			desktopTrayDestroyWindow.Call(hwnd)
			return 0
		case desktopTrayWMDestroy:
			tray.destroyed = true
			if tray.running {
				// WM_QUIT 仅发到本托盘 goroutine 独占的 OS 线程。
				desktopTrayPostQuitMessage.Call(0)
			}
			return 0
		case desktopTrayWMNCDestroy:
			tray.closeMu.Lock()
			tray.closed = true
			tray.closeMu.Unlock()
			desktopTrayWindows.Delete(hwnd)
		}
		if message == tray.taskbarCreated && message != 0 {
			if err := tray.addIcon(); err != nil {
				log.Printf("重新添加桌面托盘图标失败：%v", err)
			}
			return 0
		}
	}
	result, _, _ := desktopTrayDefWindowProc.Call(hwnd, uintptr(message), wParam, lParam)
	return result
}

func (tray *desktopTrayState) pump() {
	defer tray.cleanup()
	var message desktopTrayMessage
	for {
		result, _, callErr := desktopTrayGetMessage.Call(uintptr(unsafe.Pointer(&message)), 0, 0, 0)
		if result == 0 {
			return
		}
		if int32(result) == -1 {
			log.Printf("桌面托盘消息循环退出：%v", desktopTrayError("GetMessageW", callErr))
			return
		}
		desktopTrayTranslateMessage.Call(uintptr(unsafe.Pointer(&message)))
		desktopTrayDispatchMessage.Call(uintptr(unsafe.Pointer(&message)))
	}
}

// desktopTrayFoundWindow 收取 desktopTrayIconEnumProc 的枚举结果；
// EnumWindows 同步回调，不经 lParam 传指针（vet 禁止uintptr 反解引用）。
var desktopTrayFoundWindow uintptr

// desktopTrayIconEnumProc 找到本进程第一个可见顶层窗口（即 Wails 主窗口），
// 找到后记录并返回 0 停止枚举；托盘的隐藏窗口会被可见性过滤掉。
func desktopTrayIconEnumProc(hwnd uintptr, lparam uintptr) uintptr {
	var pid uint32
	desktopTrayGetWindowThreadPID.Call(hwnd, uintptr(unsafe.Pointer(&pid)))
	if pid != uint32(syscall.Getpid()) {
		return 1
	}
	if visible, _, _ := desktopTrayIsWindowVisible.Call(hwnd); visible == 0 {
		return 1
	}
	desktopTrayFoundWindow = hwnd
	return 0
}

// focusMainWindow 找到本进程主窗口并抢到前台；已显示的窗口 WindowShow
// 不会抢前台，通知点击定位必须显式置前。
func focusMainWindow() {
	desktopTrayFoundWindow = 0
	desktopTrayEnumWindows.Call(desktopTrayEnumProc, 0)
	if hwnd := desktopTrayFoundWindow; hwnd != 0 {
		desktopTraySetForegroundWindow.Call(hwnd)
	}
}

// setWindowsTaskbarIcon 把 exe 资源图标设为主窗口的大/小图标与窗口类图标。
// 无边框窗口没有标题栏图标可看，但任务栏按钮、hover 预览左上角和 Alt+Tab
// 都取自窗口/类图标；不设置时会退回系统默认程序图标。
// OnDomReady 时窗口可能尚未显示（枚举不到），返回是否找到窗口，由调用方重试。
func setWindowsTaskbarIcon() bool {
	desktopTrayFoundWindow = 0
	desktopTrayEnumWindows.Call(desktopTrayEnumProc, 0)
	hwnd := desktopTrayFoundWindow
	if hwnd == 0 {
		return false
	}
	instance, _, _ := desktopTrayGetModuleHandle.Call(0)
	if instance == 0 {
		return false
	}
	bigWidth, _, _ := desktopTrayGetSystemMetrics.Call(desktopTrayLargeIconWidth)
	bigHeight, _, _ := desktopTrayGetSystemMetrics.Call(desktopTrayLargeIconHeight)
	smallWidth, _, _ := desktopTrayGetSystemMetrics.Call(desktopTraySmallIconWidth)
	smallHeight, _, _ := desktopTrayGetSystemMetrics.Call(desktopTraySmallIconHeight)
	big, _, _ := desktopTrayLoadImage.Call(instance, desktopTrayAppIconResource, desktopTrayImageIcon, bigWidth, bigHeight, 0)
	small, _, _ := desktopTrayLoadImage.Call(instance, desktopTrayAppIconResource, desktopTrayImageIcon, smallWidth, smallHeight, 0)
	if big != 0 {
		desktopTraySendMessage.Call(hwnd, desktopTrayWMSetIcon, desktopTrayIconBig, big)
		desktopTraySetClassLongPtr.Call(hwnd, desktopTrayClassIconBig, big)
	}
	if small != 0 {
		desktopTraySendMessage.Call(hwnd, desktopTrayWMSetIcon, desktopTrayIconSmall, small)
		desktopTraySetClassLongPtr.Call(hwnd, desktopTrayClassIconSmall, small)
	}
	return big != 0 || small != 0
}

// desktopTrayHandle 暴露给调用方：Stop 拆除图标与窗口；SetTip 更新悬停提示。
type desktopTrayHandle struct {
	tray *desktopTrayState
	done chan struct{}
	once sync.Once
}

// Stop 只拆除图标和本窗口，不代表用户选择了菜单中的「退出」。
func (handle *desktopTrayHandle) Stop() {
	handle.once.Do(func() {
		// PostMessageW 失败时重试；成功后由本线程处理 WM_CLOSE。
		for {
			handle.tray.closeMu.Lock()
			if handle.tray.closed {
				handle.tray.closeMu.Unlock()
				break
			}
			posted, _, _ := desktopTrayPostMessage.Call(handle.tray.hwnd, desktopTrayWMClose, 0, 0)
			handle.tray.closeMu.Unlock()
			if posted != 0 {
				break
			}
			select {
			case <-handle.done:
				return
			case <-time.After(20 * time.Millisecond):
			}
		}
	})
	<-handle.done
}

// SetTip 更新托盘悬停提示（阶段与入口地址摘要）；Shell_NotifyIconW 可跨线程调用。
func (handle *desktopTrayHandle) SetTip(text string) {
	handle.tray.mu.Lock()
	defer handle.tray.mu.Unlock()
	if !handle.tray.iconAdded {
		return
	}
	encoded, err := syscall.UTF16FromString(text)
	if err != nil || len(encoded) > 128 {
		// 提示过长时截断到 127 字符并补结尾零，避免破坏 NIM_MODIFY。
		if len(encoded) > 128 {
			encoded = encoded[:127]
			encoded = append(encoded, 0)
		}
	}
	tip := handle.tray.tipText
	copy(tip[:], encoded)
	for i := len(encoded); i < len(tip); i++ {
		tip[i] = 0
	}
	handle.tray.tipText = tip
	data := handle.tray.iconData()
	data.flags = desktopTrayNIFTip
	desktopTrayNotifyIcon.Call(desktopTrayNIMModify, uintptr(unsafe.Pointer(&data)))
}

// startWindowsTray 在专属 OS 线程创建隐藏窗口；调用方的 Wails 线程不运行消息循环。
func startWindowsTray(callbacks desktopTrayCallbacks) (*desktopTrayHandle, error) {
	type startup struct {
		tray *desktopTrayState
		err  error
	}
	ready := make(chan startup)
	done := make(chan struct{})
	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		defer close(done)
		tray := &desktopTrayState{
			onShow: callbacks.onShow, onBrowser: callbacks.onBrowser, onAdmin: callbacks.onAdmin,
			onRemote: callbacks.onRemote, onQuit: callbacks.onQuit,
		}
		if err := tray.init(); err != nil {
			ready <- startup{err: err}
			return
		}
		tray.running = true
		ready <- startup{tray: tray}
		tray.pump()
	}()
	started := <-ready
	if started.err != nil {
		<-done
		return nil, started.err
	}
	return &desktopTrayHandle{tray: started.tray, done: done}, nil
}
