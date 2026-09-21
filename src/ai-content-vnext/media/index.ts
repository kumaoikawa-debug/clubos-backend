/**
 * Media｜图片理解与证据区分（§20 / Task 4 图片部分）
 *
 * 第一版：DeepSeek chat 为文本模型，不做视觉理解；图片的 orientation / caption / 证据属性
 * 由上传环节提供，这里负责规范化与轻量判定：
 *   - 图注含「往期 / 历史 / 去年 / 实拍回顾 / 往届」→ materialEvidence=true（历史素材证据）
 *   - 图注含「本次活动 / 本次 / 今年 / 新拍」→ eventFact=true（本次活动事实）
 *   - 其余默认 materialEvidence=false, eventFact=false（普通素材，按图注处理）
 *
 * 严格纪律（§20）：materialEvidence 图只能证明「图里有 X」，绝不能自动推导「本次活动会有 X」。
 */
import type { MediaRef } from '../types';

const EVIDENCE_RE = /(往期|历史|去年|前年|上届|往届|实拍回顾|旧照|回顾图)/;
const EVENT_RE = /(本次活动|本次|这一期|今年新拍|新拍|最新实拍|本期)/;

export function classifyEvidence(caption?: string): { materialEvidence: boolean; eventFact: boolean } {
  const c = (caption || '').toLowerCase();
  if (EVENT_RE.test(c)) return { materialEvidence: false, eventFact: true };
  if (EVIDENCE_RE.test(c)) return { materialEvidence: true, eventFact: false };
  return { materialEvidence: false, eventFact: false };
}

export interface IncomingPhoto {
  id: string;
  src: string;
  width?: number;
  height?: number;
  caption?: string;
  materialEvidence?: boolean;
  eventFact?: boolean;
  subjects?: string[];
}

export function normalizePhotos(photos: IncomingPhoto[] | undefined): MediaRef[] {
  if (!photos || !photos.length) return [];
  return photos.map((p) => {
    const inferred = classifyEvidence(p.caption);
    const orientation: MediaRef['orientation'] =
      p.width && p.height ? (p.width > p.height ? 'landscape' : p.width < p.height ? 'portrait' : 'square') : undefined;
    return {
      id: p.id,
      src: p.src,
      orientation,
      caption: p.caption,
      materialEvidence: p.materialEvidence ?? inferred.materialEvidence,
      eventFact: p.eventFact ?? inferred.eventFact,
      subjects: p.subjects,
    };
  });
}
