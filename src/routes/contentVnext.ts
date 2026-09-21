/**
 * ai-content-vnext —— 对外接口（Clean Rewrite 文档 V1.0）
 *
 * POST /api/content-vnext/generate   生成活动详情 AI Promo Canvas（§24 第一期）
 * POST /api/content-vnext/revise      自然语言改稿（§15 / DoD #9）
 *
 * 全部走 requireAdmin（JWT），merchantId=req.admin.sub，防越权。
 * 内部只调用 proxyChat（平台 Key + 积分计量），不接触密钥。
 *
 * 注意：本路由与 legacy 的 /api/content（Content Engine V3）并行共存，但互不复用生成逻辑。
 */
import { Router } from 'express';
import type { Response } from 'express';
import { z } from 'zod';
import { ok, fail, zodMessage } from '../lib';
import { requireAdmin } from '../middleware';
import { generatePromoCanvas, revisePromo } from '../ai-content-vnext';

const router = Router();
router.use(requireAdmin);

const PhotoSchema = z.object({
  id: z.string().min(1),
  src: z.string().min(1),
  width: z.number().optional(),
  height: z.number().optional(),
  caption: z.string().optional(),
  materialEvidence: z.boolean().optional(),
  eventFact: z.boolean().optional(),
  subjects: z.array(z.string()).optional(),
});

const SourceMaterialSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['text', 'ppt', 'word', 'pdf', 'image', 'poster', 'legacy']),
  text: z.string().optional(),
  imageRefs: z.array(z.string()).optional(),
  raw: z.record(z.any()).optional(),
});

const GenerateSchema = z.object({
  activityId: z.string().min(1, 'activityId 必填'),
  activity: z.record(z.any()).optional(),
  sourceMaterials: z.array(SourceMaterialSchema).max(40).optional(),
  photos: z.array(PhotoSchema).max(60).optional(),
});

const ReviseSchema = GenerateSchema.extend({
  instruction: z.string().min(1, 'instruction 必填'),
  existingBlocks: z.array(z.any()).optional(),
});

router.post('/generate', async (req, res: Response) => {
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
    const result = await generatePromoCanvas({
      merchantId: String(merchantId),
      activityId: parsed.data.activityId,
      activity: parsed.data.activity as Record<string, unknown> | undefined,
      sourceMaterials: parsed.data.sourceMaterials,
      photos: parsed.data.photos as any,
    });
    res.json(ok(result));
  } catch (e) {
    res.status(500).json(fail('AI Promo Canvas 生成失败：' + (e instanceof Error ? e.message : String(e))));
  }
});

router.post('/revise', async (req, res: Response) => {
  const merchantId = Number(req.admin?.sub);
  if (!merchantId) {
    res.status(401).json(fail('未登录'));
    return;
  }
  const parsed = ReviseSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(fail(zodMessage(parsed.error)));
    return;
  }
  try {
    const result = await revisePromo({
      merchantId: String(merchantId),
      activityId: parsed.data.activityId,
      activity: parsed.data.activity as Record<string, unknown> | undefined,
      sourceMaterials: parsed.data.sourceMaterials,
      photos: parsed.data.photos as any,
      instruction: parsed.data.instruction,
      existingBlocks: parsed.data.existingBlocks as any,
    });
    res.json(ok(result));
  } catch (e) {
    res.status(500).json(fail('自然语言改稿失败：' + (e instanceof Error ? e.message : String(e))));
  }
});

export default router;
