import { Router } from 'express';
import { ok, fail } from '../lib';
import * as aiCredit from '../services/aiCreditService';
import { prisma } from '../lib';

const router = Router();

/** 充值套餐（paid，永不清零） */
export const RECHARGE_PKGS: { id: string; price: number; amount: number; label: string }[] = [
  { id: 'r1', price: 9.9, amount: 3000, label: '体验包' },
  { id: 'r2', price: 39, amount: 15000, label: '进阶包' },
];

/**
 * GET /api/ai-credit/summary · 本俱乐部 AI 额度总览
 * 对外只返回「AI 积分」，不暴露 token 概念。
 */
router.get('/summary', async (req, res) => {
  const clubId = Number(req.admin?.sub);
  if (!clubId) {
    res.status(401).json(fail('未登录'));
    return;
  }
  try {
    const s = await aiCredit.summary(clubId);
    // 本月商城 GMV，用于前端展示里程碑进度
    const monthKey = s.month;
    const orders = await prisma.mallOrder.findMany({
      where: { clubId: BigInt(clubId), status: 'paid' },
      select: { amount: true, createdAt: true },
    });
    const monthSales = orders
      .filter((o) => {
        const d = new Date(o.createdAt);
        const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
        return key === monthKey;
      })
      .reduce((sum, o) => sum + Number(o.amount), 0);

    res.json(
      ok({
        balance: s.balance,
        base: s.base,
        gift: s.gift,
        paid: s.paid,
        month: s.month,
        milestones: s.milestones,
        monthSales,
        milestoneDefs: aiCredit.AI_MILESTONES,
        rechargePkgs: RECHARGE_PKGS,
        ledger: s.ledger,
      })
    );
  } catch (err) {
    res.status(500).json(fail(err instanceof Error ? err.message : String(err)));
  }
});

/** POST /api/ai-credit/recharge · 充值（模拟，不接真实支付） */
router.post('/recharge', async (req, res) => {
  const clubId = Number(req.admin?.sub);
  const pkgId = String(req.body?.pkgId || '');
  const pkg = RECHARGE_PKGS.find((p) => p.id === pkgId);
  if (!clubId || !pkg) {
    res.status(400).json(fail('缺少 clubId 或套餐不存在'));
    return;
  }
  try {
    const r = await aiCredit.recharge(clubId, pkg.amount, `充值 ${pkg.label} ¥${pkg.price}`);
    res.json(ok({ ...r, pkg }));
  } catch (err) {
    res.status(500).json(fail(err instanceof Error ? err.message : String(err)));
  }
});

/** POST /api/ai-credit/milestones/check · 按本月商城销量触发里程碑赠额（幂等） */
router.post('/milestones/check', async (req, res) => {
  const clubId = Number(req.admin?.sub);
  const monthSales = Number(req.body?.monthSales || 0);
  if (!clubId) {
    res.status(401).json(fail('未登录'));
    return;
  }
  try {
    const r = await aiCredit.grantMilestones(clubId, monthSales);
    res.json(ok(r));
  } catch (err) {
    res.status(500).json(fail(err instanceof Error ? err.message : String(err)));
  }
});

export default router;
