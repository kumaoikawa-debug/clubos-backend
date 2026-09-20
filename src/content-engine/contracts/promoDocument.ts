/**
 * Content Engine V3 —— PromoDocument / ContentBlock 契约
 * 文档 §七.4 / §七.5
 *
 * Block 是「视觉词汇」，不是「模板」。
 * AI 可以使用有限的合法 Block，但不能从预设 Page Template 里选固定 Block 顺序。
 */

import type { CreativeDirection } from './creativeDirection';
import type { CreativeFingerprint } from './fingerprints';

export const CONTENT_BLOCK_TYPES = [
  'hero',
  'lead',
  'statement',
  'image',
  'image_group',
  'text_image',
  'metric',
  'quote',
  'chapter_break',
  'gallery',
  'cta',
] as const;

export type ContentBlockType = (typeof CONTENT_BLOCK_TYPES)[number];

export type BlockWidth = 'normal' | 'wide' | 'full';
export type Alignment = 'left' | 'center' | 'right';
export type Whitespace = 'tight' | 'balanced' | 'generous';

export interface BlockCopy {
  headline?: string;
  body?: string;
  caption?: string;
}

export interface BlockLayout {
  width: BlockWidth;
  alignment?: Alignment;
  /** 0~1：该块里媒体相对文字的主导程度 */
  mediaDominance?: number;
  columns?: number;
  whitespace?: Whitespace;
  /** 0~1：视觉强调强度 */
  emphasis?: number;
}

export interface ContentBlock {
  id: string;
  type: ContentBlockType;
  /** 这块在传播上承担什么（如「建立渴望」/「消除顾虑」），不是样式名 */
  purpose: string;
  communicationGoal: string;
  /** 支撑这块内容的事实/素材引用，必须可回溯 */
  evidenceRefs: string[];
  copy?: BlockCopy;
  mediaRefs?: string[];
  layout: BlockLayout;
}

export type PromoScenario = 'detail' | 'wechat' | 'xiaohongshu' | 'recap';

export interface GenerationMeta {
  model: string;
  workflowVersion: string;
  generatedAt: string;
  repairCount: number;
  /**
   * 与同渠道最近内容是否被判为「高度重复」（Step 12 的 tooRepetitive）。
   *
   * ★ 单独记这个字段的原因：只有 detail 会真的去改稿（repairDocument），
   *   公众号/小红书/回顾目前没有 repair 步骤。它们原先把 tooRepetitive 直接写进
   *   repairCount，于是验收里读到「回顾 6 场全部 repair 1 次」——
   *   而实际上一次都没改过。指标必须说真话：没改就是 repairCount=0，
   *   「像不像历史」单独记在这里。
   */
  repetitive?: boolean;
  /**
   * 创意方向是否真的由 LLM 产出（false = 走了确定性兜底）。
   *
   * ★ 必须落进文档：`model: 'platform-llm'` 只说明「本该走 LLM」，
   *   看不出**实际有没有用上**。积分用尽 / Key 失效时全线兜底，请求照样 200、
   *   文档照样生成、日志里只有一行 warn —— 运维侧几乎零信号，
   *   只能靠人工觉得「最近文案怎么这么模板」。
   *   验收跑批 30 场里 22 场是兜底，就是靠等价的旁证才发现的。
   */
  llmUsed?: boolean;
  /** 兜底原因（仅 llmUsed=false 时存在）：积分不足 / 平台 Key 未配置 / 超时 / 供应商报错 */
  fallbackReason?: string;
}

export interface PromoDocument {
  schemaVersion: 3;
  activityId: string;
  scenario: PromoScenario;
  truthSnapshotId?: string;
  direction: CreativeDirection;
  openingMode: string;
  blocks: ContentBlock[];
  fingerprint: CreativeFingerprint;
  generationMeta: GenerationMeta;
}

export function isValidBlockType(t: unknown): t is ContentBlockType {
  return typeof t === 'string' && (CONTENT_BLOCK_TYPES as readonly string[]).includes(t);
}

export function normalizeLayout(input: Partial<BlockLayout> | undefined): BlockLayout {
  const src = (input ?? {}) as Record<string, unknown>;
  const num = (v: unknown, d?: number) => {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : d;
  };
  const width = String(src.width ?? '');
  const align = String(src.alignment ?? '');
  const ws = String(src.whitespace ?? '');
  const cols = Number(src.columns);
  const out: BlockLayout = {
    width: width === 'wide' || width === 'full' ? (width as BlockWidth) : 'normal',
  };
  if (align === 'left' || align === 'center' || align === 'right') out.alignment = align;
  const md = num(src.mediaDominance);
  if (md !== undefined) out.mediaDominance = md;
  if (Number.isFinite(cols) && cols >= 1 && cols <= 4) out.columns = Math.floor(cols);
  if (ws === 'tight' || ws === 'generous' || ws === 'balanced') out.whitespace = ws;
  const em = num(src.emphasis);
  if (em !== undefined) out.emphasis = em;
  return out;
}

/**
 * 丢弃不合法引用的 evidence：
 * evidenceRefs 必须能在 truth / vision 索引里找到，否则这块内容等于「无依据 claim」。
 */
export function filterKnownEvidence(refs: string[] | undefined, known: string[]): string[] {
  if (!Array.isArray(refs)) return [];
  const set = new Set(known);
  return refs.filter((r) => typeof r === 'string' && set.has(r));
}
