/**
 * Content Engine V3 —— 质量指标计算（文档 §二十四）
 *
 * V3 不再以「成功生成了内容」作为成功指标。核心 5 个指标：
 *   1. Direct Publish Rate —— AI 生成后可直接发布率
 *   2. Edit Ratio          —— 老板修改文字的比例（优<15% / 可接受15~30% / 不合格>50%）
 *   3. Diversity           —— 最近 20 场的 semantic / layout / opening 相似度
 *   4. Grounding           —— 无依据 claim 必须为 0
 *   5. Time-to-Publish     —— 老板丢资料到可发布的时间
 *
 * ★ 设计纪律（与 §八 保持一致）：
 *   - semantic 相似度优先用指纹里已落库的 thesisEmbedding 做余弦（纯数学、不额外调 API）；
 *     拿不到向量时降级到 bigram（copySimilarity），并置 semanticAvailable=false —— 绝不伪造语义分数。
 *   - Grounding 用**生产代码里那把唯一的尺子** groundClaims 重算，不在指标层另写一套判据
 *     （判据分叉是审计最贵的坑：审计通过 ≠ 引擎真这么判）。
 *   - 全部是纯计算，不写库、不发网络请求，可离线单测。
 */

import type { CreativeFingerprint } from '../contracts/fingerprints';
import type { ActivityTruth } from '../contracts/activityTruth';
import type { ContentBlock, PromoDocument } from '../contracts/promoDocument';
import { structureSimilarity, visualSimilarity, copySimilarity } from '../contracts/fingerprints';
import { cosineSim } from '../contracts/semantic';
import { groundClaims } from './quality';

/** 指标输入：一次生成落库后的可观察事实 */
export interface MetricsDocInput {
  id: string;
  scenario: string;
  createdAt: Date;
  publishedAt: Date | null;
  /** draft | published | archived */
  status: string;
  /** generationMeta.editorAction —— 非空 = 这份文档被老板改过 */
  editorAction?: string | null;
  fingerprint?: CreativeFingerprint | null;
  truth?: ActivityTruth | null;
  document?: PromoDocument | null;
}

export type EditRatioGrade = 'excellent' | 'acceptable' | 'watch' | 'poor';

export interface QualityMetrics {
  window: { scenario: string | null; sample: number; note: string };
  directPublishRate: {
    /** 生成后未经修改直接发布的占比（0~1） */
    rate: number;
    published: number;
    publishedWithoutEdit: number;
    total: number;
  };
  editRatio: {
    /** 被修改过的文档占比（0~1） */
    ratio: number;
    edited: number;
    total: number;
    /** 优 <15% / 可接受 15~30% / 注意 30~50% / 不合格 >50% */
    grade: EditRatioGrade;
    label: string;
  };
  diversity: {
    sample: number;
    /** 0~1，越低越多样 */
    semantic: number;
    layout: number;
    opening: number;
    /** false = 语义层降级到 bigram（指纹里没有 embedding 向量） */
    semanticAvailable: boolean;
  };
  grounding: {
    /** 无依据 claim 总数 —— 硬要求：必须为 0 */
    violations: number;
    docsScanned: number;
    ok: boolean;
    details: { id: string; count: number }[];
  };
  timeToPublish: {
    /** 平均毫秒；无已发布文档时为 0 */
    avgMs: number;
    medianMs: number;
    sample: number;
    avgHuman: string;
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Edit Ratio 分级（文档 §二十四 给出的三档，30~50% 之间文档未给档位，这里记为「注意」） */
export function gradeEditRatio(ratio: number): { grade: EditRatioGrade; label: string } {
  if (ratio < 0.15) return { grade: 'excellent', label: '优' };
  if (ratio <= 0.3) return { grade: 'acceptable', label: '可接受' };
  if (ratio > 0.5) return { grade: 'poor', label: '不合格' };
  return { grade: 'watch', label: '注意（文档未给档位，介于可接受与不合格之间）' };
}

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function humanDuration(ms: number): string {
  if (!ms || ms <= 0) return '—';
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  const rm = min % 60;
  if (h < 24) return rm ? `${h} 小时 ${rm} 分钟` : `${h} 小时`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d} 天 ${rh} 小时` : `${d} 天`;
}

/**
 * 计算 5 个质量指标。
 * @param docs 按 createdAt **倒序**（最新在前）传入；Diversity 只取最近 window 条。
 * @param window Diversity 的采样窗口（默认 20）
 */
export function computeQualityMetrics(
  docs: MetricsDocInput[],
  options?: { scenario?: string | null; window?: number }
): QualityMetrics {
  const win = Math.max(2, options?.window ?? 20);
  const scenario = options?.scenario ?? null;
  const total = docs.length;

  /* ---- 1 & 2：Direct Publish Rate / Edit Ratio ---- */
  const published = docs.filter((d) => d.status === 'published' && d.publishedAt);
  const edited = docs.filter((d) => !!d.editorAction);
  const publishedWithoutEdit = published.filter((d) => !d.editorAction);
  const editRatio = total ? edited.length / total : 0;
  const { grade, label } = gradeEditRatio(editRatio);

  /* ---- 3：Diversity（最近 window 条两两比较） ---- */
  const recent = docs
    .filter((d) => !!d.fingerprint)
    .slice(0, win)
    .map((d) => d.fingerprint as CreativeFingerprint);

  let semSum = 0;
  let semPairs = 0;
  let semAvailable = false;
  let layoutSum = 0;
  let layoutPairs = 0;
  let openSame = 0;
  let openPairs = 0;

  for (let i = 0; i < recent.length; i++) {
    for (let j = i + 1; j < recent.length; j++) {
      const a = recent[i];
      const b = recent[j];

      // semantic：优先用落库向量做余弦；两侧都有才算「语义层真可用」
      if (a.thesisEmbedding && b.thesisEmbedding) {
        semSum += cosineSim(a.thesisEmbedding, b.thesisEmbedding);
        semAvailable = true;
      } else {
        semSum += copySimilarity(a.thesisText, b.thesisText);
      }
      semPairs++;

      // layout：结构相似度与视觉相似度取均值（两者都是「排法」层面的重复）
      layoutSum += (structureSimilarity(a, b) + visualSimilarity(a, b)) / 2;
      layoutPairs++;

      // opening：开场方式是否雷同（完全相同 = 1）
      const oa = String(a.openingMode ?? '');
      const ob = String(b.openingMode ?? '');
      if (oa && ob) {
        if (oa === ob) openSame++;
        openPairs++;
      }
    }
  }

  /* ---- 4：Grounding（用生产那把尺子重算） ---- */
  const details: { id: string; count: number }[] = [];
  let violations = 0;
  for (const d of docs) {
    const truth = d.truth;
    const blocks = (d.document?.blocks ?? []) as ContentBlock[];
    if (!truth || !blocks.length) continue;
    const res = groundClaims(blocks, truth);
    if (res.violations.length) {
      violations += res.violations.length;
      details.push({ id: d.id, count: res.violations.length });
    }
  }

  /* ---- 5：Time-to-Publish ---- */
  const durations = published
    .map((d) => (d.publishedAt as Date).getTime() - d.createdAt.getTime())
    .filter((n) => Number.isFinite(n) && n >= 0);
  const avgMs = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;

  return {
    window: {
      scenario,
      sample: total,
      note: total ? `统计最近 ${total} 份文档` : '暂无数据',
    },
    directPublishRate: {
      rate: total ? round3(publishedWithoutEdit.length / total) : 0,
      published: published.length,
      publishedWithoutEdit: publishedWithoutEdit.length,
      total,
    },
    editRatio: {
      ratio: round3(editRatio),
      edited: edited.length,
      total,
      grade,
      label,
    },
    diversity: {
      sample: recent.length,
      semantic: semPairs ? round3(semSum / semPairs) : 0,
      layout: layoutPairs ? round3(layoutSum / layoutPairs) : 0,
      opening: openPairs ? round3(openSame / openPairs) : 0,
      semanticAvailable: semAvailable,
    },
    grounding: {
      violations,
      docsScanned: docs.filter((d) => !!d.truth && (d.document?.blocks ?? []).length > 0).length,
      ok: violations === 0,
      details: details.slice(0, 20),
    },
    timeToPublish: {
      avgMs: Math.round(avgMs),
      medianMs: Math.round(median(durations)),
      sample: durations.length,
      avgHuman: humanDuration(avgMs),
    },
  };
}
