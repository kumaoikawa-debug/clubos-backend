/**
 * STEP 1｜Source Understanding（§6 / Task 4）
 *
 * 输入：文本 / PPT / Word / PDF / 图片 / 海报 / 旧宣传，可多文件混合。
 * 输出：publicFacts（C 端可公开）/ internalData（仅后台）/ promoMaterial（宣传素材）/ conflicts（冲突）。
 *
 * 纪律：
 *   - 原始材料整体保留在 sourceMaterials[].text，下游（editorial / generation）整段直喂模型，
 *     不在这里把语境压成几十个字段（§32）。本步只做「信息分类」，不做压缩。
 *   - 内部经营资料（成本 / 毛利 / 供应商报价 / 内部 SOP / 退款策略）严禁进入 publicFacts（§7 B）。
 *   - 只有真正冲突且 blocking=true 才上报询问（§7 D）。
 */
import type { ChatFn } from '../chat';
import { extractJson, safeStringifyActivity } from '../chat';
import type { SourceMaterial, SourceUnderstanding, Conflict } from '../types';

const SYSTEM = `你是 ClubOS 的活动资料理解助手。老板会把一场户外活动的原始资料（可能是一句话、PPT、Word、PDF、图片、海报或旧宣传）丢给你。
你的唯一任务：把信息分成四类，不要改写、不要编造、不要压缩成几十个字段。

分类规则：
A. publicFacts：可以面向 C 端客户公开的事实。例如时间、地点、活动内容、行程、参与方式、价格、服务、装备建议。
B. internalData：只允许俱乐部后台使用的经营资料。例如供应商成本、单项采购价、毛利、内部执行费、工作人员内部 SOP、市场部名单、客服退款沟通策略。这些绝对不能进入 C 端页面。
C. promoMaterial：宣传素材/卖点。例如目的地价值、独特体验、品牌合作、场景、文化体验、服务优势。
D. conflicts：只有资料之间真正互相矛盾时才记录；field 用字段名，values 列冲突值，reason 写 source_conflict，blocking=true 表示必须问用户。

最高原则：允许创造表达，不允许创造事实。资料里没有的，不要写进任何一类。`;

export async function understandSources(
  merchantId: string,
  sourceMaterials: SourceMaterial[] | undefined,
  activity: Record<string, unknown> | undefined,
  chat: ChatFn
): Promise<SourceUnderstanding> {
  const mats = sourceMaterials && sourceMaterials.length ? sourceMaterials : [];
  const sourceText = mats
    .map((m, i) => {
      const body = [m.text, (m.imageRefs && m.imageRefs.length) ? `图片引用: ${m.imageRefs.join(', ')}` : '']
        .filter(Boolean)
        .join('\n');
      return `【资料 ${i + 1}｜类型=${m.type}】\n${body || '(无文本)'}`;
    })
    .join('\n\n');

  const prompt = `以下是这场活动的原始资料（请整体理解，不要只看字段）：

==== 原始资料 ====
${sourceText || '（无上传资料）'}

==== 活动主记录（如有）====
${safeStringifyActivity(activity)}

==== 任务 ====
请严格按 JSON 输出，只做分类，不编造：
{
  "publicFacts": { "字段名": "原始事实值" },
  "internalData": { "字段名": "内部经营值" },
  "promoMaterial": [ { "kind": "卖点类型", "text": "原始素材描述" } ],
  "conflicts": [ { "field": "字段名", "values": ["值1","值2"], "reason": "source_conflict", "blocking": true } ]
}`;

  // ★ merchantId 必须由编排器显式传入（req.admin.sub），绝不从 activity 记录里猜——
  //   前端 activity 不带 merchantId，曾兜底成 '0' → getAccount(0) 开户 → 外键约束 500（线上事故 v236 修）。
  const r = await chat(String(merchantId), prompt, {
    system: SYSTEM,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    note: 'AI Engine·Source Understanding',
  });

  let parsed: { publicFacts?: Record<string, unknown>; internalData?: Record<string, unknown>; promoMaterial?: { kind: string; text: string }[]; conflicts?: Conflict[] } = {};
  try {
    parsed = extractJson(r.content);
  } catch {
    // 分类失败不阻断主流程：退回空分类，下游用 activity 原文兜底
    parsed = {};
  }

  return {
    publicFacts: parsed.publicFacts || {},
    internalData: parsed.internalData || {},
    promoMaterial: Array.isArray(parsed.promoMaterial) ? parsed.promoMaterial : [],
    conflicts: Array.isArray(parsed.conflicts) ? parsed.conflicts : [],
    sourceMaterials: mats,
  };
}
