import { Router } from 'express';
import { z } from 'zod';
import { ok, fail, logger } from '../lib';
import { applySplitForOrder, retryFailedSplits } from '../services/splitService';

const router = Router();

const splitSchema = z.object({ order_no: z.string().min(1) });

/** POST /api/pay/split/apply · 对单笔订单发起分账 */
router.post('/split/apply', async (req, res) => {
  const parsed = splitSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(fail('缺少 order_no'));
    return;
  }

  try {
    const result = await applySplitForOrder(parsed.data.order_no);
    res.json(ok(result));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('[split/apply] 失败', message);
    res.status(400).json(fail(message));
  }
});

/**
 * POST /api/pay/split/retry · 批量重试失败分账
 * 接入后建议由定时任务按 1m / 5m / 30m 指数退避调用，而非暴露到公网。
 */
router.post('/split/retry', async (_req, res) => {
  try {
    const result = await retryFailedSplits();
    res.json(ok(result));
  } catch (err) {
    res.status(500).json(fail(err instanceof Error ? err.message : String(err)));
  }
});

export default router;
