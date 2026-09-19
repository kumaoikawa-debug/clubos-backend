/**
 * Content Engine V3 —— CreativeFingerprint 契约
 * 文档 §八
 *
 * Scope = merchantId + scenario：
 *   CreativeMemory[merchantId]['detail' | 'wechat' | 'xiaohongshu' | 'recap']
 * 每类保留最近至少 20 次。
 */

import type { ContentBlock, ContentBlockType, PromoScenario } from './promoDocument';
import type { StyleVector } from './creativeDirection';

export interface CreativeFingerprint {
  thesisEmbedding?: number[];
  thesisText: string;

  /**
   * v3.1 新增：与本次创作对应的 StyleVector。
   * 之前指纹里只有文案与结构，导致 selectDirection 的 historyVectors 永远是空数组 ——
   * 跨场次去重只比了「说了什么」，没比「用什么调性说的」，
   * 于是连着几场活动都长一个样却检测不出来。旧行没有此字段，读时按缺失处理（向后兼容）。
   */
  styleVector?: StyleVector;

  titlePattern: string;
  openingMode: string;

  blockPurposeSequence: string[];
  componentSequence: string[];

  heroMode: string;

  mediaTextRatio: number;

  imageGroupPattern: string[];

  textDensityPattern: number[];

  infoPosition: string;
  ctaPosition: string;

  signaturePhrases: string[];
}

export interface FingerprintInput {
  thesisText: string;
  titlePattern?: string;
  openingMode?: string;
  blocks?: ContentBlock[];
  scenario?: PromoScenario;
  styleVector?: StyleVector;
}

function round(n: number, p = 3): number {
  return Math.round(n * 10 ** p) / 10 ** p;
}

/**
 * 从 blocks 计算指纹。
 * 结构/视觉相似都建立在这上面 —— renderer 不再关心 style enum。
 */
export function buildCreativeFingerprint(input: FingerprintInput): CreativeFingerprint {
  const blocks = Array.isArray(input.blocks) ? input.blocks : [];
  const types = blocks.map((b) => b.type);
  const mediaCount = blocks.filter((b) => (b.mediaRefs?.length ?? 0) > 0).length;
  const total = blocks.length || 1;
  const heroIdx = blocks.findIndex((b) => b.type === 'hero');
  const ctaIdx = blocks.findIndex((b) => b.type === 'cta');

  const imageGroupPattern: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const t = blocks[i].type as ContentBlockType;
    if (t === 'image_group' || t === 'gallery' || t === 'image') {
      const n = blocks[i].mediaRefs?.length ?? 0;
      if (n >= 3) imageGroupPattern.push(`${t}:${n}`);
    }
  }

  return {
    thesisText: input.thesisText ?? '',
    ...(input.styleVector ? { styleVector: input.styleVector } : {}),
    titlePattern: input.titlePattern ?? '',
    openingMode: input.openingMode ?? '',
    blockPurposeSequence: blocks.map((b) => b.purpose || b.type),
    componentSequence: types,
    heroMode: heroIdx >= 0 ? `blocks[${heroIdx}]:${blocks[heroIdx].type}` : 'none',
    mediaTextRatio: round(mediaCount / total),
    imageGroupPattern,
    textDensityPattern: blocks.map((b) => round((b.copy?.body?.length ?? 0) / 200, 2)),
    infoPosition: infoPositionOf(blocks),
    ctaPosition: ctaIdx >= 0 ? `${ctaIdx + 1}/${blocks.length}` : 'none',
    signaturePhrases: [],
  };
}

/** Info Stack 在 PromoDocument 里的位置 —— V3 下 Info Stack 不在 Creative blocks 内，默认 trailing */
function infoPositionOf(blocks: ContentBlock[]): string {
  if (!blocks.length) return 'trailing';
  const last = blocks[blocks.length - 1].type;
  return last === 'cta' ? 'after-cta' : 'trailing';
}

/**
 * 结构相似度（0~1）—— 文档 §八「Structure Similarity」第一层（离线可用）。
 * 语义层必须走 embedding 或 LLM judge，不在这里伪造。
 */
export function structureSimilarity(a: CreativeFingerprint, b: CreativeFingerprint): number {
  const seqScore = jaccard(a.componentSequence, b.componentSequence);
  const purposeScore = jaccard(a.blockPurposeSequence, b.blockPurposeSequence);
  const heroScore = a.heroMode === b.heroMode ? 1 : 0;
  const ctaScore = a.ctaPosition === b.ctaPosition ? 1 : 0;
  return round(seqScore * 0.4 + purposeScore * 0.3 + heroScore * 0.15 + ctaScore * 0.15);
}

/** 取出历史里可用的 StyleVector（旧行无此字段会被跳过，不做猜测补齐） */
export function extractStyleVectors(list: readonly CreativeFingerprint[]): StyleVector[] {
  return (list || []).map((f) => f.styleVector).filter(Boolean) as StyleVector[];
}

/**
 * 风格向量距离（0~1，越小越像）。
 * 文档禁止用 style enum 做区分，因此这里必须比的是 StyleVector 的连续量纲。
 */
export function styleDistance(a: StyleVector, b: StyleVector): number {
  const keys: ReadonlyArray<keyof StyleVector> = [
    'imageDominance',
    'textDensity',
    'informationWeight',
    'emotionalWeight',
    'documentaryLevel',
    'aspirationLevel',
    'socialEnergy',
    'challengeSignal',
    'lifestyleSignal',
    'professionalSignal',
    'ctaStrength',
    'typographyEnergy',
  ];
  let sum = 0;
  for (const k of keys) {
    const x = Number(a[k]);
    const y = Number(b[k]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    sum += Math.abs(x - y);
  }
  return round(Math.min(1, sum / keys.length));
}

/** 视觉相似度（0~1）—— hero mode + 图文比 + 图像分组 + 文本密度节奏 */
export function visualSimilarity(a: CreativeFingerprint, b: CreativeFingerprint): number {
  const ratio = 1 - Math.min(1, Math.abs(a.mediaTextRatio - b.mediaTextRatio));
  const group = jaccard(a.imageGroupPattern, b.imageGroupPattern);
  const density = densityDistance(a.textDensityPattern, b.textDensityPattern);
  const hero = a.heroMode === b.heroMode ? 1 : 0;
  return round(ratio * 0.35 + group * 0.25 + density * 0.2 + hero * 0.2);
}

function jaccard(x: readonly string[], y: readonly string[]): number {
  const sx = new Set(x.filter(Boolean));
  const sy = new Set(y.filter(Boolean));
  if (!sx.size && !sy.size) return 1;
  if (!sx.size || !sy.size) return 0;
  let inter = 0;
  sx.forEach((v) => sy.has(v) && inter++);
  const union = sx.size + sy.size - inter;
  return union ? inter / union : 0;
}

function densityDistance(x: readonly number[], y: readonly number[]): number {
  const n = Math.min(x.length, y.length);
  if (!n) return 1;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(x[i] - y[i]);
  return 1 - Math.min(1, sum / n);
}
