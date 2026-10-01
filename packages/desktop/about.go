package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	goruntime "runtime"
	"runtime/debug"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// aboutDialog 供给「关于 DSH 工作站」原生弹窗的文案（对标 VSCode 的 About）。
// 版本在首次打开时按需解析并缓存：工作站与 dsh 版本读载荷包根的
// package.json，Node 版本来自实际使用的 node 可执行文件，Wails 与 Go
// 版本来自 Go 构建信息。全部只读；单项解析失败只降级为「未知」，
// 不阻塞其余字段。
type aboutDialog struct {
	// payload 为 nil 表示 attach 诊断模式：没有托管载荷，工作站与 dsh
	// 版本显示未知，Node 回退系统 PATH。
	payload *desktopPayload
	once    sync.Once
	text    string
}

func newAboutDialog(payload *desktopPayload) *aboutDialog {
	return &aboutDialog{payload: payload}
}

// Show 弹出原生信息对话框。绑定调用由 Wails 在独立 goroutine 派发
// （windows frontend 的 processMessage 以 go dispatchMessage 处理），
// 阻塞等待用户关闭不影响主线程。
func (d *aboutDialog) Show(ctx context.Context) {
	_, _ = runtime.MessageDialog(ctx, runtime.MessageDialogOptions{
		Type:    runtime.InfoDialog,
		Title:   "关于 DSH 工作站",
		Message: d.Text(),
	})
}

// Text 返回弹窗正文；并发调用只解析一次。
func (d *aboutDialog) Text() string {
	d.once.Do(func() { d.text = buildAboutText(d.payload) })
	return d.text
}

// buildAboutText 组装弹窗正文。发行版载荷包根是 launcher 包（pnpm deploy
// 产物），开发模式是仓库根，两者都有 package.json 与
// node_modules/@deepseek-ai/dsh，同一套读取即可覆盖。
func buildAboutText(payload *desktopPayload) string {
	packageDir, nodePath, nodeSource := "", "", "系统"
	if payload != nil {
		packageDir = payload.packageDir
		nodePath = payload.nodePath
		if payload.bundledNode {
			nodeSource = "随包"
		}
	} else if resolved, err := lookPathNode(); err == nil {
		nodePath = resolved
	}
	nodeVersion := ""
	if nodePath != "" {
		nodeVersion = nodeRuntimeVersion(nodePath)
	}
	dshVersion := ""
	if packageDir != "" {
		dshVersion = readManifestVersion(filepath.Join(packageDir, "node_modules", "@deepseek-ai", "dsh"))
	}
	nodeDisplay := "未知"
	if nodeVersion != "" {
		nodeDisplay = nodeVersion + "（" + nodeSource + " Node）"
	}
	var text strings.Builder
	text.WriteString("DSH 工作站\n\n")
	fmt.Fprintf(&text, "版本：%s\n", orUnknown(readManifestVersion(packageDir)))
	fmt.Fprintf(&text, "dsh：%s\n", orUnknown(dshVersion))
	fmt.Fprintf(&text, "Node.js：%s\n", nodeDisplay)
	fmt.Fprintf(&text, "Wails：%s\n", orUnknown(wailsBuildVersion()))
	fmt.Fprintf(&text, "Go：%s\n", orUnknown(goBuildVersion()))
	fmt.Fprintf(&text, "操作系统：%s/%s", goruntime.GOOS, goruntime.GOARCH)
	return text.String()
}

// readManifestVersion 读取 npm 包 package.json 的 version 字段；
// 目录为空或读取/解析失败返回空串，由调用方决定降级文案。
func readManifestVersion(packageDir string) string {
	if packageDir == "" {
		return ""
	}
	data, err := os.ReadFile(filepath.Join(packageDir, "package.json"))
	if err != nil {
		return ""
	}
	var manifest struct {
		Version string `json:"version"`
	}
	if json.Unmarshal(data, &manifest) != nil {
		return ""
	}
	return manifest.Version
}

// nodeRuntimeVersion 询问实际使用的 node 可执行文件版本；超时或失败返回空串。
func nodeRuntimeVersion(nodePath string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, nodePath, "--version").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(output))
}

// wailsBuildVersion 从 Go 构建信息解析 wails 模块版本（如 v2.16.0）。
// go build / go test 产出的二进制都携带依赖版本表。
func wailsBuildVersion() string {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return ""
	}
	for _, dep := range info.Deps {
		if dep.Path == "github.com/wailsapp/wails/v2" {
			return dep.Version
		}
	}
	return ""
}

// goBuildVersion 优先取构建信息里的 Go 工具链版本，读不到时回退运行时版本。
func goBuildVersion() string {
	if info, ok := debug.ReadBuildInfo(); ok && info.GoVersion != "" {
		return info.GoVersion
	}
	return goruntime.Version()
}

func orUnknown(value string) string {
	if value == "" {
		return "未知"
	}
	return value
}
