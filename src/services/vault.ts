import * as crypto from 'node:crypto';
import { config } from '../config';

/**
 * 密钥保管：用 KEY_VAULT_SECRET（32 字节）做 AES-256-GCM 加密后落库。
 * 明文仅在调用 LLM 时内存中解密，数据库中只存密文。
 */

function key(): Buffer {
  const k = Buffer.from(config.keyVaultSecret, 'utf8');
  if (k.length !== 32) throw new Error('KEY_VAULT_SECRET 必须为 32 字节');
  return k;
}

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

export function decryptSecret(stored: string): string {
  const [ivB64, tagB64, encB64] = stored.split(':');
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const enc = Buffer.from(encB64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}
