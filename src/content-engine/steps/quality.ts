/**
 * Content Engine V3 —— Workflow 步骤 Step 11~13
 * Step 11 groundClaims / Step 12 buildFingerprint+evaluateSimilarity / Step 13 repairDocument
 *
 * 文档 §22 + §八：
 *  - 无依据 claim 必须为 0（文档 §24 指标 Grounding）。
 *  - Repair 最多 2 次，禁止无限重试。
 */

import type { ActivityTruth } from '../contracts/activityTruth';
import type { ContentBlock } from '../contracts/promoDocument';
import {
  buildCreativeFingerprint,
  structureSimilarity,
  visualSimilarity,
  type CreativeFingerprint,
} from '../contracts/fingerprints';

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
 * Step 11：Claim → Fact。
 * 两类问题必须拦下：
 *  1. 文案里出现事实池之外的数字（编造价钱/里程/天数/人数）
 *  2. 出现文档 §22 禁用套话
 */
export function groundClaims(
  blocks: ContentBlock[],
  truth: ActivityTruth
): { blocks: ContentBlock[]; violations: GroundingViolation[] } {
  const allowed = allowedFactTokens(truth);
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

    const nums = `${headline} ${body}`.match(/\d+(\.\d+)?/g) ?? [];
    for (const n of nums) {
      const unitOk = Array.from(allowed).some((t) => t.includes(n));
      if (!unitOk) {
        violations.push({ blockId: b.id, reason: 'unsupported_number', detail: n });
        const re = new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
        body = body.replace(re, '');
        headline = headline.replace(re, '');
      }
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

export interface SimilarityReport {
  structure: number;
  visual: number;
  /** 0~1，当前实现是 bigram 近似；语义层须接 embedding 或 LLM judge */
  copy: number;
  tooRepetitive: boolean;
  comparedWith: number;
}

/** Step 12：与本商户最近同类内容比较 */
export function evaluateSimilarity(
  currentDoc: {
    thesisText: string;
    openingMode: string;
    blocks: ContentBlock[];
  },
  history: CreativeFingerprint[]
): SimilarityReport {
  const current = buildCreativeFingerprint({
    thesisText: currentDoc.thesisText,
    openingMode: currentDoc.openingMode,
    blocks: currentDoc.blocks,
  });

  const recent = history.slice(-5);
  let maxStruct = 0;
  let maxVisual = 0;
  let maxCopy = 0;
  for (const h of recent) {
    maxStruct = Math.max(maxStruct, structureSimilarity(current, h));
    maxVisual = Math.max(maxVisual, visualSimilarity(current, h));
    maxCopy = Math.max(maxCopy, copySimilarity(current.thesisText, h.thesisText));
  }

  // 文档默认策略：Semantic 高 且（Structure 或 Visual 也高）→ 触发 Repair
  const semanticHigh = maxCopy >= 0.7;
  const structOrVisualHigh = maxStruct >= 0.8 || maxVisual >= 0.8;
  return {
    structure: maxStruct,
    visual: maxVisual,
    copy: maxCopy,
    tooRepetitive: semanticHigh && structOrVisualHigh,
    comparedWith: recent.length,
  };
}

/** 文案层第一层快速过滤：bigram Jaccard（文档允许 n-gram 作为第一层） */
export function copySimilarity(a: string, b: string): number {
  const gram = (s: string) => {
    const t = String(s ?? '').replace(/[\s，。、,.!！?？:：;；"'"'()（）]/g, '');
    const set = new Set<string>();
    for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
    return set;
  };
  const x = gram(a);
  const y = gram(b);
  if (!x.size || !y.size) return 0;
  let inter = 0;
  x.forEach((v) => y.has(v) && inter++);
  return inter / (x.size + y.size - inter);
}

/**
 * Step 13：有限修复。
 * repairFn 由 workflow 注入（重新写违规/高相似块）。最多 2 次。
 */
export async function repairDocument(
  initial: { blocks: ContentBlock[]; violations: GroundingViolation[]; report: SimilarityReport },
  repairFn: () => Promise<ContentBlock[]>,
  maxAttempts = 2
): Promise<{ blocks: ContentBlock[]; repairCount: number }> {
  let count = 0;
  let blocks = initial.blocks;
  let needsFix = initial.violations.length > 0 || initial.report.tooRepetitive;

  while (needsFix && count < maxAttempts) {
    blocks = await repairFn();
    count += 1;
    needsFix = false; // 由注入方在下一次评估决定是否继续
  }
  return { blocks, repairCount: count };
}
