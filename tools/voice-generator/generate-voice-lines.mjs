// 煤球台词语音预生成脚本
// 作用：读取 voice-lines.json，调用语音合成接口，把每句台词生成 mp3，供离线应用直接播放。
//
// 需要的环境变量（不要把密钥写进代码或提交到仓库）：
//   SPARKLIGHT_TTS_API_KEY   接口密钥
//   SPARKLIGHT_BIZLINE_ID    请求头 X-Bizline-Id
//   SPARKLIGHT_APP_ID        请求头 X-App-Id
//   SPARKLIGHT_CHAT_ID       请求头 X-Chat-Id（可选）
//   SPARKLIGHT_USER_ID       请求头 X-User-Id（可选）
//
// 用法：
//   node generate-voice-lines.mjs                       生成全部台词（已存在的跳过）
//   node generate-voice-lines.mjs --force               全部重新生成
//   node generate-voice-lines.mjs --only=remind-01,snooze-01
//   node generate-voice-lines.mjs --speaker=xxx         换一个音色
//   node generate-voice-lines.mjs --audition=音色1,音色2  每个音色生成同一句试听，用来挑音色
//   node generate-voice-lines.mjs --output=其它目录                默认输出到 public/voice
//   node generate-voice-lines.mjs --lines=voice-lines.hamster.json --output=../../public/voice/hamster
//                                                       用另一份台词清单（每种动物一份，见 make-species-lines.mjs）

import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API_URL = 'http://api-proxy.sparklight.app/api/v3/tts/unidirectional';
const RESOURCE_ID = 'seed-tts-2.0';
const CONCURRENCY = 3;
const MAX_RETRIES = 2;
const REQUEST_TIMEOUT_MS = 60_000;
// seed-tts-2.0 只能用 _uranus_bigtts 结尾的音色；语速（-50 ~ 100，0 为常速）按情绪写在 voice-lines.json 里

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));

// ---------- 解析命令行参数 ----------
function parseArguments(argv) {
  // 默认输出到应用的 public/voice（打包进安装包；3D 小样也从这里读取）
  const options = { force: false, only: null, speaker: null, audition: null, lines: 'voice-lines.json', output: path.resolve(scriptDirectory, '../../public/voice') };
  for (const argument of argv) {
    if (argument === '--force') options.force = true;
    else if (argument.startsWith('--only=')) options.only = new Set(argument.slice(7).split(',').filter(Boolean));
    else if (argument.startsWith('--speaker=')) options.speaker = argument.slice(10);
    else if (argument.startsWith('--audition=')) options.audition = argument.slice(11).split(',').filter(Boolean);
    else if (argument.startsWith('--output=')) options.output = path.resolve(process.cwd(), argument.slice(9));
    else if (argument.startsWith('--lines=')) options.lines = argument.slice(8);
    else throw new Error(`不认识的参数：${argument}`);
  }
  return options;
}

// ---------- 读取并检查环境变量 ----------
function readCredentials() {
  const credentials = {
    apiKey: process.env.SPARKLIGHT_TTS_API_KEY,
    bizlineId: process.env.SPARKLIGHT_BIZLINE_ID,
    appId: process.env.SPARKLIGHT_APP_ID,
    chatId: process.env.SPARKLIGHT_CHAT_ID ?? '',
    userId: process.env.SPARKLIGHT_USER_ID ?? '',
  };
  const missing = [['SPARKLIGHT_TTS_API_KEY', credentials.apiKey], ['SPARKLIGHT_BIZLINE_ID', credentials.bizlineId], ['SPARKLIGHT_APP_ID', credentials.appId]]
    .filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) throw new Error(`缺少环境变量：${missing.join('、')}`);
  return credentials;
}

// ---------- 从接口返回内容里取出音频 ----------
// 接口可能直接返回音频，也可能返回多行 JSON（每行带一段 base64 音频），这里都兼容
function extractAudio(responseBuffer, contentType) {
  if (contentType.startsWith('audio/') || contentType === 'application/octet-stream') return responseBuffer;
  const responseText = responseBuffer.toString('utf8');
  const audioChunks = [];
  const candidateLines = responseText.split(/\r?\n/).map(line => line.replace(/^data:\s*/, '').trim()).filter(Boolean);
  for (const line of candidateLines) {
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.error) throw new Error(`接口报错：${message.error.message ?? JSON.stringify(message.error)}`);
    const code = message.code ?? message.header?.code;
    if (code !== undefined && code !== 0 && code !== 20000000) {
      throw new Error(`接口报错（code=${code}）：${message.message ?? message.header?.message ?? line.slice(0, 200)}`);
    }
    const audioBase64 = typeof message.data === 'string' ? message.data : message.data?.audio ?? message.audio;
    if (audioBase64) audioChunks.push(Buffer.from(audioBase64, 'base64'));
  }
  if (!audioChunks.length) throw new Error(`没有在返回内容里找到音频：${responseText.slice(0, 300)}`);
  return Buffer.concat(audioChunks);
}

// ---------- 调用一次语音合成 ----------
async function synthesize({ text, speaker, emotionStyle, credentials }) {
  const requestBody = {
    user: { uid: 'meiqiu-voice-generator' },
    req_params: {
      text,
      speaker,
      audio_params: { format: 'mp3', sample_rate: 24000, speech_rate: emotionStyle.speechRate ?? 0 },
      additions: JSON.stringify({ context_texts: [emotionStyle.prompt] }),
    },
  };
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${credentials.apiKey}`,
      'Content-Type': 'application/json',
      'X-Api-Resource-Id': RESOURCE_ID,
      'X-Bizline-Id': credentials.bizlineId,
      'X-App-Id': credentials.appId,
      'X-Chat-Id': credentials.chatId,
      'X-User-Id': credentials.userId,
    },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const responseBuffer = Buffer.from(await response.arrayBuffer());
  if (!response.ok) throw new Error(`HTTP ${response.status}：${responseBuffer.toString('utf8').slice(0, 300)}`);
  return extractAudio(responseBuffer, response.headers.get('content-type') ?? '');
}

async function synthesizeWithRetry(parameters) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await synthesize(parameters);
    } catch (error) {
      lastError = error;
      if (attempt < MAX_RETRIES) await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
  throw lastError;
}

const fileExists = filePath => access(filePath).then(() => true, () => false);

// 简单的并发控制：同时最多跑 CONCURRENCY 个任务
async function runWithConcurrency(tasks, limit) {
  const results = [];
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (nextIndex < tasks.length) {
      const index = nextIndex++;
      results[index] = await tasks[index]();
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const credentials = readCredentials();
  const voiceLines = JSON.parse(await readFile(path.join(scriptDirectory, options.lines), 'utf8'));
  const speaker = options.speaker ?? voiceLines.defaultSpeaker;

  // 试听模式：同一句话用不同音色各生成一份
  if (options.audition) {
    // 试听文件不打包进应用，放在 docs/voice/audition
    const auditionDirectory = path.resolve(scriptDirectory, '../../docs/voice/audition');
    await mkdir(auditionDirectory, { recursive: true });
    const sampleLine = voiceLines.lines.find(line => line.id === 'remind-01');
    for (const auditionSpeaker of options.audition) {
      try {
        const audio = await synthesizeWithRetry({ text: sampleLine.text, speaker: auditionSpeaker, emotionStyle: voiceLines.emotionStyles[sampleLine.emotion], credentials });
        await writeFile(path.join(auditionDirectory, `${auditionSpeaker}.mp3`), audio);
        console.log(`✅ ${auditionSpeaker}（${(audio.length / 1024).toFixed(1)} KB）`);
      } catch (error) {
        console.log(`❌ ${auditionSpeaker}：${error.message}`);
      }
    }
    return;
  }

  await mkdir(options.output, { recursive: true });
  const selectedLines = voiceLines.lines.filter(line => !options.only || options.only.has(line.id));
  const tasks = selectedLines.map(line => async () => {
    const outputFile = path.join(options.output, `${line.id}.mp3`);
    if (!options.force && await fileExists(outputFile)) return { line, status: 'skipped' };
    try {
      const emotionStyle = voiceLines.emotionStyles[line.emotion] ?? voiceLines.emotionStyles.coquettish;
      const audio = await synthesizeWithRetry({ text: line.text, speaker, emotionStyle, credentials });
      await writeFile(outputFile, audio);
      console.log(`✅ ${line.id}  ${line.text}`);
      return { line, status: 'generated' };
    } catch (error) {
      console.log(`❌ ${line.id}  ${error.message}`);
      return { line, status: 'failed', error: error.message };
    }
  });
  const results = await runWithConcurrency(tasks, CONCURRENCY);

  // 生成清单：只收录真正存在音频文件的台词，应用运行时按 id / 分组查找
  const availableLines = [];
  for (const line of voiceLines.lines) {
    if (await fileExists(path.join(options.output, `${line.id}.mp3`))) {
      availableLines.push({ id: line.id, group: line.group, count: line.count, emotion: line.emotion, text: line.text, file: `${line.id}.mp3` });
    }
  }
  const manifest = { speaker, generatedAt: new Date().toISOString(), lines: availableLines };
  await writeFile(path.join(options.output, 'voice-manifest.json'), JSON.stringify(manifest, null, 2));
  // 同时输出一份 JS 版本：本地 file:// 页面不能用 fetch 读 JSON，可以用 <script> 加载
  await writeFile(path.join(options.output, 'voice-manifest.js'), `window.MEIQIU_VOICE_MANIFEST = ${JSON.stringify(manifest, null, 2)};\n`);

  const summary = { generated: 0, skipped: 0, failed: 0 };
  results.forEach(result => summary[result.status]++);
  console.log(`\n完成：新生成 ${summary.generated}，跳过 ${summary.skipped}，失败 ${summary.failed}`);
  if (summary.failed) process.exitCode = 1;
}

main().catch(error => {
  console.error(`出错了：${error.message}`);
  process.exitCode = 1;
});
