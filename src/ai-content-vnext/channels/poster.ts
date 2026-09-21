/**
 * 海报内容结构（§17 / §27）
 *
 * 从 Activity Master「自动提取」海报需要的结构化字段，不依赖 LLM：
 *   活动名称 / 日期 / 地点 / 价格·参与方式 / 一句话卖点 / 2~3 个核心亮点 / 报名入口。
 * 亮点优先取自用户上传的宣传素材（sellingEvidence），缺则补行程 / 难度等母体字段。
 */
import type { ActivityMaster, PosterContent } from '../types';

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

export function generatePoster(master: ActivityMaster): PosterContent {
  const pf = master.publicFacts || {};

  const name = str(pf.title) || '户外活动';
  const date = str(pf.date) || str(pf.startDate) || str(pf.endDate) || '待定';
  const location = str(pf.location) || str(pf.destination) || str(pf.place) || '集合点待定';
  const priceText = str(pf.priceText) || (pf.price ? `¥${str(pf.price)}` : '价格待定');
  const participation = str(pf.signupRule) || '扫码 / 点击报名';

  // 卖点：宣传素材首条 > 摘要 > 兜底
  const evidenceTexts = (master.sellingEvidence || [])
    .map((e: unknown) => (typeof e === 'string' ? e : (e as { text?: string })?.text || ''))
    .map((t) => t.trim())
    .filter(Boolean);
  const sellingPoint = evidenceTexts[0] || str(pf.summary) || '一场值得出发的户外行程';

  // 亮点：宣传素材前 2~3 条
  const highlights: string[] = [];
  for (const t of evidenceTexts.slice(1, 4)) {
    if (t && !highlights.includes(t)) highlights.push(t);
  }
  // 素材不足则补母体字段亮点
  if (highlights.length < 2) {
    if (str(pf.distance) && !highlights.includes(`全程约 ${pf.distance}`)) highlights.push(`全程约 ${str(pf.distance)}`);
    if (str(pf.elevation) && !highlights.includes(`最高海拔 ${pf.elevation}`)) highlights.push(`最高海拔 ${str(pf.elevation)}`);
    if (str(pf.difficulty) && !highlights.includes(`难度 ${pf.difficulty}`)) highlights.push(`难度 ${pf.difficulty}`);
  }
  // 仍不足用行程首条兜底
  if (highlights.length < 2 && Array.isArray(master.itinerary) && master.itinerary.length) {
    const it = str(master.itinerary[0]);
    if (it && !highlights.includes(it)) highlights.push(it);
  }
  const finalHighlights = highlights.slice(0, 3);

  return {
    name,
    date,
    location,
    priceText,
    participation,
    sellingPoint,
    highlights: finalHighlights.length ? finalHighlights : [sellingPoint],
    signup: '扫码 / 点击左下角报名',
  };
}
