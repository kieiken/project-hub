'use strict';
const fs = require('./platform/file-io'), path = require('node:path');
const { execFile } = require('node:child_process'), { promisify } = require('node:util');
const { lt } = require('./locale');
const run = promisify(execFile);
const AUDIO_TIMEOUT = 30 * 60 * 1000, MLX_AUDIO_TIMEOUT = 10 * 60 * 1000, TEXT_LIMIT = 500000;
const PYTHON = path.join(__dirname, '..', '.venv-video', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const SCRIPT = path.join(__dirname, '..', 'tools', 'transcribe-video.py');
// A single transcription at a time, including GPU workers. Other attachments do not wait.
let active = false;
const offlineEnv = () => ({ ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1' });
function timestamp(seconds) {
  const n = Math.floor(seconds);
  return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
}
async function transcriber({ execute = run, python = PYTHON } = {}) {
  if (!fs.existsSync(python)) return { status: 'unavailable' };
  try {
    const result = await execute(python, ['-I', SCRIPT, '--check'], { timeout: 15000, killSignal: 'SIGKILL', maxBuffer: 65536, windowsHide: true, env: offlineEnv() });
    const check = JSON.parse(result.stdout);
    return { status: check.status === 'ready' ? 'ready' : check.status === 'model-missing' ? 'model-missing' : 'unavailable', python, backend: check.backend === 'mlx' ? 'mlx' : 'faster-whisper' };
  } catch { return { status: 'unavailable' }; }
}
function audioMessage(status) {
  const messages = {
    done: '音声をこのパソコン内で時刻付きの文字にしました。自動認識のため聞き間違いが含まれる場合があります',
    empty: '音声を文字起こししましたが、発話を検出できませんでした',
    absent: '音声トラックがありません',
    unavailable: '音声は文字起こしできません（道具が未導入または利用できません）',
    'model-missing': '音声は文字起こしできません（取得済みのlarge-v3モデルが見つかりません）',
    busy: '別の動画を文字起こし中のため、この動画は場面のみ参照できます',
    timeout: '音声の文字起こしがこの環境の制限時間内に終わらなかったため、場面のみ参照できます',
    failed: '音声の取り出しまたは文字起こしに失敗したため、場面のみ参照できます'
  };
  return lt(messages[status] || messages.failed);
}
async function videoTranscript(file, dir, { ffmpeg, input, audioIndex, duration, engine, execute = run } = {}) {
  if (engine.status !== 'ready') return { status: engine.status };
  if (active) return { status: 'busy' };
  active = true;
  const wav = path.join(dir, '.audio.wav'), transcript = path.join(dir, 'transcript.txt'), deadline = Date.now() + (engine.backend === 'mlx' ? MLX_AUDIO_TIMEOUT : AUDIO_TIMEOUT);
  let recognizing = false;
  const options = () => ({ timeout: Math.max(1, deadline - Date.now()), killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024, windowsHide: true, env: offlineEnv() });
  try {
    await execute(ffmpeg, ['-nostdin', '-v', 'error', '-n', '-threads', '1', ...input, '-i', file, '-map', `0:${audioIndex}`, '-t', String(duration), '-vn', '-sn', '-dn', '-af', 'aresample=async=1:first_pts=0', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-threads', '1', wav], { ...options(), timeout: 30000 });
    const st = fs.lstatSync(wav);
    if (!st.isFile() || st.size < 44 || st.size > 20 * 1024 * 1024) throw Error('invalid wav');
    recognizing = true;
    const result = await execute(engine.python, ['-I', SCRIPT, wav], options());
    const data = JSON.parse(result.stdout);
    if (!Array.isArray(data.segments) || data.segments.length > 20000) throw Error('invalid transcript');
    let previous = 0, length = 0;
    const lines = data.segments.map(s => {
      if (!Number.isFinite(s.start) || s.start < previous || s.start > duration || typeof s.text !== 'string') throw Error('invalid segment');
      previous = s.start;
      const raw = s.text.replace(/\s+/g, ' ').trim();
      // Preserve possible ASR boilerplate: the recording may actually contain it.
      const suspicious = /ご視聴ありがとうございました|ご清聴ありがとうございました|チャンネル登録|謝謝收看|谢谢收看|感謝收看|感谢收看|感謝觀看|感谢观看|请不吝点赞|請不吝點讚|支持明镜与点点栏目|支持明鏡與點點欄目/.test(raw.normalize('NFKC'));
      const text = suspicious ? raw + ' （音声認識の定型句の疑い）' : raw;
      length += text.length;
      if (length > TEXT_LIMIT) throw Error('transcript too large');
      return text ? `[${timestamp(s.start)}] ${text}` : '';
    }).filter(Boolean);
    fs.writeFileSync(transcript, lines.length ? lines.join('\n') + '\n' : lt('発話を検出できませんでした') + '\n', { flag: 'wx' });
    return { status: lines.length ? 'done' : 'empty', path: transcript };
  } catch (error) {
    return { status: recognizing && (error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && error.killed || Date.now() >= deadline) ? 'timeout' : 'failed' };
  } finally {
    try { if (fs.existsSync(wav)) fs.unlinkSync(wav); } finally { active = false; }
  }
}
module.exports = { AUDIO_TIMEOUT, MLX_AUDIO_TIMEOUT, PYTHON, transcriber, videoTranscript, audioMessage, timestamp };
