import { Router } from 'express';
import { ok, fail, logger } from '../lib';
import { dailyReconcile, generatePayouts } from '../services/settleService';
import { closeExpiredOrders } from '../services/orderService';

const router = Router();

/**
 * GET /api/pay/settle/daily?date=2026-09-01 · 日终对账
 * 三向比对微信账单 / payments / split_ledger；有差异则冻结当日结算。
 */
router.get('/settle/daily', async (req, res) => {
  const raw = typeof req.query.date === 'string' ? req.query.date : undefined;
  const date = raw && /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? raw
    : new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  try {
    const report = await dailyReconcile(date);
    res.json(ok(report));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('[settle/daily] 失败', message);
    res.status(500).json(fail(message));
  }
});

/**
 * POST /api/pay/settle/payouts · 手动生成某日结算记录
 * 正常由对账通过（无差异）后自动调用，这里提供手动补救入口。
 */
router.post('/settle/payouts', async (req, res) => {
  const raw = typeof req.body?.date === 'string' ? req.body.date : undefined;
  const period = raw ? new Date(`${raw}T00:00:00`) : new Date();

  try {
    const payouts = await generatePayouts(period);
    res.json(ok({ created: payouts.length, payouts }));
  } catch (err) {
    res.status(500).json(fail(err instanceof Error ? err.message : String(err)));
  }
});

/** POST /api/pay/jobs/close-expired · 关闭超时未支付订单 */
router.post('/jobs/close-expired', async (_req, res) => {
  try {
    const count = await closeExpiredOrders();
    res.json(ok({ closed: count }));
  } catch (err) {
    res.status(500).json(fail(err instanceof Error ? err.message : String(err)));
  }
});

export default router;
