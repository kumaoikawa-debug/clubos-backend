/**
 * Content Engine V3 —— Channel Steps（公众号 / 小红书 / 回顾）
 * 文档 §十四 / §十五 / §十六
 *
 * 与 detail 共用同一套 Activity Truth + Marketing Insight + Creative Direction，
 * 但每个渠道要重新判断：首屏节奏、长度、图数量与位置、标题、摘要、CTA。
 * 这是「同一 Truth 不同 Channel Director」的意义 —— 不是把详情页缩短或复制。
 *
 * 纪律：
 *   - 每个渠道有独立的 deterministic fallback，无 LLM / LLM 失败时仍产出可用内容。
 *   - fallback 也必须由 truth 的真实字段驱动，绝不填通用形容词。
 *   - 任何出厂文案都要过 BANNED_PHRASES（quality.ts 单一真源）。
 */

import type { ActivityTruth } from '../contracts/activityTruth';
import type { CreativeDirection } from '../contracts/creativeDirection';
import type { VisionResult } from '../contracts/visionResult';
import type {
  ActualActivityData,
  RecapInsight,
  RecapSection,
  WechatBlueprint,
  WechatTextSection,
  XhsImageSlot,
} from '../contracts/channels';
import { buildPrompt, callJsonLlm } from './llm';
import { BANNED_PHRASES } from './quality';

/** 兜底文案也必须过这道闸 —— 「无 LLM」不是泄漏模板话术的理由 */
function scrub(text: string): string {
  let out = String(text ?? '');
  for (const p of BANNED_PHRASES) out = out.split(p).join('');
  return out.replace(/\s{2,}/g, ' ').trim();
}

function factLine(truth: ActivityTruth): string {
  const f = truth.confirmedFacts;
  return [f.date, f.place, f.days ? `${f.days}天` : '', f.difficulty].filter(Boolean).join(' · ');
}

/** 把 prompt 调用包一层：失败就用 fallback，不让调用方写 try/catch 复制粘贴 */
async function tryLlm<T>(
  merchantId: string,
  system: string,
  prompt: string,
  fallback: () => T,
  note: string
): Promise<{ value: T; fromLlm: boolean }> {
  try {
    const value = await callJsonLlm<T>(merchantId, { system, prompt, note });
    return { value, fromLlm: true };
  } catch {
    return { value: fallback(), fromLlm: false };
  }
}

/* ============================================================
 * 微信公众号 Channel Director（§十四）
 * ========================================================== */

export async function buildWechatBlueprint(
  merchantId: string,
  truth: ActivityTruth,
  direction: CreativeDirection,
  photoCount: number
): Promise<WechatBlueprint> {
  const sections = await writeWechatSections(merchantId, truth, direction);
  const slots = totalSlots(sections);
  // 图没用完就补到信息密度最低的段落后面 —— Curator 的职责，不是渲染器平均分布
  distributePhotos(sections, Math.max(0, Math.min(photoCount, 12)), slots);
  return {
    titleStrategy: `${direction.communicationAngle}｜${direction.thesis}`,
    summary: scrub(truth.confirmedFacts.title ? `${truth.confirmedFacts.title}｜${factLine(truth)}` : factLine(truth)).slice(0, 120),
    opening: scrub(direction.thesis),
    sections,
    closing: '',
    cta: '',
  };
}

function totalSlots(sections: WechatTextSection[]): number {
  return sections.reduce((n, s) => n + (s.imageSlots || 0), 0);
}

/** 把没分配的照片补给「最缺图」的段落（信息密度最低 → 用 richest facts 段优先补图） */
function distributePhotos(sections: WechatTextSection[], available: number, used: number) {
  let left = available - used;
  let guard = 0;
  while (left > 0 && guard < 40) {
    for (const s of sections) {
      if (left <= 0) break;
      s.imageSlots = (s.imageSlots || 0) + 1;
      left -= 1;
    }
    guard += 1;
  }
}

async function writeWechatSections(
  merchantId: string,
  truth: ActivityTruth,
  direction: CreativeDirection
): Promise<WechatTextSection[]> {
  const f = truth.confirmedFacts;
  const task =
    '你是微信公众号长图文主笔。为这场活动规划正文结构并逐段写出正文。\n' +
    '要求：\n' +
    '1. 必须针对微信长图文重新判断首屏节奏、文章长度、图片数量与插入位置、标题、摘要、CTA。\n' +
    '2. 禁止固定模板顺序（开场→亮点→行程→报名 这类套路一律不用）。\n' +
    '3. 每段标注 imageSlots（该段后放几张图），图上有什么要能在 caption 里说清。\n' +
    '返回 JSON：{ "sections": [ { "purpose": "", "heading": "", "paragraphs": ["",""], "imageSlots": 1, "evidenceRefs": [] } ], "closing": "", "cta": "" }';

  const { value, fromLlm } = await tryLlm<{
    sections?: WechatTextSection[];
    closing?: string;
    cta?: string;
  }>(
    merchantId,
    '你是 ClubOS 户外俱乐部的内容主笔。只写有证据的内容，绝不编造天气、体感、名额紧张。',
    buildPrompt(
      {
        confirmedTruth: f,
        materialEvidence: [
          ...truth.groundedScenes.map((s) => s.value),
          ...truth.fee.include.map((x) => `费用含：${x}`),
        ],
        creativeContext: truth.creativeContext,
        forbiddenAssumptions: [
          '没有证据的天气/景观/体感',
          '名额紧张、限时优惠',
          '固定话术（详见 system prompt）',
        ],
      },
      task
    ),
    () => ({ sections: deterministicWechatSections(truth, direction) }),
    'v3-wechat-blueprint'
  );

  if (fromLlm && Array.isArray(value.sections) && value.sections.length > 0) {
    return value.sections.map((s) => ({
      purpose: String(s.purpose || '').slice(0, 60),
      heading: s.heading ? scrub(s.heading).slice(0, 40) : undefined,
      paragraphs: (Array.isArray(s.paragraphs) ? s.paragraphs : [])
        .map((p) => scrub(p).slice(0, 500))
        .filter(Boolean),
      imageSlots: Math.max(0, Math.min(4, Number(s.imageSlots) || 0)),
      evidenceRefs: Array.isArray(s.evidenceRefs) ? s.evidenceRefs.slice(0, 6) : [],
    }));
  }

  // tryLlm 已保证返回对象；若无可用 sections，走同一套确定性兜底
  return deterministicWechatSections(truth, direction);
}

/**
 * 离线兜底：结构由「这场活动真实有什么可讲」决定，不是通用模板。
 * 行程天数、费用包含、装备清单这些事实有多少写多少，没有就不写这段。
 */
function deterministicWechatSections(
  truth: ActivityTruth,
  direction: CreativeDirection
): WechatTextSection[] {
  const f = truth.confirmedFacts;
  const sections: WechatTextSection[] = [];

  sections.push({
    purpose: '建立本场的核心理由',
    heading: direction.communicationAngle.slice(0, 24),
    paragraphs: [scrub(direction.narrativeStrategy[0] || direction.thesis).slice(0, 300)],
    imageSlots: 1,
    evidenceRefs: direction.evidenceRefs.slice(0, 3),
  });

  const days = Array.isArray(truth.itinerary) ? truth.itinerary : [];
  if (days.length > 0) {
    sections.push({
      purpose: '把时间花在哪讲清楚',
      heading: `${days.length}天怎么安排`,
      paragraphs: days.slice(0, 4).map((d: any) =>
        scrub(`${d.title || `第${d.day ?? ''}天`}：${Array.isArray(d.items) ? d.items.slice(0, 4).join('、') : ''}`)
      ),
      imageSlots: Math.min(3, days.length),
      evidenceRefs: ['itinerary'],
    });
  }

  if (truth.fee.include.length) {
    sections.push({
      purpose: '消除费用疑虑',
      heading: '费用包含什么',
      paragraphs: [scrub(`已含：${truth.fee.include.join('、')}`)],
      imageSlots: 0,
      evidenceRefs: ['fee.include'],
    });
  }

  if (truth.checklist.required.length) {
    sections.push({
      purpose: '降低出发门槛',
      heading: '需要准备什么',
      paragraphs: [scrub(`必带：${truth.checklist.required.join('、')}`)],
      imageSlots: 0,
      evidenceRefs: ['checklist.required'],
    });
  }

  return sections;
}

/** 微信标题：多给候选供人选，且长度守微信习惯（≤ 30 字） */
export async function writeWechatTitles(
  merchantId: string,
  truth: ActivityTruth,
  direction: CreativeDirection
): Promise<string[]> {
  const f = truth.confirmedFacts;
  const { value } = await tryLlm<{ titles?: string[] }>(
    merchantId,
    '你是微信公众号标题写手。每条 ≤ 30 字，不用感叹号堆叠，不用「必看/震惊」。',
    buildPrompt(
      {
        confirmedTruth: f,
        materialEvidence: truth.groundedScenes.map((s) => s.value),
        creativeContext: truth.creativeContext,
        forbiddenAssumptions: ['编造地名/时间', '夸张承诺'],
      },
      `围绕「${direction.communicationAngle}」给 4 个候选标题。返回 JSON：{ "titles": ["","","",""] }`
    ),
    () => ({ titles: deterministicTitles(truth, direction) }),
    'v3-wechat-titles'
  );
  const list = Array.isArray(value.titles) ? value.titles : deterministicTitles(truth, direction);
  return list.map((t) => scrub(t).slice(0, 30)).filter(Boolean).slice(0, 5);
}

function deterministicTitles(truth: ActivityTruth, direction: CreativeDirection): string[] {
  const f = truth.confirmedFacts;
  const base = `${f.place || ''}${f.title || ''}`.trim();
  return [
    `${base}｜${direction.communicationAngle}`.slice(0, 30),
    `${factLine(truth)}｜${direction.thesis}`.slice(0, 30),
    direction.thesis.slice(0, 30),
  ].filter(Boolean);
}

/** Photo Curator：决定封面与出场顺序（不是简单取前 N 张） */
export function curateWechatPhotos(
  vision: VisionResult[],
  photos: { id: string; src?: string }[]
): { images: string[]; coverIndex: number; order: number[] } {
  const scored = photos.map((p, i) => {
    const v = vision[i];
    const hasFace = !!(v && (v as any).hasPeople);
    const useful = !!(v && (v as any).isHeroCandidate);
    return { src: p.src || '', idx: i, score: (useful ? 2 : 0) + (hasFace ? 1 : 0) };
  });
  const usable = scored.filter((s) => s.src);
  const ranked = usable.slice().sort((a, b) => b.score - a.score);
  return {
    images: ranked.map((r) => r.src),
    coverIndex: 0,
    order: ranked.map((r) => r.idx),
  };
}

/* ============================================================
 * 小红书 Channel Director（§十五）
 * ========================================================== */

export async function writeXiaohongshu(
  merchantId: string,
  truth: ActivityTruth,
  direction: CreativeDirection
): Promise<{ hook: string; titleOptions: string[]; mainAngle: string; body: string; tags: string[]; cta: string }> {
  const f = truth.confirmedFacts;
  const task =
    '你是小红书户外内容作者。写这一场。\n' +
    '要求：\n' +
    '1. hook 是第一句，决定要不要点开，必须具体到这场（不要「集美们」「不会吧」这种口癖）。\n' +
    '2. body 口语化、有分段和换行，可以带 emoji，但不堆符号。\n' +
    '3. tags 用真实相关词，不要蹭无关热点。\n' +
    '返回 JSON：{ "hook": "", "titleOptions": ["","","",""], "mainAngle": "", "body": "", "tags": ["",""], "cta": "" }';

  const { value, fromLlm } = await tryLlm<{
    hook?: string;
    titleOptions?: string[];
    mainAngle?: string;
    body?: string;
    tags?: string[];
    cta?: string;
  }>(
    merchantId,
    '你是 ClubOS 户外俱乐部的小红书主笔。只写有证据的内容，不编造体感与天气。',
    buildPrompt(
      {
        confirmedTruth: f,
        materialEvidence: truth.groundedScenes.map((s) => s.value).concat(truth.fee.include.map((x) => `费用含：${x}`)),
        creativeContext: truth.creativeContext,
        forbiddenAssumptions: ['没有证据的体感/天气', '名额紧张', '固定话术'],
      },
      task
    ),
    () => deterministicXhs(truth, direction),
    'v3-xhs'
  );

  if (!fromLlm) return deterministicXhs(truth, direction);

  return {
    hook: scrub(value.hook || '').slice(0, 60),
    titleOptions: (Array.isArray(value.titleOptions) ? value.titleOptions : [])
      .map((t) => scrub(t).slice(0, 24))
      .filter(Boolean)
      .slice(0, 5),
    mainAngle: scrub(value.mainAngle || direction.communicationAngle).slice(0, 60),
    body: scrub(value.body || '').slice(0, 1000),
    tags: (Array.isArray(value.tags) ? value.tags : []).map((t) => scrub(t).slice(0, 16)).slice(0, 10),
    cta: scrub(value.cta || '').slice(0, 60),
  };
}

/**
 * 小红书标签：只从这场自己的事实里取词。
 * 早先只取 [place, difficulty] —— 于是所有「没填难度」的场次只剩 1 个 tag，
 * 而且 '#中等' 这种难度词当话题毫无意义。改成：地点 + 「本场事实里真的出现过」的
 * 活动形态词（徒步/露营/夜跑…）。判据是 haystack.includes(w)，所以不会凭空造话题。
 */
const XHS_TOPIC_WORDS = [
  '徒步', '穿越', '登顶', '露营', '野餐', '骑行', '溯溪', '攀登', '雪山', '越野', '夜跑', '接力',
  '摄影', '拍照', '亲子', '研学', '团建', '观星', '星空', '自驾', '海岛', '浮潜', '滑雪', '攀岩',
  '采摘', '稻田', '飞盘', '瑜伽', '净山', '公益', '温泉', '度假', '戈壁', '沙漠', '探洞', '洞穴',
  '溪谷', '自然课', '地质', 'Citywalk', 'citywalk', '城市漫步', '环湖', '山径', '赛事', '日出',
  '日落', '夜爬', '漂流', '跑步', '糖水', '美食', '农家', '步行', '开板', '浮潜',
];

function xhsTags(truth: ActivityTruth): string[] {
  const f = truth.confirmedFacts;
  const haystack = [
    f.title,
    f.place,
    f.difficulty,
    f.distance,
    f.elevation,
    ...truth.fee.include,
    ...truth.fee.exclude,
    ...truth.checklist.required,
    ...truth.checklist.recommended,
    ...truth.groundedScenes.map((s) => s.value),
  ]
    .filter(Boolean)
    .join(' ');

  const out: string[] = [];
  const push = (t: unknown) => {
    const s = String(t ?? '').replace(/[\s·/|｜]+/g, '').slice(0, 16);
    if (s && out.indexOf(s) < 0) out.push(s);
  };
  if (f.place) push(f.place);
  for (const w of XHS_TOPIC_WORDS) if (haystack.indexOf(w) >= 0) push(w);
  return out.slice(0, 8);
}

function deterministicXhs(
  truth: ActivityTruth,
  direction: CreativeDirection
): { hook: string; titleOptions: string[]; mainAngle: string; body: string; tags: string[]; cta: string } {
  const f = truth.confirmedFacts;
  const scenes = truth.groundedScenes.map((s) => s.value).slice(0, 5);
  const lines = [
    factLine(truth),
    truth.fee.include.length ? `费用含：${truth.fee.include.join('、')}` : '',
    truth.checklist.required.length ? `必带：${truth.checklist.required.join('、')}` : '',
    // 方案/行程原文是用户自己给的证据 —— 早先兜底没带上它，素材薄的场次正文会短到 59 字
    scenes.length ? `行程与现场：${scenes.join('；')}` : '',
  ].filter(Boolean);
  return {
    hook: `${f.place || '这条线路'}，${direction.communicationAngle}`.slice(0, 60),
    titleOptions: deterministicTitles(truth, direction).slice(0, 4),
    mainAngle: direction.communicationAngle,
    body: `${direction.thesis}\n\n${lines.join('\n')}`.slice(0, 1000),
    tags: xhsTags(truth),
    cta: '',
  };
}

/** 小红书图片序列：每张承担明确角色 —— 「图片顺序是内容的一部分」 */
export function sequenceXhsPhotos(
  photos: { id: string; src?: string }[],
  vision: VisionResult[],
  mainAngle: string
): { sequence: XhsImageSlot[]; coverSuggestion: number } {
  const ROLES = ['先给目的地实感', '交代人在场的状态', '给出关键细节', '收尾留余味'];
  return {
    sequence: photos.slice(0, 9).map((p, i) => {
      const v = vision[i] as any;
      const captionCandidate = v?.scene?.[0] || '';
      return {
        photoIndex: i,
        role: ROLES[i] || `第${i + 1}张承接${mainAngle}`,
        caption: captionCandidate ? String(captionCandidate).slice(0, 40) : '',
      };
    }),
    coverSuggestion: 0,
  };
}

/* ============================================================
 * Recap Channel Director（§十六）
 * ========================================================== */

/**
 * Recap Insight：先回答「这一次真正最值得留下什么？」
 * 可能是人、一组孩子、一次挑战、一场雨、登顶、一顿饭、营地晚上 ——
 * 因此答案必须由 actualActivityData 的证据决定，不是套结构。
 */
export function buildRecapInsight(truth: ActivityTruth, actual: ActualActivityData): RecapInsight {
  const highlights = (actual.highlights || []).filter(Boolean);
  const feedbacks = (actual.feedbacks || []).filter(Boolean);
  const notes = (actual.onSiteNotes || []).filter(Boolean);

  const evidence = [...highlights, ...feedbacks.slice(0, 3), ...notes.slice(0, 3)];
  if (!evidence.length) {
    // 没有现场素材就诚实承认 —— recap 必须来自发生过的事，不能用方案原文冒充
    return {
      coreMemory: '',
      whyItMatters: '',
      evidence: [],
    };
  }
  return {
    coreMemory: highlights[0] || notes[0] || feedbacks[0] || '',
    whyItMatters: feedbacks[0] || highlights[1] || '',
    evidence: evidence.slice(0, 8),
  };
}

export async function writeRecapSections(
  merchantId: string,
  truth: ActivityTruth,
  actual: ActualActivityData,
  insight: RecapInsight,
  direction: CreativeDirection
): Promise<RecapSection[]> {
  const task =
    '你是户外俱乐部活动回顾的作者。写这一场真实发生过的事。\n' +
    '要求：\n' +
    '1. 严格只用【Confirmed Truth】与现场素材里的内容，方案里计划但没发生的不要写成本次发生。\n' +
    '2. 禁止固定结构（开场→核心记忆→途中体验→照片→下一期）。\n' +
    '3. 每段标注 imageSlots。\n' +
    '返回 JSON：{ "sections": [ { "purpose": "", "heading": "", "paragraphs": [""], "imageSlots": 1, "evidenceRefs": [] } ] }';

  const { value, fromLlm } = await tryLlm<{ sections?: RecapSection[] }>(
    merchantId,
    '你是 ClubOS 活动回顾主笔。没有现场证据的内容一律不写，不能用「大家都很开心」这类空话充数。',
    buildPrompt(
      {
        confirmedTruth: { ...truth.confirmedFacts, actual },
        materialEvidence: insight.evidence,
        creativeContext: truth.creativeContext,
        forbiddenAssumptions: [
          '把计划写成本次实际发生',
          '没有记录的评价/天气/体感',
          '「大家都很开心」「收获满满」这类空话',
        ],
      },
      task
    ),
    () => ({ sections: deterministicRecapSections(truth, actual, insight, direction) }),
    'v3-recap'
  );

  if (fromLlm && Array.isArray(value.sections) && value.sections.length) {
    return value.sections.map((s) => ({
      purpose: String(s.purpose || '').slice(0, 60),
      heading: s.heading ? scrub(s.heading).slice(0, 40) : undefined,
      paragraphs: (Array.isArray(s.paragraphs) ? s.paragraphs : []).map((p) => scrub(p).slice(0, 500)).filter(Boolean),
      imageSlots: Math.max(0, Math.min(4, Number(s.imageSlots) || 0)),
      evidenceRefs: Array.isArray(s.evidenceRefs) ? s.evidenceRefs.slice(0, 6) : [],
    }));
  }
  return deterministicRecapSections(truth, actual, insight, direction);
}

/** 离线兜底：有多少现场素材写多少，没有就给诚实空态而不是编内容 */
function deterministicRecapSections(
  truth: ActivityTruth,
  actual: ActualActivityData,
  insight: RecapInsight,
  direction: CreativeDirection
): RecapSection[] {
  const sections: RecapSection[] = [];
  if (insight.coreMemory) {
    sections.push({
      purpose: '先说这次真正留下的是什么',
      heading: insight.coreMemory.slice(0, 20),
      paragraphs: [scrub(insight.coreMemory).slice(0, 300)],
      imageSlots: 1,
      evidenceRefs: insight.evidence.slice(0, 3),
    });
  }
  const rest = insight.evidence.slice(1);
  if (rest.length) {
    sections.push({
      purpose: '把其余现场证据串起来',
      paragraphs: rest.slice(0, 5).map((e) => scrub(e)),
      imageSlots: Math.min(3, (actual.photos || []).length),
      evidenceRefs: rest.slice(0, 5),
    });
  }
  if (!sections.length) {
    sections.push({
      purpose: '诚实空态：还没有现场记录',
      paragraphs: ['这一场还没有整理现场记录，回顾待补充。'],
      imageSlots: 0,
      evidenceRefs: [],
    });
  }
  return sections;
}
