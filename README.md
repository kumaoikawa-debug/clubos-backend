# ClubOS 支付分账 + 会员后端

> 对应设计：`../clubos-payments-spec.md` · 画布：ClubOS 支付分账详细设计（阶段二~三）
> 状态：**微信支付 v3 接口已真实接入（带桩兜底），会员功能（订阅/积分/AI 代理/复购流失洞察）已落地。**

## 设计原则

**所有真实外部调用集中在 `src/services/wechatPay.ts` + `src/services/wechatCrypto.ts`。**
业务层（routes / services）只依赖这些文件导出的接口；`config.wechat.enabled` 为 true 时走真实 v3 接口，未配置时自动降级为桩实现，本地 / demo 可全程跑通。

## 目录结构

```
clubos-backend/
├── prisma/schema.prisma       # 9 张表：merchants / activities / orders / payments / split_ledger / payouts
│                             #        + subscriptions / point_ledger / api_key_vault
└── src/
    ├── index.ts               # Express 入口（挂载 /api/pay、rawBody 捕获、统一错误处理、启动调度）
    ├── config.ts              # 环境变量与业务参数
    ├── lib/index.ts           # Prisma 单例 + 统一响应 + 订单号生成 + 金额工具
    ├── scheduler.ts           # 定时任务：分账重试 1m / 关单 5m / 对账每日 02:00 北京
    ├── auth/jwt.ts            # 管理端 JWT（HS256，node:crypto）
    ├── middleware/index.ts    # requireAdmin（JWT 鉴权）+ verifyWechatNotify（验签 + 解密）
    ├── routes/
    │   ├── index.ts           # 路由注册（notify 公开 / admin.login 公开 / 其余挂 JWT）
    │   ├── orders.ts          # 统一下单 / 查询订单
    │   ├── notify.ts          # 微信支付回调（幂等，解密 resource）
    │   ├── split.ts           # 发起分账 / 批量重试
    │   ├── refund.ts          # 退款（含分账回退）
    │   ├── settle.ts          # 日终对账 / 生成结算 / 关闭超时订单
    │   ├── admin.ts           # 管理端登录（换取 JWT）
    │   └── membership.ts      # 会员订阅 / 状态 / 洞察 / AI 代理 / 自备 Key
    └── services/
        ├── wechatCrypto.ts    # ★ 微信签名 / 验签 / AES-256-GCM 解密（node:crypto）
        ├── wechatPay.ts       # ★ 微信支付适配层（6 方法真实调用 + 桩兜底）
        ├── orderService.ts    # 建单 / 回调入账 / 超时关单 / 积分发放
        ├── splitService.ts    # 分账执行 + 失败重试
        ├── refundService.ts   # 退款（先回退分账再退款）
        ├── settleService.ts   # 三向对账 + T+1 结算
        ├── membershipService.ts # 会员引擎：订阅 / 积分 / 复购推荐 / 流失提醒
        ├── aiProxyService.ts  # 会员版「AI 全包」代理（平台 Key / 自备 Key）
        └── vault.ts           # 密钥加密存储（AES-256-GCM）
```

## 快速开始

```bash
cd clubos-backend
npm install
cp .env.example .env        # 填 DATABASE_URL + 微信支付证书路径
npm run prisma:generate
npm run prisma:migrate       # 首次会创建 9 张表
npm run dev                  # http://localhost:3000
```

自检：`curl http://localhost:3000/health` → `{"status":"ok","wechatEnabled":false}`
（未配置微信支付时为 `false`，仍可用桩跑通下单 → 回调 → 分账全流程）

## 接口清单

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/api/pay/admin/login` | 公开 | 管理端登录，口令 `ADMIN_CODE`，返回 JWT |
| POST | `/api/pay/unified-order` | JWT | 统一下单，建 pending 订单并返回 JSAPI 调起参数 |
| GET  | `/api/pay/orders/:id` | JWT | 查询订单（前端支付后轮询） |
| POST | `/api/pay/notify` | 验签 | 微信支付回调（幂等，必须回 SUCCESS） |
| POST | `/api/pay/split/apply` | JWT | 对单笔订单发起分账 |
| POST | `/api/pay/split/retry` | JWT | 批量重试失败分账（建议定时任务调用，勿暴露公网） |
| POST | `/api/pay/refund` | JWT | 退款（已分账则先回退分账） |
| GET  | `/api/pay/settle/daily?date=YYYY-MM-DD` | JWT | 日终三向对账 |
| POST | `/api/pay/settle/payouts` | JWT | 手动生成某日 T+1 结算记录 |
| POST | `/api/pay/jobs/close-expired` | JWT | 关闭超时未支付订单 |
| POST | `/api/pay/membership/subscribe` | JWT | 开通 / 续费会员（monthly/yearly） |
| GET  | `/api/pay/membership/status` | JWT | 会员状态 + 积分 |
| GET  | `/api/pay/membership/insights` | JWT | 复购推荐 + 流失提醒 |
| POST | `/api/pay/membership/ai-proxy` | JWT | AI 代理（会员版用平台 Key，免费版用自备 Key） |
| POST | `/api/pay/membership/keys` | JWT | 免费版配置自备 LLM Key（加密存储） |

## 接入清单（已全部落地 ✅）

`wechatPay.ts` 的 6 个方法与 `verifyWechatNotify` 均已实现真实 v3 调用；`requireAdmin` 已改为真实 JWT；定时任务已挂 `scheduler.ts`。未配置凭证时全部自动降级为桩，不影响本地联调。

| # | 位置 | 状态 | 说明 |
|---|---|---|---|
| 1 | `middleware/index.ts` → `verifyWechatNotify` | ✅ | 平台证书 RSA-SHA256 验签 + APIv3 密钥 AES-256-GCM 解密 |
| 2 | `wechatPay.ts` → `unifiedOrder` | ✅ | `/v3/pay/transactions/jsapi` + JSAPI 二次签名 |
| 3 | `wechatPay.ts` → `applySplit` | ✅ | 服务商分账（俱乐部 + 平台各一笔） |
| 4 | `wechatPay.ts` → `refund` / `reverseSplit` | ✅ | 退款与分账回退 |
| 5 | `wechatPay.ts` → `downloadBill` | ✅ | 下载并解析对账单 CSV → BillRow[] |
| 6 | `wechatPay.ts` → `queryOrder` | ✅ | 主动查单（补偿回调丢失） |
| 7 | `middleware/index.ts` → `requireAdmin` | ✅ | 真实 JWT 校验 + 商户归属（req.admin） |
| 8 | `scheduler.ts` | ✅ | 分账重试 1m / 关单 5m / 对账每日 02:00 北京 |

## 会员功能

- **订阅**：`subscribe(merchantId, cycle)` 写 `subscriptions` 并把 `merchants.plan` 置 `member`、`commission_rate` 置 0（免抽成）。
- **积分**：支付成功回调里自动按成交金额加积分（`earnPointsForOrder`，幂等）。
- **AI 全包**：会员版 `/membership/ai-proxy` 直接走平台 Key（`PLATFORM_LLM_KEY`）；免费版走自备 Key（`api_key_vault`，加密存储）。业务层不接触密钥明文。
- **复购 / 流失**：`getInsights` 返回近期活动、最近参与时间、会员剩余天数、7 天内到期则标 `churnRisk`。

## 已内建的关键机制

- **双重幂等**：回调先按 `transaction_id` 去重，再按 `orders.status` 去重。
- **失败不阻塞用户**：分账失败只记台账转重试队列。
- **费率可覆盖**：`member` 强制 0，免费版走 `commission_rate`（默认 0.05）。
- **退款顺序依赖**：已分账先回退分账再退款。
- **对账三向比对**：有差异自动冻结当日结算。
- **密钥不落明**：所有 LLM Key 经 AES-256-GCM 加密后入库。

## 环境要求前置

1. 申请**微信支付服务商**资质；
2. 各俱乐部完成**特约商户进件**，拿到 `wechat_sub_mch_id` 写入 `merchants` 表；
3. 平台商户号与俱乐部商户号的分账比例需在微信后台配置（默认最大 30%，本项目 5% 在范围内）；
4. 将 `apiclient_key.pem`（商户私钥）与平台证书 `wechatpay_platform_cert.pem` 放到 `certs/`，并在 `.env` 填齐 `WECHAT_*`。
