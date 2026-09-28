package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

// desktopPayload 描述随包载荷的发现结果：launcher 入口、插件介质目录和
// 可选的内置 Node。full 变体带 runtime/node；lite 变体没有，回退系统 Node。
type desktopPayload struct {
	// packageDir 是部署的 launcher 包根（含 dist/index.js 与 node_modules）。
	packageDir string
	// entry 仅受管开发模式使用固定 wrapper；发行版仍取 package/dist/index.js。
	entry string
	// pluginMediaDir 是 package 旁的 plugins/ 介质目录（launcher 自行解析，这里只做存在性提示）。
	pluginMediaDir string
	// nodePath 为空表示使用系统 PATH 里的 node。
	nodePath string
	// bundledNode 为 true 表示使用随包 Node（完整版）。
	bundledNode bool
}

// discoverPayload 从可执行文件位置发现随包载荷。appDirOverride 用于
// 开发调试（--app-dir），生产布局为：
//
//	Windows/Linux：exe 同级 package/ 与 runtime/node/（或 runtime/node/bin/node）
//	macOS：.app/Contents/Resources/{package,runtime/node/bin/node}，exe 在 Contents/MacOS/
func discoverPayload(appDirOverride string) (desktopPayload, error) {
	var bases []string
	if appDirOverride != "" {
		bases = []string{appDirOverride}
	} else {
		executable, err := os.Executable()
		if err != nil {
			return desktopPayload{}, fmt.Errorf("无法定位可执行文件：%w", err)
		}
		exeDirectory := filepath.Dir(executable)
		bases = []string{exeDirectory}
		if runtime.GOOS == "darwin" {
			bases = append(bases, filepath.Join(exeDirectory, "..", "Resources"))
		}
	}

	payload := desktopPayload{}
	for _, base := range bases {
		candidate := filepath.Join(base, "package")
		if payload.packageDir == "" && isFile(filepath.Join(candidate, "dist", "index.js")) {
			payload.packageDir = candidate
			payload.pluginMediaDir = filepath.Join(candidate, "plugins")
		}
		if payload.nodePath == "" {
			payload.nodePath = findBundledNode(base)
		}
	}
	if payload.packageDir == "" {
		hint := "安装目录应包含 package/dist/index.js（Windows/Linux 与 exe 同级，macOS 在 Contents/Resources/ 下）。"
		if appDirOverride != "" {
			hint = fmt.Sprintf("--app-dir 指向的 %s 下没有 package/dist/index.js。", appDirOverride)
		}
		return desktopPayload{}, fmt.Errorf("没有找到随包载荷。%s", hint)
	}
	if payload.nodePath == "" {
		if resolved, err := lookPathNode(); err == nil {
			// 轻量版回退系统 Node；launcher 自己做最低版本门禁。
			payload.nodePath = resolved
		} else {
			return desktopPayload{}, fmt.Errorf("没有找到随包 Node（完整版），也没有在 PATH 里找到系统 node（轻量版需要用户自装 Node ≥ 22.19.0）。")
		}
	} else {
		payload.bundledNode = true
	}
	return payload, nil
}

// 开发模式复用同一后台管理器；只有准备入口和数据路径与发行版不同。
func discoverDevelopmentPayload(root string) (desktopPayload, error) {
	entry := filepath.Join(root, "scripts", "dev-desktop-backend.mjs")
	if !isFile(entry) || !isFile(filepath.Join(root, "packages", "launcher", "package.json")) {
		return desktopPayload{}, fmt.Errorf("--dev-root 下缺少开发后端或 launcher：%s", root)
	}
	node, err := lookPathNode()
	if err != nil {
		return desktopPayload{}, fmt.Errorf("开发模式需要系统 Node ≥ 22.19.0：%w", err)
	}
	return desktopPayload{packageDir: root, entry: entry, nodePath: node}, nil
}

func payloadFor(config runOptions) (desktopPayload, error) {
	if config.devRoot != "" {
		return discoverDevelopmentPayload(config.devRoot)
	}
	return discoverPayload(config.appDir)
}

func findBundledNode(base string) string {
	candidates := []string{filepath.Join(base, "runtime", "node", nodeBinaryName())}
	if runtime.GOOS != "windows" {
		candidates = append(candidates, filepath.Join(base, "runtime", "node", "bin", nodeBinaryName()))
	}
	for _, candidate := range candidates {
		if isFile(candidate) {
			return candidate
		}
	}
	return ""
}

func nodeBinaryName() string {
	if runtime.GOOS == "windows" {
		return "node.exe"
	}
	return "node"
}

func lookPathNode() (string, error) {
	return exec.LookPath(nodeBinaryName())
}

func isFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}
