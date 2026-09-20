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
import type { BrandProfile } from '../contracts/brandProfile';

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

/** 编辑器变更新：在已生成的文档上做局部改写并落库（文档 §十八） */
export async function updateContentDocument(
  id: string | number | bigint,
  merchantId: string | number | bigint,
  data: {
    document: AnyV3Document | Record<string, unknown>;
    direction?: CreativeDirection;
    fingerprint?: CreativeFingerprint | null;
    evaluation?: unknown;
  }
) {
  return prisma.contentDocument.update({
    where: { id: toBigInt(id), merchantId: toBigInt(merchantId) },
    data: {
      document: data.document as unknown as object,
      ...(data.direction ? { direction: data.direction as unknown as object } : {}),
      ...(data.fingerprint !== undefined ? { fingerprint: (data.fingerprint ?? null) as unknown as object } : {}),
      ...(data.evaluation !== undefined ? { evaluation: (data.evaluation ?? null) as unknown as object } : {}),
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

/**
 * 文档 §二十四：拉取用于质量指标计算的文档（按 createdAt 倒序，最新在前）。
 * 只 select 指标需要的列，不把整表 JSON 都捞出来。
 */
export async function listDocumentsForMetrics(
  merchantId: string | number | bigint,
  scenario?: string | null,
  limit = 50
) {
  return prisma.contentDocument.findMany({
    where: {
      merchantId: toBigInt(merchantId),
      ...(scenario ? { scenario } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      scenario: true,
      status: true,
      createdAt: true,
      publishedAt: true,
      truthSnapshot: true,
      document: true,
      fingerprint: true,
    },
  });
}

/** 文档 §二十四：标记发布（Time-to-Publish 的时间基准点） */
export async function publishContentDocument(
  id: string | number | bigint,
  merchantId: string | number | bigint
) {
  return prisma.contentDocument.update({
    where: { id: toBigInt(id), merchantId: toBigInt(merchantId) },
    data: { status: 'published', publishedAt: new Date() },
  });
}

/**
 * 读取某商户的品牌档案（文档 §十三）。
 * 未设置时返回 null —— 调用方应据此回落到中性默认品牌语言，
 * 绝不把 BrandProfile 当成「所有俱乐部都是年轻/松弛/山系高级感」。
 */
export async function getBrandProfile(
  merchantId: string | number | bigint
): Promise<BrandProfile | null> {
  const row = await prisma.brandProfile.findUnique({
    where: { merchantId: toBigInt(merchantId) },
  });
  if (!row) return null;
  return {
    merchantId: String(row.merchantId),
    brandName: row.brandName,
    toneKeywords: row.toneKeywords ?? [],
    avoidKeywords: row.avoidKeywords ?? [],
    visualKeywords: row.visualKeywords ?? [],
    primaryColor: row.primaryColor,
    secondaryColor: row.secondaryColor,
    typographyPreference: row.typographyPreference,
    logo: row.logo,
    contentRules: row.contentRules,
  };
}

/** 新建或更新某商户的品牌档案（文档 §十三） */
export async function upsertBrandProfile(
  merchantId: string | number | bigint,
  input: {
    brandName?: string | null;
    toneKeywords?: string[];
    avoidKeywords?: string[];
    visualKeywords?: string[];
    primaryColor?: string | null;
    secondaryColor?: string | null;
    typographyPreference?: string | null;
    logo?: string | null;
    contentRules?: string | null;
  }
): Promise<BrandProfile> {
  const mid = toBigInt(merchantId);
  const row = await prisma.brandProfile.upsert({
    where: { merchantId: mid },
    create: {
      merchantId: mid,
      brandName: input.brandName ?? null,
      toneKeywords: input.toneKeywords ?? [],
      avoidKeywords: input.avoidKeywords ?? [],
      visualKeywords: input.visualKeywords ?? [],
      primaryColor: input.primaryColor ?? null,
      secondaryColor: input.secondaryColor ?? null,
      typographyPreference: input.typographyPreference ?? null,
      logo: input.logo ?? null,
      contentRules: input.contentRules ?? null,
    },
    update: {
      brandName: input.brandName ?? null,
      toneKeywords: input.toneKeywords ?? [],
      avoidKeywords: input.avoidKeywords ?? [],
      visualKeywords: input.visualKeywords ?? [],
      primaryColor: input.primaryColor ?? null,
      secondaryColor: input.secondaryColor ?? null,
      typographyPreference: input.typographyPreference ?? null,
      logo: input.logo ?? null,
      contentRules: input.contentRules ?? null,
    },
  });
  return {
    merchantId: String(row.merchantId),
    brandName: row.brandName,
    toneKeywords: row.toneKeywords ?? [],
    avoidKeywords: row.avoidKeywords ?? [],
    visualKeywords: row.visualKeywords ?? [],
    primaryColor: row.primaryColor,
    secondaryColor: row.secondaryColor,
    typographyPreference: row.typographyPreference,
    logo: row.logo,
    contentRules: row.contentRules,
  };
}
