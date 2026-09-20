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
import { buildCreativeFingerprint, sectionsAsBlocks } from '../contracts/fingerprints';
import { embedText } from '../contracts/semantic';
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
  /** 落库后的 ContentDocument id（DB 不可用时为 null） */
  id: string | null;
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

  // ★ 回顾有自己的段落结构（purpose / imageSlots / 段长），必须如实喂给指纹：
  //   传 blocks: [] 会让它只剩一句 coreMemory 可比 —— 而所有回顾的 coreMemory
  //   恰恰都取自现场素材，比出来的「高度重复」是假的，真正该发现的「排法雷同」反而看不见。
  const structuralBlocks = sectionsAsBlocks(
    (sections || []).map((s) => ({
      purpose: s.purpose,
      images: s.imageSlots,
      text: (s.paragraphs || []).join(''),
    }))
  );
  const recapThesis = insight.coreMemory || common.direction.thesis;
  const thesisVec = await embedText(recapThesis);
  const fingerprint = buildCreativeFingerprint({
    thesisText: recapThesis,
    openingMode: 'actual-core-memory',
    blocks: structuralBlocks,
    styleVector: common.direction.styleVector,
    ...(thesisVec ? { thesisEmbedding: thesisVec } : {}),
  });
  const evaluation = await evaluateSimilarity(
    { thesisText: insight.coreMemory, openingMode: 'actual-core-memory', blocks: structuralBlocks },
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
      // 回顾目前没有改稿步骤 —— 「像历史」不能谎报成「改过一次」
      repairCount: 0,
      repetitive: evaluation.tooRepetitive,
      llmUsed: common.directionSource.llmUsed,
      fallbackReason: common.directionSource.reason || undefined,
    },
  };

  let documentId: string | null = null;
  try {
    const saved = await saveContentDocument({
      merchantId: input.merchantId,
      activityId: input.activityId,
      scenario: 'recap',
      truth: common.truth,
      direction: common.direction,
      document: document as unknown as Record<string, unknown>,
      fingerprint,
      evaluation,
    });
    documentId = saved && saved.id != null ? String(saved.id) : null;
    await appendCreativeMemory(input.merchantId, 'recap', fingerprint, input.activityId);
  } catch {
    /* DB 不可用时静默 */
  }

  return { id: documentId, document, missing: common.missing, emptyInsight: !insight.coreMemory };
}
