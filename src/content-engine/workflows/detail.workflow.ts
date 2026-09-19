/**
 * Content Engine V3 —— detail.workflow
 *
 * 文档 §九 规定为「受控 Workflow」，禁止 Agent 自由发挥：
 *   Fact/Truth → Insight → Directions → Diversity Select → Blueprint
 *   → Section Writing → Photo Matching → Layout Compose
 *   → Grounding → Similarity Eval → Repair
 *
 * 实现要点：
 *  - 业务逻辑全部在纯函数里（runDetailPipeline），不依赖任何 AI 框架，可单测。
 *  - Mastra 通过「原生动态 import」挂载（@mastra/core 是带 TLA 的 ESM，
 *    而本项目 tsc 输出 CommonJS，静态 import 会被降级成 require 而失败）。
 *  - Mastra 不可用时自动降级为顺序执行 —— 功能一致，只是失去 observability。
 */

import type { ActivityTruth } from '../contracts/activityTruth';
import type { PromoDocument } from '../contracts/promoDocument';
import { buildCreativeFingerprint, type CreativeFingerprint } from '../contracts/fingerprints';
import { buildBlueprint, writeBlocks, matchPhotos, composeLayout } from '../steps/compose';
import { runCommonPrefix } from './shared';
import { groundClaims, evaluateSimilarity, repairDocument } from '../steps/quality';
import { saveContentDocument, appendCreativeMemory } from '../storage/repo';

export const WORKFLOW_VERSION = 'v3.0-detail';

export interface DetailWorkflowInput {
  merchantId: string;
  activityId: string;
  activity?: Record<string, unknown>;
  planFacts?: Record<string, unknown>;
  materialText?: string[];
  photos?: { id: string; src?: string }[];
}

export interface DetailWorkflowResult {
  truth: ActivityTruth;
  missing: string[];
  document: PromoDocument;
  evaluation: ReturnType<typeof evaluateSimilarity>;
}

/** 主管道 —— 纯业务逻辑，可离线单测（不含 Mastra） */
export async function runDetailPipeline(
  input: DetailWorkflowInput
): Promise<DetailWorkflowResult> {
  // Step 1~6（与 wechat/xhs/recap 共用同一前缀：同一份 Activity Truth）
  const common = await runCommonPrefix(input, 'detail');
  const { truth, missing, direction, vision, photos } = common;

  // Step 7~10
  const blueprint = await buildBlueprint(
    input.merchantId,
    truth,
    direction,
    common.insight,
    photos.length
  );
  const insight = common.insight;
  const historyMemory = common.history;

  let blocks = await writeBlocks(
    input.merchantId,
    truth,
    direction,
    blueprint,
    vision,
    photos
  );
  matchPhotos(vision, blocks, photos);
  blocks = composeLayout(blocks, direction.styleVector);

  // Step 11~13
  const grounded = groundClaims(blocks, truth);
  blocks = grounded.blocks;

  const evaluation = evaluateSimilarity(
    { thesisText: direction.thesis, openingMode: blueprint.openingMode, blocks },
    historyMemory
  );

  let repairs = 0;
  if (grounded.violations.length > 0 || evaluation.tooRepetitive) {
    const repaired = await repairDocument(
      { blocks, violations: grounded.violations, report: evaluation },
      async () => {
        const again = await writeBlocks(
          input.merchantId,
          truth,
          direction,
          blueprint,
          vision,
          photos
        );
        const laid = composeLayout(again, direction.styleVector);
        return groundClaims(laid, truth).blocks;
      }
    );
    blocks = repaired.blocks;
    repairs = repaired.repairCount;
  }

  const fingerprint: CreativeFingerprint = buildCreativeFingerprint({
    thesisText: direction.thesis,
    openingMode: blueprint.openingMode,
    blocks,
    // 带上 StyleVector：跨场次去重要比「用什么调性说的」，不能只比文案
    styleVector: direction.styleVector,
  });

  const document: PromoDocument = {
    schemaVersion: 3,
    activityId: input.activityId,
    scenario: 'detail',
    direction,
    openingMode: blueprint.openingMode,
    blocks,
    fingerprint,
    generationMeta: {
      model: 'platform-llm',
      workflowVersion: WORKFLOW_VERSION,
      generatedAt: new Date().toISOString(),
      repairCount: repairs,
    },
  };

  // Step 14 persist（失败不阻断返回 —— DB 未就绪时仍要能生成）
  try {
    await saveContentDocument({
      merchantId: input.merchantId,
      activityId: input.activityId,
      scenario: 'detail',
      truth,
      direction,
      document,
      fingerprint,
      evaluation,
    });
    await appendCreativeMemory(input.merchantId, 'detail', fingerprint, input.activityId);
  } catch {
    /* DB 不可用时静默：内容仍返回给调用方 */
  }

  return { truth, missing, document, evaluation };
}

/* 历史读取已上移到 workflows/shared.ts 的 runCommonPrefix（按 scenario 隔离 + 带 StyleVector），
   四个 scenario 共用一份实现，避免各写一遍后慢慢不一致。 */

/**
 * Mastra 挂载：把四个阶段注册成受控 step。
 * 成功返回 execution 方式，失败返回 null（调用方降级）。
 */
export interface MastraRuntime {
  createStep: any;
  createWorkflow: any;
}

export async function loadMastra(): Promise<MastraRuntime | null> {
  try {
    // 注意：必须用原生动态 import（new Function），否则 TS 会降级成 require，
    // 而 @mastra/core 是带顶层 await 的 ESM，require 会抛 ERR_REQUIRE_ASYNC_MODULE。
    const dynamicImport = new Function('s', 'return import(s)') as (s: string) => Promise<any>;
    const mod = await dynamicImport('@mastra/core/workflows');
    if (typeof mod?.createStep !== 'function' || typeof mod?.createWorkflow !== 'function') {
      return null;
    }
    return { createStep: mod.createStep, createWorkflow: mod.createWorkflow };
  } catch {
    return null;
  }
}

/** 对外统一入口：优先走 Mastra 受控执行图，不可用则顺序执行 */
export async function generateActivityDetail(
  input: DetailWorkflowInput
): Promise<DetailWorkflowResult & { engine: 'mastra' | 'sequential' }> {
  const mastra = await loadMastra();
  if (mastra) {
    try {
      const { z } = await import('zod');
      const anyObj = z.record(z.any());
      const step = (id: string, fn: (i: any) => any) =>
        mastra.createStep({
          id,
          inputSchema: anyObj,
          outputSchema: anyObj,
          execute: async ({ inputData }: any) => await fn(inputData),
        });
      // 事实阶段已在 runCommonPrefix 内完成，这里只串 echo → generate
      // 事实 / QA 阶段：把机的人类控制在延迟环节，最终产出文档
      const wf = mastra
        .createWorkflow({
          id: 'clubos-detail-v3',
          inputSchema: anyObj,
          outputSchema: anyObj,
        })
        .then(step('generate', (i) => runDetailPipeline(i.input)))
        .commit();
      const run = await wf.createRun();
      const res = await run.start({ inputData: input });
      const payload = (res as any)?.result ?? res;
      if (payload && payload.document) return { ...payload, engine: 'mastra' };
    } catch {
      /* 降级到顺序执行 */
    }
  }
  const result = await runDetailPipeline(input);
  return { ...result, engine: 'sequential' };
}
