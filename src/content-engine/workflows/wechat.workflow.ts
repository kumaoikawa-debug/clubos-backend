/**
 * Content Engine V3 —— 微信公众号 workflow
 * 文档 §十四：Activity Truth → Intelligence → Insight → Direction
 *   → Wechat Channel Director → Wechat Blueprint → Block Writer
 *   → Photo Curator → WeChat HTML Renderer
 *
 * 关键：公众号不是详情页「复制一遍」或「缩短版」。
 * 必须对微信长图文重新判断首屏节奏、文章长度、图片数量与插入位置、标题、摘要、CTA。
 */

import type { WechatDocument } from '../contracts/channels';
import { buildCreativeFingerprint, sectionsAsBlocks } from '../contracts/fingerprints';
import { embedText } from '../contracts/semantic';
import { evaluateSimilarity } from '../steps/quality';
import {
  buildWechatBlueprint,
  curateWechatPhotos,
  writeWechatTitles,
} from '../steps/channels';
import { renderWechatHtml } from '../renderers/wechatHtml';
import { saveContentDocument, appendCreativeMemory } from '../storage/repo';
import { runCommonPrefix, type CommonInput } from './shared';

export const WORKFLOW_VERSION = 'v3.0-wechat';

export interface WechatResult {
  /** 落库后的 ContentDocument id（DB 不可用时为 null） */
  id: string | null;
  document: WechatDocument;
  fromLlm: boolean;
  missing: string[];
  titles: string[];
}

export async function runWechatPipeline(input: CommonInput): Promise<WechatResult> {
  const common = await runCommonPrefix(input, 'wechat');

  const blueprint = await buildWechatBlueprint(
    input.merchantId,
    common.truth,
    common.direction,
    common.photos.length
  );
  const titles = await writeWechatTitles(input.merchantId, common.truth, common.direction);
  const curated = curateWechatPhotos(common.vision, common.photos);

  const title = titles[0] || String(common.truth.confirmedFacts.title || '').slice(0, 30);

  const html = renderWechatHtml({
    activityId: input.activityId,
    blueprint,
    title,
    images: curated.images,
    coverIndex: curated.coverIndex,
    styleVector: common.direction.styleVector,
  });

  // ★ 段落结构（purpose / 配图数 / 段长）就是这一版的「排法」，必须进指纹；
  //   传 [] 会让公众号只剩一句 thesis 可比，跨场次去重形同虚设。
  const structuralBlocks = sectionsAsBlocks(
    (blueprint.sections || []).map((s) => ({
      purpose: s.purpose,
      images: s.imageSlots,
      text: (s.paragraphs || []).join(''),
    }))
  );
  const thesisVec = await embedText(common.direction.thesis);
  const fingerprint = buildCreativeFingerprint({
    thesisText: common.direction.thesis,
    openingMode: blueprint.opening,
    blocks: structuralBlocks,
    styleVector: common.direction.styleVector,
    ...(thesisVec ? { thesisEmbedding: thesisVec } : {}),
  });
  const evaluation = await evaluateSimilarity(
    { thesisText: common.direction.thesis, openingMode: blueprint.opening, blocks: structuralBlocks },
    common.history
  );

  const document: WechatDocument = {
    schemaVersion: 3,
    scenario: 'wechat',
    activityId: input.activityId,
    titleOptions: titles,
    title,
    digest: blueprint.summary,
    html,
    coverIndex: curated.coverIndex,
    imageOrder: curated.order,
    direction: common.direction,
    generationMeta: {
      model: 'platform-llm',
      workflowVersion: WORKFLOW_VERSION,
      generatedAt: new Date().toISOString(),
      // 公众号目前没有改稿步骤 —— 「像历史」不能谎报成「改过一次」
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
      scenario: 'wechat',
      truth: common.truth,
      direction: common.direction,
      document: document as unknown as Record<string, unknown>,
      fingerprint,
      evaluation,
    });
    documentId = saved && saved.id != null ? String(saved.id) : null;
    await appendCreativeMemory(input.merchantId, 'wechat', fingerprint, input.activityId);
  } catch {
    /* DB 不可用时静默 */
  }

  return {
    id: documentId,
    document,
    fromLlm: true,
    missing: common.missing,
    titles,
  };
}
