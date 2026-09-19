/**
 * Content Engine V3 —— Channel 契约（公众号 / 小红书 / 回顾）
 * 文档 §十四 / §十五 / §十六
 *
 * 三条铁律（与 detail 同源）：
 *   1. 渠道不是「详情页复制一遍」。每个渠道要重新判断首屏节奏、长度、
 *      图片数量与位置、标题、摘要、CTA —— 见 WechatBlueprint 的字段。
 *   2. 禁止固定结构：不得写死「开场→核心记忆→照片→下一期」这类序列。
 *      Recap 尤其被明令禁止（§十六 结尾）。
 *   3. evidenceRefs 必须可回溯到 ActivityTruth / Vision / 现场数据，找不到就留空，不许编。
 */

import type { GenerationMeta } from './promoDocument';
import type { CreativeDirection } from './creativeDirection';

/* ============================================================
 * 公众号（§十四）
 * ========================================================== */

/** 一段可渲染成微信正文的富文本块 —— 不是视觉布局块，是「文章」单位 */
export interface WechatTextSection {
  /** 承担的传播任务，如「打消体力顾虑」——不是样式名 */
  purpose: string;
  /** 小标题（可空：并非每段都要有标题，这是相对于模板的重要自由度） */
  heading?: string;
  paragraphs: string[];
  /** 本段要不要配图、配几张（图的位置是公众号节奏的一部分） */
  imageSlots: number;
  evidenceRefs: string[];
}

export interface WechatBlueprint {
  /** 标题策略描述（写给内部看），与最终 title 分开 */
  titleStrategy: string;
  /** 摘要 ≤ 120 字 */
  summary: string;
  /** 开场方式：从什么切入（不是模板句） */
  opening: string;
  sections: WechatTextSection[];
  closing: string;
  cta: string;
}

export interface WechatDocument {
  schemaVersion: 3;
  scenario: 'wechat';
  activityId: string;

  /** 多个候选标题供人选 §十四要求「要针对微信重新判断标题」 */
  titleOptions: string[];
  title: string;
  digest: string;

  /** 最终可直接粘贴进公众号后台的富文本（inline style、不依赖 JS/外链 CSS） */
  html: string;

  /** 封面图建议：照片序号（0-based），-1 表示无 */
  coverIndex: number;
  /** 图片在正文中的出场顺序 —— 图片位置是内容的一部分 */
  imageOrder: number[];

  direction: CreativeDirection;
  generationMeta: GenerationMeta;
}

/* ============================================================
 * 小红书（§十五）
 * ========================================================== */

/** 图片序列里每一格都承担明确任务 —— 「图片顺序是内容的一部分」 */
export interface XhsImageSlot {
  photoIndex: number;
  /** 这张图在叙事里承担什么，如「给出目的地实感」 */
  role: string;
  caption: string;
}

export interface XiaohongshuDocument {
  schemaVersion: 3;
  scenario: 'xiaohongshu';
  activityId: string;

  /** 第一句钩子 —— 决定要不要点开 */
  hook: string;
  /** 标题候选（小红书标题有强字数与符号习惯） */
  titleOptions: string[];
  mainAngle: string;
  body: string;

  imageSequence: XhsImageSlot[];
  coverSuggestion: number;

  tags: string[];
  cta: string;

  direction: CreativeDirection;
  generationMeta: GenerationMeta;
}

/* ============================================================
 * 活动回顾（§十六）
 * ========================================================== */

/**
 * 现场真实数据 —— 与 planned facts 严格分离。
 * 这是 recap 与 promo 的根本区别：promo 谈计划，recap 谈发生过的事。
 */
export interface ActualActivityData {
  attendance?: number;
  weather?: string;
  actualRoute?: string;
  highlights?: string[];
  /** 真实参与者反馈（有才有，没有就是空数组，绝不代填） */
  feedbacks?: string[];
  onSiteNotes?: string[];
  photos?: { id: string; caption?: string }[];
}

/** 本次真正最值得留下什么 —— 可能是人/雨/登顶/一顿饭，不由结构决定 */
export interface RecapInsight {
  coreMemory: string;
  whyItMatters: string;
  evidence: string[];
}

export interface RecapSection {
  purpose: string;
  heading?: string;
  paragraphs: string[];
  imageSlots: number;
  evidenceRefs: string[];
}

export interface RecapDocument {
  schemaVersion: 3;
  scenario: 'recap';
  activityId: string;

  insight: RecapInsight;
  sections: RecapSection[];
  html: string;

  coverIndex: number;
  imageOrder: number[];

  direction: CreativeDirection;
  generationMeta: GenerationMeta;
}

/* ============================================================
 * 共用
 * ========================================================== */

export const CHANNEL_SCENARIOS = ['wechat', 'xiaohongshu', 'recap'] as const;
export type ChannelScenario = (typeof CHANNEL_SCENARIOS)[number];

export function isChannelScenario(v: unknown): v is ChannelScenario {
  return typeof v === 'string' && (CHANNEL_SCENARIOS as readonly string[]).includes(v);
}
