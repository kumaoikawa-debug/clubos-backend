import { retryFailedSplits } from './services/splitService';
import { closeExpiredOrders } from './services/orderService';
import { dailyReconcile } from './services/settleService';
import { logger } from './lib';

/**
 * 定时任务调度
 *  - 分账重试：每 1 分钟（失败台账指数退避在 splitService 内控制）
 *  - 关闭超时未支付订单：每 5 分钟
 *  - 日终对账：北京时间 02:00 跑「昨日」三向对账
 */

let timers: ReturnType<typeof setInterval>[] = [];
let lastReconcileKey = '';

function maybeDailyReconcile(): void {
  const now = new Date();
  // 换算北京时间小时（UTC+8）
  const bjHour = (now.getUTCHours() + 8) % 24;
  if (bjHour !== 2) return;

  const yest = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const key = yest.toISOString().slice(0, 10);
  if (lastReconcileKey === key) return; // 当天只跑一次
  lastReconcileKey = key;

  dailyReconcile(key).catch((err) => logger.error('[scheduler] 日终对账失败', err));
}

export function startScheduler(): void {
  if (timers.length) return; // 避免重复启动
  timers.push(
    setInterval(() => {
      retryFailedSplits().catch((e) => logger.error('[scheduler] 分账重试失败', e));
    }, 60 * 1000)
  );
  timers.push(
    setInterval(() => {
      closeExpiredOrders().catch((e) => logger.error('[scheduler] 关闭超时订单失败', e));
    }, 5 * 60 * 1000)
  );
  timers.push(setInterval(maybeDailyReconcile, 60 * 60 * 1000));
  logger.info('[scheduler] 定时任务已启动（分账重试 1m / 关单 5m / 对账每日 02:00 北京）');
}

export function stopScheduler(): void {
  timers.forEach(clearInterval);
  timers = [];
}
