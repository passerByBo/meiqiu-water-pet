// 声音：Web Audio 合成叫声（猫叫 / 仓鼠吱吱 / 柴犬汪汪 / 金鱼咕噜）+ 播放预生成的台词语音 + 系统语音兜底
// 每种动物有自己的一套预生成语音：猫在 public/voice/，其它动物在 public/voice/<种类>/
// 所有声音都经过"播放队列"：一次只放一个，重要的插队，过时的丢弃，避免互相打断或叠在一起
import { SPEAK_COOLDOWN_SECONDS } from './constants';
import type { VoiceMode } from '../shared/backendApi';
import { pickRandom } from '../shared/geometry';
import type { PetSpecies } from './species';
import { playGoldfishSound, playHamsterSound, playShibaSound } from './speciesSounds';

export type MeowKind = 'call' | 'short' | 'question' | 'scared' | 'complain';
/** 音效：敲窗户、杯子摔碎、跳跃 */
export type SoundEffect = 'knock' | 'crash' | 'boing';

/**
 * 优先级：
 *   high   —— 提醒、喝水、稍后提醒等：打断正在播放的低优先级声音，排到队首
 *   normal —— 普通台词：排队等候，等太久（过时）就丢弃；受说话冷却时间限制
 *   low    —— 呼噜、受惊的猫叫等小声音：有别的声音在播就直接跳过，不排队
 */
export type VoicePriority = 'high' | 'normal' | 'low';

export interface VoiceLine {
  id: string;
  group: string;
  count?: number;
  emotion: string;
  text: string;
  file: string;
}

interface MeowPreset {
  duration: number;
  startPitch: number;
  peakPitch: number;
  endPitch: number;
  volume: number;
}

/** 队列里的一项：可以只有猫叫、只有台词，或者先猫叫再说台词 */
interface VoiceTask {
  key: string;
  priority: VoicePriority;
  meowKind: MeowKind | null;
  line: VoiceLine | null;
  /** 没有预生成语音时的文字 */
  fallbackText: string;
  /** 没有预生成语音时，是否用系统语音念出 fallbackText（否则只猫叫 + 显示字幕） */
  shouldSpeakFallback: boolean;
  /** 呼噜声 */
  isPurr: boolean;
  createdAt: number;
  /** 真正开始播放时回调（用来同步显示字幕气泡），参数是预计时长（毫秒） */
  onStart?: (estimatedDurationMs: number) => void;
}

const MEOW_PRESETS: Record<MeowKind, MeowPreset> = {
  call:     { duration: .75, startPitch: 520, peakPitch: 860, endPitch: 430, volume: .22 }, // 提醒："喵～～"
  short:    { duration: .32, startPitch: 620, peakPitch: 900, endPitch: 560, volume: .18 }, // 打招呼："喵"
  question: { duration: .28, startPitch: 560, peakPitch: 640, endPitch: 980, volume: .16 }, // 被抓包："喵？"（尾音上扬）
  scared:   { duration: .38, startPitch: 900, peakPitch: 1300, endPitch: 700, volume: .2 }, // 被吓到："喵嗷！"
  complain: { duration: .55, startPitch: 480, peakPitch: 700, endPitch: 380, volume: .2 },  // 被拎起来
};
const PRIORITY_RANK: Record<VoicePriority, number> = { low: 0, normal: 1, high: 2 };
/** 普通台词排队超过这个时间就不说了（那个时刻已经过去） */
const STALE_TASK_MILLISECONDS = 3000;
const MAX_QUEUE_LENGTH = 3;
/** 猫叫和台词之间的停顿 */
const MEOW_TO_SPEECH_GAP_MILLISECONDS = 120;
/** 单个声音最长播放时间（防止某个声音卡住，整条队列都不动） */
const MAX_TASK_MILLISECONDS = 12_000;
const PURR_SECONDS = 1.6;
/** 记住最近说过的多少句台词，避免重复 */
const RECENT_LINE_MEMORY = 12;

class CatVoice {
  isEnabled = true;
  /** 开会时：完全不出声（台词只显示文字） */
  isQuietMode = false;
  mode: VoiceMode = 'full';
  /** 音量 0~1 */
  volume = .8;
  private audioContext: AudioContext | null = null;
  private voiceLines: VoiceLine[] = [];
  private queue: VoiceTask[] = [];
  private currentTask: VoiceTask | null = null;
  /** 用来作废正在播放的任务（被插队或静音时） */
  private playbackToken = 0;
  private currentAudio: HTMLAudioElement | null = null;
  private lastNormalSpeechTime = -Infinity;
  private recentLineIds: string[] = [];
  /** 现在是哪种动物（决定叫声和用哪套语音） */
  private species: PetSpecies = 'cat';
  /** 这种动物的语音文件夹 */
  private voiceFolder = '/voice';

  /**
   * 读取某种动物的预生成语音清单（猫：public/voice/voice-manifest.json；其它：public/voice/<种类>/voice-manifest.json）。
   * 这种动物还没有生成语音时，台词只显示文字（不会用别的动物的声音）
   */
  async loadManifest(species: PetSpecies = 'cat'): Promise<void> {
    this.stopAll();
    this.species = species;
    this.voiceFolder = species === 'cat' ? '/voice' : `/voice/${species}`;
    this.voiceLines = [];
    this.recentLineIds = [];
    try {
      const response = await fetch(`${this.voiceFolder}/voice-manifest.json`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const manifest = await response.json() as { lines: VoiceLine[] };
      this.voiceLines = manifest.lines ?? [];
    } catch (error) {
      console.warn(`没有找到${species}的预生成语音，台词只显示文字`, error);
    }
  }

  /** 按 id 或分组找一句台词（同组随机挑一句，尽量避开最近说过的；杯数类台词按 count 匹配） */
  pickLine(key: string, count?: number): VoiceLine | null {
    const lineById = this.voiceLines.find(line => line.id === key);
    if (lineById) return this.rememberLine(lineById);
    const candidates = this.voiceLines.filter(line => line.group === key && (count === undefined || line.count === count));
    if (!candidates.length) return null;
    const freshCandidates = candidates.filter(line => !this.recentLineIds.includes(line.id));
    return this.rememberLine(pickRandom(freshCandidates.length ? freshCandidates : candidates));
  }

  /** 这个分组有没有台词 */
  hasGroup(group: string): boolean {
    return this.voiceLines.some(line => line.group === group || line.id === group);
  }

  /** 按杯数区分的分组（例如"今天第三杯啦"）里有没有这个杯数的台词 */
  hasCountLine(group: string, count: number): boolean {
    return this.voiceLines.some(line => line.group === group && line.count === count);
  }

  /** 记住最近说过的台词，下次尽量不重复 */
  private rememberLine(line: VoiceLine): VoiceLine {
    this.recentLineIds = [line.id, ...this.recentLineIds.filter(id => id !== line.id)].slice(0, RECENT_LINE_MEMORY);
    return line;
  }

  // ---------------- 对外接口：都只是"加入队列" ----------------

  /** 说一句台词（可选先猫叫）；返回 false 表示这次不会出声（被丢弃或声音已关闭） */
  speak(options: {
    line: VoiceLine | null;
    fallbackText?: string;
    shouldSpeakFallback?: boolean;
    meowKind?: MeowKind | null;
    priority?: VoicePriority;
    onStart?: (estimatedDurationMs: number) => void;
  }): boolean {
    const key = options.line?.id ?? (options.fallbackText || options.meowKind || 'unknown');
    return this.enqueue({
      key,
      priority: options.priority ?? 'normal',
      meowKind: options.meowKind ?? null,
      line: options.line,
      fallbackText: options.fallbackText ?? '',
      shouldSpeakFallback: options.shouldSpeakFallback ?? false,
      isPurr: false,
      createdAt: performance.now(),
      onStart: options.onStart,
    });
  }

  meow(kind: MeowKind, priority: VoicePriority = 'low'): boolean {
    return this.enqueue({
      key: `meow-${kind}`, priority, meowKind: kind, line: null, fallbackText: '', shouldSpeakFallback: false,
      isPurr: false, createdAt: performance.now(),
    });
  }

  /** 现在能不能出声 */
  get canMakeSound(): boolean {
    return this.isEnabled && !this.isQuietMode && this.volume > 0;
  }

  /** 音效：很短，不进队列，直接播放（可以和台词同时响） */
  playEffect(kind: SoundEffect): void {
    if (!this.canMakeSound) return;
    const context = this.ensureAudioContext();
    const now = context.currentTime;
    const output = context.createGain();
    output.gain.value = this.volume;
    output.connect(context.destination);
    if (kind === 'knock') {
      // 敲窗户：两声短促的"咚咚"（低频正弦 + 快速衰减）
      for (const offset of [0, .16]) {
        const oscillator = context.createOscillator();
        const envelope = context.createGain();
        oscillator.frequency.setValueAtTime(220, now + offset);
        oscillator.frequency.exponentialRampToValueAtTime(110, now + offset + .08);
        envelope.gain.setValueAtTime(.5, now + offset);
        envelope.gain.exponentialRampToValueAtTime(.001, now + offset + .1);
        oscillator.connect(envelope).connect(output);
        oscillator.start(now + offset);
        oscillator.stop(now + offset + .12);
      }
    } else if (kind === 'crash') {
      // 杯子摔碎：一小段带高频的噪声
      const duration = .35;
      const buffer = context.createBuffer(1, Math.floor(context.sampleRate * duration), context.sampleRate);
      const samples = buffer.getChannelData(0);
      for (let index = 0; index < samples.length; index++) samples[index] = (Math.random() * 2 - 1) * Math.pow(1 - index / samples.length, 3);
      const noise = context.createBufferSource();
      noise.buffer = buffer;
      const highpass = context.createBiquadFilter();
      highpass.type = 'highpass';
      highpass.frequency.value = 1800;
      const envelope = context.createGain();
      envelope.gain.value = .35;
      noise.connect(highpass).connect(envelope).connect(output);
      noise.start(now);
    } else {
      // 跳跃：一声轻快的"啵～"（音高往上滑）
      const oscillator = context.createOscillator();
      const envelope = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(300, now);
      oscillator.frequency.exponentialRampToValueAtTime(700, now + .12);
      envelope.gain.setValueAtTime(.12, now);
      envelope.gain.exponentialRampToValueAtTime(.001, now + .15);
      oscillator.connect(envelope).connect(output);
      oscillator.start(now);
      oscillator.stop(now + .16);
    }
  }

  purr(): boolean {
    return this.enqueue({
      key: 'purr', priority: 'low', meowKind: null, line: null, fallbackText: '', shouldSpeakFallback: false,
      isPurr: true, createdAt: performance.now(),
    });
  }

  /** 关闭声音或静音时：清空队列并停止正在播放的声音 */
  stopAll(): void {
    this.queue = [];
    this.interruptCurrent();
  }

  // ---------------- 队列调度 ----------------

  private enqueue(task: VoiceTask): boolean {
    if (!this.canMakeSound) return false;
    const isBusy = this.currentTask !== null;
    // 小声音：有别的声音在播就跳过
    if (task.priority === 'low' && (isBusy || this.queue.length)) return false;
    // 普通台词：说话冷却时间内不再说，避免唠叨
    if (task.priority === 'normal' && performance.now() - this.lastNormalSpeechTime < SPEAK_COOLDOWN_SECONDS * 1000) return false;
    // 同一句已经在播或在排队：不重复
    if (this.currentTask?.key === task.key || this.queue.some(queued => queued.key === task.key)) return false;

    if (task.priority === 'high') {
      // 重要的声音：打断正在播放的低优先级声音，排到所有非重要任务前面
      if (this.currentTask && PRIORITY_RANK[this.currentTask.priority] < PRIORITY_RANK.high) this.interruptCurrent();
      const firstNonHighIndex = this.queue.findIndex(queued => queued.priority !== 'high');
      this.queue.splice(firstNonHighIndex < 0 ? this.queue.length : firstNonHighIndex, 0, task);
    } else {
      this.queue.push(task);
    }
    // 队列太长：丢掉最旧的非重要任务
    while (this.queue.length > MAX_QUEUE_LENGTH) {
      const droppableIndex = this.queue.findIndex(queued => queued.priority !== 'high');
      this.queue.splice(droppableIndex < 0 ? 0 : droppableIndex, 1);
    }
    if (!this.currentTask) void this.playNext();
    return this.queue.includes(task) || this.currentTask === task;
  }

  private interruptCurrent(): void {
    this.playbackToken++;
    this.currentAudio?.pause();
    this.currentAudio = null;
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    this.currentTask = null;
  }

  private async playNext(): Promise<void> {
    const now = performance.now();
    // 丢掉排队太久、已经过时的普通台词
    this.queue = this.queue.filter(task => task.priority === 'high' || now - task.createdAt < STALE_TASK_MILLISECONDS);
    const task = this.queue.shift();
    if (!task) return;
    this.currentTask = task;
    const token = ++this.playbackToken;
    if (task.priority === 'normal' && task.line) this.lastNormalSpeechTime = now;

    try {
      await this.withTimeout(this.playTask(task, token), MAX_TASK_MILLISECONDS);
    } catch (error) {
      console.warn('播放声音失败', error);
    }
    // 被插队或静音时，这个任务已经作废，由新的任务接管队列
    if (token !== this.playbackToken) return;
    this.currentTask = null;
    void this.playNext();
  }

  private async playTask(task: VoiceTask, token: number): Promise<void> {
    if (task.isPurr) {
      task.onStart?.(PURR_SECONDS * 1000);
      // 满足的声音：猫呼噜、仓鼠小声吱吱、柴犬哈哈喘气、金鱼咕噜咕噜冒泡
      if (this.species === 'cat') await this.synthesizePurr(PURR_SECONDS);
      else await this.playSpeciesSound('content');
      return;
    }
    const speechText = task.line?.text ?? (task.shouldSpeakFallback ? task.fallbackText : '');
    const willSpeak = this.mode === 'full' && !!speechText;
    if (task.meowKind) {
      // 只有猫叫、或者"只有猫叫"模式：字幕跟着猫叫一起出现
      if (!willSpeak) task.onStart?.(MEOW_PRESETS[task.meowKind].duration * 1000 + 1500);
      await this.playCall(task.meowKind);
      if (token !== this.playbackToken) return;
      if (willSpeak) await this.sleep(MEOW_TO_SPEECH_GAP_MILLISECONDS);
    } else if (!willSpeak) {
      task.onStart?.(2000);
      return;
    }
    if (!willSpeak || token !== this.playbackToken) return;
    if (task.line) await this.playAudioFile(task.line, task, token);
    else await this.speakWithSystemVoice(task.fallbackText, task);
  }

  // ---------------- 具体的发声方式（都返回"播放结束"的 Promise） ----------------

  private ensureAudioContext(): AudioContext {
    this.audioContext ??= new AudioContext();
    if (this.audioContext.state === 'suspended') void this.audioContext.resume();
    return this.audioContext;
  }

  /** 叫一声：按动物换成猫叫 / 吱吱 / 汪汪 / 咕噜 */
  private playCall(kind: MeowKind): Promise<void> {
    return this.species === 'cat' ? this.synthesizeMeow(kind) : this.playSpeciesSound(kind);
  }

  private playSpeciesSound(kind: MeowKind | 'content'): Promise<void> {
    const options = { context: this.ensureAudioContext(), volume: this.volume };
    if (this.species === 'hamster') return playHamsterSound(kind, options);
    if (this.species === 'shiba') return playShibaSound(kind, options);
    return playGoldfishSound(kind, options);
  }

  /** 合成一声猫叫：锯齿波经过共振峰滤波（"咿→啊→呜"的口型变化），音高先升后降，带轻微颤音 */
  private synthesizeMeow(kind: MeowKind): Promise<void> {
    const context = this.ensureAudioContext();
    const preset = MEOW_PRESETS[kind];
    const now = context.currentTime;
    const end = now + preset.duration;

    const oscillator = context.createOscillator();
    oscillator.type = 'sawtooth';
    oscillator.frequency.setValueAtTime(preset.startPitch, now);
    oscillator.frequency.linearRampToValueAtTime(preset.peakPitch, now + preset.duration * .35);
    oscillator.frequency.exponentialRampToValueAtTime(preset.endPitch, end);
    const vibrato = context.createOscillator();
    const vibratoDepth = context.createGain();
    vibrato.frequency.value = 7;
    vibratoDepth.gain.value = 12;
    vibrato.connect(vibratoDepth).connect(oscillator.frequency);

    const formant = context.createBiquadFilter();
    formant.type = 'bandpass';
    formant.Q.value = 3.5;
    formant.frequency.setValueAtTime(1900, now);
    formant.frequency.linearRampToValueAtTime(1250, now + preset.duration * .45);
    formant.frequency.linearRampToValueAtTime(750, end);

    const peakVolume = preset.volume * this.volume;
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0, now);
    envelope.gain.linearRampToValueAtTime(peakVolume, now + .05);
    envelope.gain.setValueAtTime(peakVolume * .85, now + preset.duration * .6);
    envelope.gain.linearRampToValueAtTime(0, end);

    oscillator.connect(formant).connect(envelope).connect(context.destination);
    oscillator.start(now);
    vibrato.start(now);
    oscillator.stop(end + .05);
    vibrato.stop(end + .05);
    return new Promise(resolve => { oscillator.onended = () => resolve(); });
  }

  /** 合成呼噜声：低沉的布朗噪声 + 每秒约 25 次的起伏 */
  private synthesizePurr(durationSeconds: number): Promise<void> {
    const context = this.ensureAudioContext();
    const now = context.currentTime;
    const sampleCount = Math.floor(context.sampleRate * durationSeconds);
    const noiseBuffer = context.createBuffer(1, sampleCount, context.sampleRate);
    const samples = noiseBuffer.getChannelData(0);
    let previous = 0;
    for (let index = 0; index < sampleCount; index++) {
      previous = (previous + (Math.random() * 2 - 1) * .08) * .98;
      samples[index] = previous * 3;
    }
    const noise = context.createBufferSource();
    noise.buffer = noiseBuffer;
    const lowpass = context.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 260;
    const tremolo = context.createGain();
    const tremoloOscillator = context.createOscillator();
    const tremoloDepth = context.createGain();
    tremoloOscillator.frequency.value = 25;
    tremoloDepth.gain.value = .5;
    tremolo.gain.value = .5;
    tremoloOscillator.connect(tremoloDepth).connect(tremolo.gain);
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0, now);
    envelope.gain.linearRampToValueAtTime(.5 * this.volume, now + .2);
    envelope.gain.linearRampToValueAtTime(0, now + durationSeconds);
    noise.connect(lowpass).connect(tremolo).connect(envelope).connect(context.destination);
    noise.start(now);
    tremoloOscillator.start(now);
    tremoloOscillator.stop(now + durationSeconds);
    return new Promise(resolve => { noise.onended = () => resolve(); });
  }

  /** 播放预生成的台词 mp3；文件缺失或播放失败时退回系统语音 */
  private playAudioFile(line: VoiceLine, task: VoiceTask, token: number): Promise<void> {
    return new Promise(resolve => {
      const audio = new Audio(`${this.voiceFolder}/${line.file}`);
      audio.volume = this.volume;
      this.currentAudio = audio;
      audio.addEventListener('ended', () => resolve(), { once: true });
      audio.addEventListener('pause', () => resolve(), { once: true });
      audio.addEventListener('loadedmetadata', () => task.onStart?.(audio.duration * 1000), { once: true });
      audio.play().catch(() => {
        if (token !== this.playbackToken) { resolve(); return; }
        void this.speakWithSystemVoice(line.text, task).then(resolve);
      });
    });
  }

  /** 系统语音兜底（没有预生成语音的台词，例如用户自己加的定时提醒） */
  private speakWithSystemVoice(text: string, task: VoiceTask): Promise<void> {
    const spokenText = text.replace(/[\p{Extended_Pictographic}️‍]/gu, '').trim();
    if (!('speechSynthesis' in window) || !spokenText) {
      task.onStart?.(2500);
      return Promise.resolve();
    }
    return new Promise(resolve => {
      speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(spokenText);
      utterance.lang = 'zh-CN';
      // 调高音调，更像小动物（仓鼠最尖，柴犬低一点）
      utterance.pitch = this.species === 'hamster' ? 2 : this.species === 'shiba' ? 1.4 : 1.7;
      utterance.volume = this.volume;
      utterance.onstart = () => task.onStart?.(spokenText.length * 220);
      utterance.onend = () => resolve();
      utterance.onerror = () => resolve();
      speechSynthesis.speak(utterance);
    });
  }

  private sleep(milliseconds: number): Promise<void> {
    return new Promise(resolve => window.setTimeout(resolve, milliseconds));
  }

  private withTimeout(promise: Promise<void>, milliseconds: number): Promise<void> {
    return Promise.race([promise, this.sleep(milliseconds)]);
  }
}

export const catVoice = new CatVoice();
