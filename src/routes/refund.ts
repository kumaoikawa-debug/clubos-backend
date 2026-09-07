import { Router } from 'express';
import { z } from 'zod';
import { ok, fail, logger, zodMessage } from '../lib';
import { refundOrder } from '../services/refundService';

const router = Router();

const refundSchema = z.object({
  order_no: z.string().min(1),
  /** 不传则全额退；多人订单可按比例退 */
  refund_amount: z.number().positive().optional(),
  reason: z.string().max(200).optional(),
});

/**
 * POST /api/pay/refund · 退款
 * 内部已处理「已分账 → 先回退分账 → 再原路退款」的顺序依赖。
 */
router.post('/refund', async (req, res) => {
  const parsed = refundSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(fail(`参数校验失败：${zodMessage(parsed.error)}`));
    return;
  }

  const { order_no, refund_amount, reason } = parsed.data;

  try {
    const result = await refundOrder({ orderNo: order_no, refundAmount: refund_amount, reason });
    res.json(ok(result));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('[refund] 失败', message);
    res.status(400).json(fail(message));
  }
});

export default router;
