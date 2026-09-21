/**
 * vnext-merchant-guard-check.ts —— merchantId 传递护栏契约（v236 修线上事故后加）
 *
 * 事故：understandSources 曾用 `activity?.merchantId ?? '0'` 当记账 mid —— 前端 activity 不带
 * merchantId → getAccount(0) 开户 → ai_credit_accounts_club_id_fkey 外键约束 500。
 * 离线契约的 stub 从不校验 mid，所以 61 条断言全绿照样翻车。
 *
 * 本契约盯的是：**管线里每一次 LLM 调用收到的 mid 都必须是编排器传入的 merchantId**。
 * 用法：npx tsx tools/vnext-merchant-guard-check.ts
 */
import { generatePromoCanvas, generateChannel, generateRecap, understandSources } from '../src/ai-content-vnext';
import type { ChatFn, ProxyResult } from '../src/ai-content-vnext/chat';

const MERCHANT = '777';

const ACTIVITY = {
  title: '蓥华山徒步',
  location: '蓥华山',
  date: '10/11',
  priceText: '98元/人',
  summary: '单日徒步，全程8公里，爬升600米',
  // 故意不带 merchantId —— 复刻前端真实形态
};

const SOURCES = [{ id: 's1', type: 'text' as const, text: '07:30 集合出发，含领队和保险' }];

function makeStub() {
  const mids: string[] = [];
  const stub: ChatFn = async (mid: string, prompt: string): Promise<ProxyResult> => {
    mids.push(String(mid));
    let content = '';
    if (prompt.includes('分类')) {
      content = JSON.stringify({
        publicFacts: { title: ACTIVITY.title, date: ACTIVITY.date, price: ACTIVITY.priceText },
        internalData: {},
        promoMaterial: [{ kind: '体验', text: '森林徒步' }],
        conflicts: [],
      });
    } else if (prompt.includes('"blocks"')) {
      content = JSON.stringify({
        blocks: [
          { type: 'hero', headline: '周末去蓥华山徒步' },
          { type: 'text', text: '单日 8km，轻松上手' },
          { type: 'cta', ctaText: '立即报名' },
        ],
      });
    } else {
      content = JSON.stringify({
        worthRecording: '全程无一人放弃',
        activityUnderstanding: '单日徒步',
        coreSellingIdea: '轻松完成',
        targetAudience: '都市人',
        mainUserMotivation: '放松',
        mainUserBarrier: '没时间',
        editorialStrategy: '从轻松切入',
        visualStrategy: '大图',
        editorialPlan: [
          { purpose: '开场', whatToSay: '8km 轻松走', evidenceRefs: [], imageNeed: '风景图', textWeight: 0.5, visualWeight: 0.5 },
          { purpose: '主体', whatToSay: '森林徒步体验', evidenceRefs: [], imageNeed: '现场图', textWeight: 0.6, visualWeight: 0.4 },
          { purpose: '收尾', whatToSay: '立即报名', evidenceRefs: [], imageNeed: '集合图', textWeight: 0.5, visualWeight: 0.5 },
        ],
      });
    }
    return { content, source: 'platform', credits: 1, tokens: 10, balance: 999 };
  };
  return { stub, mids };
}

async function run() {
  const fails: string[] = [];
  const ok = (cond: boolean, msg: string) => { if (!cond) fails.push(msg); else console.log('  ✓', msg); };

  // 1) understandSources 直调：mid 必须原样透传
  const a = makeStub();
  await understandSources(MERCHANT, SOURCES, ACTIVITY, a.stub);
  ok(a.mids.length === 1 && a.mids[0] === MERCHANT,
    `understandSources 收到 mid=${JSON.stringify(a.mids)}（期望 ['${MERCHANT}']）`);

  // 2) 编排器全程：每次 LLM 调用的 mid 都必须是 MERCHANT，绝不允许 '0'/''/undefined
  const b = makeStub();
  await generatePromoCanvas({ merchantId: MERCHANT, activityId: 'guard-1', activity: ACTIVITY, sourceMaterials: SOURCES } as any, b.stub);
  ok(b.mids.length >= 3 && b.mids.every((m) => m === MERCHANT),
    `generatePromoCanvas 全部 ${b.mids.length} 次调用 mid 一致（${JSON.stringify([...new Set(b.mids)])}）`);

  const c = makeStub();
  await generateChannel({ merchantId: MERCHANT, activityId: 'guard-2', activity: ACTIVITY, sourceMaterials: SOURCES, channel: 'wechat' } as any, c.stub);
  ok(c.mids.length >= 2 && c.mids.every((m) => m === MERCHANT),
    `generateChannel(wechat) 全部 ${c.mids.length} 次调用 mid 一致`);

  const d = makeStub();
  await generateRecap({ merchantId: MERCHANT, activityId: 'guard-3', activity: ACTIVITY, sourceMaterials: SOURCES, recap: { actualActivityData: { actualPeople: 12 } } } as any, d.stub);
  ok(d.mids.length >= 2 && d.mids.every((m) => m === MERCHANT),
    `generateRecap 全部 ${d.mids.length} 次调用 mid 一致`);

  console.log(`通过 ${4 - fails.length}，失败 ${fails.length}`);
  if (fails.length) { console.error('失败项：', fails); process.exit(1); }
  console.log('%c[merchant guard] 记账 mid 全程一致，无占位透传', 'color:#1a7f37;font-weight:bold');
}

run().catch((e) => { console.error(e); process.exit(1); });
