# ClubOS 总平台后端 · 镜像构建
# node:22-slim（Debian）——两处硬约束：
#  1) @mastra/core@1.67.0 engines 要求 node>=22.13.0（node:20 下 npm 报 EBADENGINE 且运行期不可靠）
#  2) Prisma 需 openssl CLI 才能探测 libssl 版本；Alpine 无 openssl 会退回 openssl-1.1.x 引擎，
#     引擎加载失败并把错误文本写进 stdout → "Could not parse schema engine response: Unexpected token 'E'"
FROM node:22-slim

WORKDIR /app

# openssl：Prisma 版本探测必需；ca-certificates：引擎下载 / https 校验
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# 依赖（含 dev，因构建需要 prisma CLI / typescript）
# 注意 --include=dev：Render 会注入 NODE_ENV=production，裸 npm ci 会跳过 devDeps 导致 tsc/prisma 缺失、构建失败
COPY package.json package-lock.json ./
RUN npm ci --include=dev

# Prisma Client 生成 + 源码构建
COPY prisma ./prisma
COPY tsconfig.json ./
COPY src ./src
RUN npx prisma generate
RUN npm run build

EXPOSE 3000

# 首次启动按 DATABASE_URL 建表（db push）→ 保证默认俱乐部 id=1 存在（seed）→ 启动服务
# 注意：DATABASE_URL / PLATFORM_LLM_KEY / JWT_SECRET / KEY_VAULT_SECRET / ADMIN_CODE 须通过环境变量注入
CMD ["sh", "-c", "npx prisma db push --skip-generate && npm run seed && node dist/index.js"]
