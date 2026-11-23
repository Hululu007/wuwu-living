var Notify=(function(){
  var log=[];
  function show(msg,opt){
    var t=document.getElementById('toast');
    var tone=(opt&&opt.tone)||'info';
    if(tone==='error'){log.push({time:Date.now(),tone:tone,message:msg});if(log.length>20)log.shift();}
    if(!t)return;
    t.textContent=msg;t.className='toast on'+(tone==='error'?' err':'');
    if(tone==='error'){t.onclick=function(){t.className='toast';};return;}
    setTimeout(function(){t.className='toast';},2400);
  }
  function history(){return log.slice();}
  return {show:show,history:history};
})();
window.Notify=Notify;
function toast(msg,err){Notify.show(msg,{tone:err?'error':'info'});}
