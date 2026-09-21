/**
 * Semantic Similarity（§29 第四阶段 · 增强能力）
 *
 * 轻量语义相似度：字符 2-gram Jaccard。不引 embedding（§21 明确第一版不引）。
 *
 * 边界纪律（历史教训）：空值不能白送相似度——任一侧为空一律返回 0，
 * 否则「两边都没内容」会被判成 1.0（假撞车 / 假通过）。
 */
function bigrams(s: string): Set<string> {
  const t = String(s || '').replace(/\s+/g, '');
  const out = new Set<string>();
  if (t.length < 2) {
    if (t.length === 1) out.add(t);
    return out;
  }
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

/** 0 = 完全不同，1 = 完全相同 */
export function semanticSimilarity(a: string, b: string): number {
  const ga = bigrams(a);
  const gb = bigrams(b);
  if (!ga.size || !gb.size) return 0; // 空值不参与相似度判定
  let inter = 0;
  ga.forEach((g) => { if (gb.has(g)) inter++; });
  const union = ga.size + gb.size - inter;
  return union ? inter / union : 0;
}

/** 与最近 N 条记忆的最大语义相似度（用于「最近内容反重复」） */
export function maxSemanticSimilarity(text: string, recent: { text?: string }[]): number {
  if (!text || !recent || !recent.length) return 0;
  let max = 0;
  recent.forEach((r) => {
    if (!r.text) return;
    const s = semanticSimilarity(text, r.text);
    if (s > max) max = s;
  });
  return max;
}
