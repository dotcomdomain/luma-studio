import {evaluate,close} from './cdp.mjs';import fs from 'node:fs';import {execFileSync} from 'node:child_process';
const mode=process.argv[2]||'photo',started=Date.now();
try{
 if(mode==='video'){
  await evaluate(`Native.demoVideo();'loading'`);for(let i=0;i<40;i++){await new Promise(r=>setTimeout(r,100));if(await evaluate(`mediaType==='video'&&video.readyState>=2`))break;}
  await evaluate(`state={...defaults(),crop:{x:.17,y:.12,w:.61,h:.68},rotation:90,flipY:true,start:1,end:4,speed:1.5,look:'Golden',vignette:20,texts:[{id:'video-title',text:'VIDEO',x:.47,y:.36,size:5,color:'#ffffff',bold:true,font:'sans-serif',rotation:-12,opacity:1,outline:true}],activeTextId:'video-title',strokes:[{mode:'pen',color:'#ff2244',width:1.5,opacity:1,points:[{x:.25,y:.45},{x:.7,y:.45}]}]};normalizeEdits();setTool('text');draw();openExport();exportSize=1280;renderExport();doExport();'started'`);
 }else await evaluate(`openExport();exportFormat='png';exportSize=0;renderExport();doExport();'started'`);
 let result;
 for(let i=0;i<160;i++){await new Promise(r=>setTimeout(r,250));result=await evaluate(`({busy:exporting,status:$('exportStatus').textContent,button:$('saveButton').textContent,geometry:geometry(state)})`);if(!result.busy)break;}
 if(result.busy||!result.button.includes('Saved'))throw Error(JSON.stringify(result));
 const directory=mode==='video'?'/sdcard/Movies/Luma':'/sdcard/Pictures/Luma',listing=execFileSync('su',['-mm','-c','ls -1 '+directory],{encoding:'utf8'}).trim().split('\n');
 const files=listing.filter(n=>/^Luma_\d+\.(png|mp4)$/.test(n)&&Number(n.match(/\d+/)[0])>=started);if(files.length!==1)throw Error('Cannot identify fixture: '+files.join(','));
 const artifact='artifacts/advanced-'+mode+(mode==='video'?'.mp4':'.png');execFileSync('adb',['-s','127.0.0.1:5555','pull',directory+'/'+files[0],artifact],{stdio:'pipe'});
 const report={mode,elapsedMs:Date.now()-started,file:files[0],artifact,...result};fs.writeFileSync('artifacts/advanced-'+mode+'-export.json',JSON.stringify(report,null,2));console.log(report);
}finally{close();}
