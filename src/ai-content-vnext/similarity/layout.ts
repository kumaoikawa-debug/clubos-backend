/**
 * Layout Similarity（§29 第四阶段 · 增强能力）
 *
 * 版式相似度：比较两个 block 序列的类型构成 + 顺序。
 *
 * 边界纪律：任一侧为空一律 0（避免「两边都没 block」被判成完全相同）。
 * 顺序权重用「同位置同类型」命中率，避免只看类型集合而忽略节奏。
 */
import type { PromoBlock } from '../types';

function typesOf(blocks: PromoBlock[]): string[] {
  return (blocks || []).map((b) => b.type);
}

/** 0 = 完全不同，1 = 完全相同 */
export function layoutSimilarity(a: PromoBlock[] | string[], b: PromoBlock[] | string[]): number {
  const ta = (a || []).map((x: any) => (typeof x === 'string' ? x : x && x.type)).filter(Boolean) as string[];
  const tb = (b || []).map((x: any) => (typeof x === 'string' ? x : x && x.type)).filter(Boolean) as string[];
  if (!ta.length || !tb.length) return 0;

  // 1) 类型集合 Jaccard
  const sa = new Set(ta);
  const sb = new Set(tb);
  let inter = 0;
  sa.forEach((t) => { if (sb.has(t)) inter++; });
  const union = sa.size + sb.size - inter;
  const setSim = union ? inter / union : 0;

  // 2) 顺序命中率（同位置同类型）
  const n = Math.min(ta.length, tb.length);
  let posHit = 0;
  for (let i = 0; i < n; i++) if (ta[i] === tb[i]) posHit++;
  const orderSim = n ? posHit / n : 0;

  return 0.5 * setSim + 0.5 * orderSim;
}

/** 与最近 N 条记忆的最大版式相似度 */
export function maxLayoutSimilarity(blocks: PromoBlock[], recent: { blockSignature?: string }[]): number {
  const ta = typesOf(blocks);
  if (!ta.length || !recent || !recent.length) return 0;
  let max = 0;
  recent.forEach((r) => {
    if (!r.blockSignature) return;
    const tb = String(r.blockSignature).split('>').filter(Boolean);
    const s = layoutSimilarity(ta, tb);
    if (s > max) max = s;
  });
  return max;
}
