export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL ?? '',
  jwtSecret: process.env.JWT_SECRET ?? 'change-me',

  /** 管理端登录口令（demo 用，生产应改为 OAuth / 密码哈希） */
  adminCode: process.env.ADMIN_CODE ?? 'clubos-admin',

  /** 密钥保管加密密钥（用于加密存储平台 / 会员 LLM Key），必须 32 字节 */
  keyVaultSecret: process.env.KEY_VAULT_SECRET ?? 'change-me-32bytes-key-vault-sec',

  /** 会员版「AI 全包」使用的平台 LLM Key（DeepSeek 等） */
  platformLlmKey: process.env.PLATFORM_LLM_KEY ?? '',

  /** 视觉模型（照片识别）：未单独配置 PLATFORM_VISION_KEY 时回退平台 LLM Key（需该 Key 支持视觉） */
  platformVisionKey: process.env.PLATFORM_VISION_KEY ?? '',
  platformVisionModel: process.env.PLATFORM_VISION_MODEL ?? 'gpt-4o-mini',
  platformVisionBase: process.env.PLATFORM_VISION_BASE ?? 'https://api.openai.com/v1',

  /** 免费版默认抽成比例（0~1），会员版按 merchants.commission_rate 覆盖 */
  defaultCommissionRate: Number(process.env.DEFAULT_COMMISSION_RATE ?? 0.05),
  /** 未支付订单自动关闭时间（分钟） */
  orderExpireMinutes: Number(process.env.ORDER_EXPIRE_MINUTES ?? 30),

  wechat: {
    mchId: process.env.WECHAT_MCH_ID ?? '',
    appId: process.env.WECHAT_APPID ?? '',
    apiV3Key: process.env.WECHAT_API_V3_KEY ?? '',
    serialNo: process.env.WECHAT_SERIAL_NO ?? '',
    privateKeyPath: process.env.WECHAT_PRIVATE_KEY_PATH ?? '',
    platformCertPath: process.env.WECHAT_PLATFORM_CERT_PATH ?? '',
    notifyUrl: process.env.WECHAT_NOTIFY_URL ?? '',
    /** 任一关键配置为空 → wechatPay 走桩实现，不发起真实请求 */
    get enabled(): boolean {
      return Boolean(this.mchId && this.appId && this.apiV3Key && this.serialNo);
    },
  },
};

export type AppConfig = typeof config;
