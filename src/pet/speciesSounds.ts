// 各种动物的叫声（Web Audio 现场合成，不用音频文件）：
//   仓鼠："吱吱"——又高又短的几声颤音
//   柴犬："汪"——短促、带一点沙哑的叫声；开心时"哈哈"地喘气
//   金鱼："咕噜"——一串往上冒的泡泡声
// kind 和猫叫一样：call 提醒 / short 打招呼 / question 疑问 / scared 被吓到 / complain 不满
import type { MeowKind } from './catVoice';

interface SoundOptions {
  context: AudioContext;
  volume: number;
}

/** 等所有声音播完 */
const waitUntil = (context: AudioContext, endTime: number): Promise<void> =>
  new Promise(resolve => window.setTimeout(resolve, Math.max(0, (endTime - context.currentTime) * 1000) + 30));

/** 一小段白噪声（柴犬叫声的沙哑感、喘气声用） */
function createNoise(context: AudioContext, seconds: number): AudioBufferSourceNode {
  const buffer = context.createBuffer(1, Math.max(1, Math.floor(context.sampleRate * seconds)), context.sampleRate);
  const samples = buffer.getChannelData(0);
  for (let index = 0; index < samples.length; index++) samples[index] = Math.random() * 2 - 1;
  const noise = context.createBufferSource();
  noise.buffer = buffer;
  return noise;
}

// ---------------- 仓鼠：吱吱 ----------------

/** 一声"吱"：很高的正弦波，音高快速上下抖 */
function squeak(context: AudioContext, start: number, duration: number, basePitch: number, volume: number): void {
  const oscillator = context.createOscillator();
  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(basePitch, start);
  oscillator.frequency.linearRampToValueAtTime(basePitch * 1.25, start + duration * .4);
  oscillator.frequency.linearRampToValueAtTime(basePitch * .95, start + duration);
  const trill = context.createOscillator();
  const trillDepth = context.createGain();
  trill.frequency.value = 38;
  trillDepth.gain.value = basePitch * .06;
  trill.connect(trillDepth).connect(oscillator.frequency);
  const envelope = context.createGain();
  envelope.gain.setValueAtTime(0, start);
  envelope.gain.linearRampToValueAtTime(volume, start + .012);
  envelope.gain.linearRampToValueAtTime(0, start + duration);
  oscillator.connect(envelope).connect(context.destination);
  oscillator.start(start);
  trill.start(start);
  oscillator.stop(start + duration + .02);
  trill.stop(start + duration + .02);
}

export function playHamsterSound(kind: MeowKind | 'content', { context, volume }: SoundOptions): Promise<void> {
  const now = context.currentTime;
  // 每种情况吱几声、多高、多长
  const patterns: Record<MeowKind | 'content', { count: number; pitch: number; length: number; gap: number }> = {
    call: { count: 3, pitch: 2600, length: .09, gap: .05 },
    short: { count: 2, pitch: 2800, length: .07, gap: .05 },
    question: { count: 1, pitch: 2500, length: .16, gap: 0 },
    scared: { count: 4, pitch: 3400, length: .06, gap: .025 },
    complain: { count: 2, pitch: 2200, length: .14, gap: .06 },
    content: { count: 3, pitch: 2400, length: .05, gap: .09 },
  };
  const pattern = patterns[kind];
  let time = now;
  for (let index = 0; index < pattern.count; index++) {
    // 疑问：尾音往上扬
    const pitch = kind === 'question' ? pattern.pitch * 1.3 : pattern.pitch * (1 + (Math.random() - .5) * .08);
    squeak(context, time, pattern.length, pitch, .09 * volume);
    time += pattern.length + pattern.gap;
  }
  return waitUntil(context, time);
}

// ---------------- 柴犬：汪 ----------------

/** 一声"汪"：锯齿波 + 噪声经过共振峰（"沃→啊"的口型），音高先冲上去再落下，很短 */
function bark(context: AudioContext, start: number, duration: number, pitch: number, volume: number): void {
  const oscillator = context.createOscillator();
  oscillator.type = 'sawtooth';
  oscillator.frequency.setValueAtTime(pitch * .8, start);
  oscillator.frequency.linearRampToValueAtTime(pitch * 1.25, start + duration * .25);
  oscillator.frequency.exponentialRampToValueAtTime(pitch * .7, start + duration);
  const noise = createNoise(context, duration);
  const noiseGain = context.createGain();
  noiseGain.gain.value = .35;
  const formant = context.createBiquadFilter();
  formant.type = 'bandpass';
  formant.Q.value = 2.2;
  formant.frequency.setValueAtTime(700, start);
  formant.frequency.linearRampToValueAtTime(1300, start + duration * .3);
  formant.frequency.linearRampToValueAtTime(800, start + duration);
  const envelope = context.createGain();
  envelope.gain.setValueAtTime(0, start);
  envelope.gain.linearRampToValueAtTime(volume, start + .015);
  envelope.gain.exponentialRampToValueAtTime(.001, start + duration);
  oscillator.connect(formant);
  noise.connect(noiseGain).connect(formant);
  formant.connect(envelope).connect(context.destination);
  oscillator.start(start);
  noise.start(start);
  oscillator.stop(start + duration + .02);
}

/** 开心地"哈、哈、哈"喘气：一下一下的气声 */
function pant(context: AudioContext, start: number, count: number, volume: number): number {
  let time = start;
  for (let index = 0; index < count; index++) {
    const noise = createNoise(context, .14);
    const filter = context.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = index % 2 ? 1400 : 1900;   // 呼和吸的音色不一样
    filter.Q.value = 1.2;
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0, time);
    envelope.gain.linearRampToValueAtTime(volume, time + .03);
    envelope.gain.linearRampToValueAtTime(0, time + .13);
    noise.connect(filter).connect(envelope).connect(context.destination);
    noise.start(time);
    time += .18;
  }
  return time;
}

export function playShibaSound(kind: MeowKind | 'content', { context, volume }: SoundOptions): Promise<void> {
  const now = context.currentTime;
  if (kind === 'content') return waitUntil(context, pant(context, now, 6, .12 * volume));
  // 每种情况叫几声、多高、多长
  const patterns: Record<MeowKind, { count: number; pitch: number; length: number; gap: number }> = {
    call: { count: 2, pitch: 520, length: .16, gap: .12 },
    short: { count: 1, pitch: 560, length: .14, gap: 0 },
    question: { count: 1, pitch: 600, length: .2, gap: 0 },
    scared: { count: 3, pitch: 720, length: .1, gap: .05 },
    complain: { count: 1, pitch: 430, length: .35, gap: 0 },   // 不满：拖长的"呜——"
  };
  const pattern = patterns[kind];
  let time = now;
  for (let index = 0; index < pattern.count; index++) {
    bark(context, time, pattern.length, pattern.pitch * (1 + (Math.random() - .5) * .06), .22 * volume);
    time += pattern.length + pattern.gap;
  }
  return waitUntil(context, time);
}

// ---------------- 金鱼：咕噜咕噜 ----------------

/** 一个泡泡："啵"——正弦波音高快速往上滑 */
function bubble(context: AudioContext, start: number, size: number, volume: number): void {
  const oscillator = context.createOscillator();
  oscillator.type = 'sine';
  const basePitch = 260 + (1 - size) * 500;   // 小泡泡音高高
  oscillator.frequency.setValueAtTime(basePitch, start);
  oscillator.frequency.exponentialRampToValueAtTime(basePitch * 2.6, start + .07);
  const envelope = context.createGain();
  envelope.gain.setValueAtTime(0, start);
  envelope.gain.linearRampToValueAtTime(volume, start + .008);
  envelope.gain.exponentialRampToValueAtTime(.001, start + .09);
  oscillator.connect(envelope).connect(context.destination);
  oscillator.start(start);
  oscillator.stop(start + .1);
}

export function playGoldfishSound(kind: MeowKind | 'content', { context, volume }: SoundOptions): Promise<void> {
  const now = context.currentTime;
  const bubbleCounts: Record<MeowKind | 'content', number> = { call: 6, short: 3, question: 2, scared: 8, complain: 4, content: 5 };
  let time = now;
  for (let index = 0; index < bubbleCounts[kind]; index++) {
    bubble(context, time, Math.random(), (kind === 'scared' ? .16 : .12) * volume);
    time += kind === 'scared' ? .04 : .06 + Math.random() * .08;
  }
  return waitUntil(context, time + .1);
}
