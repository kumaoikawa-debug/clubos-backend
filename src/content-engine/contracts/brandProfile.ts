/**
 * Content Engine V3 —— BrandProfile 契约（文档 §十三）
 *
 * 替代 contentDirector.js 写死的「远拓旅游：年轻、松弛、山系高级感……」。
 *
 * ★ 中性默认：未设置 BrandProfile 时，生成链路**不注入任何品牌调性**，
 *   即使用完全中性的品牌语言。绝不默认所有俱乐部都是「年轻、松弛、山系高级感」。
 *   只有俱乐部自己在后台填了 toneKeywords / visualKeywords，才会把品牌偏好带进生成。
 */

export interface BrandProfile {
  merchantId: string;
  brandName?: string | null;
  toneKeywords: string[];
  avoidKeywords: string[];
  visualKeywords: string[];
  primaryColor?: string | null;
  secondaryColor?: string | null;
  typographyPreference?: string | null;
  logo?: string | null;
  contentRules?: string | null;
}

/**
 * 中性默认品牌语言：空调性。
 * 生成链路在 brand 为 null/undefined 时使用它 —— 不注入任何具体调性，
 * 也不会把「年轻 / 松弛 / 山系高级感」当成所有俱乐部的默认值。
 */
export const NEUTRAL_BRAND: Pick<BrandProfile, 'toneKeywords' | 'avoidKeywords' | 'visualKeywords'> = {
  toneKeywords: [],
  avoidKeywords: [],
  visualKeywords: [],
};

/** 把任意输入规整成 BrandProfile（缺字段补中性默认，防止脏数据进入生成链路） */
export function normalizeBrandProfile(input: Partial<BrandProfile> | null | undefined): BrandProfile {
  if (!input) {
    return {
      merchantId: '',
      ...NEUTRAL_BRAND,
    };
  }
  const asStrArray = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);
  return {
    merchantId: String(input.merchantId ?? ''),
    brandName: input.brandName ?? null,
    toneKeywords: asStrArray(input.toneKeywords),
    avoidKeywords: asStrArray(input.avoidKeywords),
    visualKeywords: asStrArray(input.visualKeywords),
    primaryColor: input.primaryColor ?? null,
    secondaryColor: input.secondaryColor ?? null,
    typographyPreference: input.typographyPreference ?? null,
    logo: input.logo ?? null,
    contentRules: input.contentRules ?? null,
  };
}
