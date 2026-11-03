import {evaluate,call,close} from './cdp.mjs';import fs from 'node:fs';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
try{
await call('Emulation.setFocusEmulationEnabled',{enabled:true});
await evaluate("(()=>{const c=document.createElement('canvas');c.width=4000;c.height=3000;const x=c.getContext('2d');x.fillStyle='#336699';x.fillRect(0,0,4000,3000);x.clearRect(3999,2999,1,1);window._profileAlpha=c.toDataURL('image/png');loadMedia(window._profileAlpha,'photo','Alpha profile.png')})();'loading'");
for(let i=0;i<200;i++){await wait(30);if(await evaluate('nativeW===4000&&photoHasTransparency!==null'))break;}
await evaluate("window._alphaProfile={done:false,started:performance.now()};probePhotoTransparency(image,mediaLoadSequence).then(alpha=>Object.assign(window._alphaProfile,{done:true,alpha,elapsedMs:performance.now()-window._alphaProfile.started}));'started'");
const latencies=[];let result;for(let i=0;i<300;i++){const t=performance.now();result=await evaluate('({...window._alphaProfile,visibility:document.visibilityState})');latencies.push(performance.now()-t);if(result.done)break;await wait(10)}
if(!result.done||!result.alpha)throw Error('Full-resolution transparency scan failed');latencies.sort((a,b)=>a-b);result={width:4000,height:3000,...result,polls:latencies.length,medianMainThreadRoundTripMs:latencies[Math.floor(latencies.length/2)],maxMainThreadRoundTripMs:latencies.at(-1)};fs.writeFileSync('artifacts/photo-alpha-worker-profile.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
await evaluate("delete window._profileAlpha;goBack();'home'");await call('Emulation.setFocusEmulationEnabled',{enabled:false});
}finally{close()}
