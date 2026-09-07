import { Router } from 'express';
import { ok, fail, logger } from '../lib';
import {
  createMallOrder,
  advanceCommission,
  settleClubCommissions,
  clubCommissionSummary,
  platformCommissionSummary,
} from '../services/commissionService';

const router = Router();

/**
 * POST /api/mall/orders · 俱乐部模拟下单（平台统一运营，订单归因到本俱乐部）
 * body: { items: [{ productId, qty? }], sourceType?, sourceId? }
 */
router.post('/orders', async (req, res) => {
  const clubId = Number(req.admin?.sub);
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!clubId || !items.length) {
    res.status(400).json(fail('缺少 clubId 或商品明细'));
    return;
  }
  try {
    const order = await createMallOrder({
      clubId,
      userId: req.body.userId,
      sourceType: req.body.sourceType,
      sourceId: req.body.sourceId,
      referrerClubId: req.body.referrerClubId ? Number(req.body.referrerClubId) : undefined,
      items: items.map((i: { productId: number; qty?: number }) => ({
        productId: Number(i.productId),
        qty: i.qty ? Number(i.qty) : 1,
      })),
    });
    res.json(ok(order));
  } catch (err) {
    res.status(500).json(fail(err instanceof Error ? err.message : String(err)));
  }
});

/**
 * GET /api/mall/commission/summary · 本俱乐部佣金看板（状态机各态汇总 + 阶梯）
 */
router.get('/commission/summary', async (req, res) => {
  const clubId = Number(req.admin?.sub);
  if (!clubId) {
    res.status(401).json(fail('未识别俱乐部'));
    return;
  }
  try {
    const summary = await clubCommissionSummary(clubId);
    res.json(ok(summary));
  } catch (err) {
    res.status(500).json(fail(err instanceof Error ? err.message : String(err)));
  }
});

/**
 * POST /api/mall/commission/advance · 推进某笔订单佣金状态机
 * body: { orderId, action: confirmReceive | release | settle | reverse }
 */
router.post('/commission/advance', async (req, res) => {
  const clubId = Number(req.admin?.sub);
  const orderId = Number(req.body?.orderId);
  const action = req.body?.action as 'confirmReceive' | 'release' | 'settle' | 'reverse';
  if (!clubId || !orderId || !action) {
    res.status(400).json(fail('缺少 orderId 或 action'));
    return;
  }
  try {
    const result = await advanceCommission(orderId, action);
    if (!result.ok) {
      res.status(409).json(fail(result.message));
      return;
    }
    res.json(ok(result));
  } catch (err) {
    res.status(500).json(fail(err instanceof Error ? err.message : String(err)));
  }
});

/**
 * POST /api/mall/commission/settle · 结算本俱乐部全部「可结算」佣金
 */
router.post('/commission/settle', async (req, res) => {
  const clubId = Number(req.admin?.sub);
  if (!clubId) {
    res.status(401).json(fail('未识别俱乐部'));
    return;
  }
  try {
    const result = await settleClubCommissions(clubId);
    res.json(ok(result));
  } catch (err) {
    res.status(500).json(fail(err instanceof Error ? err.message : String(err)));
  }
});

/**
 * GET /api/mall/admin/commission · 平台佣金结算总览（仅平台 admin）
 */
router.get('/admin/commission', async (req, res) => {
  if (req.admin?.role !== 'admin') {
    res.status(403).json(fail('仅平台可查看全局佣金'));
    return;
  }
  try {
    const summary = await platformCommissionSummary();
    res.json(ok(summary));
  } catch (err) {
    res.status(500).json(fail(err instanceof Error ? err.message : String(err)));
  }
});

/**
 * POST /api/mall/admin/commission/settle-all · 平台批量结算全部「可结算」佣金（跨俱乐部）
 */
router.post('/admin/commission/settle-all', async (req, res) => {
  if (req.admin?.role !== 'admin') {
    res.status(403).json(fail('仅平台可批量结算'));
    return;
  }
  try {
    const avail = await platformCommissionSummary();
    let settled = 0;
    let amount = 0;
    for (const clubIdStr of Object.keys(avail.byClub)) {
      const r = await settleClubCommissions(Number(clubIdStr));
      settled += r.settled;
      amount += r.amount;
    }
    logger.info(`[mall] 平台批量结算 ${settled} 笔，合计 ¥${amount}`);
    res.json(ok({ settled, amount }));
  } catch (err) {
    res.status(500).json(fail(err instanceof Error ? err.message : String(err)));
  }
});

export default router;
