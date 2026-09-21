/**
 * 多 Creative Direction（§29 第四阶段 · 增强能力）
 *
 * 同一场活动可以有多个不同的「宣传切口」：风景 / 人物 / 挑战 / 性价比 / 疗愈 / 社交 / 技能 / 亲子。
 * 引擎根据 Creative Memory 自动选择「最近用得最少」的那个切口（自动选择不同宣传切口），
 * 避免同一俱乐部连续几场活动都从同一个角度切入。
 *
 * 实现取舍（§21）：切口集合是确定性的（不额外调 LLM），保证主链成本不变。
 */
import type { CreativeMemoryEntry } from '../creative-memory';

export interface Direction {
  key: string;
  label: string;
  /** 注入 Editorial Plan 的策划提示 */
  hint: string;
}

export const DIRECTIONS: Direction[] = [
  { key: 'scenery', label: '风景画面', hint: '从景色 / 自然画面切入：这条线最值得看的是什么风景、什么时刻最好看。' },
  { key: 'people', label: '人物故事', hint: '从人物 / 参与者切入：谁会来、他们在现场会是什么状态、有什么可讲的人。' },
  { key: 'challenge', label: '挑战与成就', hint: '从挑战感 / 成就感切入：难度、里程、爬升、完成它会得到什么。' },
  { key: 'value', label: '性价比', hint: '从价格 / 包含服务切入：花多少钱、包含什么、为什么值。' },
  { key: 'healing', label: '疗愈放松', hint: '从放松 / 疗愈切入：逃离城市、慢下来、身心恢复。' },
  { key: 'social', label: '社交同好', hint: '从同行伙伴 / 社交切入：和谁一起去、会遇到什么样的人。' },
  { key: 'skill', label: '技能学习', hint: '从能学到什么切入：技能、知识、体验上的增量。' },
  { key: 'family', label: '亲子家庭', hint: '从家庭 / 孩子切入：适不适合带娃、孩子能获得什么。' },
];

export function directionByKey(key: string): Direction | undefined {
  return DIRECTIONS.find((d) => d.key === key);
}

/**
 * 自动选择不同宣传切口：统计最近记忆里各切口的使用次数，选最少的那个。
 * 全部用过则回到最久未用的（记忆按时间倒序，取最早出现的方向）。
 */
export function pickDirection(recent: CreativeMemoryEntry[]): Direction {
  const counts = new Map<string, number>();
  (recent || []).forEach((e) => {
    if (e && e.direction) counts.set(e.direction, (counts.get(e.direction) || 0) + 1);
  });

  let best: Direction = DIRECTIONS[0];
  let bestCount = Number.POSITIVE_INFINITY;
  for (const d of DIRECTIONS) {
    const c = counts.get(d.key) || 0;
    if (c < bestCount) {
      bestCount = c;
      best = d;
    }
  }
  return best;
}
