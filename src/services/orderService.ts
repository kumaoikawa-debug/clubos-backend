import { prisma, generateOrderNo, money, logger } from '../lib';
import { config } from '../config';
import { applySplitForOrder } from './splitService';
import { earnPointsForOrder } from './membershipService';

export interface CreateOrderInput {
  activityId: number;
  openid?: string;
  buyer: { name: string; phone: string; idType: string; idNumber: string };
  adults: number;
  children: number;
}

/** 建 pending 订单：金额 = 单价 × 人数，merchantId 从活动反查，不信任前端传值 */
export async function createPendingOrder(input: CreateOrderInput) {
  const activity = await prisma.activity.findUnique({
    where: { id: BigInt(input.activityId) },
    include: { merchant: true },
  });

  if (!activity) throw new Error('活动不存在');
  if (activity.status !== 'published') throw new Error('活动未发布，无法报名');
  if (activity.merchant.status !== 'active') throw new Error('该俱乐部已暂停服务');

  const seats = input.adults + input.children;
  if (seats <= 0) throw new Error('报名人数必须大于 0');

  const amount = money(Number(activity.price) * seats);

  return prisma.order.create({
    data: {
      orderNo: generateOrderNo(),
      activityId: activity.id,
      merchantId: activity.merchantId,
      openid: input.openid,
      buyerName: input.buyer.name,
      phone: input.buyer.phone,
      idType: input.buyer.idType,
      idNumber: input.buyer.idNumber,
      adults: input.adults,
      children: input.children,
      amount,
    },
  });
}

export async function getOrderByNo(orderNo: string) {
  return prisma.order.findUnique({
    where: { orderNo },
    select: {
      orderNo: true,
      status: true,
      amount: true,
      paidAt: true,
      activityId: true,
      merchantId: true,
    },
  });
}

export interface PayNotifyInput {
  transactionId: string;
  orderNo: string;
  raw?: unknown;
}

/**
 * 支付回调处理：**幂等**是这里的生命线。
 * 微信会对同一笔支付重投多次，必须保证只入账一次、只分账一次。
 */
export async function handlePayNotify(input: PayNotifyInput) {
  // 1) 幂等第一道闸：transaction_id 已入账 → 直接返回
  const existing = await prisma.payment.findUnique({
    where: { transactionId: input.transactionId },
    select: { id: true, paidAt: true },
  });
  if (existing?.paidAt) {
    logger.info(`[notify] 重复回调已忽略 transactionId=${input.transactionId}`);
    return { duplicated: true };
  }

  const order = await prisma.order.findUnique({
    where: { orderNo: input.orderNo },
    include: { merchant: true },
  });
  if (!order) throw new Error(`订单不存在 orderNo=${input.orderNo}`);

  // 2) 幂等第二道闸：订单已支付 → 直接返回
  if (order.status === 'paid') {
    logger.info(`[notify] 订单已支付，忽略重复回调 orderNo=${input.orderNo}`);
    return { duplicated: true };
  }

  // 3) 费率：会员版免抽成
  const rate =
    order.merchant.plan === 'member'
      ? 0
      : Number(order.merchant.commissionRate ?? config.defaultCommissionRate);

  const total = Number(order.amount);
  const platformFee = money(total * rate);
  const merchantAmount = money(total - platformFee);

  // 4) 事务：写支付流水 + 订单转 paid + 建分账台账
  await prisma.$transaction(async (tx) => {
    await tx.payment.create({
      data: {
        orderId: order.id,
        transactionId: input.transactionId,
        amount: order.amount,
        channel: 'wechat',
        paidAt: new Date(),
        rawCallback: (input.raw ?? null) as never,
      },
    });

    await tx.order.update({
      where: { id: order.id },
      data: { status: 'paid', paidAt: new Date() },
    });

    await tx.splitLedger.create({
      data: {
        orderId: order.id,
        amountTotal: order.amount,
        merchantAmount,
        platformFee,
        rate,
        status: 'pending',
      },
    });
  });

  // 5) 触发分账（失败不抛错，进重试队列，不影响用户报名成功）
  try {
    await applySplitForOrder(order.orderNo);
  } catch (err) {
    logger.error(`[notify] 首次分账失败，转入重试队列 orderNo=${order.orderNo}`, err);
  }

  // 6) 会员积分（按成交金额，幂等）
  try {
    await earnPointsForOrder(order.orderNo);
  } catch (err) {
    logger.error(`[notify] 积分发放失败 orderNo=${order.orderNo}`, err);
  }

  return { duplicated: false, orderNo: order.orderNo };
}

/** 关闭超时未支付订单（供定时任务调用） */
export async function closeExpiredOrders() {
  const deadline = new Date(Date.now() - config.orderExpireMinutes * 60 * 1000);
  const result = await prisma.order.updateMany({
    where: { status: 'pending', createdAt: { lt: deadline } },
    data: { status: 'closed', closedAt: new Date() },
  });
  logger.info(`[job] 关闭超时订单 ${result.count} 笔`);
  return result.count;
}
