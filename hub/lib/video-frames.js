'use strict';
// 動画は外部へ送らず、ローカルの ffmpeg で時刻付き静止画へ変換する。
const fs = require('./platform/file-io'), path = require('node:path');
const { execFile } = require('node:child_process'), { promisify } = require('node:util');
const platform = require('./platform'), { lt } = require('./locale');
const run = promisify(execFile);
const { transcriber, videoTranscript, audioMessage, timestamp } = require('./video-transcript');
const { videoSubtitles, subtitleMessage } = require('./video-subtitles');
const VIDEO = /\.(mp4|mov|m4v|webm)$/i, FRAME_COUNT = 8, MAX_FRAMES = 16, MAX_SECONDS = 600;
function frameCount(duration) { return Math.min(MAX_FRAMES, Math.max(4, Math.ceil(duration / 15) + 3)); }
function evenly(duration, count) {
  return Array.from({length: count}, (_, i) => duration * i / count);
}
function sceneTimes(stderr, duration) {
  return [...stderr.matchAll(/pts_time:([\d.]+)/g)].map(m => Number(m[1])).filter(n => Number.isFinite(n) && n >= 0 && n < duration);
}
function selectTimes(duration, count, scenes) {
  const cuts = [...new Set(scenes)].sort((a,b) => a-b), chosen = [];
  const take = Math.min(Math.floor(count / 2), cuts.length);
  for (let i = 0; i < take; i++) chosen.push(cuts[Math.min(cuts.length - 1, Math.floor((i + 0.5) * cuts.length / take))]);
  const anchors = evenly(duration, count);
  for (const n of [anchors[0], anchors.at(-1), ...anchors.slice(1,-1), ...evenly(duration, count * 2)]) {
    if (chosen.length >= count) break;
    if (!chosen.some(x => Math.abs(x - n) < Math.min(0.1, duration / (count * 4)))) chosen.push(n);
  }
  return chosen.sort((a,b) => a-b);
}
function executable(name) {
  const search = [process.env.PATH, ...(process.platform === 'darwin' ? ['/opt/homebrew/bin','/usr/local/bin'] : [])].filter(Boolean).join(path.delimiter);
  return platform.findExecutable(name, search);
}
async function videoFrames(file, dir, { execute = run, find = executable, checkTranscriber = transcriber, transcribe = videoTranscript, subtitles = videoSubtitles } = {}) {
  const ffmpeg = find('ffmpeg'), ffprobe = find('ffprobe');
  if (!ffmpeg || !ffprobe) throw Error(lt('このパソコンには動画を読み取る道具（ffmpeg）がありません。追加インストールはしていません'));
  const options = (deadline) => ({ timeout: Math.max(1, deadline - Date.now()), killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, windowsHide: true });
  // コンテナを限定する。プレイリストや外部URLを動画として開かない。
  const input = ['-protocol_whitelist','file','-format_whitelist','mov,matroska,webm'];
  let metadata;
  try {
    const probe = await execute(ffprobe, ['-v','error',...input,'-show_entries','format=duration:stream=index,codec_type,width,height,duration:stream_disposition=attached_pic','-of','json',file], {...options(Date.now() + 10000)});
    metadata = JSON.parse(probe.stdout);
  } catch { throw Error(lt('動画を読み取れませんでした。MP4かMOVで保存し直して追加してください')); }
  const stream = metadata.streams?.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const duration = Number(stream?.duration || metadata.format?.duration);
  if (!stream || !Number.isFinite(duration) || duration <= 0 || !Number.isInteger(stream.index) || !Number.isFinite(stream.width * stream.height) || stream.width <= 0 || stream.height <= 0 || stream.width * stream.height > 40000000)
    throw Error(lt('動画の長さや映像を確認できませんでした。MP4かMOVで保存し直して追加してください'));
  if (duration > MAX_SECONDS) throw Error(lt('動画は10分までです。見てほしい部分を短くして追加してください'));
  const audio = metadata.streams?.find(s => s.codec_type === 'audio' && Number.isInteger(s.index));
  const engine = audio ? await checkTranscriber() : {status: 'absent'};
  // Preserve the original eight-frame fallback when transcription is not installed.
  const fallback = audio && ['unavailable', 'model-missing'].includes(engine.status);
  let subtitleSheet;
  try { subtitleSheet = await subtitles(file,dir,{ffmpeg,input,videoIndex:stream.index,duration,execute}); }
  catch { subtitleSheet = {status:'failed'}; }
  const count = fallback ? FRAME_COUNT : Math.min(frameCount(duration),MAX_FRAMES-(subtitleSheet.path?1:0)), deadline = Date.now() + 45000;
  let scenes = [];
  if (!fallback) {
    try {
      const scan = await execute(ffmpeg, ['-nostdin','-v','info','-threads','1',...input,'-i',file,'-map',`0:${stream.index}`,'-an','-sn','-dn','-vf',"fps=2,scale=320:320:force_original_aspect_ratio=decrease,select='gt(scene,0.3)',showinfo",'-threads','1','-filter_threads','1','-f','null','-'], {...options(deadline), timeout:12000});
      scenes = sceneTimes(scan.stderr || '', duration);
    } catch { /* Keep uniformly spaced frames if scene detection cannot finish. */ }
  }
  const times = fallback ? Array.from({length: FRAME_COUNT}, (_,i) => duration * i / FRAME_COUNT) : selectTimes(duration,count,scenes);
  const frames = [];
  try {
    for (let i = 0; i < times.length; i++) {
      if (Date.now() >= deadline) throw Error('video timeout');
      const seconds = times[i], output = path.join(dir,`frame-${String(i + 1).padStart(2,'0')}.jpg`);
      await execute(ffmpeg, ['-nostdin','-v','error','-n','-threads','1',...input,'-ss',seconds.toFixed(6),'-i',file,'-map',`0:${stream.index}`,'-frames:v','1','-an','-sn','-dn','-vf',"scale=w='min(960,iw)':h='min(960,ih)':force_original_aspect_ratio=decrease",'-threads','1','-filter_threads','1','-q:v','3',output], options(deadline));
      const stat = fs.lstatSync(output);
      if (!stat.isFile() || stat.size < 1 || stat.size > 4 * 1024 * 1024) throw Error('video frame missing');
      frames.push({seconds, path:output});
    }
  } catch { throw Error(lt('動画の場面を取り出せませんでした。短いMP4で保存し直して追加してください')); }
  const transcript = audio ? await transcribe(file,dir,{ffmpeg,input,audioIndex:audio.index,duration,engine,execute}) : {status:'absent'};
  const message = lt`動画から${frames.length}枚の時刻付き静止画を抜き出しました。` + ' ' + audioMessage(transcript.status) + ' ' + subtitleMessage(subtitleSheet) + ' ' + lt('場面の間の動き・抜き出していない瞬間は確認できません');
  const manifest = path.join(dir,'video.txt');
  const subtitleIndex = subtitleSheet.path ? lt('字幕帯画像') + ': ' + subtitleSheet.path + '\n' + subtitleSheet.times.map((s,i) => lt`字幕帯 ${i+1}本目＝[${timestamp(s)}]` + ` (${s.toFixed(3)}s)`).join('\n') + '\n' : '';
  fs.writeFileSync(manifest, `${message}\n${lt('動画の長さ（秒）')}: ${duration.toFixed(3)}\n` + frames.map(f => `[${timestamp(f.seconds)}] ${f.seconds.toFixed(3)}s: ${f.path}`).join('\n') + '\n' + (transcript.path ? lt('時刻付き文字起こし') + ': ' + transcript.path + '\n' : '') + subtitleIndex, {flag:'wx'});
  return {duration, frames, manifest, message, transcript, subtitleSheet};
}
module.exports = { VIDEO, FRAME_COUNT, MAX_FRAMES, MAX_SECONDS, frameCount, selectTimes, sceneTimes, videoFrames };
