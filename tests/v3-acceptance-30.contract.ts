/**
 * Content Engine V3 —— Phase 6 验收：30 场多样性矩阵（离线契约）
 *
 * 运行： npx tsx tests/v3-acceptance-30.contract.ts
 *
 * ⚠️ 本地无 DATABASE_URL / 无 LLM Key 时：
 *    - 落库失败被 try/catch 兜住（预期噪音，内容照常产出）
 *    - 所有创作步骤走**确定性兜底** —— 所以这里断言的是「兜底线也必须守住的不变量」，
 *      真正的调性多样性要在线上跑 tools/v3-acceptance-live.ts（真实 LLM）。
 *
 * 断言的是边界，不是实现细节：
 *   1. 30 场 × 4 场景 全部跑通、零抛错（边界输入不许崩）
 *   2. 禁用话术零泄漏（兜底不是泄漏模板话术的理由）
 *   3. 文案里的数字必须能回溯到事实池（不得编造价格/里程/天数）
 *   4. 无价格活动不得凭空出现价格
 *   5. 公众号 HTML 能直接贴进微信后台（无 script/link/style/class + 图保比例）
 *   6. 回顾无现场素材必须诚实空态；有素材必须写素材里的事
 *   7. 缺失事实要被识别出来（交给确认卡，而不是让 AI 猜）
 */

import { runDetailPipeline } from '../src/content-engine/workflows/detail.workflow';
import { runWechatPipeline } from '../src/content-engine/workflows/wechat.workflow';
import { runXiaohongshuPipeline } from '../src/content-engine/workflows/xiaohongshu.workflow';
import { runRecapPipeline } from '../src/content-engine/workflows/recap.workflow';
import { buildTruth, normalizeInput } from '../src/content-engine/steps/truth';
import { isValidBlockType, CONTENT_BLOCK_TYPES } from '../src/content-engine/contracts/promoDocument';
import type { ActivityTruth } from '../src/content-engine/contracts/activityTruth';
import { buildFixture30, type Fixture } from '../tools/v3-fixture-30';
import { rejectUngroundedDirections } from '../src/content-engine/steps/direction';
import {
  buildCreativeFingerprint,
  sectionsAsBlocks,
  structureSimilarity,
  visualSimilarity,
} from '../src/content-engine/contracts/fingerprints';
import {
  actualFactPool,
  bannedHits,
  docTexts,
  priceFabrication,
  structureSignature,
  unsupportedNumbers,
  weatherClaims,
  wechatHtmlViolations,
  diversityStats,
  stripHtml,
  type Violation,
} from '../tools/v3-audit';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    const msg = String((e as Error).message).split('\n')[0];
    failures.push(`${name} :: ${msg}`);
    console.log(`  FAIL ${name}\n       ${msg}`);
  }
}

function must(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

function fmt(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v);
}

function summarize(vs: Violation[], limit = 6): string {
  return vs
    .slice(0, limit)
    .map((v) => `${v.kind}@${v.label}:${v.detail}`)
    .join(' | ') + (vs.length > limit ? ` …(+${vs.length - limit})` : '');
}

/* ============================================================
 * 矩阵
 * ========================================================== */

async function main() {
const fixtures: Fixture[] = buildFixture30();

interface RunRec {
  id: string;
  tag: string;
  scenario: string;
  ok: boolean;
  ms: number;
  error: string;
  doc: any;
  extra?: any;
  /** 本场传进去的现场素材（recap 用）—— 它的数字同样算「有据」，见 D2 */
  actual: Record<string, unknown> | null;
  truth: ActivityTruth;
  photoCount: number;
  texts: ReturnType<typeof docTexts>;
  banned: Violation[];
  numbers: Violation[];
  prices: Violation[];
  weather: Violation[];
  structure: string;
}

const runs: RunRec[] = [];

function truthOf(fx: Fixture): ActivityTruth {
  return buildTruth(normalizeInput({ activityId: fx.id, merchantId: '1', activity: fx.activity, planFacts: fx.planFacts, materialText: fx.materialText, photos: fx.photos }));
}

async function runOne(fx: Fixture, scenario: 'detail' | 'wechat' | 'xiaohongshu' | 'recap', withActual: boolean) {
  const truth = truthOf(fx);
  const t0 = Date.now();
  let doc: any = null;
  let extra: any = null;
  let error = '';
  const input: any = {
    merchantId: '1',
    activityId: fx.id,
    activity: fx.activity,
    planFacts: fx.planFacts,
    materialText: fx.materialText,
    photos: fx.photos,
  };
  if (scenario === 'recap' && withActual) {
    input.actual = {
      attendance: 18,
      weather: '晴，山脊风大',
      highlights: ['全员登顶', '山脊视野极好'],
      feedbacks: ['比想象中累但值得'],
      onSiteNotes: ['18 人全员完成，无一人下撤'],
    };
  } else if (scenario === 'recap') {
    input.actual = {};
  }
  try {
    if (scenario === 'detail') {
      const r = await runDetailPipeline(input);
      doc = r.document; extra = r;
    } else if (scenario === 'wechat') {
      const r = await runWechatPipeline(input);
      doc = r.document; extra = r;
    } else if (scenario === 'xiaohongshu') {
      const r = await runXiaohongshuPipeline(input);
      doc = r.document; extra = r;
    } else {
      const r = await runRecapPipeline(input);
      doc = r.document; extra = r;
    }
  } catch (e) {
    error = String((e as Error)?.message || e);
  }

  const texts: ReturnType<typeof docTexts> = doc ? docTexts(scenario, doc) : [];
  const actual = (input.actual as Record<string, unknown> | null) || null;
  runs.push({
    id: fx.id,
    tag: fx.tag,
    scenario,
    ok: !error && !!doc,
    ms: Date.now() - t0,
    error,
    doc,
    extra,
    actual,
    truth,
    photoCount: fx.photos.length,
    texts,
    banned: doc ? bannedHits(texts) : [],
    // 现场素材里的数字（实到 18 人 / 12 度）不是编造 —— 一并进事实池
    numbers: doc ? unsupportedNumbers(texts, truth, actual ? actualFactPool(actual) : []) : [],
    prices: doc ? priceFabrication(texts, truth) : [],
    weather: doc ? weatherClaims(texts, truth) : [],
    structure: doc ? structureSignature(scenario, doc) : '',
  });
}

const SCENARIOS = ['detail', 'wechat', 'xiaohongshu', 'recap'] as const;

console.log(`\n[Phase 6 · 离线] 30 场 × ${SCENARIOS.length} 场景 = ${fixtures.length * SCENARIOS.length} 篇（确定性兜底线）\n`);

for (const fx of fixtures) {
  for (const sc of SCENARIOS) {
    // recap 抽样 6 场带现场素材（其余走诚实空态）
    const withActual = sc === 'recap' && ['acc-01', 'acc-02', 'acc-09', 'acc-16', 'acc-23', 'acc-30'].includes(fx.id);
    await runOne(fx, sc, withActual);
  }
}

const detailRuns = runs.filter((r) => r.scenario === 'detail');
const wechatRuns = runs.filter((r) => r.scenario === 'wechat');
const xhsRuns = runs.filter((r) => r.scenario === 'xiaohongshu');
const recapRuns = runs.filter((r) => r.scenario === 'recap');

/* ============================================================
 * §A 矩阵自身
 * ========================================================== */

check('A1 矩阵：30 场且 id 唯一', () => {
  must(fixtures.length === 30, `fixtures=${fixtures.length}`);
  const ids = new Set(fixtures.map((f) => f.id));
  must(ids.size === 30, `uniq=${ids.size}`);
});

check('A2 矩阵覆盖关键边界（0照片/20照片/无价格/无行程/缺集合点/缺名额/超长标题/中文日期/特殊字符）', () => {
  const tags = fixtures.map((f) => f.tag).join('|');
  const need = ['边界:0照片', '边界:20照片', '边界:无价格', '边界:无行程', '边界:超长标题', '边界:特殊字符'];
  const miss = need.filter((t) => tags.indexOf(t) < 0);
  must(miss.length === 0, `缺：${miss.join(',')}`);
  const zero = fixtures.filter((f) => f.photos.length === 0).length;
  const twenty = fixtures.filter((f) => f.photos.length >= 20).length;
  must(zero >= 1 && twenty >= 1, `0照片=${zero} 20照片=${twenty}`);
  // ★ fixture 头部承诺覆盖的边界必须真的存在，否则是「假覆盖」——
  //   曾经 30 行里一行都没缺集合点、日期也全是 ISO 写法，承诺的两条边界是空的。
  const lacking = (k: string) =>
    fixtures.filter((f) => (f.activity as any)[k] === undefined && (f.planFacts as any)[k] === undefined).length;
  must(lacking('meeting') >= 1, '缺集合点的场次一个都没有（承诺的边界未覆盖）');
  must(lacking('limit') >= 1, '缺名额的场次一个都没有（承诺的边界未覆盖）');
  must(
    fixtures.some((f) => /\d{4}年\d{1,2}月\d{1,2}日/.test(String((f.activity as any).date ?? ''))),
    '中文日期写法（2026年10月1日）的场次一个都没有（承诺的边界未覆盖）'
  );
});

/* ============================================================
 * §B 零抛错
 * ========================================================== */

check('B1 ★120 篇全部跑通、零抛错（边界输入不许崩）', () => {
  const bad = runs.filter((r) => !r.ok);
  must(bad.length === 0, bad.map((r) => `${r.id}/${r.scenario}:${r.error}`).join(' | '));
});

/* ============================================================
 * §C detail 文档结构
 * ========================================================== */

check('C1 ★detail：schemaVersion=3 且 blocks ≥ 3 且 block 类型全在白名单', () => {
  const bad: string[] = [];
  for (const r of detailRuns) {
    const d = r.doc;
    if (d.schemaVersion !== 3) bad.push(`${r.id}:schema=${d.schemaVersion}`);
    const blocks = d.blocks || [];
    if (blocks.length < 3) bad.push(`${r.id}:blocks=${blocks.length}`);
    for (const b of blocks) {
      if (!isValidBlockType(b.type)) bad.push(`${r.id}:type=${b.type}`);
    }
  }
  must(bad.length === 0, bad.slice(0, 6).join(' | '));
});

check('C2 detail：block id 文档内唯一 + purpose/communicationGoal 非空 + layout.width 合法', () => {
  const bad: string[] = [];
  for (const r of detailRuns) {
    const ids = new Set<string>();
    for (const b of r.doc.blocks || []) {
      if (ids.has(b.id)) bad.push(`${r.id}:dupid=${b.id}`);
      ids.add(b.id);
      if (!b.purpose) bad.push(`${r.id}:${b.id}:no-purpose`);
      if (!b.communicationGoal) bad.push(`${r.id}:${b.id}:no-goal`);
      const w = b.layout && b.layout.width;
      if (!['normal', 'wide', 'full'].includes(w)) bad.push(`${r.id}:${b.id}:width=${w}`);
    }
  }
  must(bad.length === 0, bad.slice(0, 6).join(' | '));
});

check('C3 detail：evidenceRefs 是数组（可回溯的结构保证）', () => {
  const bad = detailRuns.filter((r) => (r.doc.blocks || []).some((b: any) => !Array.isArray(b.evidenceRefs)));
  must(bad.length === 0, bad.map((r) => r.id).join(','));
});

check('C4 ★detail：指纹带 StyleVector（跨场次去重的前提）', () => {
  const bad = detailRuns.filter((r) => !(r.doc.fingerprint && r.doc.fingerprint.styleVector));
  must(bad.length === 0, bad.map((r) => r.id).join(','));
});

/* ============================================================
 * §D 事实纪律（四场景全体）
 * ========================================================== */

check('D1 ★禁用话术零泄漏（全 120 篇）', () => {
  const bad = runs.filter((r) => r.banned.length > 0);
  must(bad.length === 0, bad.slice(0, 5).map((r) => `${r.id}/${r.scenario}: ${summarize(r.banned, 3)}`).join(' | '));
});

check('D2 ★编造数字零容忍：文案里的数字必须能回溯到事实池', () => {
  const bad = runs.filter((r) => r.numbers.length > 0);
  must(bad.length === 0, bad.slice(0, 5).map((r) => `${r.id}/${r.scenario}: ${summarize(r.numbers, 4)}`).join(' | '));
});

check('D3 ★无价格活动不得凭空出现价格', () => {
  const noPrice = runs.filter((r) => r.truth.confirmedFacts.price === undefined);
  must(noPrice.length > 0, 'fixture 里没有无价格场次，判据空转');
  const bad = noPrice.filter((r) => r.prices.length > 0);
  must(bad.length === 0, bad.slice(0, 5).map((r) => `${r.id}/${r.scenario}: ${summarize(r.prices, 2)}`).join(' | '));
});

/* ============================================================
 * §E 渠道合规
 * ========================================================== */

check('E1 ★公众号 HTML 可直接贴进微信后台（无 script/link/style/class + 图保比例）', () => {
  const bad: string[] = [];
  for (const r of wechatRuns) {
    const vs = wechatHtmlViolations(r.doc.html);
    if (vs.length) bad.push(`${r.id}: ${summarize(vs, 3)}`);
  }
  must(bad.length === 0, bad.slice(0, 5).join(' | '));
});

check('E2 公众号：title ≤ 30 字、titleOptions 非空、html 非空', () => {
  const bad: string[] = [];
  for (const r of wechatRuns) {
    if (String(r.doc.title || '').length === 0) bad.push(`${r.id}:no-title`);
    if (String(r.doc.title || '').length > 30) bad.push(`${r.id}:title-len=${String(r.doc.title).length}`);
    if (!Array.isArray(r.doc.titleOptions) || r.doc.titleOptions.length === 0) bad.push(`${r.id}:no-options`);
    if (String(r.doc.html || '').length < 200) bad.push(`${r.id}:html=${String(r.doc.html).length}`);
  }
  must(bad.length === 0, bad.slice(0, 6).join(' | '));
});

check('E3 小红书：hook/body 非空、tags 至少 2 个、imageSequence 与照片数匹配', () => {
  const bad: string[] = [];
  for (const r of xhsRuns) {
    if (!String(r.doc.hook || '').trim()) bad.push(`${r.id}:no-hook`);
    if (String(r.doc.body || '').length < 60) bad.push(`${r.id}:body=${String(r.doc.body).length}`);
    if (!Array.isArray(r.doc.tags) || r.doc.tags.length < 2) bad.push(`${r.id}:tags=${(r.doc.tags || []).length}`);
    const seq = Array.isArray(r.doc.imageSequence) ? r.doc.imageSequence.length : -1;
    if (seq > r.photoCount) bad.push(`${r.id}:seq=${seq}>${r.photoCount}`);
  }
  must(bad.length === 0, bad.slice(0, 6).join(' | '));
});

/* ============================================================
 * §F 回顾的诚实性
 * ========================================================== */

check('F1 ★回顾无现场素材 → 诚实空态（insight 为空、不拿计划冒充发生）', () => {
  const empties = recapRuns.filter((r) => !(r.extra && r.extra.emptyInsight === false));
  must(empties.length > 0, '没有空态场次，判据空转');
  const bad = empties.filter((r) => {
    const ins = r.doc.insight || {};
    return String(ins.coreMemory || '') !== '' || String(ins.whyItMatters || '') !== '';
  });
  must(bad.length === 0, bad.map((r) => `${r.id}:${fmt((r.doc.insight || {}).coreMemory).slice(0, 30)}`).join(' | '));
});

check('F2 ★回顾有现场素材 → 必须写素材里的事（coreMemory 命中 highlights/notes）', () => {
  const withActual = recapRuns.filter((r) => r.extra && r.extra.emptyInsight === false);
  must(withActual.length >= 5, `带素材场次=${withActual.length}`);
  const bad = withActual.filter((r) => {
    const ins = r.doc.insight || {};
    const cm = String(ins.coreMemory || '');
    return !cm || !['全员登顶', '山脊视野极好', '18 人全员完成，无一人下撤'].includes(cm);
  });
  must(bad.length === 0, bad.map((r) => `${r.id}:${fmt((r.doc.insight || {}).coreMemory).slice(0, 30)}`).join(' | '));
});

check('F3 回顾空态文案里不得出现「全员/登顶/都说好」这类未发生的断言', () => {
  const bad: string[] = [];
  for (const r of recapRuns) {
    if (!(r.extra && r.extra.emptyInsight !== false)) continue;
    const plain = stripHtml(r.doc.html);
    for (const w of ['全员', '所有人', '大家都', '都觉得很', '纷纷表示']) {
      if (plain.indexOf(w) >= 0) bad.push(`${r.id}:${w}`);
    }
  }
  must(bad.length === 0, bad.slice(0, 6).join(' | '));
});

/* ============================================================
 * §G 缺失事实识别
 * ========================================================== */

check('G1 ★缺失事实被识别（acc-03 缺价格 / acc-04 缺行程+缺集合点 → 交给确认卡）', () => {
  const a3 = detailRuns.filter((r) => r.id === 'acc-03')[0];
  const a4 = detailRuns.filter((r) => r.id === 'acc-04')[0];
  must(!!a3 && !!a4, 'acc-03/acc-04 未跑');
  const m3 = (a3.extra.missing || []) as string[];
  const m4 = (a4.extra.missing || []) as string[];
  must(m3.includes('price'), `acc-03 missing=${m3.join(',')}`);
  must(m4.includes('itinerary'), `acc-04 missing=${m4.join(',')}`);
  // meeting 两侧都要成立：真缺的必须报出来，有的不许误报。
  // 早先这条断言写成「有集合点也要求报缺」，是个不可能满足的判据（判据错，不是产品错）。
  must(
    a4.truth.confirmedFacts.meeting === undefined,
    `acc-04 不该有 meeting：${fmt(a4.truth.confirmedFacts.meeting)}`
  );
  must(m4.includes('meeting'), `acc-04 缺集合点未被识别：missing=${m4.join(',')}`);
  const a1 = detailRuns.filter((r) => r.id === 'acc-01')[0];
  const m1 = (a1.extra.missing || []) as string[];
  must(!m1.includes('meeting'), `acc-01 有集合点却被误报为缺：missing=${m1.join(',')}`);
});

/* ============================================================
 * §H 多样性（兜底线只做下限；真实多样性见线上跑批）
 * ========================================================== */

const dStats = diversityStats('detail', detailRuns.map((r) => r.doc));
const wStats = diversityStats('wechat', wechatRuns.map((r) => r.doc));
const xStats = diversityStats('xiaohongshu', xhsRuns.map((r) => r.doc));

check('H1 结构不被写死：30 场 detail 至少产出 3 种不同 block 序列（兜底也一样）', () => {
  must(dStats.uniqStructures >= 3, `uniqStructures=${dStats.uniqStructures}`);
});

check('H1b 公众号版式不写死：30 场 html 至少产出 2 种「标题/配图」骨架（度量本身也要立得住）', () => {
  must(wStats.uniqStructures >= 2, `uniqStructures=${wStats.uniqStructures}`);
});

check('H2 StyleVector 合法且有真实离散度（不是所有场次同一组数）', () => {
  const vecs = detailRuns.map((r) => (r.doc.direction || {}).styleVector).filter(Boolean);
  must(vecs.length === detailRuns.length, `缺向量 ${detailRuns.length - vecs.length} 场`);
  const keys = Object.keys(vecs[0]).filter((k) => typeof (vecs[0] as any)[k] === 'number');
  const bad = vecs.filter((v: any) => keys.some((k) => (v as any)[k] < 0 || (v as any)[k] > 1));
  must(bad.length === 0, `越界向量 ${bad.length} 个`);
  must(dStats.minStyleDist > 0, `存在完全相同的风格向量对（minDist=${dStats.minStyleDist}）`);
  must(dStats.meanStyleDist >= 0.05, `风格向量离散度过低（meanDist=${dStats.meanStyleDist}）`);
  // rhythm / whitespace 是公众号段距与行高的真实来源 —— 全是同一个值等于所有活动同一套排版
  const rhythms = new Set(vecs.map((v: any) => v.rhythm));
  const ws = new Set(vecs.map((v: any) => v.whitespace));
  must(rhythms.size >= 2, `30 场 rhythm 只有 ${rhythms.size} 种：${Array.from(rhythms).join(',')}`);
  must(ws.size >= 2, `30 场 whitespace 只有 ${ws.size} 种：${Array.from(ws).join(',')}`);
});

check('H3 主张不重复：30 场 thesis 唯一', () => {
  must(dStats.uniqTheses === 30, `uniqTheses=${dStats.uniqTheses}`);
});

/* ============================================================
 * §I 场景字段回填
 * ========================================================== */

check('I1 渠道文档 scenario / activityId 正确回填', () => {
  const bad: string[] = [];
  for (const r of runs) {
    if (r.doc.scenario !== r.scenario) bad.push(`${r.id}:${r.doc.scenario}≠${r.scenario}`);
    if (String(r.doc.activityId) !== r.id) bad.push(`${r.id}:activityId=${r.doc.activityId}`);
    if (r.doc.schemaVersion !== 3) bad.push(`${r.id}:schema=${r.doc.schemaVersion}`);
    if (!r.doc.generationMeta || !r.doc.generationMeta.workflowVersion) bad.push(`${r.id}:no-meta`);
  }
  must(bad.length === 0, bad.slice(0, 6).join(' | '));
});

/* ============================================================
 * §J 20 场线上跑批逼出来的三处真实缺陷（回归锁）
 *
 * 这三条都不是「风格意见」，是线上真实产出里的错：
 *   J1 指标说谎 —— 渠道场景没有改稿步骤，却把「像历史」写进 repairCount
 *   J2 编造数字从方向层溜进正文 —— 块级 groundClaims 管不到 direction.thesis
 *   J3 去重判据退化 —— 空 blocks 的结构相似度恒为 1，「一个样」检测不出来
 * ========================================================== */

check('J1 ★渠道 repairCount 不谎报：没有改稿步骤就必须是 0（撞车另记 repetitive）', () => {
  const bad: string[] = [];
  for (const r of runs) {
    if (r.scenario === 'detail') continue; // detail 真的会跑 repairDocument，次数由它给
    const meta = (r.doc.generationMeta || {}) as Record<string, unknown>;
    if (Number(meta.repairCount) !== 0) {
      bad.push(`${r.id}/${r.scenario}:repairCount=${meta.repairCount}（该场景没有改稿步骤）`);
    }
    if (typeof meta.repetitive !== 'boolean') {
      bad.push(`${r.id}/${r.scenario}:generationMeta.repetitive 缺失（撞车信号不能丢）`);
    }
  }
  must(bad.length === 0, bad.slice(0, 6).join(' | '));
});

check('J2 ★方向级事实闸门：thesis/angle 里出现事实池外数字的方向必须被拒收', () => {
  const fx = fixtures[0];
  const truth = truthOf(fx);
  const dist = String(truth.confirmedFacts.distance ?? '');
  const title = String(truth.confirmedFacts.title ?? '');
  const mk = (thesis: string, angle: string): unknown => ({
    id: 'probe',
    thesis,
    targetAudience: '',
    primaryMotivation: '',
    primaryBarrier: '',
    communicationAngle: angle,
    evidenceRefs: [],
    narrativeStrategy: [],
    styleVector: {},
    expectedVisualStrategy: '',
    rationale: '',
  });
  // 两侧都要能证伪：编造的必须拒、有据的必须留。
  // 只断言「被拒了」是不够的 —— 一个把所有方向都拒掉的实现也能通过那种断言。
  const kept = rejectUngroundedDirections(
    [
      mk('海拔 9999 米的雪线', '围绕着 8888 元档展开'),
      mk(`${title}：距 ${dist} 的一次出行`, '按事实讲清楚这一天'),
    ] as never,
    truth
  );
  must(kept.length === 1, `应只留下 1 条有据方向，实际留下 ${kept.length} 条`);
  must(kept[0].thesis.indexOf(title) >= 0, `留下的不是那条有据方向：${kept[0].thesis}`);
  must(dist !== '', '夹具 acc-01 本应有 distance 事实，否则 J2 退化成空断言');
});

check('J3 ★空结构不得被判为「完全一致」：无段落可比时 structure/visual 必须为 0', () => {
  const empty = buildCreativeFingerprint({ thesisText: 'x', openingMode: 'a', blocks: [] });
  const one = buildCreativeFingerprint({
    thesisText: 'y',
    openingMode: 'b',
    blocks: sectionsAsBlocks([{ purpose: '开场', images: 1, text: '一二三四五' }]),
  });
  const s = structureSimilarity(empty, empty);
  const v = visualSimilarity(empty, empty);
  const cross = structureSimilarity(empty, one);
  must(s === 0, `空 vs 空 structure=${s}（旧实现恒为 1，渠道文档去重因此形同虚设）`);
  must(v === 0, `空 vs 空 visual=${v}（同上）`);
  must(cross === 0, `空 vs 有结构 structure=${cross}（无证据不等于相似）`);
  // 反过来：两边都有结构时，判据必须真的能给出非零相似度，否则就是把指标改成恒 0
  const same = structureSimilarity(one, one);
  must(same > 0, `有结构 vs 自身 structure=${same}（判据被改哑了）`);
});

/* ============================================================
 * §K 第二次线上跑批（30 场真实 LLM）逼出来的两条
 *
 *   K1 兜底方向把「候选序号」写进了用户可见文案 —— 且 D2 的数字判据抓不住它
 *   K2 兜底在文档里不可观测 —— model 写着 platform-llm，实际一个 token 都没调
 * ========================================================== */

check('K1 ★用户可见文案不得含兜底脚手架（「第 N 个角度」「备用角度」）', () => {
  /*
   * 为什么必须用**文本判据**、不能只靠 D2 的数字判据：
   *   grounded 判据是「子串包含」—— 数字 n 只要被事实池里任一 token 包含就算有据。
   *   于是「第 1 个角度」的 1 常被日期里的「10 / 11」放过，
   *   整条缺陷能从数字判据底下走过去（线上只在兜底取到第 3 个候选时才炸，
   *   因为 3 恰好没被任何 token 包含）。脚手架话术必须直接点名。
   */
  const SCAFFOLD: RegExp[] = [
    /第\s*\d+\s*个角度/,
    /备用角度/,
    /候选\s*\d+\s*(?:号|个)/,
    /(?:方向|角度)\s*\d+\s*[:：]/,
  ];
  const leaked: string[] = [];
  for (const r of runs) {
    for (const t of r.texts) {
      for (const re of SCAFFOLD) {
        const m = re.exec(t.text);
        if (m) leaked.push(`${r.id}/${r.scenario}@${t.label}：${m[0]}`);
      }
    }
  }
  must(leaked.length === 0, `脚手架话术泄漏 ${leaked.length} 处 —— ${leaked.slice(0, 5).join(' | ')}`);
});

check('K2 ★兜底必须可观测：文档要自报 llmUsed，兜底时必须带 fallbackReason', () => {
  /*
   * 掉额度 / Key 失效时全线静默兜底：请求照样 200、文档照样生成、
   * model 还写着 platform-llm，运维侧几乎零信号。这里把「必须自报」钉死。
   */
  const bad: string[] = [];
  for (const r of runs) {
    const meta = (r.doc.generationMeta || {}) as Record<string, unknown>;
    if (typeof meta.llmUsed !== 'boolean') {
      bad.push(`${r.id}/${r.scenario}:generationMeta.llmUsed 缺失`);
      continue;
    }
    if (meta.llmUsed === false && !String(meta.fallbackReason ?? '').trim()) {
      bad.push(`${r.id}/${r.scenario}:llmUsed=false 却没写 fallbackReason（只知道兜底、不知道为什么）`);
    }
  }
  must(bad.length === 0, bad.slice(0, 6).join(' | '));
});

check('K3 ★前提校验：离线契约跑的是确定性兜底（否则「兜底线守住了」这句话是空的）', () => {
  /*
   * 这份契约的全部意义是「断言兜底路径的不变量」。
   * 如果某天离线环境突然能连上 LLM，跑的就全是 LLM 产出，
   * 于是它再也证明不了兜底线 —— 而失败不会有任何提示。
   * 无 Key 时 callJsonLlm 必抛（proxyChat → 积分/Key 检查），所以这里恒成立；
   * 真在带 Key 的环境跑，应当看到它以「前提不成立」失败，而不是假装通过。
   */
  const usedLlm = runs.filter((r) => (r.doc.generationMeta || {}).llmUsed === true).length;
  must(
    usedLlm === 0,
    `有 ${usedLlm} 篇真的走了 LLM —— 本契约必须在无 Key 环境下跑（它验的是兜底线）`
  );
});

/* ============================================================
 * 汇总
 * ========================================================== */

const timings = runs.map((r) => r.ms).sort((a, b) => a - b);
const p50 = timings[Math.floor(timings.length / 2)] || 0;
const p95 = timings[Math.floor(timings.length * 0.95)] || 0;

const weatherFindings = runs.filter((r) => r.weather.length > 0);

console.log(`\n  ── 指标 ──`);
console.log(`  detail  结构种类=${dStats.uniqStructures} 主张唯一=${dStats.uniqTheses}/${dStats.count} styleDist(min/mean)=${dStats.minStyleDist}/${dStats.meanStyleDist}`);
console.log(`  微信    结构种类=${wStats.uniqStructures} 主张唯一=${wStats.uniqTheses}/${wStats.count} thesisSim(max)=${wStats.maxThesisSim}`);
console.log(`  小红书  结构种类=${xStats.uniqStructures} 主张唯一=${xStats.uniqTheses}/${xStats.count}`);
console.log(`  单篇耗时 p50=${p50}ms p95=${p95}ms（离线兜底，无网络）`);
console.log(`  无据天气描写（软判据）: ${weatherFindings.length} 篇`);
console.log(`\n  ${passed}/${passed + failed} 通过\n`);

if (failed > 0) {
  console.log('  失败明细：');
  failures.forEach((f) => console.log('   - ' + f));
  console.log('');
  process.exitCode = 1;
}
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
