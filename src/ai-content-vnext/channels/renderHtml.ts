/**
 * 微信公众号 HTML 渲染器
 *
 * 把 12 型 Promo Block 渲染成「可直接复制进微信公众号后台」的内联样式 HTML 片段。
 * 原则：
 *   - 全内联样式（微信后台会清掉 <style> / class）；
 *   - 图片用 <img src> + width:100%，src 由 master.photos 的 id 解析；
 *   - 不引入 JS；
 *   - 不编造任何文案（文案来自 block，渲染只管排版）。
 */
import type { ActivityMaster, PromoBlock } from '../types';

function esc(s: string): string {
  return (s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function photoSrc(master: ActivityMaster, id: string): string {
  const p = master.photos.find((x) => x.id === id);
  return p ? p.src : '';
}

function renderImages(master: ActivityMaster, refs?: string[], single = false): string {
  if (!refs || !refs.length) return '';
  const imgs = refs
    .map((id) => {
      const src = photoSrc(master, id);
      if (!src) return '';
      return `<img src="${esc(src)}" style="width:100%;display:block;margin:0 auto 4px;"/>`;
    })
    .filter(Boolean)
    .join('');
  if (!imgs) return '';
  const wrap = single ? '' : 'display:flex;flex-wrap:wrap;gap:4px;';
  const child = single ? '' : 'width:calc(50% - 2px);';
  return `<section style="${wrap}">${imgs.replace(/width:100%/g, `width:100%;${child}`)}</section>`;
}

function renderBlock(b: PromoBlock, master: ActivityMaster): string {
  switch (b.type) {
    case 'hero':
      return `<section style="margin:18px 0;">
  ${b.headline ? `<h1 style="font-size:22px;font-weight:700;line-height:1.4;margin:0 0 8px;color:#1a1a1a;">${esc(b.headline)}</h1>` : ''}
  ${b.subtitle ? `<p style="font-size:15px;color:#666;margin:0 0 10px;line-height:1.6;">${esc(b.subtitle)}</p>` : ''}
  ${renderImages(master, b.mediaRefs, true)}
</section>`;
    case 'text':
      return `<p style="font-size:15px;line-height:1.8;color:#333;margin:14px 0;">${esc(b.text || '')}</p>`;
    case 'statement':
      return `<p style="font-size:17px;line-height:1.8;color:#1a1a1a;font-weight:600;margin:18px 0;padding:4px 0;">${esc(b.text || '')}</p>`;
    case 'metric_strip': {
      const cells = (b.metrics || [])
        .map(
          (m) =>
            `<div style="flex:1;min-width:80px;text-align:center;padding:8px 4px;">
  <div style="font-size:20px;font-weight:700;color:#e8531a;">${esc(m.value)}</div>
  <div style="font-size:12px;color:#888;margin-top:2px;">${esc(m.label)}</div>
</div>`
        )
        .join('');
      return `<section style="display:flex;flex-wrap:wrap;background:#f7f7f7;border-radius:8px;margin:16px 0;padding:10px 6px;">${cells}</section>`;
    }
    case 'single_image':
      return `<section style="margin:14px 0;">${renderImages(master, b.mediaRefs, true)}</section>`;
    case 'image_pair':
      return `<section style="margin:14px 0;">${renderImages(master, b.mediaRefs)}</section>`;
    case 'image_triplet':
      return `<section style="margin:14px 0;">${renderImages(master, b.mediaRefs)}</section>`;
    case 'image_group':
      return `<section style="margin:14px 0;">${renderImages(master, b.mediaRefs)}</section>`;
    case 'text_image':
      return `<section style="margin:16px 0;">
  ${b.headline ? `<h2 style="font-size:18px;font-weight:700;margin:0 0 8px;color:#1a1a1a;">${esc(b.headline)}</h2>` : ''}
  ${b.body ? `<p style="font-size:15px;line-height:1.8;color:#333;margin:0 0 10px;">${esc(b.body)}</p>` : ''}
  ${renderImages(master, b.mediaRefs, true)}
</section>`;
    case 'quote':
      return `<blockquote style="margin:16px 0;padding:10px 14px;border-left:4px solid #e8531a;background:#faf7f5;color:#555;font-size:15px;line-height:1.7;">${esc(b.text || '')}</blockquote>`;
    case 'divider':
      return `<hr style="border:none;border-top:1px solid #eee;margin:18px 0;"/>`;
    case 'cta':
      return `<section style="margin:20px 0;text-align:center;background:#e8531a;border-radius:8px;padding:14px 0;">
  <p style="font-size:16px;font-weight:700;color:#fff;margin:0;">${esc(b.ctaText || '立即报名')}</p>
</section>`;
    default:
      return '';
  }
}

/** 渲染整篇公众号 HTML（标题 + 摘要 + 正文 blocks + 结尾 CTA 已由 block 携带） */
export function renderWechatHtml(
  blocks: PromoBlock[],
  meta: { title: string; summary: string; master: ActivityMaster }
): string {
  const header = `<section style="margin:0 0 16px;">
  <h1 style="font-size:22px;font-weight:700;line-height:1.4;color:#1a1a1a;margin:0 0 8px;">${esc(meta.title)}</h1>
  ${meta.summary ? `<p style="font-size:14px;color:#888;line-height:1.6;margin:0;font-style:italic;">${esc(meta.summary)}</p>` : ''}
</section>`;
  const body = (blocks || []).map((b) => renderBlock(b, meta.master)).join('\n');
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Helvetica Neue',Arial,sans-serif;color:#333;max-width:680px;margin:0 auto;padding:8px 4px;">${header}\n${body}</div>`;
}
