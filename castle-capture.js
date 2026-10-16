!function(){
  function anunciar(t){
    try{window.postMessage({type:"__ql_castle_token__",token:t},"*")}catch(e){}
  }
  function salvar(t){
    if(t&&t.length>100){window.__ql_castle_token=t;anunciar(t)}
  }
  var e=setInterval(function(){
    try{
      for(var t=Object.keys(window),n=0;n<t.length;n++){
        var o=window[t[n]];
        if(o&&"object"==typeof o&&"function"==typeof o.createRequestToken){
          o.createRequestToken().then(salvar).catch(function(){});
          clearInterval(e);
          setInterval(function(){
            try{
              for(var e=Object.keys(window),t=0;t<e.length;t++){
                var n=window[e[t]];
                if(n&&"object"==typeof n&&"function"==typeof n.createRequestToken){
                  n.createRequestToken().then(salvar).catch(function(){});
                  break
                }
              }
            }catch(e){}
          },30000);
          return
        }
      }
    }catch(e){}
  },3000)
}();
