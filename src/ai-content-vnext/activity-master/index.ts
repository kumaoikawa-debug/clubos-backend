/**
 * STEP 2｜Activity Master（§6 STEP 2 / Task 5）
 *
 * 一场活动唯一数据母体。详情 / 宣发 / 回顾全部从这里读取。
 * 关键纪律：
 *   - publicFacts 由「活动主记录字段」+「Source Understanding 分类」合并，understanding 优先；
 *   - internalData 只来自理解分类（§7 B），绝不允许把成本 / 毛利塞进 publicFacts；
 *   - photos 携带 materialEvidence / eventFact（§20），原样保留供 grounding 与 Renderer 使用。
 */
import type { SourceUnderstanding, ActivityMaster, MediaRef, SourceMaterial } from '../types';

/** 活动主记录里常见的、应进入 publicFacts 的字段（白名单，避免把内部字段漏进 C 端） */
const PUBLIC_FIELD_MAP: Record<string, string> = {
  title: 'title',
  name: 'title',
  destination: 'destination',
  location: 'location',
  place: 'location',
  startDate: 'startDate',
  endDate: 'endDate',
  date: 'date',
  time: 'time',
  duration: 'duration',
  price: 'price',
  priceText: 'priceText',
  capacity: 'capacity',
  quota: 'quota',
  signupRule: 'signupRule',
  difficulty: 'difficulty',
  distance: 'distance',
  elevation: 'elevation',
  summary: 'summary',
  description: 'description',
};

export function buildActivityMaster(input: {
  activityId: string;
  activity?: Record<string, unknown>;
  understanding: SourceUnderstanding;
  photos?: MediaRef[];
}): ActivityMaster {
  const { activityId, activity, understanding, photos } = input;
  const a = activity || {};

  // 1) 主记录公开字段 → publicFacts（仅白名单字段）
  const publicFacts: Record<string, unknown> = {};
  for (const [srcKey, destKey] of Object.entries(PUBLIC_FIELD_MAP)) {
    if (a[srcKey] !== undefined && a[srcKey] !== null && a[srcKey] !== '') {
      publicFacts[destKey] = a[srcKey];
    }
  }
  // 2) 理解分类的 publicFacts 覆盖（模型从资料里读到的优先）
  Object.assign(publicFacts, understanding.publicFacts || {});

  // 3) internalData：严格只来自分类（绝不与主记录混用）
  const internalData: Record<string, unknown> = { ...(understanding.internalData || {}) };
  // 防御：若主记录里误带了成本类字段，不进 publicFacts，但也不自动进 internalData
  // （内部数据必须由理解分类显式判定，避免泄漏）

  const photos2: MediaRef[] = (photos || []).map((p) => ({
    ...p,
    materialEvidence: p.materialEvidence ?? false,
    eventFact: p.eventFact ?? false,
  }));

  const master: ActivityMaster = {
    activityId,
    publicFacts,
    itinerary: Array.isArray(a.itinerary) ? a.itinerary : [],
    fees: (a.fees && typeof a.fees === 'object' ? a.fees : (publicFacts.price ? { price: publicFacts.price } : {})) as Record<string, unknown>,
    checklist: Array.isArray(a.checklist) ? a.checklist : [],
    services: Array.isArray(a.services) ? a.services : [],
    photos: photos2,
    sourceMaterials: understanding.sourceMaterials as SourceMaterial[],
    sellingEvidence: understanding.promoMaterial || [],
    internalData,
    brandContext: (a.brand && typeof a.brand === 'object' ? a.brand : {}) as Record<string, unknown>,
    uncertainties: understanding.conflicts || [],
  };

  return master;
}
