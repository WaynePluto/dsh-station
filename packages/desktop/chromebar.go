package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

//go:embed logo.svg
var chromebarLogoSVG string

// Chrome 是自绘标题栏暴露给页面侧的最小窗口控制绑定。
// 无参绑定只接受配置握手中的 dsh/relay 精确 origin；管理动作可按需启用远程。
// 不接受任意 URL、命令或文件参数，导航目标全部由壳的配置与加载页生成。
type Chrome struct {
	currentWindow func() context.Context
	// resolve 在调用时解析工作台/远程管理地址：独立模式下 relay 端口由后台
	// 上报后才确定；attach 模式返回启动参数里的静态地址。
	resolve func() (home string, admin string)
	admin   func(external bool)
}

func (c *Chrome) Minimize() {
	if ctx := c.currentWindow(); ctx != nil {
		runtime.WindowMinimise(ctx)
	}
}

func (c *Chrome) ToggleMaximize() {
	if ctx := c.currentWindow(); ctx != nil {
		runtime.WindowToggleMaximise(ctx)
	}
}

// Hide 等价于点关闭按钮：只隐藏窗口，后台继续，托盘仍在。
func (c *Chrome) Hide() {
	if ctx := c.currentWindow(); ctx != nil {
		runtime.WindowHide(ctx)
	}
}

func (c *Chrome) Quit() {
	if ctx := c.currentWindow(); ctx != nil {
		runtime.Quit(ctx)
	}
}

// OpenExternalHome/OpenExternalAdmin 只打开配置解析出的既定地址，
// 不接受页面传入的任意 URL，避免把壳变成开放重定向的启动器。
func (c *Chrome) OpenExternalHome() {
	if ctx := c.currentWindow(); ctx != nil {
		home, _ := c.resolve()
		runtime.BrowserOpenURL(ctx, home)
	}
}

func (c *Chrome) OpenExternalAdmin() {
	if c.admin != nil {
		c.admin(true)
	}
}

func (c *Chrome) OpenAdmin() {
	if c.admin != nil {
		c.admin(false)
	}
}

func (c *Chrome) OpenHome() {
	if ctx := c.currentWindow(); ctx != nil {
		home, _ := c.resolve()
		navigateWindow(ctx, home)
	}
}

func navigateWindow(ctx context.Context, address string) {
	literal, err := json.Marshal(address)
	if err == nil {
		runtime.WindowExecJS(ctx, "location.assign("+string(literal)+")")
	}
}

// chromebarScript 是注入到每个顶层页面的自绘标题栏。
// Wails 的 OnDomReady 在每次顶层导航（含 转到→工作台/远程管理 的 location.assign）
// 后都会触发；脚本以元素 ID 幂等，SPA 内重渲染不会重复创建。
// 拖拽与边缘缩放按 v2.16 消息协议在本脚本内复刻（Wails 运行时不在 relay 页面）；
// 主题取自页面 body 背景色。
const chromebarScript = `(function(){
  if (document.getElementById('dsh-station-chromebar')) return;
  // 只在配置握手中的 dsh/relay 页面注入；临时加载页与资产页不获得绑定。
  if (location.origin !== '__RELAY_ORIGIN__' && location.origin !== '__ADMIN_ORIGIN__') return;
  var RELAY='__RELAY_URL__', ADMIN='__ADMIN_URL__';
  var call=function(name){return function(){
    // Wails 运行时只注入资产服务器主页面，relay 页面上没有 window.go；
    // 但 WebView2 的 postMessage 通道与消息格式（'C'+{name,args,callbackID}）
    // Go 侧 BindingsAllowedOrigins 只放行握手中确认的 dsh/relay 来源。
    var payload={name:'main.Chrome.'+name,args:[],callbackID:'chrome-'+name+'-'+Math.random()};
    var w=window.chrome&&window.chrome.webview;
    if(w&&w.postMessage) w.postMessage('C'+JSON.stringify(payload));
  }};
  var bar=document.createElement('div');
  bar.id='dsh-station-chromebar';
  bar.style.cssText='--wails-draggable:drag;position:fixed;top:0;left:0;right:0;height:36px;z-index:2147483000;display:flex;align-items:center;padding:0 4px;font:12.5px/1 "Segoe UI","Microsoft YaHei",system-ui,sans-serif;user-select:none;background:var(--dshrc-bg);color:var(--dshrc-fg);border-bottom:1px solid var(--dshrc-border)';
  var applyTheme=function(){
    var bg=[27,27,27], dark=true;
    try{
      var c=getComputedStyle(document.body).backgroundColor.match(/\d+/g);
      if(c&&c.length>=3){ bg=[+c[0],+c[1],+c[2]]; }
    }catch(e){}
    var lum=(0.2126*bg[0]+0.7152*bg[1]+0.0722*bg[2])/255;
    dark=lum<0.55;
    bar.style.setProperty('--dshrc-bg',dark?'#1b1b1b':'#ffffff');
    bar.style.setProperty('--dshrc-fg',dark?'#e6e6e6':'#1f1f1f');
    bar.style.setProperty('--dshrc-border',dark?'#333333':'#e5e5e5');
    bar.style.setProperty('--dshrc-hover',dark?'#2e2e2e':'#f0f0f0');
  };
  applyTheme();
  document.addEventListener('visibilitychange',applyTheme);
  if(window.MutationObserver){
    // 分别观察管理页主题与原生dsh主题；不观察子树，避免标题栏自身样式触发循环。
    var themeObserver=new MutationObserver(applyTheme);
    themeObserver.observe(document.documentElement,{attributes:true,attributeFilter:['class','style','data-theme','data-ds-theme-source']});
    themeObserver.observe(document.body,{attributes:true,attributeFilter:['class','style','data-ds-dark-theme']});
  }
  if(window.matchMedia){
    var themeMedia=window.matchMedia('(prefers-color-scheme: dark)');
    if(themeMedia.addEventListener) themeMedia.addEventListener('change',applyTheme);
  }
  var logo=document.createElement('span');
  logo.style.cssText='--wails-draggable:no-drag;display:flex;align-items:center;margin:0 6px 0 4px';
  logo.innerHTML=__LOGO_SVG__;
  if(logo.firstChild){
    logo.firstChild.style.width='20px';
    logo.firstChild.style.height='20px';
  }
  bar.appendChild(logo);
  var title=document.createElement('span');
  title.textContent='DSH 工作站'+__TITLE_SUFFIX__;
  title.style.cssText='font-weight:600;margin-right:10px;white-space:nowrap';
  bar.appendChild(title);
  var panels=[];
  var closeAll=function(){
    for(var i=0;i<panels.length;i++) panels[i].style.display='none';
  };
  var menu=function(label,items){
    var wrap=document.createElement('div');
    wrap.style.cssText='--wails-draggable:no-drag;position:relative';
    var btn=document.createElement('button');
    btn.textContent=label;
    btn.style.cssText='all:unset;cursor:default;padding:8px 10px;border-radius:6px;font:inherit';
    btn.onmouseenter=function(){btn.style.background='var(--dshrc-hover)'};
    btn.onmouseleave=function(){btn.style.background=''};
    wrap.appendChild(btn);
    var panel=document.createElement('div');
    panel.className='dshrc-panel';
    panel.style.cssText='display:none;position:absolute;top:32px;left:0;min-width:120px;padding:4px;border-radius:8px;background:var(--dshrc-bg);border:1px solid var(--dshrc-border);box-shadow:0 4px 14px rgba(0,0,0,.2)';
    panels.push(panel);
    items.forEach(function(it){
      if(it[0]==='-'){
        var sep=document.createElement('div');
        sep.style.cssText='height:1px;margin:4px 6px;background:var(--dshrc-border)';
        panel.appendChild(sep);
        return;
      }
      var item=document.createElement('div');
      item.textContent=it[0];
      item.style.cssText='padding:7px 12px;border-radius:5px;cursor:pointer;white-space:nowrap';
      item.onmouseenter=function(){item.style.background='var(--dshrc-hover)'};
      item.onmouseleave=function(){item.style.background=''};
      item.onclick=function(ev){ev.stopPropagation();closeAll();it[1]()};
      panel.appendChild(item);
    });
    wrap.appendChild(panel);
    btn.onclick=function(ev){
      ev.stopPropagation();
      var open=panel.style.display==='block';
      closeAll();
      if(!open) panel.style.display='block';
    };
    return wrap;
  };
  document.addEventListener('click',closeAll);
  bar.appendChild(menu('转到',[
    ['工作台',call('OpenHome')],
    ['远程管理',call('OpenAdmin')],
    ['-'],
    ['在浏览器中打开工作台',call('OpenExternalHome')],
    ['在浏览器中打开远程管理',call('OpenExternalAdmin')]
  ]));
  bar.appendChild(menu('工作站',[
    ['重新加载',function(){location.reload()}],
    ['-'],
    ['隐藏到托盘',call('Hide')],
    ['退出',call('Quit')]
  ]));
  var spacer=document.createElement('div');
  spacer.style.cssText='flex:1;height:100%';
  bar.appendChild(spacer);
  var winbtn=function(label,fn,danger){
    var b=document.createElement('button');
    b.textContent=label;
    b.style.cssText='--wails-draggable:no-drag;all:unset;cursor:default;padding:10px 13px;font:12px/1 "Segoe UI",system-ui';
    b.onmouseenter=function(){b.style.background=danger?'#e81123':'var(--dshrc-hover)'};
    b.onmouseleave=function(){b.style.background=''};
    b.onclick=function(ev){ev.stopPropagation();fn()};
    return b;
  };
  var maximized=false;
  var toggleMax=function(){maximized=!maximized;call('ToggleMaximize')()};
  bar.appendChild(winbtn('─',call('Minimize')));
  bar.appendChild(winbtn('❐',function(){toggleMax()}));
  bar.appendChild(winbtn('✕',call('Hide'),true));
  bar.ondblclick=function(ev){
    if(ev.target===bar||ev.target===spacer||ev.target===title) toggleMax();
  };
  // Wails 运行时只注入资产服务器主页面，relay 页面没有 window.wails，
  // 这里按 v2.16 消息协议复刻拖拽与边缘缩放：mousedown 靠边发
  // 'resize:<边>'，条上按下后随鼠标移动发 'drag'（deferDrag 保证双击可用）。
  var post=function(m){var w=window.chrome&&window.chrome.webview;w&&w.postMessage&&w.postMessage(m)};
  var BORDER=6, resizeEdge=null, defaultCursor=null, shouldDrag=false;
  window.addEventListener('mousedown',function(e){
    if(resizeEdge){
      post('resize:'+resizeEdge);
      e.preventDefault();
      return;
    }
    if(e.button!==0||e.detail!==1) return;
    if(!(e.target&&e.target.closest&&bar.contains(e.target))) return;
    if(e.target.closest('button,.dshrc-panel')) return;
    shouldDrag=true;
  });
  window.addEventListener('mouseup',function(){shouldDrag=false});
  window.addEventListener('mousemove',function(e){
    if(shouldDrag){
      shouldDrag=false;
      var pressed=(e.buttons!==undefined)?e.buttons:e.which;
      if(pressed>0){post('drag');return}
    }
    if(maximized) return;
    if(defaultCursor===null) defaultCursor=document.documentElement.style.cursor;
    var rightB=window.outerWidth-e.clientX<BORDER, leftB=e.clientX<BORDER,
        topB=e.clientY<BORDER, bottomB=window.outerHeight-e.clientY<BORDER;
    var set=function(c){document.documentElement.style.cursor=c||defaultCursor;resizeEdge=c};
    if(!leftB&&!rightB&&!topB&&!bottomB){ if(resizeEdge!==null) set(); }
    else if(rightB&&bottomB) set('se-resize');
    else if(leftB&&bottomB) set('sw-resize');
    else if(leftB&&topB) set('nw-resize');
    else if(topB&&rightB) set('ne-resize');
    else if(leftB) set('w-resize');
    else if(topB) set('n-resize');
    else if(bottomB) set('s-resize');
    else if(rightB) set('e-resize');
  });
  if(!document.body) return;
  // 标题栏占位须叠加 relay 页面原有留白，不能覆盖；变量随窄屏样式更新。
  // dsh 未定义留白变量，仍只缩进36px；border-box 避免 height:100% 链底部裁切。
  document.body.style.paddingTop='calc(36px + var(--dsh-station-page-top-gap, 0px))';
  document.body.style.boxSizing='border-box';
  document.documentElement.appendChild(bar);
})()`

// buildChromeBarScript 把配置地址与 logo 注入脚本模板；地址来自启动参数校验结果，
// 只能是规范的 http://127.0.0.1:<端口>/ 形式。logo 是多行 SVG，必须经 JSON 编码
// 变成合法的 JS 字符串字面量，直接塞进单引号字符串会因换行破坏整个脚本。
// titleSuffix 是开发模式的「 (dev)」标记，与窗口标题、任务栏区分开发壳。
func buildChromeBarScript(relayURL, adminURL, titleSuffix string) string {
	logoLiteral, err := json.Marshal(chromebarLogoSVG)
	if err != nil {
		logoLiteral = []byte(`''`)
	}
	origin := relayOrigin(relayURL)
	return strings.NewReplacer(
		"__RELAY_URL__", relayURL,
		"__RELAY_ORIGIN__", origin,
		"__ADMIN_URL__", adminURL,
		"__ADMIN_ORIGIN__", relayOrigin(adminURL),
		"__LOGO_SVG__", string(logoLiteral),
		"__TITLE_SUFFIX__", fmt.Sprintf("%q", titleSuffix),
	).Replace(chromebarScript)
}

// relayOrigin 取 relay URL 的 scheme://host 部分，用于注入脚本的来源守卫。
func relayOrigin(relayURL string) string {
	parsed, err := url.Parse(relayURL)
	if err != nil {
		return ""
	}
	return parsed.Scheme + "://" + parsed.Host
}

func injectChromeBar(ctx context.Context, relayURL, adminURL, titleSuffix string) {
	runtime.WindowExecJS(ctx, buildChromeBarScript(relayURL, adminURL, titleSuffix))
}
