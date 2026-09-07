import { Router } from 'express';
import { z } from 'zod';
import { ok, fail, logger, zodMessage } from '../lib';
import { createPendingOrder, getOrderByNo } from '../services/orderService';
import { wechatPay } from '../services/wechatPay';

const router = Router();

const unifiedOrderSchema = z.object({
  activity_id: z.number().int().positive(),
  openid: z.string().min(1),
  buyer: z.object({
    name: z.string().min(1),
    phone: z.string().regex(/^1\d{10}$/, '手机号格式不正确'),
    id_type: z.enum(['idcard', 'passport', 'other']),
    id_number: z.string().min(4),
  }),
  adults: z.number().int().min(0).default(1),
  children: z.number().int().min(0).default(0),
});

/** POST /api/pay/unified-order · 统一下单 */
router.post('/unified-order', async (req, res) => {
  const parsed = unifiedOrderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(fail(`参数校验失败：${zodMessage(parsed.error)}`));
    return;
  }

  const { activity_id, openid, buyer, adults, children } = parsed.data;

  try {
    // 外部用 snake_case，服务层用 camelCase，在此做字段名映射
    const order = await createPendingOrder({
      activityId: activity_id,
      openid,
      buyer: {
        name: buyer.name,
        phone: buyer.phone,
        idType: buyer.id_type,
        idNumber: buyer.id_number,
      },
      adults,
      children,
    });

    const payParams = await wechatPay.unifiedOrder({
      orderNo: order.orderNo,
      amount: Number(order.amount),
      openid,
      description: `活动报名 ${order.orderNo}`,
    });

    res.json(ok({ order_no: order.orderNo, amount: Number(order.amount), pay_params: payParams }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('[unified-order] 失败', message);
    res.status(400).json(fail(message));
  }
});

/** GET /api/pay/orders/:id · 查询订单（前端支付后轮询） */
router.get('/orders/:id', async (req, res) => {
  try {
    const order = await getOrderByNo(req.params.id);
    if (!order) {
      res.status(404).json(fail('订单不存在'));
      return;
    }
    res.json(
      ok({
        order_no: order.orderNo,
        status: order.status,
        amount: Number(order.amount),
        paid_at: order.paidAt,
      })
    );
  } catch (err) {
    res.status(500).json(fail(err instanceof Error ? err.message : String(err)));
  }
});

export default router;
