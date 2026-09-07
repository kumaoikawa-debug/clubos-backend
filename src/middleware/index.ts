import type { NextFunction, Request, Response } from 'express';
import { fail } from '../lib';
import { logger } from '../lib';
import { config } from '../config';
import { verifyWechatSignature, decryptResource } from '../services/wechatCrypto';
import { verifyToken } from '../auth/jwt';

type RawReq = Request & { rawBody?: Buffer; wechatResource?: unknown };

/**
 * 微信支付回调验签（API v3 规范）
 *
 * 校验头：Wechatpay-Timestamp / Wechatpay-Nonce / Wechatpay-Signature / Wechatpay-Serial
 * 验签失败必须返回 401，绝不能放行——否则任何人都能伪造支付成功回调。
 * 验签通过后，用 APIv3 密钥解密 body.resource，明文挂到 req.wechatResource 供路由使用。
 */
export function verifyWechatNotify(req: RawReq, res: Response, next: NextFunction): void {
  const ts = req.header('wechatpay-timestamp');
  const nonce = req.header('wechatpay-nonce');
  const sig = req.header('wechatpay-signature');
  const serial = req.header('wechatpay-serial');

  // 本地自测：未配置微信支付、也无签名头 → 放行（仅用于开发联调）
  if (!ts || !nonce || !sig) {
    if (!config.wechat.enabled) {
      next();
      return;
    }
    res.status(401).json(fail('缺少微信回调签名头'));
    return;
  }

  if (!config.wechat.enabled) {
    res.status(401).json(fail('微信支付未配置，拒绝接收真实回调'));
    return;
  }

  // 序列号不匹配平台证书（多证书轮换场景）——这里仅做存在性校验
  if (serial && config.wechat.serialNo && serial !== config.wechat.serialNo) {
    logger.warn(`[notify] 回调序列号 ${serial} 与当前 ${config.wechat.serialNo} 不一致，可能证书已轮换`);
  }

  const rawBody = req.rawBody?.toString('utf8') ?? '';
  if (!verifyWechatSignature(ts, nonce, rawBody, sig)) {
    logger.warn('[notify] 回调签名校验失败，拒绝');
    res.status(401).json(fail('回调签名校验失败'));
    return;
  }

  try {
    const resource = (req.body as { resource?: { ciphertext: string; nonce: string; associated_data?: string } })
      ?.resource;
    if (resource?.ciphertext) {
      req.wechatResource = decryptResource(resource, config.wechat.apiV3Key);
    }
  } catch (err) {
    logger.error('[notify] 回调解密失败', err);
    res.status(400).json(fail('回调解密失败'));
    return;
  }

  next();
}

/**
 * 管理端鉴权：校验 Authorization: Bearer <jwt>，解析出 merchantId / role，挂到 req.admin。
 * 路由据此做数据归属校验，防止越权操作别人的订单 / 会员数据。
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const auth = req.header('authorization');
  if (!auth || !auth.startsWith('Bearer ')) {
    res.status(401).json(fail('缺少或格式错误的 Authorization 头'));
    return;
  }
  try {
    req.admin = verifyToken(auth.slice(7));
    next();
  } catch (err) {
    res.status(401).json(fail(err instanceof Error ? err.message : '鉴权失败'));
  }
}
