package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// logo.svg 是 packaging/dsh-station.svg 的提交镜像（go:embed 不能引用模块外文件）。
// 源文件更新后必须同步镜像，否则注入标题栏与 exe/托盘图标会各自为政。
func TestLogoMirrorMatchesPackaging(t *testing.T) {
	source, err := os.ReadFile(filepath.Join("..", "..", "packaging", "dsh-station.svg"))
	if err != nil {
		t.Fatalf("读取 logo 源文件失败: %v", err)
	}
	mirror, err := os.ReadFile("logo.svg")
	if err != nil {
		t.Fatalf("读取 logo 镜像失败: %v", err)
	}
	if !bytes.Equal(source, mirror) {
		t.Fatal("packages/desktop/logo.svg 与 packaging/dsh-station.svg 不一致；请重新复制镜像")
	}
	if !strings.Contains(chromebarLogoSVG, "#4D6BFE") || !strings.Contains(chromebarLogoSVG, "<path") {
		t.Fatal("嵌入的 logo 缺少官方蓝色鲸鱼 path，注入标题栏会是空白图标")
	}
}

func TestBindingOrigin(t *testing.T) {
	origin, err := bindingOrigin("http://127.0.0.1:30809/")
	if err != nil {
		t.Fatal(err)
	}
	if origin != "http://127.0.0.1:30809" {
		t.Fatalf("绑定来源错误: %q", origin)
	}
	if _, err := bindingOrigin("https://127.0.0.1:30809/"); err == nil {
		t.Fatal("https 来源应被拒绝")
	}
	if _, err := bindingOrigin("http://localhost:30809/"); err == nil {
		t.Fatal("非 127.0.0.1 主机应被拒绝")
	}
}

func TestBuildChromeBarScript(t *testing.T) {
	script := buildChromeBarScript("http://127.0.0.1:31809/", "http://127.0.0.1:31809/_admin", "")
	for _, placeholder := range []string{"__RELAY_URL__", "__ADMIN_URL__", "__LOGO_SVG__", "__TITLE_SUFFIX__"} {
		if strings.Contains(script, placeholder) {
			t.Fatalf("脚本仍含未替换占位符 %s", placeholder)
		}
	}
	if !strings.Contains(script, `'http://127.0.0.1:31809/'`) || !strings.Contains(script, `'http://127.0.0.1:31809/_admin'`) {
		t.Fatal("脚本未包含工作台/远程管理地址")
	}
	if !strings.Contains(script, `'DSH 工作站'`) {
		t.Fatal("独立模式标题不应带后缀")
	}
	if !strings.Contains(script, `dsh-station-chromebar`) {
		t.Fatal("脚本缺少自绘标题栏元素 ID")
	}

	if !strings.Contains(script, `document.body.style.paddingTop='calc(36px + var(--dsh-station-page-top-gap, 0px))'`) ||
		!strings.Contains(script, `document.body.style.boxSizing='border-box'`) {
		t.Fatal("标题栏占位必须叠加页面留白，未定义变量的dsh仍保持36px与border-box")
	}
	if strings.Contains(script, `document.body.style.paddingTop='36px'`) {
		t.Fatal("不能覆盖管理页的顶部留白")
	}

	for _, marker := range []string{"'data-theme'", "'data-ds-theme-source'", "'data-ds-dark-theme'", "themeMedia.addEventListener('change',applyTheme)", "document.addEventListener('visibilitychange',applyTheme)"} {
		if !strings.Contains(script, marker) {
			t.Fatalf("标题栏缺少主题更新观察: %s", marker)
		}
	}

	devScript := buildChromeBarScript("http://127.0.0.1:31809/", "http://127.0.0.1:31809/_admin", " (dev)")
	if !strings.Contains(devScript, `'DSH 工作站'+" (dev)"`) {
		t.Fatal("attach 开发模式标题应拼接 (dev) 后缀")
	}
}
