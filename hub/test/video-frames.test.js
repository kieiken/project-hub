'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), os=require('node:os'), path=require('node:path');
const {videoFrames,FRAME_COUNT,frameCount,selectTimes,sceneTimes}=require('../lib/video-frames');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hub-video-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
const probe={format:{duration:'8'},streams:[{index:0,codec_type:'audio'},{index:1,codec_type:'video',width:1080,height:1920}]};
function executor(calls,metadata=probe,stderr='') { return async(cmd,args,options)=>{
 calls.push({cmd,args,options});if(cmd.endsWith('ffprobe'))return {stdout:JSON.stringify(metadata)};
 if(args.some(a=>a.includes('mpdecimate=')))return {stderr:'pts_time:0 s:640x126'};
 if(args.at(-1)==='-')return {stderr};fs.writeFileSync(args.at(-1),'frame');return {stdout:''};
}; }
test('missing transcriber: original eight-frame fallback, local bounded commands and truthful manifest',async t=>{
 const dir=fixture(t),calls=[];
 const result=await videoFrames('/fixture/phone.mov',dir,{find:n=>'/local/'+n,checkTranscriber:async()=>({status:'unavailable'}),execute:executor(calls)});
 assert.equal(result.frames.length,FRAME_COUNT);assert.deepEqual(result.frames.map(x=>x.seconds),[0,1,2,3,4,5,6,7]);
 assert.match(fs.readFileSync(result.manifest,'utf8'),/\[00:07\] 7.000s:.*frame-08.jpg/);assert.match(result.message,/道具が未導入/);
 assert.equal(result.transcript.status,'unavailable');assert.equal(fs.existsSync(path.join(dir,'transcript.txt')),false);
 for(const {args,options}of calls){assert.equal(args[args.indexOf('-protocol_whitelist')+1],'file');assert.equal(args[args.indexOf('-format_whitelist')+1],'mov,matroska,webm');assert.ok(options.timeout<=45000);assert.equal(options.killSignal,'SIGKILL');assert.equal(options.shell,undefined);}
 for(const {args}of calls.slice(1)){assert.equal(args[args.indexOf('-map')+1],'0:1');assert.ok(args.includes('-an'));}
});
test('adaptive frames: short/long clips, scene priority, full-clip anchors and sixteen-frame maximum',async t=>{
 assert.equal(frameCount(2),4);assert.ok(frameCount(100)>frameCount(2));assert.equal(frameCount(600),16);
 const times=selectTimes(120,11,[9,21,35,61,81,92,110]);assert.equal(times.length,11);assert.equal(times[0],0);assert.ok(times.at(-1)>100);assert.ok(times.includes(61));assert.equal(new Set(times).size,11);
 assert.deepEqual(sceneTimes('n:1 pts_time:2.5 n:2 pts_time:8 pts_time:99',10),[2.5,8]);
 const dir=fixture(t),calls=[],metadata={...probe,streams:[probe.streams[1]]};
 const video=await videoFrames('a.mov',dir,{find:n=>n,execute:executor(calls,metadata,'n:1 pts_time:2.5'),checkTranscriber:async()=>{throw Error('silent clip must not load model');}});
 assert.equal(video.frames.length,4);assert.ok(video.frames.some(f=>f.seconds===2.5));assert.match(video.message,/音声トラックがありません/);
 assert.ok(calls.some(c=>c.args.includes('null')));
});
test('long video extracts sixteen frames with at most half selected from scene cuts',async t=>{
 const dir=fixture(t),calls=[],metadata={format:{duration:'600'},streams:[probe.streams[1]]};
 const cuts=Array.from({length:40},(_,i)=>(i+1)*14+0.25);
 const video=await videoFrames('long.mov',dir,{find:n=>n,execute:executor(calls,metadata,cuts.map(n=>'pts_time:'+n).join(' '))});
 assert.equal(video.frames.length,16);assert.equal(video.frames.filter(f=>cuts.includes(f.seconds)).length,8);
 assert.equal(video.frames[0].seconds,0);assert.ok(video.frames.at(-1).seconds>500);
 assert.equal(calls.filter(c=>c.args.includes('-frames:v')).length,16);assert.match(video.message,/16枚/);
});
test('scene detector failure and transcription failure preserve usable frames and report the limit',async t=>{
 const dir=fixture(t),calls=[],execute=executor(calls);
 const video=await videoFrames('a.mov',dir,{find:n=>n,checkTranscriber:async()=>({status:'ready'}),transcribe:async()=>({status:'timeout'}),execute:async(...args)=>{if(args[1].at(-1)==='-')throw Error('scene deadline');return execute(...args);}});
 assert.deepEqual(video.frames.map(f=>f.seconds),[0,2,4,6]);assert.match(video.message,/この環境の制限時間内に終わらなかった/);assert.equal(video.transcript.path,undefined);
});
test('successful transcription is linked from manifest beside frame timestamps',async t=>{
 const dir=fixture(t),calls=[],transcript=path.join(dir,'transcript.txt');
 const video=await videoFrames('a.mov',dir,{find:n=>n,checkTranscriber:async()=>({status:'ready'}),execute:executor(calls),transcribe:async(file,out,options)=>{
  assert.equal(options.audioIndex,0);assert.equal(options.duration,8);fs.writeFileSync(transcript,'[00:02] こんにちは\n');return {status:'done',path:transcript};
 }});
 assert.equal(video.transcript.path,transcript);assert.match(fs.readFileSync(video.manifest,'utf8'),/時刻付き文字起こし:.*transcript.txt/);assert.match(video.message,/自動認識/);
});
test('local video: missing tools, invalid metadata, long clips and failed extraction never report success',async t=>{
 const dir=fixture(t);
 await assert.rejects(videoFrames('a.mov',dir,{find:()=>null}),/追加インストールはしていません/);
 for(const metadata of [{},{...probe,format:{duration:'NaN'}},{...probe,format:{duration:'601'}},{...probe,streams:[{index:0,codec_type:'video',width:100000,height:100000}]}]){
  let calls=0;await assert.rejects(videoFrames('a.mov',dir,{find:n=>n,execute:async()=>{calls++;return {stdout:JSON.stringify(metadata)};}}));assert.equal(calls,1);
 }
 await assert.rejects(videoFrames('a.mov',dir,{find:n=>n,checkTranscriber:async()=>({status:'unavailable'}),execute:async cmd=>{if(cmd==='ffprobe')return {stdout:JSON.stringify(probe)};throw Error('decode');}}),/場面を取り出せません/);
});

const {videoSubtitles,subtitleMessage,chooseStrips,SUBTITLE_TIMEOUT}=require('../lib/video-subtitles');
const subtitleOptions={ffmpeg:'ffmpeg',input:['-protocol_whitelist','file','-format_whitelist','mov,matroska,webm'],videoIndex:0,duration:600};
function subtitleExecutor(times,{height=126,calls=[],after=()=>{}}={}) {
 return async(cmd,args,options)=>{
  calls.push({cmd,args,options});
  if(args.at(-1)==='-')return {stderr:times.map(s=>'pts_time:'+s+' s:640x'+height).join('\n')};
  fs.writeFileSync(args.at(-1),'image');await after(args);return {stdout:''};
 };
}
test('subtitle strips retain chronological endpoints when sampled and fit within 1600px',async t=>{
 const dir=fixture(t),calls=[],times=Array.from({length:100},(_,i)=>i*0.25);
 const result=await videoSubtitles('a.mov',dir,{...subtitleOptions,execute:subtitleExecutor(times,{calls})});
 assert.equal(result.status,'done');assert.equal(result.times.length,24);assert.equal(result.total,100);assert.equal(result.partial,true);
 assert.equal(result.times[0],0);assert.equal(result.times.at(-1),24.75);assert.deepEqual(result.times,chooseStrips(times,24));
 assert.ok(result.width<=1600 && result.height<=1600);assert.match(subtitleMessage(result),/字幕帯は一部のみ/);
 assert.deepEqual(fs.readdirSync(dir),['subtitles.jpg']);
 for(const c of calls){assert.equal(c.options.killSignal,'SIGKILL');assert.ok(c.options.timeout<=SUBTITLE_TIMEOUT);assert.equal(c.options.shell,undefined);assert.equal(c.args[c.args.indexOf('-protocol_whitelist')+1],'file');if(c.args.at(-1)!=='-')assert.ok(c.args.includes('-n'));}
 const tallDir=fixture(t),tall=await videoSubtitles('a.mov',tallDir,{...subtitleOptions,execute:subtitleExecutor(times,{height:398})});
 assert.equal(tall.times.length,8);assert.equal(tall.partial,true);assert.ok(tall.height<=1600);
});
test('unchanged subtitle region does not create a sheet',async t=>{
 const dir=fixture(t),result=await videoSubtitles('a.mov',dir,{...subtitleOptions,execute:subtitleExecutor([0])});
 assert.equal(result.status,'absent');assert.match(subtitleMessage(result),/字幕の変化は見つかりませんでした/);assert.deepEqual(fs.readdirSync(dir),[]);
});
test('subtitle failures/timeouts/oversize output clean temporary strips and never overwrite an existing sheet',async t=>{
 for(const mode of ['failed','timeout','oversize','existing']){
  const dir=fixture(t);if(mode==='existing')fs.writeFileSync(path.join(dir,'subtitles.jpg'),'preserve');
  const execute=subtitleExecutor([0,0.75],{after:args=>{
   if(mode==='oversize' && args.at(-1).endsWith('combined.jpg'))fs.truncateSync(args.at(-1),4*1024*1024+1);
   if(mode==='failed'||mode==='timeout')throw Object.assign(Error('fixture'),mode==='timeout'?{killed:true}:{});
  }});
  const result=await videoSubtitles('a.mov',dir,{...subtitleOptions,execute});
  assert.equal(result.status,mode==='timeout'?'timeout':'failed');assert.deepEqual(fs.readdirSync(dir),mode==='existing'?['subtitles.jpg']:[]);
  if(mode==='existing')assert.equal(fs.readFileSync(path.join(dir,'subtitles.jpg'),'utf8'),'preserve');
 }
 const dir=fixture(t);let now=100000;const original=Date.now;Date.now=()=>now;
 try{
  const result=await videoSubtitles('a.mov',dir,{...subtitleOptions,execute:subtitleExecutor([0,0.75],{after:()=>{now+=SUBTITLE_TIMEOUT+1;}})});
  assert.equal(result.status,'timeout');assert.deepEqual(fs.readdirSync(dir),[]);
 }finally{Date.now=original;}
});
test('subtitle sheet fits inside video budget and manifest maps row-major strips to audio/frame timestamps',async t=>{
 for(const fallback of [false,true]){
  const dir=fixture(t),metadata={...probe,format:{duration:'600'}},calls=[];
  const video=await videoFrames('a.mov',dir,{find:n=>n,execute:executor(calls,metadata),checkTranscriber:async()=>({status:fallback?'unavailable':'ready'}),transcribe:async()=>({status:fallback?'unavailable':'done'}),subtitles:async()=>{
   const output=path.join(dir,'subtitles.jpg');fs.writeFileSync(output,'sheet');return {status:'done',path:output,times:[0,0.75,2.25],partial:false};
  }});
  assert.equal(video.frames.length,fallback?8:15);assert.equal(video.frames.length+1,fallback?9:16);
  const manifest=fs.readFileSync(video.manifest,'utf8');assert.match(manifest,/字幕帯 1本目＝\[00:00\] \(0.000s\)/);assert.match(manifest,/字幕帯 2本目＝\[00:00\] \(0.750s\)/);assert.match(manifest,/字幕帯 3本目＝\[00:02\]/);assert.match(manifest,/左上から右へ、次の行/);assert.ok(manifest.includes(video.subtitleSheet.path));
 }
});
test('subtitle failure or timeout preserves normal frames and transcription with a truthful reason',async t=>{
 for(const status of ['failed','timeout']){
  const dir=fixture(t),video=await videoFrames('a.mov',dir,{find:n=>n,execute:executor([]),checkTranscriber:async()=>({status:'ready'}),transcribe:async()=>({status:'done'}),subtitles:async()=>({status})});
  assert.equal(video.frames.length,4);assert.equal(video.transcript.status,'done');assert.equal(video.subtitleSheet.path,undefined);assert.match(video.message,status==='timeout'?/字幕帯画像は20秒以内/:/字幕帯画像の作成に失敗/);
 }
});

test('real burned-in subtitles: short lines survive 4fps sampling, unchanged video has no sheet, and pixels stay readable',async t=>{
 const {execFileSync}=require('node:child_process'),platform=require('../lib/platform'),search=[process.env.PATH,'/opt/homebrew/bin','/usr/local/bin'].join(path.delimiter);
 const ffmpeg=platform.findExecutable('ffmpeg',search),ffprobe=platform.findExecutable('ffprobe',search);
 if(!ffmpeg||!ffprobe)return t.skip('local ffmpeg unavailable');
 const dir=fixture(t),source=path.join(dir,'subtitled.mp4'),starts=[0,...Array.from({length:19},(_,i)=>0.7+i*1.4)];
 // Tiny bitmap letters avoid depending on FFmpeg drawtext or installed fonts.
 const glyphs={L:['10000','10000','10000','10000','10000','10000','11111'],I:['11111','00100','00100','00100','00100','00100','11111'],N:['10001','11001','11001','10101','10011','10011','10001'],E:['11111','10000','10000','11110','10000','10000','11111'],0:['01110','10001','10011','10101','11001','10001','01110'],1:['00100','01100','00100','00100','00100','00100','01110'],2:['01110','10001','00001','00010','00100','01000','11111'],3:['11110','00001','00001','01110','00001','00001','11110'],4:['00010','00110','01010','10010','11111','00010','00010'],5:['11111','10000','10000','11110','00001','00001','11110'],6:['01110','10000','10000','11110','10001','10001','01110'],7:['11111','00001','00010','00100','01000','01000','01000'],8:['01110','10001','10001','01110','10001','10001','01110'],9:['01110','10001','10001','01111','00001','00001','01110']};
 const sequence=[];
 for(let i=0;i<20;i++){
  const pixels=Buffer.alloc(640*360*3),text='LINE '+String(i+1).padStart(2,'0');
  for(const [c,ch]of [...text].entries())for(const [y,row]of (glyphs[ch]||[]).entries())for(const [x,bit]of [...row].entries())if(bit==='1')for(let dy=0;dy<5;dy++)for(let dx=0;dx<5;dx++){
   const offset=((290+y*5+dy)*640+210+c*30+x*5+dx)*3;pixels.fill(255,offset,offset+3);
  }
  const file=path.join(dir,'line-'+i+'.ppm');fs.writeFileSync(file,Buffer.concat([Buffer.from('P6\n640 360\n255\n'),pixels]));
  sequence.push("file '"+file+"'\nduration "+((starts[i+1]??28)-starts[i]).toFixed(3));
 }
 sequence.push("file '"+path.join(dir,'line-19.ppm')+"'");const list=path.join(dir,'sequence.txt');fs.writeFileSync(list,sequence.join('\n')+'\n');
 execFileSync(ffmpeg,['-nostdin','-v','error','-f','concat','-safe','0','-i',list,'-r','20','-c:v','libx264','-pix_fmt','yuv420p','-threads','1',source],{timeout:20000});
 const out=path.join(dir,'frames');fs.mkdirSync(out);
 const video=await videoFrames(source,out,{find:n=>n==='ffmpeg'?ffmpeg:ffprobe}),sheet=video.subtitleSheet;
 if(sheet.path && process.env.HUB_SUBTITLE_PREVIEW==='1')fs.copyFileSync(sheet.path,path.join(fs.realpathSync(os.tmpdir()),'hub-subtitle-preview.jpg'));
 assert.equal(sheet.status,'done',JSON.stringify(sheet));assert.equal(sheet.partial,false);assert.equal(sheet.times.length,20,JSON.stringify(sheet.times));assert.ok(sheet.times.includes(0.75),'the initial 0.75s line and its replacement survive');
 assert.ok(sheet.times.every((s,i)=>Math.abs(s-starts[i])<=0.25));assert.ok(sheet.width<=1600 && sheet.height<=1600);
 const info=JSON.parse(execFileSync(ffprobe,['-v','error','-show_entries','stream=width,height','-of','json',sheet.path],{encoding:'utf8',timeout:5000}));
 assert.equal(info.streams[0].width,sheet.width);assert.equal(info.streams[0].height,sheet.height);
 assert.equal(fs.readdirSync(out).some(n=>n.startsWith('.subtitle-')),false);
 const still=path.join(dir,'still.mp4');execFileSync(ffmpeg,['-nostdin','-v','error','-f','lavfi','-i','color=c=black:size=1280x720:rate=4:duration=2','-c:v','libx264','-threads','1',still],{timeout:10000});
 const absentDir=path.join(dir,'absent');fs.mkdirSync(absentDir);
 const absent=await videoFrames(still,absentDir,{find:n=>n==='ffmpeg'?ffmpeg:ffprobe});assert.equal(absent.subtitleSheet.status,'absent');assert.equal(fs.existsSync(path.join(absentDir,'subtitles.jpg')),false);assert.match(absent.message,/字幕の変化は見つかりませんでした/);
});
