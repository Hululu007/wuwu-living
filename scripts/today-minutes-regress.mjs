// 首页「在读」格 todayMinutes 三态：真 0 / null / 正常值 必须渲染出三种不同文案
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import net from 'node:net';
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE=process.env.WW_BASE||'http://127.0.0.1:8890';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let __c=[]; const onExitCleanup=f=>__c.push(f);
function exitClean(x){ for(const f of __c){try{f()}catch{}} process.exit(x) }
function reap(dir){ if(!dir) return 0; let t=0;
  for(let r=0;r<4;r++){ let pids=[];
    try{const x=spawnSync('pgrep',['-f',dir],{encoding:'utf8',timeout:5000}); pids=String(x.stdout||'').trim().split(/\s+/).filter(Boolean)}catch{return t}
    if(!pids.length) break; for(const p of pids){try{process.kill(Number(p),'SIGKILL')}catch{}} t+=pids.length;
    try{spawnSync('sleep',['0.4'],{timeout:2000})}catch{} } return t }
function killTree(p){ try{process.kill(-p.pid,'SIGKILL')}catch{} try{p.kill('SIGKILL')}catch{} }
async function freePort(){for(let i=0;i<80;i++){const p=19000+Math.floor(Math.random()*999);const ok=await new Promise(res=>{const s=net.createServer();s.once('error',()=>res(false));s.once('listening',()=>s.close(()=>res(true)));s.listen(p,'127.0.0.1')});if(ok)return p}throw new Error('no port')}
class Cdp{constructor(ws){this.ws=ws;this.id=0;this.p=new Map();this.h=new Map();ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id&&this.p.has(m.id)){const{resolve,reject}=this.p.get(m.id);this.p.delete(m.id);m.error?reject(new Error(m.error.message)):resolve(m.result)}else if(m.method)for(const f of(this.h.get(m.method)||[]))f(m.params)})}send(m,p={}){const id=++this.id;return new Promise((res,rej)=>{this.p.set(id,{resolve:res,reject:rej});this.ws.send(JSON.stringify({id,method:m,params:p}));setTimeout(()=>{if(this.p.has(id)){this.p.delete(id);rej(new Error('timeout '+m))}},40000)})}on(m,f){if(!this.h.has(m))this.h.set(m,[]);this.h.get(m).push(f)}}

// ★★ 2026-11-22 登记时自己犯的错：本套默认打线上 8890，
//   但首页是 hub.mjs 启动时读入的**快照页** —— 磁盘改了、没重启时，
//   探针读到的还是旧版，于是判「产品有缺陷」。那是误报：真相是「改了没生效」。
//   现在先查 /api/ping 的 stalePages：目标页在列表里就 exit 2（探针/环境故障，不是产品失败），
//   并把「请重启」写进输出，避免下一个人又把它当成产品缺陷。
// ★ 只在目标就是生产 8890 时才做 stale 预检：
//   夹具（如 :19175）也会反代 /api/ping 到 8890，它下发的却是**磁盘版**页面，
//   拿生产的 stale 去否决夹具是错的——夹具正是为了绕开快照。
const IS_PROD = /^https?:\/\/(127\.0\.0\.1|localhost):8890\/?$/.test(BASE);
try {
  if (!IS_PROD) throw new Error('skip: not production target');
  const ping = await fetch(BASE + '/api/ping', { signal: AbortSignal.timeout(5000) }).then(r => r.json());
  const stale = Array.isArray(ping.stalePages) ? ping.stalePages : [];
  if (stale.includes('五五客厅.html')) {
    console.error('⚠️  五五客厅.html 已改但未重启（快照页）→ 本次结论不可用，不是产品缺陷');
    console.error('   请重启 8890 后重跑：launchctl kickstart -k gui/$(id -u)/com.wuwu.wuwu-living');
    exitClean(2);
  }
} catch { /* ping 不可用就直接跑，不阻断 */ }

const CASES=[
 {name:'real0',  reading:{ok:true, lastBook:'某本书', todayMinutes:0,    sources:7538}, expect:'今天 0 分钟'},
 {name:'null',   reading:{ok:true, lastBook:'某本书', todayMinutes:null, sources:7538}, expect:'今天 — 分钟'},
 {name:'normal', reading:{ok:true, lastBook:'某本书', todayMinutes:42,   sources:7538}, expect:'今天 42 分钟'},
];
const bad=[]; const seen={};
for(const cs of CASES){
  const PORT=await freePort();
  const ud=path.join(os.tmpdir(),'tmp-'+Date.now()+'-'+Math.floor(Math.random()*9999)); fs.mkdirSync(ud,{recursive:true});
  const proc=spawn(CHROME,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-extensions','--mute-audio','--window-size=1440,900',`--remote-debugging-port=${PORT}`,`--user-data-dir=${ud}`,'about:blank'],{detached:true,stdio:['ignore','ignore','pipe']});
  onExitCleanup(()=>{killTree(proc); reap(ud); try{fs.rmSync(ud,{recursive:true,force:true})}catch{}});
  try{
    let ready=false;
    for(let i=0;i<150;i++){try{const r=await fetch(`http://127.0.0.1:${PORT}/json/version`);if(r.ok){ready=true;break}}catch{}await sleep(100)}
    if(!ready){console.error('探针故障: Chrome 未就绪');exitClean(2)}
    let t=null; for(const m of['PUT','GET']){const r=await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`,{method:m});if(r.ok){t=await r.json();break}}
    const ws=new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res,rej)=>{ws.addEventListener('open',res);ws.addEventListener('error',rej)});
    const c=new Cdp(ws); await c.send('Page.enable'); await c.send('Runtime.enable');
    await c.send('Fetch.enable',{patterns:[{urlPattern:'*/api/home/summary*',requestStage:'Request'}]});
    c.on('Fetch.requestPaused',async p=>{
      try{
        const real=await fetch(BASE+'/api/home/summary').then(r=>r.json());
        real.reading=cs.reading;
        const body=Buffer.from(JSON.stringify(real)).toString('base64');
        await c.send('Fetch.fulfillRequest',{requestId:p.requestId,responseCode:200,
          responseHeaders:[{name:'content-type',value:'application/json; charset=utf-8'},{name:'cache-control',value:'no-store'}],body});
      }catch(e){ await c.send('Fetch.continueRequest',{requestId:p.requestId}).catch(()=>{}) }
    });
    const loaded=new Promise(res=>{let d=false;c.on('Page.loadEventFired',()=>{if(!d){d=true;res()}});setTimeout(()=>{if(!d){d=true;res()}},15000)});
    await c.send('Page.navigate',{url:BASE+'/'}).catch(()=>{});
    await loaded; await sleep(1200);
    const r=await c.send('Runtime.evaluate',{expression:`(()=>{const e=document.getElementById('rdSub');return e?(e.textContent||'').trim():null})()`,returnByValue:true});
    const txt=r.result.value||'';
    seen[cs.name]=txt;
    const ok = txt.includes(cs.expect);
    console.log(`[${cs.name}] "${txt}" ${ok?'PASS':'FAIL 期望含「'+cs.expect+'」'}`);
    if(!ok) bad.push(cs.name);
    try{ws.close()}catch{}
  } finally { killTree(proc); reap(ud); try{fs.rmSync(ud,{recursive:true,force:true})}catch{} }
}
// 三态必须互不相同
const vals=Object.values(seen);
if(new Set(vals).size!==3) bad.push('三态文案未互异');
console.log('SUMMARY', JSON.stringify(seen));
console.log(bad.length? 'EXIT=1 失败: '+bad.join(',') : 'EXIT=0 三态互异且正确');
exitClean(bad.length?1:0);
