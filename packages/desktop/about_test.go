package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestReadManifestVersion(t *testing.T) {
	if v := readManifestVersion(""); v != "" {
		t.Fatalf("空目录应返回空串，得到 %q", v)
	}
	dir := t.TempDir()
	if v := readManifestVersion(dir); v != "" {
		t.Fatalf("缺失 package.json 应返回空串，得到 %q", v)
	}
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(`{"name":"x","version":"1.2.3"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if v := readManifestVersion(dir); v != "1.2.3" {
		t.Fatalf("版本解析错误：%q", v)
	}
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte("{not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	if v := readManifestVersion(dir); v != "" {
		t.Fatalf("坏 JSON 应返回空串，得到 %q", v)
	}
}

func TestBuildAboutTextManagedPayload(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(`{"name":"@dsh-station/launcher","version":"0.0.2"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	dshDir := filepath.Join(dir, "node_modules", "@deepseek-ai", "dsh")
	if err := os.MkdirAll(dshDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dshDir, "package.json"), []byte(`{"version":"0.2.0-rc.2"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	// Node 指向不存在的可执行文件：版本降级为未知，不影响其余字段。
	text := buildAboutText(&desktopPayload{
		packageDir:  dir,
		nodePath:    filepath.Join(dir, "missing-node.exe"),
		bundledNode: true,
	})
	for _, want := range []string{"DSH 工作站", "版本：0.0.2", "dsh：0.2.0-rc.2", "Node.js：未知"} {
		if !strings.Contains(text, want) {
			t.Fatalf("关于弹窗缺少 %q：\n%s", want, text)
		}
	}
	if matched := regexp.MustCompile(`(?m)^Wails：v\d+\.\d+\.\d+$`).FindString(text); matched == "" {
		t.Fatalf("Wails 版本行应来自构建信息：\n%s", text)
	}
	if matched := regexp.MustCompile(`(?m)^Go：go\S+`).FindString(text); matched == "" {
		t.Fatalf("Go 版本行应来自构建信息：\n%s", text)
	}
	if matched := regexp.MustCompile(`(?m)^操作系统：\w+/\w+$`).FindString(text); matched == "" {
		t.Fatalf("操作系统行格式错误：\n%s", text)
	}
}

func TestBuildAboutTextWithoutPayload(t *testing.T) {
	text := buildAboutText(nil)
	// attach 模式没有托管载荷；Node 可能解析到系统版本，不做断言。
	for _, want := range []string{"版本：未知", "dsh：未知"} {
		if !strings.Contains(text, want) {
			t.Fatalf("无载荷时 %q 应为未知：\n%s", want, text)
		}
	}
	dialog := newAboutDialog(nil)
	if first, second := dialog.Text(), dialog.Text(); first != second {
		t.Fatal("关于弹窗文案应只解析一次并保持稳定")
	}
}
