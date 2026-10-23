<template>
  <div v-if="draft" class="settings-page">
    <header>
      <h1>🐾 煤球 · 设置</h1>
      <span class="save-status" :class="saveStatus">{{ saveStatusText }}</span>
    </header>

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
      <div class="row">
        <label>
          <input v-model="draft.workHours.enabled" type="checkbox"> 只在工作时段提醒
        </label>
        <div class="control">
          <input v-model="draft.workHours.start" type="time" :disabled="!draft.workHours.enabled">
          <span>至</span>
          <input v-model="draft.workHours.end" type="time" :disabled="!draft.workHours.enabled">
        </div>
      </div>
      <div class="row column">
        <label>勿扰时段（例如午休）</label>
        <div v-for="(period, index) in draft.quietPeriods" :key="index" class="list-item">
          <input v-model="period.enabled" type="checkbox" title="启用">
          <input v-model="period.start" type="time">
          <span>至</span>
          <input v-model="period.end" type="time">
          <button class="link danger" @click="draft.quietPeriods.splice(index, 1)">删除</button>
        </div>
        <button v-if="draft.quietPeriods.length < 5" class="link" @click="addQuietPeriod">＋ 添加勿扰时段</button>
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
      <p class="hint">到点煤球会跑过来提醒，点"等一下嘛"会过一会儿再提醒，直到点"做完啦"。不受工作时段和勿扰时段限制。</p>
      <div v-for="(reminder, index) in draft.customReminders" :key="reminder.id" class="custom-reminder">
        <div class="list-item">
          <input v-model="reminder.enabled" type="checkbox" title="启用">
          <input v-model="reminder.time" type="time">
          <input v-model="reminder.title" class="title-input" maxlength="20" placeholder="标题，例如：下班打卡">
          <button class="link danger" @click="draft.customReminders.splice(index, 1)">删除</button>
        </div>
        <input v-model="reminder.message" class="message-input" maxlength="60" placeholder="煤球要说的话" @input="reminder.voiceLineId = null">
        <div class="weekdays">
          <button
            v-for="day in WEEKDAYS"
            :key="day.value"
            class="weekday"
            :class="{ selected: reminder.weekdays.includes(day.value) }"
            @click="toggleWeekday(reminder, day.value)"
          >{{ day.label }}</button>
        </div>
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
import { backendApi, type ActivityLevel, type AppSettings, type Chattiness, type CustomReminder, type MischiefLevel } from '../shared/backendApi';

const WEEKDAYS = [
  { value: 1, label: '一' }, { value: 2, label: '二' }, { value: 3, label: '三' }, { value: 4, label: '四' },
  { value: 5, label: '五' }, { value: 6, label: '六' }, { value: 7, label: '日' },
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

onMounted(async () => {
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
    time: '17:00',
    title: '',
    message: '喵～时间到啦！',
    weekdays: [1, 2, 3, 4, 5],
    voiceLineId: null,
  });
}

function toggleWeekday(reminder: CustomReminder, day: number): void {
  const index = reminder.weekdays.indexOf(day);
  if (index >= 0) reminder.weekdays.splice(index, 1);
  else reminder.weekdays.push(day);
  reminder.weekdays.sort((first, second) => first - second);
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
