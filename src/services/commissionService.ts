import { prisma, money, logger } from '../lib';
import { generateOrderNo } from '../lib';
import type { MallOrder, MallCommissionLedger, MallProduct } from '@prisma/client';

/**
 * V2.0 商城佣金服务
 *
 * 设计要点：
 * - 俱乐部佣金 = 商品级佣金（percentage 按比例 / fixed 固定），按 clubId 单级归因，非多级分销。
 * - 订单与佣金台账解耦于报名分账（SplitLedger）：这里是平台统一运营装备商城的俱乐部佣金。
 * - 状态机：pending(待确认) → frozen(冻结/售后期) → available(可结算) → settled(已结算) / reversed(退款冲销)。
 * - 阶梯 L1~L4 由 clubId 累计 GMV 自动判定，平台批量确认时落快照（仅用于结算档位记录，不改变商品级佣金）。
 */

export type CommissionStatus = 'pending' | 'frozen' | 'available' | 'settled' | 'reversed';

/** 状态机正向流转：每个非终态只能走到下一个态 */
const FORWARD: Record<CommissionStatus, CommissionStatus | null> = {
  pending: 'frozen',
  frozen: 'available',
  available: 'settled',
  settled: null,
  reversed: null,
};

/** GMV 阶梯阈值（元）：用于判定俱乐部 L1~L4 档位 */
export const TIER_THRESHOLDS: { tier: 'L1' | 'L2' | 'L3' | 'L4'; minGmv: number }[] = [
  { tier: 'L4', minGmv: 200_000 },
  { tier: 'L3', minGmv: 50_000 },
  { tier: 'L2', minGmv: 10_000 },
  { tier: 'L1', minGmv: 0 },
];

export function tierOf(gmv: number): 'L1' | 'L2' | 'L3' | 'L4' {
  for (const t of TIER_THRESHOLDS) if (gmv >= t.minGmv) return t.tier;
  return 'L1';
}

/** 单品佣金：percentage 按比例，fixed 固定（按数量累加） */
export function itemCommission(product: MallProduct, qty = 1): number {
  const base =
    product.commissionMode === 'fixed'
      ? Number(product.commissionValue)
      : Math.round(Number(product.retailPrice) * (Number(product.commissionValue) / 100));
  return money(base * qty);
}

export interface MallOrderItemInput {
  productId: number;
  qty?: number;
}

export interface CreateMallOrderInput {
  clubId: number;
  userId?: string;
  /** club_shop | ai_gear_list | activity | referrer | direct */
  sourceType?: string;
  sourceId?: string;
  referrerClubId?: number;
  items: MallOrderItemInput[];
}

/**
 * 创建商城订单 + 订单项 + 佣金台账（status=pending）。
 * 金额与佣金均从商品库反查，不信任前端传值；订单按 clubId 单级归因。
 */
export async function createMallOrder(input: CreateMallOrderInput): Promise<MallOrder> {
  if (!input.items?.length) throw new Error('订单至少要包含一个商品');

  const products = await prisma.mallProduct.findMany({
    where: { id: { in: input.items.map((i) => BigInt(i.productId)) } },
  });
  const byId = new Map(products.map((p) => [p.id, p]));

  let amount = 0;
  let commission = 0;
  const itemsData = input.items.map((i) => {
    const p = byId.get(BigInt(i.productId));
    if (!p) throw new Error(`商品不存在 productId=${i.productId}`);
    const qty = i.qty ?? 1;
    const price = Number(p.retailPrice);
    amount += price * qty;
    commission += itemCommission(p, qty);
    return {
      productId: p.id,
      title: p.title,
      price: p.retailPrice,
      qty,
    };
  });

  amount = money(amount);
  commission = money(commission);

  return prisma.$transaction(async (tx) => {
    const order = await tx.mallOrder.create({
      data: {
        orderNo: generateOrderNo(),
        clubId: BigInt(input.clubId),
        userId: input.userId,
        sourceType: input.sourceType ?? 'club_shop',
        sourceId: input.sourceId,
        referrerClubId: input.referrerClubId ? BigInt(input.referrerClubId) : null,
        amount,
        status: 'paid',
        items: { create: itemsData },
        ledger: {
          create: {
            clubId: BigInt(input.clubId),
            amount: commission,
            status: 'pending',
            tier: 'L1',
          },
        },
      },
      include: { ledger: true, items: true },
    });
    logger.info(`[mall] 创建商城订单 ${order.orderNo} clubId=${input.clubId} 佣金 ¥${commission}`);
    return order;
  });
}

export interface AdvanceResult {
  ok: boolean;
  status: CommissionStatus;
  message: string;
}

/**
 * 推进佣金状态机一步（正向）或冲销（退款）。
 * action: confirmReceive(pending→frozen) | release(frozen→available) | settle(available→settled) | reverse(→reversed)
 */
export async function advanceCommission(
  orderId: number,
  action: 'confirmReceive' | 'release' | 'settle' | 'reverse'
): Promise<AdvanceResult> {
  const ledger = await prisma.mallCommissionLedger.findUnique({ where: { orderId: BigInt(orderId) } });
  if (!ledger) return { ok: false, status: 'pending', message: '佣金台账不存在' };

  const cur = ledger.status as CommissionStatus;

  if (action === 'reverse') {
    if (cur === 'settled' || cur === 'reversed') {
      return { ok: false, status: cur, message: `当前状态「${cur}」不可冲销` };
    }
    await prisma.mallCommissionLedger.update({
      where: { orderId: BigInt(orderId) },
      data: { status: 'reversed', reversedAt: new Date() },
    });
    return { ok: true, status: 'reversed', message: '已冲销（退款），佣金归零' };
  }

  const target = action === 'settle' ? 'settled' : FORWARD[cur];
  if (!target) return { ok: false, status: cur, message: `当前状态「${cur}」无法执行 ${action}` };
  if (target === cur) return { ok: false, status: cur, message: '状态无变化' };

  const gmv = await clubGmv(Number(ledger.clubId));
  const update: Record<string, unknown> = { status: target };
  if (action === 'settle') {
    update.settledAt = new Date();
    update.tier = tierOf(gmv); // 结算时落阶梯快照
  }
  await prisma.mallCommissionLedger.update({ where: { orderId: BigInt(orderId) }, data: update });
  return { ok: true, status: target, message: `已流转至「${target}」` };
}

/** 平台批量结算某俱乐部全部「可结算」佣金 */
export async function settleClubCommissions(clubId: number): Promise<{ settled: number; amount: number }> {
  const gmv = await clubGmv(clubId);
  const avail = await prisma.mallCommissionLedger.findMany({
    where: { clubId: BigInt(clubId), status: 'available' },
  });
  if (!avail.length) return { settled: 0, amount: 0 };
  await prisma.mallCommissionLedger.updateMany({
    where: { clubId: BigInt(clubId), status: 'available' },
    data: { status: 'settled', settledAt: new Date(), tier: tierOf(gmv) },
  });
  const amount = avail.reduce((s, l) => s + Number(l.amount), 0);
  logger.info(`[mall] 批量结算 clubId=${clubId} ${avail.length} 笔，合计 ¥${money(amount)}`);
  return { settled: avail.length, amount: money(amount) };
}

/** 俱乐部累计商城 GMV（已支付订单） */
export async function clubGmv(clubId: number): Promise<number> {
  const agg = await prisma.mallOrder.aggregate({
    where: { clubId: BigInt(clubId), status: 'paid' },
    _sum: { amount: true },
  });
  return money(Number(agg._sum.amount ?? 0));
}

export interface CommissionSummary {
  pending: number;
  frozen: number;
  available: number;
  settled: number;
  reversed: number;
  totalPending: number; // pending + frozen + available
  gmv: number;
  tier: 'L1' | 'L2' | 'L3' | 'L4';
}

function sumByStatus(ledgers: MallCommissionLedger[]): Omit<CommissionSummary, 'totalPending' | 'gmv' | 'tier'> {
  const acc = { pending: 0, frozen: 0, available: 0, settled: 0, reversed: 0 };
  ledgers.forEach((l) => {
    if (l.status in acc) acc[l.status as keyof typeof acc] += Number(l.amount);
  });
  return acc;
}

export async function clubCommissionSummary(clubId: number): Promise<CommissionSummary> {
  const ledgers = await prisma.mallCommissionLedger.findMany({ where: { clubId: BigInt(clubId) } });
  const acc = sumByStatus(ledgers);
  const gmv = await clubGmv(clubId);
  const totalPending = money(acc.pending + acc.frozen + acc.available);
  return { ...acc, totalPending, gmv, tier: tierOf(gmv) };
}

export async function platformCommissionSummary(): Promise<CommissionSummary & { byClub: Record<string, number> }> {
  const ledgers = await prisma.mallCommissionLedger.findMany({});
  const acc = sumByStatus(ledgers);
  const totalPending = money(acc.pending + acc.frozen + acc.available);
  const byClub: Record<string, number> = {};
  ledgers.forEach((l) => {
    byClub[String(l.clubId)] = money((byClub[String(l.clubId)] ?? 0) + Number(l.amount));
  });
  return { ...acc, totalPending, gmv: 0, tier: 'L1', byClub };
}
