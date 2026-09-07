import * as crypto from 'node:crypto';
import { config } from '../config';
import { logger } from '../lib';
import { buildAuthorization, signWithPrivateKey } from './wechatCrypto';

/**
 * ============================================================
 *  微信支付适配层 —— 真实接口 + 桩兜底
 * ============================================================
 * 这是**唯一**需要替换为真实外部调用的文件。
 * 业务层（routes / services）只依赖本文件导出的接口，接入时无需改动。
 *
 * 行为：
 *  - config.wechat.enabled 为 true（mchid/appid/apiV3Key/serialNo 齐全）→ 调真实 v3 接口；
 *  - 否则 → 返回模拟结果，本地自测 / demo 可跑通完整流程。
 *
 * 统一约定：金额单位：元（Decimal(10,2)），调用微信时内部转换成分。
 */

const BASE = 'https://api.mch.weixin.qq.com';

// ---------- 入参 / 出参类型 ----------

export interface UnifiedOrderParams {
  orderNo: string;
  amount: number;
  openid: string;
  description: string;
}

/** 前端 JSAPI 调起支付所需参数 */
export interface UnifiedOrderResult {
  appId: string;
  timeStamp: string;
  nonceStr: string;
  package: string;
  signType: 'RSA';
  paySign: string;
}

export interface QueryOrderResult {
  transactionId: string | null;
  /** SUCCESS | NOTPAY | CLOSED | REFUND | PAYERROR */
  tradeState: string;
}

export interface ApplySplitParams {
  orderNo: string;
  transactionId: string;
  subMchId: string;
  /** 入俱乐部金额（元） */
  merchantAmount: number;
  /** 平台抽成（元） */
  platformFee: number;
}

export interface SplitResult {
  /** 微信分账单号 */
  outOrderNo: string;
  /** PROCESSING | SUCCESS | FAILED */
  state: string;
}

export interface RefundParams {
  orderNo: string;
  transactionId: string;
  /** 原订单金额（元） */
  total: number;
  /** 退款金额（元） */
  refundAmount: number;
  reason?: string;
}

export interface RefundResult {
  refundId: string;
  /** SUCCESS | ABNORMAL | PROCESSING */
  state: string;
}

export interface BillRow {
  transactionId: string;
  orderNo: string;
  amount: number;
  /** SUCCESS | REFUND | ... */
  tradeState: string;
}

// ---------- 工具 ----------

function toFen(yuan: number): number {
  return Math.round(yuan * 100);
}

/** 调微信 v3 接口：自动带 Authorization 头，非 2xx 抛错 */
async function wechatRequest<T>(method: 'GET' | 'POST', path: string, bodyObj?: unknown): Promise<T> {
  const body = bodyObj ? JSON.stringify(bodyObj) : '';
  const auth = buildAuthorization(method, path, body);
  const resp = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      Authorization: auth,
      'Content-Type': 'application/json',
      'User-Agent': 'ClubOS/1.0',
    },
    body: method === 'POST' ? body : undefined,
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`微信支付 ${method} ${path} 返回 ${resp.status}: ${text}`);
  }
  return text ? (JSON.parse(text) as T) : (undefined as unknown as T);
}

/** 极简 CSV 解析（支持双引号包裹与字段内逗号） */
function parseCsv(text: string): Record<string, string>[] {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  const header = parseCsvLine(lines[0]);
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cells = parseCsvLine(lines[i]);
    // 账单尾部汇总行（以 `总交易单数` 开头）忽略
    if (cells[0]?.startsWith('总交易单数')) break;
    const obj: Record<string, string> = {};
    header.forEach((h, idx) => {
      obj[h] = cells[idx] ?? '';
    });
    rows.push(obj);
  }
  return rows;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

// ---------- 真实实现（enabled） / 桩实现（disabled） ----------

export const wechatPay = {
  /** 统一下单（JSAPI） */
  async unifiedOrder(params: UnifiedOrderParams): Promise<UnifiedOrderResult> {
    if (!config.wechat.enabled) {
      logger.warn('[STUB] wechatPay.unifiedOrder 未接入真实接口，返回模拟结果');
      return {
        appId: config.wechat.appId || 'wxSTUBAPPID',
        timeStamp: String(Math.floor(Date.now() / 1000)),
        nonceStr: crypto.randomUUID().slice(0, 16),
        package: `prepay_id=wx${Date.now()}${Math.floor(Math.random() * 1e6)}`,
        signType: 'RSA',
        paySign: 'STUB_PAY_SIGN',
      };
    }

    const path = '/v3/pay/transactions/jsapi';
    const body = {
      appid: config.wechat.appId,
      mchid: config.wechat.mchId,
      description: params.description,
      out_trade_no: params.orderNo,
      notify_url: config.wechat.notifyUrl,
      amount: { total: toFen(params.amount), currency: 'CNY' },
      payer: { openid: params.openid },
    };
    const resp = await wechatRequest<{ prepay_id: string }>('POST', path, body);

    // 二次签名：前端 JSAPI 调起支付
    const timeStamp = String(Math.floor(Date.now() / 1000));
    const nonceStr = crypto.randomUUID().slice(0, 16);
    const pkg = `prepay_id=${resp.prepay_id}`;
    const paySignMsg = `${config.wechat.appId}\n${timeStamp}\n${nonceStr}\n${pkg}\n`;
    const paySign = signWithPrivateKey(paySignMsg);

    return { appId: config.wechat.appId, timeStamp, nonceStr, package: pkg, signType: 'RSA', paySign };
  },

  /** 查询订单 */
  async queryOrder(params: { orderNo: string }): Promise<QueryOrderResult> {
    if (!config.wechat.enabled) {
      logger.warn('[STUB] wechatPay.queryOrder 未接入真实接口，返回模拟结果');
      return { transactionId: `420000${Date.now()}`, tradeState: 'NOTPAY' };
    }
    const path = `/v3/pay/transactions/out-trade-no/${params.orderNo}?mchid=${config.wechat.mchId}`;
    const resp = await wechatRequest<{ transaction_id: string; trade_state: string }>('GET', path);
    return { transactionId: resp.transaction_id, tradeState: resp.trade_state };
  },

  /** 发起分账（服务商分账：俱乐部 + 平台各一笔） */
  async applySplit(params: ApplySplitParams): Promise<SplitResult> {
    if (!config.wechat.enabled) {
      logger.warn('[STUB] wechatPay.applySplit 未接入真实接口，返回模拟结果');
      return { outOrderNo: `SP${params.orderNo}`, state: 'SUCCESS' };
    }
    const path = '/v3/profitsharing/orders';
    const body = {
      appid: config.wechat.appId,
      sub_mchid: params.subMchId,
      out_order_no: `SP${params.orderNo}`,
      transaction_id: params.transactionId,
      receivers: [
        { type: 'MERCHANT_ID', account: params.subMchId, amount: toFen(params.merchantAmount) },
        { type: 'MERCHANT_ID', account: config.wechat.mchId, amount: toFen(params.platformFee) },
      ],
    };
    const resp = await wechatRequest<{ out_order_no: string; state: string }>('POST', path, body);
    return { outOrderNo: resp.out_order_no, state: resp.state };
  },

  /** 分账回退（退款前必须先回退已分账金额） */
  async reverseSplit(params: {
    orderNo: string;
    transactionId: string;
    amount: number;
  }): Promise<SplitResult> {
    if (!config.wechat.enabled) {
      logger.warn('[STUB] wechatPay.reverseSplit 未接入真实接口，返回模拟结果');
      return { outOrderNo: `RT${params.orderNo}`, state: 'SUCCESS' };
    }
    const path = '/v3/profitsharing/return-orders';
    const body = {
      sub_mchid: config.wechat.mchId,
      out_order_no: `RT${params.orderNo}`,
      out_return_no: `RT${params.orderNo}`,
      return_mchid: config.wechat.mchId,
      return_amount: toFen(params.amount),
      description: '活动退款回退分账',
    };
    const resp = await wechatRequest<{ out_order_no: string; state: string }>('POST', path, body);
    return { outOrderNo: resp.out_order_no, state: resp.state };
  },

  /** 申请退款 */
  async refund(params: RefundParams): Promise<RefundResult> {
    if (!config.wechat.enabled) {
      logger.warn('[STUB] wechatPay.refund 未接入真实接口，返回模拟结果');
      return { refundId: `RF${params.orderNo}`, state: 'SUCCESS' };
    }
    const path = '/v3/refund/domestic/refunds';
    const body = {
      transaction_id: params.transactionId,
      out_trade_no: params.orderNo,
      out_refund_no: `RF${params.orderNo}`,
      reason: params.reason ?? '活动退款',
      amount: { refund: toFen(params.refundAmount), total: toFen(params.total), currency: 'CNY' },
    };
    const resp = await wechatRequest<{ refund_id: string; status: string }>('POST', path, body);
    return { refundId: resp.refund_id, state: resp.status };
  },

  /** 下载对账单并解析为 BillRow[] */
  async downloadBill(params: { date: string }): Promise<BillRow[]> {
    if (!config.wechat.enabled) {
      logger.warn('[STUB] wechatPay.downloadBill 未接入真实接口，返回空账单');
      return [];
    }
    const billPath = `/v3/bill/tradebill?bill_date=${params.date}&bill_type=ALL`;
    const bill = await wechatRequest<{ download_url: string }>('GET', billPath);
    const csvResp = await fetch(bill.download_url);
    const csv = await csvResp.text();
    const rows = parseCsv(csv);

    return rows
      .filter((r) => r['交易状态'] === 'SUCCESS' || r['交易状态'] === 'REFUND')
      .map((r) => ({
        transactionId: r['微信支付单号'] ?? r['transaction_id'] ?? '',
        orderNo: r['商户订单号'] ?? r['out_trade_no'] ?? '',
        amount: Number(r['订单金额'] ?? r['amount'] ?? 0) / 100,
        tradeState: r['交易状态'] ?? r['trade_state'] ?? '',
      }));
  },
};

export { toFen };
