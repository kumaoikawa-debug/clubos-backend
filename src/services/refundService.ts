import { prisma, logger } from '../lib';
import { wechatPay } from './wechatPay';

export interface RefundInput {
  orderNo: string;
  /** 退款金额（元）；不传则默认全额退 */
  refundAmount?: number;
  reason?: string;
}

/**
 * 退款流程：
 *   1. 校验订单已支付；
 *   2. 若已分账 → 按退款比例**先回退分账**（否则微信会拒绝退款）；
 *   3. 调微信原路退款；
 *   4. 订单转 refunded。
 */
export async function refundOrder(input: RefundInput) {
  const order = await prisma.order.findUnique({
    where: { orderNo: input.orderNo },
    include: { splits: { orderBy: { id: 'desc' } } },
  });

  if (!order) throw new Error('订单不存在');
  if (order.status !== 'paid') throw new Error(`订单状态为 ${order.status}，不可退款`);

  const total = Number(order.amount);
  const refundAmount = input.refundAmount ?? total;
  if (refundAmount <= 0 || refundAmount > total) throw new Error('退款金额超出订单金额');

  const payment = await prisma.payment.findFirst({
    where: { orderId: order.id },
    orderBy: { id: 'desc' },
  });
  if (!payment?.transactionId) throw new Error('缺少微信支付流水，无法退款');

  // 1) 已分账则按比例回退
  const ledger = order.splits.find((s) => s.status === 'success');
  if (ledger) {
    const ratio = refundAmount / total;
    const reverseAmount = Math.round(Number(ledger.merchantAmount) * ratio * 100) / 100;
    await wechatPay.reverseSplit({
      orderNo: order.orderNo,
      transactionId: payment.transactionId,
      amount: reverseAmount,
    });
    logger.info(`[refund] 已回退分账 ${reverseAmount} 元 orderNo=${order.orderNo}`);
  }

  // 2) 原路退款
  const result = await wechatPay.refund({
    orderNo: order.orderNo,
    transactionId: payment.transactionId,
    total,
    refundAmount,
    reason: input.reason,
  });

  // 3) 全额退款才转 refunded；部分退款保持 paid（业务上可按需扩展 partial_refunded）
  const isFull = Math.abs(refundAmount - total) < 0.01;
  await prisma.order.update({
    where: { id: order.id },
    data: isFull ? { status: 'refunded' } : {},
  });

  logger.info(`[refund] 退款成功 orderNo=${order.orderNo} 金额=${refundAmount} refundId=${result.refundId}`);
  return { refundId: result.refundId, refundAmount, status: result.state };
}
