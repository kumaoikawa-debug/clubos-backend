/**
 * Content Engine V3 —— Phase 6 验收 · 审计工具
 *
 * 离线契约与线上跑批共用。判据尽量**复用生产代码里的定义**（allowedFactTokens /
 * styleVectorDistance / copySimilarity），否则「审计通过」和「引擎真的这么判」是两件事。
 *
 * 硬判据（不达标就是缺陷）：
 *   - 禁用话术零泄漏
 *   - 文案里的数字必须能在事实池里找到（不得编造价格/里程/天数/人名）
 *   - 无价格活动不得出现任何价格
 *   - 公众号 HTML 必须能直接贴进微信后台（无 script / link / style 标签 / class）
 *   - 回顾无现场素材时必须诚实（不得拿计划冒充发生过）
 * 软判据（报告里给结论，不当场判死）：
 *   - 无据天气/景观描写
 *   - 30 场之间的调性/结构/主张是否雷同
 */

import { BANNED_PHRASES, allowedFactTokens } from '../src/content-engine/steps/quality';
import { copySimilarity } from '../src/content-engine/steps/quality';
import { styleVectorDistance, type StyleVector } from '../src/content-engine/contracts/creativeDirection';
import type { ActivityTruth } from '../src/content-engine/contracts/activityTruth';

export interface TextItem {
  label: string;
  text: string;
}

/* ============================================================
 * 文本提取
 * ========================================================== */

const TAG_RE = /<[^>]*>/g;

/** 去掉 script/style 整块 + 所有标签 + 样式属性残留 —— 只留下人真正读到的字 */
export function stripHtml(html: unknown): string {
  let s = String(html ?? '');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(TAG_RE, ' ');
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  return s.replace(/\s{2,}/g, ' ').trim();
}

function objTexts(prefix: string, obj: Record<string, unknown> | undefined, keys: string[]): TextItem[] {
  const out: TextItem[] = [];
  if (!obj) return out;
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      v.forEach(function (x, i) {
        if (x === undefined || x === null) return;
        out.push({ label: `${prefix}.${k}[${i}]`, text: String(x) });
      });
    } else {
      out.push({ label: `${prefix}.${k}`, text: String(v) });
    }
  }
  return out;
}

export interface DocLike {
  scenario?: string;
  [k: string]: unknown;
}

/** 按 scenario 抽取「用户会读到的全部文本」+ 少量内部字段（thesis 等） */
export function docTexts(scenario: string, doc: DocLike): TextItem[] {
  const out: TextItem[] = [];
  const d = doc || ({} as DocLike);
  const dir = (d.direction as Record<string, unknown>) || {};
  out.push({ label: 'direction.thesis', text: String(dir.thesis ?? '') });
  out.push({ label: 'direction.angle', text: String(dir.communicationAngle ?? '') });
  if (dir.targetAudience) out.push({ label: 'direction.audience', text: String(dir.targetAudience) });

  if (scenario === 'detail') {
    const blocks = Array.isArray(d.blocks) ? (d.blocks as Record<string, unknown>[]) : [];
    blocks.forEach(function (b, i) {
      out.push(...objTexts(`block[${i}]:${String(b.type)}`, b.copy as Record<string, unknown>, [
        'headline',
        'body',
        'caption',
      ]));
    });
  } else if (scenario === 'wechat') {
    out.push({ label: 'title', text: String(d.title ?? '') });
    out.push({ label: 'digest', text: String(d.digest ?? '') });
    if (Array.isArray(d.titleOptions)) out.push({ label: 'titleOptions', text: (d.titleOptions as unknown[]).join(' / ') });
    out.push({ label: 'html(plain)', text: stripHtml(d.html) });
  } else if (scenario === 'xiaohongshu') {
    out.push({ label: 'hook', text: String(d.hook ?? '') });
    out.push({ label: 'mainAngle', text: String(d.mainAngle ?? '') });
    out.push({ label: 'body', text: String(d.body ?? '') });
    out.push({ label: 'cta', text: String(d.cta ?? '') });
    if (Array.isArray(d.tags)) out.push({ label: 'tags', text: (d.tags as unknown[]).join(' ') });
    if (Array.isArray(d.titleOptions)) out.push({ label: 'titleOptions', text: (d.titleOptions as unknown[]).join(' / ') });
  } else if (scenario === 'recap') {
    const ins = (d.insight as Record<string, unknown>) || {};
    out.push({ label: 'insight.coreMemory', text: String(ins.coreMemory ?? '') });
    out.push({ label: 'insight.whyItMatters', text: String(ins.whyItMatters ?? '') });
    const secs = Array.isArray(d.sections) ? (d.sections as Record<string, unknown>[]) : [];
    secs.forEach(function (s, i) {
      out.push({ label: `section[${i}].heading`, text: String(s.heading ?? '') });
      if (Array.isArray(s.paragraphs)) {
        (s.paragraphs as unknown[]).forEach(function (p, j) {
          out.push({ label: `section[${i}].p[${j}]`, text: String(p) });
        });
      }
    });
    out.push({ label: 'html(plain)', text: stripHtml(d.html) });
  }
  return out;
}

/* ============================================================
 * 硬判据
 * ========================================================== */

export interface Violation {
  kind: string;
  label: string;
  detail: string;
}

export function bannedHits(items: TextItem[]): Violation[] {
  const out: Violation[] = [];
  for (const it of items) {
    for (const p of BANNED_PHRASES) {
      if (it.text.indexOf(p) >= 0) out.push({ kind: 'banned_phrase', label: it.label, detail: p });
    }
  }
  return out;
}

/**
 * 抽取「数字主张」。
 * ★ 日期/时间表达式不算数字主张：LLM 把 2026-10-11 写成「10.11」是完全正常的日期写法，
 *   早先会被当成编造数字（'10.11' 不是事实池里任何 token 的子串）而误报。
 *   先剥掉日期与时间形态，再抽剩余数字 —— 剩下的才是真正需要回溯的「量」（价格/里程/海拔/人数）。
 */
export function numbersIn(text: string): string[] {
  // 正则内联：避免共用带 /g 的模块级正则带来的 lastIndex 隐状态
  const dateTime = [
    /\d{4}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2}\s*[日号]?/g, // 2026-10-11 / 2026年10月11日
    /\d{1,2}\s*月\s*\d{1,2}\s*[日号]/g, // 10月11日
    /\d{1,2}\s*[:：]\s*\d{2}/g, // 07:30
    /(?:^|[^\d])\d{1,2}\s*[-/.]\s*\d{1,2}(?![\d])/g, // 10.11 / 10-11（长日期已被上一条吃掉）
  ];
  let s = String(text);
  for (const re of dateTime) s = s.replace(re, ' ');
  return s.match(/\d+(?:\.\d+)?/g) || [];
}

/**
 * 现场素材（actual）也算合法数字来源。
 * 回顾渠道写「实到 18 人」「气温 12 度」不是编造 —— 那是运营当场填的。
 * 用 extraTokens 传进来，而不是放宽成「回顾不查数字」（那样就漏掉真编造）。
 */
export function actualFactPool(actual: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    if (typeof v === 'object') {
      Object.keys(v as Record<string, unknown>).forEach((k) => walk((v as Record<string, unknown>)[k]));
      return;
    }
    const s = String(v).trim();
    if (s) out.push(s);
  };
  walk(actual);
  return out;
}

/** 文案里的数字必须能回溯到事实池（与 quality.ts 的 groundClaims 同判据） */
export function unsupportedNumbers(
  items: TextItem[],
  truth: ActivityTruth,
  extraTokens: Iterable<string> = []
): Violation[] {
  const allowed = allowedFactTokens(truth);
  const pool = Array.from(allowed);
  for (const t of extraTokens) pool.push(String(t));
  const out: Violation[] = [];
  for (const it of items) {
    for (const n of numbersIn(it.text)) {
      const ok = pool.some(function (t) { return t.indexOf(n) >= 0; });
      if (!ok) out.push({ kind: 'unsupported_number', label: it.label, detail: n });
    }
  }
  return out;
}

/** 无价格活动不得出现价格（¥ / 「N元」） */
export function priceFabrication(items: TextItem[], truth: ActivityTruth): Violation[] {
  if (truth.confirmedFacts.price !== undefined && truth.confirmedFacts.price !== 0) return [];
  const out: Violation[] = [];
  for (const it of items) {
    if (it.text.indexOf('¥') >= 0 || /[0-9]+\s*元/.test(it.text)) {
      out.push({ kind: 'price_fabrication', label: it.label, detail: it.text.slice(0, 40) });
    }
  }
  return out;
}

/** 微信 HTML 合规：能直接粘贴进公众号后台（无脚本、无外链样式、无 class） */
export function wechatHtmlViolations(html: unknown): Violation[] {
  const s = String(html ?? '');
  const out: Violation[] = [];
  const rules: Array<[string, RegExp]> = [
    ['<script>', /<script[\s>]/i],
    ['<link>', /<link[\s>]/i],
    ['<style>', /<style[\s>]/i],
    ['class=', /\sclass\s*=/i],
    ['外链 JS 属性(on*)', /\son[a-z]+\s*=/i],
  ];
  for (const r of rules) {
    const m = s.match(r[1]);
    if (m) out.push({ kind: 'wechat_html', label: r[0], detail: String(m[0]).slice(0, 30) });
  }
  // ★ 只有「本文真的有图」时才要求 height:auto。
  //   0 照片场次（如 acc-01）本来就没有 <img>，硬要求等于逼渲染器产空图 —— 那是判据错，不是产品错。
  if (/<img[\s>]/i.test(s) && !/height\s*:\s*auto/i.test(s)) {
    out.push({ kind: 'wechat_html', label: '图片未保比例', detail: '缺少 height:auto' });
  }
  return out;
}

/* ============================================================
 * 软判据（报告用）
 * ========================================================== */

/** 无据天气/景观描写 —— 素材里没有的证据就不要写 */
const WEATHER_WORDS = ['晴天', '晴朗', '下雨', '大雨', '暴雨', '降雪', '下雪', '云海', '日照金山', '大雾', '起风', '风很大'];
export function weatherClaims(items: TextItem[], truth: ActivityTruth): Violation[] {
  const evidence = [
    ...truth.groundedScenes.map(function (s) { return s.value; }),
    ...truth.fee.include,
    ...truth.fee.exclude,
    String(truth.confirmedFacts.title ?? ''),
  ].join(' ');
  const hasEvidence = WEATHER_WORDS.some(function (w) { return evidence.indexOf(w) >= 0; });
  if (hasEvidence) return [];
  const out: Violation[] = [];
  for (const it of items) {
    for (const w of WEATHER_WORDS) {
      if (it.text.indexOf(w) >= 0) out.push({ kind: 'weather_claim', label: it.label, detail: w });
    }
  }
  return out;
}

/** 结构签名：这场「长什么样」—— 用来数 30 场里有几种版式 */
export function structureSignature(scenario: string, doc: DocLike): string {
  const d = doc || ({} as DocLike);
  if (scenario === 'detail') {
    const blocks = Array.isArray(d.blocks) ? (d.blocks as Record<string, unknown>[]) : [];
    return blocks.map(function (b) { return String(b.type); }).join('>');
  }
  if (scenario === 'wechat') {
    // ★ wechat 文档**没有 sections**（正文全在 html）——
    //   早先这里按 sections 数，永远得到 'sec0|slots'，30 场恒等于 1 种版式，
    //   是「度量失效」而不是「真的没差异」。改为从最终 HTML 里读版式骨架：标题/配图的出现顺序。
    const h = String((d as Record<string, unknown>).html ?? '');
    const toks = (h.match(/<(h2|figure)[\s>]/gi) || []).map(function (t) {
      return /<h2/i.test(t) ? 'h2' : 'fig';
    });
    return toks.length ? toks.join('>') : 'empty';
  }
  if (scenario === 'xiaohongshu') {
    const seq = Array.isArray(d.imageSequence) ? (d.imageSequence as Record<string, unknown>[]) : [];
    return 'img' + seq.length + '|' + Math.min(4, Math.round(String(d.body ?? '').length / 200));
  }
  const secs = Array.isArray(d.sections) ? (d.sections as Record<string, unknown>[]) : [];
  return 'sec' + secs.length + '|slots' + secs.map(function (s) { return String(s.imageSlots ?? 0); }).join('');
}

export function openingOf(scenario: string, doc: DocLike): string {
  const d = doc || ({} as DocLike);
  if (scenario === 'detail') return String(d.openingMode ?? '');
  if (scenario === 'wechat') return String(d.digest ?? d.title ?? '').slice(0, 40);
  if (scenario === 'xiaohongshu') return String(d.hook ?? '').slice(0, 40);
  return String(((d.insight as Record<string, unknown>) || {}).coreMemory ?? '').slice(0, 40);
}

export function thesisOf(doc: DocLike): string {
  return String((((doc || {}) as Record<string, unknown>).direction as Record<string, unknown> | undefined)?.thesis ?? '');
}

export function styleVectorOf(doc: DocLike): StyleVector | null {
  const dir = ((doc || {}) as Record<string, unknown>).direction as Record<string, unknown> | undefined;
  const sv = dir?.styleVector as StyleVector | undefined;
  return sv && typeof sv === 'object' ? sv : null;
}

export interface DiversityStats {
  count: number;
  uniqStructures: number;
  uniqTheses: number;
  uniqOpenings: number;
  /** 两两主张最大相似度（bigram）—— 越接近 1 越说明连着几场在说同一句话 */
  maxThesisSim: number;
  meanThesisSim: number;
  /** 两两 StyleVector 距离的均值/最小值 —— 最小值太小说明至少有一对「换汤不换药」 */
  meanStyleDist: number;
  minStyleDist: number;
  /** 最近 5 场窗口内的最大相似度（跨场次去重关心的就是这个窗口） */
  maxRecentThesisSim: number;
}

export function diversityStats(scenario: string, docs: DocLike[]): DiversityStats {
  const n = docs.length;
  const sigs = new Set<string>();
  const theses = new Set<string>();
  const openings = new Set<string>();
  docs.forEach(function (d) {
    sigs.add(structureSignature(scenario, d));
    theses.add(thesisOf(d));
    openings.add(openingOf(scenario, d));
  });

  let maxSim = 0, sumSim = 0, cntSim = 0;
  let minStyle = 1, sumStyle = 0, cntStyle = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = thesisOf(docs[i]);
      const b = thesisOf(docs[j]);
      if (a && b) {
        const s = copySimilarity(a, b);
        maxSim = Math.max(maxSim, s);
        sumSim += s;
        cntSim++;
      }
      const va = styleVectorOf(docs[i]);
      const vb = styleVectorOf(docs[j]);
      if (va && vb) {
        const d = styleVectorDistance(va, vb);
        minStyle = Math.min(minStyle, d);
        sumStyle += d;
        cntStyle++;
      }
    }
  }

  let recentMax = 0;
  for (let i = 0; i < n; i++) {
    for (let j = Math.max(0, i - 4); j < i; j++) {
      const a = thesisOf(docs[i]);
      const b = thesisOf(docs[j]);
      if (a && b) recentMax = Math.max(recentMax, copySimilarity(a, b));
    }
  }

  return {
    count: n,
    uniqStructures: sigs.size,
    uniqTheses: theses.size,
    uniqOpenings: openings.size,
    maxThesisSim: round4(maxSim),
    meanThesisSim: cntSim ? round4(sumSim / cntSim) : 0,
    meanStyleDist: cntStyle ? round4(sumStyle / cntStyle) : 0,
    minStyleDist: cntStyle ? round4(minStyle) : 0,
    maxRecentThesisSim: round4(recentMax),
  };
}

export function round4(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}

/* ============================================================
 * 跨场景提示
 * ========================================================== */

/** 公众号/回顾共用一个 HTML 渲染器，shape 一致；detail 与 xhs 走结构化块 */
export function scenarioHint(scenario: string): string {
  if (scenario === 'wechat') return 'html 是最终产物（无 sections）';
  if (scenario === 'recap') return 'sections + html 双份';
  if (scenario === 'xiaohongshu') return 'hook/body/tags，无 html';
  return 'blocks 序列';
}
