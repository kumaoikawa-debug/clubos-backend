/**
 * 离线契约校验（不调用真实 LLM）：
 *   - Task 5：ActivityMaster 冻结——internalData 绝不进入 publicFacts
 *   - Task 7：Promo Blocks 仅限 12 型
 *   - Task 6/§9：Editorial Plan 长度不固定（非固定章节骨架）
 *   - Task 10：grounding 拦截虚构天气 / 名额 / 领队行为，及 materialEvidence 误用
 *
 * 用 stub ChatFn 返回脚本 JSON，验证纯逻辑与结构纪律。
 */
import { buildActivityMaster } from '../src/ai-content-vnext/activity-master';
import { checkFacts } from '../src/ai-content-vnext/grounding';
import { generatePromoCanvas, type ChatFn } from '../src/ai-content-vnext';
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

// stub：根据 prompt 关键字返回不同阶段的脚本 JSON
function makeStub(planLen: number, blocks: any[]): ChatFn {
  return async (_mid: string, prompt: string): Promise<ProxyResult> => {
    let content = '';
    if (prompt.includes('分类')) {
      content = JSON.stringify({
        publicFacts: { title: '蓥华山徒步+瑜伽', date: '2026-10-24', price: '¥298' },
        internalData: { cost: 120, margin: 178 },
        promoMaterial: [{ kind: '体验', text: '森林瑜伽' }],
        conflicts: [],
      });
    } else if (prompt.includes('"blocks"')) {
      content = JSON.stringify({ blocks });
    } else {
      // editorial：含 activityUnderstanding 等 7 问字段
      const plan = Array.from({ length: planLen }).map((_, i) => ({
        purpose: `段${i}`,
        whatToSay: '基于资料',
        evidenceRefs: [],
        imageNeed: '图',
        textWeight: 0.5,
        visualWeight: 0.5,
      }));
      content = JSON.stringify({
        activityUnderstanding: '徒步+瑜伽',
        coreSellingIdea: '自然疗愈',
        targetAudience: '都市人',
        mainUserMotivation: '放松',
        mainUserBarrier: '没时间',
        editorialStrategy: '从自然切入',
        visualStrategy: '大图',
        editorialPlan: plan,
      });
    }
    return { content, source: 'platform', credits: 1, tokens: 10, balance: 999 };
  };
}

async function main() {
  console.log('— Task 5：ActivityMaster 冻结 —');
  const master = buildActivityMaster({
    activityId: 'a1',
    activity: { title: 'X', cost: 120 },
    understanding: {
      publicFacts: { title: '蓥华山徒步+瑜伽', date: '2026-10-24', price: '¥298' },
      internalData: { cost: 120, margin: 178 },
      promoMaterial: [],
      conflicts: [],
      sourceMaterials: [],
    },
    photos: [],
  });
  assert(!('cost' in master.publicFacts), '主记录 cost 字段未泄漏进 publicFacts');
  assert(master.internalData.cost === 120, 'internalData.cost 正确保留（仅后台）');
  assert(!('cost' in master.publicFacts), '分类 internalData 未混入 publicFacts');
  assert(master.publicFacts.price === '¥298', 'publicFacts.price 正确');

  console.log('— Task 7：Promo Blocks 仅限 12 型 —');
  const cleanBlocks = [
    { type: 'hero', headline: '蓥华山' },
    { type: 'single_image', mediaRefs: ['p1'] },
    { type: 'text', text: '森林徒步' },
    { type: 'cta', ctaText: '报名' },
  ];
  const stub3 = makeStub(3, cleanBlocks);
  const r1 = await generatePromoCanvas(
    { merchantId: '1', activityId: 'a1', activity: { title: '蓥华山' }, sourceMaterials: [], photos: [] },
    stub3
  );
  assert(
    r1.blocks.every((b) => PROMO_BLOCK_TYPES.includes(b.type)),
    '全部 block 类型落在 12 型白名单内'
  );
  assert(r1.blocks.length === 4, `block 数量自由（=4，非固定）`);

  console.log('— Task 6/§9：Editorial Plan 长度不固定 —');
  const r5 = await generatePromoCanvas(
    { merchantId: '1', activityId: 'a1', activity: { title: 'A' }, sourceMaterials: [], photos: [] },
    makeStub(5, [{ type: 'hero', headline: 'h' }])
  );
  const r8 = await generatePromoCanvas(
    { merchantId: '1', activityId: 'a1', activity: { title: 'A' }, sourceMaterials: [], photos: [] },
    makeStub(8, [{ type: 'hero', headline: 'h' }])
  );
  assert(r5.editorialPlan.editorialPlan.length === 5, 'editorialPlan 长度=5（可变）');
  assert(r8.editorialPlan.editorialPlan.length === 8, 'editorialPlan 长度=8（可变，证明非固定骨架）');
  assert(r5.editorialPlan.editorialPlan.length !== r8.editorialPlan.editorialPlan.length, '不同活动可不同长度');

  console.log('— Task 10：grounding 拦截虚构 —');
  // 资料里没有「日照金山 / 云海 / 剩余名额」
  const badMaster = buildActivityMaster({
    activityId: 'a2',
    activity: { title: 'B', price: '¥298' },
    understanding: { publicFacts: { title: 'B', price: '¥298' }, internalData: {}, promoMaterial: [], conflicts: [], sourceMaterials: [] },
    photos: [],
  });
  const badBlocks = [
    { type: 'statement', text: '本次活动将有绝美日照金山与云海，剩余名额不多，马上满员！' },
    { type: 'text', text: '报名费只要 ¥199' },
  ];
  const g = checkFacts(badBlocks, badMaster);
  assert(!g.passed, '含虚构天气/名额 → grounding 不通过');
  assert(g.issues.some((i) => i.field === 'weather'), '拦截虚构天气（日照金山/云海）');
  assert(g.issues.some((i) => i.field === 'participation'), '拦截虚构名额（剩余名额/马上满员）');
  assert(g.issues.some((i) => i.field === 'price'), '拦截价格越界（¥199≠¥298）');

  // materialEvidence 误用
  const evMaster = buildActivityMaster({
    activityId: 'a3',
    activity: { title: 'C' },
    understanding: { publicFacts: { title: 'C' }, internalData: {}, promoMaterial: [], conflicts: [], sourceMaterials: [] },
    photos: [{ id: 'old1', src: 'x', caption: '往期篝火实拍', materialEvidence: true, eventFact: false }],
  });
  const evBlocks = [{ type: 'text', text: '本次活动现场会有篝火' , mediaRefs: ['old1'] }];
  const g2 = checkFacts(evBlocks, evMaster);
  assert(g2.issues.some((i) => i.field === 'event' && i.severity === 'block'), 'materialEvidence 图被伪称活动事实 → 拦截');

  console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
