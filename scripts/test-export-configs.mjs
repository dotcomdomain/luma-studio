import {evaluate,call,close} from './cdp.mjs';import fs from 'node:fs';import {execFileSync} from 'node:child_process';
const wait=ms=>new Promise(r=>setTimeout(r,ms)),report={ui:{},photos:[],videos:[]};
const check=(v,m)=>{if(!v)throw Error(m)};
const run=(cmd,args,options={})=>execFileSync(cmd,args,{encoding:'utf8',...options});
function save(){fs.writeFileSync('artifacts/export-config-results.json',JSON.stringify(report,null,2));}
async function tap(selector){const p=await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);await call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...p,id:1}]});await call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await wait(350)}
async function completed(){let status;for(let i=0;i<300;i++){await wait(200);status=await evaluate("({busy:exporting,button:$('saveButton').textContent,status:$('exportStatus').textContent})");if(!status.busy)break;}check(!status.busy&&status.button.includes('Saved'),JSON.stringify(status));return status;}
async function capture(name){const r=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync('artifacts/'+name+'.png',Buffer.from(r.result.data,'base64'));}
const stored=await evaluate("({photo:localStorage.getItem('export-settings:photo'),video:localStorage.getItem('export-settings:video')})");
try{
await evaluate("demoPhoto();'photo'");for(let i=0;i<60;i++){await wait(50);if(await evaluate("mediaType==='photo'&&image.complete&&nativeW===image.naturalWidth"))break;}
await evaluate("localStorage.removeItem('export-settings:photo');openExport();'open'");
report.ui.photo=await evaluate("({formats:exportDropdowns.get('exportFormat').options.map(([v])=>v),advanced:document.querySelector('.export-advanced').open,quality:$('exportQuality').value})");check(report.ui.photo.formats.join(',')==='jpg,png,webp'&&!report.ui.photo.advanced,'Photo menu incomplete/cluttered');await capture('export-photo-configs');
await tap('.export-presets .chip:nth-child(3)');check(await evaluate("quality===.75&&exportSize===1280&&exportConfig.preset==='small'"),'Small preset failed');
await evaluate("setExportOption('format','webp');setExportOption('size','custom');setCustomExportSize(512);setPhotoExportQuality(83);closeExport();openExport();'reopened'");check(await evaluate("exportFormat==='webp'&&exportSize===512&&quality===.83"),'Settings not remembered');
for(const settings of [{format:'jpg',quality:.65,size:640},{format:'jpg',quality:.95,size:640},{format:'png',quality:.95,size:640},{format:'webp',quality:.75,size:512}]){
const name='Luma-config-photo-'+Date.now();const started=Date.now();
await evaluate(`exportFormat=${JSON.stringify(settings.format)};quality=${settings.quality};exportSize=${settings.size};exportConfig.name=${JSON.stringify(name)};renderExport();doExport();'started'`);check(await evaluate("$('exportFields').disabled"),'Options editable during save');await completed();
const file=name+'.'+settings.format,artifact='artifacts/'+file;run('adb',['-s','127.0.0.1:5555','pull','/sdcard/Pictures/Luma/'+file,artifact],{stdio:'pipe'});
const probe=JSON.parse(run('ffprobe',['-v','error','-show_entries','stream=codec_name,width,height','-of','json',artifact]));const v=probe.streams[0];check(v.width===settings.size,'Photo dimensions incorrect');check(v.codec_name===(settings.format==='jpg'?'mjpeg':settings.format==='png'?'png':'webp'),'Photo content/format mismatch');
report.photos.push({...settings,file,artifact,elapsedMs:Date.now()-started,bytes:fs.statSync(artifact).size,probe});save();await evaluate("closeExport();openExport();'next'");
}
check(report.photos[0].bytes<report.photos[1].bytes*.9,'JPEG quality setting not reflected in file');
await evaluate("closeExport();window._exportLoaded=false;window._exportLoad=loadMedia;loadMedia=function(...args){window._exportLoaded=true;return window._exportLoad(...args)};Native.demoVideo();'loading'");for(let i=0;i<100;i++){await wait(50);if(await evaluate("window._exportLoaded&&mediaType==='video'&&duration>0&&video.readyState>=2"))break;}await evaluate("loadMedia=window._exportLoad;delete window._exportLoad;localStorage.removeItem('export-settings:video');openExport();'open'");
report.ui.video=await evaluate("({fps:exportDropdowns.get('exportFps').options.map(([v])=>+v),codecs:exportDropdowns.get('exportCodec').options.map(([v])=>v),advanced:document.querySelector('.export-advanced').open})");check(report.ui.video.fps.join(',')==='0,24,25,30,50,60'&&report.ui.video.codecs.join(',')==='h264,hevc'&&!report.ui.video.advanced,'Video options missing');await capture('export-video-configs');
await tap('.export-advanced summary');check(await evaluate("document.querySelector('.export-advanced').open"),'More options does not expand');await capture('export-video-advanced');
await evaluate("setExportOption('rateMode','bitrate');setExportBitrate(1.5);setExportOption('codec','hevc');setExportOption('fps',60);closeExport();openExport();'reopened'");check(await evaluate("exportConfig.rateMode==='bitrate'&&exportConfig.bitrate===1.5&&exportConfig.codec==='hevc'&&exportConfig.fps===60"),'Video options not remembered');
for(const settings of [
{codec:'h264',crf:18,fps:24,encoding:'ultrafast',rateMode:'quality',bitrate:8,audioBitrate:96,channels:1,sampleRate:44100,fastStart:true,speed:1,mute:false,size:640,end:3},
{codec:'hevc',crf:28,fps:30,encoding:'ultrafast',rateMode:'quality',bitrate:8,audioBitrate:192,channels:2,sampleRate:48000,fastStart:true,speed:2,mute:false,size:640,end:5},
{codec:'h264',crf:23,fps:60,encoding:'veryfast',rateMode:'bitrate',bitrate:1,audioBitrate:128,channels:0,sampleRate:0,fastStart:true,speed:1,mute:true,size:640,end:3},
{codec:'h264',crf:23,fps:0,encoding:'fast',rateMode:'quality',bitrate:8,audioBitrate:128,channels:0,sampleRate:0,fastStart:false,speed:1,mute:false,size:320,end:3}
]){
const name='Luma-config-video-'+Date.now(),started=Date.now();
await evaluate(`state={...defaults(),start:1,end:${settings.end},speed:${settings.speed},mute:${settings.mute},vignette:12,drawingLayers:[{id:'a',start:1.5,end:2.5},{id:'b',start:3,end:4}],activeDrawingId:'a',strokes:[{layerId:'a',mode:'pen',color:'#ff0033',width:4,opacity:1,points:[{x:.2,y:.3},{x:.8,y:.3}]},{layerId:'b',mode:'pen',color:'#0033ff',width:4,opacity:1,points:[{x:.2,y:.6},{x:.8,y:.6}]}],texts:[{id:'title',text:'I',x:.5,y:.8,size:15,color:'#ffffff',bold:true,font:'sans-serif',rotation:0,opacity:1}]};normalizeEdits();normalizeTimings();exportConfig={...exportDefaults(),...${JSON.stringify(settings)},name:${JSON.stringify(name)}};exportSize=${settings.size};exportFormat='mp4';renderExport();doExport();'started'`);await completed();
const file=name+'.mp4',artifact='artifacts/'+file;run('adb',['-s','127.0.0.1:5555','pull','/sdcard/Movies/Luma/'+file,artifact],{stdio:'pipe'});
const probe=JSON.parse(run('ffprobe',['-v','error','-show_entries','stream=codec_name,codec_tag_string,width,height,r_frame_rate,channels,sample_rate,bit_rate','-show_entries','format=duration','-of','json',artifact]));const v=probe.streams.find(s=>s.codec_name===settings.codec);check(!!v,'Codec ignored');check(v.width===settings.size,'Video resolution ignored');const [n,d]=v.r_frame_rate.split('/').map(Number);if(settings.fps)check(Math.abs(n/d-settings.fps)<.01,'Frame rate ignored');check(Math.abs(+probe.format.duration-(settings.end-1)/settings.speed)<.08,'Duration mismatch');
const a=probe.streams.find(s=>s.codec_name==='aac');if(settings.mute)check(!a,'Silent export contains audio');else{check(!!a,'Audio missing');if(settings.channels)check(a.channels===settings.channels,'Channel setting ignored');if(settings.sampleRate)check(+a.sample_rate===settings.sampleRate,'Sample rate ignored');}
if(settings.codec==='hevc')check(v.codec_tag_string==='hvc1','HEVC compatibility tag missing');
const bytes=fs.readFileSync(artifact),moov=bytes.indexOf(Buffer.from('moov')),mdat=bytes.indexOf(Buffer.from('mdat'));check(settings.fastStart?moov<mdat:moov>mdat,'Streaming optimization ignored');
const frames=[];if(settings.codec==='hevc')for(const time of [.3,.9,1.2,1.7]){const raw=execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-ss',String(time),'-i',artifact,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{maxBuffer:8*1024*1024});let red=0,blue=0;for(let p=0;p<raw.length;p+=3){if(raw[p]>210&&raw[p+1]<80&&raw[p+2]<130)red++;if(raw[p]<80&&raw[p+1]<130&&raw[p+2]>210)blue++;}check((red>1000)===(time>=.25&&time<.75),'HEVC drawing layer A wrong');check((blue>1000)===(time>=1&&time<1.5),'HEVC drawing layer B wrong');frames.push({time,red,blue});}
report.videos.push({...settings,file,artifact,elapsedMs:Date.now()-started,bytes:bytes.length,probe,frames});save();console.log(JSON.stringify({codec:settings.codec,fps:settings.fps,rateMode:settings.rateMode,elapsedMs:Date.now()-started}));await evaluate("closeExport();openExport();'next'");
}
console.log('All export configurations passed.');
}finally{
await evaluate(`(()=>{const saved=${JSON.stringify(stored)};for(const key of ['photo','video']){if(saved[key]===null)localStorage.removeItem('export-settings:'+key);else localStorage.setItem('export-settings:'+key,saved[key]);}if(!exporting){closeExport();goBack();}return 'restored'})()`);close();
}
