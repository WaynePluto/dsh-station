import { createHash } from 'node:crypto'

export const ADMIN_THEME_EVENTS_PATH = '/_admin/theme/events'

/** 固定只读脚本：只改主题属性，不触碰表单、Cookie、设置或导航。 */
export const ADMIN_THEME_SCRIPT = String.raw`(function(){
  if(!window.fetch||!window.AbortController||!window.TextDecoder) return;
  var controller=null, timer=null, running=false, stopped=false, failures=0;
  function stop(){stopped=true;clearTimeout(timer);if(controller) controller.abort();}
  async function connect(){
    if(stopped||running) return;
    running=true;
    controller=new AbortController();
    var connection=controller;
    var deadline=setTimeout(function(){connection.abort();},360000);
    var reader=null;
    try{
      var response=await fetch('/_admin/theme/events',{
        method:'GET',mode:'same-origin',credentials:'same-origin',redirect:'error',
        cache:'no-store',headers:{Accept:'application/x-ndjson'},signal:controller.signal
      });
      if(response.status===401||response.status===403||response.status===404){stopped=true;return;}
      if(!response.ok||!response.body||(response.headers.get('content-type')||'').split(';')[0]!=='application/x-ndjson') throw new Error('Theme stream unavailable');
      reader=response.body.getReader();
      var decoder=new TextDecoder('utf-8',{fatal:true}), pending='';
      while(!stopped){
        var chunk=await reader.read();
        if(chunk.done) break;
        var text;
        try{text=decoder.decode(chunk.value,{stream:true});}catch(error){stopped=true;throw error;}
        for(var i=0;i<text.length;i++){
          var character=text[i];
          if(character!=='\n'){
            pending+=character;
            if(pending.length>128){stopped=true;throw new Error('Invalid theme frame');}
            continue;
          }
          if(pending==='') continue;
          var frame;
          try{frame=JSON.parse(pending);}catch(error){stopped=true;throw error;}
          pending='';
          if(!frame||Object.keys(frame).length!==2||frame.version!==1||['light','dark','system'].indexOf(frame.preference)<0){stopped=true;throw new Error('Invalid theme frame');}
          if(document.documentElement.dataset.theme!==frame.preference) document.documentElement.dataset.theme=frame.preference;
          failures=0;
        }
      }
    }catch(error){
      // 保留页面及最后配色；网络断开只重建流，不重新加载或提交页面。
    }finally{
      clearTimeout(deadline);
      connection.abort();
      if(reader){try{await reader.cancel();}catch(error){}}
      running=false;
      if(!stopped){timer=setTimeout(connect,Math.min(30000,1000*Math.pow(2,Math.min(failures++,5))));}
    }
  }
  window.addEventListener('pagehide',stop);
  window.addEventListener('pageshow',function(event){if(event.persisted){stopped=false;failures=0;connect();}});
  connect();
})();`

export const ADMIN_THEME_CSP_EXTENSION = `script-src 'sha256-${createHash('sha256').update(ADMIN_THEME_SCRIPT).digest('base64')}'; connect-src 'self'`
