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
  copySimilarity,
  type CreativeFingerprint,
} from '../contracts/fingerprints';
import { semanticSimilarity, embedText } from '../contracts/semantic';

// 保留公开 API：copySimilarity 已迁至 contracts/fingerprints（语义相似度的第 1 层 + 降级），
// 重新导出以免 tools/v3-audit.ts 等调用方改动。
export { copySimilarity };

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
 * 谁在用：
 *   - groundClaims（块级：把无据数字擦掉）
 *   - direction 过滤（方向级：thesis/angle 里有编造数字就拒收整个方向）
 *   - tools/v3-audit.ts（验收：报出编造数字）
 * 三处必须同源。曾经验收侧自己写了一套「先剥日期再抽数字」的规则，
 * 于是「审计通过」并不等于「引擎真的这么判」—— 判据分叉是审计最贵的坑。
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

export interface SimilarityReport {
  structure: number;
  visual: number;
  /** 第 1 层：bigram n-gram 近似（离线 / 无 embedding 时的语义代理） */
  copy: number;
  /**
   * 第 2 层：真实语义相似度（embedding 余弦）。
   * 无 embedding 能力时等于 `copy`（降级），此时 `semanticAvailable=false`。
   */
  semantic: number;
  /** 本轮比较是否真的走了 embedding（false = 全部降级到 bigram） */
  semanticAvailable: boolean;
  tooRepetitive: boolean;
  comparedWith: number;
}

/** Step 12：与本商户最近同类内容比较 */
export async function evaluateSimilarity(
  currentDoc: {
    thesisText: string;
    openingMode: string;
    blocks: ContentBlock[];
  },
  history: CreativeFingerprint[]
): Promise<SimilarityReport> {
  const current = buildCreativeFingerprint({
    thesisText: currentDoc.thesisText,
    openingMode: currentDoc.openingMode,
    blocks: currentDoc.blocks,
  });

  const recent = history.slice(-5);
  let maxStruct = 0;
  let maxVisual = 0;
  let maxCopy = 0;
  let maxSem = 0;
  let semAvailable = false;

  // 当前 thesis 只 embed 一次（命中缓存时免费），与历史指纹里的 thesisEmbedding 复用
  const curVec = await embedText(currentDoc.thesisText);
  for (const h of recent) {
    maxStruct = Math.max(maxStruct, structureSimilarity(current, h));
    maxVisual = Math.max(maxVisual, visualSimilarity(current, h));
    const copy = copySimilarity(current.thesisText, h.thesisText);
    maxCopy = Math.max(maxCopy, copy);
    const sem = await semanticSimilarity(
      current.thesisText,
      h.thesisText,
      curVec,
      h.thesisEmbedding ?? null
    );
    if (curVec && h.thesisEmbedding) semAvailable = true;
    maxSem = Math.max(maxSem, sem);
  }

  // 文档默认策略：Semantic 高 且（Structure 或 Visual 也高）→ 触发 Repair。
  // 语义层可用时以真实 cosine 为准（阈值偏高，余弦分布稠密）；
  // 不可用时退回 bigram 阈值（与旧实现行为一致，保证离线契约判据不漂移）。
  const semanticHigh = semAvailable ? maxSem >= 0.82 : maxCopy >= 0.7;
  const structOrVisualHigh = maxStruct >= 0.8 || maxVisual >= 0.8;
  return {
    structure: maxStruct,
    visual: maxVisual,
    copy: maxCopy,
    semantic: maxSem,
    semanticAvailable: semAvailable,
    tooRepetitive: semanticHigh && structOrVisualHigh,
    comparedWith: recent.length,
  };
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
