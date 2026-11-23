// 书房「书源库」端到端：点开弹窗 → 量 chips 条数 + 首屏列表条数 + 加载态/空态
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import net from 'node:net';
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE=process.env.WW_BASE||'http://127.0.0.1:8890';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let __cleanupFns=[]; const onExitCleanup=f=>__cleanupFns.push(f);
function exitClean(c){ for(const f of __cleanupFns){try{f()}catch{}} __cleanupFns=[]; process.exit(c); }
function reapByUserDir(dir){
  if(!dir) return 0;
  let total=0;
  for(let r=0;r<4;r++){
    let pids=[];
    try{ const x=spawnSync('pgrep',['-f',dir],{encoding:'utf8',timeout:5000});
      pids=String(x.stdout||'').trim().split(/\s+/).filter(Boolean); }catch{return total}
    if(!pids.length) break;
    for(const p of pids){ try{process.kill(Number(p),'SIGKILL')}catch{} }
    total+=pids.length;
    try{ spawnSync('sleep',['0.4'],{timeout:2000}) }catch{}
  }
  return total;
}
function killTree(p){ try{process.kill(-p.pid,'SIGKILL')}catch{} try{p.kill('SIGKILL')}catch{} }
async function freePort(){for(let i=0;i<80;i++){const p=19000+Math.floor(Math.random()*999);const ok=await new Promise(res=>{const s=net.createServer();s.once('error',()=>res(false));s.once('listening',()=>s.close(()=>res(true)));s.listen(p,'127.0.0.1')});if(ok)return p}throw new Error('no port')}
class Cdp{constructor(ws){this.ws=ws;this.id=0;this.p=new Map();this.h=new Map();ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id&&this.p.has(m.id)){const{resolve,reject}=this.p.get(m.id);this.p.delete(m.id);m.error?reject(new Error(m.error.message)):resolve(m.result)}else if(m.method)for(const f of(this.h.get(m.method)||[]))f(m.params)})}send(m,p={}){const id=++this.id;return new Promise((res,rej)=>{this.p.set(id,{resolve:res,reject:rej});this.ws.send(JSON.stringify({id,method:m,params:p}));setTimeout(()=>{if(this.p.has(id)){this.p.delete(id);rej(new Error('timeout '+m))}},40000)})}on(m,f){if(!this.h.has(m))this.h.set(m,[]);this.h.get(m).push(f)}}

const PORT=await freePort();
const ud=path.join(os.tmpdir(),'bkgrp-'+Date.now()); fs.mkdirSync(ud,{recursive:true});
const proc=spawn(CHROME,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-extensions','--mute-audio','--window-size=1440,900',`--remote-debugging-port=${PORT}`,`--user-data-dir=${ud}`,'about:blank'],{detached:true,stdio:['ignore','ignore','pipe']});
onExitCleanup(()=>{ killTree(proc); reapByUserDir(ud); try{fs.rmSync(ud,{recursive:true,force:true})}catch{} });
try{
  let ready=false;
  for(let i=0;i<150;i++){try{const r=await fetch(`http://127.0.0.1:${PORT}/json/version`);if(r.ok){ready=true;break}}catch{}await sleep(100)}
  if(!ready){console.error('探针故障: Chrome 未就绪');exitClean(2)}
  let t=null; for(const m of['PUT','GET']){const r=await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`,{method:m});if(r.ok){t=await r.json();break}}
  const ws=new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res,rej)=>{ws.addEventListener('open',res);ws.addEventListener('error',rej)});
  const c=new Cdp(ws); await c.send('Page.enable'); await c.send('Runtime.enable');
  // 记录 groups 请求
  await c.send('Page.addScriptToEvaluateOnNewDocument',{source:`
    window.__g=[]; const of_=window.fetch;
    window.fetch=function(u,o){const t0=Date.now();const url=String(u&&u.url||u);const p=of_.apply(this,arguments);
      if(/book\\/groups/.test(url)){ p.then(r=>window.__g.push({url,ms:Date.now()-t0,status:r.status}))
        .catch(e=>window.__g.push({url,err:String(e&&e.message||e)})); }
      // ★ 2026-11-22 补：也记录首屏搜索请求。原探针只记 groups，
      //   于是「首屏别传 undefined」这条判据**从未真正验过**：
      //   代码里写的是 groups[0].name，但没人量过实际发出的 URL。
      if(/book\\/search/.test(url)){ window.__s=window.__s||[]; window.__s.push({url}); }
      return p;};
  `});
  const loaded=new Promise(res=>{let d=false;c.on('Page.loadEventFired',()=>{if(!d){d=true;res()}});setTimeout(()=>{if(!d){d=true;res()}},20000)});
  await c.send('Page.navigate',{url:BASE+'/book/'}).catch(()=>{});
  await loaded; await sleep(1200);
  // 点开书源库
  const EXPR=`(async()=>{
    // 入口是 #openSources，按钮文案「浏览书源」（不是「书源库」）
    const btn=document.getElementById('openSources') ||
      [...document.querySelectorAll('button,a,[role=button]')].find(e=>/浏览书源|书源库/.test((e.textContent||'').trim()));
    if(!btn) return {err:'找不到书源库入口(#openSources)'};
    btn.click();
    const chips=document.getElementById('groupChips');
    const list=document.getElementById('sourceList');
    const modal=document.getElementById('sourceModal');
    const t0=performance.now();
    let loadingSeen=false;
    for(let i=0;i<80;i++){
      if(chips && /正在读分组/.test(chips.textContent||'')) loadingSeen=true;
      const n=chips?chips.querySelectorAll('button').length:0;
      if(n>0) break;
      await new Promise(r=>setTimeout(r,100));
    }
    await new Promise(r=>setTimeout(r,1200));
    const chipBtns=chips?[...chips.querySelectorAll('button')]:[];
    const items=list?list.querySelectorAll('[data-idx], .src-item, li, .row').length:0;
    return {modalOpen: !!(modal && !modal.hidden),
      chipCount: chipBtns.length,
      chipSample: chipBtns.slice(0,3).map(b=>b.textContent),
      listText: (list?list.textContent:'').trim().slice(0,80),
      listItemGuess: items,
      loadingSeen,
      ms: Math.round(performance.now()-t0)};
  })()`;
  const r=await c.send('Runtime.evaluate',{expression:EXPR,returnByValue:true,awaitPromise:true});
  const v=r.result.value||{};
  const g=await c.send('Runtime.evaluate',{expression:'window.__g||[]',returnByValue:true});
  const reqs=g.result.value||[];
  const s2=await c.send('Runtime.evaluate',{expression:'window.__s||[]',returnByValue:true});
  const searches=s2.result.value||[];
  console.log('结果:', JSON.stringify(v));
  console.log('groups 请求:', JSON.stringify(reqs));
  console.log('首屏搜索请求:', JSON.stringify(searches));
  const fail=[];
  if(v.err) fail.push(v.err);
  if(!v.modalOpen) fail.push('弹窗没打开');
  if(!(v.chipCount>0)) fail.push(`chips 为 0（修复前就是这个症状）`);
  if(!reqs.length) fail.push('没有发出 /api/book/groups 请求');
  if(/^\s*$/.test(v.listText||'')) fail.push('首屏列表空白');
  // 首屏搜索必须带真实分组名，不能是空
  if(!searches.length) fail.push('首屏没发出搜索请求');
  else {
    const first=searches[0].url;
    if(/[?&]group=(&|$)/.test(first)) fail.push('首屏 group 参数为空（undefined 拼出来的）: '+first);
    if(!/[?&]group=[^&]+/.test(first)) fail.push('首屏未带分组名: '+first);
  }
  console.log(fail.length? 'FAIL: '+fail.join(' / ') : `PASS chips=${v.chipCount} 首屏已加载`);
  try{ws.close()}catch{}
  exitClean(fail.length?1:0);
} catch(e){ console.error('探针故障', e.message); exitClean(2); }
