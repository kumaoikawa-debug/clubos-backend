/**
 * STEP 4｜Promo Blocks（§10 / Task 7）
 *
 * Editorial Plan 确定后再做第二次生成，输出结构化 Block，不直接生成 HTML。
 *
 * 纪律（§10）：
 *   - Block 类型只有 12 种（hero/text/statement/metric_strip/single_image/image_pair/image_triplet/image_group/text_image/quote/divider/cta）；
 *   - Block 顺序不固定（保证页面不是模板）；
 *   - Block 数量不固定（让不同活动产生不同节奏）；
 *   - 内容必须来自资料事实（§19），图片引用必须遵守 materialEvidence/eventFact 区分（§20）。
 */
import type { ChatFn } from '../chat';
import { extractJson } from '../chat';
import {
  PROMO_BLOCK_TYPES,
  type ActivityMaster,
  type EditorialPlan,
  type PromoBlock,
  type PromoBlocks,
  type SourceUnderstanding,
} from '../types';

const SYSTEM = `你是 ClubOS 的 Block 生成器。根据「Editorial Plan」把策划落地成结构化 Promo Block 序列。

只允许以下 12 种 block 类型：
hero / text / statement / metric_strip / single_image / image_pair / image_triplet / image_group / text_image / quote / divider / cta

规则：
- 不输出 HTML，只输出 JSON blocks 数组；
- block 顺序由你定（不要千篇一律 hero→text→image→cta）；
- block 数量由你定（可 4 个也可 12 个），跟着 editorialPlan 的节奏走；
- hero 必带 headline；text/statement/quote 必带 text；metric_strip 带 metrics[{label,value}]；
- 图片 block（single_image/image_pair/image_triplet/image_group/text_image）的 mediaRefs 只能引用资料里真实存在的图片 id；
- 引用历史素材图（materialEvidence=true 且 eventFact=false）时，文案只能说「往期活动」/「实拍」，绝不能说「本次活动会有篝火/日照金山」之类未证实事实；
- 严禁编造天气、云海、红叶、雪、日照金山、登顶、实际人数、用户评价、领队行为、保险保障、剩余名额、「马上满员」、「最后几个」、「大家很开心」。

允许创造表达（更有画面感的措辞），不允许创造事实。`;

function buildContext(master: ActivityMaster, understanding: SourceUnderstanding, plan: EditorialPlan): string {
  const photos = master.photos
    .map(
      (p) =>
        `${p.id}｜${p.caption || '(无图注)'}｜朝向=${p.orientation || '未知'}｜主体=${(
          p.subjects || []
        ).join('/') || '未知'}｜${p.eventFact ? '本次活动事实' : p.materialEvidence ? '历史素材证据' : '未标注'}｜src=${p.src}`
    )
    .join('\n');
  return `==== publicFacts（可引用的事实）====
${JSON.stringify(master.publicFacts, null, 2)}
==== 可引用图片 ====
${photos || '(无)'}
==== Editorial Plan ====
${JSON.stringify(plan, null, 2)}`;
}

export async function generateBlocks(
  merchantId: string,
  master: ActivityMaster,
  understanding: SourceUnderstanding,
  plan: EditorialPlan,
  chat: ChatFn,
  instruction?: string
): Promise<PromoBlocks> {
  const ctx = buildContext(master, understanding, plan);
  const reviseNote = instruction
    ? `\n\n【自然语言改稿指令】请基于以上计划做调整：${instruction}\n要求：只调整表达方式/结构/图文比重，绝不改变已确认的事实与图片引用。`
    : '';

  const prompt = `${ctx}
${reviseNote}

==== 任务 ====
输出 JSON：{ "blocks": [ /* 按你定的顺序与数量，只使用允许的 12 种类型 */ ] }
每个 block 示例：
{ "type": "hero", "headline": "...", "subtitle": "...", "mediaRefs": ["img_01"] }
{ "type": "statement", "text": "..." }
{ "type": "image_pair", "mediaRefs": ["img_07", "img_09"] }
{ "type": "text_image", "headline": "...", "body": "...", "mediaRefs": ["img_12"] }
{ "type": "metric_strip", "metrics": [ {"label":"里程","value":"12km"}, {"label":"海拔","value":"3200m"} ] }
{ "type": "cta", "ctaText": "立即报名", "ctaAction": "signup" }`;

  const r = await chat(merchantId, prompt, {
    system: SYSTEM,
    temperature: instruction ? 0.6 : 0.8,
    response_format: { type: 'json_object' },
    note: instruction ? 'AI Engine·Promo Blocks(revise)' : 'AI Engine·Promo Blocks',
  });

  const parsed = extractJson<PromoBlocks>(r.content);
  if (!Array.isArray(parsed.blocks)) throw new Error('模型未返回 blocks 数组');

  // 类型白名单过滤：未知类型一律丢弃，保证前端可控（§10）
  const blocks: PromoBlock[] = parsed.blocks
    .filter((b: PromoBlock) => PROMO_BLOCK_TYPES.includes(b.type))
    .map((b: PromoBlock) => ({
      type: b.type,
      headline: b.headline,
      subtitle: b.subtitle,
      text: b.text,
      metrics: Array.isArray(b.metrics) ? b.metrics : undefined,
      mediaRefs: Array.isArray(b.mediaRefs) ? b.mediaRefs : undefined,
      body: b.body,
      caption: b.caption,
      ctaText: b.ctaText,
      ctaAction: b.ctaAction,
    }));

  if (blocks.length === 0) throw new Error('过滤后无合法 block（模型可能返回了非法类型）');
  return { blocks };
}
