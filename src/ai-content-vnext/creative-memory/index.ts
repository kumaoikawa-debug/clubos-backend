/**
 * Creative Memory（§29 第四阶段 · 增强能力）
 *
 * 按俱乐部（merchantId）记住最近产出过的「宣传切口 / 核心主张 / 版式签名」，
 * 供反重复与「自动选择不同宣传切口」使用。
 *
 * 实现取舍（§21 / §29）：这是增强能力，不是第一版主链，因此用进程内存储，
 * 不引 embedding、不做 20 场长期记忆。重启即清空，语义上等价于「最近内容」。
 */
import type { PromoBlock } from '../types';

export interface CreativeMemoryEntry {
  activityId: string;
  /** 渠道 / 场景（promo / wechat / xiaohongshu / poster / moments / recap） */
  channel?: string;
  /** 宣传切口（direction key） */
  direction?: string;
  /** 核心主张（一句话） */
  thesis?: string;
  /** 版式签名（block 类型序列，如 hero>text>cta） */
  blockSignature?: string;
  /** 主要文案（用于语义相似度比对） */
  text?: string;
  ts: number;
}

const store = new Map<string, CreativeMemoryEntry[]>();
const MAX_PER_MERCHANT = 30;

export function recordCreativeMemory(merchantId: string, entry: Omit<CreativeMemoryEntry, 'ts'>): void {
  const list = store.get(merchantId) || [];
  list.push({ ...entry, ts: Date.now() });
  // 只保留最近 N 条
  store.set(merchantId, list.slice(-MAX_PER_MERCHANT));
}

export function recentCreativeMemory(merchantId: string, n = 10): CreativeMemoryEntry[] {
  const list = store.get(merchantId) || [];
  return list.slice(-n);
}

export function clearCreativeMemory(merchantId?: string): void {
  if (merchantId) store.delete(merchantId);
  else store.clear();
}

/** 版式签名：block 类型序列（用于 Layout Similarity） */
export function blockSignatureOf(blocks: PromoBlock[]): string {
  return (blocks || []).map((b) => b.type).join('>');
}

/** 抽取主要文案（用于 Semantic Similarity） */
export function textOfBlocks(blocks: PromoBlock[]): string {
  return (blocks || [])
    .map((b) => [b.headline, b.subtitle, b.text, b.body, b.caption, b.ctaText].filter(Boolean).join(' '))
    .join('\n')
    .trim();
}
