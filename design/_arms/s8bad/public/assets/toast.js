// 负向臂：常驻但没有记录，点关闭即永久丢失
function toast(msg, err){
  var t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'toast on' + (err ? ' err' : '');
  if (err) { t.onclick = function(){ t.className='toast'; }; return; }
  setTimeout(function(){ t.className='toast'; }, 2400);
}
