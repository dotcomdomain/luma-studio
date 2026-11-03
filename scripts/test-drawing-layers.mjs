import {evaluate,call,close} from './cdp.mjs';
import fs from 'node:fs';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const check=(x,m)=>{if(!x)throw Error(m)};
const report={};
async function stroke(y){const b=await evaluate("(()=>{const r=$('gestureLayer').getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height}})()");await call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:b.x+b.w*.2,y:b.y+b.h*y,id:1}]});for(let i=1;i<=6;i++)await call('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:b.x+b.w*(.2+i*.08),y:b.y+b.h*y,id:1}]});await call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await wait(100)}
try {
report.migration=await evaluate(`(()=>{state={...defaults(),end:duration,drawingStart:2,drawingEnd:4,strokes:[{mode:'pen',width:2,opacity:1,color:'#ff0000',points:[{x:.2,y:.3},{x:.8,y:.3}]}]};normalizeEdits();return {count:state.drawingLayers.length,start:selectedDrawing().start,end:selectedDrawing().end,assigned:state.strokes[0].layerId===selectedDrawing().id}})()`);
check(report.migration.count===1&&report.migration.start===2&&report.migration.end===4&&report.migration.assigned,'Legacy drawing lost');
await evaluate("state={...defaults(),end:duration};history=[];future=[];normalizeEdits();setTool('draw');'ready'");
check(await evaluate("$('toolContent').textContent.trim()==='Add layer'&&!$('gestureLayer').classList.contains('interactive')&&state.drawingLayers.length===0"),'Empty Draw tab not clear');
await stroke(.3);check(await evaluate('state.strokes.length===0&&state.drawingLayers.length===0'),'Preview created a layer automatically');
const add=await evaluate("(()=>{const r=document.querySelector('.add-layer-button').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()");
await call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...add,id:1}]});await call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await wait(350);
check(await evaluate("state.drawingLayers.length===1&&!!$('toolContent').querySelector('.brush-row')&&$('gestureLayer').classList.contains('interactive')"),'Add layer did not enable drawing');
await stroke(.3);await stroke(.4);
report.strokes=await evaluate("({layers:state.drawingLayers.length,strokes:state.strokes.length,ids:[...new Set(state.strokes.map(s=>s.layerId))]})");check(report.strokes.layers===1&&report.strokes.strokes===2&&report.strokes.ids.length===1,'Strokes not grouped');
await evaluate("addDrawingLayer();'added'");await stroke(.6);
check(await evaluate("state.drawingLayers.length===2&&state.strokes.filter(s=>s.layerId===selectedDrawing().id).length===1"),'Second layer failed');
await evaluate("setTimeEndpoint('drawing','start',3,{record:true});setTimeEndpoint('drawing','end',6,{record:true});persist();selectDrawing(state.drawingLayers[0].id);setTimeEndpoint('drawing','start',1,{record:true});setTimeEndpoint('drawing','end',4,{record:true});persist();'timed'");
report.intervals=await evaluate("state.drawingLayers.map(l=>({start:l.start,end:l.end}))");check(report.intervals[0].start===1&&report.intervals[0].end===4&&report.intervals[1].start===3&&report.intervals[1].end===6,'Timing shared');
await evaluate("clearDrawing();'clear'");check(await evaluate("state.strokes.length===1&&state.strokes[0].layerId===state.drawingLayers[1].id"),'Clear affected another layer');await evaluate("undo();deleteDrawingLayer();'delete'");check(await evaluate("state.drawingLayers.length===1&&state.strokes.length===1"),'Delete affected other layer');await evaluate("undo();redo();undo();'restored'");check(await evaluate("state.drawingLayers.length===2&&state.strokes.length===3"),'Layer undo failed');
report.reload=await evaluate(`(()=>{persist();const key='project:'+mediaPath;const saved=JSON.parse(localStorage.getItem(key));state={...defaults(),...saved};normalizeEdits();normalizeTimings();setTool('draw');return {layers:state.drawingLayers.length,strokes:state.strokes.length,start:selectedDrawing().start,end:selectedDrawing().end}})()`);check(report.reload.layers===2&&report.reload.strokes===3&&report.reload.start===1&&report.reload.end===4,'Persistence failed');
await evaluate(`(()=>{state={...defaults(),end:duration,drawingLayers:[{id:'red',start:1,end:4},{id:'blue',start:3,end:6}],activeDrawingId:'blue',strokes:[{layerId:'red',mode:'pen',color:'#ff0033',width:4,opacity:1,points:[{x:.2,y:.3},{x:.8,y:.3}]},{layerId:'red',mode:'pen',color:'#ff0033',width:4,opacity:1,points:[{x:.2,y:.4},{x:.8,y:.4}]},{layerId:'blue',mode:'pen',color:'#0033ff',width:4,opacity:1,points:[{x:.2,y:.6},{x:.8,y:.6}]},{layerId:'blue',mode:'eraser',color:'#000000',width:8,opacity:1,points:[{x:.2,y:.3},{x:.8,y:.3}]}]};normalizeEdits();normalizeTimings();setTool('draw');})()`);
report.visibility=[];
for(const time of [.5,2,3.5,5,7]){
await evaluate(`scrubTo(${time});'seek'`);for(let i=0;i<50;i++){await wait(20);if(await evaluate('!video.seeking'))break;}
const p=await evaluate(`(()=>{const c=document.createElement('canvas');c.width=640;c.height=426;renderStrokesDirect(c.getContext('2d'),state);const pixel=y=>[...c.getContext('2d').getImageData(320,Math.round(426*y),1,1).data];return {time:video.currentTime,red:pixel(.3),red2:pixel(.4),blue:pixel(.6)}})()`);
const red=time>=1&&time<4,blue=time>=3&&time<6;
check((p.red[3]>200)===red&&(p.red2[3]>200)===red&&(p.blue[3]>200)===blue,'Visibility/eraser mismatch '+JSON.stringify(p));report.visibility.push(p);
}
report.performance=await evaluate(`(()=>{video.currentTime=3.5;const c=document.createElement('canvas');c.width=640;c.height=426;const ctx=c.getContext('2d'),times=[];for(let i=0;i<90;i++){ctx.clearRect(0,0,640,426);const t=performance.now();renderStrokesDirect(ctx,state);times.push(performance.now()-t)}times.sort((a,b)=>a-b);return {medianMs:times[45],p95Ms:times[85]}})()`);
fs.writeFileSync('artifacts/drawing-layers-ui-results.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{close()}
