/**
 * Content Engine V3 —— Workflow 步骤 Step 7~10
 * Step 7 buildBlueprint / Step 8 writeBlocks / Step 9 matchPhotos / Step 10 composeLayout
 *
 * 文档要求：
 *  - Director 阶段（Step 7）不要写完整正文，只产出 Block purpose / goal / evidence / media need / layout intent。
 *  - WriteBlocks 每个 Block 只看到自己的 purpose + 允许的 evidence + 照片语义 + 前后块摘要，
 *    防止整篇被模型统一语气套模板。
 *  - Block 是视觉词汇，不是模板：不得从预设 Page Template 里选固定顺序。
 */

import type { ActivityTruth } from '../contracts/activityTruth';
import type { CreativeDirection } from '../contracts/creativeDirection';
import type {
  ContentBlock,
  ContentBlockType,
  BlockLayout,
} from '../contracts/promoDocument';
import { normalizeLayout, filterKnownEvidence } from '../contracts/promoDocument';
import { buildPrompt, callJsonLlm } from './llm';
import type { VisionResult } from '../contracts/visionResult';
import type { MarketingInsight } from './direction';

export interface BlockIntent {
  type: ContentBlockType;
  purpose: string;
  communicationGoal: string;
  evidenceRefs: string[];
  mediaNeed: number;
  layoutIntent: Partial<BlockLayout>;
}

export interface Blueprint {
  openingMode: string;
  intents: BlockIntent[];
}

const BLUEPRINT_SYSTEM =
  '你是页面导演。你只决定「每一块承担什么传播任务」，不要写正文。' +
  '可用块类型有限：hero/lead/statement/image/image_group/text_image/metric/quote/chapter_break/gallery/cta。' +
  '必须输出严格 JSON。';

/** Step 7：生成蓝图（只有意图，不含正文） */
export async function buildBlueprint(
  merchantId: string,
  truth: ActivityTruth,
  direction: CreativeDirection,
  insight: MarketingInsight,
  photoCount: number
): Promise<Blueprint> {
  const evidencePool = buildEvidencePool(truth);

  const prompt = buildPrompt(
    {
      confirmedTruth: truth.confirmedFacts,
      materialEvidence: truth.groundedScenes.map((s) => s.value).concat(insight.strongestEvidence),
      creativeContext: {
        direction: {
          thesis: direction.thesis,
          narrativeStrategy: direction.narrativeStrategy,
          styleVector: direction.styleVector,
        },
        photoCount,
      },
      forbiddenAssumptions: [
        '固定结构：Hero + 金句 + 三图 + 章节 + CTA',
        '固定顺序：为什么值得去 → 来了体验什么 → 适合谁',
      ],
    },
    `输出 JSON：{"openingMode":"开场方式一句话","blocks":[{"type":"...","purpose":"这块承担的传播任务","communicationGoal":"要读者产生什么反应","evidenceRefs":["必须是上面 Confirmed Truth / Material Evidence 里出现过的原文片段"],"mediaNeed":图片张数(0~4),"layoutIntent":{"width":"normal|wide|full","alignment":"left|center|right","whitespace":"tight|balanced|generous"}}]}
约束：
- 块数量 3~9，首尾得当；允许不用 hero 或把 hero 放在中段。
- imageDominance=${direction.styleVector.imageDominance}、textDensity=${direction.styleVector.textDensity}、rhythm=${direction.styleVector.rhythm}，请用不同 width/whitespace 制造真实节奏差异。
- mediaNeed 总和不超过 ${photoCount}。`
  );

  try {
    const json = await callJsonLlm<{ openingMode?: string; blocks?: unknown }>(merchantId, {
      system: BLUEPRINT_SYSTEM,
      prompt,
      temperature: 0.85,
      note: 'V3 blueprint',
    });
    const intents = (Array.isArray(json.blocks) ? json.blocks : [])
      .map((raw) => normalizeIntent(raw, evidencePool))
      .filter(Boolean) as BlockIntent[];
    if (intents.length) {
      return {
        openingMode: String(json.openingMode ?? direction.thesis).slice(0, 60),
        intents: capMedia(intents, photoCount),
      };
    }
  } catch {
    /* 走确定性兜底 */
  }
  return deterministicBlueprint(truth, direction, insight, photoCount, evidencePool);
}

function buildEvidencePool(truth: ActivityTruth): string[] {
  const pool: string[] = [];
  const f = truth.confirmedFacts;
  for (const v of [f.title, f.date, f.place, f.meeting, f.distance, f.elevation, f.difficulty]) {
    if (v) pool.push(String(v));
  }
  if (f.price !== undefined) pool.push(String(f.price));
  if (f.days) pool.push(`${f.days}天`);
  for (const s of truth.groundedScenes) pool.push(s.value);
  return pool.filter(Boolean);
}

function normalizeIntent(raw: unknown, pool: string[]): BlockIntent | null {
  const r = raw as Record<string, unknown>;
  const type = String(r.type ?? '');
  const allowed: ContentBlockType[] = [
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
  ];
  if (!allowed.includes(type as ContentBlockType)) return null;
  return {
    type: type as ContentBlockType,
    purpose: String(r.purpose ?? '').slice(0, 60),
    communicationGoal: String(r.communicationGoal ?? '').slice(0, 60),
    // 关键：过滤掉引用不到真源的那部分 —— 无依据的 claim 不允许进入后续写作
    evidenceRefs: filterKnownEvidence(
      Array.isArray(r.evidenceRefs) ? r.evidenceRefs.map(String) : [],
      pool
    ),
    mediaNeed: Math.max(0, Math.min(4, Number(r.mediaNeed) || 0)),
    layoutIntent: normalizeLayout((r.layoutIntent ?? {}) as Partial<BlockLayout>),
  };
}

function capMedia(intents: BlockIntent[], photoCount: number): BlockIntent[] {
  let left = photoCount;
  return intents.map((it) => {
    if (left <= 0) return { ...it, mediaNeed: 0 };
    const n = Math.min(it.mediaNeed, left);
    left -= n;
    return { ...it, mediaNeed: n };
  });
}

/** 确定性兜底蓝图 —— 由 StyleVector 驱动，不是模板常量 */
export function deterministicBlueprint(
  truth: ActivityTruth,
  direction: CreativeDirection,
  insight: MarketingInsight,
  photoCount: number,
  evidencePool: string[]
): Blueprint {
  const sv = direction.styleVector;
  const intents: BlockIntent[] = [];
  const ev = evidencePool.slice(0, 3);

  if (photoCount > 0 && sv.imageDominance > 0.45) {
    intents.push({
      type: 'hero',
      purpose: '用最强的一张现场素材建立第一印象',
      communicationGoal: '让读者先“看见”，再决定是否读下去',
      evidenceRefs: ev,
      mediaNeed: 1,
      layoutIntent: normalizeLayout({ width: 'full', alignment: 'left' }),
    });
  }
  intents.push({
    type: 'lead',
    purpose: '把本场活动的核心主张说清楚',
    communicationGoal: '让读者 3 秒内知道这场活动为什么值得看',
    evidenceRefs: ev,
    mediaNeed: 0,
    layoutIntent: normalizeLayout({ width: sv.textDensity > 0.6 ? 'wide' : 'normal' }),
  });
  if (sv.informationWeight > 0.5) {
    intents.push({
      type: 'metric',
      purpose: '用可核查的数据建立可信度',
      communicationGoal: '降低“不知道难度/强度”的顾虑',
      evidenceRefs: evidencePool.filter((e) => /天|km|公里|米|元|人/.test(e)).slice(0, 4),
      mediaNeed: 0,
      layoutIntent: normalizeLayout({ width: 'wide', columns: 3 }),
    });
  }
  const remainingPhotos = photoCount - intents.reduce((s, i) => s + i.mediaNeed, 0);
  if (remainingPhotos >= 3) {
    intents.push({
      type: 'image_group',
      purpose: '用一组照片交代现场气质',
      communicationGoal: '让读者脑中形成画面',
      evidenceRefs: ev,
      mediaNeed: Math.min(3, remainingPhotos),
      layoutIntent: normalizeLayout({ width: 'wide', columns: 3, whitespace: sv.whitespace }),
    });
  } else if (remainingPhotos > 0) {
    intents.push({
      type: 'image',
      purpose: '用一张照片支撑上面的说法',
      communicationGoal: '用视觉证据增强可信',
      evidenceRefs: ev,
      mediaNeed: remainingPhotos,
      layoutIntent: normalizeLayout({ width: 'wide' }),
    });
  }
  if (sv.emotionalWeight > 0.55 || sv.aspirationLevel > 0.6) {
    intents.push({
      type: 'quote',
      purpose: '给这场活动一句能被记住的话',
      communicationGoal: '形成可传播的短句',
      evidenceRefs: ev.slice(0, 1),
      mediaNeed: 0,
      layoutIntent: normalizeLayout({ width: 'wide', alignment: 'center' }),
    });
  }
  intents.push({
    type: 'cta',
    purpose: '把兴趣转成行动',
    communicationGoal: '让人知道下一步做什么',
    evidenceRefs: [truth.confirmedFacts.date, truth.confirmedFacts.price]
      .filter((x) => x !== undefined)
      .map(String),
    mediaNeed: 0,
    layoutIntent: normalizeLayout({ width: 'normal', emphasis: sv.ctaStrength }),
  });

  return {
    openingMode: `${direction.thesis}｜${insight.whatWeSell}`.slice(0, 60),
    intents: intents.filter((i) => i.purpose),
  };
}

const WRITE_SYSTEM =
  '你是单块内容的写作者。你只写交给你的这一块。禁止使用通用营销套话。' +
  '禁止出现：名额有限/手慢无/私信我/评论扣1/群内接龙/下一期正在安排/大家都很开心/逃离城市/治愈/松弛。' +
  '只能使用给定的 Confirmed Truth 与 Material Evidence；没有依据的内容不许写。必须输出严格 JSON。';

/** Step 8：逐块写文案 —— 每块只看到自己的上下文 */
export async function writeBlocks(
  merchantId: string,
  truth: ActivityTruth,
  direction: CreativeDirection,
  blueprint: Blueprint,
  vision: VisionResult[],
  photos: { id: string; src?: string }[]
): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = [];
  for (let i = 0; i < blueprint.intents.length; i++) {
    const intent = blueprint.intents[i];
    const prev = blueprint.intents[i - 1];
    const next = blueprint.intents[i + 1];
    const media = takePhotos(photos, intent.mediaNeed, i);

    const prompt = buildPrompt(
      {
        confirmedTruth: truth.confirmedFacts,
        materialEvidence: intent.evidenceRefs.concat(
          media.map((m) => vision.find((v) => v.imageId === m.id)?.scene?.join('、') ?? '')
        ).filter(Boolean),
        creativeContext: {
          direction: { thesis: direction.thesis, styleVector: direction.styleVector },
          thisBlock: { type: intent.type, purpose: intent.purpose, goal: intent.communicationGoal },
          prevBlock: prev ? prev.purpose : '（无）',
          nextBlock: next ? next.purpose : '（无）',
        },
        forbiddenAssumptions: ['与本块 purpose 无关的内容', '重复上一块的措辞'],
      },
      `只写这一块，输出 JSON：{"headline":"（<=24字，hero/lead/statement/quote 需要）","body":"（正文，<=120字）","caption":"（配图说明，<=20字，有图时需要）"}
块类型：${intent.type}｜传播任务：${intent.purpose}｜期望反应：${intent.communicationGoal}`
    );

    let copy = { headline: '', body: '', caption: '' };
    try {
      const json = await callJsonLlm<Record<string, string>>(merchantId, {
        system: WRITE_SYSTEM,
        prompt,
        temperature: 0.9,
        note: 'V3 block writer',
      });
      copy = {
        headline: String(json.headline ?? '').slice(0, 40),
        body: String(json.body ?? '').slice(0, 200),
        caption: String(json.caption ?? '').slice(0, 30),
      };
    } catch {
      copy = groundedFallbackCopy(intent, truth, direction);
    }

    if (!copy.headline && !copy.body) copy = groundedFallbackCopy(intent, truth, direction);

    blocks.push({
      id: `blk-${i + 1}-${intent.type}`,
      type: intent.type,
      purpose: intent.purpose,
      communicationGoal: intent.communicationGoal,
      evidenceRefs: intent.evidenceRefs,
      copy,
      mediaRefs: media.map((m) => m.id),
      layout: normalizeLayout(intent.layoutIntent),
    });
  }
  return blocks;
}

/** 无 LLM 时的接地兜底：只使用已确认事实，不生产营销套话 */
function groundedFallbackCopy(
  intent: BlockIntent,
  truth: ActivityTruth,
  direction: CreativeDirection
): { headline: string; body: string; caption: string } {
  const f = truth.confirmedFacts;
  const facts = [f.date, f.place, f.days ? `${f.days}天` : '', f.difficulty]
    .filter(Boolean)
    .join(' · ');

  // 每块必须有不同的标题 —— 全篇复用同一句 thesis 是最典型的模板化症状
  let headline = intent.purpose.slice(0, 16);
  if (intent.type === 'hero') headline = String(f.title ?? f.place ?? '').slice(0, 20) || headline;
  else if (intent.type === 'cta') headline = facts ? `${f.date ?? ''} 出发`.trim() || '怎么参加' : '怎么参加';
  else if (intent.type === 'quote') headline = direction.thesis.slice(0, 20);
  else if (intent.type === 'metric') headline = '这一趟的硬指标';

  let body = intent.communicationGoal || intent.purpose;
  if (intent.evidenceRefs.length) body += `；依据：${intent.evidenceRefs.slice(0, 2).join('、')}`;
  if (facts) body += `（${facts}）`;

  return {
    headline: headline.trim(),
    body: body.slice(0, 120),
    caption: '',
  };
}

/** Step 9：配图 —— 视觉/语义/复用惩罚综合打分，纯确定性 */
export function matchPhotos(
  vision: VisionResult[],
  blocks: ContentBlock[],
  photos: { id: string; src?: string }[]
): Record<string, string[]> {
  const assignment: Record<string, string[]> = {};
  const used = new Set<string>();
  for (const b of blocks) {
    const need = b.mediaRefs?.length ?? 0;
    if (!need) continue;
    const scored = photos
      .filter((p) => !used.has(p.id))
      .map((p) => {
        const v = vision.find((x) => x.imageId === p.id);
        let score = 0.3;
        if (v) {
          score += v.qualityScore * 0.4;
          if (b.type === 'hero' && (v.scene ?? []).some((s) => /scenic|people|action/.test(s))) score += 0.2;
          if (b.type === 'gallery' || b.type === 'image_group') score += 0.1;
        }
        return { p, score };
      })
      .sort((a, b2) => b2.score - a.score);
    const picked = scored.slice(0, need).map((s) => s.p.id);
    picked.forEach((id) => used.add(id));
    assignment[b.id] = picked;
  }
  for (const b of blocks) {
    if (assignment[b.id]) b.mediaRefs = assignment[b.id];
  }
  return assignment;
}

/** Step 10：排版 —— 由 StyleVector 决定 layout 属性，不由模板决定 */
export function composeLayout(
  blocks: ContentBlock[],
  styleVector: CreativeDirection['styleVector']
): ContentBlock[] {
  return blocks.map((b, i) => {
    const widen = styleVector.imageDominance > 0.65 && (b.mediaRefs?.length ?? 0) > 0;
    const ws =
      styleVector.whitespace === 'generous' || styleVector.whitespace === 'tight'
        ? styleVector.whitespace
        : undefined;
    return {
      ...b,
      layout: normalizeLayout({
        ...b.layout,
        width: widen && b.layout.width === 'normal' ? 'wide' : b.layout.width,
        whitespace: ws ?? b.layout.whitespace,
        emphasis: b.type === 'cta' ? Math.max(b.layout.emphasis ?? 0, styleVector.ctaStrength) : b.layout.emphasis,
        columns: b.layout.columns ?? (b.mediaRefs?.length ?? 0) >= 3 ? (b.layout.columns ?? 3) : undefined,
        mediaDominance: styleVector.imageDominance,
      }),
    };
  }) as ContentBlock[];
}

function takePhotos(
  photos: { id: string; src?: string }[],
  need: number,
  idx: number
): { id: string; src?: string }[] {
  if (need <= 0) return [];
  const start = (idx * need) % Math.max(1, photos.length);
  const out: { id: string; src?: string }[] = [];
  for (let k = 0; k < need && photos.length; k++) {
    out.push(photos[(start + k) % photos.length]);
  }
  return out;
}
