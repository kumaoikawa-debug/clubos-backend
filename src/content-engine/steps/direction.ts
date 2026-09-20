/**
 * Content Engine V3 —— Workflow 步骤 Step 4~6
 * Step 4 buildMarketingInsight / Step 5 generateDirections / Step 6 selectDirection
 *
 * 文档明令禁止：
 *  - 不得固定 season / challenge / social / lifestyle 四选一
 *  - 不得用 style = "magazine" / "diary" / "family" 作为生成入口
 * 差异化必须来自「这一场活动本身的证据 + StyleVector 连续量纲」。
 */

import type { ActivityTruth } from '../contracts/activityTruth';
import type {
  CreativeDirection,
  StyleVector,
} from '../contracts/creativeDirection';
import {
  normalizeStyleVector,
  styleVectorDistance,
  isSameThesis,
  clamp01,
} from '../contracts/creativeDirection';
import { buildPrompt, callJsonLlm } from './llm';
import { unsupportedNumbersIn } from './quality';
import type { VisionResult } from '../contracts/visionResult';
import type { BrandProfile } from '../contracts/brandProfile';
import { logger } from '../../lib';

export interface MarketingInsight {
  /** 真正卖的是什么 */
  whatWeSell: string;
  targetAudience: string;
  /** 用户为什么参加 */
  motivation: string[];
  /** 最大顾虑 */
  barrier: string;
  /** 哪些证据最强 */
  strongestEvidence: string[];
}

export interface DirectionSelectionInput {
  directions: CreativeDirection[];
  truth: ActivityTruth;
  vision: VisionResult[];
  /** 历史指纹（最近 N 篇），用于差异化降权 */
  historyTheses: string[];
  historyVectors: StyleVector[];
}

const INSIGHT_SYSTEM =
  '你是户外活动的营销策划。只依据给定事实与素材做判断，禁止臆造。必须输出严格 JSON。';

/** Step 4：营销洞察（LLM），失败时退化为基于事实的保守洞察，绝不抛联络调用方 */
export async function buildMarketingInsight(
  merchantId: string,
  truth: ActivityTruth,
  vision: VisionResult[]
): Promise<MarketingInsight> {
  const evidence = vision.length
    ? vision.flatMap((v) => [...(v.scene ?? []), ...(v.activity ?? [])]).slice(0, 12)
    : truth.groundedScenes.map((s) => s.value);

  const prompt = buildPrompt(
    {
      confirmedTruth: truth.confirmedFacts,
      materialEvidence: evidence,
      creativeContext: truth.creativeContext,
      forbiddenAssumptions: [
        '没有证据的天气、景观、体感描述',
        '未经确认的名额紧张、限时优惠',
        '把历史素材说成本次活动会发生',
      ],
    },
    `输出 JSON：
{
  "whatWeSell": "这场活动真正卖的是什么（20 字内）",
  "targetAudience": "最可能被打动的人（20 字内）",
  "motivation": ["参加动机1", "参加动机2"],
  "barrier": "这类人最可能的顾虑（20 字内）",
  "strongestEvidence": ["最有说服力的证据1", "证据2"]
}`
  );

  try {
    const json = await callJsonLlm<Partial<MarketingInsight>>(merchantId, {
      system: INSIGHT_SYSTEM,
      prompt,
      temperature: 0.6,
      note: 'V3 marketing insight',
    });
    return {
      whatWeSell: String(json.whatWeSell ?? '').slice(0, 40) || '一次有组织的户外出行',
      targetAudience: String(json.targetAudience ?? '').slice(0, 40) || '想出门但缺同伴与安排的人',
      motivation: Array.isArray(json.motivation) ? json.motivation.map(String).slice(0, 4) : [],
      barrier: String(json.barrier ?? '').slice(0, 40) || '担心难度与安全',
      strongestEvidence: Array.isArray(json.strongestEvidence)
        ? json.strongestEvidence.map(String).slice(0, 4)
        : evidence.slice(0, 4),
    };
  } catch {
    return {
      whatWeSell: '一次有组织的户外出行',
      targetAudience: '想出门但缺同伴与安排的人',
      motivation: ['有人安排路线与交通'],
      barrier: '担心难度与安全',
      strongestEvidence: evidence.slice(0, 4),
    };
  }
}

const DIRECTION_SYSTEM =
  '你是户外活动的创意总监。为同一场活动提出 3 个明显不同、但都站得住的创意方向。' +
  '禁止使用季节/挑战/社交/生活方式这类固定四选一标签，必须基于本场活动的真实证据提出方向。必须输出严格 JSON。';

/**
 * 方向生成的结果。
 *
 * ★ 为什么要把「到底用没用上 LLM」作为返回值带出来：
 *   掉额度 / Key 失效 / 超时时，方向会静默退化成确定性兜底 —— 请求仍然 200、
 *   文档照样生成，`generationMeta.model` 还写着 `platform-llm`。
 *   于是线上整月兜底，报表上一点异常都看不到，只能靠人工比对文案「怎么这么模板」。
 *   验收跑批里 30 场有 22 场是兜底，就是这么被发现的。
 */
export interface DirectionsResult {
  directions: CreativeDirection[];
  /** 真实 LLM 是否参与了方向生成（false = 全部来自确定性兜底） */
  llmUsed: boolean;
  /** LLM 失败原因（仅 llmUsed=false 时有值）：积分不足 / Key 未配置 / 超时 / 供应商报错 */
  llmError: string;
}

/**
 * 文档 §十三：把 BrandProfile 的品牌语言偏好拼成一段写进 prompt 的话。
 * 只有俱乐部真的填了 toneKeywords / visualKeywords 才注入；否则返回空串
 * （中性默认，绝不默认任何调性）。
 */
function buildBrandVoice(brand?: BrandProfile | null): string {
  if (!brand) return '';
  const tone = (brand.toneKeywords ?? []).filter(Boolean);
  const visual = (brand.visualKeywords ?? []).filter(Boolean);
  if (!tone.length && !visual.length) return '';
  const parts = [...tone, ...visual].filter(Boolean);
  const name = brand.brandName ? `（${brand.brandName}）` : '';
  return `\n\n【品牌调性】该俱乐部的品牌语言偏好：${parts.join('、')}${name}。请基于活动事实与这一品牌偏好推导方向，但不得编造任何事实或数字。`;
}

/** Step 5：生成 3 个候选方向（LLM，失败退化为由本场证据推出的确定性方向） */
export async function generateDirections(
  merchantId: string,
  truth: ActivityTruth,
  insight: MarketingInsight,
  vision: VisionResult[],
  /** 文档 §十三：品牌档案。null/undefined = 中性默认品牌语言，绝不默认任何具体调性 */
  brand?: BrandProfile | null
): Promise<DirectionsResult> {
  const material = [
    ...truth.groundedScenes.map((s) => s.value),
    ...vision.flatMap((v) => v.scene ?? []),
  ].slice(0, 16);

  const forbiddenAssumptions = [
    '把灵感当成事实',
    '固定话术如“逃离城市”“治愈”“松弛”',
    // 品牌明确说不要的词，直接进禁忌清单（§十三）
    ...(brand?.avoidKeywords?.length ? brand.avoidKeywords : []),
  ];
  const brandVoice = buildBrandVoice(brand);

  const prompt = buildPrompt(
    {
      confirmedTruth: { ...truth.confirmedFacts, itineraryDays: truth.itinerary.length },
      materialEvidence: material,
      creativeContext: { ...truth.creativeContext, insight },
      forbiddenAssumptions,
    },
    `输出 JSON：{"directions": [ ...3 个... ]}
每个 direction：
{
  "thesis": "核心传播主张（一句话，25 字内，必须是这一场独有的）",
  "targetAudience": "面向谁",
  "primaryMotivation": "主要动机",
  "primaryBarrier": "主要障碍",
  "communicationAngle": "传播角度（不得重复其他两个）",
  "evidenceRefs": ["引用的事实/素材，必须与上面给出的内容一致"],
  "narrativeStrategy": ["叙事步骤1", "步骤2", "步骤3"],
  "styleVector": {
    "imageDominance":0~1,"textDensity":0~1,"informationWeight":0~1,"emotionalWeight":0~1,
    "documentaryLevel":0~1,"aspirationLevel":0~1,"socialEnergy":0~1,"challengeSignal":0~1,
    "lifestyleSignal":0~1,"professionalSignal":0~1,"ctaStrength":0~1,"typographyEnergy":0~1,
    "rhythm":"slow|medium|fast","whitespace":"tight|balanced|generous"
  },
  "expectedVisualStrategy": "视觉策略一句话",
  "rationale": "为什么这个方向适合这场活动（内部留痕，不会上屏）"
}
要求：3 个方向的 thesis 必须互不相同，styleVector 也要有真实差异。
★ 数字只能原样出现在上面给出的事实与素材里：禁止四舍五入、禁止写约数
  （海拔 1004 米不能写成「1000 米级」，4980 元不能写成「5000 元档」）。${brandVoice}`
  );

  let raw: Partial<CreativeDirection>[] = [];
  let llmError = '';
  try {
    const json = await callJsonLlm<{ directions?: unknown }>(merchantId, {
      system: DIRECTION_SYSTEM,
      prompt,
      temperature: 0.9,
      note: 'V3 creative directions',
    });
    if (Array.isArray(json.directions)) raw = json.directions as Partial<CreativeDirection>[];
  } catch (err) {
    // ★ 绝不静默吞错：LLM 失败会退化成 dir-fallback-* 兜底方向，
    //   若不打日志，线上只能看到「方向很模板」而查不出是 Key 失效 / 积分不足 / 超时。
    //
    // ★ 归一化后只留「一行有效信息」：底层抛出的常是多行 prisma / 网络堆栈，
    //   整段塞进 generationMeta.fallbackReason 会变成一段读不了的文本
    //   （实测开头就是个空行）。这个字段是给运维看的
    //   （「AI 积分不足，请充值…」/「平台 LLM Key 未配置」/ 超时），不是用来读堆栈的。
    const firstLine = String(err instanceof Error ? err.message : err)
      .split('\n')
      .map((s) => s.trim())
      .find((s) => s.length > 0);
    llmError = (firstLine || '未知原因').slice(0, 200);
    logger.warn(`[v3/direction] LLM 生成方向失败，走确定性兜底：${llmError}`);
    raw = [];
  }

  const candidate = raw.map((d, i) => normalizeDirection(d, truth, insight, i));
  const final = dedupeDirections(rejectUngroundedDirections(candidate, truth), truth, insight);

  /*
   * ★ 闸门要盖在**输出**上，而不是只盖住「LLM 那一段」。
   *
   * 原先只在 LLM 方向上调 rejectUngroundedDirections，兜底方向不过闸 ——
   * 而兜底方向同样会一字不改地上屏（thesis → 公众号 opening / 详情页引用，
   * communicationAngle → 小红书 mainAngle / 公众号 heading）。
   * 于是线上出现了「LLM 方向被闸门拒收 → 兜底补位 → 兜底自己带无据数字 → 照样上线」，
   * 闸门等于装了个寂寞：水流从旁边绕过去了。
   * 修法就是这一行：出口处再过一次同一把尺子。
   */
  const safe = rejectUngroundedDirections(final, truth);
  if (!safe.length) {
    // 正常走不到：兜底文案全部由 confirmedFacts / insight 的原文拼装，天生在事实池内。
    // 留着只为「宁可退化也不把空数组喂给 selectDirection」（selectDirection 会取 [0] 使用）。
    logger.error('[v3/direction] 全部方向都被事实闸门拒收，退回未过滤集合（属于内部逻辑缺陷，请查兜底模板）');
  }

  return {
    directions: safe.length ? safe : final,
    llmUsed: raw.length > 0,
    llmError: raw.length > 0 ? '' : llmError,
  };
}

/**
 * 方向级事实闸门。
 *
 * 为什么必须在方向这一层就拦：thesis 与 communicationAngle 不是内部字段 ——
 *   · 公众号 opening 直接取 direction.thesis（channels.ts）
 *   · 小红书 hook / mainAngle / body 直接取 communicationAngle 与 thesis
 *   · 详情页 quote 型 block 的 headline 取 thesis
 * 于是 LLM 在方向里随手写的「海拔 5000 米」（实际 5025）、「2700 米」
 * 会一字不改地出现在用户读到的文案里，而块级 groundClaims 根本管不到它
 * （groundClaims 只看 blocks 的 copy）。验收时正是这条路径漏出了编造数字。
 *
 * 处理方式：整条方向拒收，不做数字擦除 —— 从 thesis 里抠掉数字必然留下破句，
 * 而「永不产破句」是硬约定。方向有 3 个候选，拒收一条还剩两条；
 * 全被拒收时由 dedupeDirections 里那套「由本场证据推出」的确定性兜底补位。
 */
export function rejectUngroundedDirections(
  list: CreativeDirection[],
  truth: ActivityTruth
): CreativeDirection[] {
  const kept: CreativeDirection[] = [];
  for (const d of list) {
    const visible = [d.thesis, d.communicationAngle, ...(d.narrativeStrategy || [])].join(' ');
    const bad = Array.from(new Set(unsupportedNumbersIn(visible, truth)));
    if (bad.length) {
      logger.warn(
        `[v3/direction] 拒收方向「${d.thesis}」：thesis/angle 出现事实池外的数字 ${bad.join('、')}`
      );
      continue;
    }
    kept.push(d);
  }
  return kept;
}

function normalizeDirection(
  d: Partial<CreativeDirection>,
  truth: ActivityTruth,
  insight: MarketingInsight,
  idx: number
): CreativeDirection {
  return {
    id: `dir-${idx + 1}-${Math.random().toString(36).slice(2, 8)}`,
    thesis: String(d.thesis ?? '').slice(0, 60) || `围绕${truth.confirmedFacts.place ?? '这条路线'}的一次出行`,
    targetAudience: String(d.targetAudience ?? insight.targetAudience).slice(0, 40),
    primaryMotivation: String(d.primaryMotivation ?? insight.motivation?.[0] ?? '').slice(0, 40),
    primaryBarrier: String(d.primaryBarrier ?? insight.barrier).slice(0, 40),
    communicationAngle: String(d.communicationAngle ?? '').slice(0, 60),
    evidenceRefs: Array.isArray(d.evidenceRefs) ? d.evidenceRefs.map(String).slice(0, 8) : [],
    narrativeStrategy: Array.isArray(d.narrativeStrategy)
      ? d.narrativeStrategy.map(String).slice(0, 5)
      : [],
    styleVector: normalizeStyleVector(d.styleVector),
    expectedVisualStrategy: String(d.expectedVisualStrategy ?? '').slice(0, 80),
    rationale: String(d.rationale ?? '').slice(0, 120),
  };
}

/* ============================================================
 * 兜底方向的 StyleVector —— 必须由「这一场自己的证据」推出来
 * ==========================================================
 * 为什么非改不可：原先 3 个兜底方向都从 neutralStyleVector() 起跳，于是 30 场活动
 * 算出的风格向量**完全相同**（styleVectorDistance min=0）—— 等于「不管什么活动都长一个样」，
 * 而文档的硬要求恰恰是「差异化必须来自 StyleVector 连续量纲 + 本场证据」。
 * 更直接的后果：选中率最高的第 1 个方向恒为 rhythm=slow / whitespace=tight，
 * 公众号渲染器的段距/行高对所有活动都一样。
 *
 * 映射关系（每一项都能在 ActivityTruth 里找到出处，不做无据推断）：
 *   informationWeight  ← 费用项 / 装备项 / 里程海拔等硬指标的条数
 *   textDensity        ← 行程条目数（要交代的步骤越多，字越密）
 *   documentaryLevel   ← 行程条目数 + 接地场景数
 *   aspirationLevel    ← 海拔/里程量级（5025 米的雪山 ≠ 6 公里的净山）
 *   challengeSignal    ← 难度词 + 里程/爬升量级
 *   socialEnergy       ← 事实文本里是否出现人群型活动词（亲子/团建/接力/飞盘…）
 *   lifestyleSignal    ← 是否出现生活方式词（温泉/度假/野餐/摄影/市集…）
 *   professionalSignal ← 费用与装备里是否出现向导/教练/领队/保障/许可/保险/讲师
 *   emotionalWeight    ← 素材里是否出现日出/星空/云海/夜色这类画面词
 *   imageDominance     ← 可描写的画面条数（素材越多越能让图说话）
 *   ctaStrength        ← 价格/名额/装备清单的完备度（信息给全了才敢催报名）
 *   typographyEnergy   ← 标题长度（长标题需要更收的排版能量）
 */
const DIFFICULTY_RANK: Array<[RegExp, number]> = [
  [/技术/, 1],
  [/高强度|挑战|极限/, 0.85],
  [/中等/, 0.55],
  [/轻松|休闲/, 0.25],
];

/** '海拔5025米' / '累计爬升800米' / '往返34公里' → 0~1 的量级 */
function magnitude(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return 0;
  const s = String(raw);
  const m = s.match(/\d+(?:\.\d+)?/g);
  if (!m || !m.length) return 0;
  const n = Math.max.apply(null, m.map(Number));
  if (!Number.isFinite(n)) return 0;
  if (/海拔|爬升|米/.test(s)) return clamp01(n / 6000);
  if (/公里|km|KM/.test(s)) return clamp01(n / 80);
  return clamp01(n / 100);
}

export function evidenceStyleVector(truth: ActivityTruth): StyleVector {
  const f = truth.confirmedFacts;
  const scenes = truth.groundedScenes;
  const text = [
    f.title,
    f.place,
    f.difficulty,
    f.distance,
    f.elevation,
    ...truth.fee.include,
    ...truth.fee.exclude,
    ...truth.checklist.required,
    ...truth.checklist.recommended,
    ...scenes.map((s) => s.value),
  ]
    .filter(Boolean)
    .join(' ');

  const itinCount = truth.itinerary.length;
  const sceneCount = scenes.length;
  /** 素材/行程原文的**总字数** —— 这是「这场能讲多少」的直接证据。
      只数条数会撞车：acc-14「含破冰游戏与定向寻宝」与 acc-29「零基础友好」都是
      1 条素材 / 3 项费用 / 0 行程 / 轻松 / 12 字标题，条数口径下完全同构 → 向量一模一样。 */
  const sceneChars = scenes.reduce((n, s) => n + String(s.value).length, 0);
  const feeChars = [...truth.fee.include, ...truth.fee.exclude, ...truth.checklist.required]
    .join('')
    .length;
  const feeCount = truth.fee.include.length + truth.fee.exclude.length;
  const gearCount = truth.checklist.required.length + truth.checklist.recommended.length;
  const hardCount = [f.distance, f.elevation, f.difficulty].filter(Boolean).length;
  const titleLen = String(f.title ?? '').length;

  const diffRank = DIFFICULTY_RANK.reduce(
    (acc, r) => (r[0].test(String(f.difficulty ?? '')) ? Math.max(acc, r[1]) : acc),
    0
  );
  const mag = Math.max(magnitude(f.elevation), magnitude(f.distance));
  const has = (words: string[]) => words.some((w) => text.indexOf(w) >= 0);

  const social = has(['亲子', '团建', '接力', '飞盘', '瑜伽', '研学', '家庭', '破冰', '聚会', '同行']);
  const lifestyle = has(['温泉', '度假', '野餐', '糖水', '摄影', '市集', '咖啡', '美食', '山居']);
  const professional = has(['向导', '教练', '领队', '保障', '许可', '保险', '讲师', '导师', '急救']);
  const emotional = has(['日出', '日落', '星空', '银河', '云海', '夜色', '晚霞', '晨雾', '灯火']);

  /* insight 只在证据薄时兜住几个表达维度，不参与事实判断 */
  const thin = sceneCount === 0 && feeCount === 0;

  const base: Partial<StyleVector> = {
    imageDominance: clamp01(0.3 + Math.min(0.42, sceneCount * 0.05) + (has(['摄影', '观星', '星空', '日出', '云海']) ? 0.12 : 0)),
    textDensity: clamp01(
      0.24 +
        Math.min(0.4, itinCount * 0.06) +
        feeCount * 0.02 +
        gearCount * 0.015 +
        titleLen * 0.004 +
        Math.min(0.1, sceneChars * 0.004)
    ),
    informationWeight: clamp01(
      0.28 +
        feeCount * 0.05 +
        gearCount * 0.04 +
        hardCount * 0.08 +
        titleLen * 0.003 +
        Math.min(0.14, sceneChars * 0.005) +
        Math.min(0.1, feeChars * 0.004)
    ),
    emotionalWeight: clamp01(0.3 + (emotional ? 0.28 : 0) + (lifestyle ? 0.12 : 0) + (thin ? 0.08 : 0)),
    documentaryLevel: clamp01(
      0.25 + Math.min(0.4, itinCount * 0.06) + Math.min(0.25, sceneCount * 0.03) + Math.min(0.22, sceneChars * 0.006)
    ),
    aspirationLevel: clamp01(0.3 + mag * 0.45 + (lifestyle ? 0.08 : 0)),
    socialEnergy: clamp01(0.25 + (social ? 0.4 : 0) + Math.min(0.2, gearCount * 0.02) + (f.limit && f.limit >= 30 ? 0.08 : 0)),
    challengeSignal: clamp01(0.2 + diffRank * 0.45 + mag * 0.3),
    lifestyleSignal: clamp01(0.25 + (lifestyle ? 0.35 : 0)),
    professionalSignal: clamp01(0.28 + (professional ? 0.35 : 0) + Math.min(0.2, feeCount * 0.03)),
    ctaStrength: clamp01(
      0.3 + (f.price !== undefined ? 0.15 : 0) + Math.min(0.25, gearCount * 0.04) + (f.limit ? 0.08 : 0)
    ),
    typographyEnergy: clamp01(0.3 + Math.min(0.35, titleLen / 60) + (diffRank >= 0.85 ? 0.1 : 0)),
  };

  const textDensity = base.textDensity as number;
  const imageDominance = base.imageDominance as number;
  return normalizeStyleVector({
    ...base,
    /* 节奏与留白也由证据折算，不做「三档模板」 */
    rhythm: textDensity >= 0.55 ? 'fast' : textDensity <= 0.36 ? 'slow' : 'medium',
    whitespace:
      textDensity >= 0.6 ? 'tight' : imageDominance >= 0.6 && textDensity <= 0.46 ? 'generous' : 'balanced',
  });
}

/**
 * 兜底方向的可上屏文案 —— 只能由「本场已有证据」拼装。
 *
 * ★ 三条硬规矩，都是线上踩出来的：
 *
 *  1. **不得含序号。** 旧模板是 `${title}的第 ${i + 1} 个角度：${whatWeSell}`，
 *     外加 `communicationAngle: `${whatWeSell}（备用角度 ${i + 1}）``。
 *     问题是这两个字段**不是内部字段**：
 *       · thesis → 公众号 opening、详情页引用型 block 的 headline、小红书正文
 *       · communicationAngle → 小红书 mainAngle、公众号 heading
 *     于是读者真的会看到「沙漠穿越 + 洞穴探秘的第 3 个角度」——
 *     那是写代码的人需要的信息，不是读者需要的；而且那个「3」是事实池外的
 *     数字，会被方向级事实闸门判成编造数字（线上验收 R4b 就是这么挂的）。
 *     序号只允许出现在 `rationale`（内部留痕，不上屏）。
 *
 *  2. **不得含事实池外的数字。** 切面全部取自 insight 与 confirmedFacts 的原文，
 *     因此天然满足。任何时候都不要在这里新造数字（比如「N 大亮点」）。
 *
 *  3. **候选之间的差异只能来自不同切面，不能来自序号。**
 *     切面不够就少给候选 ——「宁少不假」：下游少一个候选只是少一个选择，
 *     把序号送上屏是事故。
 */
function fallbackFacets(
  truth: ActivityTruth,
  insight: MarketingInsight
): { thesis: string; angle: string }[] {
  const f = truth.confirmedFacts;
  const title = String(f.title ?? '').trim();
  const place = String(f.place ?? '').trim();
  // 标题里往往已经含地点（title「白云嶂穿越 · 一日徒步」+ place「惠州 白云嶂」），
  // 无脑拼接会得到「白云嶂穿越 · 一日徒步 · 惠州 白云嶂」这种自己重复自己的话。
  const placeRedundant =
    !!place && place.split(/[\s·,，/]+/).filter(Boolean).some((seg) => title.includes(seg));
  const lead = title && place && !placeRedundant ? `${title} · ${place}` : title || place || '本场活动';

  const out: { thesis: string; angle: string }[] = [];
  const push = (v: unknown) => {
    const angle = String(v ?? '').trim();
    if (!angle) return;
    const thesis = `${lead}｜${angle}`;
    if (out.some((o) => o.thesis === thesis)) return;
    out.push({ thesis, angle });
  };
  /*
   * 顺序即优先级。★只收「能当主张读的短语」：
   *   whatWeSell / motivation / targetAudience 是见解级短语，读起来是一句话；
   *   insight.strongestEvidence 是**事实原句**（如「07:30 深圳北站集合出发」）——
   *   拿它当传播主张会产出「…｜07:30 深圳北站集合出发」这种莫名其妙的东西
   *   （第一版就这么产过，所以这里把它踢出切面表）。
   * 事实字段（difficulty / distance / days）只在短语不足时补位：它们是值不是主张，
   * 但读到「…｜中等」也比把序号送上屏强。
   * 切面凑不满 3 个就少给候选 —— 宁少不假。
   */
  push(insight.whatWeSell);
  push((insight.motivation ?? [])[0]);
  push(insight.targetAudience);
  push(f.difficulty);
  push(f.distance);
  push(f.days ? `${f.days} 天` : '');
  // 一个切面都取不到时，至少给「标题（含地点）」本身 —— 它是最硬的已确认事实
  if (!out.length) out.push({ thesis: lead, angle: lead });
  return out.slice(0, 3);
}

/**
 * 去重：文档要求 3 个方向必须「明显不同」。
 * 同 thesis 视为重复；styleVector 距离过近也降权删除。
 */
export function dedupeDirections(
  list: CreativeDirection[],
  truth: ActivityTruth,
  insight: MarketingInsight
): CreativeDirection[] {
  const kept: CreativeDirection[] = [];
  for (const d of list) {
    const dupThesis = kept.some((k) => isSameThesis(k.thesis, d.thesis));
    const dupStyle = kept.some((k) => styleVectorDistance(k.styleVector, d.styleVector) < 0.12);
    if (dupThesis || dupStyle) continue;
    kept.push(d);
  }
  // 不足 3 个时用「本场证据推出的向量」在各量纲上展开，保证下游始终有选择空间
  const evBase = evidenceStyleVector(truth);
  const facets = fallbackFacets(truth, insight);
  let i = 0;
  // ★ 上界是 facets.length，不是硬编码 3：候选之间的差异只能来自不同切面。
  //   见 fallbackFacets 注释 —— 用序号硬凑第 3 个候选，就是把序号送上屏。
  while (kept.length < 3 && i < facets.length) {
    const jitter = (base: number, step: number) =>
      clamp01(base + (i % 2 === 0 ? step : -step * 0.6));
    const base = kept[0]?.styleVector ?? evBase;
    const v = normalizeStyleVector({
      ...base,
      documentaryLevel: jitter(base.documentaryLevel, 0.25 + i * 0.1),
      aspirationLevel: jitter(base.aspirationLevel, 0.2 + i * 0.08),
      socialEnergy: jitter(base.socialEnergy, 0.18 + i * 0.08),
      // i=0 的节奏/留白保持证据取值（它被 selectDirection 选中的概率最高）；
      // i>0 才在节奏上做展开，保证候选之间也互不重复。
      rhythm: i === 0 ? base.rhythm : (['slow', 'medium', 'fast'] as const)[i % 3],
      whitespace: i === 0 ? base.whitespace : (['tight', 'balanced', 'generous'] as const)[i % 3],
    });
    kept.push({
      id: `dir-fallback-${i + 1}`,
      thesis: facets[i].thesis,
      targetAudience: insight.targetAudience,
      primaryMotivation: insight.motivation?.[0] ?? '',
      primaryBarrier: insight.barrier,
      communicationAngle: facets[i].angle,
      evidenceRefs: insight.strongestEvidence.slice(0, 3),
      narrativeStrategy: ['建立参照', '展开证据', '落到行动'],
      styleVector: v,
      expectedVisualStrategy: '按 StyleVector 执行',
      // 序号只允许出现在这里：rationale 是内部留痕，不上屏。
      rationale: `LLM 方向不足时的确定性补齐（内部序号 ${i + 1}）`,
    });
    i++;
  }
  return kept.slice(0, 3);
}

/**
 * Step 6：选择最合适且不过度重复的方向。
 * 文档优先级：活动适合度 > 事实支持 > 素材支持 > 目标用户匹配 > 历史差异化 > 随机性
 */
export function selectDirection(input: DirectionSelectionInput): CreativeDirection {
  const { directions, truth, vision, historyTheses, historyVectors } = input;
  if (!directions.length) return directions[0];

  const fit = (d: CreativeDirection) => {
    let s = 0;
    const scene = (truth.confirmedFacts.place ?? '').slice(0, 2);
    if (scene && d.thesis.includes(scene)) s += 0.2;
    if (d.evidenceRefs?.length) s += Math.min(0.3, d.evidenceRefs.length * 0.1);
    if (d.communicationAngle) s += 0.1;
    if (truth.confirmedFacts.difficulty && d.primaryBarrier) s += 0.1;
    return Math.min(1, s);
  };
  const asset = (d: CreativeDirection) => {
    const n = vision.length;
    if (!n) return d.styleVector.imageDominance < 0.35 ? 0.6 : 0.2;
    return d.styleVector.imageDominance > 0.5 ? 0.7 : 0.4;
  };
  const historyPenalty = (d: CreativeDirection) => {
    let worst = 0;
    for (const t of historyTheses) if (isSameThesis(t, d.thesis)) worst = Math.max(worst, 1);
    for (const v of historyVectors) {
      const dist = styleVectorDistance(v, d.styleVector);
      if (dist < 0.15) worst = Math.max(worst, 0.6);
    }
    return worst;
  };

  let best = directions[0];
  let bestScore = -Infinity;
  for (const d of directions) {
    const score = 0.4 * fit(d) + 0.3 * asset(d) + 0.3 * (1 - historyPenalty(d));
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}
