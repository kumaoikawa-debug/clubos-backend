/**
 * 第三阶段｜活动回顾离线契约校验（不调用真实 LLM）
 *
 * 验证 §18 / §28 纪律：
 *   - 输入 = Activity Master + actualActivityData + 现场照片 + 领队备注 + 用户反馈；
 *   - AI 重新判断「这一次真正值得记录的是什么」（worthRecording）；
 *   - 回顾 block 由模型产出，生成器不注入固定 skeleton（集合→出发→途中→合影→感谢→下一期）；
 *   - actualActivityData / 领队备注 / 用户反馈 纳入「允许事实集」：
 *       真实发生的细节不被误判为编造，但资料里没有的仍然拦截；
 *   - 图片只引用现场照片真实 id。
 */
import { generateRecap, type ChatFn } from '../src/ai-content-vnext';
import { PROMO_BLOCK_TYPES, type ProxyResult } from '../src/ai-content-vnext/types';

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    pass++;
    console.log('  ✓', msg);
  } else {
    fail++;
    console.error('  ✗', msg);
  }
}

const ACTIVITY = { title: '蓥华山徒步+瑜伽', date: '2026-10-24', location: '什邡', price: '¥298' };

const FIXED_SKELETON = ['集合', '出发', '途中', '合影', '感谢', '下一期'];

function makeRecapStub(blocks: any[], worthRecording = '一个孩子第一次走完全程'): ChatFn {
  return async (_mid: string, prompt: string): Promise<ProxyResult> => {
    let content = '';
    if (prompt.includes('分类')) {
      content = JSON.stringify({
        publicFacts: { title: ACTIVITY.title, date: ACTIVITY.date, location: ACTIVITY.location, price: ACTIVITY.price },
        internalData: { cost: 120 },
        promoMaterial: [],
        conflicts: [],
      });
    } else if (prompt.includes('"blocks"')) {
      content = JSON.stringify({ blocks });
    } else {
      content = JSON.stringify({
        worthRecording,
        activityUnderstanding: '实际走完了',
        coreSellingIdea: '第一次完成',
        targetAudience: '同行伙伴',
        mainUserMotivation: '回忆',
        mainUserBarrier: '没时间看',
        editorialStrategy: '从人物切入',
        visualStrategy: '现场图',
        editorialPlan: [
          { purpose: '开场', whatToSay: '那天山上下了雪', evidenceRefs: [], imageNeed: '现场图', textWeight: 0.5, visualWeight: 0.5 },
          { purpose: '主体', whatToSay: '孩子坚持走完', evidenceRefs: [], imageNeed: '人物图', textWeight: 0.6, visualWeight: 0.4 },
          { purpose: '收尾', whatToSay: '下次再见', evidenceRefs: [], imageNeed: '合影', textWeight: 0.5, visualWeight: 0.5 },
        ],
      });
    }
    return { content, source: 'platform', credits: 1, tokens: 10, balance: 999 };
  };
}

async function main() {
  const base = {
    merchantId: '1',
    activityId: 'a1',
    activity: ACTIVITY as Record<string, unknown>,
    sourceMaterials: [{ id: 's1', type: 'text', text: '森林瑜伽与溪流徒步' }],
    photos: [] as any,
  };

  console.log('— 回顾主流程：AI 重新判断「值得记录什么」—');
  const recapBlocks = [
    { type: 'hero', headline: '那天，一个孩子走完了全程' },
    { type: 'text', text: '实到 18 人，全程 8km' },
    { type: 'single_image', mediaRefs: ['live1'] },
    { type: 'cta', ctaText: '看下一期' },
  ];
  const r = await generateRecap(
    {
      ...base,
      recap: {
        actualActivityData: { attendance: 18, distance: '8km', weather: '下雪', summit: false },
        photos: [{ id: 'live1', src: 'https://img/live1.jpg', caption: '现场', eventFact: true }],
        leaderNotes: ['孩子第一次参加，一路很坚持'],
        feedback: ['孩子说下次还要来'],
      },
    },
    makeRecapStub(recapBlocks)
  );

  assert(!!r.worthRecording, '回顾产出 worthRecording（AI 判断「真正值得记录的是什么」）');
  assert(r.blocks.length === recapBlocks.length, `回顾 block 数量 = 模型产出（${recapBlocks.length}），生成器未注入额外 block`);
  assert(
    r.blocks.every((b) => PROMO_BLOCK_TYPES.includes(b.type)),
    '回顾 block 类型落在 12 型白名单内'
  );

  console.log('— 不套固定 skeleton（集合→出发→途中→合影→感谢→下一期）—');
  // 生成器不主动注入：模型没给的 skeleton 词不应凭空出现
  const modelText = recapBlocks.map((b: any) => b.headline || b.text || b.ctaText || '').join('');
  const skeletonInjected = FIXED_SKELETON.filter(
    (w) => r.blocks.some((b: any) => (b.headline || b.text || b.ctaText || '').indexOf(w) >= 0) &&
      modelText.indexOf(w) < 0
  );
  assert(skeletonInjected.length === 0, '生成器未注入固定 skeleton 文案（' + (skeletonInjected.join('/') || '无') + '）');

  console.log('— actualActivityData 纳入允许事实集（真实细节不被误判）—');
  // 「下雪」属 §19 禁造词，但 actualActivityData 明确写了 weather=下雪 → 应放行
  const snowBlocks = [
    { type: 'text', text: '那天山上真的下雪了' },
    { type: 'cta', ctaText: '看下一期' },
  ];
  const rSnow = await generateRecap(
    {
      ...base,
      recap: { actualActivityData: { weather: '下雪' }, photos: [] },
    },
    makeRecapStub(snowBlocks)
  );
  assert(rSnow.grounding.passed, 'actualActivityData 写了「下雪」→ 回顾说下雪不算编造（真实数据放行）');

  console.log('— 资料里没有的仍然拦截（编造不放行）—');
  // 「登顶」不在 actualActivityData → 应拦截
  const evilBlocks = [
    { type: 'statement', text: '大家成功登顶，还有绝美日照金山' },
    { type: 'cta', ctaText: '看下一期' },
  ];
  const rEvil = await generateRecap(
    {
      ...base,
      recap: { actualActivityData: { attendance: 18 }, photos: [] },
    },
    makeRecapStub(evilBlocks)
  );
  assert(!rEvil.grounding.passed, '回顾编造「登顶 / 日照金山」而实际数据无 → grounding 不通过');
  assert(rEvil.grounding.issues.some((i) => i.field === 'event' || i.field === 'weather'), '拦截编造（§19）');

  console.log('— 现场照片：只引用真实 id —');
  const refs = r.blocks.flatMap((b: any) => b.mediaRefs || []);
  assert(
    refs.every((id: string) => id === 'live1'),
    '回顾 block 图片引用全部来自现场照片真实 id'
  );

  console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
