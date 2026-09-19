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
import { getLatestDocument, listRecentFingerprints } from '../content-engine/storage/repo';

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
