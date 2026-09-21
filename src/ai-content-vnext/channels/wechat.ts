/**
 * 微信公众号渠道（§17 / §27）
 *
 * 共享 Activity Master，按公众号角度重新策划：标题 / 摘要 / 首屏 / 节奏 / 图片顺序 / 长文 / CTA。
 * 复用 planEditorial(channel='wechat') + generateBlocks（同一套 12 型 Block，但按公众号节奏重排），
 * 最后渲染成可直接粘贴公众号后台的 HTML。绝不复制活动详情页。
 */
import type { ChatFn } from '../chat';
import { planEditorial } from '../editorial';
import { generateBlocks } from '../generation';
import { checkFacts, scanFreeText } from '../grounding';
import type { ActivityMaster, SourceUnderstanding, WechatContent, GroundingReport } from '../types';
import { renderWechatHtml } from './renderHtml';

function deriveTitle(plan: { coreSellingIdea?: string; activityUnderstanding?: string }, blocks: { type: string; headline?: string }[], master: ActivityMaster): string {
  const hero = blocks.find((b) => b.type === 'hero');
  if (hero?.headline) return hero.headline;
  const t = (master.publicFacts?.title as string) || plan.coreSellingIdea || plan.activityUnderstanding || '活动报名';
  return t.slice(0, 31);
}

function deriveSummary(plan: { coreSellingIdea?: string; activityUnderstanding?: string }, master: ActivityMaster): string {
  const s = plan.coreSellingIdea || plan.activityUnderstanding || (master.publicFacts?.summary as string) || '';
  return s.slice(0, 54);
}

export async function generateWechat(
  merchantId: string,
  master: ActivityMaster,
  understanding: SourceUnderstanding,
  chat: ChatFn,
  instruction?: string,
  directionHint?: string
): Promise<{ content: WechatContent; grounding: GroundingReport }> {
  const plan = await planEditorial(merchantId, master, understanding, chat, 'wechat', directionHint);
  const { blocks } = await generateBlocks(merchantId, master, understanding, plan, chat, instruction);

  const title = deriveTitle(plan, blocks, master);
  const summary = deriveSummary(plan, master);
  const hero = blocks.find((b) => b.type === 'hero');
  const cta = blocks.find((b) => b.type === 'cta');
  const html = renderWechatHtml(blocks, { title, summary, master });

  const grounding = checkFacts(blocks, master, understanding);
  // 自由文本（标题 / 摘要）额外扫描
  const extra = scanFreeText(`${title}\n${summary}`, master);
  if (extra.length) {
    grounding.issues.push(...extra);
    grounding.passed = grounding.passed && extra.filter((i) => i.severity === 'block').length === 0;
  }

  const content: WechatContent = {
    title,
    summary,
    heroHeadline: hero?.headline || '',
    ctaText: cta?.ctaText || '立即报名',
    ctaAction: cta?.ctaAction || 'signup',
    blocks,
    html,
  };
  return { content, grounding };
}
