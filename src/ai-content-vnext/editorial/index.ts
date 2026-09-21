/**
 * STEP 3｜Editorial Plan（§8 / Task 6）
 *
 * 新版最核心能力：AI 不当填模板工，先当「活动内容主编」完整阅读 Activity Master + 原始资料 + 图片理解 + 品牌上下文，
 * 先回答 7 个问题，再给出 editorialPlan。
 *
 * 纪律（§9）：
 *   - editorialPlan 长度不固定（可 3 段也可 8+ 段），不同活动结构必须允许完全不同；
 *   - 「为什么值得去 / 体验什么 / 收获什么 / 适合谁」只是模型内部思考参考，绝不能变成页面固定章节骨架；
 *   - 页面结构由 AI 自定，Renderer 不替 AI 决定（§11）。
 */
import type { ChatFn } from '../chat';
import { extractJson } from '../chat';
import type { ActivityMaster, EditorialPlan, EditorialPlanItem, SourceUnderstanding } from '../types';

const SYSTEM = `你是 ClubOS 的「活动内容主编」。你不直接套模板，而是先真正理解这场户外活动，再为它策划一整套宣传结构。

你必须：
1. 完整阅读 Activity Master、原始资料文本、图片理解与品牌上下文；
2. 先想清楚 7 个问题（活动是什么 / 最值得卖的是什么 / 谁会感兴趣 / 最大区别 / 页面从哪里开始 / 图文谁更重 / 详情如何展开）；
3. 再给出 editorialPlan：每一段是一个宣传意图（purpose）、要讲什么（whatToSay）、引用哪些证据（evidenceRefs，对应资料/图片 id）、需要什么图（imageNeed）、文字权重 textWeight 与视觉权重 visualWeight（二者相加≈1）。

严禁：
- 使用固定章节骨架（如「第一章：为什么值得去 / 第二章：体验 / 第三章：适合谁」）；
- 给所有活动套同一套段落顺序；
- 凭空编造资料里没有的天气、名额、领队行为、用户评价。

editorialPlan 长度由你根据活动自行决定，可 3 段也可 8 段以上。`;

function buildMasterContext(master: ActivityMaster, understanding: SourceUnderstanding): string {
  const rawTexts = (understanding.sourceMaterials || [])
    .map((m, i) => `【原始资料 ${i + 1}｜${m.type}】\n${m.text || '(无文本)'}`)
    .join('\n\n');
  const photos = master.photos
    .map(
      (p) =>
        `- ${p.id}: ${p.caption || '(无图注)'} ｜ 朝向=${p.orientation || '未知'} ｜ 主体=${(
          p.subjects || []
        ).join('/') || '未知'} ｜ 证据=${p.eventFact ? '本次活动事实' : p.materialEvidence ? '历史素材证据' : '未标注'}`
    )
    .join('\n');
  return `==== Activity Master ====
publicFacts: ${JSON.stringify(master.publicFacts, null, 2)}
itinerary: ${JSON.stringify(master.itinerary, null, 2)}
fees: ${JSON.stringify(master.fees, null, 2)}
services: ${JSON.stringify(master.services, null, 2)}
checklist: ${JSON.stringify(master.checklist, null, 2)}
sellingEvidence(宣传素材): ${JSON.stringify(master.sellingEvidence, null, 2)}
photos:
${photos || '(无)'}
brandContext: ${JSON.stringify(master.brandContext, null, 2)}

==== 原始资料全文（请整体理解）====
${rawTexts || '(无上传资料)'}`;
}

export async function planEditorial(
  merchantId: string,
  master: ActivityMaster,
  understanding: SourceUnderstanding,
  chat: ChatFn
): Promise<EditorialPlan> {
  const ctx = buildMasterContext(master, understanding);
  const prompt = `${ctx}

==== 任务 ====
请严格按 JSON 输出：
{
  "activityUnderstanding": "这场活动真正是什么",
  "coreSellingIdea": "最值得卖的是什么",
  "targetAudience": "谁会对它感兴趣",
  "mainUserMotivation": "用户主要动机",
  "mainUserBarrier": "用户主要顾虑",
  "editorialStrategy": "页面整体如何展开",
  "visualStrategy": "图文谁更重、用什么图",
  "editorialPlan": [
    {
      "purpose": "这一段宣传意图",
      "whatToSay": "要讲的核心内容（只基于资料事实，不编造）",
      "evidenceRefs": ["引用的资料/图片 id"],
      "imageNeed": "需要什么图（如：一张雪山横图 / 两张人物竖图）",
      "textWeight": 0.3,
      "visualWeight": 0.7
    }
  ]
}`;

  const r = await chat(merchantId, prompt, {
    system: SYSTEM,
    temperature: 0.7,
    response_format: { type: 'json_object' },
    note: 'AI Engine·Editorial Plan',
  });

  const parsed = extractJson<EditorialPlan>(r.content);
  if (!Array.isArray(parsed.editorialPlan) || parsed.editorialPlan.length === 0) {
    throw new Error('Editorial Plan 为空，模型未产出 editorialPlan');
  }
  // 归一化权重
  parsed.editorialPlan = parsed.editorialPlan.map((it: EditorialPlanItem) => ({
    purpose: String(it.purpose || ''),
    whatToSay: String(it.whatToSay || ''),
    evidenceRefs: Array.isArray(it.evidenceRefs) ? it.evidenceRefs.map(String) : [],
    imageNeed: String(it.imageNeed || ''),
    textWeight: typeof it.textWeight === 'number' ? it.textWeight : 0.5,
    visualWeight: typeof it.visualWeight === 'number' ? it.visualWeight : 0.5,
  }));
  return parsed;
}
