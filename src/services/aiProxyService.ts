import { prisma, logger } from '../lib';
import { config } from '../config';
import { decryptSecret } from './vault';
import * as aiCredit from './aiCreditService';

/**
 * AI 统一代理（V2.0 单俱乐部版）
 *  - V2.0 下所有俱乐部统一走「平台 Key」（不再区分会员/免费自备 Key），
 *    用量按 AI 积分计量：调用前预检余额，调用成功后按真实 token 折算扣减。
 *  - 业务层只调用本服务，不接触任何密钥明文。
 */

export interface ProxyOptions {
  model?: string;
  temperature?: number;
  /** 系统提示词（前端多场景需要 system 角色，如文案生成、JSON 结构化解析） */
  system?: string;
  /** 强制 JSON 输出，DeepSeek 兼容 { type: 'json_object' } */
  response_format?: { type: string };
  /** 备注，写进额度流水便于对账 */
  note?: string;
}

interface DeepSeekResult {
  content: string;
  totalTokens: number;
}

async function callDeepSeek(
  apiKey: string,
  prompt: string,
  opts?: ProxyOptions
): Promise<DeepSeekResult> {
  const model = opts?.model ?? 'deepseek-chat';
  // 组装 messages：有 system 则系统角色在前，再追加用户提示（与前端直连契约一致）
  const messages: { role: 'system' | 'user'; content: string }[] = [];
  if (opts?.system && opts.system.trim()) {
    messages.push({ role: 'system', content: opts.system });
  }
  messages.push({ role: 'user', content: prompt });

  const reqBody: Record<string, unknown> = {
    model,
    messages,
    temperature: opts?.temperature ?? 0.8,
  };
  // 仅在需要时附加 response_format（JSON 模式），避免无谓报错
  if (opts?.response_format && opts.response_format.type) {
    reqBody.response_format = opts.response_format;
  }

  const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(reqBody),
  });
  if (!resp.ok) {
    throw new Error(`DeepSeek 返回 ${resp.status}: ${await resp.text()}`);
  }
  const json = (await resp.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };
  const content = json.choices?.[0]?.message?.content ?? '';
  if (!content) throw new Error('DeepSeek 返回空内容');
  const totalTokens =
    json.usage?.total_tokens ??
    (json.usage?.prompt_tokens ?? 0) + (json.usage?.completion_tokens ?? 0);
  return { content, totalTokens };
}

export interface ProxyResult {
  content: string;
  source: 'platform' | 'self';
  /** 本次消耗的 AI 积分 */
  credits: number;
  /** 真实 token 数（供应商未回传时为 0） */
  tokens: number;
  balance: number;
}

export async function proxyChat(
  merchantId: bigint | string,
  prompt: string,
  opts?: ProxyOptions
): Promise<ProxyResult> {
  const mid = BigInt(merchantId);

  // 1) 调用前预检：余额必须大于 0
  const account = await aiCredit.getAccount(mid);
  if (aiCredit.balanceOf(account) <= 0) {
    throw new Error('AI 积分不足，请充值或等待每月基础额度刷新');
  }

  // 2) 选 Key：V2.0 统一走平台 Key；未配置平台 Key 时降级到俱乐部自备 Key
  let apiKey = config.platformLlmKey;
  let source: 'platform' | 'self' = 'platform';
  if (!apiKey) {
    const vault = await prisma.apiKeyVault.findUnique({
      where: { merchantId_channel: { merchantId: mid, channel: 'deepseek' } },
    });
    if (!vault) throw new Error('平台 LLM Key 未配置，且俱乐部未自备 Key');
    apiKey = decryptSecret(vault.secretEnc);
    source = 'self';
  }

  logger.info(`[ai] merchant=${mid} 走${source === 'platform' ? '平台' : '自备'} Key`);
  const { content, totalTokens } = await callDeepSeek(apiKey, prompt, opts);

  // 3) 调用成功后按真实 token 折算扣减；供应商未回传 token 时按 1 积分兜底
  const credits = totalTokens > 0 ? aiCredit.creditsForTokens(totalTokens) : 1;
  const res = await aiCredit.consume(
    mid,
    credits,
    opts?.note ?? 'AI 内容生成',
    totalTokens || undefined
  );

  return { content, source, credits: res.consumed, tokens: totalTokens, balance: res.balance };
}
