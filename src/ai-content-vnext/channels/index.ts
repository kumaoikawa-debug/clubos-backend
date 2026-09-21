/**
 * 宣发渠道统一入口（§17 / §27 第二阶段）
 *
 * 所有渠道共享同一个 Activity Master（数据母体），各自重新策划：
 *   wechat      → LLM 重策划公众号长文（输出 HTML）
 *   xiaohongshu → LLM 重策划小红书笔记（结构化字段）
 *   poster      → 确定性提取海报结构（不调 LLM）
 *   moments     → 确定性派生朋友圈 / 群文案（不调 LLM）
 *
 * 与详情页生成共用 understandSources / buildActivityMaster，但每个渠道独立 plan + generate，绝不复制。
 */
import type { ChatFn } from '../chat';
import { defaultChat } from '../chat';
import { understandSources } from '../source-understanding';
import { buildActivityMaster } from '../activity-master';
import { normalizePhotos } from '../media';
import { checkFacts, scanFreeText } from '../grounding';
import { metered } from './meter';
import { generateWechat } from './wechat';
import { generateXiaohongshu } from './xiaohongshu';
import { generatePoster } from './poster';
import { generateMoments } from './moments';
import { selectDirection, recordAndMeasure } from '../diversity';
import type { ChannelResult, ChannelType, GenerateChannelInput, GroundingReport, DiversityMeta } from '../types';

export async function generateChannel(input: GenerateChannelInput, chat: ChatFn = defaultChat): Promise<ChannelResult> {
  const { fn: c, meter } = metered(chat);
  const merchantId = input.merchantId;

  // 共享母体：理解源材料 → Activity Master
  const photos = normalizePhotos(input.photos);
  const understanding = await understandSources(merchantId, input.sourceMaterials, input.activity, c);
  const master = buildActivityMaster({
    activityId: input.activityId,
    activity: input.activity,
    understanding,
    photos,
  });

  let content: ChannelResult['content'];
  let grounding: GroundingReport;

  // §29 反重复闸门：自动挑一个与最近内容不同的宣传切口
  const useDiversity = input.diversity !== false;
  const direction = useDiversity ? selectDirection(merchantId) : null;
  const hint = direction ? direction.hint : undefined;

  switch (input.channel as ChannelType) {
    case 'wechat': {
      const r = await generateWechat(merchantId, master, understanding, c, input.instruction, hint);
      content = r.content;
      grounding = r.grounding;
      break;
    }
    case 'xiaohongshu': {
      const r = await generateXiaohongshu(merchantId, master, understanding, c, input.instruction, hint);
      content = r.content;
      grounding = r.grounding;
      break;
    }
    case 'poster': {
      const poster = generatePoster(master);
      const g = checkFacts([], master, understanding);
      const extra = scanFreeText(
        [poster.name, poster.date, poster.location, poster.priceText, poster.sellingPoint, ...poster.highlights].join('\n'),
        master
      );
      if (extra.length) {
        g.issues.push(...extra);
        g.passed = g.passed && extra.filter((i) => i.severity === 'block').length === 0;
      }
      content = poster;
      grounding = g;
      break;
    }
    case 'moments': {
      const moments = generateMoments(master);
      const g = checkFacts([], master, understanding);
      const extra = scanFreeText([moments.text, moments.signup].join('\n'), master);
      if (extra.length) {
        g.issues.push(...extra);
        g.passed = g.passed && extra.filter((i) => i.severity === 'block').length === 0;
      }
      content = moments;
      grounding = g;
      break;
    }
    default:
      throw new Error('未知渠道：' + input.channel);
  }

  // 生成后写入 Creative Memory 并度量反重复
  const diversity: DiversityMeta | null = useDiversity
    ? {
        direction,
        repetition: recordAndMeasure(merchantId, {
          activityId: input.activityId,
          channel: input.channel,
          direction,
          blocks: ((content as any) && (content as any).blocks) || [],
        }),
      }
    : null;

  return {
    channel: input.channel,
    activityMaster: master,
    grounding,
    content,
    diversity: diversity || undefined,
    usage: { credits: meter.credits, tokens: meter.tokens, balance: meter.balance, source: meter.source },
  };
}

export { generateWechat } from './wechat';
export { generateXiaohongshu } from './xiaohongshu';
export { generatePoster } from './poster';
export { generateMoments } from './moments';
export { renderWechatHtml } from './renderHtml';
