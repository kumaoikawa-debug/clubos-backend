/**
 * 朋友圈 / 微信群轻量输出（§17）
 *
 * 从同一 Activity Master 派生一段轻量邀约文案，确定性、不依赖 LLM。
 * 与海报共用提取逻辑（卖点 / 亮点），但语气更口语、更短。
 */
import type { ActivityMaster, MomentsContent } from '../types';
import { generatePoster } from './poster';

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

export function generateMoments(master: ActivityMaster): MomentsContent {
  const pf = master.publicFacts || {};
  const poster = generatePoster(master);

  const name = str(pf.title) || '户外活动';
  const date = str(pf.date) || str(pf.startDate) || '本周末';
  const location = str(pf.location) || str(pf.destination) || '';

  const lead = location ? `${date}，${location}的「${name}」` : `${date}，「${name}」`;
  const point = poster.sellingPoint ? `——${poster.sellingPoint}` : '';
  const text = `${lead}开放报名啦${point}\n${poster.participation}，${poster.priceText}。`;

  return {
    text,
    signup: poster.participation,
  };
}
