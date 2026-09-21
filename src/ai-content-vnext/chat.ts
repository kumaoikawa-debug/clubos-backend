/**
 * ai-content-vnext —— LLM 调用抽象
 *
 * 所有子模块只依赖 `ChatFn`，默认实现走现有 `proxyChat`（平台 Key / 积分计量），
 * 不直连任何密钥。测试可注入 stub，做到离线验证（§22 benchmark / 契约测试）。
 */
import { proxyChat, type ProxyOptions, type ProxyResult } from '../services/aiProxyService';
import type { GeneratePromoInput } from './types';

export type { ProxyOptions, ProxyResult } from '../services/aiProxyService';

export type ChatFn = (
  merchantId: string,
  prompt: string,
  opts?: ProxyOptions
) => Promise<ProxyResult>;

export const defaultChat: ChatFn = (merchantId, prompt, opts) =>
  proxyChat(BigInt(merchantId), prompt, opts);

/** 从模型输出中稳健提取 JSON（兼容 ```json 围栏 / 前后缀废话） */
export function extractJson<T = unknown>(raw: string): T {
  if (!raw) throw new Error('模型返回空内容');
  let s = raw.trim();
  // 去掉 ```json ... ``` 围栏
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  // 取第一个 { 或 [ 到最后一个 } 或 ]
  const start = s.search(/[[{]/);
  const end = s.lastIndexOf('}');
  const endArr = s.lastIndexOf(']');
  const cut = Math.max(end, endArr);
  if (start >= 0 && cut > start) s = s.slice(start, cut + 1);
  try {
    return JSON.parse(s) as T;
  } catch (e) {
    throw new Error('模型输出不是合法 JSON：' + (e as Error).message + ' | 原文前 200 字：' + raw.slice(0, 200));
  }
}

/** 把活动主记录安全序列化（避免 BigInt / 循环引用） */
export function safeStringifyActivity(activity?: Record<string, unknown>): string {
  if (!activity) return '（未提供活动主记录）';
  try {
    return JSON.stringify(activity, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
  } catch {
    return String(activity);
  }
}

export type { GeneratePromoInput };
