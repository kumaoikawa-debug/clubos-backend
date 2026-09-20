/**
 * Content Engine V3 —— 编辑器变更新端点契约（文档 §十八）
 *
 * 运行： npx tsx tests/v3-editor.contract.ts
 *
 * 离线（无 LLM / 无 DB）也能跑：rewrite-block 的 LLM 不可用时会降级为确定性改写，
 * 其余三个是确定性变换。断言的是「编辑器改动后文档依然守住院栏」+「四个动作真的改到了东西」。
 */

import { runDetailPipeline } from '../src/content-engine/workflows/detail.workflow';
import { buildTruth, normalizeInput } from '../src/content-engine/steps/truth';
import { buildFixture30 } from '../tools/v3-fixture-30';
import {
  regenerateStyle,
  regenerateLayout,
  rewriteBlock,
  replaceImage,
} from '../src/content-engine/steps/editor';
import { isValidBlockType } from '../src/content-engine/contracts/promoDocument';
import { bannedHits, docTexts } from '../tools/v3-audit';
import type { PromoDocument } from '../src/content-engine/contracts/promoDocument';

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

function assertDocInvariants(tag: string, doc: PromoDocument) {
  must(doc.schemaVersion === 3, `${tag}: schemaVersion=${doc.schemaVersion}`);
  must(Array.isArray(doc.blocks) && doc.blocks.length >= 3, `${tag}: blocks=${doc.blocks?.length}`);
  for (const b of doc.blocks) {
    if (!isValidBlockType(b.type)) throw new Error(`${tag}: 非法 block 类型 ${b.type}`);
    if (!b.purpose) throw new Error(`${tag}: ${b.id} 缺 purpose`);
  }
  const banned = bannedHits(docTexts('detail', doc as never));
  must(banned.length === 0, `${tag}: 禁用话术泄漏 ${banned.slice(0, 3).join(' | ')}`);
}

async function main() {
  const fx = buildFixture30()[0];
  const truth = buildTruth(
    normalizeInput({
      activityId: fx.id,
      merchantId: '1',
      activity: fx.activity,
      planFacts: fx.planFacts,
      materialText: fx.materialText,
      photos: fx.photos,
    })
  );
  const { document: base } = await runDetailPipeline({
    merchantId: '1',
    activityId: fx.id,
    activity: fx.activity,
    planFacts: fx.planFacts,
    materialText: fx.materialText,
    photos: fx.photos,
  });
  const firstId = (base.blocks as PromoDocument['blocks'])[0].id;

  console.log(`\n[§十八 编辑器] 基线 detail 文档 blocks=${(base.blocks as PromoDocument['blocks']).length}\n`);

  check('基线 detail 文档本身守住院栏', () => assertDocInvariants('base', base as PromoDocument));

  /* ---- regenerate-style ---- */
  const styled = await regenerateStyle(base as PromoDocument, truth, '1', 'visual');
  check('regenerate-style：imageDominance 被明确上推（visual bias +0.2）', () => {
    const before = (base as PromoDocument).direction.styleVector.imageDominance;
    const after = styled.document.direction.styleVector.imageDominance;
    must(after > before, `imageDominance ${before} → ${after}（应增大）`);
  });
  check('regenerate-style：action 已记录、改动后文档仍自洽', () => {
    must(styled.action === 'regenerate-style:visual', `action=${styled.action}`);
    must(styled.document.generationMeta.editorAction === 'regenerate-style:visual', 'editorAction 未写入');
    assertDocInvariants('style', styled.document);
  });

  /* ---- regenerate-layout ---- */
  const laid = await regenerateLayout(base as PromoDocument, truth, '1', 'airy');
  check('regenerate-layout：whitespace 变 generous（airy）', () => {
    must(laid.document.direction.styleVector.whitespace === 'generous', `whitespace=${laid.document.direction.styleVector.whitespace}`);
  });
  check('regenerate-layout：改动后文档仍自洽', () => {
    must(laid.document.generationMeta.editorAction === 'regenerate-layout:airy', 'editorAction 未写入');
    assertDocInvariants('layout', laid.document);
  });

  /* ---- rewrite-block（离线降级到确定性改写）---- */
  const rewritten = await rewriteBlock(base as PromoDocument, truth, '1', firstId);
  check('rewrite-block：离线降级到确定性改写、不抛错、llmUsed=false 带原因', () => {
    must(rewritten.llmUsed === false, `llmUsed 应为 false（离线），实际 ${rewritten.llmUsed}`);
    must(!!rewritten.fallbackReason, '离线应带 fallbackReason');
  });
  check('rewrite-block：目标块 copy 非空、不变量守住', () => {
    const blk = (rewritten.document.blocks as PromoDocument['blocks']).find((b) => b.id === firstId)!;
    must(!!blk.copy && (!!blk.copy.body || !!blk.copy.headline), `${firstId} 改写后 copy 为空`);
    must(rewritten.document.generationMeta.editorAction === `rewrite-block:${firstId}`, 'editorAction 未写入');
    assertDocInvariants('rewrite', rewritten.document);
  });

  /* ---- replace-image ---- */
  const replaced = await replaceImage(base as PromoDocument, truth, '1', firstId, 'photo-NEW-001', '新配图说明');
  check('replace-image：目标块 mediaRefs 被替换为新 photoId', () => {
    const blk = (replaced.document.blocks as PromoDocument['blocks']).find((b) => b.id === firstId)!;
    must(JSON.stringify(blk.mediaRefs) === JSON.stringify(['photo-NEW-001']), `mediaRefs=${JSON.stringify(blk.mediaRefs)}`);
    must(replaced.document.generationMeta.editorAction === `replace-image:${firstId}->photo-NEW-001`, 'editorAction 未写入');
    assertDocInvariants('replace', replaced.document);
  });

  /* ---- 错误路径 ---- */
  let threw = false;
  try {
    await rewriteBlock(base as PromoDocument, truth, '1', 'no-such-block');
  } catch {
    threw = true;
  }
  check('rewrite-block：blockId 不存在时抛错（不静默吞掉）', () => must(threw, '未对非法 blockId 抛错'));

  console.log(`\n  ${passed}/${passed + failed} 通过\n`);
  if (failed > 0) {
    failures.forEach((f) => console.log('   - ' + f));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
