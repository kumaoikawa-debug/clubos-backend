/**
 * Content Engine V3 —— VisionResult 协议（文档 §十 / §十一）
 *
 * 前后端必须统一到这份协议。
 * Vision 证明的是：「上传素材中有什么」
 * Vision 不自动证明：「本次活动将发生什么」
 * → 历史素材一律 evidenceScope.eventFact = false，
 *   只有明确本次现场素材 / 用户确认，才可升级。
 */

export interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VisionSubject {
  type: string;
  bbox: BBox;
}

export interface VisionPeople {
  count: number;
  group: boolean;
  children: boolean;
}

export interface VisionEvidenceScope {
  /** 始终是 true —— 它只证明素材里有 */
  materialEvidence: true;
  /** 是否可作为「本次活动」的事实依据 */
  eventFact: boolean;
}

export interface VisionResult {
  imageId: string;

  scene: string[];
  objects: string[];

  people: VisionPeople;

  subjects: VisionSubject[];

  activity: string[];
  environment: string[];

  orientation: string;
  qualityScore: number;

  emotion?: string;
  composition?: string;

  focalPoint: { x: number; y: number };

  safeCropBox?: BBox;
  textSafeArea?: unknown[];

  duplicateGroup?: string;

  confidence: number;

  evidenceScope: VisionEvidenceScope;
}

/**
 * CropPolicy —— 优先级：
 * 人物/主体完整 > 语义匹配 > 图片质量 > 版式美观 > 容器填满
 * riskLevel = high → allowCrop = false 且 aspect_preserved，Renderer 不得再切回 cover。
 */
export interface CropPolicy {
  mode: 'cover' | 'safe_cover' | 'aspect_preserved';
  riskLevel: 'low' | 'medium' | 'high';
  focalPoint: { x: number; y: number };
  subjectBoxes: BBox[];
  protectedSubjects: string[];
  allowCrop: boolean;
  safeCropBox?: BBox;
}

export function buildCropPolicy(v: VisionResult): CropPolicy {
  const people = v.people?.count ?? 0;
  const hasSubject = (v.subjects?.length ?? 0) > 0;
  const subjectsAtEdge = (v.subjects ?? []).some((s) => touchesEdge(s.bbox));
  const high = people > 0 && (subjectsAtEdge || hasSubject === false && people >= 2);
  const risk: CropPolicy['riskLevel'] = high ? 'high' : people > 0 || hasSubject ? 'medium' : 'low';
  return {
    mode: risk === 'high' ? 'aspect_preserved' : risk === 'medium' ? 'safe_cover' : 'cover',
    riskLevel: risk,
    focalPoint: v.focalPoint ?? { x: 0.5, y: 0.5 },
    subjectBoxes: (v.subjects ?? []).map((s) => s.bbox),
    protectedSubjects: ['person', '人物', 'face', 'child', 'dog', 'animal'].filter(
      (t) => v.scene.includes(t) || (v.subjects ?? []).some((s) => s.type === t)
    ),
    allowCrop: risk !== 'high',
    safeCropBox: v.safeCropBox,
  };
}

function touchesEdge(b: BBox, tol = 0.06): boolean {
  return b.x <= tol || b.y <= tol || b.x + b.width >= 1 - tol || b.y + b.height >= 1 - tol;
}

/**
 * 老协议（v151 视觉 masc：单值 scene / crop_risk / people_count）→ V3 VisionResult。
 * 用于平滑迁移：老调用方无感，新链路拿到统一协议。
 */
export function fromLegacyAnalysis(
  imageId: string,
  legacy: Record<string, unknown> | null
): VisionResult | null {
  if (!legacy || typeof legacy !== 'object') return null;
  const num = (v: unknown, d = 0) => {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : d;
  };
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : v ? [String(v)] : [];
  const peopleCount = Math.max(0, Math.round(num(legacy.people_count, 0)));
  const fp = (legacy.focal_point ?? {}) as Record<string, unknown>;
  const cropRisk = String(legacy.crop_risk ?? 'low');

  return {
    imageId,
    scene: arr(legacy.scene),
    objects: [],
    people: {
      count: peopleCount,
      group: peopleCount >= 2,
      children: false,
    },
    subjects: [],
    activity: arr(legacy.action),
    environment: arr(legacy.subject),
    orientation: String(legacy.orientation ?? 'unknown'),
    qualityScore: Math.max(0, Math.min(1, num(legacy.quality_score, 0))),
    emotion: legacy.emotion ? String(legacy.emotion) : undefined,
    composition: undefined,
    focalPoint: { x: num(fp.x, 0.5), y: num(fp.y, 0.5) },
    textSafeArea: legacy.safe_text_area ? [String(legacy.safe_text_area)] : undefined,
    duplicateGroup: undefined,
    confidence: cropRisk === 'high' ? 0.4 : cropRisk === 'medium' ? 0.7 : 0.85,
    evidenceScope: { materialEvidence: true, eventFact: false },
  };
}
