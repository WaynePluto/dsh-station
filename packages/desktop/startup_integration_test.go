package main

import (
	"io"
	"net/http"
	"testing"
)

// 真后端集成测试沿浏览器顶层请求顺序验证，不打印 Location 或 cookie。
func assertStartupDshHandoff(t *testing.T, client *http.Client, loading *adminLoadingServer, dsh string) {
	t.Helper()
	get := func(target, site string, cookies []*http.Cookie) *http.Response {
		t.Helper()
		request, err := http.NewRequest("GET", target, nil)
		if err != nil {
			t.Fatal("无法构建交接请求")
		}
		request.Header.Set("Sec-Fetch-Site", site)
		request.Header.Set("Sec-Fetch-Mode", "navigate")
		request.Header.Set("Sec-Fetch-Dest", "document")
		for _, cookie := range cookies {
			request.AddCookie(cookie)
		}
		response, err := client.Do(request)
		if err != nil {
			t.Fatal("交接请求失败（不输出含token的URL）")
		}
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 2<<20))
		response.Body.Close()
		return response
	}
	redirect := get(loading.URL()+"/enter", "same-origin", nil)
	if redirect.StatusCode != 302 {
		t.Fatalf("壳交接状态：%d", redirect.StatusCode)
	}
	exchange := get(redirect.Header.Get("Location"), "same-site", nil)
	if exchange.StatusCode != 303 || len(exchange.Cookies()) == 0 {
		t.Fatalf("dsh认证交换状态：%d", exchange.StatusCode)
	}
	page := get(dsh, "same-site", exchange.Cookies())
	if page.StatusCode != 200 {
		t.Fatalf("dsh首页状态：%d", page.StatusCode)
	}
}
