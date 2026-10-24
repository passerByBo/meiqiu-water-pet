<template>
  <div v-if="draft" class="settings-page">
    <header>
      <h1>{{ currentSpecies.icon }} {{ currentPetName }} · 设置</h1>
      <span class="save-status" :class="saveStatus">{{ saveStatusText }}</span>
    </header>

    <!-- 🐾 我的宠物 -->
    <section>
      <h2>🐾 我的宠物</h2>
      <div class="species-grid">
        <button v-for="species in SPECIES_LIST" :key="species.id" class="species-card" :class="{ selected: draft.petSpecies === species.id }"
                @click="draft.petSpecies = species.id">
          <span class="species-icon">{{ species.icon }}</span>
          <b>{{ draft.petNames[species.id] || species.defaultName }}</b>
          <span class="species-label">{{ species.label }}</span>
        </button>
      </div>
      <p class="hint">{{ currentSpecies.description }}</p>
      <div class="row">
        <label>给{{ currentSpecies.label }}起个名字</label>
        <div class="control">
          <input :value="draft.petNames[draft.petSpecies] ?? ''" class="name-input" maxlength="8" :placeholder="`默认叫${currentSpecies.defaultName}`"
                 @input="renamePet(($event.target as HTMLInputElement).value)">
        </div>
      </div>
      <div class="row column">
        <label>{{ currentPetName }}的外观</label>
        <div class="skin-grid">
          <button v-for="skin in currentSkins" :key="skin.id" class="skin-card" :class="{ selected: currentSkinId === skin.id }"
                  @click="chooseSkin(skin.id)">
            <span class="skin-swatch" :style="{ background: `linear-gradient(135deg, ${skin.swatch[0]} 0 60%, ${skin.swatch[1]} 60% 100%)` }"></span>
            <span>{{ skin.name }}</span>
          </button>
        </div>
      </div>
      <p class="hint">换宠物后，喝水记录、统计、设置、已解锁的装扮都还在；每只宠物的心情和亲密度各自记着，换回来时它还记得你。</p>
    </section>

    <!-- 🐱 关于你 -->
    <section>
      <h2>🐱 关于你</h2>
      <div class="row">
        <label>{{ currentPetName }}怎么称呼你</label>
        <div class="control">
          <input v-model="draft.ownerName" class="name-input" maxlength="8" placeholder="例如：小明（不填就叫你）">
        </div>
      </div>
      <p class="hint">称呼会出现在气泡文字里（例如"小明，该喝水啦"）。语音是提前录好的，所以语音里还是叫"你"。</p>
    </section>

    <!-- 🕘 作息 -->
    <section>
      <h2>🕘 作息</h2>
      <div class="row">
        <label>上下班时间</label>
        <div class="control">
          <input v-model="draft.workHours.start" type="time">
          <span>上班，</span>
          <input v-model="draft.workHours.end" type="time">
          <span>下班</span>
        </div>
      </div>
      <div class="row">
        <label>上班的日子</label>
        <div class="weekdays">
          <button v-for="day in WEEKDAYS" :key="day.value" class="weekday" :class="{ selected: draft.workWeekdays.includes(day.value) }"
                  @click="toggleDay(draft.workWeekdays, day.value)">{{ day.label }}</button>
        </div>
      </div>
      <div class="row">
        <label><input v-model="draft.lunchBreak.enabled" type="checkbox"> 午休</label>
        <div class="control">
          <input v-model="draft.lunchBreak.start" type="time" :disabled="!draft.lunchBreak.enabled">
          <span>至</span>
          <input v-model="draft.lunchBreak.end" type="time" :disabled="!draft.lunchBreak.enabled">
        </div>
      </div>
      <div class="row">
        <label><input v-model="draft.workHours.enabled" type="checkbox"> 只在上班时间提醒喝水</label>
      </div>
      <p class="hint">{{ currentPetName }}会跟着你的作息走：上班时伸懒腰，午休陪你睡午觉（不提醒），快下班时很兴奋，下班后还在忙会催你回家。</p>
    </section>

    <!-- ⏰ 喝水提醒 -->
    <section>
      <h2>💧 喝水提醒</h2>
      <div class="row">
        <label>多久提醒一次</label>
        <div class="control">
          <input v-model.number="draft.remindIntervalMinutes" type="range" min="15" max="180" step="5">
          <span class="value">{{ draft.remindIntervalMinutes }} 分钟</span>
        </div>
      </div>
      <div class="row">
        <label>点"等一下嘛"后</label>
        <div class="control">
          <input v-model.number="draft.snoozeMinutes" type="range" min="5" max="30" step="1">
          <span class="value">{{ draft.snoozeMinutes }} 分钟后再提醒</span>
        </div>
      </div>
      <div class="row column">
        <label>其它勿扰时段（午休在上面的"作息"里设置）</label>
        <div v-for="(period, index) in draft.quietPeriods" :key="index" class="list-item">
          <input v-model="period.enabled" type="checkbox" title="启用">
          <input v-model="period.start" type="time">
          <span>至</span>
          <input v-model="period.end" type="time">
          <button class="link danger" @click="draft.quietPeriods.splice(index, 1)">删除</button>
        </div>
        <button v-if="draft.quietPeriods.length < 5" class="link" @click="addQuietPeriod">＋ 添加勿扰时段</button>
        <p v-if="!draft.quietPeriods.length" class="hint">暂时没有其它勿扰时段</p>
      </div>
      <div class="row">
        <label><input v-model="draft.fullscreenDoNotDisturb" type="checkbox"> 全屏时（看视频、放 PPT、打游戏）不打扰</label>
      </div>
      <div class="row">
        <label>离开电脑多久算"不在"</label>
        <div class="control">
          <input v-model.number="draft.awayThresholdMinutes" type="range" min="3" max="30" step="1">
          <span class="value">{{ draft.awayThresholdMinutes }} 分钟</span>
        </div>
      </div>
    </section>

    <!-- 📅 定时提醒 -->
    <section>
      <h2>📅 定时提醒</h2>
      <p class="hint">到点{{ currentPetName }}会跑过来举牌提醒，点"等一下嘛"会过一会儿再提醒，直到点"做完啦"。不受上班时间和勿扰时段限制。</p>
      <div v-for="(reminder, index) in draft.customReminders" :key="reminder.id" class="custom-reminder">
        <div class="list-item">
          <input v-model="reminder.enabled" type="checkbox" title="启用">
          <input v-model="reminder.title" class="title-input" maxlength="20" placeholder="标题，例如：下班打卡">
          <button class="link danger" @click="draft.customReminders.splice(index, 1)">删除</button>
        </div>
        <div class="list-item">
          <select v-model="reminder.mode">
            <option value="once">固定时间</option>
            <option value="beforeWorkEnd">跟着下班时间</option>
            <option value="repeat">时间段内重复</option>
          </select>
          <template v-if="reminder.mode === 'once'">
            <input v-model="reminder.time" type="time"> <span>提醒一次</span>
          </template>
          <template v-else-if="reminder.mode === 'beforeWorkEnd'">
            <span>下班前</span>
            <input v-model.number="reminder.minutesBeforeWorkEnd" type="number" min="0" max="240" step="5"> <span>分钟</span>
            <span class="hint-inline">（{{ beforeWorkEndTime(reminder.minutesBeforeWorkEnd) }}）</span>
          </template>
          <template v-else>
            <input v-model="reminder.time" type="time"> <span>至</span> <input v-model="reminder.endTime" type="time">
            <span>每</span>
            <input v-model.number="reminder.repeatIntervalMinutes" type="number" min="5" max="480" step="5"> <span>分钟</span>
          </template>
        </div>
        <input v-model="reminder.message" class="message-input" maxlength="60" :placeholder="`${currentPetName}要说的话`" @input="reminder.voiceLineId = null">
        <div class="list-item">
          <div class="weekdays">
            <button v-for="day in WEEKDAYS" :key="day.value" class="weekday" :class="{ selected: reminder.weekdays.includes(day.value) }"
                    @click="toggleDay(reminder.weekdays, day.value)">{{ day.label }}</button>
          </div>
          <span class="presets">
            <button v-for="preset in WEEKDAY_PRESETS" :key="preset.label" class="link" @click="reminder.weekdays = preset.days()">{{ preset.label }}</button>
          </span>
        </div>
        <p class="hint summary">{{ describeReminder(reminder) }}</p>
      </div>
      <button v-if="draft.customReminders.length < 10" class="link" @click="addCustomReminder">＋ 添加定时提醒</button>
    </section>

    <!-- 🥤 饮水 -->
    <section>
      <h2>🥤 饮水目标</h2>
      <div class="row">
        <label>每日目标</label>
        <div class="control">
          <input v-model.number="draft.dailyGoal" type="number" min="1" max="20"> 杯
          <span class="hint-inline">≈ {{ draft.dailyGoal * draft.cupVolumeMl }} ml</span>
        </div>
      </div>
      <div class="row">
        <label>每杯容量</label>
        <div class="control">
          <input v-model.number="draft.cupVolumeMl" type="number" min="50" max="1000" step="50"> ml
        </div>
      </div>
    </section>

    <!-- 🔊 声音 -->
    <section>
      <h2>🔊 声音</h2>
      <div class="row">
        <label>话多程度</label>
        <div class="control segmented">
          <button v-for="level in CHATTINESS_LEVELS" :key="level.value" :class="{ selected: draft.chattiness === level.value }"
                  @click="draft.chattiness = level.value">{{ level.label }}</button>
        </div>
      </div>
      <p class="hint">只影响闲聊（巡视点评、捣乱、心情）的频率；喝水提醒和你操作后的回应不受影响。</p>
      <div class="row">
        <label><input v-model="draft.voiceEnabled" type="checkbox"> 开启声音</label>
      </div>
      <div class="row">
        <label>声音模式</label>
        <div class="control">
          <select v-model="draft.voiceMode" :disabled="!draft.voiceEnabled">
            <option value="full">猫叫 + 说话</option>
            <option value="meowOnly">只有猫叫</option>
          </select>
        </div>
      </div>
      <div class="row">
        <label>音量</label>
        <div class="control">
          <input v-model.number="draft.voiceVolume" type="range" min="0" max="100" :disabled="!draft.voiceEnabled">
          <span class="value">{{ draft.voiceVolume }}%</span>
        </div>
      </div>
    </section>

    <!-- 🐾 散步 -->
    <section>
      <h2>🐾 外观与散步</h2>
      <div class="row">
        <label>猫咪大小</label>
        <div class="control segmented">
          <button v-for="size in CAT_SIZES" :key="size" :class="{ selected: draft.catSizePercent === size }"
                  @click="draft.catSizePercent = size">{{ size }}%</button>
        </div>
      </div>
      <div class="row">
        <label>启动时的散步模式</label>
        <div class="control">
          <select v-model="draft.defaultRoamMode">
            <option value="free">自由散步</option>
            <option value="anchored">待在原地</option>
            <option value="edge">在屏幕边缘溜达</option>
          </select>
        </div>
      </div>
      <div class="row">
        <label>活跃度</label>
        <div class="control segmented">
          <button v-for="level in ACTIVITY_LEVELS" :key="level.value" :class="{ selected: draft.activityLevel === level.value }"
                  @click="draft.activityLevel = level.value">{{ level.label }}</button>
        </div>
      </div>
      <div class="row">
        <label>捣乱程度</label>
        <div class="control segmented">
          <button v-for="level in MISCHIEF_LEVELS" :key="level.value" :class="{ selected: draft.mischiefLevel === level.value }"
                  @click="draft.mischiefLevel = level.value">{{ level.label }}</button>
        </div>
      </div>
      <p class="hint">捣乱：满屏乱跑、扑你的鼠标、霸占你的窗口、把小杯子推下去……开会和全屏时不会捣乱。</p>
      <div class="row">
        <label><input v-model="draft.scareEnabled" type="checkbox"> 鼠标猛冲过去会吓跑它</label>
      </div>
    </section>

    <!-- 🎀 装扮 -->
    <section>
      <h2>🎀 装扮</h2>
      <p class="hint">好好喝水就能解锁新装扮，解锁后会自动穿上，也可以在这里换。</p>
      <div class="rewards">
        <div class="reward" :class="{ selected: draft.equippedAccessory === 'none' }">
          <span class="reward-icon">🐈‍⬛</span>
          <div class="reward-text"><b>不穿装扮</b><span class="hint-inline">只戴红项圈小铃铛</span></div>
          <button class="small-button" :disabled="draft.equippedAccessory === 'none'" @click="draft.equippedAccessory = 'none'">
            {{ draft.equippedAccessory === 'none' ? '当前' : '换上' }}
          </button>
        </div>
        <div v-for="reward in rewardRules" :key="reward.id" class="reward" :class="{ selected: draft.equippedAccessory === reward.id, locked: !unlockedRewardIds.has(reward.id) }">
          <span class="reward-icon">{{ unlockedRewardIds.has(reward.id) ? reward.icon : '🔒' }}</span>
          <div class="reward-text">
            <b>{{ reward.name }}</b>
            <span class="hint-inline">{{ reward.description }}<template v-if="!unlockedRewardIds.has(reward.id)"> · {{ rewardProgress(reward) }}</template></span>
          </div>
          <button v-if="unlockedRewardIds.has(reward.id)" class="small-button" :disabled="draft.equippedAccessory === reward.id"
                  @click="draft.equippedAccessory = reward.id">{{ draft.equippedAccessory === reward.id ? '穿着' : '换上' }}</button>
        </div>
      </div>
    </section>

    <!-- ⚙ 系统 -->
    <section>
      <h2>⚙ 系统</h2>
      <div class="row">
        <label><input v-model="draft.launchAtStartup" type="checkbox"> 开机自动启动</label>
      </div>
    </section>

    <footer>
      <button class="secondary-button" @click="restoreDefaults">恢复默认设置</button>
      <button class="primary-button" @click="closeWindow">完成</button>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  backendApi, type ActivityLevel, type AppSettings, type Chattiness, type CustomReminder, type MischiefLevel, type Statistics,
} from '../shared/backendApi';
import { catConfig, loadCatConfig, type RewardRule } from '../pet/catConfig';
import { SPECIES_LIST, speciesInfo } from '../pet/species';
import { findSkin, SKINS } from '../pet/skins';

const WEEKDAYS = [
  { value: 1, label: '一' }, { value: 2, label: '二' }, { value: 3, label: '三' }, { value: 4, label: '四' },
  { value: 5, label: '五' }, { value: 6, label: '六' }, { value: 7, label: '日' },
];
/** 定时提醒的星期快捷选择 */
const WEEKDAY_PRESETS = [
  { label: '工作日', days: () => [1, 2, 3, 4, 5] },
  { label: '每天', days: () => [1, 2, 3, 4, 5, 6, 7] },
  { label: '周末', days: () => [6, 7] },
  { label: '同上班日', days: () => [...(draft.value?.workWeekdays ?? [1, 2, 3, 4, 5])] },
];
const ACTIVITY_LEVELS: { value: ActivityLevel; label: string }[] = [
  { value: 'calm', label: '安静' }, { value: 'normal', label: '正常' }, { value: 'lively', label: '活泼' },
];
const MISCHIEF_LEVELS: { value: MischiefLevel; label: string }[] = [
  { value: 'off', label: '不捣乱' }, { value: 'sometimes', label: '偶尔' }, { value: 'often', label: '经常' },
];
const CAT_SIZES = [60, 75, 90, 100];
const CHATTINESS_LEVELS: { value: Chattiness; label: string }[] = [
  { value: 'quiet', label: '安静' }, { value: 'normal', label: '适中' }, { value: 'chatty', label: '话多' },
];
const AUTO_SAVE_DELAY_MS = 500;

const draft = ref<AppSettings | null>(null);
const saveStatus = ref<'idle' | 'saving' | 'saved' | 'error'>('idle');
const saveErrorMessage = ref('');
let saveTimer: number | undefined;
let isApplyingFromBackend = false;

const saveStatusText = computed(() => ({
  idle: '修改后自动保存',
  saving: '保存中…',
  saved: '✓ 已保存',
  error: `保存失败：${saveErrorMessage.value}`,
}[saveStatus.value]));

// ---- 宠物 ----
const currentSpecies = computed(() => speciesInfo(draft.value?.petSpecies));
/** 现在这只宠物的名字（页面上的"煤球"都换成它） */
const currentPetName = computed(() => (draft.value?.petNames[draft.value.petSpecies] || '').trim() || currentSpecies.value.defaultName);

// ---- 皮肤（每种动物各记一套） ----
const currentSkins = computed(() => SKINS[currentSpecies.value.id]);
const currentSkinId = computed(() => findSkin(currentSpecies.value.id, draft.value?.petSkins?.[currentSpecies.value.id]).id);
function chooseSkin(skinId: string): void {
  if (!draft.value) return;
  draft.value.petSkins = { ...draft.value.petSkins, [currentSpecies.value.id]: skinId };
}

/** 改当前宠物的名字；清空就恢复默认名字 */
function renamePet(name: string): void {
  if (!draft.value) return;
  const names = { ...draft.value.petNames };
  if (name.trim()) names[draft.value.petSpecies] = name;
  else delete names[draft.value.petSpecies];
  draft.value.petNames = names;
}

// ---- 装扮 ----
const rewardRules = ref<RewardRule[]>([]);
const unlockedRewardIds = ref(new Set<string>());
const statistics = ref<Statistics | null>(null);

async function loadRewards(): Promise<void> {
  const [unlocked, latestStatistics] = await Promise.all([backendApi.getUnlockedRewards(), backendApi.getStatistics()]);
  unlockedRewardIds.value = new Set(unlocked.map(reward => reward.id));
  statistics.value = latestStatistics;
}

/** 还没解锁的装扮：显示进度，例如"已累计 1/3 天" */
function rewardProgress(reward: RewardRule): string {
  if (!statistics.value) return '';
  const parts: string[] = [];
  if (reward.goalDaysAtLeast !== undefined) parts.push(`已累计 ${Math.min(statistics.value.goalDaysTotal, reward.goalDaysAtLeast)}/${reward.goalDaysAtLeast} 天`);
  if (reward.streakAtLeast !== undefined) parts.push(`已连续 ${Math.min(statistics.value.streakDays, reward.streakAtLeast)}/${reward.streakAtLeast} 天`);
  return parts.join('，');
}

onMounted(async () => {
  await loadCatConfig();
  rewardRules.value = catConfig.rewards;
  void loadRewards();
  void backendApi.onRewardsChanged(() => void loadRewards());
  isApplyingFromBackend = true;
  draft.value = await backendApi.getSettings();
  // 托盘里切换了声音 / 开机自启时，同步到这个窗口
  void backendApi.onSettingsChanged(settings => {
    if (JSON.stringify(settings) === JSON.stringify(draft.value)) return;
    isApplyingFromBackend = true;
    draft.value = settings;
  });
});

// 任何修改都在停顿 0.5 秒后自动保存
watch(draft, () => {
  if (isApplyingFromBackend) {
    isApplyingFromBackend = false;
    return;
  }
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(saveSettings, AUTO_SAVE_DELAY_MS);
}, { deep: true });

async function saveSettings(): Promise<void> {
  if (!draft.value) return;
  saveStatus.value = 'saving';
  try {
    const savedSettings = await backendApi.updateSettings(draft.value);
    // 后端会把超出范围的值修正回来，以后端返回的为准
    if (JSON.stringify(savedSettings) !== JSON.stringify(draft.value)) {
      isApplyingFromBackend = true;
      draft.value = savedSettings;
    }
    saveStatus.value = 'saved';
  } catch (error) {
    saveErrorMessage.value = String(error);
    saveStatus.value = 'error';
  }
}

function addQuietPeriod(): void {
  draft.value?.quietPeriods.push({ enabled: true, start: '11:30', end: '13:00' });
}

function addCustomReminder(): void {
  draft.value?.customReminders.push({
    id: `custom-${Date.now()}`,
    enabled: true,
    mode: 'once',
    time: '15:00',
    endTime: '18:00',
    repeatIntervalMinutes: 60,
    minutesBeforeWorkEnd: 0,
    title: '',
    message: '喵～时间到啦！',
    weekdays: [...(draft.value?.workWeekdays ?? [1, 2, 3, 4, 5])],
    voiceLineId: null,
  });
}

/** 星期按钮：点一下选中，再点一下取消 */
function toggleDay(days: number[], day: number): void {
  const index = days.indexOf(day);
  if (index >= 0) days.splice(index, 1);
  else days.push(day);
  days.sort((first, second) => first - second);
}

const minutesOf = (time: string) => { const [hours, minutes] = time.split(':').map(Number); return hours * 60 + minutes; };
const formatMinutes = (total: number) => {
  const wrapped = ((total % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
};

/** "跟着下班时间"模式：算出实际几点提醒 */
function beforeWorkEndTime(minutesBefore: number): string {
  if (!draft.value) return '';
  return minutesBefore ? `也就是 ${formatMinutes(minutesOf(draft.value.workHours.end) - minutesBefore)}` : `下班那一刻 ${draft.value.workHours.end}`;
}

/** 用一句话说明这条提醒什么时候会响，例如"每个工作日 17:00 提醒一次" */
function describeReminder(reminder: CustomReminder): string {
  const days = reminder.weekdays;
  if (!days.length) return '⚠ 还没选哪几天提醒，这条提醒不会响';
  const isSameDays = (expected: number[]) => expected.length === days.length && expected.every(day => days.includes(day));
  const dayText = isSameDays([1, 2, 3, 4, 5, 6, 7]) ? '每天' : isSameDays([1, 2, 3, 4, 5]) ? '每个工作日' : isSameDays([6, 7]) ? '每个周末'
    : `每周${days.map(day => WEEKDAYS[day - 1].label).join('、')}`;
  const weeklyCount = (perDay: number) => `，一周 ${days.length * perDay} 次`;
  if (reminder.mode === 'beforeWorkEnd') {
    return `${dayText} ${beforeWorkEndTime(reminder.minutesBeforeWorkEnd).replace('也就是 ', '')} 提醒（改下班时间会跟着变）${weeklyCount(1)}`;
  }
  if (reminder.mode === 'repeat') {
    const span = minutesOf(reminder.endTime) - minutesOf(reminder.time);
    if (span <= 0) return '⚠ 结束时间要晚于开始时间';
    const timesPerDay = Math.ceil(span / Math.max(5, reminder.repeatIntervalMinutes));
    return `${dayText} ${reminder.time}～${reminder.endTime} 每 ${reminder.repeatIntervalMinutes} 分钟提醒，每天 ${timesPerDay} 次${weeklyCount(timesPerDay)}`;
  }
  return `${dayText} ${reminder.time} 提醒一次${weeklyCount(1)}`;
}

async function restoreDefaults(): Promise<void> {
  if (!window.confirm('确定要恢复所有默认设置吗？')) return;
  draft.value = await backendApi.getDefaultSettings();
}

async function closeWindow(): Promise<void> {
  window.clearTimeout(saveTimer);
  await saveSettings();
  await getCurrentWindow().close();
}
</script>

<style scoped>
.settings-page {
  font-family: "Microsoft YaHei UI", system-ui, sans-serif;
  color: #2b2b2b;
  padding: 16px 20px 20px;
  font-size: 13px;
}
header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}
h1 {
  font-size: 18px;
  margin: 0 0 8px;
}
.save-status { font-size: 12px; color: #999; }
.save-status.saved { color: #3a9a5b; }
.save-status.error { color: #d9534f; }
section {
  background: #fff;
  border: 1px solid #e8e5df;
  border-radius: 10px;
  padding: 12px 14px;
  margin: 12px 0;
}
h2 {
  font-size: 14px;
  margin: 0 0 8px;
}
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 6px 0;
}
.row.column {
  flex-direction: column;
  align-items: stretch;
}
.control {
  display: flex;
  align-items: center;
  gap: 6px;
}
.value {
  min-width: 70px;
  color: #3a7bd5;
}
.hint {
  color: #888;
  font-size: 12px;
  margin: 0 0 8px;
}
.hint-inline {
  color: #888;
  margin-left: 6px;
}
.list-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 0;
}
.custom-reminder {
  border: 1px dashed #e0ddd6;
  border-radius: 8px;
  padding: 8px;
  margin-bottom: 8px;
}
.title-input { flex: 1; }
.name-input { width: 190px; }
.species-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 8px; }
.species-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 10px 4px 8px;
  border: 2px solid #ece9e3;
  border-radius: 10px;
  background: #fff;
  cursor: pointer;
  font-family: inherit;
  color: inherit;
}
.species-card.selected { border-color: #4fb4f5; background: #f2f9ff; }
.species-icon { font-size: 28px; }
.species-label { color: #888; font-size: 12px; }
.skin-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
.skin-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: 2px solid #ece9e3;
  border-radius: 10px;
  background: #fff;
  cursor: pointer;
  font-family: inherit;
  color: inherit;
}
.skin-card.selected { border-color: #4fb4f5; background: #f2f9ff; }
.skin-swatch { width: 22px; height: 22px; border-radius: 50%; border: 1px solid rgba(0, 0, 0, .18); flex-shrink: 0; }
.presets { display: flex; gap: 8px; margin-left: auto; }
.summary { margin: 4px 0 0; color: #3a7bd5; }
.rewards { display: flex; flex-direction: column; gap: 6px; }
.reward {
  display: flex;
  align-items: center;
  gap: 10px;
  border: 1px solid #ece9e3;
  border-radius: 8px;
  padding: 6px 10px;
}
.reward.selected { border-color: #4fb4f5; background: #f2f9ff; }
.reward.locked { opacity: .65; }
.reward-icon { font-size: 22px; width: 28px; text-align: center; }
.reward-text { display: flex; flex-direction: column; flex: 1; }
.reward-text .hint-inline { margin-left: 0; font-size: 12px; }
.small-button {
  border: 1px solid #4fb4f5;
  background: #fff;
  color: #3a7bd5;
  border-radius: 6px;
  padding: 2px 10px;
  cursor: pointer;
  font-family: inherit;
}
.small-button:disabled { border-color: #ddd; color: #999; cursor: default; }
.message-input {
  width: 100%;
  box-sizing: border-box;
  margin: 4px 0;
}
.weekdays {
  display: flex;
  gap: 4px;
}
.weekday, .segmented button {
  border: 1px solid #ddd;
  background: #fafafa;
  border-radius: 6px;
  padding: 2px 8px;
  cursor: pointer;
  font-family: inherit;
}
.weekday.selected, .segmented button.selected {
  background: #4fb4f5;
  border-color: #4fb4f5;
  color: #fff;
}
input[type="number"] { width: 64px; }
input, select { font-family: inherit; font-size: 13px; }
.link {
  border: 0;
  background: none;
  color: #3a7bd5;
  cursor: pointer;
  padding: 2px 0;
  text-align: left;
  font-family: inherit;
}
.link.danger { color: #d9534f; margin-left: auto; }
footer {
  display: flex;
  justify-content: space-between;
  margin-top: 8px;
}
.primary-button, .secondary-button {
  border-radius: 8px;
  padding: 6px 18px;
  cursor: pointer;
  font-family: inherit;
}
.primary-button { background: #4fb4f5; color: #fff; border: 0; font-weight: bold; }
.secondary-button { background: #fff; border: 1px solid #ddd; color: #555; }
</style>
