import { Router } from 'express';
import type { Request } from 'express';
import { logger } from '../lib';
import { verifyWechatNotify } from '../middleware';
import { handlePayNotify } from '../services/orderService';

const router = Router();

/**
 * POST /api/pay/notify · 微信支付回调
 *
 * 契约要点：
 *  - 幂等：重复通知只处理一次（内部按 transaction_id + order.status 双重去重）；
 *  - 无论业务是否成功，**只要消息已收到都必须回 SUCCESS**，否则微信会持续重投 24h；
 *  - 业务异常时应记录日志并交由对账/重试队列兜底，而不是回 FAIL。
 */
type RawReq = Request & { rawBody?: Buffer; wechatResource?: unknown };

router.post('/notify', verifyWechatNotify, async (req: RawReq, res) => {
  // 已配置微信支付时，中间件已解密 resource 挂到 req.wechatResource；
  // 未配置（桩）时回退读取 req.body 字段，便于本地联调。
  const resource = req.wechatResource as
    | { transaction_id?: string; out_trade_no?: string; trade_state?: string }
    | undefined;

  const transactionId: string | undefined =
    resource?.transaction_id ?? req.body?.transaction_id ?? req.body?.resource?.transaction_id;
  const orderNo: string | undefined =
    resource?.out_trade_no ?? req.body?.out_trade_no ?? req.body?.resource?.out_trade_no;
  const tradeState: string | undefined =
    resource?.trade_state ?? req.body?.trade_state ?? req.body?.resource?.trade_state;

  if (!transactionId || !orderNo) {
    logger.warn('[notify] 回调缺少 transaction_id / out_trade_no，已忽略');
    // 缺字段属于消息本身有问题，回 SUCCESS 避免微信无意义重投，由对账发现
    res.type('text/plain').send('SUCCESS');
    return;
  }

  if (tradeState && tradeState !== 'SUCCESS') {
    logger.info(`[notify] 支付未成功 trade_state=${tradeState} orderNo=${orderNo}`);
    res.type('text/plain').send('SUCCESS');
    return;
  }

  try {
    await handlePayNotify({ transactionId, orderNo, raw: req.body });
    res.type('text/plain').send('SUCCESS');
  } catch (err) {
    logger.error(`[notify] 处理失败 orderNo=${orderNo}`, err);
    res.status(500).type('text/plain').send('FAIL');
  }
});

export default router;
