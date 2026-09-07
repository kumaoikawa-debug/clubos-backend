import { prisma, logger } from '../lib';
import { wechatPay } from './wechatPay';

const MAX_RETRY = 3;

/**
 * 对某笔订单发起分账。
 * 幂等：仅处理 status=pending / failed 的台账，success 直接跳过。
 */
export async function applySplitForOrder(orderNo: string) {
  const ledger = await prisma.splitLedger.findFirst({
    where: { order: { orderNo } },
    include: {
      order: { include: { merchant: true } },
    },
    orderBy: { id: 'desc' },
  });

  if (!ledger) throw new Error(`分账台账不存在 orderNo=${orderNo}`);
  if (ledger.status === 'success') {
    logger.info(`[split] 已分账成功，跳过 orderNo=${orderNo}`);
    return { skipped: true };
  }

  const payment = await prisma.payment.findFirst({
    where: { orderId: ledger.orderId },
    orderBy: { id: 'desc' },
  });
  if (!payment?.transactionId) throw new Error(`缺少微信支付流水 orderNo=${orderNo}`);

  const subMchId = ledger.order.merchant.wechatSubMchId;
  if (!subMchId) {
    // 俱乐部未完成特约商户进件，无法分账
    await prisma.splitLedger.update({
      where: { id: ledger.id },
      data: { status: 'failed', failReason: '俱乐部未配置 wechat_sub_mch_id（未完成进件）' },
    });
    throw new Error('俱乐部未配置 wechat_sub_mch_id，无法分账');
  }

  try {
    const result = await wechatPay.applySplit({
      orderNo,
      transactionId: payment.transactionId,
      subMchId,
      merchantAmount: Number(ledger.merchantAmount),
      platformFee: Number(ledger.platformFee),
    });

    if (result.state === 'FAILED') {
      throw new Error(`微信分账返回 FAILED outOrderNo=${result.outOrderNo}`);
    }

    await prisma.splitLedger.update({
      where: { id: ledger.id },
      data: {
        status: 'success',
        splitAt: new Date(),
        failReason: null,
      },
    });

    logger.info(
      `[split] 分账成功 orderNo=${orderNo} 俱乐部=${ledger.merchantAmount} 平台=${ledger.platformFee}`
    );
    return { success: true, outOrderNo: result.outOrderNo };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.splitLedger.update({
      where: { id: ledger.id },
      data: {
        status: 'failed',
        failReason: message,
        retryCount: { increment: 1 },
      },
    });
    logger.error(`[split] 分账失败 orderNo=${orderNo} 原因=${message}`);
    throw err;
  }
}

/** 重试失败的分账（建议用定时任务 1m / 5m / 30m 指数退避调用） */
export async function retryFailedSplits() {
  const failed = await prisma.splitLedger.findMany({
    where: { status: 'failed', retryCount: { lt: MAX_RETRY } },
    include: { order: { select: { orderNo: true } } },
  });

  let recovered = 0;
  let stillFailed = 0;

  for (const ledger of failed) {
    try {
      await applySplitForOrder(ledger.order.orderNo);
      recovered += 1;
    } catch {
      stillFailed += 1;
    }
  }

  logger.info(`[job] 分账重试 成功=${recovered} 仍失败=${stillFailed}`);
  return { recovered, stillFailed };
}
