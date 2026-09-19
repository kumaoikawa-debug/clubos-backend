/**
 * Content Engine V3 —— Activity Truth 契约
 *
 * 规则（来自 V3 文档 §七.1）：
 *  confirmedFacts / itinerary / fee / checklist / groundedScenes
 *  才可以进入「事实表达」。
 *
 *  creativeContext 只能决定「怎么讲」，不能证明「发生了什么」。
 *  任何生成器都不得把 creativeContext 当事实引用。
 */

/** 已确认事实 —— 唯一可写成陈述句的来源 */
export interface ConfirmedFacts {
  title?: string;
  date?: string;
  place?: string;
  meeting?: string;
  price?: number;
  limit?: number;
  difficulty?: string;
  distance?: string;
  elevation?: string;
  days?: number;
  leader?: unknown;
  insurance?: unknown;
  signup?: unknown;
}

export interface FeeSpec {
  include: string[];
  exclude: string[];
  addons?: string[];
  refundRules?: string[];
}

export interface ChecklistSpec {
  required: string[];
  recommended: string[];
  optional?: string[];
}

/**
 * 接地场景 —— 「可以拿来描写」的画面素材
 * 注意 vision 来源只在 materialEvidence 范围内成立：
 * 它证明「上传素材里有什么」，不自动证明「本次活动会发生什么」。
 */
export interface GroundedScene {
  value: string;
  source: 'user' | 'itinerary' | 'vision' | 'manual_confirm';
  confidence?: number;
}

/** 创意上下文 —— 只影响表达，不构成事实证据 */
export interface CreativeContext {
  season?: string;
  possibleAngles?: string[];
  activityMotivation?: string[];
  brandTone?: string[];
}

export interface ActivityTruth {
  activityId: string;
  merchantId: string;
  confirmedFacts: ConfirmedFacts;
  itinerary: unknown[];
  fee: FeeSpec;
  checklist: ChecklistSpec;
  groundedScenes: GroundedScene[];
  creativeContext: CreativeContext;
}

export function emptyConfirmedFacts(): ConfirmedFacts {
  return {};
}

export function emptyActivityTruth(activityId: string, merchantId: string): ActivityTruth {
  return {
    activityId,
    merchantId,
    confirmedFacts: emptyConfirmedFacts(),
    itinerary: [],
    fee: { include: [], exclude: [] },
    checklist: { required: [], recommended: [] },
    groundedScenes: [],
    creativeContext: {},
  };
}

/** creativeContext 是否为空 —— 空则生成器不得引用任何品牌/季节假设 */
export function hasCreativeContext(ctx: CreativeContext | undefined): boolean {
  if (!ctx) return false;
  return Boolean(
    ctx.season ||
      (ctx.possibleAngles && ctx.possibleAngles.length) ||
      (ctx.activityMotivation && ctx.activityMotivation.length) ||
      (ctx.brandTone && ctx.brandTone.length)
  );
}
