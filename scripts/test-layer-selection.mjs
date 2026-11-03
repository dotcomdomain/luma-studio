import {evaluate,call,close} from './cdp.mjs';import fs from 'node:fs';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
try{
await evaluate("Native.demoVideo();'loading'");for(let i=0;i<80;i++){await wait(50);if(await evaluate("mediaType==='video'&&duration>0&&video.readyState>=2"))break;}
await evaluate(`state={...defaults(),end:duration,drawingLayers:[{id:'red',start:1,end:4},{id:'blue',start:3,end:6}],activeDrawingId:'blue',strokes:[{layerId:'red',mode:'pen',color:'#ff0033',width:4,opacity:1,points:[{x:.2,y:.3},{x:.8,y:.3}]},{layerId:'blue',mode:'pen',color:'#0033ff',width:4,opacity:1,points:[{x:.2,y:.6},{x:.8,y:.6}]}]};normalizeEdits();setTool('draw');drawingTimingOpen=false;toggleDrawingTiming();'timing'`);await wait(250);
const context=await evaluate(`(()=>{const area=document.querySelector('.tool-area').getBoundingClientRect(),row=document.querySelector('.drawing-layer-row').getBoundingClientRect(),toggle=document.querySelector('.drawing-timing-toggle').getBoundingClientRect();return {areaTop:area.top,rowTop:row.top,rowBottom:row.bottom,toggleTop:toggle.top}})()`);
if(context.rowTop<context.areaTop-.1||context.toggleTop<context.rowBottom-1)throw Error(JSON.stringify(context));
const p=await evaluate(`(()=>{const r=document.querySelector('.drawing-layer-row .chip').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
await call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...p,id:1}]});await call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await wait(350);
const selection=await evaluate(`({id:state.activeDrawingId,range:timeRange('drawing'),start:document.querySelector('[data-time-scope=drawing][data-time-field=start]').value,end:document.querySelector('[data-time-scope=drawing][data-time-field=end]').value})`);
if(selection.id!=='red'||+selection.start!==1||+selection.end!==4)throw Error(JSON.stringify(selection));
let old=fs.statSync('artifacts/display.png').mtimeMs;fs.writeFileSync('artifacts/capture.request','');await evaluate('draw()');for(let i=0;i<50;i++){await wait(50);if(fs.statSync('artifacts/display.png').mtimeMs>old){const bytes=fs.readFileSync('artifacts/display.png');if(bytes.subarray(-8).toString('hex')==='49454e44ae426082'){fs.writeFileSync('artifacts/drawing-layer-timing.png',bytes);break}}}
console.log('Layer selector stays visible; touch selection switches timing fields.');
await evaluate("demoPhoto();'photo'");for(let i=0;i<50;i++){await wait(50);if(await evaluate("mediaType==='photo'&&image.complete&&image.naturalWidth>0&&nativeW===image.naturalWidth"))break;}
const photo=await evaluate(`(()=>{state.drawingLayers=[{id:'a',start:100,end:101},{id:'b',start:200,end:201}];state.strokes=[{layerId:'a',mode:'pen',color:'#ff0000',width:5,opacity:1,points:[{x:.2,y:.3},{x:.8,y:.3}]},{layerId:'b',mode:'pen',color:'#0000ff',width:5,opacity:1,points:[{x:.2,y:.6},{x:.8,y:.6}]}];strokeRevision++;const c=document.createElement('canvas');c.width=640;c.height=426;renderStrokesDirect(c.getContext('2d'),state);return [.3,.6].map(y=>[...c.getContext('2d').getImageData(320,Math.round(426*y),1,1).data])})()`);
if(photo.some(p=>p[3]!==255))throw Error('Photo layers hidden by video timing');console.log('Photo layers visible regardless of video intervals.');
fs.writeFileSync('artifacts/drawing-layer-selection-results.json',JSON.stringify({context,selection,photo},null,2));await evaluate("goBack();'home'");
}finally{close()}
