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
import { listRecentFingerprints, getBrandProfile, type Scenario } from '../storage/repo';
import type { BrandProfile } from '../contracts/brandProfile';

export interface CommonInput extends RawActivityInput {
  merchantId: string;
  activityId: string;
}

export interface CommonPrefix {
  truth: ActivityTruth;
  missing: string[];
  insight: MarketingInsight;
  direction: CreativeDirection;
  /**
   * 方向的来源事实：LLM 到底有没有参与、没参与是为什么。
   *
   * ★ 必须一路带到文档的 `generationMeta`：掉额度 / Key 失效时全线静默兜底，
   *   请求照样 200、文档照样生成、`model` 还写着 `platform-llm`，
   *   运维侧几乎零信号 —— 验收跑批里 30 场有 22 场兜底，就是靠等价旁证才发现的。
   */
  directionSource: { llmUsed: boolean; reason: string };
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

/**
 * 读取某商户品牌档案（文档 §十三）。
 * DB 不可用 / 未设置 → 返回 null，上层用中性默认品牌语言，
 * 绝不默认所有俱乐部都是「年轻、松弛、山系高级感」。
 */
export async function loadBrandProfile(merchantId: string): Promise<BrandProfile | null> {
  try {
    return await getBrandProfile(merchantId);
  } catch {
    return null;
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

  const [vision, history, brand] = await Promise.all([
    analyzeMedia(input.merchantId, photos),
    loadHistory(input.merchantId, scenario),
    loadBrandProfile(input.merchantId),
  ]);

  const insight = await buildMarketingInsight(input.merchantId, truth, vision);
  // ★ brand 为 null 时走中性默认品牌语言（§十三），不注入任何具体调性
  const generated = await generateDirections(input.merchantId, truth, insight, vision, brand);
  const direction = selectDirection({
    directions: generated.directions,
    truth,
    vision,
    historyTheses: history.map((f) => f.thesisText),
    // ★ 之前这里恒为 []，导致「连着几场都长一个样」检测不出来；现在真的带上历史向量
    historyVectors: extractStyleVectors(history) as StyleVector[],
  });

  return {
    truth,
    missing,
    insight,
    direction,
    directionSource: { llmUsed: generated.llmUsed, reason: generated.llmError },
    vision,
    photos,
    history,
  };
}
