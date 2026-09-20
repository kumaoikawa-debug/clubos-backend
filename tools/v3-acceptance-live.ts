/**
 * Content Engine V3 —— Phase 6 验收 · 线上跑批（真实 LLM）
 *
 * 与离线契约的区别：离线跑的是「确定性兜底」，只证明兜底线守得住不变量；
 * 这里打真实后端，走 DeepSeek + Mastra 全链路，回答 Phase 6 真正要回答的两个问题：
 *   1) 真实 LLM 产出是否同样满足硬判据（禁用话术 / 编造数字 / 无价格不产价格 / 公众号 HTML 合规 / 回顾诚实）
 *   2) 连续 30 场会不会「长得一个样」—— 这是我们唯一的真问题，兜底线数据答不了
 *
 * 用法：
 *   npx tsx tools/v3-acceptance-live.ts
 *
 * 环境变量（都有默认值）：
 *   CLUBOS_BASE           后端地址          默认 https://clubos-backend-gald.onrender.com
 *   CLUBOS_ADMIN_CODE     管理端登录口令     默认取 .env 里的 ADMIN_CODE（无则报错退出）
 *   CLUBOS_MERCHANT_ID    俱乐部 ID          默认 1
 *   V3_LIVE_SCENARIOS     跑哪些场景         默认 detail,wesample,recap
 *   V3_LIVE_LIMIT         跑前 N 场          默认 30（0=全部）
 *   V3_LIVE_ONLY          只跑这些场次       默认空（逗号分隔，如 acc-03,acc-17）—— 用于「只补跑失败的那几场」
 *   V3_LIVE_RETRY         瞬时故障重试次数   默认 3（仅对 5xx / 网络错误 / 非 JSON 响应重试；4xx 不重试）
 *   V3_LIVE_PREFIX        活动 id 前缀       默认 p6-（便于识别/可重跑，不覆盖真实活动）
 *   V3_LIVE_OUT           输出 JSON 路径     默认 ./tmp/v3-acceptance-live.json
 *   V3_LIVE_HTML          输出 HTML 路径     默认 ./tmp/v3-acceptance-live.html
 *
 * 为什么 detail 跑满 30 场、渠道只抽样：
 *   多样性是「页面长得像不像」的问题，主战场是 detail 的 blocks + StyleVector。
 *   全场景 ×30 会变成 400+ 次 LLM 调用（几十分钟 + 无谓开销），不加信息量。
 */

import fs from 'fs';
import path from 'path';

import { buildFixture30, type Fixture } from './v3-fixture-30';
import { buildTruth, normalizeInput } from '../src/content-engine/steps/truth';
import type { ActivityTruth } from '../src/content-engine/contracts/activityTruth';
import {
  actualFactPool,
  bannedHits,
  docTexts,
  diversityStats,
  priceFabrication,
  structureSignature,
  stripHtml,
  unsupportedNumbers,
  weatherClaims,
  type DiversityStats,
  type Violation,
} from './v3-audit';

/* ============================================================
 * 环境
 * ========================================================== */

// truth.ts 会经 visionService 间接带出 prisma 客户端；不给 DATABASE_URL 会在构造时抛错。
// 本工具全程走 HTTP，不需要数据库 —— 塞个占位串即可（只影响 prisma 的懒连接报错噪音）。
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgresql://placeholder:placeholder@localhost:5432/placeholder';
}

const BASE = (process.env.CLUBOS_BASE || 'https://clubos-backend-gald.onrender.com').replace(/\/+$/, '');
const MERCHANT = process.env.CLUBOS_MERCHANT_ID || '1';
const PREFIX = process.env.V3_LIVE_PREFIX ?? 'p6-';
const LIMIT = Number(process.env.V3_LIVE_LIMIT ?? 30);
/** 「只补跑失败的那几场」：逗号分隔的 fixture id（acc-03,acc-17） */
const ONLY = (process.env.V3_LIVE_ONLY || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
/** 瞬时故障重试次数 —— 免费实例会重启（部署/冷启动），长跑批没有重试会把网关抖动记成产品失败 */
const RETRY = Number(process.env.V3_LIVE_RETRY ?? 3);
const OUT_JSON = process.env.V3_LIVE_OUT || path.join(process.cwd(), 'tmp', 'v3-acceptance-live.json');
const OUT_HTML = process.env.V3_LIVE_HTML || path.join(process.cwd(), 'tmp', 'v3-acceptance-live.html');

/** 渠道抽样：detail 全量，渠道只在前 N 场跑（含 recap 的现场素材子集）。
    用 V3_LIVE_ONLY 补跑时默认不跑渠道 —— 补跑通常只为把失败那几场的 detail 补齐。 */
const SAMPLE = Number(process.env.V3_LIVE_SAMPLE ?? (ONLY.length ? 0 : 6));
const WITH_ACTUAL = ['acc-01', 'acc-02', 'acc-09', 'acc-16', 'acc-23', 'acc-30'];

function adminCode(): string {
  const fromEnv = process.env.CLUBOS_ADMIN_CODE || process.env.ADMIN_CODE;
  if (fromEnv) return fromEnv;
  const envFile = path.join(process.cwd(), '.env');
  if (fs.existsSync(envFile)) {
    const m = fs.readFileSync(envFile, 'utf8').match(/^ADMIN_CODE\s*=\s*(.+)$/m);
    if (m) return m[1].trim();
  }
  throw new Error('缺少 ADMIN_CODE：请设 CLUBOS_ADMIN_CODE 或写入 .env');
}

/* ============================================================
 * HTTP
 * ========================================================== */

async function login(): Promise<string> {
  const r = await fetch(`${BASE}/api/pay/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: adminCode(), merchant_id: MERCHANT }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`登录失败 HTTP ${r.status}：${text.slice(0, 200)}`);
  const j = JSON.parse(text) as { data?: { token?: string } };
  const token = j.data?.token;
  if (!token) throw new Error(`登录响应里没有 token：${text.slice(0, 200)}`);
  return token;
}

interface GenOutcome {
  ok: boolean;
  ms: number;
  doc: any;
  extra: any;
  error: string;
  httpStatus: number;
}

/**
 * 回顾的现场素材：既用于发请求，也用作「有据数字」的事实池（响应不回显它）。
 *
 * ★ 必须**逐场不同**。原先 6 场回顾共用同一份素材（同样的 highlights），
 *   而 recap 的 coreMemory 就是 highlights[0] —— 于是 6 场的「核心记忆」
 *   是同一个字符串，文案相似度天然 100%，报告里读出「回顾 6/6 全部重复」；
 *   段落结构也全是 sec3|slots111，看起来像「所有回顾都一个样」。
 *   那是夹具造成的假信号：夹具不能替引擎背锅，也不能给引擎放假。
 */
const ACTUALS: Record<string, Record<string, unknown>> = {
  'acc-01': {
    attendance: 18,
    weather: '晴，山脊有风',
    highlights: ['12:30 全队登顶白云嶂', '山脊云海比预期好'],
    feedbacks: ['下坡比想象中费腿'],
    onSiteNotes: ['18 人全员完成，无一人下撤'],
  },
  'acc-02': {
    attendance: 10,
    weather: '晴，午后有阵雪',
    highlights: ['凌晨 4 点出发，10 人全队登顶大峰', '在大本营的第一晚几乎没睡着'],
    feedbacks: ['海拔适应那两天最难熬'],
    onSiteNotes: ['实到 10 人，1 人因高反留在大本营'],
  },
  'acc-09': {
    attendance: 15,
    weather: '多云，溪水偏凉',
    highlights: ['孩子们自己认出了三种溪流昆虫', '最小的 4 岁全程自己走完'],
    feedbacks: ['孩子回家还在讲溪里的小鱼'],
    onSiteNotes: ['15 人（含 8 名儿童）完成全程'],
  },
  'acc-16': {
    attendance: 46,
    weather: '阴，起跑时 12 度',
    highlights: ['46 人全部在关门时间内完赛', '最后 5 公里碎石坡最磨人'],
    feedbacks: ['补给点的热姜茶救了命'],
    onSiteNotes: ['实到 46 人，2 人中途退赛'],
  },
  'acc-23': {
    attendance: 22,
    weather: '晴，骑楼下有荫',
    highlights: ['讲解员带大家认出了三处民国骑楼', '糖水铺老板多送了一碗'],
    feedbacks: ['原来走了十几年的街还有这些故事'],
    onSiteNotes: ['实到 22 人，走完全程 4 公里'],
  },
  'acc-30': {
    attendance: 9,
    weather: '沙漠段晴、洞穴段阴冷',
    highlights: ['9 人在沙漠里走完了 3 天', '第 5 天完成 30 米绳索下降'],
    feedbacks: ['洞穴里那段安静得能听见自己心跳'],
    onSiteNotes: ['实到 9 人，全员完成洞穴下降'],
  },
};

/** 没有专属素材的场次给一份通用素材（同样不能与方案原文混同） */
function actualFor(fx: Fixture): Record<string, unknown> {
  return (
    ACTUALS[fx.id] ?? {
      attendance: 12,
      weather: '晴',
      highlights: ['按计划走完全程'],
      feedbacks: ['节奏比预想稳'],
      onSiteNotes: ['实到 12 人，无中途下撤'],
    }
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 只有「大概率跟内容无关」的失败才重试：网络异常 / 5xx / 非 JSON（Render 网关的 HTML 错误页）。
    4xx 一律不重试 —— 401 是鉴权真错、400 是入参真错，重试只会掩盖问题。 */
function isTransient(o: GenOutcome): boolean {
  if (o.ok) return false;
  if (o.httpStatus === 0) return true;
  if (o.httpStatus >= 500) return true;
  return /^非 JSON 响应/.test(o.error);
}

async function generateOnce(
  token: string,
  scenario: string,
  body: Record<string, unknown>
): Promise<GenOutcome> {
  const t0 = Date.now();
  try {
    const r = await fetch(`${BASE}/api/content/${scenario}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    const ms = Date.now() - t0;
    let j: any = null;
    try {
      j = JSON.parse(text);
    } catch {
      return { ok: false, ms, doc: null, extra: null, httpStatus: r.status, error: `非 JSON 响应：${text.slice(0, 120)}` };
    }
    if (!r.ok || j.code !== 0) {
      return { ok: false, ms, doc: null, extra: null, httpStatus: r.status, error: `${r.status} ${j.message || ''}` };
    }
    const d = j.data || {};
    return { ok: true, ms, doc: d.document ?? d, extra: d, error: '', httpStatus: r.status };
  } catch (e) {
    return {
      ok: false,
      ms: Date.now() - t0,
      doc: null,
      extra: null,
      httpStatus: 0,
      error: String((e as Error)?.message || e),
    };
  }
}

async function generate(
  token: string,
  scenario: string,
  activityId: string,
  fx: Fixture,
  withActual: boolean
): Promise<GenOutcome> {
  const body: Record<string, unknown> = {
    activityId,
    activity: fx.activity,
    planFacts: fx.planFacts,
    materialText: fx.materialText,
    photos: fx.photos,
  };
  if (scenario === 'recap') {
    body.actual = withActual ? actualFor(fx) : {};
  }

  let out = await generateOnce(token, scenario, body);
  let attempt = 1;
  while (isTransient(out) && attempt < RETRY) {
    const wait = 4000 * attempt;
    console.log(`      ↻ 瞬时失败（${out.error.slice(0, 60)}），${wait}ms 后重试 ${attempt}/${RETRY - 1}`);
    await sleep(wait);
    out = await generateOnce(token, scenario, body);
    attempt++;
  }
  return out;
}

/* ============================================================
 * 逐场结果
 * ========================================================== */

interface RunRec {
  id: string;
  fixtureId: string;
  tag: string;
  scenario: string;
  ok: boolean;
  ms: number;
  error: string;
  doc: any;
  directionId: string;
  thesis: string;
  structure: string;
  model: string;
  repairCount: number;
  texts: ReturnType<typeof docTexts>;
  banned: Violation[];
  numbers: Violation[];
  prices: Violation[];
  weather: Violation[];
  /** 该场用的是真实 LLM 还是确定性兜底 */
  usedLlm: boolean;
  /** 后端回传的 truth 与本工具复算的 truth 不一致的字段（前后端事实漂移探针） */
  truthDrift: string[];
}

function isFallbackDirection(id: unknown): boolean {
  return /^dir-fallback/.test(String(id ?? ''));
}

/** 与离线契约同一入口 —— 审计的「事实池」必须用生产代码算，不能自己另写一套 */
function truthOf(fx: Fixture): ActivityTruth {
  return buildTruth(
    normalizeInput({
      activityId: fx.id,
      merchantId: MERCHANT,
      activity: fx.activity,
      planFacts: fx.planFacts,
      materialText: fx.materialText,
      photos: fx.photos,
    })
  );
}

/** 探针：后端算出的 truth 应与我们本地复算的一致（不一致 = 前后端事实漂移，历史踩过） */
function truthDriftOf(serverTruth: any, localTruth: ActivityTruth): string[] {
  if (!serverTruth || typeof serverTruth !== 'object') return [];
  const sf = serverTruth.confirmedFacts || {};
  const lf = localTruth.confirmedFacts;
  const drift: string[] = [];
  const cmp = (k: keyof typeof lf) => {
    const a = sf[k as string] === undefined ? undefined : String(sf[k as string]);
    const b = lf[k] === undefined ? undefined : String(lf[k]);
    if (a !== b) drift.push(`${String(k)}: 后端=${a} 本地=${b}`);
  };
  (['date', 'place', 'meeting', 'price', 'limit', 'difficulty', 'days'] as const).forEach(cmp);
  return drift;
}

/* ============================================================
 * 主流程
 * ========================================================== */

async function main() {
  const all = buildFixture30();
  const known = new Set(all.map((f) => f.id));
  const unknown = ONLY.filter((id) => !known.has(id));
  if (unknown.length) throw new Error(`V3_LIVE_ONLY 里有未知场次：${unknown.join(',')}`);
  const picked = ONLY.length ? all.filter((f) => ONLY.includes(f.id)) : all;
  const fixtures = picked.slice(0, LIMIT > 0 ? LIMIT : undefined);
  const token = await login();
  console.log(
    `已登录 ${BASE}（merchant=${MERCHANT}），矩阵 ${fixtures.length} 场` +
      (ONLY.length ? `（补跑：${ONLY.join(',')}）` : '') +
      `，渠道抽样 ${Math.min(SAMPLE, fixtures.length)} 场，重试 ${RETRY}\n`
  );

  const runs: RunRec[] = [];

  for (let i = 0; i < fixtures.length; i++) {
    const fx = fixtures[i];
    const activityId = `${PREFIX}${fx.id}`;

    // detail 全量
    const out = await generate(token, 'detail', activityId, fx, false);
    push(runs, fx, 'detail', activityId, out, null);
    const dirId = out.ok ? String(out.doc?.direction?.id ?? '') : '-';
    console.log(
      `[${String(i + 1).padStart(2)}/${fixtures.length}] ${fx.id} detail ` +
        `${out.ok ? 'ok' : 'FAIL'} ${out.ms}ms dir=${dirId}${out.ok ? '' : ' :: ' + out.error}`
    );

    // 渠道抽样：前 SAMPLE 场跑公众号/小红书；带现场素材的场跑回顾
    if (i < SAMPLE) {
      for (const sc of ['wechat', 'xiaohongshu'] as const) {
        const o2 = await generate(token, sc, activityId, fx, false);
        push(runs, fx, sc, activityId, o2, null);
        console.log(`      ${fx.id} ${sc} ${o2.ok ? 'ok' : 'FAIL'} ${o2.ms}ms${o2.ok ? '' : ' :: ' + o2.error}`);
      }
    }
    if (WITH_ACTUAL.includes(fx.id)) {
      for (const withActual of [true, false]) {
        const o3 = await generate(token, 'recap', activityId, fx, withActual);
        push(runs, fx, 'recap', activityId, o3, withActual ? actualFor(fx) : {});
        console.log(
          `      ${fx.id} recap(${withActual ? '有素材' : '空态'}) ${o3.ok ? 'ok' : 'FAIL'} ${o3.ms}ms${
            o3.ok ? '' : ' :: ' + o3.error
          }`
        );
      }
    }
  }

  report(runs, fixtures);
  writeArtifacts(runs, fixtures);
}

function push(
  runs: RunRec[],
  fx: Fixture,
  scenario: string,
  activityId: string,
  out: GenOutcome,
  sentActual: Record<string, unknown> | null
) {
  const doc = out.doc;
  const truth = truthOf(fx);
  const texts = doc ? docTexts(scenario, doc) : [];
  // 回顾：运营当场填的现场素材数字（实到 18 人…）同样算「有据」。
  // ★ 用「发出去的那份」而不是响应里的 —— 后端不回显 actual。
  const extraFacts =
    scenario === 'recap' && sentActual && Object.keys(sentActual).length ? actualFactPool(sentActual) : [];
  const dirId = String(doc?.direction?.id ?? '');
  runs.push({
    id: activityId,
    fixtureId: fx.id,
    tag: fx.tag,
    scenario,
    ok: out.ok,
    ms: out.ms,
    error: out.error,
    doc,
    directionId: dirId,
    thesis: String(doc?.direction?.thesis ?? ''),
    structure: doc ? structureSignature(scenario, doc) : '',
    model: String(doc?.generationMeta?.model ?? ''),
    repairCount: Number(doc?.generationMeta?.repairCount ?? 0) || 0,
    texts,
    banned: doc ? bannedHits(texts) : [],
    numbers: doc ? unsupportedNumbers(texts, truth, extraFacts) : [],
    prices: doc ? priceFabrication(texts, truth) : [],
    weather: doc ? weatherClaims(texts, truth) : [],
    usedLlm: !!doc && !isFallbackDirection(dirId),
    truthDrift: truthDriftOf(out.extra?.truth, truth),
  });
}

/* ============================================================
 * 汇总
 * ========================================================== */

interface Report {
  generatedAt: string;
  base: string;
  merchant: string;
  counts: Record<string, number>;
  failures: string[];
  llm: { detailRuns: number; usedLlm: number; fallback: number; fallbackRate: number };
  diversity: Record<string, DiversityStats>;
  repairs: Record<string, number>;
  /** 被判「与同渠道历史高度重复」的场次（与 repairs 分开：撞车 ≠ 改过稿） */
  repetitive: Record<string, number>;
  timings: { p50: number; p95: number };
}

function summarize(vs: Violation[], limit = 6): string {
  return (
    vs
      .slice(0, limit)
      .map((v) => `${v.kind}@${v.label}:${v.detail}`)
      .join(' | ') + (vs.length > limit ? ` …(+${vs.length - limit})` : '')
  );
}

function byScenario(runs: RunRec[], sc: string) {
  return runs.filter((r) => r.scenario === sc);
}

function report(runs: RunRec[], fixtures: Fixture[]) {
  const scenarios = Array.from(new Set(runs.map((r) => r.scenario)));
  const failures: string[] = [];
  const counts: Record<string, number> = {};

  const check = (name: string, bad: RunRec[], detail?: string) => {
    const pass = bad.length === 0;
    counts[name] = pass ? 1 : 0;
    console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${pass ? '' : ' :: ' + (detail || bad.slice(0, 4).map((b) => b.id).join(','))}`);
    if (!pass) failures.push(`${name} :: ${detail || bad.slice(0, 4).map((b) => b.id).join(',')}`);
  };

  console.log('\n── 硬判据（线上真实产出） ──');
  check('R1 全部请求成功（无 5xx / 无超时）', runs.filter((r) => !r.ok), runs.filter((r) => !r.ok).slice(0, 3).map((r) => `${r.id}/${r.scenario}:${r.error}`).join(' | '));
  check('R2 禁用话术零泄漏', runs.filter((r) => r.banned.length > 0), runs.filter((r) => r.banned.length > 0).slice(0, 3).map((r) => `${r.id}/${r.scenario}:${summarize(r.banned, 2)}`).join(' | '));
  const detailRuns = byScenario(runs, 'detail');
  check(
    'R3 detail：schemaVersion=3 / blocks≥3 / block id 唯一',
    detailRuns.filter((r) => {
      const b = r.doc.blocks || [];
      const ids = new Set(b.map((x: any) => x.id));
      return r.doc.schemaVersion !== 3 || b.length < 3 || ids.size !== b.length;
    })
  );
  check('R4 无价格活动不得凭空出现价格', runs.filter((r) => r.prices.length > 0), runs.filter((r) => r.prices.length > 0).slice(0, 3).map((r) => `${r.id}/${r.scenario}:${summarize(r.prices, 1)}`).join(' | '));
  check(
    'R4b 编造数字零容忍（文案里的数字必须能回溯到事实池）',
    runs.filter((r) => r.numbers.length > 0),
    runs.filter((r) => r.numbers.length > 0).slice(0, 3).map((r) => `${r.id}/${r.scenario}:${summarize(r.numbers, 3)}`).join(' | ')
  );
  check(
    'R4c 前后端事实一致（date/place/meeting/price/limit/difficulty/days）',
    runs.filter((r) => r.truthDrift.length > 0),
    runs.filter((r) => r.truthDrift.length > 0).slice(0, 3).map((r) => `${r.id}:${r.truthDrift.join(';')}`).join(' | ')
  );

  const wechat = byScenario(runs, 'wechat');
  check(
    'R5 公众号 HTML 可直接贴进微信后台（无 script/link/style/class）',
    wechat.filter((r) => {
      const h = String(r.doc.html || '');
      return /<script[\s>]/i.test(h) || /<link[\s>]/i.test(h) || /<style[\s>]/i.test(h) || /\sclass\s*=/i.test(h);
    })
  );
  check(
    'R6 公众号 HTML 有图则保比例',
    wechat.filter((r) => {
      const h = String(r.doc.html || '');
      return /<img[\s>]/i.test(h) && !/height\s*:\s*auto/i.test(h);
    })
  );

  const recap = byScenario(runs, 'recap');
  const empties = recap.filter((r) => r.extra && r.extra.emptyInsight !== false);
  check(
    'R7 回顾空态不编造（insight 为空 + 无「全员/都说好」类断言）',
    empties.filter((r) => {
      const ins = r.doc.insight || {};
      const plain = stripHtml(r.doc.html);
      return (
        String(ins.coreMemory || '') !== '' ||
        ['全员', '所有人', '都觉得很', '纷纷表示'].some((w) => plain.indexOf(w) >= 0)
      );
    }),
    `空态场次=${empties.length}`
  );

  /* 多样性 */
  const dStats = diversityStats('detail', detailRuns.map((r) => r.doc));
  const wStats = diversityStats('wechat', wechat.map((r) => r.doc));
  const xStats = diversityStats('xiaohongshu', byScenario(runs, 'xiaohongshu').map((r) => r.doc));

  const usedLlm = detailRuns.filter((r) => r.usedLlm).length;
  const fallback = detailRuns.length - usedLlm;

  const repairs: Record<string, number> = {};
  const repetitive: Record<string, number> = {};
  for (const sc of scenarios) {
    const list = byScenario(runs, sc);
    repairs[sc] = list.reduce((n, r) => n + (r.repairCount > 0 ? 1 : 0), 0);
    // 「像历史」不等于「改过一次」：只有 detail 真的有改稿步骤，
    // 公众号/小红书/回顾当前只记录是否撞车（generationMeta.repetitive）。
    repetitive[sc] = list.reduce((n, r) => n + (r.doc?.generationMeta?.repetitive ? 1 : 0), 0);
  }

  const timings = runs.map((r) => r.ms).sort((a, b) => a - b);
  const p50 = timings[Math.floor(timings.length / 2)] || 0;
  const p95 = timings[Math.floor(timings.length * 0.95)] || 0;

  console.log('\n── 多样性矩阵（真实 LLM） ──');
  console.log(`  detail  ${dStats.count} 场 | 结构 ${dStats.uniqStructures} 种 | thesis 唯一 ${dStats.uniqTheses}/${dStats.count} | maxSim=${dStats.maxThesisSim} | 近5场maxSim=${dStats.maxRecentThesisSim} | styleDist min/mean=${dStats.minStyleDist}/${dStats.meanStyleDist}`);
  if (wechat.length) console.log(`  公众号  ${wStats.count} 场 | 版式骨架 ${wStats.uniqStructures} 种 | maxSim=${wStats.maxThesisSim} | styleDist mean=${wStats.meanStyleDist}`);
  if (xStats.count) console.log(`  小红书  ${xStats.count} 场 | 版式 ${xStats.uniqStructures} 种 | maxSim=${xStats.maxThesisSim}`);

  console.log('\n── 链路 ──');
  console.log(`  detail 走真实 LLM：${usedLlm}/${detailRuns.length}（兜底 ${fallback}，兜底率 ${((fallback / Math.max(1, detailRuns.length)) * 100).toFixed(1)}%）`);
  console.log(`  触发 repair 的场次（只有 detail 会真的改稿）：${JSON.stringify(repairs)}`);
  console.log(`  被判「与历史撞车」的场次：${JSON.stringify(repetitive)}`);
  console.log(`  单次请求 p50=${p50}ms p95=${p95}ms`);

  const rep: Report = {
    generatedAt: new Date().toISOString(),
    base: BASE,
    merchant: MERCHANT,
    counts,
    failures,
    llm: { detailRuns: detailRuns.length, usedLlm, fallback, fallbackRate: fallback / Math.max(1, detailRuns.length) },
    diversity: { detail: dStats, wechat: wStats, xiaohongshu: xStats },
    repairs,
    repetitive,
    timings: { p50, p95 },
  };
  (globalThis as any).__V3_REPORT__ = rep;
}

/* ============================================================
 * 产物
 * ========================================================== */

function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function writeArtifacts(runs: RunRec[], fixtures: Fixture[]) {
  const rep = (globalThis as any).__V3_REPORT__ as Report;
  const dir = path.dirname(OUT_JSON);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(
    OUT_JSON,
    JSON.stringify(
      {
        report: rep,
        runs: runs.map((r) => ({
          id: r.id,
          fixtureId: r.fixtureId,
          tag: r.tag,
          scenario: r.scenario,
          ok: r.ok,
          ms: r.ms,
          error: r.error,
          directionId: r.directionId,
          thesis: r.thesis,
          structure: r.structure,
          model: r.model,
          repairCount: r.repairCount,
          usedLlm: r.usedLlm,
          truthDrift: r.truthDrift,
          banned: r.banned,
          numbers: r.numbers,
          prices: r.prices,
          bannedCount: r.banned.length,
          unsupportedCount: r.numbers.length,
        })),
      },
      null,
      2
    ),
    'utf8'
  );

  const checkNames = Object.keys(rep.counts);
  const passCount = checkNames.filter((n) => rep.counts[n] === 1).length;

  const rows = runs
    .map(
      (r) =>
        `<tr class="${r.ok ? '' : 'bad'}">
      <td>${esc(r.fixtureId)}</td><td>${esc(r.tag)}</td><td>${esc(r.scenario)}</td>
      <td>${r.ok ? 'ok' : 'FAIL'}</td><td>${r.ms}ms</td>
      <td>${esc(r.directionId)}</td>
      <td class="mono">${esc(r.structure).slice(0, 70)}</td>
      <td>${r.usedLlm ? 'LLM' : '兜底'}</td>
      <td>${r.repairCount}</td>
      <td>${r.banned.length + r.numbers.length + r.prices.length}</td>
      <td class="thesis">${esc(r.thesis).slice(0, 60)}</td>
    </tr>`
    )
    .join('\n');

  const checkRows = checkNames
    .map((n) => `<li class="${rep.counts[n] === 1 ? 'ok' : 'ng'}">${rep.counts[n] === 1 ? '✅' : '❌'} ${esc(n)}</li>`)
    .join('\n');

  const detailRows = runs
    .filter((r) => r.scenario === 'detail')
    .map((r) => `<tr><td>${esc(r.fixtureId)}</td><td>${esc(r.structure)}</td><td>${esc(r.directionId)}</td></tr>`)
    .join('\n');

  const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"/>
<title>ClubOS Content Engine V3 · Phase 6 验收报告</title>
<style>
 :root{--bg:#f7f7f5;--card:#fff;--ink:#1c1f1d;--muted:#6b7370;--line:#e4e6e3;--ok:#1f7a4d;--ng:#b5341f;--accent:#2b4d7a}
 *{box-sizing:border-box}
 body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.65 -apple-system,"PingFang SC","Helvetica Neue",sans-serif}
 .wrap{max-width:1080px;margin:0 auto;padding:40px 22px 80px}
 h1{font-size:26px;margin:0 0 6px;letter-spacing:.2px}
 .sub{color:var(--muted);font-size:13px;margin-bottom:26px}
 .badge{display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600;margin-right:8px}
 .badge.ok{background:#e6f4ec;color:var(--ok)} .badge.ng{background:#fbe9e5;color:var(--ng)}
 .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;margin:18px 0 26px}
 .kpi{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
 .kpi b{display:block;font-size:23px;letter-spacing:.3px}
 .kpi span{color:var(--muted);font-size:12px}
 section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px 22px;margin-bottom:18px}
 h2{font-size:16px;margin:0 0 12px;padding-bottom:10px;border-bottom:1px solid var(--line)}
 ul.checks{list-style:none;padding:0;margin:0}
 ul.checks li{padding:7px 0;border-bottom:1px dashed var(--line)}
 ul.checks li:last-child{border-bottom:0}
 table{width:100%;border-collapse:collapse;font-size:12.5px}
 th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
 th{color:var(--muted);font-weight:600;white-space:nowrap}
 tr.bad{background:#fff6f4}
 .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;color:var(--muted)}
 .thesis{color:var(--muted)}
 .note{color:var(--muted);font-size:12.5px;margin-top:10px}
 .scroll{max-height:520px;overflow:auto;border:1px solid var(--line);border-radius:8px}
</style></head>
<body><div class="wrap">
<h1>ClubOS Content Engine V3 · Phase 6 验收报告</h1>
<div class="sub">
  生成于 ${esc(rep.generatedAt)} · 后端 <code>${esc(rep.base)}</code> · 俱乐部 ${esc(rep.merchant)} · 共 ${runs.length} 次生成
</div>

<div class="grid">
  <div class="kpi"><b>${detailRows ? runs.filter((r) => r.scenario === 'detail').length : 0}</b><span>detail 场次</span></div>
  <div class="kpi"><b>${rep.diversity.detail.uniqStructures}</b><span>detail 版式种类</span></div>
  <div class="kpi"><b>${rep.diversity.detail.uniqTheses}/${rep.diversity.detail.count}</b><span>主张唯一</span></div>
  <div class="kpi"><b>${(rep.llm.fallbackRate * 100).toFixed(0)}%</b><span>兜底率</span></div>
  <div class="kpi"><b>${rep.timings.p95}ms</b><span>p95 单次耗时</span></div>
</div>

<section>
  <h2>硬判据（线上真实产出）</h2>
  <div class="badge ${passCount === checkNames.length ? 'ok' : 'ng'}">${passCount}/${checkNames.length} 通过</div>
  <ul class="checks">${checkRows}</ul>
  ${rep.failures.length ? '<div class="note">失败明细：<br/>' + rep.failures.map(esc).join('<br/>') + '</div>' : ''}
</section>

<section>
  <h2>多样性矩阵</h2>
  <table><tr><th>场景</th><th>场次</th><th>版式种类</th><th>thesis 唯一</th><th>两两最大相似</th><th>近 5 场最大相似</th><th>StyleVector 距离 min/mean</th></tr>
  <tr><td>detail</td><td>${rep.diversity.detail.count}</td><td>${rep.diversity.detail.uniqStructures}</td><td>${rep.diversity.detail.uniqTheses}</td><td>${rep.diversity.detail.maxThesisSim}</td><td>${rep.diversity.detail.maxRecentThesisSim}</td><td>${rep.diversity.detail.minStyleDist} / ${rep.diversity.detail.meanStyleDist}</td></tr>
  <tr><td>公众号</td><td>${rep.diversity.wechat.count}</td><td>${rep.diversity.wechat.uniqStructures}</td><td>${rep.diversity.wechat.uniqTheses}</td><td>${rep.diversity.wechat.maxThesisSim}</td><td>${rep.diversity.wechat.maxRecentThesisSim}</td><td>${rep.diversity.wechat.minStyleDist} / ${rep.diversity.wechat.meanStyleDist}</td></tr>
  <tr><td>小红书</td><td>${rep.diversity.xiaohongshu.count}</td><td>${rep.diversity.xiaohongshu.uniqStructures}</td><td>${rep.diversity.xiaohongshu.uniqTheses}</td><td>${rep.diversity.xiaohongshu.maxThesisSim}</td><td>${rep.diversity.xiaohongshu.maxRecentThesisSim}</td><td>${rep.diversity.xiaohongshu.minStyleDist} / ${rep.diversity.xiaohongshu.meanStyleDist}</td></tr>
  </table>
  <div class="note">
    近 5 场最大相似度是跨场次去重真正关心的量：连续发五场，最像的那一对有多像。<br/>
    触发 repair 的场次（只有 detail 会真的改稿）：${esc(JSON.stringify(rep.repairs))}
    <br/>被判「与历史撞车」的场次：${esc(JSON.stringify(rep.repetitive))}
  </div>
</section>

<section>
  <h2>detail 结构（版式签名）</h2>
  <div class="scroll"><table><tr><th>场次</th><th>block 序列</th><th>direction.id</th></tr>${detailRows}</table></div>
</section>

<section>
  <h2>逐场明细</h2>
  <div class="scroll">
  <table>
    <tr><th>场次</th><th>边界</th><th>场景</th><th>状态</th><th>耗时</th><th>direction</th><th>版式签名</th><th>产出源</th><th>repair</th><th>违规</th><th>主张</th></tr>
    ${rows}
  </table>
  </div>
</section>

<div class="note">
  原始数据：<code>${esc(OUT_JSON)}</code>
</div>
</div></body></html>`;

  fs.writeFileSync(OUT_HTML, html, 'utf8');
  console.log(`\n已写出：\n  JSON ${OUT_JSON}\n  HTML ${OUT_HTML}\n`);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
