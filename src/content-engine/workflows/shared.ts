/**
 * Content Engine V3 —— 四个 scenario 共用的管线前缀
 *
 * Truth → Insight → Directions → Diversity Select 这四步在
 * detail / wechat / xiaohongshu / recap 里完全一致（同一个 Activity Truth），
 * 差异只在 Channel Director 之后。抽出来是为了避免四个 workflow 各写一遍、
 * 然后其中三个慢慢和另外那个不一致。
 *
 * ★ CreativeMemory 按 scenario 隔离读取：
 *   微信的历史不该让详情页生成时被判「撞车」（反之亦然），
 *   但同一渠道内连续几场撞车就要被差异化惩罚。
 */

import type { ActivityTruth } from '../contracts/activityTruth';
import type { CreativeDirection, StyleVector } from '../contracts/creativeDirection';
import type { VisionResult } from '../contracts/visionResult';
import { extractStyleVectors, type CreativeFingerprint } from '../contracts/fingerprints';
import { normalizeInput, buildTruth, missingFacts, analyzeMedia, type RawActivityInput } from '../steps/truth';
import {
  buildMarketingInsight,
  generateDirections,
  selectDirection,
  type MarketingInsight,
} from '../steps/direction';
import { listRecentFingerprints, type Scenario } from '../storage/repo';

export interface CommonInput extends RawActivityInput {
  merchantId: string;
  activityId: string;
}

export interface CommonPrefix {
  truth: ActivityTruth;
  missing: string[];
  insight: MarketingInsight;
  direction: CreativeDirection;
  vision: VisionResult[];
  photos: { id: string; src?: string }[];
  /** 本 scenario 的历史指纹（已按时间倒序），供后续 Repair / 落 fingerprint 复用 */
  history: CreativeFingerprint[];
}

export async function loadHistory(
  merchantId: string,
  scenario: Scenario,
  limit = 20
): Promise<CreativeFingerprint[]> {
  try {
    return await listRecentFingerprints(merchantId, scenario, limit);
  } catch {
    // DB 不可用不能拖垮生成 —— 只是失去跨场次去重能力
    return [];
  }
}

export async function runCommonPrefix(
  input: CommonInput,
  scenario: Scenario
): Promise<CommonPrefix> {
  const normalized = normalizeInput(input);
  const truth = buildTruth(normalized);
  const missing = missingFacts(truth);
  const photos = Array.isArray(normalized.photos) ? normalized.photos : [];

  const [vision, history] = await Promise.all([
    analyzeMedia(input.merchantId, photos),
    loadHistory(input.merchantId, scenario),
  ]);

  const insight = await buildMarketingInsight(input.merchantId, truth, vision);
  const directions = await generateDirections(input.merchantId, truth, insight, vision);
  const direction = selectDirection({
    directions,
    truth,
    vision,
    historyTheses: history.map((f) => f.thesisText),
    // ★ 之前这里恒为 []，导致「连着几场都长一个样」检测不出来；现在真的带上历史向量
    historyVectors: extractStyleVectors(history) as StyleVector[],
  });

  return { truth, missing, insight, direction, vision, photos, history };
}
