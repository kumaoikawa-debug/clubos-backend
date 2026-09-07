import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// 首次启动保证存在一个默认俱乐部（id=1, free, active），
// 否则前端「商家ID=1」登录会因 merchants 表无记录而 404。
// 幂等：已存在则跳过。
async function main() {
  const id = 1n;
  const existing = await prisma.merchant.findUnique({ where: { id } });
  if (!existing) {
    await prisma.merchant.create({
      data: { id, name: 'Demo Club', plan: 'free', status: 'active' },
    });
    console.log('[seed] 已创建默认俱乐部 id=1 (free/active)');
  } else {
    console.log(`[seed] 俱乐部已存在 id=${existing.id} plan=${existing.plan} status=${existing.status}`);
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error('[seed] 失败', e);
    await prisma.$disconnect();
    process.exit(1);
  });
