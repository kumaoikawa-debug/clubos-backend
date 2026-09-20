/**
 * Content Engine V3 —— Evaluator: Semantic Diversity（文档 §九 semanticDiversity.eval.ts）
 *
 * 文案 / 语义相似度评测：把当前 thesis 与同商户最近 5 场指纹比较，
 * 给出第 1 层 bigram 近似（copy）与第 2 层真实语义余弦（semantic）。
 *
 * 语义层（§八 第 2 层）拿不到 embedding（离线 / 无 Key / 配额）时降级到 bigram，
 * 绝不伪造语义分数 —— 由 contracts/semantic.ts 的 semanticSimilarity 负责。
 *
 * 与 layoutDiversity.eval.ts 的分工：本文件只算「说了什么」层面的去重，
 * 「排法」层面的去重交给 layoutDiversity。两者由 steps/quality.ts 的
 * `evaluateSimilarity` 汇总成 SimilarityReport。
 */

import { copySimilarity } from '../contracts/fingerprints';
import { semanticSimilarity, embedText } from '../contracts/semantic';
import type { CreativeFingerprint } from '../contracts/fingerprints';

export interface SemanticDiversityScore {
  /** 第 1 层：bigram n-gram 近似 */
  copy: number;
  /** 第 2 层：真实语义余弦（无 embedding 时等于 copy） */
  semantic: number;
  /** 本轮比较是否真的走了 embedding（false = 全部降级到 bigram） */
  semanticAvailable: boolean;
}

const RECENT = 5;

/** 与最近 5 场比较文案/语义相似度 */
export async function semanticDiversity(
  currentThesis: string,
  history: CreativeFingerprint[]
): Promise<SemanticDiversityScore> {
  const recent = history.slice(-RECENT);
  // 当前 thesis 只 embed 一次（命中缓存时免费），与历史指纹里的 thesisEmbedding 复用
  const curVec = await embedText(currentThesis);

  let maxCopy = 0;
  let maxSem = 0;
  let semAvailable = false;

  for (const h of recent) {
    const copy = copySimilarity(currentThesis, h.thesisText);
    maxCopy = Math.max(maxCopy, copy);
    const sem = await semanticSimilarity(
      currentThesis,
      h.thesisText,
      curVec,
      h.thesisEmbedding ?? null
    );
    if (curVec && h.thesisEmbedding) semAvailable = true;
    maxSem = Math.max(maxSem, sem);
  }

  return { copy: maxCopy, semantic: maxSem, semanticAvailable: semAvailable };
}
