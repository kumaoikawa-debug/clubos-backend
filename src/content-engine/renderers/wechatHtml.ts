/**
 * Content Engine V3 —— 微信公众号富文本渲染器
 * 文档 §十四 硬性要求：
 *   - inline style 或微信可保留的样式
 *   - 不依赖 JS（微信会剥掉 script）
 *   - 不依赖外链 CSS（<link> 会被剥）
 *   - 图片保持原比例优先（不许用固定 height 把竖图压扁）
 *   - 支持一键复制（产出就是一段可直接粘贴的 HTML）
 *
 * 反模板化：字号/间距/留白由 StyleVector 的连续量纲折算，
 * 不存在「文艺版 / 干练版」这种固定选一套的做法。
 */

import type { StyleVector } from '../contracts/creativeDirection';
import type { WechatBlueprint, WechatDocument } from '../contracts/channels';

export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface WechatRenderInput {
  activityId: string;
  blueprint: WechatBlueprint;
  title: string;
  /** 图片 URL 列表（按 Curator 排好的出场顺序传入） */
  images: string[];
  coverIndex: number;
  styleVector: StyleVector;
}

/** 留白档 → 连续系数（0~1），用于把字符串枚举折算成真实 px，避免「三套模板」 */
function whitespaceFactor(v: StyleVector): number {
  return v.whitespace === 'generous' ? 1 : v.whitespace === 'tight' ? 0 : 0.5;
}

/** 把 StyleVector 折算成连续的内联排版参数（不是三档枚举） */
function styleToMetrics(v: StyleVector) {
  const ws = whitespaceFactor(v);
  const bodySize = 15 + Math.round(v.textDensity * 3); // 15~18px
  const lineHeight = (1.6 + ws * 0.35).toFixed(2);
  const paraGap = Math.round(10 + ws * 14); // 10~24px
  const headingSize = Math.round(bodySize * (1.25 + v.typographyEnergy * 0.35));
  const imgRadius = Math.round(2 + v.aspirationLevel * 10);
  const accent = v.emotionalWeight > 0.6 ? '#1f6f4a' : '#2b4d7a';
  return { bodySize, lineHeight, paraGap, headingSize, imgRadius, accent };
}

/**
 * 渲染正文。
 * 图片插在哪一段由 blueprint.sections[].imageSlots 决定 —— 图的位置是内容的一部分，
 * 不是渲染器按「每隔两段插一张」的模板算出来的。
 */
export function renderWechatHtml(input: WechatRenderInput): string {
  const { blueprint, images, styleVector } = input;
  const m = styleToMetrics(styleVector);

  const parts: string[] = [];
  parts.push(
    `<section style="font-size:${m.bodySize}px;line-height:${m.lineHeight};color:#333;letter-spacing:.3px;">`
  );

  if (blueprint.opening) {
    parts.push(
      `<p style="margin:0 0 ${m.paraGap}px;font-size:${m.headingSize - 2}px;color:${m.accent};font-weight:600;">${esc(
        blueprint.opening
      )}</p>`
    );
  }

  const queue = images.slice();
  for (const sec of blueprint.sections) {
    if (sec.heading) {
      parts.push(
        `<h2 style="margin:${m.paraGap + 6}px 0 ${Math.round(m.paraGap / 2)}px;font-size:${m.headingSize}px;` +
          `color:#222;font-weight:700;line-height:1.4;">${esc(sec.heading)}</h2>`
      );
    }
    for (const p of sec.paragraphs) {
      parts.push(`<p style="margin:0 0 ${m.paraGap}px;">${esc(p)}</p>`);
    }
    // imageSlots 决定本段后跟几张 —— 位置由 content 决定，不由渲染器平均分布
    for (let i = 0; i < (sec.imageSlots || 0); i++) {
      const src = queue.shift();
      if (!src) break;
      parts.push(
        `<figure style="margin:${m.paraGap}px 0;"><img src="${esc(src)}" ` +
          `style="width:100%;max-width:100%;height:auto;display:block;border-radius:${m.imgRadius}px;" ` +
          `/></figure>`
      );
    }
  }

  if (blueprint.closing) {
    parts.push(`<p style="margin:${m.paraGap}px 0 0;">${esc(blueprint.closing)}</p>`);
  }
  if (blueprint.cta) {
    parts.push(
      `<p style="margin:${m.paraGap}px 0 0;padding:12px 14px;background:#f6f8f6;border-left:3px solid ${m.accent};` +
        `color:#333;">${esc(blueprint.cta)}</p>`
    );
  }

  parts.push('</section>');
  return parts.join('');
}

/** 组装完整 WechatDocument（渲染器产出 HTML， Detailed fields 由 workflow 补齐） */
export function buildWechatHtmlDocument(
  input: WechatRenderInput,
  extra: { titleOptions: string[]; digest: string; imageOrder: number[]; direction: any; meta: any }
): WechatDocument {
  return {
    schemaVersion: 3,
    scenario: 'wechat',
    activityId: input.activityId,
    titleOptions: extra.titleOptions,
    title: input.title,
    digest: extra.digest,
    html: renderWechatHtml(input),
    coverIndex: input.coverIndex,
    imageOrder: extra.imageOrder,
    direction: extra.direction,
    generationMeta: extra.meta,
  };
}
