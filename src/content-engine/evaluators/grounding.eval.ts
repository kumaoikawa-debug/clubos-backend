/**
 * Content Engine V3 —— Evaluator: Grounding（文档 §九 grounding.eval.ts）
 *
 * 「这句话里的数字/套话有没有事实出处」—— 全链路唯一的判据来源。
 *   - groundClaims：块级，把无据数字与禁用套话擦掉（Step 11）。
 *   - unsupportedNumbersIn：方向级，thesis/angle 里有编造数字就拒收整个方向。
 *   - tools/v3-audit.ts：验收侧复用同一判据，避免「审计通过 ≠ 引擎真这么判」的分叉。
 *
 * 原实现位于 steps/quality.ts，本次按文档 §九 拆为独立 evaluator 模块，
 * steps/quality.ts 仅做重新导出，调用方零改动。
 */

import type { ActivityTruth } from '../contracts/activityTruth';
import type { ContentBlock } from '../contracts/promoDocument';

/** 文档 §22 明令禁止出现在兜底文案里的套话 */
export const BANNED_PHRASES = [
  '名额有限',
  '手慢无',
  '私信我',
  '评论扣1',
  '群内接龙',
  '下一期正在安排',
  '大家都很开心',
  '逃离城市',
  '治愈',
  '松弛',
];

export interface GroundingViolation {
  blockId: string;
  reason: string;
  detail?: string;
}

/** 事实池：允许被陈述的所有原文片段 */
export function allowedFactTokens(truth: ActivityTruth): Set<string> {
  const f = truth.confirmedFacts;
  const raw: string[] = [];
  for (const v of [
    f.title,
    f.date,
    f.place,
    f.meeting,
    f.distance,
    f.elevation,
    f.difficulty,
  ]) {
    if (v) raw.push(String(v));
  }
  if (f.price !== undefined) raw.push(String(f.price));
  // 名额上限也是已确认事实 —— 漏了它，「限额 20 人」这种正常表述里的 20 会被当成编造删掉
  if (f.limit !== undefined) raw.push(String(f.limit));
  if (f.days) raw.push(String(f.days));
  raw.push(...truth.fee.include, ...truth.fee.exclude);
  raw.push(...truth.groundedScenes.map((s) => s.value));
  const tokens = new Set<string>();
  for (const r of raw) {
    for (const t of String(r).split(/[\s，。、,.:：;；()（）·—-]+/)) {
      if (t) tokens.add(t);
    }
  }
  return tokens;
}

/**
 * 「这句话里的数字有没有事实出处」—— 全局唯一判据。
 *
 * 返回原文里**每一个**未在事实池出现过的数字片段（保留重复，便于逐处擦除）。
 */
export function unsupportedNumbersIn(text: string, truth: ActivityTruth): string[] {
  const allowed = allowedFactTokens(truth);
  const out: string[] = [];
  for (const n of String(text ?? '').match(/\d+(\.\d+)?/g) ?? []) {
    if (!Array.from(allowed).some((t) => t.includes(n))) out.push(n);
  }
  return out;
}

/**
 * Step 11：Claim → Fact。
 * 两类问题必须拦下：
 *  1. 文案里出现事实池之外的数字（编造价钱/里程/天数/人数）
 *  2. 出现文档 §22 禁用套话
 */
export function groundClaims(
  blocks: ContentBlock[],
  truth: ActivityTruth
): { blocks: ContentBlock[]; violations: GroundingViolation[] } {
  const violations: GroundingViolation[] = [];

  const cleaned = blocks.map((b) => {
    let body = String(b.copy?.body ?? '');
    let headline = String(b.copy?.headline ?? '');
    let caption = String(b.copy?.caption ?? '');

    for (const phrase of BANNED_PHRASES) {
      if (body.includes(phrase) || headline.includes(phrase)) {
        violations.push({ blockId: b.id, reason: 'banned_phrase', detail: phrase });
        body = body.split(phrase).join('');
        headline = headline.split(phrase).join('');
      }
    }

    for (const n of unsupportedNumbersIn(`${headline} ${body}`, truth)) {
      violations.push({ blockId: b.id, reason: 'unsupported_number', detail: n });
      const re = new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
      body = body.replace(re, '');
      headline = headline.replace(re, '');
    }

    return {
      ...b,
      copy: {
        headline: headline.trim(),
        body: body.replace(/\s{2,}/g, ' ').trim(),
        caption: caption.trim(),
      },
    };
  });

  return { blocks: cleaned, violations };
}
