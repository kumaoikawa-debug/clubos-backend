/**
 * Content Engine V3 —— Evaluator: Specificity（文档 §九 specificity.eval.ts）
 *
 * 「具体度」评测：检测文案里的空话 / 模糊强调词（hedging + empty intensifiers），
 * 给出 0~1 的具体度评分（越高越具体、越有信息量）。
 *
 * 与 grounding.eval.ts 的分工：
 *   - grounding 管「数字/套话有没有事实出处」（硬事实边界）。
 *   - specificity 管「表述是否空泛」（软文风质量），两者互不重叠。
 *
 * 这是文档 §九 点名的 5 个 evaluator 之一，此前未独立成模块；本文件按 spec 字面补齐。
 * 纯函数、无外部依赖，可离线单测。
 */

/** 模糊强调词 / 空话（不指向任何具体事实，删掉也不损失信息） */
export const VAGUE_PHRASES = [
  '非常',
  '特别',
  '十分',
  '极其',
  '相当',
  '超',
  '超级',
  '绝绝子',
  '满满',
  '很',
  '挺',
  '蛮',
  '值得一提',
  '值得一提的是',
  '总的来说',
  '总之',
  '众所周知',
  '可以说',
  '一定程度上',
  '某种程度上',
  '不言而喻',
  '毋庸置疑',
  '众所周知的是',
  '不得不说',
  '说真的',
];

export interface SpecificityReport {
  /** 0~1，越高越具体 */
  score: number;
  /** 命中的空话及其出现次数 */
  vaguePhrases: { phrase: string; count: number }[];
  /** 参与统计的 token 数（粗略按中文字/词切分） */
  totalTokens: number;
}

function tokenize(text: string): string[] {
  const t = String(text ?? '').trim();
  if (!t) return [];
  // 中文按字、英文按词，统一用空白与标点切分后保留非空片段
  return t
    .split(/[\s，。、,.!！?？:：;；"'"'()（）·—\n\r]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 评测一段文案的具体度。
 * 空话次数占 token 比例越高，评分越低；最多扣到 0.4（保留底线，避免 0 分误杀）。
 */
export function evaluateSpecificity(text: string): SpecificityReport {
  const tokens = tokenize(text);
  const totalTokens = tokens.length;
  if (totalTokens === 0) {
    return { score: 0, vaguePhrases: [], totalTokens: 0 };
  }

  const lower = String(text ?? '').toLowerCase();
  const hits: Record<string, number> = {};
  for (const p of VAGUE_PHRASES) {
    const re = new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    const m = lower.match(re);
    if (m) hits[p] = m.length;
  }

  const vagueCount = Object.values(hits).reduce((a, b) => a + b, 0);
  const vaguePhrases = Object.entries(hits)
    .map(([phrase, count]) => ({ phrase, count }))
    .sort((a, b) => b.count - a.count);

  // 每处空话扣 0.15，封顶扣 0.6
  const penalty = Math.min(0.6, vagueCount * 0.15);
  const score = Math.max(0, Math.min(1, Math.round((1 - penalty) * 1000) / 1000));

  return { score, vaguePhrases, totalTokens };
}
