import { prisma, logger } from '../lib';

/**
 * AI 额度服务（V2.0）
 *  - 对外只暴露「AI 积分」，内部按 token 折算（1 AI 积分 = TOKENS_PER_CREDIT 个 token）。
 *  - 额度分三层：base 每月基础额度（月清）、gift 商城销量里程碑赠送（月清）、paid 充值（不清零）。
 *  - 消耗顺序严格 base → gift → paid，绝不反向。
 */

/** 1 AI 积分 折算的 token 数 */
export const TOKENS_PER_CREDIT = 1000;
/** 每月基础额度（AI 积分） */
export const AI_BASE_MONTHLY = 1000;
/** 商城销量里程碑赠额（gift，月清） */
export const AI_MILESTONES = [
  { threshold: 10000, grant: 100 },
  { threshold: 50000, grant: 300 },
  { threshold: 100000, grant: 500 },
  { threshold: 500000, grant: 1000 },
];

function currentMonth(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function parseMilestones(json: string | null | undefined): Record<string, boolean> {
  try {
    const v = JSON.parse(json || '{}');
    return v && typeof v === 'object' ? (v as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

/** 取（并在首次访问时创建）额度账户，必要时执行月初刷新 */
export async function getAccount(clubId: bigint | string | number) {
  const cid = BigInt(clubId);
  const ym = currentMonth();
  let acc = await prisma.aiCreditAccount.findUnique({ where: { clubId: cid } });
  if (!acc) {
    acc = await prisma.aiCreditAccount.create({
      data: { clubId: cid, base: AI_BASE_MONTHLY, gift: 0, paid: 0, month: ym, milestones: '{}' },
    });
    await prisma.aiCreditLedger.create({
      data: {
        clubId: cid,
        type: 'refresh',
        delta: AI_BASE_MONTHLY,
        balance: AI_BASE_MONTHLY,
        note: '开户并下发每月基础额度',
      },
    });
    return acc;
  }
  // 跨月：base/gift 归位、里程碑标记清零，paid 保留
  if (acc.month !== ym) {
    acc = await prisma.aiCreditAccount.update({
      where: { clubId: cid },
      data: { base: AI_BASE_MONTHLY, gift: 0, month: ym, milestones: '{}' },
    });
    await prisma.aiCreditLedger.create({
      data: {
        clubId: cid,
        type: 'refresh',
        delta: AI_BASE_MONTHLY,
        balance: acc.base + acc.gift + acc.paid,
        note: '每月基础额度已刷新',
      },
    });
    logger.info(`[ai-credit] 月度刷新 club=${cid} month=${ym}`);
  }
  return acc;
}

export function balanceOf(acc: { base: number; gift: number; paid: number }): number {
  return acc.base + acc.gift + acc.paid;
}

/**
 * 消耗额度：按 base → gift → paid 顺序扣减。
 * @returns 扣减结果；余额不足返回 { ok: false }
 */
export async function consume(
  clubId: bigint | string | number,
  credits: number,
  note = 'AI 内容生成',
  tokens?: number
): Promise<{ ok: boolean; balance: number; consumed: number }> {
  const cid = BigInt(clubId);
  const acc = await getAccount(cid);
  const need = Math.max(0, Math.ceil(credits));
  if (balanceOf(acc) < need) {
    return { ok: false, balance: balanceOf(acc), consumed: 0 };
  }

  let left = need;
  let base = acc.base;
  let gift = acc.gift;
  let paid = acc.paid;

  if (base > 0) {
    const d = Math.min(base, left);
    base -= d;
    left -= d;
  }
  if (left > 0 && gift > 0) {
    const d = Math.min(gift, left);
    gift -= d;
    left -= d;
  }
  if (left > 0 && paid > 0) {
    const d = Math.min(paid, left);
    paid -= d;
    left -= d;
  }

  const updated = await prisma.aiCreditAccount.update({
    where: { clubId: cid },
    data: { base, gift, paid },
  });
  const balance = balanceOf(updated);
  await prisma.aiCreditLedger.create({
    data: { clubId: cid, type: 'consume', delta: -need, balance, note, tokens: tokens ?? null },
  });
  return { ok: true, balance, consumed: need };
}

/** 充值（paid，永不清零） */
export async function recharge(clubId: bigint | string | number, credits: number, note = '充值') {
  const cid = BigInt(clubId);
  const acc = await getAccount(cid);
  const amount = Math.max(0, Math.ceil(credits));
  const updated = await prisma.aiCreditAccount.update({
    where: { clubId: cid },
    data: { paid: acc.paid + amount },
  });
  const balance = balanceOf(updated);
  await prisma.aiCreditLedger.create({
    data: { clubId: cid, type: 'recharge', delta: amount, balance, note },
  });
  return { balance, recharged: amount };
}

/**
 * 商城销量里程碑实时赠额（gift，月清）。
 * @param monthSales 俱乐部本月商城 GMV（元）
 * @returns 本次新增赠送额度（已去重，同一里程碑每月只发一次）
 */
export async function grantMilestones(
  clubId: bigint | string | number,
  monthSales: number
): Promise<{ granted: number; hits: { threshold: number; grant: number }[] }> {
  const cid = BigInt(clubId);
  const acc = await getAccount(cid);
  const done = parseMilestones(acc.milestones);
  const hits: { threshold: number; grant: number }[] = [];
  let granted = 0;

  for (const m of AI_MILESTONES) {
    const key = `m${m.threshold}`;
    if (monthSales >= m.threshold && !done[key]) {
      done[key] = true;
      granted += m.grant;
      hits.push({ threshold: m.threshold, grant: m.grant });
    }
  }

  if (granted > 0) {
    const updated = await prisma.aiCreditAccount.update({
      where: { clubId: cid },
      data: { gift: acc.gift + granted, milestones: JSON.stringify(done) },
    });
    const balance = balanceOf(updated);
    await prisma.aiCreditLedger.create({
      data: {
        clubId: cid,
        type: 'grant',
        delta: granted,
        balance,
        note: `商城销量达 ¥${monthSales} 里程碑奖励`,
      },
    });
    logger.info(`[ai-credit] 里程碑赠额 club=${cid} +${granted}`);
  }
  return { granted, hits };
}

/** 汇总：余额、分层、流水 */
export async function summary(clubId: bigint | string | number, ledgerLimit = 20) {
  const cid = BigInt(clubId);
  const acc = await getAccount(cid);
  const ledger = await prisma.aiCreditLedger.findMany({
    where: { clubId: cid },
    orderBy: { createdAt: 'desc' },
    take: ledgerLimit,
  });
  return {
    balance: balanceOf(acc),
    base: acc.base,
    gift: acc.gift,
    paid: acc.paid,
    month: acc.month,
    milestones: parseMilestones(acc.milestones),
    ledger,
  };
}

/** token → AI 积分 折算（向上取整，至少 1 积分） */
export function creditsForTokens(tokens: number): number {
  return Math.max(1, Math.ceil(tokens / TOKENS_PER_CREDIT));
}
