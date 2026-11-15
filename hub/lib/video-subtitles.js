'use strict';
const fs = require('./platform/file-io'), path = require('node:path');
const { execFile } = require('node:child_process'), { promisify } = require('node:util');
const { lt } = require('./locale');
const run = promisify(execFile), SUBTITLE_TIMEOUT = 20000, IMAGE_LIMIT = 4 * 1024 * 1024;
// Keep text at up to 640px per strip; reduce the number of tall strips instead
// of squeezing all 24 into an unreadable sheet. FFmpeg applies display rotation.
const crop = "crop=iw:'max(2,floor(ih*0.35/2)*2)':0:ih-oh";
const scale = "scale=w='min(640,iw)':h='min(800,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1";
function subtitleSamples(stderr, duration) {
  const times = [...new Set([...stderr.matchAll(/pts_time:\s*([\d.]+)/g)].map(m => Number(m[1])))].filter(n => Number.isFinite(n) && n >= 0 && n < duration).sort((a,b) => a-b);
  const size = stderr.match(/\bs:(\d+)x(\d+)/);
  return { times, width: Number(size?.[1]), height: Number(size?.[2]) };
}
function chooseStrips(times, capacity) {
  return times.length <= capacity ? times : Array.from({length:capacity}, (_,i) => times[Math.round(i * (times.length - 1) / (capacity - 1))]);
}
function subtitleMessage(sheet) {
  if (sheet.status === 'done') return (sheet.partial ? lt('字幕帯は一部のみ。') : '') + lt`画面下側の変化を${sheet.times.length}本の字幕帯として1枚にまとめました。` + lt('左上から右へ、次の行の順です。背景の動きも含む場合があり、字幕の全行を保証するものではありません');
  if (sheet.status === 'absent') return lt('字幕の変化は見つかりませんでした（画面下側の変化から推定）');
  return sheet.status === 'timeout' ? lt('字幕帯画像は20秒以内に作成できなかったため省略しました') : lt('字幕帯画像の作成に失敗したため省略しました');
}
async function videoSubtitles(file, dir, { ffmpeg, input, videoIndex, duration, execute = run } = {}) {
  const deadline = Date.now() + SUBTITLE_TIMEOUT;
  let temp;
  const command = async(args) => {
    if (Date.now() >= deadline) throw Object.assign(Error('subtitle timeout'), {code:'SUBTITLE_TIMEOUT'});
    return execute(ffmpeg, args, {timeout:Math.max(1,deadline-Date.now()), killSignal:'SIGKILL', maxBuffer:2*1024*1024, windowsHide:true});
  };
  try {
    // Select one real frame in each quarter-second bucket, retaining its PTS.
    // fps=4 would retime frames, and seeking that rounded time can pick the
    // preceding subtitle instead of the changed subtitle detected in the scan.
    const sample = "setpts=PTS-STARTPTS,select='isnan(prev_selected_t)+gt(floor(t*4),floor(prev_selected_t*4))'";
    const scan = await command(['-nostdin','-v','info','-threads','1',...input,'-i',file,'-t',String(duration),'-map',`0:${videoIndex}`,'-an','-sn','-dn','-vf',`${sample},${crop},${scale},format=gray,mpdecimate=hi=2048:lo=768:frac=0.03,showinfo`,'-threads','1','-filter_threads','1','-f','null','-']);
    const samples = subtitleSamples(scan.stderr || '', duration);
    if (samples.times.length < 2) return {status:'absent'};
    if (samples.times.length > 2401 || !Number.isInteger(samples.width) || !Number.isInteger(samples.height) || samples.width < 2 || samples.width > 640 || samples.height < 2 || samples.height > 800) throw Error('invalid subtitle samples');
    const capacity = Math.min(24, 2 * Math.floor(1600 / samples.height)), times = chooseStrips(samples.times, capacity);
    temp = fs.mkdtempSync(path.join(dir,'.subtitle-'));
    for (let i = 0; i < times.length; i++) {
      const output = path.join(temp,`strip-${String(i+1).padStart(2,'0')}.png`);
      await command(['-nostdin','-v','error','-n','-threads','1',...input,'-ss',times[i].toFixed(6),'-i',file,'-map',`0:${videoIndex}`,'-frames:v','1','-an','-sn','-dn','-vf',`${crop},${scale}`,'-threads','1','-filter_threads','1',output]);
      const st = fs.lstatSync(output);
      if (!st.isFile() || st.size < 1 || st.size > IMAGE_LIMIT) throw Error('invalid subtitle strip');
    }
    const rows = Math.ceil(times.length / 2), combined = path.join(temp,'combined.jpg');
    await command(['-nostdin','-v','error','-n','-threads','1','-protocol_whitelist','file','-format_whitelist','image2','-f','image2','-framerate','1','-start_number','1','-i',path.join(temp,'strip-%02d.png'),'-frames:v','1','-vf',`tile=2x${rows}:nb_frames=${times.length}:color=white`,'-threads','1','-filter_threads','1','-q:v','2',combined]);
    const st = fs.lstatSync(combined);
    if (!st.isFile() || st.size < 1 || st.size > IMAGE_LIMIT) throw Error('invalid subtitle sheet');
    const output = path.join(dir,'subtitles.jpg');
    fs.copyFileSync(combined, output, fs.constants.COPYFILE_EXCL);
    return {status:'done',path:output,times,total:samples.times.length,partial:times.length<samples.times.length,width:samples.width*2,height:samples.height*rows};
  } catch (error) {
    return {status:error.code === 'SUBTITLE_TIMEOUT' || error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && error.killed || Date.now() >= deadline ? 'timeout' : 'failed'};
  } finally {
    if (temp) fs.rmSync(temp,{recursive:true,force:true});
  }
}
module.exports = { videoSubtitles, subtitleMessage, subtitleSamples, chooseStrips, SUBTITLE_TIMEOUT };
