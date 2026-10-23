// 行为模拟测试（只在开发时用，打开 http://localhost:1420/simulate.html）：
// 用一个假桌面（两个窗口）让猫的大脑以 30 帧/秒快速跑几个小时的"模拟时间"，
// 在不同心情、作息、位置下统计选了哪些动作，再逐个触发摸摸、抱抱、逗猫、吓唬、喝水等反应，
// 同时检查：有没有出错、位置有没有坏、有没有触发"卡住复位"。
import { CatBrain, type CatEffects } from '../pet/CatBrain';
import { DesktopLayout } from '../pet/DesktopLayout';
import { FreeSpaceMap } from '../pet/FreeSpaceMap';
import { PeekPlanner } from '../pet/PeekPlanner';
import { loadCatConfig, type RoutinePhase } from '../pet/catConfig';
import { actionLibrary, type ActionTrigger } from '../pet/actionSystem';
import type { DesktopLayoutPayload, MoodLevel, RoamMode } from '../shared/backendApi';

// ---- 模拟时钟：让冷却时间、新鲜度都按模拟时间算 ----
let simulatedMs = 0;
performance.now = () => simulatedMs;
const FRAME_SECONDS = 1 / 30;

const report: string[] = [];
const write = (line = '') => { report.push(line); document.getElementById('report')!.textContent = report.join('\n'); };

// ---- 假桌面：1920×1080，一个微信窗口（前台）、一个 VS Code 窗口 ----
const payload: DesktopLayoutPayload = {
  monitors: [{ id: 'monitor-1', bounds: { left: 0, top: 0, right: 1920, bottom: 1080 }, workArea: { left: 0, top: 0, right: 1920, bottom: 1040 }, scaleFactor: 1, isPrimary: true }],
  windows: [
    { id: 'chat', title: '微信', processName: 'WeChat.exe', bounds: { left: 300, top: 260, right: 900, bottom: 820 }, isMaximized: false, isFullscreen: false, monitorId: 'monitor-1', isForeground: true },
    { id: 'code', title: 'main.ts - Visual Studio Code', processName: 'Code.exe', bounds: { left: 1050, top: 200, right: 1800, bottom: 760 }, isMaximized: false, isFullscreen: false, monitorId: 'monitor-1', isForeground: false },
  ],
};

// ---- 假的界面效果：只记录调用次数 ----
const effectCounts = new Map<string, number>();
const countEffect = (name: string) => effectCounts.set(name, (effectCounts.get(name) ?? 0) + 1);
const effects: CatEffects = {
  say: () => countEffect('say'),
  sayLine: key => countEffect(`sayLine:${key}`),
  hideBubble: () => {},
  float: () => countEffect('float'),
  burst: () => countEffect('burst'),
  meow: () => countEffect('meow'),
  purr: () => countEffect('purr'),
  playSound: () => countEffect('sound'),
  reactToWindow: () => countEffect('reactToWindow'),
  announceMischief: kind => countEffect(`mischief:${kind}`),
};

async function main(): Promise<void> {
  await Promise.all([loadCatConfig(), actionLibrary.load()]);
  console.info = () => {}; // 动作日志太多，模拟时关掉
  const desktop = new DesktopLayout();
  desktop.update(payload);
  const freeSpaceMap = new FreeSpaceMap();
  freeSpaceMap.rebuild(desktop.workArea, desktop.getObstacles().map(obstacle => obstacle.rect));
  const brain = new CatBrain(freeSpaceMap, desktop, new PeekPlanner(desktop, freeSpaceMap), effects);
  brain.position = freeSpaceMap.cellCenter(freeSpaceMap.nearestFreeCell(1600, 950));
  brain.isReady = true;
  brain.setBehavior('sit', 1);
  brain.foregroundCategory = 'chat';

  // 统计：每个动作被选了几次、复位了几次、出错几次
  const actionCounts = new Map<string, number>();
  const originalMarkUsed = actionLibrary.markUsed.bind(actionLibrary);
  actionLibrary.markUsed = (id: string) => { actionCounts.set(id, (actionCounts.get(id) ?? 0) + 1); originalMarkUsed(id); };
  const recoverReasons: string[] = [];
  const originalRecover = brain.recover.bind(brain);
  brain.recover = (reason: string) => { recoverReasons.push(reason); originalRecover(reason); };
  let errorCount = 0;
  let invalidPositionFrames = 0;

  const run = (seconds: number) => {
    for (let frame = 0; frame < seconds / FRAME_SECONDS; frame++) {
      simulatedMs += FRAME_SECONDS * 1000;
      try {
        brain.update(FRAME_SECONDS);
        brain.buildTargetPose();
      } catch (error) {
        errorCount++;
        if (errorCount <= 5) write(`❌ 出错：${String(error)}`);
      }
      if (!Number.isFinite(brain.position.x) || !Number.isFinite(brain.position.y)) invalidPositionFrames++;
    }
  };

  const summarize = (title: string, before: Map<string, number>) => {
    const diff = [...actionCounts].map(([id, count]) => [id, count - (before.get(id) ?? 0)] as const).filter(([, count]) => count > 0)
      .sort((first, second) => second[1] - first[1]);
    const total = diff.reduce((sum, [, count]) => sum + count, 0);
    write(`【${title}】共 ${total} 个动作，${diff.length} 种：`);
    write('  ' + diff.map(([id, count]) => `${id}×${count}`).join('  '));
    write();
  };

  // ---- 场景一：不同心情、作息、位置下平时会做什么 ----
  const scenarios: { title: string; mood: MoodLevel; phase: RoutinePhase; roamMode: RoamMode; minutes: number; intimacy: number }[] = [
    { title: '上班中、心情一般、自由散步', mood: 'normal', phase: 'working', roamMode: 'free', minutes: 30, intimacy: 10 },
    { title: '心情很好、亲密度高', mood: 'happy', phase: 'working', roamMode: 'free', minutes: 20, intimacy: 90 },
    { title: '发脾气', mood: 'angry', phase: 'working', roamMode: 'free', minutes: 15, intimacy: 40 },
    { title: '午休', mood: 'normal', phase: 'lunch', roamMode: 'free', minutes: 15, intimacy: 40 },
    { title: '快下班', mood: 'normal', phase: 'almostOff', roamMode: 'free', minutes: 15, intimacy: 40 },
    { title: '待在原地模式', mood: 'normal', phase: 'working', roamMode: 'anchored', minutes: 10, intimacy: 40 },
    { title: '屏幕边缘模式', mood: 'normal', phase: 'working', roamMode: 'edge', minutes: 10, intimacy: 40 },
  ];
  for (const scenario of scenarios) {
    const before = new Map(actionCounts);
    brain.moodLevel = scenario.mood;
    brain.routinePhase = scenario.phase;
    brain.intimacy = scenario.intimacy;
    brain.setRoamMode(scenario.roamMode, false);
    run(scenario.minutes * 60);
    summarize(`${scenario.title}（模拟 ${scenario.minutes} 分钟）`, before);
  }
  brain.setRoamMode('free', false);
  brain.moodLevel = 'normal';
  brain.routinePhase = 'working';

  // ---- 场景二：逐个触发反应 ----
  const testTrigger = (title: string, trigger: ActionTrigger, action: () => unknown, times: number, mood: MoodLevel = 'normal') => {
    const before = new Map(actionCounts);
    brain.moodLevel = mood;
    const results: unknown[] = [];
    for (let index = 0; index < times; index++) {
      brain.peek = null;
      brain.setBehavior('sit', 10);
      run(.5);
      brain.cursor.x = brain.position.x + 120;
      brain.cursor.y = brain.position.y - 60;
      results.push(action());
      run(6);
    }
    const chosen = [...actionCounts].filter(([id, count]) => count > (before.get(id) ?? 0)).map(([id, count]) => `${id}×${count - (before.get(id) ?? 0)}`);
    write(`【${title}】（${trigger}，心情 ${mood}，${times} 次）→ ${chosen.join('  ') || '⚠ 没有选到动作'}` +
      (results.some(result => typeof result === 'boolean') ? `；返回 true 的次数：${results.filter(Boolean).length}` : ''));
  };
  brain.intimacy = 50;
  testTrigger('摸摸', 'pet', () => brain.pet(), 12);
  testTrigger('摸摸（发脾气）', 'pet', () => brain.pet(), 8, 'angry');
  testTrigger('抱抱', 'hug', () => { const isHugging = brain.startHug(); run(3); brain.endHug(); return isHugging; }, 8);
  testTrigger('抱抱（发脾气）', 'hug', () => { const isHugging = brain.startHug(); run(3); brain.endHug(); return isHugging; }, 6, 'angry');
  testTrigger('逗猫棒', 'teaser', () => brain.playWithTeaser(), 10, 'happy');
  testTrigger('喝水', 'drink', () => brain.drinkRecorded(false), 6);
  testTrigger('达标', 'goalReached', () => brain.drinkRecorded(true), 4);
  testTrigger('稍后提醒', 'snooze', () => brain.snooze(), 4);
  testTrigger('表演一个', 'trick', () => brain.performTrick(), 10, 'happy');
  testTrigger('吓唬（鼠标猛冲过去）', 'scare', () => {
    // 鼠标在 1/30 秒内从猫左边 300 像素直线冲到右边 300 像素
    const startX = brain.position.x - 300;
    for (let step = 0; step <= 10; step++) brain.recordCursorSample(startX + step * 60, brain.position.y - 40);
    run(FRAME_SECONDS);
    return brain.behavior === 'flee' || brain.behavior === 'startled' || brain.behavior === 'jumpPrep';
  }, 8);
  write();

  // ---- 场景三：补测条件比较特殊的动作（早上、加班、休息日、打字、各种软件、亲密度低、各种位置被吓……） ----
  const conditionalScenarios: { title: string; minutes: number; setup: () => void }[] = [
    { title: '刚上班', minutes: 15, setup: () => { brain.routinePhase = 'morning'; } },
    { title: '加班', minutes: 15, setup: () => { brain.routinePhase = 'overtime'; } },
    { title: '休息日', minutes: 15, setup: () => { brain.routinePhase = 'offDay'; } },
    { title: '你在打字', minutes: 10, setup: () => { brain.routinePhase = 'working'; brain.isUserTyping = true; } },
    { title: '写代码', minutes: 15, setup: () => { brain.isUserTyping = false; brain.foregroundCategory = 'code'; } },
    { title: '看视频', minutes: 10, setup: () => { brain.foregroundCategory = 'video'; } },
    { title: '网购', minutes: 15, setup: () => { brain.foregroundCategory = 'shopping'; } },
    { title: '闹别扭（grumpy）', minutes: 15, setup: () => { brain.foregroundCategory = 'chat'; brain.moodLevel = 'grumpy'; } },
    { title: '很久没理它（安静 40 分钟）', minutes: 40, setup: () => { brain.moodLevel = 'normal'; } },
  ];
  for (const scenario of conditionalScenarios) {
    const before = new Map(actionCounts);
    scenario.setup();
    run(scenario.minutes * 60);
    summarize(`${scenario.title}（模拟 ${scenario.minutes} 分钟）`, before);
  }
  brain.moodLevel = 'normal';
  brain.routinePhase = 'working';
  brain.foregroundCategory = 'chat';

  brain.intimacy = 5;
  testTrigger('摸摸（还不熟，亲密度 5）', 'pet', () => brain.pet(), 6);
  testTrigger('抱抱（还不熟）', 'hug', () => { const isHugging = brain.startHug(); run(2); brain.endHug(); return isHugging; }, 6);
  brain.intimacy = 90;
  testTrigger('摸摸（心情好、亲密度 90）', 'pet', () => brain.pet(), 12, 'happy');
  testTrigger('吓唬（亲密度 90，胆子大了）', 'scare', () => {
    const startX = brain.position.x - 300;
    for (let step = 0; step <= 10; step++) brain.recordCursorSample(startX + step * 60, brain.position.y - 40);
    run(FRAME_SECONDS);
  }, 10);
  brain.intimacy = 20;
  const dashPastCat = () => {
    const startX = brain.position.x - 300;
    for (let step = 0; step <= 10; step++) brain.recordCursorSample(startX + step * 60, brain.position.y - 40);
    run(FRAME_SECONDS);
  };
  testTrigger('吓唬（还不熟，会炸毛）', 'scare', dashPastCat, 10);
  testTrigger('睡觉时被吓', 'scare', () => { brain.setBehavior('sleep', 60); run(.2); dashPastCat(); }, 4);
  brain.setRoamMode('anchored', false);
  testTrigger('待在原地时被吓', 'scare', dashPastCat, 4);
  brain.setRoamMode('free', false);
  testTrigger('在窗口上被吓', 'scare', () => {
    brain.tryJumpOntoWindow(() => brain.setBehavior('sit', 30), 'chat');
    run(3);
    dashPastCat();
  }, 4);
  testTrigger('逗猫（发脾气）', 'teaser', () => brain.playWithTeaser(), 6, 'angry');
  brain.routinePhase = 'lunch';
  testTrigger('逗猫（午休犯困）', 'teaser', () => brain.playWithTeaser(), 6);
  brain.routinePhase = 'working';
  testTrigger('喝水（心情好）', 'drink', () => brain.drinkRecorded(false), 6, 'happy');
  testTrigger('提醒没人理', 'reminderIgnored', () => { brain.setBehavior('remindWaiting'); brain.reminderIgnored(); }, 6);
  testTrigger('定时提醒做完了', 'customDone', () => brain.customReminderDone(), 6);
  testTrigger('你回来了（把它吵醒）', 'wakeUp', () => { brain.setBehavior('sleep'); brain.wakeUp(); }, 10);
  // 全屏：把微信窗口改成全屏
  const fullscreenPayload: DesktopLayoutPayload = { ...payload, windows: payload.windows.map(window => window.id === 'chat'
    ? { ...window, bounds: { left: 0, top: 0, right: 1920, bottom: 1080 }, isMaximized: true, isFullscreen: true } : window) };
  desktop.update(fullscreenPayload);
  freeSpaceMap.rebuild(desktop.workArea, desktop.getObstacles().map(obstacle => obstacle.rect));
  brain.handleLayoutChange();
  const beforeFullscreen = new Map(actionCounts);
  run(10 * 60);
  summarize('全屏（模拟 10 分钟）', beforeFullscreen);
  desktop.update(payload);
  freeSpaceMap.rebuild(desktop.workArea, desktop.getObstacles().map(obstacle => obstacle.rect));
  brain.handleLayoutChange();
  run(30);

  // ---- 场景四：故意把位置弄坏，看能不能自动复位 ----
  const recoversBefore = recoverReasons.length;
  brain.position = { x: Number.NaN, y: Number.NaN };
  run(1);
  write(`【容错】位置被弄坏后：${recoverReasons.length > recoversBefore ? `✅ 自动复位（${recoverReasons[recoverReasons.length - 1]}），复位后位置 (${Math.round(brain.position.x)}, ${Math.round(brain.position.y)})` : '❌ 没有复位'}`);

  // ---- 总结 ----
  const neverChosen = [...new Set((await (await fetch('/config/cat-actions.json')).json()).actions.map((action: { id: string }) => action.id))]
    .filter(id => !actionCounts.has(id as string));
  write();
  write(`出错次数：${errorCount}　位置无效的帧数：${invalidPositionFrames}`);
  write(`卡住复位（不含故意弄坏那次）：${recoverReasons.length - 1} 次 ${recoverReasons.slice(0, -1).join('、')}`);
  write(`动作库 ${actionLibrary.count} 个，跑到过的 ${actionCounts.size} 个；没跑到的：${neverChosen.join('、') || '无'}`);
  write(`界面效果调用：${[...effectCounts].map(([name, count]) => `${name}×${count}`).join('  ')}`);
  (window as unknown as { simulationDone: boolean }).simulationDone = true;
}

void main().catch(error => write(`❌ 模拟中断：${String(error)}\n${error?.stack ?? ''}`));
