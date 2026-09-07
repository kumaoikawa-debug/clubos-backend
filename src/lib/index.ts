import { PrismaClient } from '@prisma/client';
import type { ZodError } from 'zod';

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
