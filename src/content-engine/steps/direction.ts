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
  neutralStyleVector,
  styleVectorDistance,
  isSameThesis,
  clamp01,
} from '../contracts/creativeDirection';
import { buildPrompt, callJsonLlm } from './llm';
import type { VisionResult } from '../contracts/visionResult';

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

/** Step 5：生成 3 个候选方向（LLM） */
export async function generateDirections(
  merchantId: string,
  truth: ActivityTruth,
  insight: MarketingInsight,
  vision: VisionResult[]
): Promise<CreativeDirection[]> {
  const material = [
    ...truth.groundedScenes.map((s) => s.value),
    ...vision.flatMap((v) => v.scene ?? []),
  ].slice(0, 16);

  const prompt = buildPrompt(
    {
      confirmedTruth: { ...truth.confirmedFacts, itineraryDays: truth.itinerary.length },
      materialEvidence: material,
      creativeContext: { ...truth.creativeContext, insight },
      forbiddenAssumptions: ['把灵感当成事实', '固定话术如“逃离城市”“治愈”“松弛”'],
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
要求：3 个方向的 thesis 必须互不相同，styleVector 也要有真实差异。`
  );

  let raw: Partial<CreativeDirection>[] = [];
  try {
    const json = await callJsonLlm<{ directions?: unknown }>(merchantId, {
      system: DIRECTION_SYSTEM,
      prompt,
      temperature: 0.9,
      note: 'V3 creative directions',
    });
    if (Array.isArray(json.directions)) raw = json.directions as Partial<CreativeDirection>[];
  } catch {
    raw = [];
  }

  const directions = raw.map((d, i) => normalizeDirection(d, truth, insight, i));
  return dedupeDirections(directions, truth, insight);
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
  // 不足 3 个时用中性/变换量纲补齐，保证下游始终有选择空间
  let i = 0;
  while (kept.length < 3) {
    const seed = truth.confirmedFacts.title ?? 'activity';
    const jitter = (base: number, step: number) =>
      clamp01(base + (i % 2 === 0 ? step : -step * 0.6));
    const base = kept[0]?.styleVector ?? neutralStyleVector();
    const v = normalizeStyleVector({
      ...base,
      documentaryLevel: jitter(base.documentaryLevel, 0.25 + i * 0.1),
      aspirationLevel: jitter(base.aspirationLevel, 0.2 + i * 0.08),
      socialEnergy: jitter(base.socialEnergy, 0.18 + i * 0.08),
      rhythm: (['slow', 'medium', 'fast'] as const)[i % 3],
      whitespace: (['tight', 'balanced', 'generous'] as const)[i % 3],
    });
    kept.push({
      id: `dir-fallback-${i + 1}`,
      thesis: `${String(seed)}的第 ${i + 1} 个角度：${insight.whatWeSell}`,
      targetAudience: insight.targetAudience,
      primaryMotivation: insight.motivation?.[0] ?? '',
      primaryBarrier: insight.barrier,
      communicationAngle: `${insight.whatWeSell}（备用角度 ${i + 1}）`,
      evidenceRefs: insight.strongestEvidence.slice(0, 3),
      narrativeStrategy: ['建立参照', '展开证据', '落到行动'],
      styleVector: v,
      expectedVisualStrategy: '按 StyleVector 执行',
      rationale: 'LLM 方向不足时的确定性补齐',
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
