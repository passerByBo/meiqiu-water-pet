// 按情境选台词分组：读取配置里某个情境的规则，挑出条件都满足的，按权重随机选一个
import { catConfig, type DialogueConditions, type DialogueRule } from './catConfig';

/** 判断规则条件需要的信息（只填当前情境用得到的） */
export interface DialogueContext {
  now?: Date;
  activity?: string;
  mood?: string;
  reason?: string;
  style?: string;
  escalationLevel?: number;
  cupsToday?: number;
  dailyGoal?: number;
  expectedCups?: number;
  hadReminder?: boolean;
  responseSeconds?: number;
  yesterdayReached?: boolean;
  hasHistory?: boolean;
  streakDays?: number;
}

const minutesOf = (time: string): number => {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
};

/** 当前时间是否在时间段里（支持跨午夜） */
function isWithinTime([start, end]: [string, string], now: Date): boolean {
  const current = now.getHours() * 60 + now.getMinutes();
  const startMinutes = minutesOf(start);
  const endMinutes = minutesOf(end);
  return startMinutes <= endMinutes ? current >= startMinutes && current < endMinutes : current >= startMinutes || current < endMinutes;
}

function matchesConditions(conditions: DialogueConditions | undefined, context: DialogueContext): boolean {
  if (!conditions) return true;
  const now = context.now ?? new Date();
  const cups = context.cupsToday ?? 0;
  const goal = context.dailyGoal ?? 8;
  const remaining = goal - cups;
  const deficit = (context.expectedCups ?? cups) - cups;
  const weekday = now.getDay() === 0 ? 7 : now.getDay();
  const checks: [unknown, () => boolean][] = [
    [conditions.timeBetween, () => isWithinTime(conditions.timeBetween!, now)],
    [conditions.weekday, () => conditions.weekday!.includes(weekday)],
    [conditions.activity, () => !!context.activity && conditions.activity!.includes(context.activity)],
    [conditions.mood, () => !!context.mood && conditions.mood!.includes(context.mood)],
    [conditions.reason, () => !!context.reason && conditions.reason!.includes(context.reason)],
    [conditions.style, () => !!context.style && conditions.style!.includes(context.style)],
    [conditions.escalationLevelAtLeast, () => (context.escalationLevel ?? 0) >= conditions.escalationLevelAtLeast!],
    [conditions.deficitAtLeast, () => deficit >= conditions.deficitAtLeast!],
    [conditions.deficitAtMost, () => deficit <= conditions.deficitAtMost!],
    [conditions.remainingCups, () => remaining >= conditions.remainingCups![0] && remaining <= conditions.remainingCups![1]],
    [conditions.cupsAtLeast, () => cups >= conditions.cupsAtLeast!],
    [conditions.goalReached, () => (cups >= goal) === conditions.goalReached],
    [conditions.justReachedGoal, () => (cups === goal) === conditions.justReachedGoal],
    [conditions.cupsAboveGoal, () => (cups > goal) === conditions.cupsAboveGoal],
    [conditions.isHalfway, () => (cups === Math.ceil(goal / 2)) === conditions.isHalfway],
    [conditions.hadReminder, () => !!context.hadReminder === conditions.hadReminder],
    [conditions.responseSecondsAtMost, () => context.responseSeconds !== undefined && context.responseSeconds <= conditions.responseSecondsAtMost!],
    [conditions.responseSecondsAtLeast, () => context.responseSeconds !== undefined && context.responseSeconds >= conditions.responseSecondsAtLeast!],
    [conditions.yesterdayReached, () => context.yesterdayReached === conditions.yesterdayReached],
    [conditions.hasHistory, () => !!context.hasHistory === conditions.hasHistory],
    [conditions.streakAtLeast, () => (context.streakDays ?? 0) >= conditions.streakAtLeast!],
  ];
  return checks.every(([condition, check]) => condition === undefined || check());
}

/** 把 {remaining} 这类占位符换成实际值 */
function resolveGroupName(rule: DialogueRule, context: DialogueContext): string {
  const remaining = Math.max(1, (context.dailyGoal ?? 8) - (context.cupsToday ?? 0));
  return rule.group.replace('{remaining}', String(Math.min(remaining, 8)));
}

/**
 * 选一个台词分组：在命中的规则里按权重随机抽。
 * hasLines 用来排除还没有台词（或语音）的分组；一个都没命中时返回 null
 */
export function chooseDialogueGroup(situation: string, context: DialogueContext, hasLines: (group: string) => boolean): string | null {
  const candidates = (catConfig.situations[situation] ?? [])
    .filter(rule => rule.weight > 0 && matchesConditions(rule.when, context))
    .map(rule => ({ group: resolveGroupName(rule, context), weight: rule.weight }))
    .filter(candidate => hasLines(candidate.group));
  if (!candidates.length) return null;
  const totalWeight = candidates.reduce((sum, candidate) => sum + candidate.weight, 0);
  let roll = Math.random() * totalWeight;
  for (const candidate of candidates) {
    roll -= candidate.weight;
    if (roll <= 0) return candidate.group;
  }
  return candidates[candidates.length - 1].group;
}
