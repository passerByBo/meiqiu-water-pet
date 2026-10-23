// 作息：按设置里的上下班时间、上班的日子、午休，算出现在是一天里的哪个阶段，
// 并在阶段切换的那一刻发出事件（上班了、午休了、午休结束、快下班了、加班了……），让猫做出对应的反应
import { catConfig, type RoutinePhase } from './catConfig';
import type { AppSettings } from '../shared/backendApi';

/** 作息事件 */
export type RoutineEvent = 'workStart' | 'lunchStart' | 'lunchEnd' | 'almostOff' | 'overtime' | 'offDayHello';

/** 凌晨几点之前还算"昨天加班" */
const LATE_NIGHT_END_MINUTES = 5 * 60;
/** 休息日打开电脑多久后打个招呼 */
const OFF_DAY_HELLO_DELAY_MS = 10 * 60_000;

const minutesOf = (time: string): number => {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
};

export class DailyRoutine {
  phase: RoutinePhase = 'working';
  private previousPhase: RoutinePhase | null = null;
  private dateKey = '';
  private overtimeNudges = 0;
  private lastOvertimeNudgeTime = 0;
  private hasSaidOffDayHello = false;
  private readonly startedAt = Date.now();

  /** 算出现在的阶段 */
  computePhase(settings: AppSettings, now: Date): RoutinePhase {
    const routine = catConfig.routine;
    const weekday = now.getDay() === 0 ? 7 : now.getDay();
    const current = now.getHours() * 60 + now.getMinutes();
    if (!settings.workWeekdays.includes(weekday)) return 'offDay';
    const workStart = minutesOf(settings.workHours.start);
    const workEnd = minutesOf(settings.workHours.end);
    if (current < workStart) return current < LATE_NIGHT_END_MINUTES ? 'overtime' : 'beforeWork';
    if (current >= workEnd) return 'overtime';
    const lunch = settings.lunchBreak;
    if (lunch.enabled) {
      const lunchStart = minutesOf(lunch.start);
      const lunchEnd = minutesOf(lunch.end);
      if (current >= lunchStart && current < lunchEnd) return 'lunch';
      if (current >= lunchEnd && current < lunchEnd + routine.afternoonSlumpMinutes) return 'afternoonSlump';
    }
    if (current >= workEnd - routine.almostOffMinutes) return 'almostOff';
    if (current < workStart + routine.morningMinutes) return 'morning';
    return 'working';
  }

  /**
   * 每隔一会儿调用一次：更新阶段，返回刚刚发生的作息事件。
   * 只在程序开着、阶段真的"切换"时才发事件（刚启动时不补发，开场问候会处理）
   */
  update(settings: AppSettings, isUserActive: boolean, now = new Date()): RoutineEvent[] {
    const routine = catConfig.routine;
    const todayKey = now.toDateString();
    if (todayKey !== this.dateKey) {
      this.dateKey = todayKey;
      this.overtimeNudges = 0;
      this.hasSaidOffDayHello = false;
    }
    const phase = this.computePhase(settings, now);
    const previousPhase = this.previousPhase;
    this.phase = phase;
    this.previousPhase = phase;
    const events: RoutineEvent[] = [];
    if (previousPhase !== null && previousPhase !== phase) {
      if (previousPhase === 'beforeWork' && phase === 'morning') events.push('workStart');
      if (phase === 'lunch') events.push('lunchStart');
      if (previousPhase === 'lunch') events.push('lunchEnd');
      if (phase === 'almostOff') events.push('almostOff');
    }
    // 下班后还在用电脑：过一会儿催一次，之后隔一段时间再催，最多催几次
    if (phase === 'overtime' && isUserActive && this.overtimeNudges < routine.maxOvertimeNudges) {
      const workEnd = minutesOf(settings.workHours.end);
      const current = now.getHours() * 60 + now.getMinutes();
      const minutesAfterWork = current >= workEnd ? current - workEnd : current + 24 * 60 - workEnd;
      const isTimeToNudge = minutesAfterWork >= routine.overtimeAfterMinutes &&
        Date.now() - this.lastOvertimeNudgeTime >= routine.overtimeRepeatMinutes * 60_000;
      if (isTimeToNudge) {
        this.overtimeNudges++;
        this.lastOvertimeNudgeTime = Date.now();
        events.push('overtime');
      }
    }
    if (phase === 'offDay' && isUserActive && !this.hasSaidOffDayHello && Date.now() - this.startedAt > OFF_DAY_HELLO_DELAY_MS) {
      this.hasSaidOffDayHello = true;
      events.push('offDayHello');
    }
    return events;
  }
}
