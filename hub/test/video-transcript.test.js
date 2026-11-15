'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFile,execFileSync}=require('node:child_process'),{promisify}=require('node:util');
const {videoTranscript,transcriber,AUDIO_TIMEOUT,MLX_AUDIO_TIMEOUT,audioMessage}=require('../lib/video-transcript');
const {videoFrames}=require('../lib/video-frames');
const run=promisify(execFile);
function fixture(t){const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-transcript-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
const defaults={ffmpeg:'ffmpeg',input:['-protocol_whitelist','file','-format_whitelist','mov,matroska,webm'],audioIndex:1,duration:120,engine:{status:'ready',python:'python'}};
function execute(data,calls=[]) {return async(cmd,args,options)=>{
 calls.push({cmd,args,options});if(cmd==='ffmpeg'){fs.writeFileSync(args.at(-1),Buffer.alloc(100));return {stdout:''};}
 return {stdout:JSON.stringify(data)};
};}
test('timestamps, offline CPU worker request and deletion of temporary audio',async t=>{
 const dir=fixture(t),calls=[];
 const result=await videoTranscript('a.mov',dir,{...defaults,execute:execute({segments:[{start:0,text:'  こんにちは\n世界 '},{start:65.9,text:'次の話'}]},calls)});
 assert.equal(result.status,'done');assert.equal(fs.readFileSync(result.path,'utf8'),'[00:00] こんにちは 世界\n[01:05] 次の話\n');assert.equal(fs.existsSync(path.join(dir,'.audio.wav')),false);
 const audio=calls[0],worker=calls[1];assert.equal(audio.args[audio.args.indexOf('-map')+1],'0:1');assert.equal(audio.args[audio.args.indexOf('-ar')+1],'16000');assert.equal(audio.args[audio.args.indexOf('-ac')+1],'1');assert.ok(audio.args.includes('aresample=async=1:first_pts=0'));
 assert.equal(audio.options.timeout,30000);assert.ok(worker.options.timeout<=AUDIO_TIMEOUT);assert.equal(worker.options.killSignal,'SIGKILL');assert.equal(worker.options.env.HF_HUB_OFFLINE,'1');assert.equal(worker.options.env.TRANSFORMERS_OFFLINE,'1');assert.equal(worker.options.env.HF_HUB_DISABLE_TELEMETRY,'1');assert.equal(worker.args[0],'-I');
});
test('unavailable tools/models and concurrent recognition do not queue or launch another worker',async t=>{
 const dir=fixture(t);
 assert.deepEqual(await transcriber({python:path.join(dir,'missing')}),{status:'unavailable'});
 const python=path.join(dir,'python');fs.writeFileSync(python,'fixture');
 assert.equal((await transcriber({python,execute:async()=>({stdout:'{"status":"model-missing"}'})})).status,'model-missing');
 assert.equal((await transcriber({python,execute:async()=>{throw Error('broken module');}})).status,'unavailable');
 for(const status of ['unavailable','model-missing'])assert.equal((await videoTranscript('a',dir,{...defaults,engine:{status},execute:()=>{throw Error('must not execute');}})).status,status);
 let release,started;const ready=new Promise(r=>started=r),held=new Promise(r=>release=r),normal=execute({segments:[]});
 const first=videoTranscript('a',dir,{...defaults,execute:async(...args)=>{if(args[0]==='python'){started();await held;}return normal(...args);}});
 await ready;assert.equal((await videoTranscript('b',dir,{...defaults})).status,'busy');release();assert.equal((await first).status,'empty');assert.match(fs.readFileSync(path.join(dir,'transcript.txt'),'utf8'),/発話を検出できません/);
});
test('timeouts, bad output and audio failures leave no transcript or temporary wav and release the worker',async t=>{
 for(const mode of ['timeout','buffer-limit','bad-json','invalid-time','too-large','audio-failure']){
  const dir=fixture(t),normal=execute({segments:[]});
  const result=await videoTranscript('a',dir,{...defaults,execute:async(...args)=>{
   if(args[0]==='ffmpeg'){await normal(...args);if(mode==='audio-failure')throw Object.assign(Error('decode timeout'),{killed:true});return {stdout:''};}
   if(mode==='buffer-limit')throw Object.assign(Error('buffer limit'),{killed:true,code:'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'});
   if(mode==='timeout')throw Object.assign(Error('timeout'),{killed:true});
   return {stdout:mode==='bad-json'?'bad':JSON.stringify({segments:[{start:mode==='invalid-time'?121:1,text:mode==='too-large'?'x'.repeat(500001):'ok'}]})};
  }});
  assert.equal(result.status,mode==='timeout'?'timeout':'failed');assert.equal(fs.existsSync(path.join(dir,'.audio.wav')),false);assert.equal(fs.existsSync(path.join(dir,'transcript.txt')),false);
 }
});
test('real audio video: local extraction and missing-tool fallback; worker boundary with known transcript',async t=>{
 const dir=fixture(t),platform=require('../lib/platform'),search=[process.env.PATH,'/opt/homebrew/bin','/usr/local/bin'].join(path.delimiter),ffmpeg=platform.findExecutable('ffmpeg',search),ffprobe=platform.findExecutable('ffprobe',search);
 if(!ffmpeg||!ffprobe)return t.skip('local ffmpeg unavailable');
 const source=path.join(dir,'source.mov');execFileSync(ffmpeg,['-nostdin','-v','error','-f','lavfi','-i','testsrc2=size=128x72:rate=8:duration=2','-f','lavfi','-i','sine=frequency=440:duration=2','-c:v','libx264','-threads','1','-c:a','aac','-shortest',source],{timeout:15000});
 const fallbackDir=path.join(dir,'fallback');fs.mkdirSync(fallbackDir);
 const fallback=await videoFrames(source,fallbackDir,{find:n=>n==='ffmpeg'?ffmpeg:ffprobe,checkTranscriber:async()=>({status:'unavailable'})});assert.equal(fallback.frames.length,8);assert.equal(fallback.transcript.status,'unavailable');assert.match(fallback.message,/道具が未導入/);
 const out=path.join(dir,'ready');fs.mkdirSync(out);let wavSeen=false;
 const video=await videoFrames(source,out,{find:n=>n==='ffmpeg'?ffmpeg:ffprobe,checkTranscriber:async()=>({status:'ready',python:'worker-fixture'}),execute:async(cmd,args,options)=>{
  if(cmd!=='worker-fixture')return run(cmd,args,options);
  const wav=args.at(-1),data=fs.readFileSync(wav);assert.equal(data.toString('ascii',0,4),'RIFF');assert.equal(data.readUInt32LE(24),16000);assert.equal(data.readUInt16LE(22),1);wavSeen=true;
  return {stdout:JSON.stringify({segments:[{start:0.5,text:'既知の試験用文字列'}]})};
 }});
 assert.ok(wavSeen);assert.equal(video.frames.length,4);assert.equal(video.transcript.status,'done');assert.match(fs.readFileSync(video.transcript.path,'utf8'),/\[00:00\] 既知の試験用文字列/);assert.equal(fs.existsSync(path.join(out,'.audio.wav')),false);
});
test('Python CPU worker uses only cached large-v3, int8, no VAD or text carryover, and automatic language',t=>{
 const dir=fixture(t),platform=require('../lib/platform'),python=platform.findExecutable('python3',process.env.PATH);
 if(!python)return t.skip('python3 unavailable');
 const snapshot=path.join(dir,'hub/models--Systran--faster-whisper-large-v3/snapshots/abc');fs.mkdirSync(snapshot,{recursive:true});
 for(const name of ['model.bin','config.json','tokenizer.json','vocabulary.json'])fs.writeFileSync(path.join(snapshot,name),'fixture');
 const script=path.resolve(__dirname,'../tools/transcribe-video.py');
 const code=`import sys, types, runpy, os, platform
platform.system = lambda: 'Windows'
platform.machine = lambda: 'AMD64'
os.environ['HF_HOME'] = ${JSON.stringify(dir)}
os.environ.pop('HF_HUB_CACHE', None)
class Worker:
 def __init__(self, model, **kwargs):
  assert model == ${JSON.stringify(snapshot)}
  assert kwargs['device'] == 'cpu' and kwargs['compute_type'] == 'int8'
  assert kwargs['local_files_only'] and kwargs['num_workers'] == 1
  assert 1 <= kwargs['cpu_threads'] <= 4
 def transcribe(self, audio, **kwargs):
  assert kwargs == {'beam_size': 5, 'vad_filter': False, 'condition_on_previous_text': False}
  assert os.environ['HF_HUB_OFFLINE'] == '1'
  return iter([types.SimpleNamespace(start=1.5, text='試験')]), None
sys.modules['faster_whisper'] = types.SimpleNamespace(WhisperModel=Worker)
sys.argv = [${JSON.stringify(script)}, 'fixture.wav']
runpy.run_path(${JSON.stringify(script)}, run_name='__main__')`;
 const result=execFileSync(python,['-I','-c',code],{encoding:'utf8',timeout:10000});assert.deepEqual(JSON.parse(result),{segments:[{start:1.5,text:'試験'}]});
});

test('backend preflight selects MLX only on Apple Silicon; absent models never trigger recognition',t=>{
 const dir=fixture(t),platform=require('../lib/platform'),python=platform.findExecutable('python3',process.env.PATH);
 if(!python)return t.skip('python3 unavailable');
 const script=path.resolve(__dirname,'../tools/transcribe-video.py');
 for(const [engine,names] of [['mlx',['config.json','weights.npz']],['faster-whisper',['config.json','model.bin','tokenizer.json','vocabulary.json']]]){
  const snapshot=path.join(dir,`hub/models--${engine==='mlx'?'mlx-community--whisper-large-v3-mlx':'Systran--faster-whisper-large-v3'}/snapshots/abc`);
  fs.mkdirSync(snapshot,{recursive:true});for(const name of names)fs.writeFileSync(path.join(snapshot,name),'fixture');
 }
 const invoke=(system,machine,available=true,home=dir)=>JSON.parse(execFileSync(python,['-I','-c',`import sys, types, runpy, os, platform
platform.system=lambda:${JSON.stringify(system)}
platform.machine=lambda:${JSON.stringify(machine)}
os.environ['HF_HOME']=${JSON.stringify(home)}
os.environ.pop('HF_HUB_CACHE',None)
sys.modules['mlx_whisper']=types.SimpleNamespace() if ${available?'True':'False'} else None
sys.modules['faster_whisper']=types.SimpleNamespace(WhisperModel=None)
sys.argv=[${JSON.stringify(script)},'--check']
runpy.run_path(${JSON.stringify(script)},run_name='__main__')`],{encoding:'utf8',timeout:10000}));
 assert.deepEqual(invoke('Darwin','arm64'),{status:'ready',backend:'mlx'});
 assert.deepEqual(invoke('Darwin','x86_64'),{status:'ready',backend:'faster-whisper'});
 assert.deepEqual(invoke('Windows','AMD64'),{status:'ready',backend:'faster-whisper'});
 assert.deepEqual(invoke('Darwin','arm64',false),{status:'unavailable',backend:'mlx'},'do not silently switch backends');
 assert.deepEqual(invoke('Darwin','arm64',true,path.join(dir,'missing')),{status:'model-missing',backend:'mlx'});
});

test('MLX worker receives bounded PCM samples and a local large-v3 path without starting ffmpeg',t=>{
 const dir=fixture(t),platform=require('../lib/platform'),python=platform.findExecutable('python3',process.env.PATH);
 if(!python)return t.skip('python3 unavailable');
 const snapshot=path.join(dir,'hub/models--mlx-community--whisper-large-v3-mlx/snapshots/abc');fs.mkdirSync(snapshot,{recursive:true});
 for(const name of ['config.json','weights.npz'])fs.writeFileSync(path.join(snapshot,name),'fixture');
 const script=path.resolve(__dirname,'../tools/transcribe-video.py'),wav=path.join(dir,'input.wav');
 const code=`import sys, types, runpy, os, platform, wave, struct, subprocess
platform.system=lambda:'Darwin'
platform.machine=lambda:'arm64'
os.environ['HF_HOME']=${JSON.stringify(dir)}
os.environ.pop('HF_HUB_CACHE',None)
def forbidden(*args,**kwargs): raise AssertionError('no subprocess allowed')
subprocess.Popen=forbidden
class Samples:
 def __init__(self,data,dtype):
  assert dtype=='<i2'
  self.values=struct.unpack('<3h',data)
 def astype(self,dtype):
  assert dtype=='float32'
  return self
 def __truediv__(self,scale):
  assert scale==32768.0
  return [v/scale for v in self.values]
def transcribe(audio,**kwargs):
 assert audio==[-1.0,0.0,32767/32768]
 assert kwargs=={'path_or_hf_repo':${JSON.stringify(snapshot)},'language':None,'condition_on_previous_text':False,'verbose':None}
 assert os.environ['HF_HUB_OFFLINE']=='1' and os.environ['HF_HUB_DISABLE_TELEMETRY']=='1'
 return {'segments':[{'start':0.0,'text':'你好'}]}
sys.modules['numpy']=types.SimpleNamespace(frombuffer=Samples,float32='float32')
sys.modules['mlx_whisper']=types.SimpleNamespace(transcribe=transcribe)
with wave.open(${JSON.stringify(wav)},'wb') as w:
 w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(struct.pack('<3h',-32768,0,32767))
sys.argv=[${JSON.stringify(script)},${JSON.stringify(wav)}]
runpy.run_path(${JSON.stringify(script)},run_name='__main__')`;
 assert.deepEqual(JSON.parse(execFileSync(python,['-I','-c',code],{encoding:'utf8',timeout:10000})),{segments:[{start:0,text:'你好'}]});
 // The decoder rejects unsupported or excessively long audio before allocation/recognition.
 const bad=`import runpy, wave, struct
m=runpy.run_path(${JSON.stringify(script)})
for channels,rate,frames in [(2,16000,1),(1,8000,1),(1,16000,16000*600+1)]:
 with wave.open(${JSON.stringify(wav)},'wb') as w:
  w.setnchannels(channels); w.setsampwidth(2); w.setframerate(rate); w.writeframes(b'\\0\\0'*channels)
 if frames>1:
  with open(${JSON.stringify(wav)},'r+b') as f: f.seek(40); f.write(struct.pack('<I',frames*2))
 try: m['mlx_audio'](${JSON.stringify(wav)})
 except RuntimeError: pass
 else: raise AssertionError('invalid WAV accepted')`;
 // Reuse the same stdlib-only NumPy stub; invalid headers must fail before using it.
 execFileSync(python,['-I','-c',"import sys,types\nsys.modules['numpy']=types.SimpleNamespace()\n"+bad],{timeout:10000});
});

test('MLX preflight and deadlines preserve the 30-minute CPU fallback and annotate rather than remove boilerplate',async t=>{
 const dir=fixture(t),python=path.join(dir,'python');fs.writeFileSync(python,'fixture');
 const engine=await transcriber({python,execute:async()=>({stdout:'{"status":"ready","backend":"mlx"}'})});
 assert.equal(engine.backend,'mlx');
 for(const backend of ['mlx','faster-whisper']){
  const out=path.join(dir,backend);fs.mkdirSync(out);const calls=[];
  const result=await videoTranscript('a',out,{...defaults,engine:{...engine,python:'python',backend},execute:execute({segments:[{start:1,text:'ご視聴ありがとうございました'},{start:2,text:'謝謝收看'},{start:3,text:'実際に話した内容'},{start:4,text:'请不吝点赞 订阅 转发 打赏支持明镜与点点栏目'},{start:5,text:'請不吝點讚 訂閱 轉發'}]},calls)});
  const expected=backend==='mlx'?MLX_AUDIO_TIMEOUT:AUDIO_TIMEOUT;
  assert.ok(calls[1].options.timeout>expected-2000 && calls[1].options.timeout<=expected);
  const text=fs.readFileSync(result.path,'utf8');
  assert.match(text,/\[00:01\] ご視聴ありがとうございました （音声認識の定型句の疑い）/);
  assert.match(text,/\[00:02\] 謝謝收看 （音声認識の定型句の疑い）/);
  assert.match(text,/\[00:04\] 请不吝点赞 订阅 转发 打赏支持明镜与点点栏目 （音声認識の定型句の疑い）/);
  assert.match(text,/\[00:05\] 請不吝點讚 訂閱 轉發 （音声認識の定型句の疑い）/);
  assert.match(text,/\[00:03\] 実際に話した内容\n/);
  assert.equal(fs.existsSync(path.join(out,'.audio.wav')),false);
 }
 assert.equal(MLX_AUDIO_TIMEOUT,600000);assert.equal(AUDIO_TIMEOUT,1800000);
 assert.match(audioMessage('timeout'),/この環境の制限時間/);
});

test('real scene cut is selected alongside uniformly spaced snapshots',async t=>{
 const dir=fixture(t),platform=require('../lib/platform'),search=[process.env.PATH,'/opt/homebrew/bin','/usr/local/bin'].join(path.delimiter),ffmpeg=platform.findExecutable('ffmpeg',search),ffprobe=platform.findExecutable('ffprobe',search);
 if(!ffmpeg||!ffprobe)return t.skip('local ffmpeg unavailable');
 const source=path.join(dir,'cut.mp4');
 execFileSync(ffmpeg,['-nostdin','-v','error','-f','lavfi','-i','color=c=black:size=128x72:rate=8:duration=1.25[a];color=c=white:size=128x72:rate=8:duration=2[b];[a][b]concat=n=2:v=1:a=0','-c:v','libx264','-threads','1',source],{timeout:15000});
 const out=path.join(dir,'frames');fs.mkdirSync(out);
 const result=await videoFrames(source,out,{find:n=>n==='ffmpeg'?ffmpeg:ffprobe});
 assert.equal(result.frames.length,4);assert.ok(result.frames.some(f=>f.seconds>=1 && f.seconds<=1.5),'the half-second sample around the 1.25s cut is included: '+JSON.stringify(result.frames.map(f=>f.seconds)));
 assert.equal(result.frames[0].seconds,0);assert.ok(result.frames.at(-1).seconds>2);
});
