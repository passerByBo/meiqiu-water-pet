<template>
  <div class="viz-root" @mousemove="moveTooltip">
    <div v-if="!statistics" class="loading">正在读取数据…</div>
    <template v-else>
      <header class="page-header">
        <h1>📊 喝水统计</h1>
        <div class="header-actions">
          <button class="toggle" :class="{ selected: isTableView }" @click="isTableView = !isTableView">
            {{ isTableView ? '看图表' : '看表格' }}
          </button>
        </div>
      </header>

      <!-- 今天：一个大数字 + 进度条 + 煤球的点评 -->
      <section class="card today-card">
        <div class="today-main">
          <div class="stat-label">今天</div>
          <div class="hero-figure">{{ statistics.today.cups }}<span class="hero-unit"> / {{ statistics.dailyGoal }} 杯</span></div>
          <div class="secondary-text">{{ statistics.today.volumeMl }} ml</div>
          <div class="meter" role="img" :aria-label="`今天完成 ${todayPercent}%`">
            <div class="meter-fill" :style="{ width: `${todayPercent}%` }"></div>
          </div>
        </div>
        <div class="cat-comment">
          <div class="mood-face">{{ moodFace }}</div>
          <div>
            <div class="comment-text">{{ catComment }}</div>
            <div v-if="mood" class="muted-text">心情 {{ moodLabel }} · 亲密度 {{ mood.intimacy }}</div>
          </div>
        </div>
      </section>

      <!-- 关键数字 -->
      <section class="tile-row">
        <div class="card tile">
          <div class="stat-label">连续达标</div>
          <div class="tile-value">{{ statistics.streakDays }} 天</div>
        </div>
        <div class="card tile">
          <div class="stat-label">最近 7 天达标</div>
          <div class="tile-value">{{ weekGoalDays }} / 7 天</div>
        </div>
        <div class="card tile">
          <div class="stat-label">最多的一天</div>
          <div class="tile-value">{{ statistics.bestDay ? `${statistics.bestDay.cups} 杯` : '—' }}</div>
          <div v-if="statistics.bestDay" class="muted-text">{{ formatDateLong(statistics.bestDay.date) }}</div>
        </div>
        <div class="card tile">
          <div class="stat-label">提醒后平均多久喝水</div>
          <div class="tile-value">{{ averageResponseText }}</div>
        </div>
      </section>

      <!-- 图表视图 -->
      <template v-if="!isTableView">
        <!-- 最近 7 天：柱状图 + 目标线 -->
        <section class="card">
          <h2>最近 7 天</h2>
          <svg class="chart" :viewBox="`0 0 ${WEEK_CHART.width} ${WEEK_CHART.height}`" role="img" aria-label="最近 7 天每天喝了几杯">
            <line v-for="tick in weekTicks" :key="`grid-${tick}`" class="gridline"
                  :x1="WEEK_CHART.left" :x2="WEEK_CHART.width - WEEK_CHART.right" :y1="weekY(tick)" :y2="weekY(tick)" />
            <text v-for="tick in weekTicks" :key="`tick-${tick}`" class="axis-text" text-anchor="end"
                  :x="WEEK_CHART.left - 8" :y="weekY(tick) + 4">{{ tick }}</text>
            <line class="goal-line" :x1="WEEK_CHART.left" :x2="WEEK_CHART.width - WEEK_CHART.right"
                  :y1="weekY(statistics.dailyGoal)" :y2="weekY(statistics.dailyGoal)" />
            <text class="goal-text" text-anchor="end" :x="WEEK_CHART.width - WEEK_CHART.right" :y="weekY(statistics.dailyGoal) - 6">目标 {{ statistics.dailyGoal }} 杯</text>
            <g v-for="(day, index) in statistics.lastSevenDays" :key="day.date">
              <!-- 比柱子大的透明感应区，方便鼠标悬停 -->
              <rect class="hit-area" :x="weekBandX(index)" :y="WEEK_CHART.top" :width="weekBandWidth" :height="weekPlotHeight"
                    @mouseenter="showTooltip(`${formatDateLong(day.date)} · ${day.cups} 杯（${day.volumeMl} ml）`)" @mouseleave="hideTooltip" />
              <path v-if="day.cups > 0" class="bar" :d="columnPath(weekBarX(index), weekY(day.cups), BAR_WIDTH, weekY(0))" />
              <text v-if="index === 6 || day.cups === weekMax" class="value-text" text-anchor="middle"
                    :x="weekBarX(index) + BAR_WIDTH / 2" :y="weekY(day.cups) - 6">{{ day.cups }}</text>
              <text class="axis-text" text-anchor="middle" :x="weekBarX(index) + BAR_WIDTH / 2" :y="WEEK_CHART.height - 6">
                {{ index === 6 ? '今天' : weekdayLabel(day.date) }}
              </text>
            </g>
            <line class="baseline" :x1="WEEK_CHART.left" :x2="WEEK_CHART.width - WEEK_CHART.right" :y1="weekY(0)" :y2="weekY(0)" />
          </svg>
        </section>

        <!-- 本月：日历热力图 -->
        <section class="card">
          <h2>{{ monthTitle }}</h2>
          <div class="calendar">
            <div v-for="label in WEEKDAY_LABELS" :key="label" class="calendar-head">{{ label }}</div>
            <div v-for="blank in monthLeadingBlanks" :key="`blank-${blank}`"></div>
            <div v-for="day in statistics.thisMonth" :key="day.date" class="calendar-cell"
                 :class="{ today: day.date === statistics.today.date }"
                 :style="{ background: heatColor(day.cups), color: heatInk(day.cups) }"
                 @mouseenter="showTooltip(`${formatDateLong(day.date)} · ${day.cups} 杯${day.cups >= statistics.dailyGoal ? ' ✓ 达标' : ''}`)"
                 @mouseleave="hideTooltip">
              {{ Number(day.date.slice(8)) }}
            </div>
          </div>
          <div class="scale-legend">
            <span class="muted-text">0 杯</span>
            <span v-for="(step, index) in HEAT_STEPS" :key="index" class="scale-swatch" :style="{ background: step }"></span>
            <span class="muted-text">达标</span>
          </div>
        </section>

        <!-- 一天中什么时候喝水 -->
        <section class="card">
          <h2>一天中什么时候喝水 <span class="muted-text">（最近 30 天）</span></h2>
          <svg class="chart" :viewBox="`0 0 ${HOUR_CHART.width} ${HOUR_CHART.height}`" role="img" aria-label="一天中每个小时喝水的杯数">
            <g v-for="(cups, hour) in visibleHours" :key="hour">
              <rect class="hit-area" :x="hourBandX(hour)" :y="HOUR_CHART.top" :width="hourBandWidth" :height="hourPlotHeight"
                    @mouseenter="showTooltip(`${hour + FIRST_HOUR}:00–${hour + FIRST_HOUR + 1}:00 · ${cups} 杯`)" @mouseleave="hideTooltip" />
              <path v-if="cups > 0" class="bar" :d="columnPath(hourBarX(hour), hourY(cups), HOUR_BAR_WIDTH, hourY(0))" />
              <text v-if="cups > 0 && cups === hourMax" class="value-text" text-anchor="middle"
                    :x="hourBarX(hour) + HOUR_BAR_WIDTH / 2" :y="hourY(cups) - 6">{{ cups }}</text>
              <text v-if="(hour + FIRST_HOUR) % 3 === 0" class="axis-text" text-anchor="middle"
                    :x="hourBarX(hour) + HOUR_BAR_WIDTH / 2" :y="HOUR_CHART.height - 6">{{ hour + FIRST_HOUR }}点</text>
            </g>
            <line class="baseline" :x1="HOUR_CHART.left" :x2="HOUR_CHART.width - HOUR_CHART.right" :y1="hourY(0)" :y2="hourY(0)" />
          </svg>
          <p v-if="peakHourText" class="secondary-text">{{ peakHourText }}</p>
        </section>

        <!-- 提醒响应：一条分段条 + 图例 -->
        <section class="card">
          <h2>最近 7 天的提醒 <span class="muted-text">（共 {{ statistics.reminderResponse.fired }} 次）</span></h2>
          <div v-if="statistics.reminderResponse.fired > 0">
            <div class="stacked-bar">
              <div v-for="segment in responseSegments" :key="segment.key" class="stacked-segment"
                   :style="{ flexGrow: segment.value, background: segment.color }"
                   @mouseenter="showTooltip(`${segment.label} ${segment.value} 次`)" @mouseleave="hideTooltip"></div>
            </div>
            <div class="legend">
              <span v-for="segment in responseSegments" :key="segment.key" class="legend-item">
                <span class="legend-swatch" :style="{ background: segment.color }"></span>{{ segment.label }} {{ segment.value }} 次
              </span>
            </div>
          </div>
          <p v-else class="secondary-text">还没有提醒记录。</p>
        </section>
      </template>

      <!-- 表格视图：所有数字都能直接读到 -->
      <section v-else class="card">
        <h2>本月每天</h2>
        <table class="data-table">
          <thead><tr><th>日期</th><th>杯数</th><th>水量</th><th>是否达标</th></tr></thead>
          <tbody>
            <tr v-for="day in [...statistics.thisMonth].reverse()" :key="day.date">
              <td>{{ formatDateLong(day.date) }}</td>
              <td class="number">{{ day.cups }}</td>
              <td class="number">{{ day.volumeMl }} ml</td>
              <td>{{ day.cups >= statistics.dailyGoal ? '✓ 达标' : '—' }}</td>
            </tr>
          </tbody>
        </table>
        <h2>提醒回应</h2>
        <table class="data-table">
          <tbody>
            <tr v-for="segment in responseSegments" :key="segment.key"><td>{{ segment.label }}</td><td class="number">{{ segment.value }} 次</td></tr>
          </tbody>
        </table>
      </section>

      <footer class="muted-text">
        一共陪伴了 {{ statistics.totalDays }} 天，喝了 {{ statistics.totalCups }} 杯水 · 数据只保存在这台电脑上
      </footer>
    </template>
    <div v-show="tooltipText" class="tooltip" :style="{ left: `${tooltipPosition.x + 14}px`, top: `${tooltipPosition.y + 14}px` }">{{ tooltipText }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { backendApi, type CatMoodSnapshot, type Statistics } from '../shared/backendApi';
import { adaptTextToSpecies, speciesInfo, type SpeciesInfo } from '../pet/species';

// ---------------- 图表尺寸与配色（配色来自经过色盲校验的参考调色板） ----------------
const WEEK_CHART = { width: 640, height: 230, top: 24, right: 12, bottom: 28, left: 36 };
const HOUR_CHART = { width: 640, height: 170, top: 22, right: 12, bottom: 26, left: 12 };
const BAR_WIDTH = 24;
const HOUR_BAR_WIDTH = 14;
const FIRST_HOUR = 6;           // 只显示 6 点到 23 点
const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'];
/** 热力图：单一蓝色从浅到深（0 杯用表面灰，最后一级表示达标） */
const HEAT_STEPS = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#1c5cab'];
const HEAT_EMPTY = 'var(--surface-2)';
/** 提醒回应的三段：分类色前三位（已通过色盲校验） */
const RESPONSE_COLORS = { drank: 'var(--series-1)', snoozed: 'var(--series-2)', ignored: 'var(--series-3)' };
const REFRESH_INTERVAL_MS = 60_000;

const statistics = ref<Statistics | null>(null);
const mood = ref<CatMoodSnapshot | null>(null);
/** 现在养的是哪种动物（点评的口吻和心情表情跟着它） */
const currentSpecies = ref<SpeciesInfo>(speciesInfo('cat'));
const isTableView = ref(false);
const tooltipText = ref('');
const tooltipPosition = ref({ x: 0, y: 0 });

async function loadData(): Promise<void> {
  const [statisticsResult, moodResult, settings] = await Promise.all([backendApi.getStatistics(), backendApi.getCatMood(), backendApi.getSettings()]);
  statistics.value = statisticsResult;
  mood.value = moodResult;
  currentSpecies.value = speciesInfo(settings.petSpecies);
}

onMounted(async () => {
  await loadData();
  void backendApi.onCatMoodChanged(snapshot => { mood.value = snapshot; });
  void backendApi.onSettingsChanged(settings => { currentSpecies.value = speciesInfo(settings.petSpecies); });
  window.addEventListener('focus', () => void loadData());
  window.setInterval(() => void loadData(), REFRESH_INTERVAL_MS);
});

// ---------------- 今天 ----------------
const todayPercent = computed(() => {
  if (!statistics.value) return 0;
  return Math.min(100, Math.round(statistics.value.today.cups / statistics.value.dailyGoal * 100));
});
const weekGoalDays = computed(() => statistics.value?.lastSevenDays.filter(day => day.cups >= statistics.value!.dailyGoal).length ?? 0);
const averageResponseText = computed(() => {
  const seconds = statistics.value?.reminderResponse.averageResponseSeconds;
  if (seconds == null) return '—';
  return seconds < 60 ? `${seconds} 秒` : `${Math.round(seconds / 60)} 分钟`;
});

const MOOD_FACES = { happy: '😸', normal: '🐱', grumpy: '😾', angry: '🙀' } as const;
const MOOD_LABELS = { happy: '很开心', normal: '还不错', grumpy: '在闹别扭', angry: '在发脾气' } as const;
// 猫有现成的各种心情猫脸；其它动物用它自己的图标，心情看旁边的文字
const moodFace = computed(() => {
  if (currentSpecies.value.id !== 'cat') return currentSpecies.value.icon;
  return mood.value ? MOOD_FACES[mood.value.level] : '🐱';
});
const moodLabel = computed(() => (mood.value ? MOOD_LABELS[mood.value.level] : ''));

/** 宠物根据真实数据说一句点评（台词按猫的口吻写，再换成现在这种动物的口吻） */
const catComment = computed(() => adaptTextToSpecies(catCommentText(), currentSpecies.value));
function catCommentText(): string {
  const data = statistics.value;
  if (!data) return '';
  const remaining = data.dailyGoal - data.today.cups;
  if (data.today.cups >= data.dailyGoal) return `今天已经达标啦！本喵宣布你是最棒的铲屎官～`;
  if (data.streakDays >= 3) return `已经连续达标 ${data.streakDays} 天了，今天还差 ${remaining} 杯，别断了哦！`;
  if (weekGoalDays.value >= 5) return `这周有 ${weekGoalDays.value} 天达标，本喵很满意～今天还差 ${remaining} 杯。`;
  if (data.reminderResponse.ignored > data.reminderResponse.drank) return `最近总是不理本喵的提醒……今天还差 ${remaining} 杯，哼！`;
  return `今天还差 ${remaining} 杯，本喵会盯着你的！`;
}

// ---------------- 最近 7 天柱状图 ----------------
const weekMax = computed(() => Math.max(...(statistics.value?.lastSevenDays.map(day => day.cups) ?? [0])));
const weekScaleMax = computed(() => {
  const highest = Math.max(weekMax.value, statistics.value?.dailyGoal ?? 8);
  return Math.ceil((highest + 1) / 2) * 2;
});
const weekTicks = computed(() => {
  const step = weekScaleMax.value > 10 ? 4 : 2;
  return Array.from({ length: Math.floor(weekScaleMax.value / step) + 1 }, (_, index) => index * step);
});
const weekPlotHeight = WEEK_CHART.height - WEEK_CHART.top - WEEK_CHART.bottom;
const weekBandWidth = (WEEK_CHART.width - WEEK_CHART.left - WEEK_CHART.right) / 7;
const weekY = (cups: number) => WEEK_CHART.top + weekPlotHeight * (1 - cups / weekScaleMax.value);
const weekBandX = (index: number) => WEEK_CHART.left + index * weekBandWidth;
const weekBarX = (index: number) => weekBandX(index) + (weekBandWidth - BAR_WIDTH) / 2;

// ---------------- 按小时柱状图 ----------------
const visibleHours = computed(() => statistics.value?.hourlyDistribution.slice(FIRST_HOUR) ?? []);
const hourMax = computed(() => Math.max(1, ...visibleHours.value));
const hourPlotHeight = HOUR_CHART.height - HOUR_CHART.top - HOUR_CHART.bottom;
const hourBandWidth = computed(() => (HOUR_CHART.width - HOUR_CHART.left - HOUR_CHART.right) / Math.max(1, visibleHours.value.length));
const hourY = (cups: number) => HOUR_CHART.top + hourPlotHeight * (1 - cups / hourMax.value);
const hourBandX = (index: number) => HOUR_CHART.left + index * hourBandWidth.value;
const hourBarX = (index: number) => hourBandX(index) + (hourBandWidth.value - HOUR_BAR_WIDTH) / 2;
const peakHourText = computed(() => {
  const hours = visibleHours.value;
  if (!hours.some(cups => cups > 0)) return '';
  const peakIndex = hours.indexOf(hourMax.value);
  return `你最常在 ${peakIndex + FIRST_HOUR} 点左右喝水。`;
});

/** 柱子：顶部 4px 圆角，底部贴着基线是直角 */
function columnPath(x: number, top: number, width: number, baseline: number): string {
  const radius = Math.min(4, (baseline - top) / 2, width / 2);
  return `M${x},${baseline} V${top + radius} Q${x},${top} ${x + radius},${top} H${x + width - radius} Q${x + width},${top} ${x + width},${top + radius} V${baseline} Z`;
}

// ---------------- 本月日历热力图 ----------------
const monthTitle = computed(() => {
  const firstDay = statistics.value?.thisMonth[0]?.date;
  return firstDay ? `${Number(firstDay.slice(5, 7))} 月` : '本月';
});
/** 1 号是星期几，前面要空几格（周一开头） */
const monthLeadingBlanks = computed(() => {
  const firstDay = statistics.value?.thisMonth[0]?.date;
  if (!firstDay) return 0;
  return (new Date(`${firstDay}T12:00:00`).getDay() + 6) % 7;
});
function heatLevel(cups: number): number {
  const goal = statistics.value?.dailyGoal ?? 8;
  if (cups <= 0) return -1;
  if (cups >= goal) return HEAT_STEPS.length - 1;
  return Math.min(HEAT_STEPS.length - 2, Math.floor(cups / goal * (HEAT_STEPS.length - 1)));
}
const heatColor = (cups: number) => (heatLevel(cups) < 0 ? HEAT_EMPTY : HEAT_STEPS[heatLevel(cups)]);
/** 格子里的日期数字：深色格子用白字，浅色格子用深色字 */
const heatInk = (cups: number) => (heatLevel(cups) >= 3 ? '#ffffff' : 'var(--text-primary)');

// ---------------- 提醒回应 ----------------
const responseSegments = computed(() => {
  const response = statistics.value?.reminderResponse;
  if (!response) return [];
  return [
    { key: 'drank', label: '喝了', value: response.drank, color: RESPONSE_COLORS.drank },
    { key: 'snoozed', label: '等一下', value: response.snoozed, color: RESPONSE_COLORS.snoozed },
    { key: 'ignored', label: '没理', value: response.ignored, color: RESPONSE_COLORS.ignored },
  ].filter(segment => segment.value > 0);
});

// ---------------- 日期格式与提示框 ----------------
function weekdayLabel(date: string): string {
  return `周${WEEKDAY_LABELS[(new Date(`${date}T12:00:00`).getDay() + 6) % 7]}`;
}
function formatDateLong(date: string): string {
  return `${Number(date.slice(5, 7))}月${Number(date.slice(8))}日 ${weekdayLabel(date)}`;
}
function showTooltip(text: string): void { tooltipText.value = text; }
function hideTooltip(): void { tooltipText.value = ''; }
function moveTooltip(event: MouseEvent): void { tooltipPosition.value = { x: event.clientX, y: event.clientY }; }
</script>

<style scoped>
.viz-root {
  color-scheme: light;
  --page: #f9f9f7;
  --surface-1: #fcfcfb;
  --surface-2: #f0efec;
  --text-primary: #0b0b0b;
  --text-secondary: #52514e;
  --text-muted: #898781;
  --gridline: #e1e0d9;
  --baseline: #c3c2b7;
  --border: rgba(11, 11, 11, .10);
  --series-1: #2a78d6;
  --series-2: #eb6834;
  --series-3: #1baf7a;
  --meter-track: #cde2fb;
  min-height: 100vh;
  background: var(--page);
  color: var(--text-primary);
  font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei UI", sans-serif;
  font-size: 13px;
  padding: 18px 22px 24px;
  box-sizing: border-box;
}
@media (prefers-color-scheme: dark) {
  .viz-root {
    color-scheme: dark;
    --page: #0d0d0d;
    --surface-1: #1a1a19;
    --surface-2: #2c2c2a;
    --text-primary: #ffffff;
    --text-secondary: #c3c2b7;
    --gridline: #2c2c2a;
    --baseline: #383835;
    --border: rgba(255, 255, 255, .10);
    --series-1: #3987e5;
    --series-2: #d95926;
    --series-3: #199e70;
    --meter-track: #184f95;
  }
}
.loading { padding: 40px; color: var(--text-secondary); }
.page-header { display: flex; align-items: center; justify-content: space-between; }
h1 { font-size: 18px; margin: 0; }
h2 { font-size: 14px; margin: 0 0 10px; font-weight: 600; }
.card {
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 14px 16px;
  margin-top: 12px;
}
.stat-label { color: var(--text-secondary); font-size: 12px; }
.secondary-text { color: var(--text-secondary); }
.muted-text { color: var(--text-muted); font-size: 12px; font-weight: normal; }
.toggle {
  border: 1px solid var(--border); background: var(--surface-1); color: var(--text-primary);
  border-radius: 8px; padding: 4px 12px; cursor: pointer; font-family: inherit;
}
/* 今天 */
.today-card { display: flex; gap: 24px; align-items: center; }
.today-main { flex: 1; }
.hero-figure { font-size: 52px; font-weight: 600; line-height: 1.1; }
.hero-unit { font-size: 18px; font-weight: normal; color: var(--text-secondary); }
.meter { height: 8px; border-radius: 4px; background: var(--meter-track); margin-top: 10px; overflow: hidden; }
.meter-fill { height: 100%; border-radius: 4px; background: var(--series-1); transition: width .4s; }
.cat-comment { flex: 1; display: flex; gap: 10px; align-items: center; }
.mood-face { font-size: 40px; }
.comment-text { line-height: 1.6; }
/* 关键数字 */
.tile-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
.tile-row .card { margin-top: 12px; }
.tile-value { font-size: 22px; font-weight: 600; margin-top: 4px; }
/* 图表 */
.chart { width: 100%; height: auto; display: block; }
.gridline { stroke: var(--gridline); stroke-width: 1; }
.baseline { stroke: var(--baseline); stroke-width: 1; }
.goal-line { stroke: var(--text-muted); stroke-width: 1; }
.goal-text, .axis-text { fill: var(--text-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.value-text { fill: var(--text-primary); font-size: 12px; font-weight: 600; }
.bar { fill: var(--series-1); }
.hit-area { fill: transparent; cursor: default; }
.hit-area:hover + .bar { opacity: .85; }
/* 日历 */
.calendar { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; max-width: 420px; }
.calendar-head { text-align: center; color: var(--text-muted); font-size: 11px; padding-bottom: 4px; }
.calendar-cell {
  height: 36px; border-radius: 4px; display: flex; align-items: center; justify-content: center;
  font-size: 12px; font-variant-numeric: tabular-nums;
}
.calendar-cell.today { box-shadow: 0 0 0 2px var(--surface-1), 0 0 0 4px var(--text-primary); }
.scale-legend { display: flex; align-items: center; gap: 2px; margin-top: 10px; }
.scale-legend .muted-text { margin: 0 6px; }
.scale-swatch { width: 22px; height: 10px; border-radius: 2px; }
/* 分段条 + 图例 */
.stacked-bar { display: flex; gap: 2px; height: 14px; border-radius: 4px; overflow: hidden; }
.stacked-segment { min-width: 4px; }
.legend { display: flex; gap: 16px; margin-top: 10px; color: var(--text-secondary); }
.legend-item { display: flex; align-items: center; gap: 6px; }
.legend-swatch { width: 10px; height: 10px; border-radius: 2px; }
/* 表格 */
.data-table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
.data-table th, .data-table td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--gridline); }
.data-table th { color: var(--text-secondary); font-weight: 600; }
.data-table .number { font-variant-numeric: tabular-nums; }
footer { margin-top: 16px; text-align: center; }
/* 提示框 */
.tooltip {
  position: fixed; pointer-events: none; z-index: 10;
  background: var(--text-primary); color: var(--surface-1);
  padding: 5px 9px; border-radius: 6px; font-size: 12px; white-space: nowrap;
}
</style>
