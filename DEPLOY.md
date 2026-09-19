# ClubOS 总平台后端 · 部署与联调 Runbook

> 适用范围：把 `clubos-backend/`（Express + TS + Prisma）部署为「总平台后端代理」，
> 让俱乐部前端（`clubos-demo/`）通过它统一调用 DeepSeek，**前端永不持有 API Key**。
> 本文件与 `clubos-demo/src/core.js` 的 `clubLLM()` 客户端配套使用。

---

## 1. 架构与目标

```
俱乐部后台 (clubos-demo/admin.html)
   │  ① 填「总平台后端地址 + 管理员口令 + 商家ID」
   │  ② POST /api/pay/admin/login  → JWT（缓存在本机 localStorage）
   ▼
总平台后端 (clubos-backend)   ←── 唯一持有 PLATFORM_LLM_KEY / PLATFORM_VISION_KEY
   │  ③ POST /api/pay/membership/ai-proxy  (Bearer JWT)
   │       ├─ 校验 JWT（requireAdmin）→ req.admin.sub = 数字 merchantId
   │       ├─ 按 AI 积分计量（base/gift/paid → 消耗 base→gift→paid）
   │       └─ proxyChat() → DeepSeek（system / response_format / temperature 透传）
   │  ③' POST /api/pay/membership/ai-vision  (Bearer JWT)   ← v151 照片识别
   │       ├─ 同上校验 JWT；入参 images:[{id,src}]（URL 或 dataURL）
   │       ├─ 每张成功识别扣 1 AI 积分（预检余额）
   │       └─ analyzeImages() → 视觉模型（OpenAI 兼容 /v1/chat/completions）
   ▼
DeepSeek API（文案） / 视觉模型（照片识别）
```

**解决的问题**：之前每次部署新沙盒后，测试用的 DeepSeek Key 存于前端 `localStorage`（按 origin 隔离、换沙盒即清空），需反复重填。
改为 Key 只存于总平台服务端，俱乐部侧只需配置「后端地址 + 口令 + 商家ID」，彻底消除「钥匙易丢」。

**回退兜底**：若前端未配置后端地址，`aiAuthMode()` 返回 `'key'`，`clubLLM()` 回退到浏览器直连（演示 Key 存本机浏览器），保证无后端也能演示。

---

## 2. 运行环境要求

| 依赖 | 版本/说明 |
|------|-----------|
| Node.js | ≥ 18（类型用 `tsc` 校验，运行用 `dist/`） |
| PostgreSQL | ≥ 13，需可写连接串；首次部署用 Prisma 建表 |
| DeepSeek Key | 填 `PLATFORM_LLM_KEY`，平台统一持有 |
| 网络 | 后端需能出网访问 `api.deepseek.com` |

---

## 3. 环境变量清单

复制 `.env.example` 为 `.env`，按环境填写：

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `DATABASE_URL` | ✅ | — | PostgreSQL 连接串，如 `postgresql://user:pwd@host:5432/clubos?schema=public` |
| `PORT` | ❌ | `3000` | 服务监听端口 |
| `JWT_SECRET` | ✅ | `change-me` | JWT 签发/校验密钥，**生产必须改成随机长串** |
| `ADMIN_CODE` | ✅ | `clubos-admin` | 管理员登录口令（demo 用明文；生产应改 OAuth / 密码哈希） |
| `KEY_VAULT_SECRET` | ✅ | `change-me-32bytes-key-vault-sec` | 加密存储 LLM Key 的密钥，**必须正好 32 字节** |
| `PLATFORM_LLM_KEY` | ✅（AI 代理用） | `""` | 平台统一 DeepSeek Key；留空则 `/ai-proxy` 不可用 |
| `PLATFORM_VISION_KEY` | ❌（照片识别用） | `""` | 视觉模型 Key；**留空时回退 `PLATFORM_LLM_KEY`**（需该 Key 支持视觉） |
| `PLATFORM_VISION_MODEL` | ❌ | `gpt-4o-mini` | 视觉模型名，如 `qwen-vl-max` / `glm-4v-flash` / `gemini-2.0-flash` |
| `PLATFORM_VISION_BASE` | ❌ | `https://api.openai.com/v1` | 视觉模型 Base URL（OpenAI 兼容端点） |
| `DEFAULT_COMMISSION_RATE` | ❌ | `0.05` | 免费版默认抽成（0~1）；会员版按 `merchants.commission_rate` 覆盖为 0 |
| `ORDER_EXPIRE_MINUTES` | ❌ | `30` | 未支付订单自动关闭（分钟） |
| `WECHAT_MCH_ID` 等 | ❌ | `""` | 微信支付服务商参数；**留空即走桩实现，不发起真实请求** |

> 微信支付相关 7 项（`WECHAT_MCH_ID`/`WECHAT_APPID`/`WECHAT_API_V3_KEY`/`WECHAT_SERIAL_NO`/`WECHAT_PRIVATE_KEY_PATH`/`WECHAT_PLATFORM_CERT_PATH`/`WECHAT_NOTIFY_URL`）
> 全部为空时 `config.wechat.enabled === false`，后端自动降级为桩，不影响 AI 代理与会员引擎。

---

## 4. 部署步骤

```bash
# 1. 安装依赖
npm install

# 2. 生成 Prisma Client
npx prisma generate

# 3. 首次建表（已有库可跳过；会按 schema 创建 9 张表）
npx prisma db push          # 或 prisma migrate deploy（若用 migration）

# 4. 类型检查（CI / 提交前必跑）
./node_modules/.bin/tsc -p tsconfig.json --noEmit     # 期望 EXIT 0

# 5. 构建
npm run build                # 输出到 dist/

# 6. 运行
npm start                    # 或 node dist/index.js
```

健康检查：`GET /api/pay/health`（如未提供，可用 `GET /` 或登录接口探测）。

---

## 5. 前端（俱乐部后台）配置步骤

在俱乐部后台「设置 → AI 设置」（或「AI 高级设置」）填写：

| 字段 | localStorage 键 | 说明 |
|------|----------------|------|
| 总平台后端地址 | `clubos_backend_url` | 形如 `https://<backend-host>`（自动去掉结尾 `/`） |
| 管理员口令 | `clubos_backend_admin_code` | 对应后端 `ADMIN_CODE` |
| 商家ID | `clubos_backend_merchant_id` | **数字字符串**（默认 `"1"`），须与后端 `merchants` 表记录 id 对应 |
| 本地演示 Key | `clubos_ai_key` | **仅未接后端时生效**；接入后端后此 Key 不再使用 |

填完点「测试后端连接」：前端会清掉旧 JWT → `ensureBackendToken()` 重新登录 → 用一句示例 prompt 调 `/ai-proxy`，
按返回给出「连接成功 / 未鉴权 / 后端不可达(已回退演示直连)」提示。

> ⚠️ **商家ID 类型陷阱**：后端 `merchants.id` 是 BigInt 数字，而前端 demo 默认 `"club_demo"` 之类字符串会不匹配。
> 联调时务必在后端 `merchants` 表存在一条对应数字 id 的记录，并在前端「商家ID」填该数字。

---

## 6. AI 代理契约（前后端对齐）

**请求** `POST /api/pay/membership/ai-proxy`
`Authorization: Bearer <JWT>`
```json
{
  "prompt": "用户提示（必填）",
  "system": "系统提示词（可选，文案生成/JSON 解析场景需要）",
  "model": "deepseek-chat（可选，前端传非 deepseek 会被强制改回 deepseek-chat）",
  "temperature": 0.7,
  "response_format": { "type": "json_object" }   // 可选，JSON 模式
}
```

**响应**
```json
{ "code": 0, "data": { "content": "<模型返回文本>" } }
```

**实现要点（与前端 `clubLLMviaBackend` 对齐）**
- 模型强制 `deepseek-chat`（平台 Key 即 DeepSeek，避免把 qwen 误传 deepseek 接口）；
- 有 `system` 则组装到 `messages[0]`（role=system），再追加 user，与前端直连契约一致；
- 仅当 `response_format.type` 存在时附加 JSON 模式，避免无谓报错；
- 401 → 前端清 JWT 重登一次；网络异常/无 token → 前端收到哨兵 `"__fallback__"` 回退直连。

---

## 7. AI 积分模型（与后端一致）

对外称「AI 积分」，三类额度：

| 类型 | 来源 | 清零规则 | 消耗顺序 |
|------|------|----------|----------|
| `base` | 每月赠送 1000 | 月清 | 1（先用） |
| `gift` | 销量里程碑赠 | 月清 | 2 |
| `paid` | 充值 | **不清零** | 3（最后用） |

前端 `aiBalance()` / `AI_COST_PER_CALL` 按上述模型本地计量展示；后端 `proxyChat(merchantId, …)` 按 `req.admin.sub`（数字 merchantId）真实扣减，
实现「按俱乐部归因 + 阶梯 + 账本（pending→frozen→available→settled / reversed）」。

---

## 8. 联调检查清单

- [ ] 后端 `tsc --noEmit` 通过、能 `npm start` 起来
- [ ] `PLATFORM_LLM_KEY` 已填且能出网访问 DeepSeek
- [ ] 前端填后端地址 + 口令 + 商家ID（数字 id 与后端记录一致）
- [ ] 「测试后端连接」返回「连接成功」并能拿到文案
- [ ] 断网/后端 404 时，前端自动回退演示直连（若有本地 Key）不报错
- [ ] 7 处 AI 调用点（ai.js×4、publish.js×2、activities.js×2）均走 `clubLLM()`，无 `getAIKey()` 直连残留
- [ ] 前端 `node --check` 对 core/ai/publish/activities/shell 全 OK

---

## 9. 已知约束与回退

- **本次（v114）只落地代码 + 类型校验，未部署后端**：等待用户提供后端 URL 与 `PLATFORM_LLM_KEY` 后再联调。
- **未部署前的前端行为**：因没有后端地址，`aiAuthMode()` 回退 `'key'`，沿用本地演示 Key（需手填，换沙盒仍会丢——这是预期内的演示态）。
- **若后端长期不部署**：可回退到「纯前端 Key 固化」方案（把演示 Key 写进代码/配置而非 localStorage），作为用户此前认可的兜底。
- **密钥安全**：`PLATFORM_LLM_KEY` 只存在于服务端环境变量；`KEY_VAULT_SECRET` 用于加密存储商家自备 Key，切勿提交到仓库（已 `.gitignore`）。

---

## 10. 容器 / 平台一键部署（推荐）

后端是 Express+Prisma+Postgres 服务，**不能跑在 CloudStudio 静态沙盒**，需独立容器/服务器。仓库已内置三种开箱即用物料：

| 物料 | 适用场景 |
|------|----------|
| `Dockerfile` | 任意容器平台（Render / Railway / Fly.io / 自建 K8s） |
| `docker-compose.yml` | 本地或自托管一键起（自带 Postgres 服务） |
| `render.yaml` | Render Blueprint，连仓库即自动建 Postgres + Web 服务 |
| `.dockerignore` | 构建时排除 node_modules/.env 等 |

**本地 / 自托管（docker compose）**
```bash
cd clubos-backend
cp .env.example .env          # 填 DATABASE_URL / PLATFORM_LLM_KEY / JWT_SECRET / KEY_VAULT_SECRET / ADMIN_CODE
docker compose up -d --build  # 自动建表(prisma db push) + 启动，监听 3000
curl http://localhost:3000/health   # 期望 {"status":"ok",...}
```

**Render（最简，零 Docker 命令）**
1. Render 控制台 → New → Blueprint → 关联本仓库（识别 `render.yaml`）；
2. 手动填 `sync:false` 变量：`PLATFORM_LLM_KEY` / `JWT_SECRET`(随机长串) / `KEY_VAULT_SECRET`(正好 32 字节) / `ADMIN_CODE`；
3. 部署完成后，`DATABASE_URL` 由 Postgres 插件自动注入；服务地址即前端要填的「总平台后端地址」。

> ⚠️ 无论哪种方式，`/api/pay/membership/ai-proxy` 需要 `ADMIN_CODE` 换 JWT，且 `PLATFORM_LLM_KEY` 必须有值，否则「测试后端连接」会返回未鉴权 / 代理失败。
> ⚠️ `KEY_VAULT_SECRET` 必须**正好 32 字节**，否则 vault 加解密会报错。
> ⚠️ 首次启动已由 `prisma/seed.ts` **幂等创建默认俱乐部 `id=1`（free/active）**，故前端「商家ID」直接填 `1` 即可登录并调 `/ai-proxy`；如需多商家自行往 `merchants` 表插记录（status 须 `active`）。
