import { Router } from 'express';
import { requireAdmin } from '../middleware';
import ordersRouter from './orders';
import notifyRouter from './notify';
import splitRouter from './split';
import refundRouter from './refund';
import settleRouter from './settle';
import adminRouter from './admin';
import membershipRouter from './membership';
import mallRouter from './mall';
import aiCreditRouter from './aiCredit';
import analyticsRouter from './analytics';

const router = Router();

// 微信回调不需要管理端鉴权，靠验签中间件保护
router.use(notifyRouter);

// 登录接口公开
router.use(adminRouter);

// 其余接口挂管理端鉴权（JWT）
router.use(requireAdmin);
router.use(ordersRouter);
router.use(splitRouter);
router.use(refundRouter);
router.use(settleRouter);
router.use('/membership', membershipRouter);
router.use('/mall', mallRouter);
router.use('/ai-credit', aiCreditRouter);
router.use('/analytics', analyticsRouter);

export default router;
