/**
 * 第四阶段｜增强能力离线契约校验（§29，不调用真实 LLM）
 *
 * 验证：
 *   - Semantic Similarity：相同→1、不同→低、空值→0（空值绝不白送相似度）；
 *   - Layout Similarity：同版式→1、异版式→低、空→0；
 *   - Creative Memory：写入 / 读取最近 / 清空；
 *   - 多 Creative Direction + 自动选择不同宣传切口：连续生成会换切口（不是死代码）；
 *   - 反重复度量：重复内容被标记为 repetitive；
 *   - 闸门真的挂在生成链路上（diversity 默认开启，diversity:false 可关）。
 */
import {
  semanticSimilarity,
  layoutSimilarity,
  recordCreativeMemory,
  recentCreativeMemory,
  clearCreativeMemory,
  pickDirection,
  DIRECTIONS,
  recordAndMeasure,
  generatePromoCanvas,
  type ChatFn,
} from '../src/ai-content-vnext';
import type { ProxyResult } from '../src/ai-content-vnext/types';

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

function makeStub(blocks: any[]): ChatFn {
  return async (_mid: string, prompt: string): Promise<ProxyResult> => {
    let content = '';
    if (prompt.includes('分类')) {
      content = JSON.stringify({
        publicFacts: { title: '蓥华山徒步', price: '¥298' },
        internalData: {},
        promoMaterial: [],
        conflicts: [],
      });
    } else if (prompt.includes('"blocks"')) {
      content = JSON.stringify({ blocks });
    } else {
      content = JSON.stringify({
        activityUnderstanding: 'x',
        coreSellingIdea: '自然疗愈',
        targetAudience: 'a',
        mainUserMotivation: 'b',
        mainUserBarrier: 'c',
        editorialStrategy: 'd',
        visualStrategy: 'e',
        editorialPlan: [{ purpose: 'p', whatToSay: 's', evidenceRefs: [], imageNeed: 'i', textWeight: 0.5, visualWeight: 0.5 }],
      });
    }
    return { content, source: 'platform', credits: 1, tokens: 10, balance: 999 };
  };
}

async function main() {
  console.log('— Semantic Similarity —');
  assert(semanticSimilarity('森林瑜伽徒步', '森林瑜伽徒步') === 1, '完全相同文本 → 相似度 1');
  assert(semanticSimilarity('森林瑜伽徒步', '城市骑行看展') < 0.3, '不同内容 → 相似度低');
  assert(semanticSimilarity('', '森林瑜伽') === 0, '空文本 → 相似度 0（空值不白送相似度）');
  assert(semanticSimilarity('森林瑜伽', '') === 0, '另一侧空 → 相似度 0');

  console.log('— Layout Similarity —');
  const seqA = [{ type: 'hero' }, { type: 'text' }, { type: 'cta' }] as any;
  const seqB = [{ type: 'hero' }, { type: 'text' }, { type: 'cta' }] as any;
  const seqC = [{ type: 'quote' }, { type: 'image_pair' }] as any;
  assert(layoutSimilarity(seqA, seqB) === 1, '相同版式序列 → 版式相似度 1');
  assert(layoutSimilarity(seqA, seqC) < 0.5, '不同版式 → 相似度低');
  assert(layoutSimilarity([], seqA) === 0, '空版式 → 相似度 0');

  console.log('— Creative Memory —');
  clearCreativeMemory('m1');
  recordCreativeMemory('m1', { activityId: 'a1', direction: 'scenery', text: '看风景' });
  const mem = recentCreativeMemory('m1', 10);
  assert(mem.length === 1 && mem[0].direction === 'scenery', '写入后可读取最近记忆');
  clearCreativeMemory('m1');
  assert(recentCreativeMemory('m1', 10).length === 0, '清空后记忆为空');

  console.log('— 自动选择不同宣传切口 —');
  const d1 = pickDirection([]);
  const d2 = pickDirection([{ activityId: 'a', direction: d1.key, ts: Date.now() }]);
  assert(d1.key !== d2.key, `连续两次选择不同切口（${d1.key} → ${d2.key}）`);
  assert(DIRECTIONS.length >= 3, `存在多个 Creative Direction（${DIRECTIONS.length} 个）`);

  console.log('— 反重复度量 —');
  clearCreativeMemory('m2');
  const blocks = [{ type: 'hero', headline: '蓥华山森林瑜伽的一天' }, { type: 'text', text: '溪流徒步与森林瑜伽' }] as any;
  const m1 = recordAndMeasure('m2', { activityId: 'a1', direction: d1, blocks });
  const m2 = recordAndMeasure('m2', { activityId: 'a1', direction: d2, blocks });
  assert(m1.semantic < 0.5 && m1.layout < 0.5, '首次生成与历史无撞车（相似度低）');
  assert(m2.semantic > 0.5 && m2.layout > 0.5, '重复内容 → 语义 / 版式相似度都高');
  assert(m2.repetitive === true, '重复内容被标记为 repetitive（反重复生效）');

  console.log('— 闸门真的挂在生成链路上（非死代码）—');
  clearCreativeMemory('m3');
  const r1 = await generatePromoCanvas(
    { merchantId: 'm3', activityId: 'a1', activity: { title: 'A' }, sourceMaterials: [], photos: [] },
    makeStub(blocks)
  );
  assert(!!r1.diversity && !!r1.diversity.direction, '默认生成即带 diversity.direction（闸门默认开启）');
  const r2 = await generatePromoCanvas(
    { merchantId: 'm3', activityId: 'a1', activity: { title: 'A' }, sourceMaterials: [], photos: [] },
    makeStub(blocks)
  );
  assert(
    !!r1.diversity?.direction && !!r2.diversity?.direction &&
      r1.diversity.direction.key !== r2.diversity.direction.key,
    `连续生成自动换切口（${r1.diversity?.direction?.key} → ${r2.diversity?.direction?.key}）`
  );
  const r3 = await generatePromoCanvas(
    { merchantId: 'm3', activityId: 'a1', activity: { title: 'A' }, sourceMaterials: [], photos: [], diversity: false },
    makeStub(blocks)
  );
  assert(!r3.diversity, 'diversity:false 可关闭闸门（增强能力非强制主链）');

  console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
