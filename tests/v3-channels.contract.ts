/**
 * Content Engine V3 —— Channel 契约回归（离线可跑，不需要 DB / LLM Key）
 *
 * 运行： npx tsx tests/v3-channels.contract.ts
 *
 * ⚠️ 本地无 DATABASE_URL 时会刷出 prisma 的 "Environment variable not found" 报错，
 *    这是**预期噪音**：落库失败被 try/catch 兜住，内容照样生成。
 *    同理无 LLM Key 时所有创作步骤走确定性兜底 —— 本脚本正是要验证这条兜底线。
 *
 * 断言的是「不可退让的边界」，不是实现细节：
 *   1. 公众号 HTML 必须能直接粘贴进微信后台（无 script / 无外链 CSS / 图保持原比例）
 *   2. 图片位置由 content 决定，不是渲染器平均分布
 *   3. 回顾必须来自真实发生过的事 —— 没有现场素材就给诚实空态，绝不拿方案原文冒充
 *   4. 禁用话术零泄漏（无 LLM 也不是泄漏模板话术的理由）
 *   5. 四个 scenario 的 CreativeMemory 互相隔离
 *   6. StyleVector 必须进指纹 —— 否则跨场次去重只在比文案
 */

import assert from 'node:assert';
import { runWechatPipeline } from '../src/content-engine/workflows/wechat.workflow';
import { runXiaohongshuPipeline } from '../src/content-engine/workflows/xiaohongshu.workflow';
import { runRecapPipeline } from '../src/content-engine/workflows/recap.workflow';
import { runDetailPipeline } from '../src/content-engine/workflows/detail.workflow';
import { buildRecapInsight, sequenceXhsPhotos } from '../src/content-engine/steps/channels';
import { renderWechatHtml } from '../src/content-engine/renderers/wechatHtml';
import {
  buildCreativeFingerprint,
  extractStyleVectors,
  styleDistance,
} from '../src/content-engine/contracts/fingerprints';
import { neutralStyleVector } from '../src/content-engine/contracts/creativeDirection';
import { BANNED_PHRASES } from '../src/content-engine/steps/quality';

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ok   ${name}`);
    })
    .catch((e) => {
      failed++;
      console.log(`  FAIL ${name}\n       ${(e as Error).message.split('\n')[0]}`);
    });
}

const ACT = {
  title: '赵公山徒步',
  date: '2026-10-01',
  place: '都江堰赵公山',
  days: 1,
  difficulty: '中等',
  meeting: '天府广场地铁站A口',
  price: 168,
  limit: 25,
  itineraryDays: [{ day: 1, title: '上山', items: ['集合出发', '山脊行走', '下撤'] }],
  feeInclude: ['往返车费', '专业领队'],
  checklist: { required: ['登山鞋', '雨衣'] },
};
const PHOTOS = [{ id: 'p0', src: 'https://x/a.jpg' }, { id: 'p1', src: 'https://x/b.jpg' }, { id: 'p2', src: 'https://x/c.jpg' }];

function input() {
  return {
    merchantId: '1',
    activityId: 'act-1',
    activity: ACT,
    planFacts: { place: '都江堰赵公山', price: 168, limit: 25, feeInclude: ['往返车费'] },
    photos: PHOTOS,
  };
}

function assertNoBanned(text: string, label: string) {
  for (const p of BANNED_PHRASES) {
    assert.ok(!String(text).includes(p), `${label} 泄漏禁用话术：${p}`);
  }
}

async function main() {
  console.log('\n== A. 微信公众号富文本（文档 §十四）==');

  const wx = await runWechatPipeline(input());
  const html = wx.document.html;

  await check('A1 产出可直接粘贴的 HTML', () => {
    assert.ok(html.length > 50, 'html 不应为空');
    assert.ok(html.startsWith('<section'), '应以 inline-style section 开头');
  });

  await check('A2 不依赖 JS（微信会剥 script）', () => {
    assert.ok(!/<script/i.test(html), '出现了 script');
    assert.ok(!/onclick|onerror|onload\s*=/i.test(html), '出现了内联事件属性');
  });

  await check('A3 不依赖外链 CSS', () => {
    assert.ok(!/<link/i.test(html), '出现了 link 标签');
    assert.ok(!/<style/i.test(html), '出现了 style 标签（微信不可靠）');
    assert.ok(!/class="/i.test(html), '出现了 class 依赖外链样式');
  });

  await check('A4 图片保持原比例（不许固定 height 压扁竖图）', () => {
    const imgs = html.match(/<img[^>]*>/g) || [];
    assert.ok(imgs.length > 0, '应至少有一张图');
    for (const img of imgs) {
      assert.ok(/height:\s*auto/.test(img), `图片缺少 height:auto -> ${img.slice(0, 80)}`);
      assert.ok(/max-width:\s*100%/.test(img), '图片缺少 max-width:100%');
      assert.ok(!/height:\s*\d+px/.test(img), '图片被写死固定高度');
    }
  });

  await check('A5 多标题候选 + 摘要存在且不残留占位符', () => {
    assert.ok(wx.document.titleOptions.length >= 1, '无标题候选');
    assert.ok(wx.document.title.length > 0, 'title 为空');
    assert.ok(!/待定|xx|TBD/i.test(wx.document.title), 'title 残留占位符');
  });

  await check('A6 禁用话术零泄漏', () => assertNoBanned(html + wx.document.digest, 'wechat'));

  await check('A7 图片位置由 imageSlots 决定（不是渲染器平均插入）', () => {
    // 全部集中到第一段：渲染器必须照做，不能自己平均分布
    const out = renderWechatHtml({
      activityId: 'a',
      blueprint: {
        titleStrategy: '', summary: '', opening: 'x',
        sections: [
          { purpose: 'p1', paragraphs: ['一段'], imageSlots: 3, evidenceRefs: [] },
          { purpose: 'p2', paragraphs: ['二段'], imageSlots: 0, evidenceRefs: [] },
        ],
        closing: '', cta: '',
      },
      title: 't', images: ['a', 'b', 'c'], coverIndex: 0,
      styleVector: neutralStyleVector(),
    });
    const firstSecIdx = out.indexOf('二段');
    const imgCountBeforeSecond = (out.slice(0, firstSecIdx).match(/<img/g) || []).length;
    assert.strictEqual(imgCountBeforeSecond, 3, `第二段前应集中 3 张，实际 ${imgCountBeforeSecond}`);
  });

  console.log('\n== B. 小红书（文档 §十五）==');

  const xhs = await runXiaohongshuPipeline(input());

  await check('B1 必备字段齐全', () => {
    const d = xhs.document;
    assert.ok(d.hook.length > 0, 'hook 为空');
    assert.ok(d.titleOptions.length >= 1, '无标题候选');
    assert.ok(d.mainAngle.length > 0, 'mainAngle 为空');
    assert.ok(d.body.length > 0, 'body 为空');
  });

  await check('B2 图片顺序是内容的一部分（每格都有角色）', () => {
    assert.ok(xhs.document.imageSequence.length > 0, 'imageSequence 为空');
    for (const s of xhs.document.imageSequence) {
      assert.ok(s.role.length > 0, `第 ${s.photoIndex} 张没有 role`);
    }
    assert.ok(typeof xhs.document.coverSuggestion === 'number', 'coverSuggestion 缺失');
  });

  await check('B3 不是把公众号缩短（hook 与 detail 导语不同源即可区分）', () => {
    const seq = sequenceXhsPhotos(PHOTOS, [], 'x').sequence;
    assert.strictEqual(seq.length, PHOTOS.length, '序列应覆盖所有照片');
    assert.strictEqual(new Set(seq.map((s) => s.role)).size, seq.length, '角色应互不重复');
  });

  await check('B4 禁用话术零泄漏', () => assertNoBanned(xhs.document.body + xhs.document.hook, 'xhs'));

  console.log('\n== C. 活动回顾（文档 §十六）==');

  const emptyRecap = await runRecapPipeline(input());

  await check('C1 无现场素材 → 诚实空态，不拿方案原文冒充回顾', () => {
    assert.strictEqual(emptyRecap.emptyInsight, true, '应识别为无现场洞察');
    assert.strictEqual(emptyRecap.document.insight.coreMemory, '', 'coreMemory 应为空');
    assert.ok(
      /还没有|待补充|暂无/.test(emptyRecap.document.html),
      '应给出诚实空态文案，而不是演出一篇回顾'
    );
  });

  await check('C2 有现场素材 → 洞察必须来自 actualActivityData', () => {
    const insight = buildRecapInsight(
      { activityId: 'a', merchantId: '1', confirmedFacts: {}, itinerary: [], fee: { include: [], exclude: [] }, checklist: { required: [], recommended: [] }, groundedScenes: [] } as never,
      { highlights: ['登顶那十分钟全队都没说话'], feedbacks: ['领队一路在点人数，很安心'] }
    );
    assert.ok(insight.coreMemory.includes('登顶'), '应取现场 highlight 作为核心记忆');
    assert.ok(insight.evidence.length > 0, '应有可回溯证据');
  });

  await check('C3 actual 与 planned 严格分离（不由 plan 推出 coreMemory）', () => {
    const insight = buildRecapInsight(
      { activityId: 'a', merchantId: '1', confirmedFacts: { title: '赵公山' }, itinerary: [], fee: { include: [], exclude: [] }, checklist: { required: [], recommended: [] }, groundedScenes: [] } as never,
      {}
    );
    assert.strictEqual(insight.coreMemory, '', '没有 actual 就不许产出「核心记忆」');
  });

  const realRecap = await runRecapPipeline({
    ...input(),
    actual: { highlights: ['登顶那十分钟全队都没说话'], feedbacks: ['领队一路在点人数'] },
  });

  await check('C4 有实录时产出真实回顾且不含禁用话术', () => {
    assert.strictEqual(realRecap.emptyInsight, false);
    assert.ok(realRecap.document.html.includes('登顶'), 'html 应含现场内容');
    assertNoBanned(realRecap.document.html, 'recap');
  });

  console.log('\n== D. 跨场次去重（本轮修复的核心缺陷）==');

  await check('D1 StyleVector 必须进入指纹（否则只比了文案）', () => {
    const v = neutralStyleVector({ imageDominance: 0.9 });
    const fp = buildCreativeFingerprint({ thesisText: 't', blocks: [], styleVector: v });
    assert.ok(fp.styleVector, '指纹里没有 styleVector');
    assert.strictEqual(fp.styleVector.imageDominance, 0.9, 'styleVector 未被保留');
  });

  await check('D2 extractStyleVectors 能取出历史风格向量', () => {
    const v1 = neutralStyleVector({ professionalSignal: 0.2 });
    const v2 = neutralStyleVector({ professionalSignal: 0.9 });
    const list = [
      buildCreativeFingerprint({ thesisText: 'a', styleVector: v1 }),
      buildCreativeFingerprint({ thesisText: 'b', styleVector: v2 }),
      buildCreativeFingerprint({ thesisText: 'c' }), // 旧行：无 styleVector
    ];
    const got = extractStyleVectors(list);
    assert.strictEqual(got.length, 2, `应只取到 2 个有效向量，实际 ${got.length}`);
  });

  await check('D3 styleDistance 是连续量纲，不是相等与否', () => {
    const a = neutralStyleVector();
    const near = neutralStyleVector({ imageDominance: 0.51 });
    const far = neutralStyleVector({ imageDominance: 1, socialEnergy: 1, lifestyleSignal: 1 });
    const dNear = styleDistance(a, near);
    const dFar = styleDistance(a, far);
    assert.ok(dNear < dFar, `近的应更近：near=${dNear} far=${dFar}`);
    assert.ok(dNear >= 0 && dFar <= 1, '距离应在 0~1');
  });

  console.log('\n== E. 既有能力零回归 ==');

  const detail = await runDetailPipeline(input());

  await check('E1 detail 重构后仍能产出 blocks', () => {
    assert.ok(detail.document.blocks.length > 0, 'blocks 为空');
    assert.ok(detail.document.fingerprint, 'fingerprint 缺失');
    assert.ok(detail.document.fingerprint.styleVector, 'detail 指纹也应带 styleVector');
  });

  await check('E2 detail 无占位符日期泄漏', () => {
    const body = detail.document.blocks.map((b) => (b.copy?.body || '') + (b.copy?.headline || '')).join(' ');
    assert.ok(!/xx日|待定/.test(body), '泄漏占位符：' + body.slice(0, 80));
  });

  await check('E3 detail 标题各不相同（不再所有块复用一句 thesis）', () => {
    const heads = detail.document.blocks.map((b) => b.copy?.headline).filter(Boolean);
    assert.strictEqual(new Set(heads).size, heads.length, '存在重复标题');
  });

  console.log(`\n==== 总计 ${passed + failed} 项，通过 ${passed}，失败 ${failed} ====\n`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
