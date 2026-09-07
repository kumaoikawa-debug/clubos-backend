import * as crypto from 'node:crypto';
import { config } from '../config';

/**
 * 管理端 JWT（HS256，基于 node:crypto，不引入额外依赖）
 * 用于在管理端接口上标识商户身份，防止越权操作他人订单 / 会员数据。
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      admin?: AdminClaims;
    }
  }
}

export interface AdminClaims {
  /** 商户 ID（字符串化 BigInt） */
  sub: string;
  role: 'merchant' | 'admin';
  plan?: string;
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

/** 签发 token，默认 7 天有效 */
export function signToken(claims: AdminClaims, expiresInSec = 60 * 60 * 24 * 7): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = { ...claims, iat: now, exp: now + expiresInSec };
  const data = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = crypto.createHmac('sha256', config.jwtSecret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

/** 校验 token，失败抛错 */
export function verifyToken(token: string): AdminClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('JWT 格式错误');
  const [h, p, s] = parts;
  const expected = crypto.createHmac('sha256', config.jwtSecret).update(`${h}.${p}`).digest('base64url');
  if (expected !== s) throw new Error('JWT 签名校验失败');
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as AdminClaims & {
    exp?: number;
  };
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) throw new Error('JWT 已过期');
  return payload;
}
