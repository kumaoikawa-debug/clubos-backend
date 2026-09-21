/**
 * 反重复闸门（§29 第四阶段 · 增强能力）
 *
 * 把 Creative Memory + Semantic Similarity + Layout Similarity + 多 Direction 串成一条
 * 「发布前闸门」，挂在 generatePromoCanvas / generateChannel / generateRecap 上：
 *
 *   生成前：按 Creative Memory 自动挑选一个最近用得最少的宣传切口（direction）；
 *   生成后：写入 Creative Memory，并算出与最近内容的语义 / 版式相似度作为反重复度量。
 *
 * 默认开启（可通过传参 diversity=false 关闭），确保这条链路真的被调用而不是死代码。
 */
import {
  recordCreativeMemory,
  recentCreativeMemory,
  blockSignatureOf,
  textOfBlocks,
  type CreativeMemoryEntry,
} from '../creative-memory';
import { maxSemanticSimilarity } from '../similarity/semantic';
import { maxLayoutSimilarity } from '../similarity/layout';
import { pickDirection, type Direction } from '../directions';
import type { PromoBlock } from '../types';

export interface RepetitionMetrics {
  /** 与最近内容的语义相似度（0=全新，1=几乎重复） */
  semantic: number;
  /** 与最近内容的版式相似度 */
  layout: number;
  /** 是否疑似撞车（两者都偏高） */
  repetitive: boolean;
}

export interface DiversityMeta {
  direction: Direction | null;
  repetition: RepetitionMetrics;
}

const REPETITIVE_THRESHOLD = 0.6;

/** 生成前：选一个与最近内容不同的宣传切口 */
export function selectDirection(merchantId: string): Direction {
  return pickDirection(recentCreativeMemory(merchantId, 10));
}

/** 生成后：写入记忆 + 计算反重复度量 */
export function recordAndMeasure(
  merchantId: string,
  payload: {
    activityId: string;
    channel?: string;
    direction?: Direction | null;
    thesis?: string;
    blocks: PromoBlock[];
  }
): RepetitionMetrics {
  const text = textOfBlocks(payload.blocks);
  const signature = blockSignatureOf(payload.blocks);
  const entry: Omit<CreativeMemoryEntry, 'ts'> = {
    activityId: payload.activityId,
    channel: payload.channel,
    direction: payload.direction ? payload.direction.key : undefined,
    thesis: payload.thesis,
    blockSignature: signature,
    text,
  };
  // 先量再记，避免把自己算进「最近内容」
  const recent = recentCreativeMemory(merchantId, 10);
  const semantic = maxSemanticSimilarity(text, recent);
  const layout = maxLayoutSimilarity(payload.blocks, recent);
  recordCreativeMemory(merchantId, entry);
  return {
    semantic,
    layout,
    repetitive: semantic >= REPETITIVE_THRESHOLD && layout >= REPETITIVE_THRESHOLD,
  };
}

/** 只算度量（不写记忆），供外部查看 */
export function measureOnly(merchantId: string, blocks: PromoBlock[]): RepetitionMetrics {
  const recent = recentCreativeMemory(merchantId, 10);
  const semantic = maxSemanticSimilarity(textOfBlocks(blocks), recent);
  const layout = maxLayoutSimilarity(blocks, recent);
  return { semantic, layout, repetitive: semantic >= REPETITIVE_THRESHOLD && layout >= REPETITIVE_THRESHOLD };
}

export { DIRECTIONS } from '../directions';
export { clearCreativeMemory, recentCreativeMemory } from '../creative-memory';
export { semanticSimilarity } from '../similarity/semantic';
export { layoutSimilarity } from '../similarity/layout';
