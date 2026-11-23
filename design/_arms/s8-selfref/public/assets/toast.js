(function(){var log=[];function toast(m,k){if(k==='err'){log.push({text:m,at:Date.now()});return;}}
var Notify={history:function(){return log.slice();},count:function(){return log.length;}};
toast.history=Notify.history;window.Notify=Notify;window.toast=toast;})();
