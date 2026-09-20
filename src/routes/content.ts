/**
 * Content Engine V3 —— 对外接口（文档 §十八）
 *
 * POST /api/content/detail/generate     生成活动详情 PromoDocument
 * GET  /api/content/activity/:activityId 取该活动最新 V3 文档
 * GET  /api/content/:id                  按文档 id 取
 *
 * 接口全部走 requireAdmin（JWT），merchantId 取 req.admin.sub，防止越权读别人内容。
 */

import { Router } from 'express';
import type { Response } from 'express';
import { z } from 'zod';
import { ok, fail, zodMessage } from '../lib';
import { requireAdmin } from '../middleware';
import { generateActivityDetail } from '../content-engine/workflows/detail.workflow';
import { runWechatPipeline } from '../content-engine/workflows/wechat.workflow';
import { runXiaohongshuPipeline } from '../content-engine/workflows/xiaohongshu.workflow';
import { runRecapPipeline } from '../content-engine/workflows/recap.workflow';
import {
  getLatestDocument,
  listRecentFingerprints,
  getBrandProfile,
  upsertBrandProfile,
  listDocumentsForMetrics,
  publishContentDocument,
} from '../content-engine/storage/repo';
import { computeQualityMetrics, type MetricsDocInput } from '../content-engine/steps/metrics';
import type { CreativeFingerprint } from '../content-engine/contracts/fingerprints';
import type { ActivityTruth } from '../content-engine/contracts/activityTruth';
import type { PromoDocument } from '../content-engine/contracts/promoDocument';

const router = Router();
router.use(requireAdmin);

const PhotoSchema = z.object({
  id: z.string().min(1),
  src: z.string().optional(),
});

const GenerateSchema = z.object({
  activityId: z.string().min(1, 'activityId 必填'),
  /** 活动主记录（可选，缺失时走 Missing Facts） */
  activity: z.record(z.any()).optional(),
  /** 方案抽取事实（最高优先） */
  planFacts: z.record(z.any()).optional(),
  materialText: z.array(z.string()).max(40).optional(),
  photos: z.array(PhotoSchema).max(60).optional(),
});

/**
 * POST /api/content/detail/generate
 * 返回 PromoDocument —— 不含任何 XF Family / style enum，页面由 blocks 动态渲染。
 */
router.post('/detail/generate', async (req, res: Response) => {
  const merchantId = Number(req.admin?.sub);
  if (!merchantId) {
    res.status(401).json(fail('未登录'));
    return;
  }
  const parsed = GenerateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(fail(zodMessage(parsed.error)));
    return;
  }

  try {
    const result = await generateActivityDetail({
      merchantId: String(merchantId),
      activityId: parsed.data.activityId,
      activity: parsed.data.activity,
      planFacts: parsed.data.planFacts,
      materialText: parsed.data.materialText,
      photos: parsed.data.photos,
    });
    res.json(ok(result));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json(fail('内容生成失败：' + msg));
  }
});

/**
 * 三个渠道共用一个 handler 形状 —— 差异只在 workflow，
 * 不写四份几乎一样的代码（四份就意味着将来必有一份和另外三份不一致）。
 */
const RecapSchema = GenerateSchema.extend({
  /** 现场真实数据 —— 与 planned facts 严格分离（文档 §十六） */
  actual: z
    .object({
      attendance: z.number().int().nonnegative().optional(),
      weather: z.string().max(40).optional(),
      actualRoute: z.string().max(200).optional(),
      highlights: z.array(z.string().max(300)).max(30).optional(),
      feedbacks: z.array(z.string().max(300)).max(30).optional(),
      onSiteNotes: z.array(z.string().max(300)).max(30).optional(),
      photos: z.array(z.object({ id: z.string(), caption: z.string().optional() })).max(60).optional(),
    })
    .optional(),
});

function makeChannelHandler(
  scenario: 'wechat' | 'xiaohongshu' | 'recap',
  schema: typeof GenerateSchema | typeof RecapSchema,
  run: (input: any) => Promise<any>
) {
  return async (req: any, res: Response) => {
    const merchantId = Number(req.admin?.sub);
    if (!merchantId) {
      res.status(401).json(fail('未登录'));
      return;
    }
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(fail(zodMessage(parsed.error)));
      return;
    }
    try {
      const result = await run({
        merchantId: String(merchantId),
        activityId: parsed.data.activityId,
        activity: parsed.data.activity,
        planFacts: parsed.data.planFacts,
        materialText: parsed.data.materialText,
        photos: parsed.data.photos,
        actual: (parsed.data as { actual?: unknown }).actual,
      });
      res.json(ok(result));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json(fail(`${scenario} 内容生成失败：` + msg));
    }
  };
}

router.post('/wechat/generate', makeChannelHandler('wechat', GenerateSchema, (i) => runWechatPipeline(i)));
router.post(
  '/xiaohongshu/generate',
  makeChannelHandler('xiaohongshu', GenerateSchema, (i) => runXiaohongshuPipeline(i))
);
router.post('/recap/generate', makeChannelHandler('recap', RecapSchema, (i) => runRecapPipeline(i)));

/**
 * ★ 编辑器变更新端点（文档 §十八）
 * 作用在「已生成的 detail 文档」上，对应前端块编辑器的四个动作：
 *   regenerate-style / regenerate-layout / rewrite-block / replace-image。
 * 先按 id 取文档（校验 merchant 归属 + 必须是 blocks 型 detail 文档），再局部变换并落库。
 */

import {
  regenerateStyle,
  regenerateLayout,
  rewriteBlock,
  replaceImage,
  type StyleBias,
  type LayoutMode,
} from '../content-engine/steps/editor';
import { updateContentDocument } from '../content-engine/storage/repo';

const EditorStyleSchema = z.object({ bias: z.enum(['magazine', 'visual', 'professional', 'natural']).optional() });
const EditorLayoutSchema = z.object({ mode: z.enum(['airy', 'dense', 'rhythmic']).optional() });
const EditorRewriteSchema = z.object({
  blockId: z.string().min(1, 'blockId 必填'),
  instruction: z.string().max(300).optional(),
});
const EditorImageSchema = z.object({
  blockId: z.string().min(1, 'blockId 必填'),
  photoId: z.string().min(1, 'photoId 必填'),
  photoSrc: z.string().max(300).optional(),
});

/** 按 id 取 detail 文档（带 merchant 归属校验）。返回 null 时已写过响应。 */
async function loadDetailDoc(req: any, res: Response): Promise<{ doc: any; truth: any } | null> {
  const merchantId = Number(req.admin?.sub);
  if (!merchantId) {
    res.status(401).json(fail('未登录'));
    return null;
  }
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json(fail('id 不合法'));
    return null;
  }
  try {
    const { prisma } = await import('../lib');
    const row = await prisma.contentDocument.findFirst({
      where: { id: BigInt(id), merchantId: BigInt(merchantId) },
    });
    if (!row) {
      res.status(404).json(fail('文档不存在'));
      return null;
    }
    const doc = row.document as unknown as Record<string, any>;
    const truth = row.truthSnapshot as unknown as Record<string, any>;
    if (!Array.isArray(doc?.blocks)) {
      res.status(400).json(fail('该端点仅支持 detail（blocks）文档'));
      return null;
    }
    return { doc, truth };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json(fail('读取失败：' + msg));
    return null;
  }
}

/** 应用编辑器结果并落库，返回统一响应 */
async function saveEditorResult(
  req: any,
  res: Response,
  doc: any,
  truth: any,
  result: { document: any; action: string; llmUsed: boolean; fallbackReason?: string; evaluation?: unknown }
) {
  const merchantId = Number(req.admin?.sub);
  const id = Number(req.params.id);
  try {
    await updateContentDocument(id, merchantId, {
      document: result.document,
      direction: result.document.direction,
      fingerprint: result.document.fingerprint,
      evaluation: result.evaluation,
    });
    res.json(
      ok({
        id,
        document: result.document,
        editorAction: result.action,
        llmUsed: result.llmUsed,
        ...(result.fallbackReason ? { fallbackReason: result.fallbackReason } : {}),
      })
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json(fail('保存失败：' + msg));
  }
}

router.post('/:id/regenerate-style', async (req, res: Response) => {
  const parsed = EditorStyleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(fail(zodMessage(parsed.error)));
    return;
  }
  const loaded = await loadDetailDoc(req, res);
  if (!loaded) return;
  try {
    const result = await regenerateStyle(loaded.doc, loaded.truth, Number(req.admin?.sub), parsed.data.bias as StyleBias);
    await saveEditorResult(req, res, loaded.doc, loaded.truth, result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(400).json(fail('换风格失败：' + msg));
  }
});

router.post('/:id/regenerate-layout', async (req, res: Response) => {
  const parsed = EditorLayoutSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(fail(zodMessage(parsed.error)));
    return;
  }
  const loaded = await loadDetailDoc(req, res);
  if (!loaded) return;
  try {
    const result = await regenerateLayout(loaded.doc, loaded.truth, Number(req.admin?.sub), parsed.data.mode as LayoutMode);
    await saveEditorResult(req, res, loaded.doc, loaded.truth, result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(400).json(fail('换版式失败：' + msg));
  }
});

router.post('/:id/rewrite-block', async (req, res: Response) => {
  const parsed = EditorRewriteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(fail(zodMessage(parsed.error)));
    return;
  }
  const loaded = await loadDetailDoc(req, res);
  if (!loaded) return;
  try {
    const result = await rewriteBlock(
      loaded.doc,
      loaded.truth,
      Number(req.admin?.sub),
      parsed.data.blockId,
      parsed.data.instruction
    );
    await saveEditorResult(req, res, loaded.doc, loaded.truth, result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(400).json(fail('改写块失败：' + msg));
  }
});

router.post('/:id/replace-image', async (req, res: Response) => {
  const parsed = EditorImageSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(fail(zodMessage(parsed.error)));
    return;
  }
  const loaded = await loadDetailDoc(req, res);
  if (!loaded) return;
  try {
    const result = await replaceImage(
      loaded.doc,
      loaded.truth,
      Number(req.admin?.sub),
      parsed.data.blockId,
      parsed.data.photoId,
      parsed.data.photoSrc
    );
    await saveEditorResult(req, res, loaded.doc, loaded.truth, result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(400).json(fail('换图失败：' + msg));
  }
});

/**
 * GET /api/content/activity/:activityId?scenario=detail
 * ★ 必须真的按 activityId 过滤 —— 早期版本忽略路径参数、永远返回最新一篇，
 *   导致「A 活动打开看到 B 活动的内容」。
 */
router.get('/activity/:activityId', async (req, res: Response) => {
  const merchantId = Number(req.admin?.sub);
  if (!merchantId) {
    res.status(401).json(fail('未登录'));
    return;
  }
  try {
    const scenario = (req.query.scenario as string) || 'detail';
    if (!['detail', 'wechat', 'xiaohongshu', 'recap'].includes(scenario)) {
      res.status(400).json(fail('scenario 不合法'));
      return;
    }
    const doc = await getLatestDocument(merchantId, scenario as never, req.params.activityId);
    if (!doc) {
      res.status(404).json(fail('暂无 V3 内容文档'));
      return;
    }
    res.json(ok(doc));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json(fail('读取失败：' + msg));
  }
});

/**
 * GET /api/content/memory/:scenario
 * 返回该渠道最近 20 条创作指纹 —— 用于核查「连续几场是不是长一个样」，
 * 也是跨场次去重（selectDirection historyVectors）的输入来源，必须可见可验。
 */
router.get('/memory/:scenario', async (req, res: Response) => {
  const merchantId = Number(req.admin?.sub);
  if (!merchantId) {
    res.status(401).json(fail('未登录'));
    return;
  }
  const scenario = String(req.params.scenario || '');
  if (!['detail', 'wechat', 'xiaohongshu', 'recap'].includes(scenario)) {
    res.status(400).json(fail('scenario 不合法'));
    return;
  }
  try {
    const list = await listRecentFingerprints(merchantId, scenario as never, 20);
    const withVector = list.filter((f) => !!(f as { styleVector?: unknown }).styleVector).length;
    res.json(ok({ total: list.length, withStyleVector: withVector, items: list }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json(fail('读取失败：' + msg));
  }
});

/** 文档 §十三 —— 品牌档案（BrandProfile） */
const BrandProfileSchema = z.object({
  brandName: z.string().max(80).optional().nullable(),
  toneKeywords: z.array(z.string().max(30)).max(20).optional(),
  avoidKeywords: z.array(z.string().max(30)).max(20).optional(),
  visualKeywords: z.array(z.string().max(30)).max(20).optional(),
  primaryColor: z.string().max(30).optional().nullable(),
  secondaryColor: z.string().max(30).optional().nullable(),
  typographyPreference: z.string().max(40).optional().nullable(),
  logo: z.string().max(500).optional().nullable(),
  contentRules: z.string().max(500).optional().nullable(),
});

/**
 * GET /api/content/brand-profile
 * 未设置时返回 brandProfile=null —— 生成链路据此使用中性默认品牌语言，
 * 绝不默认所有俱乐部都是「年轻、松弛、山系高级感」。
 * ★ 必须注册在 GET /:id 之前，否则会被 /:id 吃掉。
 */
router.get('/brand-profile', async (req, res: Response) => {
  const merchantId = Number(req.admin?.sub);
  if (!merchantId) {
    res.status(401).json(fail('未登录'));
    return;
  }
  try {
    const brandProfile = await getBrandProfile(merchantId);
    res.json(ok({ brandProfile, neutral: !brandProfile }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json(fail('读取品牌档案失败：' + msg));
  }
});

/** PUT /api/content/brand-profile —— 新建或更新本俱乐部品牌档案 */
router.put('/brand-profile', async (req, res: Response) => {
  const merchantId = Number(req.admin?.sub);
  if (!merchantId) {
    res.status(401).json(fail('未登录'));
    return;
  }
  const parsed = BrandProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(fail(zodMessage(parsed.error)));
    return;
  }
  try {
    const brandProfile = await upsertBrandProfile(merchantId, parsed.data);
    res.json(ok({ brandProfile }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json(fail('保存品牌档案失败：' + msg));
  }
});

/**
 * POST /api/content/:id/publish
 * 文档 §二十四：标记发布并写入 publishedAt —— Time-to-Publish 的时间基准点。
 */
router.post('/:id/publish', async (req, res: Response) => {
  const merchantId = Number(req.admin?.sub);
  if (!merchantId) {
    res.status(401).json(fail('未登录'));
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json(fail('id 不合法'));
    return;
  }
  try {
    const doc = await publishContentDocument(id, merchantId);
    res.json(ok({
      id: String(doc.id),
      status: doc.status,
      publishedAt: doc.publishedAt,
      /** 从生成到发布的耗时（§二十四 Time-to-Publish 的原始样本） */
      timeToPublishMs: doc.publishedAt ? doc.publishedAt.getTime() - doc.createdAt.getTime() : null,
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json(fail('发布失败：' + msg));
  }
});

/**
 * GET /api/content/metrics —— 文档 §二十四 质量指标仪表盘
 * 5 个指标：Direct Publish Rate / Edit Ratio / Diversity / Grounding / Time-to-Publish
 * 可选 query：scenario(detail|wechat|xiaohongshu|recap)、limit(<=100，默认 50)
 * ★ 必须注册在 GET /:id 之前，否则会被 /:id 吃掉。
 */
router.get('/metrics', async (req, res: Response) => {
  const merchantId = Number(req.admin?.sub);
  if (!merchantId) {
    res.status(401).json(fail('未登录'));
    return;
  }
  const scenario = String(req.query.scenario || '').trim();
  const limitRaw = Number(req.query.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(100, Math.floor(limitRaw)) : 50;

  try {
    const rows = await listDocumentsForMetrics(
      merchantId,
      scenario || null,
      limit
    );
    const docs: MetricsDocInput[] = rows.map((r) => {
      const doc = r.document as unknown as
        | { blocks?: unknown[]; generationMeta?: { editorAction?: string } }
        | null;
      return {
        id: String(r.id),
        scenario: r.scenario,
        createdAt: r.createdAt,
        publishedAt: r.publishedAt ?? null,
        status: r.status,
        // 被改过的文档在 generationMeta.editorAction 上留痕（§十八 编辑器端点写入）
        editorAction: doc?.generationMeta?.editorAction ?? null,
        fingerprint: r.fingerprint as unknown as CreativeFingerprint | null,
        truth: r.truthSnapshot as unknown as ActivityTruth | null,
        document: r.document as unknown as PromoDocument | null,
      };
    });
    const metrics = computeQualityMetrics(docs, { scenario: scenario || null, window: 20 });
    res.json(ok(metrics));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json(fail('读取质量指标失败：' + msg));
  }
});

/** GET /api/content/:id */
router.get('/:id', async (req, res: Response) => {
  const merchantId = Number(req.admin?.sub);
  if (!merchantId) {
    res.status(401).json(fail('未登录'));
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json(fail('id 不合法'));
    return;
  }
  try {
    const { prisma } = await import('../lib');
    const doc = await prisma.contentDocument.findFirst({
      where: { id: BigInt(id), merchantId: BigInt(merchantId) },
    });
    if (!doc) {
      res.status(404).json(fail('文档不存在'));
      return;
    }
    res.json(ok(doc));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json(fail('读取失败：' + msg));
  }
});

export default router;
