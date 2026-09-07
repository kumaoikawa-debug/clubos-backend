import { prisma, logger } from '../lib';

/**
 * 会员引擎：订阅 / 积分 / 复购推荐 / 流失提醒。
 * 订阅成功后把 merchant.plan 置为 member、commissionRate 置 0（免抽成）。
 */

export const PLAN_PRICE = { monthly: 199, yearly: 1799 } as const;

export type Cycle = keyof typeof PLAN_PRICE;

export async function subscribe(merchantId: bigint | string, cycle: Cycle) {
  const mid = BigInt(merchantId);
  const amount = PLAN_PRICE[cycle];
  const days = cycle === 'yearly' ? 365 : 30;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  const sub = await prisma.subscription.create({
    data: { merchantId: mid, plan: 'member', cycle, amount, status: 'active', expiresAt },
  });
  await prisma.merchant.update({
    where: { id: mid },
    data: { plan: 'member', commissionRate: 0 },
  });

  logger.info(`[member] 订阅成功 merchant=${mid} cycle=${cycle} expire=${expiresAt.toISOString().slice(0, 10)}`);
  return sub;
}

export async function getStatus(merchantId: bigint | string) {
  const mid = BigInt(merchantId);
  const sub = await prisma.subscription.findFirst({
    where: { merchantId: mid, status: 'active', expiresAt: { gt: new Date() } },
    orderBy: { id: 'desc' },
  });
  const agg = await prisma.pointLedger.aggregate({ where: { merchantId: mid }, _sum: { change: true } });
  const merchant = await prisma.merchant.findUnique({
    where: { id: mid },
    select: { plan: true, name: true },
  });
  return {
    plan: merchant?.plan ?? 'free',
    subscription: sub,
    points: agg._sum.change ?? 0,
  };
}

/** 订单支付成功后给俱乐部加积分（按成交金额取整，幂等） */
export async function earnPointsForOrder(orderNo: string) {
  const order = await prisma.order.findUnique({
    where: { orderNo },
    include: { merchant: true },
  });
  if (!order || order.status !== 'paid') return null;

  const reason = `order:${orderNo}`;
  const existing = await prisma.pointLedger.findFirst({ where: { merchantId: order.merchantId, reason } });
  if (existing) return existing; // 幂等，避免重复加积分

  const change = Math.max(1, Math.round(Number(order.amount)));
  const prev = await prisma.pointLedger.aggregate({
    where: { merchantId: order.merchantId },
    _sum: { change: true },
  });
  const balance = (prev._sum.change ?? 0) + change;

  logger.info(`[member] 订单 ${orderNo} 加积分 ${change}（余额 ${balance}）`);
  return prisma.pointLedger.create({
    data: { merchantId: order.merchantId, change, balance, reason },
  });
}

/** 复购推荐 + 流失提醒洞察 */
export async function getInsights(merchantId: bigint | string) {
  const mid = BigInt(merchantId);
  const merchant = await prisma.merchant.findUnique({
    where: { id: mid },
    include: {
      activities: { where: { status: 'published' }, orderBy: { startsAt: 'asc' }, take: 5 },
    },
  });
  const lastOrder = await prisma.order.findFirst({
    where: { merchantId: mid, status: 'paid' },
    orderBy: { paidAt: 'desc' },
  });
  const sub = await prisma.subscription.findFirst({
    where: { merchantId: mid, status: 'active' },
    orderBy: { id: 'desc' },
  });
  const daysToExpire = sub
    ? Math.ceil((sub.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000))
    : null;
  const churnRisk = daysToExpire !== null && daysToExpire <= 7;

  return {
    upcomingActivities: (merchant?.activities ?? []).map((a) => ({
      id: a.id.toString(),
      title: a.title,
      startsAt: a.startsAt,
    })),
    lastParticipatedAt: lastOrder?.paidAt ?? null,
    subscriptionExpiresInDays: daysToExpire,
    churnRisk,
    repurchaseHint: churnRisk ? '会员即将到期，建议推送续费优惠' : '可推送近期活动促进复购',
  };
}
