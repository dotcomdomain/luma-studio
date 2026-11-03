let page;
for(let i=0;i<200;i++){
  try{const pages=await(await fetch('http://127.0.0.1:9222/json')).json();page=pages.find(p=>p.webSocketDebuggerUrl&&p.type==='page')||pages.find(p=>p.webSocketDebuggerUrl);if(page)break}catch(_){}
  await new Promise(r=>setTimeout(r,25));
}
if(!page)throw Error('Editor WebView debugging endpoint is unavailable');
const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((r,reject)=>{ws.onopen=r;ws.onerror=reject});let id=0;const pending=new Map;
ws.onmessage=e=>{const d=JSON.parse(e.data);if(pending.has(d.id)){pending.get(d.id)(d);pending.delete(d.id)}};
export async function call(method,params={}){const n=++id;return new Promise(r=>{pending.set(n,r);ws.send(JSON.stringify({id:n,method,params}))})}
export async function evaluate(expression){const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.error)throw Error(JSON.stringify(r.error));if(r.result.exceptionDetails)throw Error(JSON.stringify(r.result.exceptionDetails));return r.result.result.value}
export function close(){ws.close()}
let ready=false;
for(let i=0;i<300;i++){if(await evaluate("location.protocol==='file:'&&document.readyState==='complete'")){ready=true;break}await new Promise(r=>setTimeout(r,25));}
if(!ready){close();throw Error('Editor document did not finish loading')}
// Tests drive taps on fixed timings, so they run with reduced motion unless LUMA_MOTION=1.
if(process.env.LUMA_MOTION!=='1')await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
if(process.argv[1]?.endsWith('/cdp.mjs')){console.log(JSON.stringify(await evaluate(process.argv[2])));close()}
