/**
 * Content Engine V3 —— Creative Direction / StyleVector 契约
 * 文档 §七.2 / §七.3
 *
 * 重要（文档明令禁止）：
 *   不得再用 style = "magazine" / "diary" / "family" 之类的固定 style enum 作为生成入口。
 *   这些最多只能作为「调试后的描述标签」。
 *   差异化必须由 StyleVector 的连续量纲 + 动态 direction 产生。
 */

export interface StyleVector {
  imageDominance: number; // 0~1
  textDensity: number; // 0~1
  informationWeight: number; // 0~1
  emotionalWeight: number; // 0~1

  documentaryLevel: number;
  aspirationLevel: number;
  socialEnergy: number;
  challengeSignal: number;
  lifestyleSignal: number;
  professionalSignal: number;

  ctaStrength: number;

  rhythm: 'slow' | 'medium' | 'fast';
  whitespace: 'tight' | 'balanced' | 'generous';

  typographyEnergy: number;
}

export interface CreativeDirection {
  id: string;

  thesis: string;
  targetAudience: string;
  primaryMotivation: string;
  primaryBarrier: string;

  communicationAngle: string;

  /** 支撑本方向的事实/素材引用，必须可回溯到 ActivityTruth 或 Vision */
  evidenceRefs: string[];

  narrativeStrategy: string[];

  styleVector: StyleVector;

  expectedVisualStrategy: string;

  /** 为什么选这个方向 —— 只做内部推理留痕，绝不上屏给用户看 */
  rationale: string;
}

export const STYLE_NUMERIC_KEYS: ReadonlyArray<keyof StyleVector> = [
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
] as const;

export function clamp01(n: unknown, fallback = 0.5): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(0, Math.min(1, v));
}

/**
 * 中性默认 StyleVector。
 * 不带任何品牌预设 —— 俱乐部品牌调性来自 BrandProfile，不来自默认值。
 */
export function neutralStyleVector(overrides: Partial<StyleVector> = {}): StyleVector {
  const base: StyleVector = {
    imageDominance: 0.6,
    textDensity: 0.45,
    informationWeight: 0.5,
    emotionalWeight: 0.5,
    documentaryLevel: 0.5,
    aspirationLevel: 0.5,
    socialEnergy: 0.4,
    challengeSignal: 0.4,
    lifestyleSignal: 0.4,
    professionalSignal: 0.5,
    ctaStrength: 0.5,
    rhythm: 'medium',
    whitespace: 'balanced',
    typographyEnergy: 0.5,
  };
  return normalizeStyleVector({ ...base, ...overrides });
}

/** 归一化：把任意来源（AI 常常越界或给字符串）的 StyleVector 收进合法区间 */
export function normalizeStyleVector(input: Partial<StyleVector> | undefined | null): StyleVector {
  const src = (input ?? {}) as Record<string, unknown>;
  const out = {} as StyleVector;
  for (const k of STYLE_NUMERIC_KEYS) {
    (out as unknown as Record<string, number>)[k] = clamp01(src[k as string], 0.5);
  }
  const rhythm = String(src.rhythm ?? '');
  out.rhythm = rhythm === 'slow' || rhythm === 'fast' ? rhythm : 'medium';
  const ws = String(src.whitespace ?? '');
  out.whitespace = ws === 'tight' || ws === 'generous' ? ws : 'balanced';
  return out;
}

/**
 * 两个方向的差异度（0~1）。用于 Diversity Controller：
 * 3 个候选方向必须有真实差异，否则等于没生成。
 */
export function styleVectorDistance(a: StyleVector, b: StyleVector): number {
  if (!STYLE_NUMERIC_KEYS.length) return 0;
  let sum = 0;
  for (const k of STYLE_NUMERIC_KEYS) {
    sum += Math.abs((a[k] as number) - (b[k] as number));
  }
  const numeric = sum / STYLE_NUMERIC_KEYS.length; // 0~1
  const rhythmDiff = a.rhythm === b.rhythm ? 0 : 1;
  const wsDiff = a.whitespace === b.whitespace ? 0 : 1;
  return Math.min(1, numeric * 0.8 + rhythmDiff * 0.1 + wsDiff * 0.1);
}

/** 是否为「换个颜色的同一个方向」——  thesis 高度相似时即便 style 有差异也应拒收 */
export function isSameThesis(a: string, b: string): boolean {
  const norm = (s: string) => String(s ?? '').replace(/[\s，。、,.!！?？:：;；"'"'()（）]/g, '');
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  return x === y;
}
