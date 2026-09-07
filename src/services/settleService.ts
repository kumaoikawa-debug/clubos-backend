import { prisma, logger } from '../lib';
import { wechatPay, type BillRow } from './wechatPay';

export interface ReconDiff {
  transactionId: string;
  orderNo: string;
  /** missing_in_db | amount_mismatch | status_mismatch */
  type: string;
  billAmount?: number;
  dbAmount?: number;
  detail: string;
}

/**
 * 日终对账：微信账单 vs payments vs split_ledger 三向比对。
 * 有差异 → 记录差异并冻结当日 payouts（人工核销后解冻）。
 */
export async function dailyReconcile(dateStr: string) {
  const day = new Date(`${dateStr}T00:00:00+08:00`);
  const nextDay = new Date(day.getTime() + 24 * 60 * 60 * 1000);

  const bill: BillRow[] = await wechatPay.downloadBill({ date: dateStr });

  const payments = await prisma.payment.findMany({
    where: { paidAt: { gte: day, lt: nextDay } },
    include: { order: { select: { orderNo: true } } },
  });

  const diffs: ReconDiff[] = [];
  const billMap = new Map(bill.map((r) => [r.transactionId, r]));
  const dbMap = new Map(
    payments.filter((p) => p.transactionId).map((p) => [p.transactionId as string, p])
  );

  // 1) 微信有、库里没有
  for (const row of bill) {
    if (!dbMap.has(row.transactionId)) {
      diffs.push({
        transactionId: row.transactionId,
        orderNo: row.orderNo,
        type: 'missing_in_db',
        billAmount: row.amount,
        detail: '微信账单存在但该笔支付流水缺失（可能回调丢失）',
      });
    }
  }

  // 2) 库里有、微信没有 → 高度可疑（可能是伪造回调）
  for (const p of payments) {
    if (!p.transactionId) continue;
    const row = billMap.get(p.transactionId);
    if (!row) {
      diffs.push({
        transactionId: p.transactionId,
        orderNo: p.order.orderNo,
        type: 'missing_in_bill',
        dbAmount: Number(p.amount),
        detail: '库中存在但该笔不在微信账单（需人工核查）',
      });
      continue;
    }
    if (Math.abs(row.amount - Number(p.amount)) > 0.01) {
      diffs.push({
        transactionId: p.transactionId,
        orderNo: p.order.orderNo,
        type: 'amount_mismatch',
        billAmount: row.amount,
        dbAmount: Number(p.amount),
        detail: '金额不一致',
      });
    }
  }

  const clean = diffs.length === 0;
  logger.info(`[settle] ${dateStr} 对账完成：账单 ${bill.length} 笔 / 库 ${payments.length} 笔 / 差异 ${diffs.length} 笔`);

  // 有差异则冻结当日结算，人工核销后解冻
  if (clean) {
    await generatePayouts(day);
  } else {
    logger.warn(`[settle] ${dateStr} 存在 ${diffs.length} 笔差异，已冻结当日结算，等待人工核销`);
  }

  return { date: dateStr, billCount: bill.length, dbCount: payments.length, diffs, clean };
}

/** 按商户汇总已分账金额，生成 T+1 待结算记录 */
export async function generatePayouts(period: Date) {
  const day = new Date(period);
  day.setHours(0, 0, 0, 0);

  const splits = await prisma.splitLedger.findMany({
    where: { status: 'success', splitAt: { gte: day, lt: new Date(day.getTime() + 86400000) } },
    include: { order: { select: { merchantId: true } } },
  });

  const byMerchant = new Map<bigint, number>();
  for (const s of splits) {
    const mid = s.order.merchantId;
    byMerchant.set(mid, (byMerchant.get(mid) ?? 0) + Number(s.merchantAmount));
  }

  const created = [];
  for (const [merchantId, amount] of byMerchant) {
    const payout = await prisma.payout.upsert({
      where: { merchantId_period: { merchantId, period: day } },
      create: { merchantId, amount, period: day, status: 'pending' },
      update: { amount },
    });
    created.push(payout);
  }

  logger.info(`[settle] 生成 T+1 结算记录 ${created.length} 条`);
  return created;
}
