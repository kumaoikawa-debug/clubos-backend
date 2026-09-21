/**
 * ai-content-vnext —— 共享类型定义
 *
 * 严格对应 Clean Rewrite 文档 V1.0：
 *   §6  Activity Master
 *   §7  信息分类（publicFacts / internalData / promoMaterial / conflicts）
 *   §8  Editorial Plan
 *   §10 Promo Blocks（仅 12 型）
 *   §19 事实安全
 *   §20 图片证据 materialEvidence / eventFact 区分
 *
 * 设计纪律（§32）：
 *   - 原始资料整体直喂模型，不预先压成几十个字段；
 *   - Block 类型有限（12），但顺序 / 数量 / 组合无限；
 *   - 允许创造表达，不允许创造事实。
 */

/** 上传源材料（§4 / §7） */
export type SourceMaterialType =
  | 'text'
  | 'ppt'
  | 'word'
  | 'pdf'
  | 'image'
  | 'poster'
  | 'legacy';

export interface SourceMaterial {
  id: string;
  type: SourceMaterialType;
  /** 抽取后的原文 / 说明文字（PPT/Word/PDF 取页面文本，image/poster 取图注或留空） */
  text?: string;
  /** 关联图片 media id（image / poster 类型使用） */
  imageRefs?: string[];
  /** 原始版面关系等元数据（可选） */
  raw?: Record<string, unknown>;
}

/** 图片 / 素材引用（§20） */
export interface MediaRef {
  id: string;
  src: string;
  orientation?: 'landscape' | 'portrait' | 'square';
  caption?: string;
  /**
   * materialEvidence=true 表示「这张图是历史素材证据」（图里有篝火 ≠ 本次活动有篝火）。
   * eventFact=true 表示「资料明确写成本次活动事实」。两者互斥优先 eventFact。
   */
  materialEvidence?: boolean;
  eventFact?: boolean;
  /** 图中主体（人物 / 风景 / 食材等），用于 Renderer 安全裁剪与排版 */
  subjects?: string[];
}

/** 信息冲突（§7 D） */
export interface Conflict {
  field: string;
  values: unknown[];
  reason: string;
  /** blocking=true 才询问用户 */
  blocking: boolean;
}

/** Source Understanding 输出（§7 / Task 4） */
export interface SourceUnderstanding {
  publicFacts: Record<string, unknown>;
  internalData: Record<string, unknown>;
  promoMaterial: { kind: string; text: string }[];
  conflicts: Conflict[];
  sourceMaterials: SourceMaterial[];
}

/** Activity Master：一场活动唯一数据母体（§6 STEP 2 / Task 5） */
export interface ActivityMaster {
  activityId: string;
  publicFacts: Record<string, unknown>;
  itinerary: unknown[];
  fees: Record<string, unknown>;
  checklist: unknown[];
  services: unknown[];
  photos: MediaRef[];
  sourceMaterials: SourceMaterial[];
  sellingEvidence: unknown[];
  /** 仅后台使用，不得进入 C 端 */
  internalData: Record<string, unknown>;
  brandContext: Record<string, unknown>;
  uncertainties: Conflict[];
}

/** Editorial Plan 单段（§8） */
export interface EditorialPlanItem {
  purpose: string;
  whatToSay: string;
  evidenceRefs: string[];
  imageNeed: string;
  textWeight: number;
  visualWeight: number;
}

/** Editorial Plan（§8 STEP 3） */
export interface EditorialPlan {
  activityUnderstanding: string;
  coreSellingIdea: string;
  targetAudience: string;
  mainUserMotivation: string;
  mainUserBarrier: string;
  editorialStrategy: string;
  visualStrategy: string;
  /** 长度不固定（3~8+），禁止固定章节骨架 */
  editorialPlan: EditorialPlanItem[];
}

/** 12 个允许的 Block 类型（§10） */
export type PromoBlockType =
  | 'hero'
  | 'text'
  | 'statement'
  | 'metric_strip'
  | 'single_image'
  | 'image_pair'
  | 'image_triplet'
  | 'image_group'
  | 'text_image'
  | 'quote'
  | 'divider'
  | 'cta';

export const PROMO_BLOCK_TYPES: PromoBlockType[] = [
  'hero',
  'text',
  'statement',
  'metric_strip',
  'single_image',
  'image_pair',
  'image_triplet',
  'image_group',
  'text_image',
  'quote',
  'divider',
  'cta',
];

/** Promo Block（§10 STEP 4） */
export interface PromoBlock {
  type: PromoBlockType;
  headline?: string;
  subtitle?: string;
  text?: string;
  metrics?: { label: string; value: string }[];
  mediaRefs?: string[];
  body?: string;
  caption?: string;
  ctaText?: string;
  ctaAction?: string;
}

export interface PromoBlocks {
  blocks: PromoBlock[];
}

/** 事实安全校验维度（§19 / Task 10） */
export type FactField =
  | 'time'
  | 'place'
  | 'price'
  | 'itinerary'
  | 'participation'
  | 'leader'
  | 'insurance'
  | 'weather'
  | 'event';

export interface GroundingIssue {
  blockIndex: number;
  field: FactField;
  snippet: string;
  reason: string;
  severity: 'warn' | 'block';
}

export interface MaterialEvidenceFlag {
  mediaId: string;
  materialEvidence: boolean;
  eventFact: boolean;
  note: string;
}

export interface GroundingReport {
  passed: boolean;
  issues: GroundingIssue[];
  materialEvidenceFlags: MaterialEvidenceFlag[];
}

/** 编排器最终产出 */
export interface PromoCanvasResult {
  activityMaster: ActivityMaster;
  editorialPlan: EditorialPlan;
  blocks: PromoBlock[];
  grounding: GroundingReport;
  /** 调用计量（来自 proxyChat） */
  usage?: { credits: number; tokens: number; balance: number; source: string };
}

/** 编排器输入 */
export interface GeneratePromoInput {
  merchantId: string;
  activityId: string;
  /** 活动主记录（DB 字段，可选） */
  activity?: Record<string, unknown>;
  /** 原始上传源材料 */
  sourceMaterials?: SourceMaterial[];
  /** 已上传图片（含 orientation / materialEvidence 等元数据） */
  photos?: MediaRef[];
  /** 自然语言改稿指令（revise 时使用） */
  instruction?: string;
  /** 既有 blocks（revise 时携带，用于约束「不要推翻已有正确事实」 */
  existingBlocks?: PromoBlock[];
}
