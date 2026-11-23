// 验证 Rev3：三态 ::before 符号真渲染、textContent 不冲掉、边框虚实/粗细不同、无 emoji
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import net from 'node:net';

// ★ 2026-11-22 探针互斥：六个用真浏览器的探针里，原本只有 toast-behavior
//   读了 regress.lock，其余五个既不读锁也不互相避让。实测两个探针并发时
//   本机 load 31~65（8 核），标签页被挤到后台 → Chrome 冻结渲染时间线 →
//   transition 不推进 → computed opacity 恒为 0 → 判「提示没画出来」。
//   于是同一份代码两次跑出不同缺陷页。锁在这里，不是可选项。
import { acquireProbeLock } from './probe-lock.mjs';
await acquireProbeLock('toast-symbol');
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE=process.env.WW_BASE||'http://127.0.0.1:8890';
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


async function freePort(){for(let i=0;i<80;i++){const p=19000+Math.floor(Math.random()*999);const ok=await new Promise(res=>{const s=net.createServer();s.once('error',()=>res(false));s.once('listening',()=>s.close(()=>res(true)));s.listen(p,'127.0.0.1')});if(ok)return p}throw new Error('no port')}
class Cdp{constructor(ws){this.ws=ws;this.id=0;this.p=new Map();this.h=new Map();ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id&&this.p.has(m.id)){const{resolve,reject}=this.p.get(m.id);this.p.delete(m.id);m.error?reject(new Error(m.error.message)):resolve(m.result)}else if(m.method)for(const f of(this.h.get(m.method)||[]))f(m.params)})}send(m,p={}){const id=++this.id;return new Promise((res,rej)=>{this.p.set(id,{resolve:res,reject:rej});this.ws.send(JSON.stringify({id,method:m,params:p}));setTimeout(()=>{if(this.p.has(id)){this.p.delete(id);rej(new Error('timeout '+m))}},40000)})}on(m,f){if(!this.h.has(m))this.h.set(m,[]);this.h.get(m).push(f)}}
const PORT=await freePort();
const ud=path.join(os.tmpdir(),'rev3-'+Date.now()); fs.mkdirSync(ud,{recursive:true});
const proc=spawn(CHROME,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-extensions','--mute-audio','--window-size=1440,900',`--remote-debugging-port=${PORT}`,`--user-data-dir=${ud}`,'about:blank'],{detached:true, stdio:['ignore','ignore','pipe']});

// 把清理注册进 exitClean：process.exit 跳过 finally，所以必须走这条路。
onExitCleanup(function(){ try{ killTree(proc); }catch{} try{ reapByUserDir(ud); }catch{} });
try{
  let ready=false;
  for(let i=0;i<150;i++){try{const r=await fetch(`http://127.0.0.1:${PORT}/json/version`);if(r.ok){ready=true;break}}catch{}await sleep(100)}
  if(!ready){console.error('探针故障: Chrome 未就绪');exitClean(2)}
  let t=null; for(const m of['PUT','GET']){const r=await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`,{method:m});if(r.ok){t=await r.json();break}}
  const ws=new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res,rej)=>{ws.addEventListener('open',res);ws.addEventListener('error',rej)});
  const c=new Cdp(ws); await c.send('Page.enable'); await c.send('Runtime.enable');
  const loaded=new Promise(res=>{let d=false;c.on('Page.loadEventFired',()=>{if(!d){d=true;res()}});setTimeout(()=>{if(!d){d=true;res()}},15000)});
  await c.send('Page.navigate',{url:BASE+'/'}).catch(()=>{});
  await loaded; await sleep(800);
  const EXPR=`(async()=>{
    const t=document.getElementById('toast');
    const snap=async(k)=>{ window.toast('探针-'+k, k);
      await new Promise(r=>setTimeout(r,700));
      const cs=getComputedStyle(t);
      const bf=getComputedStyle(t,'::before');
      return {cls:t.className,
        before:bf.content, beforeOpacity:bf.opacity, beforeWeight:bf.fontWeight,
        borderStyle:cs.borderTopStyle, borderWidth:cs.borderTopWidth,
        text:t.textContent, hasAfter:(()=>{const a=getComputedStyle(t,'::after');return a.content})()};};
    return {info:await snap('info'), good:await snap('good'), err:await snap('err')};
  })()`;
  const r=await c.send('Runtime.evaluate',{expression:EXPR,returnByValue:true,awaitPromise:true});
  const v=r.result.value;
  for(const k of ['info','good','err']) console.log(k, JSON.stringify(v[k]));
  const fail=[];
  const sym=s=>String(s||'').replace(/["']/g,'').trim();
  const si=sym(v.info.before), sg=sym(v.good.before), se=sym(v.err.before);
  if(!si) fail.push('info 没有 ::before 符号');
  if(!sg) fail.push('good 没有 ::before 符号');
  if(!se) fail.push('err 没有 ::before 符号');
  if(si===sg||sg===se||si===se) fail.push(`三态符号不互异: info=${si} good=${sg} err=${se}`);
  if(/[\u{1F300}-\u{1FAFF}]/u.test(si+sg+se)) fail.push('符号含 emoji（U+1F300–1FAFF）');
  if(v.info.borderStyle!=='dashed') fail.push(`info 边框应 dashed，实为 ${v.info.borderStyle}`);
  if(v.good.borderStyle!=='solid') fail.push(`good 边框应 solid，实为 ${v.good.borderStyle}`);
  if(v.err.borderWidth!=='2px') fail.push(`err 边框应 2px，实为 ${v.err.borderWidth}`);
  // textContent 是否冲掉 ::before
  if(!v.err.text.includes('探针-err')) fail.push('textContent 丢了正文');
  console.log('符号: info='+JSON.stringify(si)+' good='+JSON.stringify(sg)+' err='+JSON.stringify(se));
  console.log(fail.length? 'FAIL: '+fail.join(' / ') : 'PASS Rev3 四维区分成立（符号互异/边框虚实粗细/无 emoji）');
  try{ws.close()}catch{}
  exitClean(fail.length?1:0);
} finally { killTree(proc); reapByUserDir(ud); try{fs.rmSync(ud,{recursive:true,force:true})}catch{} }
