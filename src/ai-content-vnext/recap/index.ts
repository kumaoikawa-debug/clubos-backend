/**
 * 活动回顾（§18 / §28 第三阶段）
 *
 * 输入：Activity Master + actualActivityData + 现场照片 + 领队少量备注 + 真实用户反馈。
 * AI 重新判断：这一次真正值得记录的是什么？
 *   - 可能是一个孩子第一次完成 / 一段登顶 / 一场雨 / 一组人物 / 一顿营地晚餐 / 一组非常漂亮的现场照片。
 * 严禁固定 skeleton：集合 → 出发 → 途中 → 合影 → 感谢 → 下一期。
 *
 * Block 复用同一套 12 型（§10），顺序 / 数量由 AI 自定；grounding 额外把
 * actualActivityData / 领队备注 / 用户反馈 纳入「允许事实集」。
 */
import type { ChatFn } from '../chat';
import { extractJson, defaultChat } from '../chat';
import { generateBlocks } from '../generation';
import { checkFacts, scanFreeText } from '../grounding';
import { normalizePhotos } from '../media';
import { metered } from '../channels/meter';
import { understandSources } from '../source-understanding';
import { buildActivityMaster } from '../activity-master';
import { selectDirection, recordAndMeasure } from '../diversity';
import type { ActivityMaster, DiversityMeta, GenerateRecapInput, GroundingReport, RecapPlan, RecapResult, SourceUnderstanding } from '../types';

const SYSTEM = `你是 ClubOS 的「活动回顾主编」。你要为一场已经结束的活动写回顾。

输入包括：
- Activity Master（原始方案的事实母体）；
- actualActivityData（实际发生的数据：真实时间 / 人数 / 行程 / 天气等）；
- 现场照片（本次真实拍摄）；
- 领队的少量备注；
- 真实用户反馈（如有）。

你必须先回答一个问题：
> 这一次真正值得记录的是什么？

它可能是：
- 一个孩子第一次完成；
- 一段登顶；
- 一场雨；
- 一组人物；
- 一顿营地晚餐；
- 一组非常漂亮的现场照片。

然后围绕这个判断重新策划回顾结构，用 JSON 输出。

严禁：
- 套用固定 skeleton（集合 → 出发 → 途中 → 合影 → 感谢 → 下一期）——不同活动必须长得不一样；
- 编造天气、云海、红叶、雪、日照金山、登顶、实际人数、用户评价、领队行为、现场氛围——除非 actualActivityData / 领队备注 / 用户反馈明确支持；
- 把「方案里承诺的」当成「实际发生的」。

允许创造表达（更有画面感的措辞），不允许创造事实。`;

function buildRecapContext(
  master: ActivityMaster,
  understanding: SourceUnderstanding,
  recap: GenerateRecapInput['recap']
): string {
  const rawTexts = (understanding.sourceMaterials || [])
    .map((m, i) => `【原始资料 ${i + 1}｜${m.type}】\n${m.text || '(无文本)'}`)
    .join('\n\n');
  const notes = (recap.leaderNotes || []).map((n, i) => `- 领队备注 ${i + 1}：${n}`).join('\n');
  const feedback = (recap.feedback || []).map((f, i) => `- 用户反馈 ${i + 1}：${f}`).join('\n');
  const photos = (recap.photos && recap.photos.length ? recap.photos : master.photos)
    .map(
      (p) =>
        `- ${p.id}: ${p.caption || '(无图注)'} ｜ 朝向=${p.orientation || '未知'} ｜ 主体=${(
          p.subjects || []
        ).join('/') || '未知'} ｜ src=${p.src}`
    )
    .join('\n');
  return `==== Activity Master（原始方案）====
publicFacts: ${JSON.stringify(master.publicFacts, null, 2)}
itinerary: ${JSON.stringify(master.itinerary, null, 2)}
photos:
${photos || '(无)'}

==== actualActivityData（实际发生，真实数据）====
${JSON.stringify(recap.actualActivityData || {}, null, 2)}

==== 领队备注 ====
${notes || '(无)'}

==== 真实用户反馈 ====
${feedback || '(无)'}

==== 原始资料全文 ====
${rawTexts || '(无上传资料)'}`;
}

/**
 * 把回顾输入并入母体，使 grounding 把 actualActivityData / 领队备注 / 用户反馈
 * 视为「允许事实集」的一部分（否则回顾里的真实细节会被误判为编造）。
 */
export function buildRecapMaster(master: ActivityMaster, recap: GenerateRecapInput['recap']): ActivityMaster {
  const parts: string[] = [];
  if (recap.actualActivityData && Object.keys(recap.actualActivityData).length) {
    parts.push('【实际发生】' + JSON.stringify(recap.actualActivityData));
  }
  (recap.leaderNotes || []).forEach((n) => parts.push('【领队备注】' + n));
  (recap.feedback || []).forEach((f) => parts.push('【用户反馈】' + f));
  const text = parts.join('\n');

  return {
    ...master,
    photos: recap.photos && recap.photos.length ? normalizePhotos(recap.photos) : master.photos,
    sourceMaterials: [
      ...master.sourceMaterials,
      { id: 'actual_activity_data', type: 'text' as const, text },
    ],
    sellingEvidence: [
      ...master.sellingEvidence,
      ...(recap.leaderNotes || []).map((n) => ({ kind: '领队备注', text: n })),
      ...(recap.feedback || []).map((f) => ({ kind: '用户反馈', text: f })),
    ],
  };
}

async function planRecap(
  merchantId: string,
  master: ActivityMaster,
  understanding: SourceUnderstanding,
  recap: GenerateRecapInput['recap'],
  chat: ChatFn,
  instruction?: string,
  directionHint?: string
): Promise<RecapPlan> {
  const ctx = buildRecapContext(master, understanding, recap);
  const reviseNote = instruction ? `\n\n【改稿指令】${instruction}\n只调整表达方式 / 结构 / 图文比重，绝不改变真实发生的事实。` : '';
  const system = directionHint
    ? SYSTEM + '\n\n本次回顾建议的切入角度：' + directionHint
    : SYSTEM;
  const prompt = `${ctx}
${reviseNote}

==== 任务 ====
严格按 JSON 输出：
{
  "worthRecording": "这一次真正值得记录的是什么（一句话）",
  "activityUnderstanding": "这场活动实际发生了什么",
  "coreSellingIdea": "回顾的核心主线",
  "targetAudience": "这篇回顾写给谁看",
  "mainUserMotivation": "他们为什么想看",
  "mainUserBarrier": "他们可能的顾虑",
  "editorialStrategy": "回顾整体如何展开",
  "visualStrategy": "图文如何配合",
  "editorialPlan": [
    {
      "purpose": "这一段意图",
      "whatToSay": "要讲的内容（只基于实际发生的事实）",
      "evidenceRefs": ["引用的照片 / 数据 id"],
      "imageNeed": "需要什么图",
      "textWeight": 0.5,
      "visualWeight": 0.5
    }
  ]
}`;

  const r = await chat(merchantId, prompt, {
    system,
    temperature: 0.7,
    response_format: { type: 'json_object' },
    note: instruction ? 'AI Engine·Recap Plan(revise)' : 'AI Engine·Recap Plan',
  });

  const parsed = extractJson<RecapPlan>(r.content);
  if (!Array.isArray(parsed.editorialPlan) || parsed.editorialPlan.length === 0) {
    throw new Error('回顾计划为空，模型未产出 editorialPlan');
  }
  parsed.editorialPlan = parsed.editorialPlan.map((it) => ({
    purpose: String(it.purpose || ''),
    whatToSay: String(it.whatToSay || ''),
    evidenceRefs: Array.isArray(it.evidenceRefs) ? it.evidenceRefs.map(String) : [],
    imageNeed: String(it.imageNeed || ''),
    textWeight: typeof it.textWeight === 'number' ? it.textWeight : 0.5,
    visualWeight: typeof it.visualWeight === 'number' ? it.visualWeight : 0.5,
  }));
  parsed.worthRecording = String(parsed.worthRecording || '');
  return parsed;
}

/** 生成活动回顾（完整管线：理解 → 母体 → 回顾策划 → Blocks → Grounding） */
export async function generateRecap(
  input: GenerateRecapInput,
  chat: ChatFn = defaultChat
): Promise<RecapResult> {
  const { fn: c, meter } = metered(chat);
  const merchantId = input.merchantId;

  const photos = normalizePhotos(input.photos);
  const understanding: SourceUnderstanding = await understandSources(input.sourceMaterials, input.activity, c);
  const baseMaster = buildActivityMaster({
    activityId: input.activityId,
    activity: input.activity,
    understanding,
    photos,
  });
  // 回顾母体：并入 actualActivityData / 领队备注 / 用户反馈
  const master = buildRecapMaster(baseMaster, input.recap);

  // §29 反重复闸门：自动挑一个与最近内容不同的切入角度
  const useDiversity = input.diversity !== false;
  const direction = useDiversity ? selectDirection(merchantId) : null;

  const plan = await planRecap(
    merchantId,
    master,
    understanding,
    input.recap,
    c,
    input.instruction,
    direction ? direction.hint : undefined
  );
  const { blocks } = await generateBlocks(merchantId, master, understanding, plan, c, input.instruction);

  const grounding: GroundingReport = checkFacts(blocks, master, understanding);
  const extra = scanFreeText(plan.worthRecording, master);
  if (extra.length) {
    grounding.issues.push(...extra);
    grounding.passed = grounding.passed && extra.filter((i) => i.severity === 'block').length === 0;
  }

  const diversity: DiversityMeta | null = useDiversity
    ? {
        direction,
        repetition: recordAndMeasure(merchantId, {
          activityId: input.activityId,
          channel: 'recap',
          direction,
          thesis: plan.worthRecording,
          blocks,
        }),
      }
    : null;

  return {
    activityId: input.activityId,
    activityMaster: master,
    worthRecording: plan.worthRecording,
    blocks,
    grounding,
    diversity: diversity || undefined,
    usage: { credits: meter.credits, tokens: meter.tokens, balance: meter.balance, source: meter.source },
  };
}

export { planRecap };
