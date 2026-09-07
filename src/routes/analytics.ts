import { Router } from 'express';
import { ok, fail, prisma } from '../lib';

const router = Router();

/**
 * GET /api/analytics/overview
 * 俱乐部数据运营概览：北极星指标「每 100 报名 → 商城 GMV」+ 转化/佣金 + 商品排行 + 俱乐部排行。
 * 口径与前端 Demo 一致：冲销（reversed）订单不计入 GMV。
 */
router.get('/overview', async (req, res) => {
  const clubId = Number(req.admin?.sub);
  if (!clubId) {
    res.status(401).json(fail('未登录'));
    return;
  }
  const cid = BigInt(clubId);
  try {
    // 报名人次 = Σ(adults + children)，只统计已支付/已完成
    const signupAgg = await prisma.order.aggregate({
      where: { merchantId: cid, status: { in: ['paid', 'refunded'] } },
      _sum: { adults: true, children: true },
      _count: { _all: true },
    });
    const signupOrders = await prisma.order.findMany({
      where: { merchantId: cid, status: { in: ['paid', 'refunded'] } },
      select: { adults: true, children: true },
    });
    const people = signupOrders.reduce(
      (s, o) => s + (o.adults || 0) + (o.children || 0),
      0
    );

    // 商城 GMV（排除冲销）
    const mallOrders = await prisma.mallOrder.findMany({
      where: { clubId: cid, status: 'paid' },
      select: { id: true, amount: true, createdAt: true },
    });
    const commissions = await prisma.mallCommissionLedger.findMany({
      where: { clubId: cid },
      select: { orderId: true, status: true, amount: true },
    });
    const reversedOrderIds = new Set(
      commissions.filter((c) => c.status === 'reversed').map((c) => c.orderId.toString())
    );
    const validOrders = mallOrders.filter((o) => !reversedOrderIds.has(o.id.toString()));
    const gmv = validOrders.reduce((s, o) => s + Number(o.amount), 0);
    const per100 = people > 0 ? (gmv / people) * 100 : 0;
    const conversion = people > 0 ? (validOrders.length / people) * 100 : 0;

    // 佣金分状态汇总
    const commissionByStatus = commissions.reduce<Record<string, number>>((acc, c) => {
      acc[c.status] = (acc[c.status] ?? 0) + Number(c.amount);
      return acc;
    }, {});

    // 商品排行（按成交额）
    const items = await prisma.mallOrderItem.findMany({
      where: { order: { clubId: cid, status: 'paid' } },
      select: { productId: true, title: true, price: true, qty: true, orderId: true },
    });
    const reversedSet = reversedOrderIds;
    const prodMap = new Map<
      string,
      { productId: string; title: string; qty: number; amount: number }
    >();
    for (const it of items) {
      if (reversedSet.has(it.orderId.toString())) continue;
      const key = it.productId.toString();
      const cur = prodMap.get(key) ?? {
        productId: key,
        title: it.title,
        qty: 0,
        amount: 0,
      };
      cur.qty += it.qty;
      cur.amount += Number(it.price) * it.qty;
      prodMap.set(key, cur);
    }
    const productRank = [...prodMap.values()].sort((a, b) => b.amount - a.amount).slice(0, 10);

    // 俱乐部排行（每 100 报名 GMV）
    const clubs = await prisma.merchant.findMany({
      where: { status: 'active' },
      select: { id: true, name: true },
      take: 50,
    });
    const rows: { name: string; signups: number; gmv: number; per100: number; isMe: boolean }[] = [];
    for (const c of clubs) {
      const so = await prisma.order.findMany({
        where: { merchantId: c.id, status: { in: ['paid', 'refunded'] } },
        select: { adults: true, children: true },
      });
      const mo = await prisma.mallOrder.findMany({
        where: { clubId: c.id, status: 'paid' },
        select: { id: true, amount: true },
      });
      const cm = await prisma.mallCommissionLedger.findMany({
        where: { clubId: c.id, status: 'reversed' },
        select: { orderId: true },
      });
      const rs = new Set(cm.map((x) => x.orderId.toString()));
      const clubGmv = mo.filter((o) => !rs.has(o.id.toString())).reduce((s, o) => s + Number(o.amount), 0);
      const clubPeople = so.reduce((s, o) => s + (o.adults || 0) + (o.children || 0), 0);
      rows.push({
        name: c.name,
        signups: clubPeople,
        gmv: clubGmv,
        per100: clubPeople > 0 ? (clubGmv / clubPeople) * 100 : 0,
        isMe: c.id === cid,
      });
    }
    const clubRank = rows.sort((a, b) => b.per100 - a.per100).slice(0, 10);

    res.json(
      ok({
        people,
        signupOrderCount: signupAgg._count?._all ?? 0,
        mallOrderCount: validOrders.length,
        gmv,
        per100,
        conversion,
        commissionByStatus,
        productRank,
        clubRank,
      })
    );
  } catch (err) {
    res.status(500).json(fail(err instanceof Error ? err.message : String(err)));
  }
});

export default router;
