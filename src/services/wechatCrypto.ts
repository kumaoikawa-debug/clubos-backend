import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { config } from '../config';

/**
 * ============================================================
 *  微信支付 API v3 —— 密码学基建（请求签名 / 回调解密 / 验签）
 * ============================================================
 * 全部基于 Node 内置 crypto，不引入额外依赖。
 *  - 商户私钥：RSA-SHA256 对请求签名；
 *  - 平台证书：RSA-SHA256 校验回调签名；
 *  - APIv3 密钥：AES-256-GCM 解密回调 resource。
 */

let privateKeyCache: string | null = null;
let platformCertCache: crypto.KeyObject | null = null;

function loadPrivateKey(): string {
  if (privateKeyCache) return privateKeyCache;
  const path = config.wechat.privateKeyPath;
  if (!path) throw new Error('WECHAT_PRIVATE_KEY_PATH 未配置，无法加载商户私钥');
  privateKeyCache = fs.readFileSync(path, 'utf8');
  return privateKeyCache;
}

function loadPlatformCert(): crypto.KeyObject {
  if (platformCertCache) return platformCertCache;
  const path = config.wechat.platformCertPath;
  if (!path) throw new Error('WECHAT_PLATFORM_CERT_PATH 未配置，无法加载平台证书');
  platformCertCache = crypto.createPublicKey(fs.readFileSync(path, 'utf8'));
  return platformCertCache;
}

/** 请求签名原文：METHOD\nURL\nTIMESTAMP\nNONCE\nBODY\n（末尾必须带换行） */
export function buildSignatureMessage(
  method: string,
  url: string,
  timestamp: string,
  nonce: string,
  body = ''
): string {
  return `${method}\n${url}\n${timestamp}\n${nonce}\n${body}\n`;
}

/** 用商户私钥对消息做 RSA-SHA256 签名，返回 base64 */
export function signWithPrivateKey(message: string): string {
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(message);
  sign.end();
  return sign.sign(loadPrivateKey(), 'base64');
}

/** 构造 Authorization 请求头（WECHATPAY2-SHA256-RSA2048 ...） */
export function buildAuthorization(method: string, url: string, body = ''): string {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const message = buildSignatureMessage(method, url, timestamp, nonce, body);
  const signature = signWithPrivateKey(message);
  return (
    `WECHATPAY2-SHA256-RSA2048 mchid="${config.wechat.mchId}",` +
    `nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",` +
    `serial_no="${config.wechat.serialNo}"`
  );
}

/** 校验微信回调签名：TIMESTAMP\nNONCE\nBODY\n 用平台证书验签 */
export function verifyWechatSignature(
  timestamp: string,
  nonce: string,
  body: string,
  signatureBase64: string
): boolean {
  const message = `${timestamp}\n${nonce}\n${body}\n`;
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(message);
  verifier.end();
  try {
    return verifier.verify(loadPlatformCert(), Buffer.from(signatureBase64, 'base64'));
  } catch {
    return false;
  }
}

/** AES-256-GCM 解密回调节报（resource.ciphertext 末尾 16 字节为 authTag） */
export function decryptResource(
  resource: { ciphertext: string; nonce: string; associated_data?: string },
  apiV3Key: string
): unknown {
  const key = Buffer.from(apiV3Key, 'utf8');
  if (key.length !== 32) throw new Error('APIv3 密钥必须为 32 字节');

  const data = Buffer.from(resource.ciphertext, 'base64');
  const authTag = data.subarray(data.length - 16);
  const cipherBytes = data.subarray(0, data.length - 16);
  const iv = Buffer.from(resource.nonce, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  if (resource.associated_data) {
    decipher.setAAD(Buffer.from(resource.associated_data, 'utf8'));
  }
  const decrypted = Buffer.concat([decipher.update(cipherBytes), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}
