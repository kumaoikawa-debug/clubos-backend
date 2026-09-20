/**
 * Content Engine V3 —— 持久化仓储
 * 对应文档 §十七 Prisma：ContentDocument / CreativeMemory
 * scope = merchantId + scenario，CreativeMemory 每类保留最近 20 条以上。
 */

import { prisma } from '../../lib';
import type { CreativeFingerprint } from '../contracts/fingerprints';
import type { CreativeDirection } from '../contracts/creativeDirection';
import type { PromoDocument } from '../contracts/promoDocument';
import type { ActivityTruth } from '../contracts/activityTruth';
import type { WechatDocument, XiaohongshuDocument, RecapDocument } from '../contracts/channels';

/** V3 四个 scenario 的文档都可入库 —— document 列是 Json，落库不看具体形状 */
export type AnyV3Document =
  | PromoDocument
  | WechatDocument
  | XiaohongshuDocument
  | RecapDocument;

export type Scenario = 'detail' | 'wechat' | 'xiaohongshu' | 'recap';

function toBigInt(v: string | number | bigint): bigint {
  if (typeof v === 'bigint') return v;
  return BigInt(String(v));
}

/**
 * 活动 id 可能是 'act-1' 这种非数字（前端草稿期常见），
 * 直接 BigInt() 会抛错 —— 之前被上层 try/catch 静默吞掉，表现为「生成成功但查不到」。
 * 这里降级为 null（DB 列允许 NULL，document JSON 内部仍保留原 activityId）。
 */
function toBigIntOrNull(v: string | number | bigint | null | undefined): bigint | null {
  if (v === null || v === undefined || v === '') return null;
  try {
    return toBigInt(v);
  } catch {
    return null;
  }
}

export interface SaveDocumentInput {
  merchantId: string | number | bigint;
  activityId?: string | number | bigint | null;
  scenario: Scenario;
  truth: ActivityTruth;
  direction: CreativeDirection;
  document: AnyV3Document | Record<string, unknown>;
  fingerprint?: CreativeFingerprint;
  evaluation?: unknown;
}

export async function saveContentDocument(input: SaveDocumentInput) {
  return prisma.contentDocument.create({
    data: {
      merchantId: toBigInt(input.merchantId),
      activityId: toBigIntOrNull(input.activityId),
      scenario: input.scenario,
      schemaVersion: 3,
      status: 'draft',
      truthSnapshot: input.truth as unknown as object,
      direction: input.direction as unknown as object,
      document: input.document as unknown as object,
      fingerprint: (input.fingerprint ?? null) as unknown as object,
      evaluation: (input.evaluation ?? null) as unknown as object,
    },
  });
}

export async function appendCreativeMemory(
  merchantId: string | number | bigint,
  scenario: Scenario,
  fingerprint: CreativeFingerprint,
  activityId?: string | number | bigint | null
) {
  return prisma.creativeMemory.create({
    data: {
      merchantId: toBigInt(merchantId),
      activityId: toBigIntOrNull(activityId),
      scenario,
      fingerprint: fingerprint as unknown as object,
    },
  });
}

/** 读取最近 N 条指纹（反重复用） */
export async function listRecentFingerprints(
  merchantId: string | number | bigint,
  scenario: Scenario,
  limit = 20
): Promise<CreativeFingerprint[]> {
  const rows = await prisma.creativeMemory.findMany({
    where: { merchantId: toBigInt(merchantId), scenario },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  return rows.map((r) => r.fingerprint as unknown as CreativeFingerprint);
}

export async function getLatestDocument(
  merchantId: string | number | bigint,
  scenario: Scenario,
  activityId?: string | number | bigint | null
) {
  const where: Record<string, unknown> = { merchantId: toBigInt(merchantId), scenario };
  const aid = toBigIntOrNull(activityId);
  if (aid !== null) {
    where.activityId = aid;
  } else if (activityId !== null && activityId !== undefined && String(activityId) !== '') {
    /**
     * ★ 非数字 activityId（草稿期 'a-123' / 'smoke-v3-1' 等）写不进 BigInt 列，
     *   DB.activityId 恒为 NULL。此时**绝不能丢掉过滤条件**——否则
     *   ① 查 A 活动会返回 B 活动的内容；② 连不存在的 id 也会返回最新一篇（线上实测）。
     *   改为按入库 JSON 内保留的原始 activityId 精确匹配（truth / document 两处任一命中），
     *   新旧数据都覆盖，且无需改表结构。
     */
    const key = String(activityId);
    where.OR = [
      { truthSnapshot: { path: ['activityId'], equals: key } },
      { document: { path: ['activityId'], equals: key } },
    ];
  }
  return prisma.contentDocument.findFirst({ where, orderBy: { createdAt: 'desc' } });
}
