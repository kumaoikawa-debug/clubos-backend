/**
 * Content Engine V3 —— Evaluator: Publish Readiness（文档 §九 publishReadiness.eval.ts）
 *
 * 两层职责：
 *  1. `repairDocument`（Step 13）：有限修复。repairFn 由 workflow 注入，最多 2 次，禁止无限重试。
 *     原实现位于 steps/quality.ts，本次按文档 §九 迁至独立 evaluator 模块。
 *  2. `evaluatePublishReadiness`：把 grounding 违规 + 雷同判据 + 具体度，汇总成一个
 *     「能否直接发布」的 verdict。§二十四 质量指标仪表盘的 ready 信号即来源于此。
 *
 * 纯函数 + 一次异步修复，无外部 I/O。
 */

import type { ContentBlock } from '../contracts/promoDocument';
import type { GroundingViolation } from './grounding.eval';
import type { SpecificityReport } from './specificity.eval';
import type { SimilarityReport } from '../steps/quality';

/** Step 13：有限修复。最多 maxAttempts 次。 */
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

export interface PublishReadiness {
  /** 全部判据通过 = 可直接发布 */
  ready: boolean;
  groundingViolations: number;
  tooRepetitive: boolean;
  /** 具体度评分（0~1）；未传入 specificity 时为 null */
  specificityScore: number | null;
  /** 未通过的原因清单（空 = 通过） */
  reasons: string[];
}

/**
 * 汇总发布就绪 verdict。
 * 任何一条硬判据不过 → ready=false，并在 reasons 里给出可读原因。
 */
export function evaluatePublishReadiness(input: {
  violations: GroundingViolation[];
  report: SimilarityReport;
  specificity?: SpecificityReport | null;
}): PublishReadiness {
  const reasons: string[] = [];

  if (input.violations.length > 0) {
    reasons.push(`仍有 ${input.violations.length} 处无依据陈述/禁用套话未清理`);
  }
  if (input.report.tooRepetitive) {
    reasons.push('与近 5 场内容高度雷同，需重新设计');
  }
  const specificityScore = input.specificity ? input.specificity.score : null;
  if (specificityScore !== null && specificityScore < 0.5) {
    reasons.push('文案过于空泛（具体度 < 0.5）');
  }

  return {
    ready: reasons.length === 0,
    groundingViolations: input.violations.length,
    tooRepetitive: input.report.tooRepetitive,
    specificityScore,
    reasons,
  };
}
