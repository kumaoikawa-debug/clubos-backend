/**
 * 小红书渠道（§17 / §27）
 *
 * 共享 Activity Master，按小红书用户独立策划：标题（关键词 + 情绪 + 干货感）/ Hook（前两行抓眼球）/
 * 正文（口语化有干货）/ 首图 / 图片顺序 / 标签 / CTA。绝不写成公众号缩短版。
 * 复用 planEditorial(channel='xiaohongshu') + generateBlocks，再从 blocks 派生小红书字段。
 */
import type { ChatFn } from '../chat';
import { planEditorial } from '../editorial';
import { generateBlocks } from '../generation';
import { checkFacts, scanFreeText } from '../grounding';
import type { ActivityMaster, SourceUnderstanding, XiaohongshuContent, GroundingReport, PromoBlock } from '../types';

function deriveTags(master: ActivityMaster): string[] {
  const pf = master.publicFacts || {};
  const tags: string[] = [];
  if (typeof pf.destination === 'string' && pf.destination) tags.push(`#${pf.destination}`);
  if (typeof pf.difficulty === 'string' && pf.difficulty) tags.push(`#${pf.difficulty}徒步`);
  if (typeof pf.location === 'string' && pf.location) tags.push(`#${pf.location}`);
  tags.push('#户外'); // 通用，非编造
  tags.push('#周末去哪儿');
  tags.push('#小众旅行');
  return tags.slice(0, 6);
}

export async function generateXiaohongshu(
  merchantId: string,
  master: ActivityMaster,
  understanding: SourceUnderstanding,
  chat: ChatFn,
  instruction?: string,
  directionHint?: string
): Promise<{ content: XiaohongshuContent; grounding: GroundingReport }> {
  const plan = await planEditorial(merchantId, master, understanding, chat, 'xiaohongshu', directionHint);
  const { blocks } = await generateBlocks(merchantId, master, understanding, plan, chat, instruction);

  const hero = blocks.find((b) => b.type === 'hero');
  const title = (hero?.headline || plan.coreSellingIdea || (master.publicFacts?.title as string) || '周末去哪儿')
    .toString()
    .slice(0, 20);

  // Hook：开头抓眼球的两行 = 第一条 text / statement 文案
  const hookBlock = blocks.find((b) => (b.type === 'text' || b.type === 'statement' || b.type === 'quote') && b.text) as
    | PromoBlock
    | undefined;
  const hook = (hookBlock?.text || plan.activityUnderstanding || '').toString().slice(0, 60);

  // 正文：口语化拼接 text / statement / quote
  const bodyParts = blocks
    .filter((b) => (b.type === 'text' || b.type === 'statement' || b.type === 'quote') && b.text)
    .map((b) => b.text as string);
  let body = bodyParts.join('\n\n');
  if (!body.trim()) body = plan.coreSellingIdea || '';

  const cta = blocks.find((b) => b.type === 'cta');
  const cover = blocks.find((b) => b.mediaRefs && b.mediaRefs.length) as PromoBlock | undefined;
  const coverCaption = cover?.caption || '';

  // 图片顺序：按出现顺序收集所有图片 block 的 mediaRefs
  const imageOrder: string[] = [];
  blocks.forEach((b) => {
    (b.mediaRefs || []).forEach((id) => {
      if (!imageOrder.includes(id)) imageOrder.push(id);
    });
  });

  const tags = deriveTags(master);

  const grounding = checkFacts(blocks, master, understanding);
  const extra = scanFreeText(`${title}\n${hook}\n${body}\n${tags.join(' ')}`, master);
  if (extra.length) {
    grounding.issues.push(...extra);
    grounding.passed = grounding.passed && extra.filter((i) => i.severity === 'block').length === 0;
  }

  const content: XiaohongshuContent = {
    title,
    hook,
    body,
    tags,
    ctaText: cta?.ctaText || '戳我报名',
    coverCaption,
    imageOrder,
    blocks,
  };
  return { content, grounding };
}
