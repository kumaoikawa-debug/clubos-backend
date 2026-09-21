/**
 * 渠道生成计量（与编排器同款 metered，独立导出避免与 index.ts 循环依赖）
 */
import type { ChatFn, ProxyResult } from '../chat';

interface Meter {
  credits: number;
  tokens: number;
  balance: number;
  source: string;
}

export function metered(chat: ChatFn): { fn: ChatFn; meter: Meter } {
  const meter: Meter = { credits: 0, tokens: 0, balance: 0, source: 'platform' };
  const fn: ChatFn = async (mid, prompt, opts) => {
    const r: ProxyResult = await chat(mid, prompt, opts);
    meter.credits += r.credits;
    meter.tokens += r.tokens;
    meter.balance = r.balance;
    meter.source = r.source;
    return r;
  };
  return { fn, meter };
}
