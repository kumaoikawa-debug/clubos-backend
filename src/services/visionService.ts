import { logger } from '../lib';
import { config } from '../config';
import * as aiCredit from './aiCreditService';
import {
  fromLegacyAnalysis,
  buildCropPolicy,
  type VisionResult as VisionResultV3,
} from '../content-engine/contracts/visionResult';

/**
 * 视觉模型代理（照片识别，v151）
 *  - Key 由平台在服务端统一持有（PLATFORM_VISION_KEY，未配置时回退 PLATFORM_LLM_KEY）。
 *  - 入参只接受图片 URL / dataURL 数组，返回结构化识别结果，前端不接触密钥。
 *  - 计费：按「每张图 1 AI 积分」预检 + 成功后扣减（视觉调用单价高于文本，故不按 token 折算）。
 */

export interface VisionImage {
  id: string;
  /** http(s) 图片地址，或 data:image/...;base64,... 内联图 */
  src: string;
}

export interface VisionOptions {
  scenario?: string;
  prompt?: string;
  model?: string;
}

export interface VisionItem {
  id: string;
  analysis: Record<string, unknown> | null;
  error?: string;
}

export interface VisionResult {
  results: VisionItem[];
  model: string;
  credits: number;
  balance: number;
}

const VISION_SYSTEM = `你是户外活动照片分析助手。请只根据画面中确实存在的内容分析，不得臆造天气、地点或事件。
必须输出严格 JSON（不要任何解释、不要 markdown 代码块），字段：
{
  "orientation": "landscape|portrait|square",
  "quality_score": 0 到 1 的数字,
  "scene": "scenic|sky|people|action|water|camp|meal|gear|detail|route",
  "subject": "人物|环境|天空|细节",
  "people_count": 画面中清晰可辨的人物数量（整数，0 表示无人）,
  "action": "动态|静止",
  "emotion": "明快|沉静|治愈|活力",
  "safe_text_area": "top-left|top-right|bottom-left|bottom-right",
  "focal_point": { "x": 0 到 1, "y": 0 到 1 },
  "crop_risk": "low|medium|high（把该图裁成横幅或竖版时，人物/主体被裁断的风险）",
  "recommended_use": ["hero","story","gallery","detail","full"] 的子集
}`;

function parseJson(text: string): Record<string, unknown> | null {
  if (!text) return null;
  const s = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    /* 容错：截取第一个 JSON 对象 */
  }
  const m = s.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      return JSON.parse(m[0]) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return null;
}

/** 归一化：只保留白名单字段，避免把模型多余输出透传给前端 */
const FIELDS = [
  'orientation',
  'quality_score',
  'scene',
  'subject',
  'people_count',
  'action',
  'emotion',
  'safe_text_area',
  'focal_point',
  'crop_risk',
  'recommended_use',
];

function normalize(raw: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null;
  const out: Record<string, unknown> = {};
  for (const k of FIELDS) if (raw[k] !== undefined && raw[k] !== null) out[k] = raw[k];
  if (out.orientation && !['landscape', 'portrait', 'square'].includes(String(out.orientation))) delete out.orientation;
  if (out.quality_score != null) {
    let q = Number(out.quality_score);
    if (Number.isNaN(q)) delete out.quality_score;
    else {
      if (q > 1) q = q / 100;
      out.quality_score = Math.max(0, Math.min(1, q));
    }
  }
  if (out.people_count != null) {
    const n = parseInt(String(out.people_count), 10);
    if (Number.isNaN(n)) delete out.people_count;
    else out.people_count = Math.max(0, n);
  }
  if (out.crop_risk && !['low', 'medium', 'high'].includes(String(out.crop_risk))) delete out.crop_risk;
  if (out.safe_text_area && !['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(String(out.safe_text_area))) delete out.safe_text_area;
  if (out.focal_point && typeof out.focal_point !== 'object') delete out.focal_point;
  return Object.keys(out).length ? out : null;
}

async function callVisionModel(
  src: string,
  prompt: string,
  apiKey: string,
  model: string,
  base: string
): Promise<Record<string, unknown> | null> {
  const body = {
    model,
    temperature: 0.1,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: VISION_SYSTEM },
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: src } },
        ],
      },
    ],
  };
  const resp = await fetch(`${base.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`视觉模型返回 ${resp.status}: ${await resp.text()}`);
  const json = (await resp.json()) as { choices?: { message?: { content?: string } }[] };
  return parseJson(json.choices?.[0]?.message?.content ?? '');
}

export async function analyzeImages(
  merchantId: bigint | string,
  images: VisionImage[],
  opts?: VisionOptions
): Promise<VisionResult> {
  const mid = BigInt(merchantId);
  const apiKey = config.platformVisionKey || config.platformLlmKey;
  if (!apiKey) throw new Error('平台视觉模型 Key 未配置（PLATFORM_VISION_KEY / PLATFORM_LLM_KEY）');
  const model = opts?.model || config.platformVisionModel;
  const base = config.platformVisionBase;
  const prompt = opts?.prompt || '请分析这张活动照片，按约定 JSON 输出。';

  // 1) 预检：按图片张数预估积分
  const account = await aiCredit.getAccount(mid);
  if (aiCredit.balanceOf(account) < images.length) {
    throw new Error('AI 积分不足（本次需 ' + images.length + ' 积分），请充值或等待每月基础额度刷新');
  }

  // 2) 逐张分析（单张失败不影响其他图）
  const results: VisionItem[] = [];
  for (const img of images) {
    try {
      const raw = await callVisionModel(img.src, prompt, apiKey, model, base);
      const analysis = normalize(raw);
      if (!analysis) results.push({ id: img.id, analysis: null, error: '模型未返回可用结构化结果' });
      else results.push({ id: img.id, analysis });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[ai-vision] image=${img.id} 失败：${msg}`);
      results.push({ id: img.id, analysis: null, error: msg });
    }
  }

  const okCount = results.filter((r) => r.analysis).length;
  const credits = okCount; // 每张成功识别 1 积分
  let balance = aiCredit.balanceOf(account);
  if (credits > 0) {
    const res = await aiCredit.consume(mid, credits, `AI 照片识别（${credits} 张）`);
    balance = res.balance;
  }
  logger.info(`[ai-vision] merchant=${mid} 成功 ${okCount}/${images.length}，扣 ${credits} 积分`);

  return { results, model, credits, balance };
}

/**
 * V3（Content Engine）—— 输出统一到 V3 VisionResult 协议。
 *
 * 与旧 analyzeImages 的关系：
 *  - 旧的 analyzeImages 保持不动，继续服务现有调用方（文档纪律：不一次大爆炸删除旧链）。
 *  - 新增本函数作为 Content Engine V3 的唯一视觉入口，
 *    内部复用旧模型调用，再把老字段映射到 V3 协议（fromLegacyAnalysis）。
 *
 * 关键不变式：
 *  - evidenceScope.materialEvidence 恒为 true（Vision 只证明「素材里有什么」）
 *  - evidenceScope.eventFact 恒为 false —— 历史素材不得变成「本次活动」的承诺，
 *    除非调用方显式确认并传入 promoteToEventFact。
 */
export async function analyzeImagesV3(
  merchantId: bigint | string,
  images: VisionImage[],
  opts?: VisionOptions & { promoteToEventFact?: boolean }
): Promise<{ results: V3VisionItem[]; model: string; credits: number; balance: number }> {
  const legacy = await analyzeImages(merchantId, images, opts);
  const eventFact = Boolean(opts?.promoteToEventFact);

  const results: V3VisionItem[] = legacy.results.map((item) => {
    const v3 = item.analysis
      ? fromLegacyAnalysis(item.id, item.analysis)
      : null;
    if (!v3) {
      return { id: item.id, vision: null, error: item.error ?? '模型未返回可用结构化结果' };
    }
    return {
      id: item.id,
      vision: { ...v3, evidenceScope: { materialEvidence: true, eventFact } },
      cropPolicy: buildCropPolicy(v3),
    };
  });

  return { results, model: legacy.model, credits: legacy.credits, balance: legacy.balance };
}

export interface V3VisionItem {
  id: string;
  vision: VisionResultV3 | null;
  cropPolicy?: ReturnType<typeof buildCropPolicy>;
  error?: string;
}
