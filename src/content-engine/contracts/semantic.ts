/**
 * Content Engine V3 —— Semantic Similarity（文档 §八 第 2 层）
 *
 * 这是规格里长期「未闭环」的红线的真实实现：
 *   - 旧实现 `quality.ts` 的 `copy` 字段只有 bigram 近似，注释明写
 *     「语义层须接 embedding 或 LLM judge，不在这里伪造」。
 *   - 本文件提供真实语义相似度：能拿到 embedding 就走余弦，否则确定性降级到 bigram。
 *
 * 设计约束（与现有架构一致）：
 *   - 走平台 Key 直连 DeepSeek embeddings（model=`deepseek-embedding`），
 *     不走 `proxyChat` 的 AI 积分账本 —— 相似度是工具调用，不应吃创作额度，
 *     也避免「跑批把积分吃光 → 全线静默兜底」这类事故波及去重判据。
 *   - 任何失败（无 Key / 离线 / 网络 / 超时 / 配额 / 返回空）一律返回 null，
 *     调用方降级到 bigram，**绝不伪造语义分数**。
 *   - 文本级内存缓存，同一句 thesis 不重复打 API。
 *   - 全部包裹 try/catch，失败不影响主生成链路（相似度只是 Repair 的触发条件之一）。
 */

import { config } from '../../config';
import { copySimilarity } from './fingerprints';

const EMBED_MODEL = 'deepseek-embedding';
const EMBED_TIMEOUT_MS = 15000;

const cache = new Map<string, number[]>();

/**
 * 把文本转成 embedding 向量。
 * 返回 null = 「无法获得真实语义向量」，调用方应降级到 bigram。
 */
export async function embedText(text: string): Promise<number[] | null> {
  const key = config.platformLlmKey;
  const t = String(text ?? '').trim();
  if (!key || !t) return null;

  const cached = cache.get(t);
  if (cached) return cached;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), EMBED_TIMEOUT_MS);
    const resp = await fetch('https://api.deepseek.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ model: EMBED_MODEL, input: t }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return null;

    const json = (await resp.json()) as {
      data?: { embedding?: number[] }[];
    };
    const vec = json.data?.[0]?.embedding;
    if (!Array.isArray(vec) || vec.length === 0) return null;

    // 规整为有限数，防止 NaN/Infinity 污染余弦
    const clean = vec.map((v) => (Number.isFinite(v) ? v : 0));
    cache.set(t, clean);
    return clean;
  } catch {
    return null;
  }
}

/** 余弦相似度（0~1）。向量长度不一致或任一为零向量 → 0。 */
export function cosineSim(a: number[], b: number[]): number {
  if (!a.length || !b.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return Math.max(0, Math.min(1, dot / (Math.sqrt(na) * Math.sqrt(nb))));
}

/**
 * 语义相似度（0~1）—— §八 第 2 层真实实现。
 * 两条都有 embedding → 余弦；
 * 任一条拿不到（离线 / 无 Key / 配额）→ 降级到 bigram（n-gram 第 1 层）。
 *
 * @param aVec / bVec 可选：调用方若已持有向量（如历史指纹里存的 thesisEmbedding），
 *        直接传入避免重复 embedding。
 */
export async function semanticSimilarity(
  a: string,
  b: string,
  aVec?: number[] | null,
  bVec?: number[] | null
): Promise<number> {
  const va = aVec ?? (await embedText(a));
  const vb = bVec ?? (await embedText(b));
  if (va && vb) return cosineSim(va, vb);
  return copySimilarity(a, b);
}
