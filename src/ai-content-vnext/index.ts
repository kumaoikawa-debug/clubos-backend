/**
 * ai-content-vnext —— 编排器（§6 五步 / §21 简单流程）
 *
 *   Source Understanding
 *     ↓ Activity Master
 *     ↓ Editorial Plan
 *     ↓ Promo Blocks
 *     ↓ Renderer（前端）
 *     ↓ Fact Check（grounding）
 *
 * 对外只暴露两个能力：
 *   generatePromoCanvas(input) —— 生成活动详情 AI Promo Canvas
 *   revisePromo(input)        —— 自然语言改稿（§15 / DoD #9）
 *
 * 所有 LLM 调用经 ChatFn（默认 proxyChat，平台 Key + 积分计量），不接触密钥。
 */
import type { ChatFn, ProxyResult } from './chat';
import { defaultChat } from './chat';
import { understandSources } from './source-understanding';
import { buildActivityMaster } from './activity-master';
import { planEditorial } from './editorial';
import { generateBlocks } from './generation';
import { checkFacts } from './grounding';
import { normalizePhotos } from './media';
import { selectDirection, recordAndMeasure } from './diversity';
import type { GeneratePromoInput, PromoCanvasResult, DiversityMeta } from './types';

interface Meter {
  credits: number;
  tokens: number;
  balance: number;
  source: string;
}

function metered(chat: ChatFn): { fn: ChatFn; meter: Meter } {
  const meter: Meter = { credits: 0, tokens: 0, balance: 0, source: 'platform' };
  const fn: ChatFn = async (mid, prompt, opts) => {
    const r: ProxyResult = await chat(mid, prompt, opts);
    meter.credits += r.credits;
    meter.tokens += r.tokens;
    meter.balance = r.balance;
    meter.source = r.source;
    return r;
  };
  return { fn, meter };
}

export async function generatePromoCanvas(
  input: GeneratePromoInput,
  chat: ChatFn = defaultChat
): Promise<PromoCanvasResult> {
  const { fn: c, meter } = metered(chat);
  const merchantId = input.merchantId;

  const photos = normalizePhotos(input.photos);
  const understanding = await understandSources(input.sourceMaterials, input.activity, c);
  const master = buildActivityMaster({
    activityId: input.activityId,
    activity: input.activity,
    understanding,
    photos,
  });
  // §29 反重复闸门：生成前自动挑一个与最近内容不同的宣传切口
  const useDiversity = input.diversity !== false;
  const direction = useDiversity ? selectDirection(merchantId) : null;

  const plan = await planEditorial(
    merchantId,
    master,
    understanding,
    c,
    undefined,
    direction ? direction.hint : undefined
  );
  const { blocks } = await generateBlocks(merchantId, master, understanding, plan, c);
  const grounding = checkFacts(blocks, master, understanding);

  // 生成后写入 Creative Memory 并度量反重复
  const diversity: DiversityMeta | null = useDiversity
    ? {
        direction,
        repetition: recordAndMeasure(merchantId, {
          activityId: input.activityId,
          channel: 'promo',
          direction,
          thesis: plan.coreSellingIdea,
          blocks,
        }),
      }
    : null;

  return {
    activityMaster: master,
    editorialPlan: plan,
    blocks,
    grounding,
    diversity: diversity || undefined,
    usage: { credits: meter.credits, tokens: meter.tokens, balance: meter.balance, source: meter.source },
  };
}

/**
 * 自然语言改稿（§15 / DoD #9）：字少一点 / 图片多一点 / 更专业 / 突出徒步 / 重新策划
 * 第一版策略：保留 Activity Master 与事实，重跑 Editorial Plan + Blocks，并把指令注入生成。
 * 不推翻已确认事实（grounding 仍会兜底校验）。
 */
export async function revisePromo(
  input: GeneratePromoInput,
  chat: ChatFn = defaultChat
): Promise<PromoCanvasResult> {
  if (!input.instruction || !input.instruction.trim()) {
    throw new Error('revise 需要提供 instruction（自然语言改稿指令）');
  }
  // 改稿复用既有理解结果（如果有），否则重新理解
  const { fn: c, meter } = metered(chat);
  const merchantId = input.merchantId;
  const photos = normalizePhotos(input.photos);
  const understanding = await understandSources(input.sourceMaterials, input.activity, c);
  const master = buildActivityMaster({
    activityId: input.activityId,
    activity: input.activity,
    understanding,
    photos,
  });
  const useDiversity = input.diversity !== false;
  const direction = useDiversity ? selectDirection(merchantId) : null;

  const plan = await planEditorial(
    merchantId,
    master,
    understanding,
    c,
    undefined,
    direction ? direction.hint : undefined
  );
  const { blocks } = await generateBlocks(merchantId, master, understanding, plan, c, input.instruction);
  const grounding = checkFacts(blocks, master, understanding);

  const diversity: DiversityMeta | null = useDiversity
    ? {
        direction,
        repetition: recordAndMeasure(merchantId, {
          activityId: input.activityId,
          channel: 'promo',
          direction,
          thesis: plan.coreSellingIdea,
          blocks,
        }),
      }
    : null;

  return {
    activityMaster: master,
    editorialPlan: plan,
    blocks,
    grounding,
    diversity: diversity || undefined,
    usage: { credits: meter.credits, tokens: meter.tokens, balance: meter.balance, source: meter.source },
  };
}

export * from './types';
export { understandSources } from './source-understanding';
export { buildActivityMaster } from './activity-master';
export { planEditorial } from './editorial';
export { generateBlocks } from './generation';
export { checkFacts } from './grounding';
export { normalizePhotos, classifyEvidence } from './media';
export { defaultChat } from './chat';
export type { ChatFn } from './chat';
export { generateChannel } from './channels';
export type { ChannelResult, ChannelType, GenerateChannelInput } from './types';
export { generateRecap, buildRecapMaster } from './recap';
export type { RecapResult, RecapInput, GenerateRecapInput, RecapPlan } from './types';
/* §29 增强能力（第四阶段） */
export { selectDirection, recordAndMeasure, measureOnly } from './diversity';
export { DIRECTIONS, pickDirection } from './directions';
export { recordCreativeMemory, recentCreativeMemory, clearCreativeMemory } from './creative-memory';
export { semanticSimilarity } from './similarity/semantic';
export { layoutSimilarity } from './similarity/layout';
