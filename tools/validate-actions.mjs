// 检查动作库配置（public/config/cat-actions.json）有没有写错：
//   id 重复、触发时机 / 位置 / 姿势 / 能力 / 声音 / 姿势参数写错、条件名写错、台词分组没有语音等。
// 用法：node tools/validate-actions.mjs [配置文件路径]
// 新增或修改动作后跑一下，有错误会列出来并以非 0 状态退出。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const actionFile = process.argv[2] ?? path.join(projectRoot, 'public/config/cat-actions.json');
const manifestFile = path.join(projectRoot, 'public/voice/voice-manifest.json');

// 这些清单要和代码保持一致：actionSystem.ts（触发时机、姿势、条件）、CatBrain.runAbility（能力）、BlackCatModel.createDefaultPose（姿势参数）
const TRIGGERS = ['idle', 'pet', 'hug', 'hugEnd', 'teaser', 'scare', 'drink', 'goalReached', 'snooze', 'reminderIgnored', 'customDone', 'wakeUp', 'trick',
  'coverExposed', 'coverYanked', 'coverPartial', 'coverReturned', 'coverGone', 'windowDropped', 'rideSlow', 'rideFast', 'shakenOff', 'windowDragged', 'desktopCleared', 'windowPopped'];
const PLACES = ['floor', 'window', 'edge', 'anchored'];
const POSES = ['sit', 'stand', 'groom', 'stretch', 'rest', 'sleep', 'petted', 'happy', 'sulk', 'startled', 'dodge', 'scratch', 'yawn', 'observe', 'rolling', 'swat', 'hugged'];
const ABILITIES = ['wander', 'peek', 'patrol', 'roll', 'sleep', 'goEdge', 'flee', 'approachCursor', 'dodgeHop', 'pounceCursor', 'walkOnWindow', 'observe',
  'hopToOtherWindow', 'jumpDown', 'rehideHere', 'emerge', 'hideUnder', 'mischief:zoomies', 'mischief:pounce', 'mischief:occupyWindow', 'mischief:pushCup', 'mischief:follow'];
const SOUNDS = ['purr', 'knock', 'crash', 'boing', 'meow:call', 'meow:short', 'meow:question', 'meow:scared', 'meow:complain'];
const POSE_KEYS = ['stand', 'sit', 'lie', 'stretch', 'lifted', 'walkAmount', 'headYaw', 'headPitch', 'headRoll', 'eyeOpen', 'squint', 'pupilX', 'pupilY',
  'pupilWidth', 'earBack', 'earPerk', 'mouthOpen', 'tailLift', 'tailSwing', 'tailSpeed', 'tailWrap', 'groom', 'bounce', 'legKick', 'breathRate', 'crouch',
  'pawsOnLedge', 'airborne', 'knock', 'holdSign', 'wiggle', 'rollAngle', 'cupVisible', 'cupPush', 'special', 'special2', 'special3'];
const CONDITIONS = ['species', 'speciesNot', 'hasLegs', 'mood', 'routinePhase', 'activity', 'activityLevel', 'mischiefLevel', 'roamMode', 'timeBetween', 'weekday', 'intimacyAtLeast', 'intimacyBelow',
  'fullscreen', 'lowProfile', 'typing', 'cursorNearby', 'behavior', 'behaviorNot', 'quietMinutesAtLeast', 'chance'];
const ACTION_KEYS = ['id', 'name', 'trigger', 'where', 'when', 'weight', 'moodWeight', 'phaseWeight', 'activityLevelWeight', 'mischiefLevelWeight',
  'cooldownSeconds', 'maxPerHour', 'rejectsHold', 'steps', 'disabled'];
const STEP_KEYS = ['pose', 'seconds', 'tweak', 'animate', 'spin', 'face', 'say', 'text', 'float', 'burst', 'burstCount', 'sound', 'run'];
const FACES = ['cursor', 'user', 'away', 'random'];
const SPECIES = ['cat', 'hamster', 'shiba', 'goldfish'];

const errors = [];
const warnings = [];
const data = JSON.parse(fs.readFileSync(actionFile, 'utf8'));
const voiceGroups = new Set();
if (fs.existsSync(manifestFile)) {
  for (const line of JSON.parse(fs.readFileSync(manifestFile, 'utf8')).lines ?? []) { voiceGroups.add(line.group); voiceGroups.add(line.id); }
}

const seenIds = new Set();
const countByTrigger = Object.fromEntries(TRIGGERS.map(trigger => [trigger, 0]));
for (const action of data.actions ?? []) {
  const where = `动作 ${action.id ?? '(没有 id)'}`;
  if (!action.id) errors.push(`${where}：缺少 id`);
  if (seenIds.has(action.id)) errors.push(`${where}：id 重复`);
  seenIds.add(action.id);
  for (const key of Object.keys(action)) if (!ACTION_KEYS.includes(key)) errors.push(`${where}：不认识的字段 ${key}`);
  const triggers = Array.isArray(action.trigger) ? action.trigger : [action.trigger];
  for (const trigger of triggers) {
    if (!TRIGGERS.includes(trigger)) errors.push(`${where}：不认识的触发时机 ${trigger}`);
    else countByTrigger[trigger]++;
  }
  for (const place of action.where ?? []) if (!PLACES.includes(place)) errors.push(`${where}：不认识的位置 ${place}`);
  for (const key of Object.keys(action.when ?? {})) if (!CONDITIONS.includes(key)) errors.push(`${where}：不认识的条件 ${key}`);
  for (const species of [...(action.when?.species ?? []), ...(action.when?.speciesNot ?? [])]) {
    if (!SPECIES.includes(species)) errors.push(`${where}：不认识的动物 ${species}`);
  }
  if (typeof action.weight !== 'number' || action.weight < 0) errors.push(`${where}：weight 要是 0 或正数`);
  if (!Array.isArray(action.steps) || !action.steps.length) { errors.push(`${where}：没有步骤`); continue; }
  action.steps.forEach((step, index) => {
    const stepWhere = `${where} 第 ${index + 1} 步`;
    for (const key of Object.keys(step)) if (!STEP_KEYS.includes(key)) errors.push(`${stepWhere}：不认识的字段 ${key}`);
    if (step.pose && !POSES.includes(step.pose)) errors.push(`${stepWhere}：不认识的姿势 ${step.pose}`);
    if (step.run && !ABILITIES.includes(step.run)) errors.push(`${stepWhere}：不认识的能力 ${step.run}`);
    if (step.pose && step.run) errors.push(`${stepWhere}：pose 和 run 不能写在同一步`);
    if (step.run && index !== action.steps.length - 1) warnings.push(`${stepWhere}：run 之后的步骤不会执行（能力接管后动作就结束了）`);
    if (step.sound && !SOUNDS.includes(step.sound)) errors.push(`${stepWhere}：不认识的声音 ${step.sound}`);
    if (step.face && !FACES.includes(step.face)) errors.push(`${stepWhere}：不认识的转向 ${step.face}`);
    for (const key of [...Object.keys(step.tweak ?? {}), ...Object.keys(step.animate ?? {})]) {
      if (!POSE_KEYS.includes(key)) errors.push(`${stepWhere}：不认识的姿势参数 ${key}`);
    }
    if (step.say && voiceGroups.size && !voiceGroups.has(step.say)) warnings.push(`${stepWhere}：台词分组 ${step.say} 没有语音（会只显示 text 里的文字）`);
  });
  if (!action.steps.some(step => step.pose || step.run)) warnings.push(`${where}：没有姿势也没有能力，运行时会自动补一个"坐 2 秒"`);
}

console.log(`动作总数：${seenIds.size}`);
for (const species of SPECIES) {
  const hasLegs = species !== 'goldfish';
  const usable = (data.actions ?? []).filter(action => {
    const when = action.when ?? {};
    if (when.species && !when.species.includes(species)) return false;
    if (when.speciesNot && when.speciesNot.includes(species)) return false;
    if (when.hasLegs !== undefined && when.hasLegs !== hasLegs) return false;
    return true;
  });
  const own = usable.filter(action => action.when?.species?.length === 1).length;
  console.log(`  ${species}：能做 ${usable.length} 个动作（其中特有 ${own} 个）`);
  for (const trigger of TRIGGERS) {
    if (!usable.some(action => (Array.isArray(action.trigger) ? action.trigger : [action.trigger]).includes(trigger))) {
      warnings.push(`${species} 在触发时机 ${trigger} 一个动作都没有`);
    }
  }
}
console.log('各触发时机的动作数：', countByTrigger);
for (const trigger of TRIGGERS) if (!countByTrigger[trigger]) warnings.push(`触发时机 ${trigger} 一个动作都没有（会用代码里的保底反应）`);
warnings.forEach(message => console.log(`⚠ ${message}`));
errors.forEach(message => console.log(`❌ ${message}`));
console.log(errors.length ? `\n发现 ${errors.length} 个错误` : '\n✅ 没有错误');
process.exit(errors.length ? 1 : 0);
