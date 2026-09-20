import { PrismaClient } from '@prisma/client';
import type { ZodError } from 'zod';

/**
 * ★ BigInt 序列化补丁（全局，必须在任何 res.json 之前生效）
 *
 * Prisma 的 BigInt 主键 / 金额字段无法被 JSON.stringify 处理，未打补丁时
 * `res.json(row)` 会抛 `Do not know how to serialize a BigInt` → 接口 500
 * （线上实测：GET /api/pay/ai-credit/summary）。
 *
 * 统一序列化为十进制字符串：id 类字段前端按字符串处理即可；
 * 金额字段本身就是 Decimal→string，不引入浮点误差。
 */
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function toJSON(this: bigint) {
  return this.toString();
};

export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});

export interface ApiResult<T> {
  code: number;
  message: string;
  data: T | null;
}

export function ok<T>(data: T): ApiResult<T> {
  return { code: 0, message: 'ok', data };
}

export function fail(message: string, code = -1): ApiResult<never> {
  return { code, message, data: null };
}

export const logger = {
  info: (...args: unknown[]) => console.log('[info ]', ...args),
  warn: (...args: unknown[]) => console.warn('[warn ]', ...args),
  error: (...args: unknown[]) => console.error('[error]', ...args),
};

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** 平台订单号：OD + yyyymmdd + 8 位随机，业务幂等键 */
export function generateOrderNo(): string {
  const d = new Date();
  const day = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  let suffix = '';
  for (let i = 0; i < 8; i += 1) {
    suffix += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return `OD${day}${suffix}`;
}

/** 金额保留 2 位小数，避免浮点误差进入数据库 */
export function money(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 把 zod 校验错误转成中文可读文案（zod 默认只报 "Required"） */
export function zodMessage(err: ZodError): string {
  return err.issues
    .map((issue) => {
      const field = issue.path.join('.') || '参数';
      if (issue.code === 'invalid_type' && issue.received === 'undefined') return `${field} 必填`;
      return `${field} ${issue.message}`;
    })
    .join('；');
}
