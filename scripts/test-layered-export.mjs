import {evaluate,close} from './cdp.mjs';import fs from 'node:fs';import {execFileSync} from 'node:child_process';
const wait=ms=>new Promise(r=>setTimeout(r,ms));const reports=[];
try{
await evaluate(`state={...defaults(),end:duration,drawingLayers:[{id:'red',start:1,end:4},{id:'blue',start:3,end:6}],activeDrawingId:'blue',strokes:[{layerId:'red',mode:'pen',color:'#ff0033',width:4,opacity:1,points:[{x:.2,y:.3},{x:.8,y:.3}]},{layerId:'red',mode:'pen',color:'#ff0033',width:4,opacity:1,points:[{x:.2,y:.4},{x:.8,y:.4}]},{layerId:'blue',mode:'pen',color:'#0033ff',width:4,opacity:1,points:[{x:.2,y:.6},{x:.8,y:.6}]},{layerId:'blue',mode:'eraser',color:'#000000',width:8,opacity:1,points:[{x:.2,y:.3},{x:.8,y:.3}]}]};normalizeEdits();normalizeTimings();'fixture'`);
for(const mode of (process.env.LUMA_EXPORT_MODES || 'overlap,outside,full').split(',')){
const started=Date.now();
await evaluate(`state.start=1;state.end=7;state.speed=2;state.mute=true;state.crop={x:.1,y:.1,w:.8,h:.8};state.vignette=12;state.texts=[{id:'static',text:'I',x:.5,y:.7,size:15,color:'#ffffff',bold:true,font:'sans-serif',rotation:0,opacity:1}];state.drawingLayers[0].start=${mode==='overlap'?1:mode==='outside'?0:0};state.drawingLayers[0].end=${mode==='overlap'?4:mode==='outside'?.5:8};state.drawingLayers[1].start=${mode==='overlap'?3:mode==='outside'?7.5:0};state.drawingLayers[1].end=${mode==='overlap'?6:8};normalizeTimings();setTool('looks');openExport();exportSize=640;renderExport();doExport();'started'`);
let status;for(let i=0;i<200;i++){await wait(250);status=await evaluate(`({busy:exporting,button:$('saveButton').textContent,status:$('exportStatus').textContent})`);if(!status.busy)break;}
if(status.busy||!status.button.includes('Saved'))throw Error(mode+': '+JSON.stringify(status));
const names=execFileSync('su',['-mm','-c','ls -1 /sdcard/Movies/Luma'],{encoding:'utf8'}).trim().split('\n').filter(n=>/^Luma_\d+\.mp4$/.test(n)&&Number(n.match(/\d+/)[0])>=started);if(names.length!==1)throw Error('Ambiguous fixture');
const file=names[0],artifact='artifacts/layered-export-'+mode+'.mp4';
execFileSync('adb',['-s','127.0.0.1:5555','pull','/sdcard/Movies/Luma/'+file,artifact],{stdio:'pipe'});
const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_entries','stream=codec_name,width,height','-show_entries','format=duration','-of','json',artifact],{encoding:'utf8'}));
const {width:w,height:h}=probe.streams.find(s=>s.codec_name==='h264'),frames=[];
for(const time of [.25,1.25,2.25,2.75]){
const raw=execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-ss',String(time),'-i',artifact,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{maxBuffer:8*1024*1024});if(raw.length!==w*h*3)throw Error('Frame missing');
let red=0,blue=0;for(let y=0;y<h;y++)for(let x=0;x<w;x++){const p=(y*w+x)*3;if(raw[p]>210&&raw[p+1]<80&&raw[p+2]<130)red++;if(raw[p]<80&&raw[p+1]<130&&raw[p+2]>210)blue++;}
const expectedRed=mode==='full'||mode==='overlap'&&time<1.5,expectedBlue=mode==='full'||mode==='overlap'&&time>=1&&time<2.5;
if(expectedRed?red<1000:red>80)throw Error(`Red interval mismatch ${mode}@${time}: ${red}`);
if(expectedBlue?blue<1000:blue>80)throw Error(`Blue interval mismatch ${mode}@${time}: ${blue}`);
const p=(Math.floor(h*.75)*w+Math.floor(w*.5))*3,white=[...raw.subarray(p,p+3)];if(Math.min(...white)<210)throw Error('Static text missing '+white);
frames.push({time,red,blue,white,expectedRed,expectedBlue});
}
if(Math.abs(Number(probe.format.duration)-3)>.045)throw Error('Trim/speed duration mismatch');
reports.push({mode,file,artifact,elapsedMs:Date.now()-started,probe,frames});fs.writeFileSync(process.env.LUMA_EXPORT_REPORT || 'artifacts/layered-export-results.json',JSON.stringify(reports,null,2));console.log(JSON.stringify(reports.at(-1)));
await evaluate("closeExport();'closed'");
}
}finally{close()}
