import { Router } from 'express';
import { z } from 'zod';
import { ok, fail, logger, zodMessage, prisma } from '../lib';
import { subscribe, getStatus, getInsights, type Cycle } from '../services/membershipService';
import { proxyChat } from '../services/aiProxyService';
import { encryptSecret } from '../services/vault';

const router = Router();

/** POST /api/pay/membership/subscribe · 开通 / 续费会员 */
router.post('/subscribe', async (req, res) => {
  const parsed = z.object({ cycle: z.enum(['monthly', 'yearly']) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(fail(`参数校验失败：${zodMessage(parsed.error)}`));
    return;
  }
  try {
    const sub = await subscribe(req.admin!.sub, parsed.data.cycle as Cycle);
    res.json(ok({ subscription: sub }));
  } catch (err) {
    res.status(400).json(fail(err instanceof Error ? err.message : String(err)));
  }
});

/** GET /api/pay/membership/status · 会员状态 + 积分 */
router.get('/status', async (req, res) => {
  try {
    res.json(ok(await getStatus(req.admin!.sub)));
  } catch (err) {
    res.status(500).json(fail(err instanceof Error ? err.message : String(err)));
  }
});

/** GET /api/pay/membership/insights · 复购推荐 + 流失提醒 */
router.get('/insights', async (req, res) => {
  try {
    res.json(ok(await getInsights(req.admin!.sub)));
  } catch (err) {
    res.status(500).json(fail(err instanceof Error ? err.message : String(err)));
  }
});

/** POST /api/pay/membership/ai-proxy · AI 代理（会员版用平台 Key，免费版用自备 Key）
 *  入参：prompt(必填) + 可选 system / model / temperature / response_format（JSON 模式）。
 *  前端多场景（文案生成 + 结构化解析）统一走此代理，Key 由平台在服务端持有，按 AI 积分计量。 */
router.post('/ai-proxy', async (req, res) => {
  const parsed = z
    .object({
      prompt: z.string().min(1),
      system: z.string().optional(),
      model: z.string().optional(),
      temperature: z.number().optional(),
      response_format: z.object({ type: z.string() }).optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(fail(`参数校验失败：${zodMessage(parsed.error)}`));
    return;
  }
  try {
    const result = await proxyChat(req.admin!.sub, parsed.data.prompt, {
      model: parsed.data.model,
      system: parsed.data.system,
      temperature: parsed.data.temperature,
      response_format: parsed.data.response_format,
    });
    res.json(ok(result));
  } catch (err) {
    logger.error('[ai-proxy] 失败', err);
    res.status(400).json(fail(err instanceof Error ? err.message : String(err)));
  }
});

/** POST /api/pay/membership/keys · 免费版配置自备 LLM Key（加密存储） */
router.post('/keys', async (req, res) => {
  const parsed = z
    .object({
      channel: z.enum(['deepseek', 'openai']).default('deepseek'),
      secret: z.string().min(1),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(fail(`参数校验失败：${zodMessage(parsed.error)}`));
    return;
  }
  try {
    const enc = encryptSecret(parsed.data.secret);
    const vault = await prisma.apiKeyVault.upsert({
      where: { merchantId_channel: { merchantId: BigInt(req.admin!.sub), channel: parsed.data.channel } },
      create: { merchantId: BigInt(req.admin!.sub), channel: parsed.data.channel, secretEnc: enc },
      update: { secretEnc: enc },
    });
    res.json(ok({ id: vault.id.toString(), channel: vault.channel }));
  } catch (err) {
    res.status(400).json(fail(err instanceof Error ? err.message : String(err)));
  }
});

export default router;
