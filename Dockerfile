# ClubOS 总平台后端 · 镜像构建
FROM node:20-alpine

WORKDIR /app

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
