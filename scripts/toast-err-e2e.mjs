// A/B 修法端到端探针：注入失败响应 → 点真按钮 → 量 toast 的 class 与 3 秒后是否还在
// 判据（A 类）：class 含 err 且 3 秒后仍可见（失败常驻，不自动消失）
// 判据（B 类）：两分支必须不同——失败分支含 err，成功分支不含 err
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import net from 'node:net';

// ★ 2026-11-22 探针互斥：六个用真浏览器的探针里，原本只有 toast-behavior
//   读了 regress.lock，其余五个既不读锁也不互相避让。实测两个探针并发时
//   本机 load 31~65（8 核），标签页被挤到后台 → Chrome 冻结渲染时间线 →
//   transition 不推进 → computed opacity 恒为 0 → 判「提示没画出来」。
//   于是同一份代码两次跑出不同缺陷页。锁在这里，不是可选项。
import { acquireProbeLock } from './probe-lock.mjs';
await acquireProbeLock('toast-err-e2e');
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

// ★★ 2026-11-22 实测漏点：上面那条只修了「正常退出」。
//   探针里任何**未被捕获的异常**（实测最常见的是 CDP `timeout Runtime.evaluate`，
//   页面脚本卡住或标签页被挤到后台时必然发生）会直接让进程崩掉：
//     · finally 不执行
//     · exitClean 不被调用
//     · 于是 Chrome 不被杀、user-data-dir 不被删
//   量化后果：本机 /tmp 里已积压 204 个 terr-* 目录共 220MB，
//   全部来自这种崩溃路径（每次崩一个 1MB 左右的 profile）。
//   修法：把崩溃也接进同一条清理路径，并把它判成「探针故障」而不是产品缺陷。
function installCrashCleanup(label){
  const onFatal = (kind) => (err) => {
    try{ console.error(`❌ 探针故障（${kind}）：${(err && (err.message||err)) || '未知'}`); }catch{}
    try{ console.error('   本次结论不可用（exit 2），不是产品缺陷。'); }catch{}
    for(const fn of __cleanupFns){ try{ fn(); }catch{} }
    __cleanupFns = [];
    process.exit(2);
  };
  process.on('uncaughtException', onFatal('未捕获异常'));
  process.on('unhandledRejection', onFatal('未处理的 Promise 拒绝'));
  void label;
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


async function freePort(){for(let i=0;i<40;i++){const p=19000+Math.floor(Math.random()*999);const ok=await new Promise(res=>{const s=net.createServer();s.once('error',()=>res(false));s.once('listening',()=>s.close(()=>res(true)));s.listen(p,'127.0.0.1')});if(ok)return p}throw new Error('no port')}
class Cdp{constructor(ws){this.ws=ws;this.id=0;this.p=new Map();this.h=new Map();ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id&&this.p.has(m.id)){const{resolve,reject}=this.p.get(m.id);this.p.delete(m.id);m.error?reject(new Error(m.error.message)):resolve(m.result)}else if(m.method)for(const f of(this.h.get(m.method)||[]))f(m.params)})}send(m,p={}){const id=++this.id;return new Promise((res,rej)=>{this.p.set(id,{resolve:res,reject:rej});this.ws.send(JSON.stringify({id,method:m,params:p}));setTimeout(()=>{if(this.p.has(id)){this.p.delete(id);rej(new Error('timeout '+m))}},45000)})}on(m,f){if(!this.h.has(m))this.h.set(m,[]);this.h.get(m).push(f)}}

const MEASURE=`(()=>{const t=document.getElementById('toast'); if(!t) return null;
  const cs=getComputedStyle(t); const r=t.getBoundingClientRect();
  return {text:(t.textContent||'').trim(), cls:t.className,
    visible: cs.display!=='none'&&cs.visibility!=='hidden'&&parseFloat(cs.opacity||'1')>0.01&&r.width>0&&r.height>0,
    rect:[Math.round(r.width),Math.round(r.height)],
    afterContent:(()=>{try{return getComputedStyle(t,'::after').content||''}catch(e){return ''}})()};})()`;

// 用例：{name, url, api, body(失败响应), trigger}
const CASES=[
 {name:'五五客厅-全部启动失败', url:'/', sel:'#startAll', api:'*/api/start-all*', resp:{ok:false,message:'全部启动失败了（探针注入）'},
  // ★ startApp 在 IIFE 内，外部取不到；用真实可点控件 #startAll（它同样走 start 链路）
  trigger:`(()=>{const b=document.getElementById('startAll'); if(!b) return 'no startAll'; b.click(); return 'clicked';})()`,
  expect:'A'},
 {name:'五五客厅-门启动失败', url:'/', sel:'.door[data-id="music"]', api:'*/api/start*',
  // ★ 门只有在「房间未运行」时才会 startApp（见 enter() 1070 行）。
  //   线上 music 常常已在跑，点门只切舞台、不发 /api/start —— 那样这臂永远红，
  //   且是「因为没触发」而红，没有区分力。这里覆写 summary 让 music 处于未运行态。
  summaryOverride:{music:{running:false,degraded:false}},
  resp:{ok:false,message:'这间屋没启动成功（探针注入）'},
  // ★ 舞台房的门走 enter()→startApp()→POST /api/start（见 1064-1073 行），
  //   这是 A-1 的真实触发路径；#startAll 走的是另一条 /api/start-all。
  // ★ 点门会先 openStage() 切到舞台视图，toast 被舞台遮住 → 负向臂会「因为看不见而红」，
  //   那是探针缺陷不是产品缺陷。改用页面自己暴露的路径：直接触发一次 POST /api/start
  //   再断言 toast —— 但这样绕过了 startApp 里的 toast 代码，等于没测。
  //   正解：点击后立刻把视图切回首页（stage 关闭），让 toast 可见再量。
  trigger:`(()=>{const d=document.querySelector('.door[data-id="music"]'); if(!d) return 'no door'; d.click(); return 'clicked';})()`,
  // ★ 2026-11-22：门的点击是 `addEventListener('click', …)` 绑的（见 五五客厅.html:1246），
  //   `el.onclick` 永远为 null —— 默认就绪判据 `!!(b && b.onclick)` 对门恒为 false，
  //   于是「元素明明在、脚本明明绑好了」却被判成「10 秒内未就绪」→ 探针故障（假红）。
  //   门的就绪判据改成：元素存在 + 文档加载完成 + 共享 toast 已就绪
  //   （这三条同时成立时，1246 行那段同步绑定必然已执行）。
  ready:`(()=>{const d=document.querySelector('.door[data-id="music"]'); return !!(d && document.readyState==='complete' && typeof window.toast==='function');})()`,
  expect:'A'},
 {name:'相册-扫描没启动', url:'/photos/', sel:'#btnScan', api:'*/api/photos/scan*', resp:{ok:false,message:'扫描没启动（探针注入）'},
  trigger:`(()=>{const b=document.getElementById('btnScan'); if(!b) return 'no btn'; b.click(); return 'clicked';})()`,
  expect:'A'},
 {name:'下载中心-清空0条', url:'/download/', sel:'#btnClear', api:'*/api/download/clear-done*', resp:{ok:true,removed:0},
  trigger:`(()=>{const b=document.getElementById('btnClear'); if(!b) return 'no btn'; b.click(); return 'clicked';})()`,
  expect:'B-info'},
 {name:'下载中心-清空N条', url:'/download/', sel:'#btnClear', api:'*/api/download/clear-done*', resp:{ok:true,removed:3},
  trigger:`(()=>{const b=document.getElementById('btnClear'); if(!b) return 'no btn'; b.click(); return 'clicked';})()`,
  expect:'B-good'},
];

const bad=[]; const results={}; const probeFails=[];
installCrashCleanup('toast-err-e2e');

// ★ 源码级臂：语义只允许一种写法 —— toast(..., 'err')。
//   为什么这条必须有：toast.js 仍兼容 true 和 'bad'（防旧缓存跨版本错配），
//   所以「传 true/'bad'」在运行时不报错、渲染也正常 —— 光看运行时永远发现不了它回来了。
//   只能查源码。
//   ★ 2026-11-22 扩断言：原来只查 true，漏了 'bad'（投屏.html 实测 8 处）。
//     两者经 normalize 都映射到 'err'，行为等价、不是缺陷，但「一种语义三种写法」
//     正是今天反复出问题的根源 —— 断言必须把等价别名一起查，否则永远收不干净。
{
  const fsx=await import('node:fs'); const px=await import('node:path');
  const root=px.default.resolve(import.meta.dirname,'..','public');
  /* ★★ 2026-11-22 废掉正则式，改括号配对（真缺陷）：
   *   旧写法 /toast\((?:[^;()]|\([^()]*\))*?,\s*true\)/ 只能处理**一层**嵌套，
   *   且要求第二实参**整段等于**别名。实测投屏.html 改前有 10 处别名，
   *   旧写法只命中 8 处 —— 漏掉的两处正是三元形：
   *     toast(x, e ? 'bad' : 'good')
   *     toast(x, d.ok ? 'good' : 'bad')
   *   这两处是**真实的 toast tone 别名**，且三元写法正是今天出现最多的一种，
   *   漏掉它们等于断言对「三元写 bad」这类回流完全瞫眼。
   *   现在：用括号配对切出真实参列表 → 取第二实参原文 → 只要**出现**别名就报。
   *   误报风险已排除：先剥注释，且只看 toast( 括号内部的第二实参，
   *   CSS 类名 'bad'（如 .dot.bad / class="r bad"）不在 toast( 里，不会计入。 */
  function scanAliases(src){
    const s = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
    const out = [];
    let i = 0;
    while ((i = s.indexOf('toast(', i)) >= 0) {
      const start = i + 6;
      let k = start, depth = 1;
      while (k < s.length && depth > 0) {
        const c = s[k];
        if (c === '(') depth++;
        else if (c === ')') depth--;
        k++;
      }
      if (depth !== 0) { i = start; continue; }
      const call = s.slice(start, k - 1);
      const args = []; let cur = '', d = 0, q = null;
      for (let j = 0; j < call.length; j++) {
        const c = call[j];
        if (q) { cur += c; if (c === q && call[j - 1] !== '\\') q = null; continue; }
        if (c === '"' || c === "'") { q = c; cur += c; continue; }
        if ('([{'.includes(c)) d++;
        else if (')]}'.includes(c)) d--;
        if (c === ',' && d === 0) { args.push(cur); cur = ''; continue; }
        cur += c;
      }
      if (cur.trim()) args.push(cur);
      const second = (args[1] || '').trim();
      if (/\btrue\b/.test(second)) out.push({ kind: 'true', second });
      if (/["']bad["']/.test(second)) out.push({ kind: 'bad', second });
      i = k;
    }
    return out;
  }
  const hits=[];
  for(const f of fsx.default.readdirSync(root).filter(x=>x.endsWith('.html'))){
    const src=fsx.default.readFileSync(px.default.join(root,f),'utf8');
    const found = scanAliases(src);
    const t = found.filter(x=>x.kind==='true').length;
    const b = found.filter(x=>x.kind==='bad').length;
    if(t) hits.push(`${f}:true\u00d7${t}`);
    if(b) hits.push(`${f}:bad\u00d7${b}`);
  }
  const okSrc = hits.length===0;
  console.log(`[源码-语义别名退役] ${okSrc?'PASS 全站只有 \'err\' 一种写法':'FAIL 仍有别名 '+hits.join(' ')}`);
  if(!okSrc) bad.push('源码-布尔别名退役');
  results['源码-布尔别名退役']=okSrc;
}
for(const cs of CASES){
  const PORT=await freePort();
  const ud=path.join(os.tmpdir(),'terr-'+Date.now()+'-'+Math.floor(Math.random()*9999));
  fs.mkdirSync(ud,{recursive:true});
  const proc=spawn(CHROME,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-extensions','--mute-audio','--window-size=1440,900',`--remote-debugging-port=${PORT}`,`--user-data-dir=${ud}`,'about:blank'],{detached:true, stdio:['ignore','ignore','pipe']});

// 把清理注册进 exitClean：process.exit 跳过 finally，所以必须走这条路。
onExitCleanup(function(){ try{ killTree(proc); }catch{} try{ reapByUserDir(ud); }catch{} });
  let ok=true, detail={};
  try{
    // ★ 2026-11-22：原实现在循环里 break，超时后仍继续拿 target，
    //   于是报 ECONNREFUSED（看起来像产品缺陷）。改成显式就绪判定 + exit 2。
    let ready=false;
    for(let i=0;i<150;i++){try{const r=await fetch(`http://127.0.0.1:${PORT}/json/version`);if(r.ok){ready=true;break}}catch{}await sleep(100)}
    if(!ready){
      // 顶层不能用 return：直接给出可读原因并退出 2（探针故障，不是产品缺陷）
      console.error(`❌ 探针故障：headless Chrome 在 ${PORT} 上 15 秒内没起来（不是产品缺陷）`);
      killTree(proc)
      try{fs.rmSync(ud,{recursive:true,force:true})}catch{}
      exitClean(2);
    }
    let t=null; for(const m of['PUT','GET']){const r=await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`,{method:m});if(r.ok){t=await r.json();break}}
    const ws=new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res,rej)=>{ws.addEventListener('open',res);ws.addEventListener('error',rej)});
    const c=new Cdp(ws); await c.send('Page.enable'); await c.send('Runtime.enable');
    const patterns=[{urlPattern:cs.api,requestStage:'Request'}];
    if(cs.summaryOverride) patterns.push({urlPattern:'*/api/home/summary*',requestStage:'Request'});
    await c.send('Fetch.enable',{patterns});
    c.on('Fetch.requestPaused',async p=>{
      try{
        let payload=cs.resp;
        if(cs.summaryOverride && /\/api\/home\/summary/.test(p.request.url)){
          const real=await fetch(BASE+'/api/home/summary').then(r=>r.json());
          real.apps=(real.apps||[]).map(a=>cs.summaryOverride[a.id]?{...a,...cs.summaryOverride[a.id]}:a);
          payload=real;
        }
        const body=Buffer.from(JSON.stringify(payload)).toString('base64');
        await c.send('Fetch.fulfillRequest',{requestId:p.requestId,responseCode:200,
          responseHeaders:[{name:'content-type',value:'application/json; charset=utf-8'},{name:'cache-control',value:'no-store'}],body});
      }catch(e){await c.send('Fetch.continueRequest',{requestId:p.requestId}).catch(()=>{})}
    });
    const loaded=new Promise(res=>{let d=false;c.on('Page.loadEventFired',()=>{if(!d){d=true;res()}});setTimeout(()=>{if(!d){d=true;res()}},15000)});
    await c.send('Page.navigate',{url:BASE+cs.url}).catch(()=>{});
    await loaded;
    // ★ 就绪判据不能靠 sleep：等「触发元素存在 且 onclick 已绑定」再点。
    //   实测竞态：下载中心 load() 是异步的，#btnClear 存在但 onclick 还是 null，
    //   此时点击什么都不发生，会被误判成「产品没弹 toast」。
    const READY=cs.ready||`(()=>{const b=document.querySelector('${cs.sel||'#startAll'}'); return !!(b && b.onclick);})()`;
    // ★ 2026-11-22：原来这个轮询跑满 10 秒后**不判失败就继续**，
    //   接着点一个还没绑 onclick 的按钮 → detail.trigger='clicked' 但什么都没发生
    //   → 判「toast 没出现」→ 被当成产品缺陷。
    //   实测相册那条就是这样假红过一次（并发负载下按钮晚于 10 秒才就绪）。
    //   现在：就绪超时 = 探针故障（exit 2），明确与产品缺陷分开。
    let readyEl=false;
    for(let i=0;i<100;i++){
      const r=await c.send('Runtime.evaluate',{expression:READY,returnByValue:true});
      if(r.result.value===true){ readyEl=true; break; }
      await sleep(100);
    }
    if(!readyEl){
      console.error(`❌ 探针故障：${cs.name} 的触发元素 10 秒内未就绪（不是产品缺陷）`);
      console.error(`  选择器 ${cs.sel||'#startAll'}；多半是负载高或页面脚本报错`);
      detail.probeFail='元素未就绪';
      probeFails.push(cs.name);
      // 这一条不计入「产品缺陷」，直接标记为探针故障并继续下一条
      try{ await c.send('Fetch.disable'); }catch{}
      try{ ws.close(); }catch{}
      continue;
    }
    const fire=await c.send('Runtime.evaluate',{expression:cs.trigger,returnByValue:true,awaitPromise:true});
    detail.trigger=fire.result.value;
    let first=null;
    for(let i=0;i<50;i++){
      const r=await c.send('Runtime.evaluate',{expression:MEASURE,returnByValue:true});
      const v=r.result.value;
      // ★ 不能用 visible 判首帧：点门会 openStage()，toast 被舞台层盖住，
      //   getBoundingClientRect 仍非零但视觉被遮挡 → 会把「已实现」判成「没出现」。
      //   这里只要文本非空就算出现；样式由 class 判定，持久性由 3 秒后 class 判定。
      if(v&&v.text){first=v;break}
      await sleep(100);
    }
    detail.first=first;
    await sleep(3000);   // ★ 越过 2400ms 自动消失窗口
    const r2=await c.send('Runtime.evaluate',{expression:MEASURE,returnByValue:true});
    detail.after3s=r2.result.value;

    const fail=[];
    if(!String(detail.trigger).startsWith('clicked')) fail.push('触发失败：'+detail.trigger);
    else if(!first) fail.push('toast 没出现');
    else{
      const cls=first.cls||''; const isErr=/\berr\b/.test(cls);
      if(cs.expect==='A'){
        if(!isErr) fail.push(`失败提示没走 err 样式（class="${cls}"）= 与成功同色`);
        // 失败必须常驻：3 秒后 class 里必须还带 err（自动消失会把 err 去掉）
        if(!(detail.after3s&&/\berr\b/.test(detail.after3s.cls||''))) fail.push('3 秒后 err 样式已消失 = 失败没常驻');
        // ★ 「点此关闭」是 .toast.err.on::after 伪元素，不在 className 里。
        //   判据改成查伪元素 content，否则会把「已实现」误判成缺失（我第一版就是这么错的）。
        if(detail.after3s && !/点此关闭/.test(detail.after3s.afterContent||'')) fail.push('err 态缺「点此关闭」伪元素提示');
      }
      if(cs.expect==='B-info'){
        if(isErr) fail.push(`removed=0 被当成失败（class="${cls}"）`);
      }
      if(cs.expect==='B-good'){
        if(!/\bgood\b/.test(cls)) fail.push(`removed=3 没走 good 样式（class="${cls}"）`);
      }
    }
    ok=fail.length===0;
    console.log(`[${cs.name}] first=${JSON.stringify(first&&{cls:first.cls,text:first.text})} after3s=${JSON.stringify(detail.after3s&&{cls:detail.after3s.cls,visible:detail.after3s.visible,text:detail.after3s.text})}`);
    console.log(`[${cs.name}] ${ok?'PASS':'FAIL: '+fail.join(' / ')}`);
    await c.send('Fetch.disable').catch(()=>{});
    try{ws.close()}catch{}
  } finally { killTree(proc); reapByUserDir(ud); try{fs.rmSync(ud,{recursive:true,force:true})}catch{} }
  results[cs.name]=ok; if(!ok) bad.push(cs.name);
}
console.log('\nSUMMARY '+JSON.stringify(results));
// ★ 探针故障优先判定：它证明不了产品好坏，不能混进「缺陷」里报红，也不能报绿。
if(probeFails.length){console.log('EXIT=2 探针故障（本次结论不可用）: '+probeFails.join(','));exitClean(2)}
if(bad.length){console.log('EXIT=1 失败: '+bad.join(','));exitClean(1)}
console.log('EXIT=0 A/B 全过');exitClean(0);
