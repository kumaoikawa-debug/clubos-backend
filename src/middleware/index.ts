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
 * CORS —— 前后端分离部署（前端 GitHub Pages + 后端 Render）**必须**开启。
 *
 * ★为什么是硬需求：浏览器跨域发 `POST + Content-Type: application/json` 之前会先发
 *   `OPTIONS` 预检，并要求预检响应带 `Access-Control-Allow-Origin`；真实响应也必须带该头，
 *   否则浏览器会**直接丢弃响应并让 fetch 抛错**（JS 里只看到 "Failed to fetch"，看不到 4xx/5xx）。
 *   典型误判：服务端 curl 全绿（curl 不受同源策略约束），网页上「测试后端连接」却永远失败。
 * ★安全性：本服务鉴权走 `Authorization: Bearer <jwt>`（不是 Cookie），放行来源不存在 CSRF 风险。
 *   默认反射请求方 Origin；若将来绑自有域名想收紧，设 env `CORS_ORIGINS=https://a.com,https://b.com`。
 * ★必须挂在所有路由**之前**（含鉴权中间件），且 OPTIONS 要提前 204 返回。
 */
export function cors(req: Request, res: Response, next: NextFunction): void {
  const origin = req.header('origin');
  const allow = config.corsOrigins.trim();

  if (allow === '*' || !allow) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  } else {
    const list = allow.split(',').map((s) => s.trim()).filter(Boolean);
    if (origin && list.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
    else if (!origin && list.length) res.setHeader('Access-Control-Allow-Origin', list[0]);
  }

  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  // 回显预检请求声明的头，避免前端加自定义头时被拦
  res.setHeader(
    'Access-Control-Allow-Headers',
    req.header('access-control-request-headers') || 'Content-Type,Authorization'
  );
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
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
