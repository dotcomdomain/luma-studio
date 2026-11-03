import {evaluate,close} from './cdp.mjs';import fs from 'node:fs';import {execFileSync} from 'node:child_process';
const reports=[];
function rms(file,args=[]){const data=execFileSync('ffmpeg',['-hide_banner','-loglevel','error',...args,'-i',file,'-vn','-ac','1','-f','f32le','pipe:1'],{maxBuffer:8*1024*1024});let sum=0;for(let i=0;i<data.length;i+=4){const x=data.readFloatLE(i);sum+=x*x;}return Math.sqrt(sum/(data.length/4));}
try{
 await evaluate(`Native.demoVideo();'loading'`);for(let i=0;i<40;i++){await new Promise(r=>setTimeout(r,100));if(await evaluate(`mediaType==='video'&&duration>0&&video.readyState>=2`))break;}
 await evaluate(`setTimeEndpoint('trim','start',1,{record:true});setTimeEndpoint('trim','end',5,{record:true});setTool('speed');setPlaybackSpeed(2);selectExtraTool('audio');'ready'`);
 for(const level of [0,50]){
  const started=Date.now();await evaluate(`setVolumeLevel(${level});openExport();exportSize=640;renderExport();doExport();'started'`);
  let result;for(let i=0;i<160;i++){await new Promise(r=>setTimeout(r,250));result=await evaluate(`({busy:exporting,button:$('saveButton').textContent,status:$('exportStatus').textContent,volume:state.volume,mute:state.mute,speed:state.speed})`);if(!result.busy)break;}
  if(result.busy||!result.button.includes('Saved'))throw Error(JSON.stringify(result));
  const files=execFileSync('su',['-mm','-c','ls -1 /sdcard/Movies/Luma'],{encoding:'utf8'}).trim().split('\n').filter(n=>/^Luma_\d+\.mp4$/.test(n)&&Number(n.match(/\d+/)[0])>=started);if(files.length!==1)throw Error('Ambiguous fixture');
  const artifact='artifacts/clean-audio-'+level+'.mp4';execFileSync('adb',['-s','127.0.0.1:5555','pull','/sdcard/Movies/Luma/'+files[0],artifact],{stdio:'pipe'});
  const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_entries','stream=codec_name,width,height,duration','-show_entries','format=duration','-of','json',artifact],{encoding:'utf8'}));
  if(Math.abs(Number(probe.format.duration)-2)>.045)throw Error('Speed/trim duration changed');const hasAudio=probe.streams.some(s=>s.codec_name==='aac');if(hasAudio!==(level>0))throw Error('Volume/mute export state wrong');
  const report={level,file:files[0],artifact,elapsedMs:Date.now()-started,result,probe};if(level===50){report.rms=rms(artifact);const reference=rms('app/assets/demo.mp4');report.rmsRatio=report.rms/reference;if(Math.abs(report.rmsRatio-.5)>.05)throw Error('Export gain does not match 50%');}
  reports.push(report);fs.writeFileSync('artifacts/clean-audio-export-results.json',JSON.stringify(reports,null,2));console.log(JSON.stringify({level,duration:probe.format.duration,hasAudio,rmsRatio:report.rmsRatio}));await evaluate(`closeExport();'closed'`);
 }
}finally{close();}
