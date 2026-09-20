/**
 * Content Engine V3 —— 编辑器变更新操作（文档 §十八）
 *
 * 四个端点都作用在「已生成的 detail 文档（PromoDocument.blocks）」上：
 *   - regenerate-style  换风格：按 style bias 调整连续 StyleVector，重排 layout
 *   - regenerate-layout  换版式：调整 whitespace / rhythm，重排 layout（更松 / 更密 / 更有节奏）
 *   - rewrite-block      单块 AI 改写：对指定 block 重写作案，保持 purpose / 证据 / 类型
 *   - replace-image      换图：替换指定 block 的 mediaRefs
 *
 * 设计约束（与生成链路一致）：
 *   - 改动后必须重跑事实纪律（groundClaims）与指纹重建，保持「不变量不丢」——
 *     编辑器不是绕过护栏的后门。
 *   - rewrite-block 是唯一真走 LLM 的操作；其余是确定性变换，不消耗创作额度。
 *   - LLM 不可用时（离线 / 积分耗尽）rewrite-block 降级为确定性改写，绝不抛错中断编辑。
 *   - 不改原 generation 的 llmUsed / fallbackReason（那记录的是「首次生成」是否走 LLM），
 *     只在 generationMeta.editorAction 追加「最近被改成什么」。
 */

import type { PromoDocument, ContentBlock, BlockCopy } from '../contracts/promoDocument';
import type { ActivityTruth } from '../contracts/activityTruth';
import type { CreativeDirection, StyleVector } from '../contracts/creativeDirection';
import { normalizeStyleVector, clamp01 } from '../contracts/creativeDirection';
import { composeLayout } from './compose';
import { groundClaims, evaluateSimilarity, BANNED_PHRASES } from './quality';
import { buildCreativeFingerprint } from '../contracts/fingerprints';
import { embedText } from '../contracts/semantic';
import { callJsonLlm, buildPrompt } from './llm';

export type StyleBias = 'magazine' | 'visual' | 'professional' | 'natural';
export type LayoutMode = 'airy' | 'dense' | 'rhythmic';

const REWRITE_SYSTEM =
  '你是单块内容改写者。你只改写交给你的那一块，保持它的传播任务与事实依据。' +
  '禁止通用营销套话：名额有限/手慢无/私信我/评论扣1/群内接龙/下一期正在安排/大家都很开心/逃离城市/治愈/松弛。' +
  '只能使用给定的 Confirmed Truth；没有依据的内容不许写。必须输出严格 JSON。';

export interface EditorResult {
  document: PromoDocument;
  /** 本次操作是否真走了 LLM（仅 rewrite-block 可能为 true） */
  llmUsed: boolean;
  /** 操作说明，写入 generationMeta.editorAction */
  action: string;
  /** 未走 LLM 时的原因（仅 rewrite-block 降级时存在） */
  fallbackReason?: string;
  /** 重算后的相似度报告（调用方按需落库） */
  evaluation?: unknown;
}

/* ---------- 内部工具 ---------- */

function applyStyleBias(sv: StyleVector, bias: StyleBias): StyleVector {
  const next: Record<string, unknown> = { ...sv };
  const d = (k: keyof StyleVector, delta: number) => (next[k] = clamp01((sv[k] as number) + delta));
  if (bias === 'magazine') {
    d('imageDominance', 0.1);
    d('textDensity', 0.1);
    d('typographyEnergy', 0.15);
    next.whitespace = 'balanced';
    next.rhythm = 'medium';
  } else if (bias === 'visual') {
    d('imageDominance', 0.2);
    d('textDensity', -0.1);
  } else if (bias === 'professional') {
    d('informationWeight', 0.2);
    d('professionalSignal', 0.2);
    d('textDensity', 0.05);
  } else if (bias === 'natural') {
    d('documentaryLevel', 0.2);
    d('lifestyleSignal', 0.1);
    d('emotionalWeight', -0.05);
  }
  return normalizeStyleVector(next);
}

function applyLayoutMode(sv: StyleVector, mode: LayoutMode): StyleVector {
  const next: Record<string, unknown> = { ...sv };
  if (mode === 'airy') next.whitespace = 'generous';
  else if (mode === 'dense') next.whitespace = 'tight';
  else if (mode === 'rhythmic') next.rhythm = 'fast';
  return normalizeStyleVector(next);
}

/** 重跑事实纪律 + 重建指纹 + 补 generationMeta，保证编辑器改动后文档仍然自洽 */
async function finalize(
  doc: PromoDocument,
  direction: CreativeDirection,
  blocks: ContentBlock[],
  truth: ActivityTruth,
  action: string,
  llmUsed: boolean,
  fallbackReason?: string
): Promise<EditorResult> {
  const grounded = groundClaims(blocks, truth);
  const finalBlocks = grounded.blocks;
  const evaluation = await evaluateSimilarity(
    { thesisText: direction.thesis, openingMode: doc.openingMode, blocks: finalBlocks },
    []
  );
  const thesisEmbedding = await embedText(direction.thesis);
  const fingerprint = buildCreativeFingerprint({
    thesisText: direction.thesis,
    openingMode: doc.openingMode,
    blocks: finalBlocks,
    styleVector: direction.styleVector,
    ...(thesisEmbedding ? { thesisEmbedding } : {}),
  });
  return {
    document: {
      ...doc,
      direction,
      blocks: finalBlocks,
      fingerprint,
      generationMeta: {
        ...doc.generationMeta,
        generatedAt: new Date().toISOString(),
        editorAction: action,
      },
    } as PromoDocument,
    llmUsed,
    action,
    fallbackReason,
    evaluation,
  };
}

/* ---------- 四个操作 ---------- */

/** 换风格：调整 StyleVector 并重排 layout（确定性，不消耗额度） */
export async function regenerateStyle(
  doc: PromoDocument,
  truth: ActivityTruth,
  _merchantId: string | number,
  bias?: StyleBias
): Promise<EditorResult> {
  const newSv = bias ? applyStyleBias(doc.direction.styleVector, bias) : doc.direction.styleVector;
  const direction = { ...doc.direction, styleVector: newSv };
  const blocks = composeLayout(doc.blocks, newSv);
  return finalize(doc, direction, blocks, truth, bias ? `regenerate-style:${bias}` : 'regenerate-style', false);
}

/** 换版式：调整 whitespace / rhythm 并重排 layout（确定性） */
export async function regenerateLayout(
  doc: PromoDocument,
  truth: ActivityTruth,
  _merchantId: string | number,
  mode?: LayoutMode
): Promise<EditorResult> {
  const newSv = mode ? applyLayoutMode(doc.direction.styleVector, mode) : doc.direction.styleVector;
  const direction = { ...doc.direction, styleVector: newSv };
  const blocks = composeLayout(doc.blocks, newSv);
  return finalize(doc, direction, blocks, truth, mode ? `regenerate-layout:${mode}` : 'regenerate-layout', false);
}

/** 单块 AI 改写：对指定 block 重写作案（真走 LLM，离线降级确定性改写） */
export async function rewriteBlock(
  doc: PromoDocument,
  truth: ActivityTruth,
  merchantId: string | number,
  blockId: string,
  instruction?: string
): Promise<EditorResult> {
  const idx = doc.blocks.findIndex((b) => b.id === blockId);
  if (idx < 0) throw new Error(`blockId 不存在：${blockId}`);
  const block = doc.blocks[idx];
  const f = truth.confirmedFacts;

  let copy: BlockCopy;
  let llmUsed = false;
  let fallbackReason: string | undefined;
  try {
    const json = await callJsonLlm<Record<string, string>>(String(merchantId), {
      system: REWRITE_SYSTEM,
      prompt: buildPrompt(
        {
          confirmedTruth: f,
          materialEvidence: block.evidenceRefs,
          creativeContext: {
            thisBlock: { type: block.type, purpose: block.purpose, goal: block.communicationGoal },
            currentCopy: block.copy ?? {},
            instruction: instruction ?? '（无额外要求，按原传播任务改写得更利落）',
          },
          forbiddenAssumptions: BANNED_PHRASES,
        },
        `只改写这一块，输出 JSON：{"headline":"（<=24字，hero/lead/statement/quote 需要）","body":"（正文，<=120字）","caption":"（配图说明，<=20字，有图时需要）"}`
      ),
      temperature: 0.85,
      note: 'V3 editor rewrite-block',
    });
    copy = {
      headline: String(json.headline ?? '').slice(0, 40),
      body: String(json.body ?? '').slice(0, 200),
      caption: String(json.caption ?? '').slice(0, 30),
    };
    llmUsed = true;
  } catch {
    // 离线 / 积分耗尽 / 供应商报错 → 确定性改写（保持 purpose，只用已确认事实）
    copy = deterministicRewrite(block, truth);
    fallbackReason = 'editor:rewrite-block LLM 不可用，用确定性改写';
  }

  const blocks = doc.blocks.map((b, i) => (i === idx ? { ...b, copy } : b));
  return finalize(doc, doc.direction, blocks, truth, `rewrite-block:${blockId}`, llmUsed, fallbackReason);
}

/** 换图：替换指定 block 的 mediaRefs（确定性，不消耗额度） */
export async function replaceImage(
  doc: PromoDocument,
  truth: ActivityTruth,
  _merchantId: string | number,
  blockId: string,
  photoId: string,
  photoSrc?: string
): Promise<EditorResult> {
  const idx = doc.blocks.findIndex((b) => b.id === blockId);
  if (idx < 0) throw new Error(`blockId 不存在：${blockId}`);
  if (!photoId) throw new Error('photoId 必填');
  const blocks = doc.blocks.map((b, i) =>
    i === idx
      ? {
          ...b,
          mediaRefs: [photoId],
          copy: { ...b.copy, caption: photoSrc ? String(photoSrc).slice(0, 30) : b.copy?.caption },
        }
      : b
  );
  return finalize(doc, doc.direction, blocks, truth, `replace-image:${blockId}->${photoId}`, false);
}

/** 离线降级用的确定性改写：只用已确认事实 + 该块 purpose，不生产套话 */
function deterministicRewrite(block: ContentBlock, truth: ActivityTruth): BlockCopy {
  const f = truth.confirmedFacts;
  const facts = [f.date, f.place, f.days ? `${f.days}天` : '', f.difficulty].filter(Boolean).join(' · ');
  const headline =
    block.type === 'hero' ? String(f.title ?? f.place ?? '').slice(0, 20) : block.purpose.slice(0, 16);
  let body = block.communicationGoal || block.purpose;
  if (block.evidenceRefs.length) body += `；依据：${block.evidenceRefs.slice(0, 2).join('、')}`;
  if (facts) body += `（${facts}）`;
  return { headline: headline.trim(), body: body.slice(0, 120), caption: '' };
}
