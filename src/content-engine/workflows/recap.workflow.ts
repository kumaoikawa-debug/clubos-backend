/**
 * Content Engine V3 —— 活动回顾 workflow
 * 文档 §十六：input = Activity Truth + actualActivityData + 现场照片 + 现场备注 + 真实用户反馈
 *
 * ★ 保留当前最有价值的：**actualActivityData 与 planned facts 严格分离**。
 *   recap 谈「发生过的事」，promo 谈「计划好的事」 ——
 *   把方案原文当成本次实际发生，是回顾最大的失信来源。
 *
 * 禁止固定结构（文档原话）：开场→核心记忆→途中体验→值得记住→收获→照片→下一期。
 */

import type { ActualActivityData, RecapDocument } from '../contracts/channels';
import { buildCreativeFingerprint } from '../contracts/fingerprints';
import { evaluateSimilarity } from '../steps/quality';
import { buildRecapInsight, writeRecapSections } from '../steps/channels';
import { renderWechatHtml } from '../renderers/wechatHtml';
import { saveContentDocument, appendCreativeMemory } from '../storage/repo';
import { runCommonPrefix, type CommonInput } from './shared';

export const WORKFLOW_VERSION = 'v3.0-recap';

export interface RecapInput extends CommonInput {
  actual?: ActualActivityData;
}

export interface RecapResult {
  document: RecapDocument;
  missing: string[];
  /** 没有现场素材时为真 —— 此时产出的是诚实空态，不是编出来的回顾 */
  emptyInsight: boolean;
}

export async function runRecapPipeline(input: RecapInput): Promise<RecapResult> {
  const common = await runCommonPrefix(input, 'recap');

  const actual: ActualActivityData = input.actual || {};
  const insight = buildRecapInsight(common.truth, actual);
  const sections = await writeRecapSections(
    input.merchantId,
    common.truth,
    actual,
    insight,
    common.direction
  );

  const photos = (actual.photos || []).map((p) => ({ id: p.id, src: p.caption }));
  const images = photos.map((p) => p.src || '').filter(Boolean);

  const html = renderWechatHtml({
    activityId: input.activityId,
    blueprint: {
      titleStrategy: insight.coreMemory,
      summary: insight.coreMemory.slice(0, 120),
      opening: insight.coreMemory,
      sections: sections.map((s) => ({
        purpose: s.purpose,
        heading: s.heading,
        paragraphs: s.paragraphs,
        imageSlots: s.imageSlots,
        evidenceRefs: s.evidenceRefs,
      })),
      closing: insight.whyItMatters,
      cta: '',
    },
    title: insight.coreMemory.slice(0, 30) || String(common.truth.confirmedFacts.title || ''),
    images,
    coverIndex: 0,
    styleVector: common.direction.styleVector,
  });

  const fingerprint = buildCreativeFingerprint({
    thesisText: insight.coreMemory || common.direction.thesis,
    openingMode: 'actual-core-memory',
    blocks: [],
    styleVector: common.direction.styleVector,
  });
  const evaluation = evaluateSimilarity(
    { thesisText: insight.coreMemory, openingMode: 'actual-core-memory', blocks: [] },
    common.history
  );

  const document: RecapDocument = {
    schemaVersion: 3,
    scenario: 'recap',
    activityId: input.activityId,
    insight,
    sections,
    html,
    coverIndex: 0,
    imageOrder: photos.map((_, i) => i),
    direction: common.direction,
    generationMeta: {
      model: 'platform-llm',
      workflowVersion: WORKFLOW_VERSION,
      generatedAt: new Date().toISOString(),
      repairCount: evaluation.tooRepetitive ? 1 : 0,
    },
  };

  try {
    await saveContentDocument({
      merchantId: input.merchantId,
      activityId: input.activityId,
      scenario: 'recap',
      truth: common.truth,
      direction: common.direction,
      document: document as unknown as Record<string, unknown>,
      fingerprint,
      evaluation,
    });
    await appendCreativeMemory(input.merchantId, 'recap', fingerprint, input.activityId);
  } catch {
    /* DB 不可用时静默 */
  }

  return { document, missing: common.missing, emptyInsight: !insight.coreMemory };
}
