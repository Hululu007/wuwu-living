import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

// ★ 2026-11-22 探针互斥：六个用真浏览器的探针里，原本只有 toast-behavior
//   读了 regress.lock，其余五个既不读锁也不互相避让。实测两个探针并发时
//   本机 load 31~65（8 核），标签页被挤到后台 → Chrome 冻结渲染时间线 →
//   transition 不推进 → computed opacity 恒为 0 → 判「提示没画出来」。
//   于是同一份代码两次跑出不同缺陷页。锁在这里，不是可选项。
import { acquireProbeLock } from './probe-lock.mjs';
await acquireProbeLock('state-visual');
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
// ★ 2026-11-22 修「探针留残骸」：proc.kill('SIGKILL') 只杀 Chrome 主进程，
//   它自己拉的 helper 子进程会活下来占端口 —— 实测每跑一次留 2 个，
//   累积几十个之后后续探针报 ECONNREFUSED，看起来像产品缺陷。
//   spawn 时必须 detached:true 才成组，收尾用 kill(-pid) 杀整组。
function killTree(p){
  try{ process.kill(-p.pid, 'SIGKILL'); }catch{}
  try{ p.kill('SIGKILL'); }catch{}
}

// ★ 2026-11-22 修「探针留残骸」的第二版：只 kill(-pid) 仍会漏。
//   实测 detached + 进程组 kill 之后，每跑一次仍留 2 个 —— Chrome 的 helper
//   被 SIGKILL 后会 reparent 到 launchd，脱离原进程组，group kill 抓不到。
//   可靠做法：按本探针**唯一的 user-data-dir 路径**反查进程再杀，
//   这个字符串只属于本次运行，不会误伤别人的 Chrome。

// ★★ 2026-11-22 根因：exitClean() 会**直接终止进程，finally 块不执行**。
//   这就是为什么之前写了收尾代码也照样留残骸：探针跑到尾就 exit，
//   cleanup 永远没机会跑。现在统一改成 exitClean(code)：先杀干净再退出。
let __cleanupFns = [];
function onExitCleanup(fn){ __cleanupFns.push(fn); }
function exitClean(code){
  for(const fn of __cleanupFns){ try{ fn(); }catch{} }
  __cleanupFns = [];
  process.exit(code);
}

function reapByUserDir(dir){
  if(!dir) return 0;
  // 2026-11-22 第三版：杀一次不够。Chrome 主进程被 SIGKILL 后，
  //   已被 launchd 接管的 helper 会重新拉起主进程，所以必须
  //   「扫描→杀→等一下→再扫」循环到干净。不走 shell：pgrep 直接调用。
  let total = 0;
  for(let round=0; round<4; round++){
    let pids = [];
    try{
      const r = spawnSync('pgrep', ['-f', dir], {encoding:'utf8', timeout:5000});
      pids = String(r.stdout||'').trim().split(/\s+/).filter(Boolean);
    }catch{ return total; }
    if(!pids.length) break;
    for(const p of pids){ try{ process.kill(Number(p), 'SIGKILL'); }catch{} }
    total += pids.length;
    try{ spawnSync('sleep', ['0.4'], {timeout:2000}); }catch{}
  }
  return total;
}


// ★ 2026-11-22 修端口竞态：原实现在 14000–15499 随机取端口，探完立刻 close，
//   从「探到空闲」到「Chrome 真正绑定」之间有空窗 —— 被别人（含本组其它探针的
//   未回收 headless Chrome）抢走就报 ECONNREFUSED，看起来像产品缺陷。
//   实测残骸里 14189 / 14562 正是这么来的（微信还长期占 14013–14023）。
//   两条修法：① 换到 19000–19999（与全组端口纪律一致，避开常驻服务段）；
//            ② 绑定成功后再 close 不算数 —— 改为「探到就记住，失败就换下一个重试」。
async function freePort(){
  const net=await import('node:net');
  for(let i=0;i<80;i++){
    const p=19000+Math.floor(Math.random()*999);
    const ok=await new Promise(res=>{const s=net.createServer();s.once('error',()=>res(false));s.once('listening',()=>s.close(()=>res(true)));s.listen(p,'127.0.0.1')});
    if(ok) return p;
  }
  throw new Error('no port');
}
// ★ 启动 Chrome 后必须等到 /json/version 真能应答；原实现只在循环里 break，
//   超时后仍继续拿 target，于是报 ECONNREFUSED 而不是「Chrome 没起来」。
async function waitChrome(port, ms=15000){
  const t0=Date.now();
  while(Date.now()-t0<ms){
    try{const r=await fetch(`http://127.0.0.1:${port}/json/version`);if(r.ok)return true}catch{}
    await sleep(100);
  }
  return false;
}
class Cdp{constructor(ws){this.ws=ws;this.id=0;this.p=new Map();this.h=new Map();ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id&&this.p.has(m.id)){const{resolve,reject}=this.p.get(m.id);this.p.delete(m.id);m.error?reject(new Error(m.error.message)):resolve(m.result)}else if(m.method)for(const f of(this.h.get(m.method)||[]))f(m.params)})}send(m,p={}){const id=++this.id;return new Promise((res,rej)=>{this.p.set(id,{resolve:res,reject:rej});this.ws.send(JSON.stringify({id,method:m,params:p}));setTimeout(()=>{if(this.p.has(id)){this.p.delete(id);rej(new Error('timeout '+m))}},30000)})}on(m,f){if(!this.h.has(m))this.h.set(m,[]);this.h.get(m).push(f)}}

const PORT=await freePort();
const ud=path.join(os.tmpdir(),'stateprobe-'+Date.now()); fs.mkdirSync(ud,{recursive:true});
const proc=spawn(CHROME,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-extensions','--mute-audio','--window-size=1440,900',`--remote-debugging-port=${PORT}`,`--user-data-dir=${ud}`,'about:blank'],{detached:true, stdio:['ignore','ignore','pipe']});

// 把清理注册进 exitClean：process.exit 跳过 finally，所以必须走这条路。
onExitCleanup(function(){ try{ killTree(proc); }catch{} try{ reapByUserDir(ud); }catch{} });
if(!await waitChrome(PORT)){ killTree(proc); reapByUserDir(ud); try{fs.rmSync(ud,{recursive:true,force:true})}catch{}
  console.error(`❌ 探针故障：headless Chrome 在 ${PORT} 上 15 秒内没起来（不是产品缺陷）`);
  exitClean(2); }
const t=await (async()=>{for(const m of['PUT','GET']){const r=await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`,{method:m});if(r.ok)return r.json()}throw new Error('no target')})();
const ws=new WebSocket(t.webSocketDebuggerUrl);
await new Promise((res,rej)=>{ws.addEventListener('open',res);ws.addEventListener('error',rej)});
const c=new Cdp(ws); await c.send('Page.enable'); await c.send('Runtime.enable');
const loaded=new Promise(res=>{let d=false;c.on('Page.loadEventFired',()=>{if(!d){d=true;res()}});setTimeout(()=>{if(!d){d=true;res()}},12000)});
try{await Promise.race([c.send('Page.navigate',{url:'http://127.0.0.1:8890/photos/'}),sleep(8000)])}catch{}
await loaded; await sleep(800);

const EXPR=`(()=>{
  // 在同一页面里并排造出三种态，量它们的计算样式
  const host = document.createElement('div');
  host.id='probe-states';
  host.style.cssText='position:fixed;left:0;top:0;width:900px;background:#0a0d0b;padding:20px;z-index:99999;display:flex;gap:16px';
  host.innerHTML =
    '<div class="empty" id="p-empty" style="flex:1"><b>这里还没有相片</b><span>扫一下目录就会出来</span></div>' +
    '<div class="empty error" id="p-err" style="flex:1"><b>相片没读出来</b><span>服务没响应</span></div>';
  document.body.appendChild(host);

  const pick = el => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return { borderStyle: cs.borderTopStyle, borderColor: cs.borderTopColor, borderLeftWidth: cs.borderLeftWidth,
      textAlign: cs.textAlign, alignItems: cs.alignItems, paddingLeft: cs.paddingLeft,
      bg: cs.backgroundColor, w: Math.round(r.width), h: Math.round(r.height) };
  };
  const e0 = pick(document.getElementById('p-empty'));
  const e1 = pick(document.getElementById('p-err'));

  // 去色测试：转灰度后两者的边框亮度是否仍不同（不靠色相也能分）
  const lum = c => { const m = c.match(/[\\d.]+/g); if(!m) return null;
    const [r,g,b] = m.slice(0,3).map(Number); return Math.round(0.2126*r + 0.7152*g + 0.0722*b); };
  const diff = (a,b) => ['borderStyle','textAlign','alignItems','paddingLeft','borderLeftWidth']
    .filter(k => String(a[k]) !== String(b[k]));

  return {
    empty: e0, error: e1,
    structuralDiffs: diff(e0,e1),
    grayLumEmpty: lum(e0.borderColor), grayLumError: lum(e1.borderColor),
    grayDelta: Math.abs((lum(e0.borderColor)||0) - (lum(e1.borderColor)||0)),
    bothRendered: e0.h>0 && e1.h>0,
  };
})()`;
const r=await c.send('Runtime.evaluate',{expression:EXPR,returnByValue:true});
const v=r.result.value;
console.log(JSON.stringify(v,null,1));
const issues=[];
if(!v.bothRendered) issues.push('两种态没有都画出来（量不到尺寸）');
if(v.structuralDiffs.length===0) issues.push('去色后完全同形：没有任何结构性差异（只靠颜色不算区分）');
if(v.grayDelta < 8) issues.push(`灰度下边框亮度差仅 ${v.grayDelta}，色盲/黑白打印会分不出`);
console.log(issues.length? '\n❌ '+issues.join('；') : '\n✅ 结构性差异: '+v.structuralDiffs.join(' / ')+'；灰度差 '+v.grayDelta);
killTree(proc); reapByUserDir(ud); try{fs.rmSync(ud,{recursive:true,force:true})}catch{}
exitClean(issues.length?1:0);
