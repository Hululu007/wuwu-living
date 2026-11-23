(function(){if(!window.Notify)return;
function mount(){var b=document.createElement('button');b.id='ww-notify-entry';
b.textContent='消息记录';b.onclick=function(){window.Notify.history();};document.body.appendChild(b);}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount);else mount();})();
