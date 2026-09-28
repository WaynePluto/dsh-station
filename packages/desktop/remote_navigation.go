package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"strings"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// 停止前不用 URLs.Local：远程仍就绪时它指向即将关闭的 relay。
func remoteFallbackScript(status backendStatus) (string, error) {
	if !status.HasURLs || status.DshToken == "" {
		return "", errors.New("本机工作台尚未就绪，无法返回")
	}
	if err := validateBackendURLs(status.URLs); err != nil {
		return "", errors.New("本机工作台地址无效，已拒绝跳转")
	}
	relayOrigin := strings.TrimSuffix(status.URLs.Admin, "/_admin")
	if relayOrigin == strings.TrimSuffix(status.URLs.Dsh, "/") {
		return "", errors.New("远程入口与本机工作台不能共用来源")
	}
	options, err := json.Marshal(struct {
		Origin string `json:"origin"`
		Target string `json:"target"`
	}{relayOrigin, status.URLs.Dsh + "?" + url.Values{"token": {status.DshToken}}.Encode()})
	if err != nil {
		return "", err
	}
	return "(" + remoteFallbackClient + ")(" + string(options) + ");", nil
}

func returnRemotePageToLocal(ctx context.Context, status backendStatus) {
	script, err := remoteFallbackScript(status)
	if err == nil {
		runtime.WindowExecJS(ctx, script)
	}
}

// 只影响即将失去服务的 relay 文档；直连工作台、外站与外部浏览器不参与。
// replace 不把离线管理页留为本次回退的历史入口；重复执行保持幂等。
const remoteFallbackClient = `function(options) {
  if (window.top !== window || location.origin !== options.origin) return;
  if (window.__dshStationReturningLocal) return;
  window.__dshStationReturningLocal = true;
  const block = event => { event.preventDefault(); event.stopImmediatePropagation(); };
  window.addEventListener('click', block, true);
  window.addEventListener('submit', block, true);
  window.stop();
  location.replace(options.target);
}`
