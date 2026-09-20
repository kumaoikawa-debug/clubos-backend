/**
 * Content Engine V3 —— Workflow 步骤 Step 11~13 的对外入口（Barrel）
 *
 * 文档 §九 要求把评价逻辑拆成独立 evaluator 模块：
 *   evaluators/grounding.eval.ts        —— grounded claims / 禁用套话 / 无据数字
 *   evaluators/specificity.eval.ts      —— 文案具体度评分
 *   evaluators/layoutDiversity.eval.ts  —— 结构 / 视觉相似度
 *   evaluators/semanticDiversity.eval.ts—— 文案 / 语义相似度（§八 第 2 层）
 *   evaluators/publishReadiness.eval.ts —— 有限修复 + 发布就绪 verdict
 *
 * 本文件只做「重新导出 + 汇总」，确保历史调用方（detail/wechat/xhs/recap workflow、
 * editor.ts、direction.ts、channels.ts、tools/v3-audit.ts、tests/*）零改动。
 * 公开 API 与拆分前逐字节一致。
 */

import type { ContentBlock } from '../contracts/promoDocument';
import type { CreativeFingerprint } from '../contracts/fingerprints';

import { BANNED_PHRASES, groundClaims, allowedFactTokens, unsupportedNumbersIn } from '../evaluators/grounding.eval';
import { evaluateSpecificity, type SpecificityReport } from '../evaluators/specificity.eval';
import { layoutSimilarity, type LayoutSimilarity } from '../evaluators/layoutDiversity.eval';
import { semanticDiversity, type SemanticDiversityScore } from '../evaluators/semanticDiversity.eval';
import { repairDocument, evaluatePublishReadiness, type PublishReadiness } from '../evaluators/publishReadiness.eval';

// ── 公开 API：重新导出（与拆分前一致） ───────────────────────────────────
export { BANNED_PHRASES, groundClaims, allowedFactTokens, unsupportedNumbersIn } from '../evaluators/grounding.eval';
export type { GroundingViolation } from '../evaluators/grounding.eval';
export { evaluateSpecificity } from '../evaluators/specificity.eval';
export type { SpecificityReport } from '../evaluators/specificity.eval';
export { layoutSimilarity } from '../evaluators/layoutDiversity.eval';
export type { LayoutSimilarity } from '../evaluators/layoutDiversity.eval';
export { semanticDiversity } from '../evaluators/semanticDiversity.eval';
export type { SemanticDiversityScore } from '../evaluators/semanticDiversity.eval';
export { repairDocument, evaluatePublishReadiness } from '../evaluators/publishReadiness.eval';
export type { PublishReadiness } from '../evaluators/publishReadiness.eval';

// 保留向后兼容：copySimilarity 已迁至 contracts/fingerprints（语义相似度第 1 层 + 降级），
// 重新导出以免 tools/v3-audit.ts 等调用方改动。
export { copySimilarity } from '../contracts/fingerprints';

/**
 * Step 12 汇总报告：合并 layout + semantic 两层去重结果。
 * 阈值与原实现完全一致：
 *   - 语义层可用时以真实 cosine 为准（>=0.82）；
 *     不可用时退回 bigram 阈值（>=0.7，与旧实现行为一致，保证离线契约判据不漂移）。
 *   - 结构高 或 视觉高（>=0.8）且与语义高同时成立 → tooRepetitive。
 */
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
  const layout: LayoutSimilarity = layoutSimilarity(currentDoc, history);
  const semantic: SemanticDiversityScore = await semanticDiversity(currentDoc.thesisText, history);

  // 文档默认策略：Semantic 高 且（Structure 或 Visual 也高）→ 触发 Repair。
  const semanticHigh = semantic.semanticAvailable ? semantic.semantic >= 0.82 : semantic.copy >= 0.7;
  const structOrVisualHigh = layout.structure >= 0.8 || layout.visual >= 0.8;

  return {
    structure: layout.structure,
    visual: layout.visual,
    copy: semantic.copy,
    semantic: semantic.semantic,
    semanticAvailable: semantic.semanticAvailable,
    tooRepetitive: semanticHigh && structOrVisualHigh,
    comparedWith: layout.comparedWith,
  };
}
