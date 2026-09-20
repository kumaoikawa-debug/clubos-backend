/**
 * Content Engine V3 —— 质量指标契约（文档 §二十四）
 *
 * 运行： npx tsx tests/v3-metrics.contract.ts
 *
 * 断言的是「指标说真话」，不是实现细节：
 *   1. 空数据不吹牛（分母为 0 时给 0，不是 NaN / 不是 100%）
 *   2. Direct Publish Rate = 未经修改直接发布 / 全部
 *   3. Edit Ratio 分级严格按文档三档（优<15% / 可接受15~30% / 不合格>50%）
 *   4. Grounding **有牙**：真的往文案里塞一个事实池外的数字，指标必须报出来（反向验证）
 *   5. Diversity：开场方式雷同要能被识别（同=1，不同=0）
 *   6. Time-to-Publish：从 createdAt 到 publishedAt 的真实耗时
 *
 * ★ 为什么必须有第 4 条：只断言「violations === 0」是**永远为真**的坏断言 ——
 *   指标算错了也会通过。这里先造一份真的带编造数字的文档，逼指标必须 > 0。
 */

import assert from 'node:assert';
import { computeQualityMetrics, gradeEditRatio, type MetricsDocInput } from '../src/content-engine/steps/metrics';
import { buildTruth, normalizeInput } from '../src/content-engine/steps/truth';
import { buildCreativeFingerprint } from '../src/content-engine/contracts/fingerprints';
import type { ContentBlock } from '../src/content-engine/contracts/promoDocument';

const results: string[] = [];
let failed = 0;

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    results.push(`  ok   ${name}`);
  } else {
    failed++;
    results.push(`  FAIL ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

const truth = buildTruth(
  normalizeInput({
    activityId: 'metrics-1',
    merchantId: '1',
    activity: {
      title: '白云嶂穿越',
      place: '惠州 白云嶂',
      date: '2026-10-11',
      price: 298,
      difficulty: '中等',
      limit: 20,
      days: 1,
    },
    materialText: ['07:30 深圳北站集合出发'],
  })
);

function block(id: string, body: string): ContentBlock {
  return {
    id,
    type: 'statement',
    purpose: '展示体验',
    communicationGoal: '',
    evidenceRefs: [],
    copy: { headline: '', body, caption: '' },
    mediaRefs: [],
    layout: { width: 'normal' },
  } as ContentBlock;
}

function doc(over: Partial<MetricsDocInput>): MetricsDocInput {
  return {
    id: 'd1',
    scenario: 'detail',
    createdAt: new Date('2026-09-01T10:00:00Z'),
    publishedAt: null,
    status: 'draft',
    editorAction: null,
    fingerprint: null,
    truth: null,
    document: null,
    ...over,
  };
}

function fingerprintsFor(openingMode: string, thesis: string) {
  return buildCreativeFingerprint({
    thesisText: thesis,
    openingMode,
    blocks: [block('b1', '正文')],
  });
}

/* ---------------- 1. 空数据不吹牛 ---------------- */
{
  const m = computeQualityMetrics([]);
  check('M1 空数据：sample = 0', m.window.sample === 0);
  check('M1 空数据：各项为 0 且非 NaN', !Number.isNaN(m.directPublishRate.rate) && m.directPublishRate.rate === 0);
  check('M1 空数据：Edit Ratio = 0', m.editRatio.ratio === 0);
  check('M1 空数据：Grounding 无违规（没有东西可查，ok 才为真）', m.grounding.ok === true);
  check('M1 空数据：Time-to-Publish 样本 0', m.timeToPublish.sample === 0 && m.timeToPublish.avgHuman === '—');
}

/* ---------------- 2. Direct Publish Rate ---------------- */
{
  const docs: MetricsDocInput[] = [];
  // 4 篇已发布（2 篇未经修改、2 篇改过），6 篇草稿
  for (let i = 0; i < 4; i++) {
    docs.push(doc({
      id: `p${i}`,
      status: 'published',
      publishedAt: new Date('2026-09-01T11:00:00Z'),
      editorAction: i < 2 ? 'rewrite-block:b1' : null,
    }));
  }
  for (let i = 0; i < 6; i++) docs.push(doc({ id: `d${i}` }));

  const m = computeQualityMetrics(docs);
  check('M2 Direct Publish Rate：已发布 4', m.directPublishRate.published === 4, `got ${m.directPublishRate.published}`);
  check('M2 Direct Publish Rate：未经修改发布 2', m.directPublishRate.publishedWithoutEdit === 2, `got ${m.directPublishRate.publishedWithoutEdit}`);
  check('M2 Direct Publish Rate：2/10 = 0.2', m.directPublishRate.rate === 0.2, `got ${m.directPublishRate.rate}`);
}

/* ---------------- 3. Edit Ratio 分级 ---------------- */
{
  check('M3 分级：<15% 为优', gradeEditRatio(0.1).grade === 'excellent');
  check('M3 分级：15% 为可接受', gradeEditRatio(0.15).grade === 'acceptable');
  check('M3 分级：30% 为可接受', gradeEditRatio(0.3).grade === 'acceptable');
  check('M3 分级：40% 为注意（文档未给档位）', gradeEditRatio(0.4).grade === 'watch');
  check('M3 分级：>50% 为不合格', gradeEditRatio(0.6).grade === 'poor');

  const docs: MetricsDocInput[] = [];
  for (let i = 0; i < 10; i++) {
    docs.push(doc({ id: `e${i}`, editorAction: i < 6 ? 'regenerate-style' : null }));
  }
  const m = computeQualityMetrics(docs);
  check('M3 Edit Ratio：6/10 = 0.6', m.editRatio.ratio === 0.6, `got ${m.editRatio.ratio}`);
  check('M3 Edit Ratio：0.6 判为不合格', m.editRatio.grade === 'poor');
}

/* ---------------- 4. Grounding 有牙（反向验证） ---------------- */
{
  // 4a 干净文案：只出现事实池里的数字 → 0 违规
  const clean = computeQualityMetrics([
    doc({
      id: 'clean',
      truth,
      document: { blocks: [block('b1', '费用 298 元，限额 20 人')] } as never,
    }),
  ]);
  check('M4a 干净文案：0 违规、ok=true', clean.grounding.violations === 0 && clean.grounding.ok === true,
    `violations=${clean.grounding.violations}`);

  // 4b 塞入编造数字 → 必须被报出来（否则这条指标是坏的）
  const dirty = computeQualityMetrics([
    doc({
      id: 'dirty',
      truth,
      document: { blocks: [block('b1', '全程 999 公里，海拔 8888 米')] } as never,
    }),
  ]);
  check('M4b 编造数字：violations > 0', dirty.grounding.violations > 0, `got ${dirty.grounding.violations}`);
  check('M4b 编造数字：ok=false（§二十四 无依据 claim 必须为 0）', dirty.grounding.ok === false);
  check('M4b 编造数字：扫描到 1 份文档', dirty.grounding.docsScanned === 1, `got ${dirty.grounding.docsScanned}`);

  // 4c 反向验证：确认「0 违规」不是因为根本没扫描
  assert.ok(dirty.grounding.docsScanned >= 1, '必须真的扫到了文档，否则 0 违规是空转');
}

/* ---------------- 5. Diversity ---------------- */
{
  // 5a 开场方式完全相同 → opening = 1
  const same = computeQualityMetrics([
    doc({ id: 'a', fingerprint: fingerprintsFor('hook', '主张一句话') }),
    doc({ id: 'b', fingerprint: fingerprintsFor('hook', '主张一句话') }),
  ]);
  check('M5a 开场雷同：opening similarity = 1', same.diversity.opening === 1, `got ${same.diversity.opening}`);
  check('M5a 开场雷同：layout 相似度偏高（>=0.8）', same.diversity.layout >= 0.8, `got ${same.diversity.layout}`);

  // 5b 开场方式不同 → opening = 0
  const diff = computeQualityMetrics([
    doc({ id: 'a', fingerprint: fingerprintsFor('hook', '主张一句话') }),
    doc({ id: 'b', fingerprint: fingerprintsFor('scene', '另一句话完全不同') }),
  ]);
  check('M5b 开场不同：opening similarity = 0', diff.diversity.opening === 0, `got ${diff.diversity.opening}`);
  check('M5b Diversity 采样 2 份', diff.diversity.sample === 2, `got ${diff.diversity.sample}`);
  check('M5b 语义层降级标记存在（无 embedding 向量时 semanticAvailable=false）',
    typeof diff.diversity.semanticAvailable === 'boolean');
}

/* ---------------- 6. Time-to-Publish ---------------- */
{
  const docs: MetricsDocInput[] = [
    doc({ id: 't1', status: 'published', createdAt: new Date('2026-09-01T10:00:00Z'), publishedAt: new Date('2026-09-01T10:30:00Z') }),
    doc({ id: 't2', status: 'published', createdAt: new Date('2026-09-01T10:00:00Z'), publishedAt: new Date('2026-09-01T11:30:00Z') }),
  ];
  const m = computeQualityMetrics(docs);
  check('M6 Time-to-Publish：样本 2', m.timeToPublish.sample === 2, `got ${m.timeToPublish.sample}`);
  check('M6 Time-to-Publish：平均 60 分钟', m.timeToPublish.avgMs === 3600000, `got ${m.timeToPublish.avgMs}`);
  check('M6 Time-to-Publish：中位数 60 分钟', m.timeToPublish.medianMs === 3600000, `got ${m.timeToPublish.medianMs}`);
  check('M6 Time-to-Publish：人类可读 = 1 小时', m.timeToPublish.avgHuman === '1 小时', `got ${m.timeToPublish.avgHuman}`);

  /* 线上实测：12850ms 曾被 Math.round(ms/60000) 显示成「0 分钟」，看着像没数据。
     不足 1 分钟必须按秒显示 —— 反向验证：断言里同时点名「不得出现 0 分钟」。 */
  const sec = computeQualityMetrics([
    doc({ id: 's1', status: 'published', createdAt: new Date('2026-09-01T10:00:00Z'), publishedAt: new Date('2026-09-01T10:00:12.850Z') }),
  ]);
  check('M6b 12.85 秒：不得显示成「0 分钟」', sec.timeToPublish.avgHuman !== '0 分钟', `got ${sec.timeToPublish.avgHuman}`);
  check('M6b 12.85 秒：人类可读 = 13 秒', sec.timeToPublish.avgHuman === '13 秒', `got ${sec.timeToPublish.avgHuman}`);
  const m1 = computeQualityMetrics([
    doc({ id: 's2', status: 'published', createdAt: new Date('2026-09-01T10:00:00Z'), publishedAt: new Date('2026-09-01T10:01:00Z') }),
  ]);
  check('M6b 满 1 分钟进分钟档（1 分钟）', m1.timeToPublish.avgHuman === '1 分钟', `got ${m1.timeToPublish.avgHuman}`);
}

console.log(results.join('\n'));
console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} ${results.length - failed}/${results.length}`);
process.exit(failed === 0 ? 0 : 1);
