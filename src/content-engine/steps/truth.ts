/**
 * Content Engine V3 —— Workflow 步骤 Step 1~3
 * Step 1 normalizeInput / Step 2 buildTruth / Step 3 analyzeMedia
 *
 * 铁律（文档 §七.1 + §二十六）：
 *  - buildTruth 只做「事实合并、来源优先级、缺失识别」，绝不写宣传文案。
 *  - creativeContext 只能决定怎么讲，不能证明发生了什么。
 *  - 占位符（10月xx日 / 待定 / TBD）不得进入 confirmedFacts —— 否则会泄漏到页面。
 */

import type { ActivityTruth, GroundedScene } from '../contracts/activityTruth';
import { emptyActivityTruth } from '../contracts/activityTruth';
import { analyzeImagesV3 } from '../../services/visionService';
import type { VisionResult } from '../contracts/visionResult';

export interface PhotoRef {
  id: string;
  src?: string;
}

export interface RawActivityInput {
  activityId: string | number;
  merchantId: string | number;
  /** 活动主记录 */
  activity?: Record<string, unknown>;
  /** 方案抽取事实（上传的 Word/PPT/PDF/海报解析结果）—— 优先级最高 */
  planFacts?: Record<string, unknown>;
  /** 方案原文片段，用于接地场景抽取 */
  materialText?: string[];
  photos?: PhotoRef[];
}

export interface NormalizedActivityInput {
  activityId: string;
  merchantId: string;
  activity: Record<string, unknown>;
  planFacts: Record<string, unknown>;
  materialText: string[];
  photos: PhotoRef[];
}

/** Step 1：输入归一化，补齐空值，后续步骤不必再判空 */
export function normalizeInput(input: RawActivityInput): NormalizedActivityInput {
  return {
    activityId: String(input.activityId ?? ''),
    merchantId: String(input.merchantId ?? ''),
    activity: input.activity ?? {},
    planFacts: input.planFacts ?? {},
    materialText: Array.isArray(input.materialText) ? input.materialText.filter(Boolean) : [],
    photos: Array.isArray(input.photos) ? input.photos : [],
  };
}

/** 事实值可接受性判断（true=可接受，占位符/无具体日期一律 false）
    命名说明：这里返回的是「能不能收」，不是「有没有拒」 —— 早先叫 rejectPlaceholder，
    语义与函数名正好相反，容易被人写成反的。与前端 v215 factPlaceholderReject 同口径。 */
export function acceptsFactValue(value: unknown, kind: 'date' | 'price' | 'text'): boolean {
  if (value === null || value === undefined) return false;
  const s = String(value).trim();
  if (!s) return false;
  if (kind === 'date') {
    if (/(xx|XX|待定|暂定|TBD|tbd|某日|几号|上旬|中旬|下旬)/.test(s)) return false;
    // 必须含具体「日」：26日 / 26号 / 2026-10-01
    return /(?:^|\D)(\d{1,2})\s*[日号]/.test(s) || /\d{4}[-/年]\d{1,2}[-/月]\d{1,2}/.test(s);
  }
  if (kind === 'price') {
    return /\d/.test(s);
  }
  return !/(待定|暂定|TBD|tbd)/.test(s);
}

function pickTruthValue(sources: Record<string, unknown>[], key: string): unknown {
  // 来源优先级：planFacts > activity（按传入顺序）
  for (const src of sources) {
    const v = src?.[key];
    if (v === undefined || v === null || v === '') continue;
    const kind: 'date' | 'price' | 'text' = key === 'date' ? 'date' : key === 'price' ? 'price' : 'text';
    if (!acceptsFactValue(v, kind)) continue;
    return v;
  }
  return undefined;
}

/** Step 2：构建 ActivityTruth（纯函数，不写文案，不调用 AI） */
export function buildTruth(input: NormalizedActivityInput): ActivityTruth {
  const truth = emptyActivityTruth(input.activityId, input.merchantId);
  const sources = [input.planFacts, input.activity];

  const date = pickTruthValue(sources, 'date');
  if (date !== undefined) truth.confirmedFacts.date = String(date);

  const title = pickTruthValue(sources, 'title');
  if (title !== undefined) truth.confirmedFacts.title = String(title);

  const place = pickTruthValue(sources, 'place');
  if (place !== undefined) truth.confirmedFacts.place = String(place);

  const meeting = pickTruthValue(sources, 'meeting');
  if (meeting !== undefined) truth.confirmedFacts.meeting = String(meeting);

  const price = pickTruthValue(sources, 'price');
  if (price !== undefined) {
    const n = Number(String(price).replace(/[^\d.]/g, ''));
    if (Number.isFinite(n)) truth.confirmedFacts.price = n;
  }

  const limit = pickTruthValue(sources, 'limit');
  if (limit !== undefined) {
    const n = Number(String(limit).replace(/[^\d]/g, ''));
    if (Number.isFinite(n)) truth.confirmedFacts.limit = n;
  }

  for (const k of ['difficulty', 'distance', 'elevation'] as const) {
    const v = pickTruthValue(sources, k);
    if (v !== undefined) truth.confirmedFacts[k] = String(v);
  }
  const days = pickTruthValue(sources, 'days');
  if (days !== undefined) {
    const n = Number(String(days).replace(/[^\d]/g, ''));
    if (Number.isFinite(n) && n > 0) truth.confirmedFacts.days = n;
  }

  if (Array.isArray(input.activity.itinerary)) truth.itinerary = input.activity.itinerary;
  if (Array.isArray(input.planFacts.feeInclude)) {
    truth.fee.include = input.planFacts.feeInclude.map(String);
  }
  if (Array.isArray(input.planFacts.feeExclude)) {
    truth.fee.exclude = input.planFacts.feeExclude.map(String);
  }
  if (Array.isArray(input.activity.checklist)) {
    const c = input.activity.checklist as unknown;
    if (c && typeof c === 'object') Object.assign(truth.checklist, c);
  }

  truth.groundedScenes = extractScenes(input);
  return truth;
}

/** 接地场景：从 itinerary / 方案原文抽取；vision 来源由 analyzeMedia 再合并 */
function extractScenes(input: NormalizedActivityInput): GroundedScene[] {
  const scenes: GroundedScene[] = [];
  const push = (v: string, source: GroundedScene['source'], confidence: number) => {
    const s = String(v || '').trim();
    if (!s || s.length > 40) return;
    if (scenes.some((x) => x.value === s)) return;
    scenes.push({ value: s, source, confidence });
  };

  const itin = input.activity.itinerary;
  if (Array.isArray(itin)) {
    for (const day of itin) {
      const items = (day as { items?: unknown[] })?.items;
      if (Array.isArray(items)) {
        for (const raw of items) {
          const t = typeof raw === 'string' ? raw : String((raw as { text?: string })?.text ?? '');
          push(t, 'itinerary', 0.9);
        }
      }
    }
  }
  for (const line of input.materialText) push(line, 'user', 0.7);
  return scenes.slice(0, 24);
}

/** 还没有被确认的关键事实 —— 交给老板确认卡，而不是让 AI 去猜 */
export function missingFacts(truth: ActivityTruth): string[] {
  const miss: string[] = [];
  const f = truth.confirmedFacts;
  if (!f.title) miss.push('title');
  if (!f.date) miss.push('date');
  if (!f.place) miss.push('place');
  if (!f.meeting) miss.push('meeting');
  if (f.price === undefined) miss.push('price');
  if (!truth.itinerary.length) miss.push('itinerary');
  if (!truth.fee.include.length && !truth.fee.exclude.length) miss.push('fee');
  return miss;
}

/** Step 3：视觉分析（V3 协议）—— 失败不抛，返回空数组（Photo Curator 会降级） */
export async function analyzeMedia(
  merchantId: string,
  photos: PhotoRef[]
): Promise<VisionResult[]> {
  const usable = photos.filter((p) => p.src);
  if (!usable.length) return [];
  try {
    const res = await analyzeImagesV3(
      merchantId,
      usable.map((p) => ({ id: p.id, src: p.src as string })),
      { scenario: 'content-v3' }
    );
    return res.results.map((r) => r.vision).filter(Boolean) as VisionResult[];
  } catch {
    return [];
  }
}
