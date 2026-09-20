import { Router } from 'express';
import { z } from 'zod';
import { ok, fail, logger, zodMessage } from '../lib';
import { prisma } from '../lib';
import { config } from '../config';
import { signToken } from '../auth/jwt';

const router = Router();

const loginSchema = z.object({
  merchant_id: z.union([z.string(), z.number()]).transform((v) => String(v)),
  code: z.string().min(1),
});

/**
 * POST /api/pay/admin/login · 管理端登录，换取 JWT
 * demo 用统一口令 ADMIN_CODE；生产应替换为 OAuth / 密码哈希。
 *
 * ★路径说明：本路由挂在 `/api/pay` 下，规范路径是 `/api/pay/admin/login`
 *   （README / DEPLOY.md / 前端 core.js#ensureBackendToken / 本地联调 harness 均按此写）。
 *   此前只注册了 `/login`，导致前端一律 401 → 拿不到 JWT → 所有 AI 调用静默回退直连。
 *   现同时注册 `/admin/login`（规范）与 `/login`（历史别名），两者行为一致。
 */
router.post(['/admin/login', '/login'], async (req, res) => {
  // 兼容前端两种字段名：规范为 code，旧版曾发 adminCode（v139 前端已统一为 code）
  const body = { ...req.body };
  if (!body.code && body.adminCode) body.code = body.adminCode;
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    res.status(400).json(fail(`参数校验失败：${zodMessage(parsed.error)}`));
    return;
  }

  const { merchant_id, code } = parsed.data;
  if (code !== config.adminCode) {
    res.status(401).json(fail('登录口令错误'));
    return;
  }

  const merchant = await prisma.merchant.findUnique({
    where: { id: BigInt(merchant_id) },
    select: { id: true, name: true, plan: true, status: true },
  });
  if (!merchant) {
    res.status(404).json(fail('俱乐部不存在'));
    return;
  }
  if (merchant.status !== 'active') {
    res.status(403).json(fail('该俱乐部已暂停服务'));
    return;
  }

  const token = signToken({ sub: merchant.id.toString(), role: 'merchant', plan: merchant.plan });
  logger.info(`[admin] 登录成功 merchant=${merchant.id}`);
  res.json(ok({ token, merchant: { id: merchant.id.toString(), name: merchant.name, plan: merchant.plan } }));
});

export default router;
