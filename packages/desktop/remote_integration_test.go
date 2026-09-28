package main

import (
	"context"
	"io"
	"net/http"
	"strconv"
	"strings"
	"testing"
)

// 与真后端启动检查共用临时 home，验证两端协议和真实端口回收，不打印 token。
func assertRemoteControlIntegration(t *testing.T, manager *backendManager, relayPort int) {
	t.Helper()
	initial := manager.Status()
	if initial.DshToken == "" {
		t.Fatal("缺少验证 dsh 生命周期所需的登录令牌")
	}
	client := adminLoadingTestClient(t)
	for _, action := range []remoteAction{remoteStop, remoteStart, remoteRestart, remoteStop} {
		request, send, err := manager.reserveRemote(action)
		if err != nil || !send || request == nil {
			t.Fatalf("无法预约 %s：%v", action, err)
		}
		if err := manager.sendRemote(request); err != nil {
			t.Fatal(err)
		}
		if err := manager.waitForRemoteRequest(context.Background(), request, action.timeout()); err != nil {
			t.Fatalf("%s 未完成：%v", action, err)
		}
		status := manager.Status()
		if status.Phase != phaseReady || status.DshToken != initial.DshToken || status.URLs.Dsh != initial.URLs.Dsh {
			t.Fatal("远程控制改变了本机 dsh 生命周期或地址")
		}
		wantRemote := action != remoteStop
		if status.RemoteEnabled != wantRemote || tcpReachable("127.0.0.1:"+strconv.Itoa(relayPort)) != wantRemote {
			t.Fatal("远程真实监听端口与完成状态不符")
		}
		if !wantRemote && (status.RemoteState != "idle" || status.URLs.Local != status.URLs.Dsh || !manager.RemoteMenu().Enabled) {
			t.Fatal("停止后未恢复本机入口和启用菜单")
		}
		// 每轮都使用同一 dsh token 完成认证，不能只用端口存活替代工作台可用性。
		response, err := client.Get(strings.TrimSuffix(initial.URLs.Dsh, "/") + "/?token=" + initial.DshToken)
		if err != nil {
			t.Fatal("远程操作后本机认证请求失败（不输出含 token 的 URL）")
		}
		io.Copy(io.Discard, io.LimitReader(response.Body, 2<<20))
		response.Body.Close()
		if response.StatusCode != http.StatusSeeOther || len(response.Cookies()) == 0 {
			t.Fatal("本机 dsh 原登录令牌已失效")
		}
		page, _ := http.NewRequest("GET", initial.URLs.Dsh, nil)
		for _, cookie := range response.Cookies() {
			page.AddCookie(cookie)
		}
		response, err = client.Do(page)
		if err != nil {
			t.Fatal("远程操作后本机首页请求失败")
		}
		io.Copy(io.Discard, io.LimitReader(response.Body, 2<<20))
		response.Body.Close()
		if response.StatusCode != http.StatusOK {
			t.Fatalf("本机首页状态异常：%d", response.StatusCode)
		}
	}
	t.Log("真实远程 stop→start→restart→stop 完成；relay 端口与状态一致，dsh 原 token 认证及首页均保持可用")
}
