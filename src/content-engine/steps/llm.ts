/**
 * Content Engine V3 —— LLM 调用层
 *
 * 文档 §21 Prompt 规范：
 * 每个 Prompt 必须严格区分四块信息，禁止大而全 Prompt。
 *
 *   【Confirmed Truth】      可以写成事实
 *   【Material Evidence】    图片/历史素材里看到了什么
 *   【Creative Context】     只用于决定表达，不构成事实
 *   【Forbidden Assumptions】没有证据不得写
 *
 * 所有结构化输出走 JSON 模式；解析失败必须向上抛（由 Repair Loop 处理），
 * 不允许静默吞错后返回模板内容。
 */

import { proxyChat } from '../../services/aiProxyService';

export interface EvidenceBundle {
  /** 可以是任意结构化对象（ActivityTruth["confirmedFacts"] 等接口无索引签名，故用 unknown） */
  confirmedTruth: unknown;
  materialEvidence: string[];
  creativeContext: unknown;
  forbiddenAssumptions: string[];
}

/**
 * 组装标准 Prompt 文本。
 * 四块信息缺一不可 —— 缺了 Forbidden Assumptions，模型就会去猜。
 */
export function buildPrompt(ev: EvidenceBundle, task: string): string {
  const truth = JSON.stringify(ev.confirmedTruth ?? {}, null, 2);
  const material = ev.materialEvidence.length ? ev.materialEvidence.map((s) => `- ${s}`).join('\n') : '（无）';
  const creative =
    ev.creativeContext && Object.keys(ev.creativeContext as Record<string, unknown>).length
      ? JSON.stringify(ev.creativeContext, null, 2)
      : '（无）';
  const forbidden = ev.forbiddenAssumptions.length
    ? ev.forbiddenAssumptions.map((s) => `- ${s}`).join('\n')
    : '（无）';

  return [
    '【Confirmed Truth】可以写成事实的内容：',
    truth,
    '',
    '【Material Evidence】图片/历史素材中确实存在的内容：',
    material,
    '',
    '【Creative Context】仅用于决定表达方式，不得当作发生过的事实：',
    creative,
    '',
    '【Forbidden Assumptions】没有证据，绝对不得写出的内容：',
    forbidden,
    '',
    '【任务】',
    task,
  ].join('\n');
}

export interface LlmCallOptions {
  system: string;
  prompt: string;
  temperature?: number;
  note?: string;
}

/** 调用平台 LLM（走 aiProxyService，含积分预算与密钥托管） */
export async function callJsonLlm<T>(
  merchantId: bigint | string,
  opts: LlmCallOptions
): Promise<T> {
  const res = await proxyChat(merchantId, opts.prompt, {
    system: opts.system,
    temperature: opts.temperature ?? 0.7,
    response_format: { type: 'json_object' },
    note: opts.note ?? 'Content Engine V3',
  });
  const parsed = parseJsonStrict<T>(res.content);
  if (parsed === null) {
    throw new Error('LLM 未返回可解析的 JSON');
  }
  return parsed;
}

/** 严格 JSON 解析：容忍 markdown 代码块，容忍首尾噪声，但不允许返回 null 蒙混过关 */
export function parseJsonStrict<T>(raw: string): T | null {
  if (!raw) return null;
  let s = String(raw).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(s) as T;
  } catch {
    /* 继续兜底取第一个对象/数组 */
  }
  const obj = s.match(/\{[\s\S]*\}/);
  if (obj) {
    try {
      return JSON.parse(obj[0]) as T;
    } catch {
      return null;
    }
  }
  const arr = s.match(/\[[\s\S]*\]/);
  if (arr) {
    try {
      return JSON.parse(arr[0]) as T;
    } catch {
      return null;
    }
  }
  return null;
}
