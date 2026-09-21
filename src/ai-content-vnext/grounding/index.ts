/**
 * STEP 5｜Fact Check / Grounding（§19 / §20 / Task 10）
 *
 * 生成完成后检查，确保不越界：
 *   时间 / 地点 / 价格 / 行程 / 参与方式 / 领队 / 保险 / 天气 / 现场事件
 *
 * 实现（§21：第一版保持简单，不引 embedding / 多 Agent）：
 *   1) 汇总 Activity Master 中「资料支持的原文」作为允许事实集；
 *   2) 对全部 block 文案做禁止编造词扫描（§19 清单）；资料里没有即拦截；
 *   3) 价格 / 日期出现具体数值时与母体比对，越界即报；
 *   4) 图片 materialEvidence / eventFact 区分（§20）：历史素材证据图不得被文案伪称本次活动事实。
 */
import type { ActivityMaster, PromoBlock, GroundingReport, GroundingIssue, MaterialEvidenceFlag, FactField, SourceUnderstanding } from '../types';

/** §19 禁止自动创造的词（出现在文案但资料未支持 = 编造） */
const FORBIDDEN: { word: string; field: FactField }[] = [
  { word: '云海', field: 'weather' },
  { word: '红叶', field: 'weather' },
  { word: '日照金山', field: 'weather' },
  { word: '下雪', field: 'weather' },
  { word: '雪景', field: 'weather' },
  { word: '天气', field: 'weather' },
  { word: '登顶', field: 'event' },
  { word: '实际人数', field: 'participation' },
  { word: '用户评价', field: 'event' },
  { word: '领队行为', field: 'leader' },
  { word: '保险保障', field: 'insurance' },
  { word: '剩余名额', field: 'participation' },
  { word: '马上满员', field: 'participation' },
  { word: '最后几个', field: 'participation' },
  { word: '大家很开心', field: 'event' },
  { word: '现场氛围', field: 'event' },
];

function collectSourceText(master: ActivityMaster): string {
  const parts: string[] = [];
  parts.push(JSON.stringify(master.publicFacts || {}));
  parts.push(JSON.stringify(master.itinerary || []));
  parts.push(JSON.stringify(master.fees || {}));
  parts.push(JSON.stringify(master.services || []));
  parts.push(JSON.stringify(master.sellingEvidence || []));
  (master.sourceMaterials || []).forEach((m) => parts.push(m.text || ''));
  return parts.join('\n').toLowerCase();
}

function blockText(b: PromoBlock): string {
  return [b.headline, b.subtitle, b.text, b.body, b.caption, b.ctaText]
    .filter(Boolean)
    .join('\n');
}

function extractPrice(text: string): string | null {
  // 必须带货币符号前缀（避免把里程 12km 等普通数字误判为价格），单位可选
  const m = text.match(/(?:¥|￥|RMB)\s*(\d{2,6})(?:\s*(?:元|块|\/人|每人))?/i);
  return m ? m[1] : null;
}

function extractDate(text: string): string | null {
  const m =
    text.match(/(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})/) ||
    text.match(/(\d{1,2})月(\d{1,2})[日号]/) ||
    text.match(/(\d{1,2})\.(\d{1,2})/);
  return m ? m[0] : null;
}

export function checkFacts(
  blocks: PromoBlock[],
  master: ActivityMaster,
  _understanding?: SourceUnderstanding
): GroundingReport {
  const sourceText = collectSourceText(master).toLowerCase();
  const knownPrice = extractPrice(JSON.stringify(master.publicFacts) + JSON.stringify(master.fees));
  const issues: GroundingIssue[] = [];

  blocks.forEach((b, i) => {
    const t = blockText(b);
    if (!t) return;
    const low = t.toLowerCase();

    // 1) 禁止编造词扫描
    for (const f of FORBIDDEN) {
      if (low.includes(f.word) && !sourceText.includes(f.word.toLowerCase())) {
        issues.push({
          blockIndex: i,
          field: f.field,
          snippet: t.length > 60 ? t.slice(0, 60) + '…' : t,
          reason: `文案出现「${f.word}」但资料未支持，疑似编造（§19）`,
          severity: 'block',
        });
      }
    }

    // 2) 价格越界
    const price = extractPrice(t);
    if (price && knownPrice && price !== knownPrice) {
      issues.push({
        blockIndex: i,
        field: 'price',
        snippet: t.length > 60 ? t.slice(0, 60) + '…' : t,
        reason: `文案价格 ${price} 与母体已知价格 ${knownPrice} 不一致`,
        severity: 'block',
      });
    }

    // 3) 日期越界（仅当资料里完全找不到该日期字符串时）
    const date = extractDate(t);
    if (date && !sourceText.includes(date.toLowerCase()) && !sourceText.includes(date.replace(/[.\/-]/g, ''))) {
      issues.push({
        blockIndex: i,
        field: 'time',
        snippet: t.length > 60 ? t.slice(0, 60) + '…' : t,
        reason: `文案出现日期 ${date} 但资料未提及`,
        severity: 'warn',
      });
    }
  });

  // 4) 图片证据区分（§20）
  const materialEvidenceFlags: MaterialEvidenceFlag[] = master.photos.map((p) => ({
    mediaId: p.id,
    materialEvidence: !!p.materialEvidence,
    eventFact: !!p.eventFact,
    note: p.eventFact
      ? '可作为本次活动事实引用'
      : p.materialEvidence
        ? '仅作往期/历史素材证据，文案不得伪称本次活动事实'
        : '未标注，按普通素材处理',
  }));

  // 引用了 materialEvidence 图但文案伪称「本次活动」的，额外拦截
  const evidenceIds = new Set(
    master.photos.filter((p) => p.materialEvidence && !p.eventFact).map((p) => p.id)
  );
  if (evidenceIds.size) {
    blocks.forEach((b, i) => {
      const refs = b.mediaRefs || [];
      const usedEvidence = refs.filter((id) => evidenceIds.has(id));
      if (!usedEvidence.length) return;
      const t = blockText(b);
      if (/(本次活动|这次活动|届时|现场会|将有|会有).{0,6}(篝火|日照金山|云海|雪|红叶|星空)/.test(t)) {
        issues.push({
          blockIndex: i,
          field: 'event',
          snippet: t.length > 60 ? t.slice(0, 60) + '…' : t,
          reason: '引用了历史素材证据图，却伪称本次活动会有该场景（§20 图片证据≠活动事实）',
          severity: 'block',
        });
      }
    });
  }

  return {
    passed: issues.filter((x) => x.severity === 'block').length === 0,
    issues,
    materialEvidenceFlags,
  };
}
