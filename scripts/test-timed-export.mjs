import {evaluate,close} from './cdp.mjs';import fs from 'node:fs';import {execFileSync} from 'node:child_process';
const reports=[];
try{
 for(const mode of ['partial','outside','full','ink-only','none']){
  const from=mode==='outside'?0:mode==='full'?0:2,to=mode==='outside'?.5:mode==='full'?null:4,ink=!['none'].includes(mode),text=!['ink-only','none'].includes(mode),vignette=!['ink-only','none'].includes(mode)?12:0,started=Date.now();
  await evaluate(`state={...defaults(),start:1,end:7,speed:2,mute:${mode!=='partial'},vignette:${vignette},drawingStart:${from},drawingEnd:${to},texts:${text?"[{id:'static-text',text:'I',x:.5,y:.55,size:15,color:'#ffffff',bold:true,font:'sans-serif',rotation:0,opacity:1}]":"[]"},strokes:${ink?"[{mode:'pen',color:'#ff0033',width:3,opacity:1,points:[{x:.2,y:.55},{x:.8,y:.55}]}]":"[]"}};normalizeEdits();normalizeTimings();video.muted=true;setTool('looks');openExport();exportSize=640;renderExport();doExport();'started'`);
  let status;for(let i=0;i<160;i++){await new Promise(r=>setTimeout(r,250));status=await evaluate(`({busy:exporting,button:$('saveButton').textContent,status:$('exportStatus').textContent})`);if(!status.busy)break;}
  if(status.busy||!status.button.includes('Saved'))throw Error(mode+': '+JSON.stringify(status));
  const names=execFileSync('su',['-mm','-c','ls -1 /sdcard/Movies/Luma'],{encoding:'utf8'}).trim().split('\n').filter(n=>/^Luma_\d+\.mp4$/.test(n)&&Number(n.match(/\d+/)[0])>=started);if(names.length!==1)throw Error('Ambiguous fixture '+names.join(','));
  const artifact='artifacts/timing-export-'+mode+'.mp4';execFileSync('adb',['-s','127.0.0.1:5555','pull','/sdcard/Movies/Luma/'+names[0],artifact],{stdio:'pipe'});
  const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_entries','stream=codec_name,width,height,duration','-show_entries','format=duration','-of','json',artifact],{encoding:'utf8'}));
  const stream=probe.streams.find(s=>s.codec_name==='h264'),w=stream.width,h=stream.height,frames=[];
  for(const time of [.25,.75,1.75,2.96]){
   const raw=execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-ss',String(time),'-i',artifact,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{maxBuffer:8*1024*1024});
   if(raw.length!==w*h*3)throw Error('Frame missing '+mode+'@'+time);
   let red=0;for(let y=Math.floor(h*.55)-3;y<Math.floor(h*.55)+3;y++)for(let x=0;x<w;x++){let p=(y*w+x)*3;if(raw[p]>210&&raw[p+1]<80&&raw[p+2]<130)red++;}
   let center=(Math.floor(h*.55)*w+Math.floor(w*.5))*3,pixel=[...raw.subarray(center,center+3)];
   const expected=mode==='full'||(['partial','ink-only'].includes(mode)&&time>=.5&&time<1.5);
   if(expected?red<300:red>60)throw Error(`Drawing interval mismatch ${mode}@${time}: ${red}`);
   if(text&&Math.min(...pixel)<210)throw Error(`Text not above drawing at ${mode}@${time}: ${pixel}`);
   frames.push({time,redPixels:red,textCenter:pixel,drawingExpected:expected});
  }
  if(Math.abs(Number(probe.format.duration)-3)>.045)throw Error('Wrong trim/speed duration');
  if(mode==='partial'&&!probe.streams.some(s=>s.codec_name==='aac'))throw Error('Audio not preserved');
  const report={mode,file:names[0],artifact,elapsedMs:Date.now()-started,probe,frames};reports.push(report);fs.writeFileSync('artifacts/timed-export-results.json',JSON.stringify(reports,null,2));console.log(JSON.stringify({mode,file:names[0],elapsedMs:report.elapsedMs,duration:probe.format.duration,frames}));
  await evaluate(`closeExport();'closed'`);
 }
}finally{close();}
