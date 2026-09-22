import 'dotenv/config';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import routes from './routes';
import contentRouter from './routes/content';
import contentVnextRouter from './routes/contentVnext';
import { cors } from './middleware';
import { config } from './config';
import { prisma, logger, fail } from './lib';
import { startScheduler } from './scheduler';

const app = express();

// CORS 必须最先挂：前端在 GitHub Pages、后端在 Render，属跨域；缺这两个头浏览器会直接抛错
app.use(cors);

// 微信回调会带原始 body，验签需要原始字节；用 verify 把 rawBody 暂存到 req 上
// 限制放宽到 5mb：前端已不再发送 dataURL 照片（本地渲染兜底），正常请求远小于此；
// 仍超限时由下方全局处理器返回 413 诊断，而不是被吞成「服务器内部错误」。
app.use(
  express.json({
    limit: '5mb',
    verify: (req, _res, buf) => {
      (req as Request & { rawBody?: Buffer }).rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: true }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', wechatEnabled: config.wechat.enabled });
});

// 业务路由统一挂在 /api/pay 下
app.use('/api/pay', routes);

// Content Engine V3：活动详情页 / 宣发 / 回顾的内容生成（自带 requireAdmin 鉴权）
app.use('/api/content', contentRouter);

// [Clean Rewrite] ai-content-vnext：活动详情 AI Promo Canvas 新引擎（自带 requireAdmin 鉴权）
app.use('/api/content-vnext', contentVnextRouter);

// 404
app.use((_req, res) => {
  res.status(404).json(fail('接口不存在', 404));
});

// 统一错误处理
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error('[unhandled]', err);
  // 请求体超限：给出可诊断信息，而不是被吞成「服务器内部错误」（曾导致宣发渠道直接报内部错误）
  const e = err as Error & { type?: string; status?: number; length?: number; limit?: number };
  if (e.type === 'entity.too.large' || e.status === 413) {
    res.status(413).json(
      fail('请求体过大（超过 5MB）。请不要在资料里附带超大图片，照片会自动用本地原图渲染；如仍报错，请减少单次上传文件数量。')
    );
    return;
  }
  res.status(500).json(fail('服务器内部错误'));
});

async function main() {
  if (!config.databaseUrl) {
    logger.warn('未配置 DATABASE_URL，Prisma 将无法连接数据库（骨架可启动但接口会报错）');
  }

  app.listen(config.port, () => {
    logger.info(`ClubOS 支付分账服务已启动 http://localhost:${config.port}`);
    logger.info(`微信支付：${config.wechat.enabled ? '已配置（真实接口）' : '未配置 → 走桩实现'}`);
    startScheduler();
  });
}

process.on('SIGTERM', async () => {
  await prisma.$disconnect();
  process.exit(0);
});

main().catch((err) => {
  logger.error('启动失败', err);
  process.exit(1);
});
