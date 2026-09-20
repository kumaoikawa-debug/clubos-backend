/**
 * Content Engine V3 —— 小红书 workflow
 * 文档 §十五：「不要从公众号缩短。」
 *
 * 同一份 Activity Intelligence 交给 Xiaohongshu Channel Director，
 * 产出 hook / titleOptions / mainAngle / body / imageSequence / coverSuggestion / tags / cta。
 * ★ 图片顺序是内容的一部分：必须决定第一张是什么、第二张承担什么、
 *   人物/风景比例、是否需要信息图。
 */

import type { XiaohongshuDocument } from '../contracts/channels';
import { buildCreativeFingerprint, sectionsAsBlocks } from '../contracts/fingerprints';
import { embedText } from '../contracts/semantic';
import { evaluateSimilarity } from '../steps/quality';
import { writeXiaohongshu, sequenceXhsPhotos } from '../steps/channels';
import { saveContentDocument, appendCreativeMemory } from '../storage/repo';
import { runCommonPrefix, type CommonInput } from './shared';

export const WORKFLOW_VERSION = 'v3.0-xiaohongshu';

export interface XhsResult {
  /** 落库后的 ContentDocument id（DB 不可用时为 null） */
  id: string | null;
  document: XiaohongshuDocument;
  missing: string[];
}

export async function runXiaohongshuPipeline(input: CommonInput): Promise<XhsResult> {
  const common = await runCommonPrefix(input, 'xiaohongshu');

  const written = await writeXiaohongshu(input.merchantId, common.truth, common.direction);
  const { sequence, coverSuggestion } = sequenceXhsPhotos(
    common.photos,
    common.vision,
    written.mainAngle
  );

  // ★ 小红书的「结构」= 图集 + 正文分段。原文传 blocks: [] 时它只剩 thesis 可比，
  //   连「这条是图多还是字多」都进不了指纹，跨场次去重等于没做。
  const structuralBlocks = sectionsAsBlocks([
    { purpose: '图集顺序', images: sequence.length, text: '' },
    ...String(written.body || '')
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((text) => ({ purpose: '正文段', text })),
  ]);
  const thesisVec = await embedText(common.direction.thesis);
  const fingerprint = buildCreativeFingerprint({
    thesisText: common.direction.thesis,
    openingMode: written.hook,
    blocks: structuralBlocks,
    styleVector: common.direction.styleVector,
    ...(thesisVec ? { thesisEmbedding: thesisVec } : {}),
  });
  const evaluation = await evaluateSimilarity(
    { thesisText: common.direction.thesis, openingMode: written.hook, blocks: structuralBlocks },
    common.history
  );

  const document: XiaohongshuDocument = {
    schemaVersion: 3,
    scenario: 'xiaohongshu',
    activityId: input.activityId,
    hook: written.hook,
    titleOptions: written.titleOptions,
    mainAngle: written.mainAngle,
    body: written.body,
    imageSequence: sequence,
    coverSuggestion,
    tags: written.tags,
    cta: written.cta,
    direction: common.direction,
    generationMeta: {
      model: 'platform-llm',
      workflowVersion: WORKFLOW_VERSION,
      generatedAt: new Date().toISOString(),
      // 小红书目前没有改稿步骤 —— 「像历史」不能谎报成「改过一次」
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
      scenario: 'xiaohongshu',
      truth: common.truth,
      direction: common.direction,
      document: document as unknown as Record<string, unknown>,
      fingerprint,
      evaluation,
    });
    documentId = saved && saved.id != null ? String(saved.id) : null;
    await appendCreativeMemory(input.merchantId, 'xiaohongshu', fingerprint, input.activityId);
  } catch {
    /* DB 不可用时静默 */
  }

  return { id: documentId, document, missing: common.missing };
}
