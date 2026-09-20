/**
 * Content Engine V3 —— Evaluator: Layout Diversity（文档 §九 layoutDiversity.eval.ts）
 *
 * 结构 / 视觉相似度评测：把当前文档与同商户最近 5 场指纹比较，
 * 给出结构相似度与视觉相似度（0~1），并判「是否因结构/视觉雷同而太重复」。
 *
 * 注意：`buildCreativeFingerprint` 的结构/视觉字段只依赖 blocks（不依赖 thesisText/openingMode），
 * 故此处用空 thesis/opening 构建指纹，得到与原 `evaluateSimilarity` 完全一致的数值。
 *
 * 与 semanticDiversity.eval.ts 的分工：本文件只算「排法」层面的去重，
 * 「文案/语义」层面的去重交给 semanticDiversity。两者由 steps/quality.ts 的
 * `evaluateSimilarity` 汇总成 SimilarityReport。
 */

import {
  buildCreativeFingerprint,
  structureSimilarity,
  visualSimilarity,
  type CreativeFingerprint,
} from '../contracts/fingerprints';
import type { ContentBlock } from '../contracts/promoDocument';

export interface LayoutSimilarity {
  structure: number;
  visual: number;
  /** 结构高 或 视觉高 → 触发去重修复的候选 */
  tooRepetitive: boolean;
  comparedWith: number;
}

const RECENT = 5;

/** 与最近 5 场比较结构/视觉相似度 */
export function layoutSimilarity(
  currentDoc: { blocks: ContentBlock[] },
  history: CreativeFingerprint[]
): LayoutSimilarity {
  const current = buildCreativeFingerprint({
    thesisText: '',
    openingMode: '',
    blocks: currentDoc.blocks,
  });

  const recent = history.slice(-RECENT);
  let maxStruct = 0;
  let maxVisual = 0;
  for (const h of recent) {
    maxStruct = Math.max(maxStruct, structureSimilarity(current, h));
    maxVisual = Math.max(maxVisual, visualSimilarity(current, h));
  }

  const structOrVisualHigh = maxStruct >= 0.8 || maxVisual >= 0.8;
  return {
    structure: maxStruct,
    visual: maxVisual,
    tooRepetitive: structOrVisualHigh,
    comparedWith: recent.length,
  };
}
