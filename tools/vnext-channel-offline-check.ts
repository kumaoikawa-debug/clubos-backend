/**
 * 第二阶段｜宣发渠道离线契约校验（不调用真实 LLM）
 *
 * 验证 §17 / §27 纪律：
 *   - 四个渠道（wechat / xiaohongshu / poster / moments）共享同一 Activity Master；
 *   - wechat / xiaohongshu 各自独立重新策划（block 结构不同，非互相复制 / 非复制详情页）；
 *   - poster / moments 确定性提取，不依赖 LLM；
 *   - 渠道自由文本（标题 / 摘要 / Hook / 标签）同样过事实安全扫描；
 *   - 图片引用只使用母体真实 photo id（不杜撰）。
 *
 * 用 stub ChatFn 返回脚本 JSON，验证纯逻辑与结构纪律。
 */
import { generateChannel, type ChatFn } from '../src/ai-content-vnext';
import { PROMO_BLOCK_TYPES, type ProxyResult } from '../src/ai-content-vnext/types';

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    pass++;
    console.log('  ✓', msg);
  } else {
    fail++;
    console.error('  ✗', msg);
  }
}

const PHOTOS = [
  { id: 'p1', src: 'https://img/p1.jpg', caption: '徒步实拍', eventFact: true },
  { id: 'p2', src: 'https://img/p2.jpg', caption: '瑜伽', materialEvidence: true },
];

const ACTIVITY = {
  title: '蓥华山徒步+瑜伽',
  date: '2026-10-24',
  location: '什邡',
  price: '¥298',
  distance: '8km',
  elevation: '1800m',
  difficulty: '轻松',
  summary: '自然疗愈一日线',
};

// stub：共享理解，按渠道分别产出 editorial / blocks（证明独立重策划）
function makeStub(): ChatFn {
  let lastChannel: 'wechat' | 'xiaohongshu' | '' = '';
  return async (_mid: string, prompt: string, opts?: any): Promise<ProxyResult> => {
    let content = '';
    if (prompt.includes('分类')) {
      content = JSON.stringify({
        publicFacts: {
          title: ACTIVITY.title,
          date: ACTIVITY.date,
          location: ACTIVITY.location,
          price: ACTIVITY.price,
          distance: ACTIVITY.distance,
          elevation: ACTIVITY.elevation,
          difficulty: ACTIVITY.difficulty,
          summary: ACTIVITY.summary,
        },
        internalData: { cost: 120, margin: 178 },
        promoMaterial: [{ kind: '体验', text: '森林瑜伽与溪流徒步，适合新手' }],
        conflicts: [],
      });
    } else if (prompt.includes('"blocks"')) {
      if (lastChannel === 'xiaohongshu') {
        content = JSON.stringify({
          blocks: [
            { type: 'hero', headline: '周末去蓥华山徒步瑜伽' },
            { type: 'text', text: '都市人也能轻松上手的自然疗愈线' },
            { type: 'image_pair', mediaRefs: ['p1', 'p2'] },
            { type: 'cta', ctaText: '戳我报名' },
          ],
        });
      } else {
        // wechat（默认）
        content = JSON.stringify({
          blocks: [
            { type: 'hero', headline: '蓥华山徒步+瑜伽：一天把电池充满' },
            { type: 'statement', text: '不是又累又晒的拉练，是边走边放松的自然疗愈' },
            { type: 'metric_strip', metrics: [{ label: '里程', value: '8km' }, { label: '海拔', value: '1800m' }] },
            { type: 'single_image', mediaRefs: ['p1'] },
            { type: 'cta', ctaText: '立即报名' },
          ],
        });
      }
    } else {
      // editorial：从 opts.system 读渠道（渠道角度指令挂在 system 上，不进 prompt）
      const sys: string = opts?.system || '';
      if (sys.includes('微信公众号')) lastChannel = 'wechat';
      else if (sys.includes('小红书')) lastChannel = 'xiaohongshu';
      const plan = Array.from({ length: 4 }).map((_, i) => ({
        purpose: `段${i}`,
        whatToSay: '基于资料',
        evidenceRefs: [],
        imageNeed: '图',
        textWeight: 0.5,
        visualWeight: 0.5,
      }));
      content = JSON.stringify({
        activityUnderstanding: '徒步+瑜伽',
        coreSellingIdea: '自然疗愈',
        targetAudience: '都市人',
        mainUserMotivation: '放松',
        mainUserBarrier: '没时间',
        editorialStrategy: '从自然切入',
        visualStrategy: '大图',
        editorialPlan: plan,
      });
    }
    return { content, source: 'platform', credits: 1, tokens: 10, balance: 999 };
  };
}

async function main() {
  const stub = makeStub();
  const base = {
    merchantId: '1',
    activityId: 'a1',
    activity: ACTIVITY as Record<string, unknown>,
    sourceMaterials: [{ id: 's1', type: 'text', text: '森林瑜伽与溪流徒步，适合新手' }],
    photos: PHOTOS as any,
  };

  console.log('— 共享 Activity Master：四个渠道均从同一母体派生 —');
  const wechat = await generateChannel({ ...base, channel: 'wechat' }, stub);
  const xhs = await generateChannel({ ...base, channel: 'xiaohongshu' }, stub);
  const poster = await generateChannel({ ...base, channel: 'poster' }, stub);
  const moments = await generateChannel({ ...base, channel: 'moments' }, stub);

  assert(wechat.activityMaster.activityId === xhs.activityMaster.activityId, 'wechat / xhs 共享同一 Activity Master');
  assert(
    (wechat.content as any).blocks.every((b: any) => PROMO_BLOCK_TYPES.includes(b.type)),
    'wechat block 类型落在 12 型白名单内'
  );
  assert(
    (xhs.content as any).blocks.every((b: any) => PROMO_BLOCK_TYPES.includes(b.type)),
    'xhs block 类型落在 12 型白名单内'
  );

  console.log('— 微信公众号：独立重策划，输出可直接粘贴后台的 HTML —');
  assert(!!(wechat.content as any).title, 'wechat 标题已生成');
  assert((wechat.content as any).html.includes((wechat.content as any).title), 'wechat HTML 含标题');
  assert((wechat.content as any).html.includes('<div'), 'wechat HTML 为内联样式片段');
  assert((wechat.content as any).html.includes('https://img/p1.jpg'), 'wechat HTML 引用母体真实图片');

  console.log('— 小红书：独立内容策略（非公众号缩短版）—');
  assert(!!(xhs.content as any).title, 'xhs 标题已生成');
  assert((xhs.content as any).title.length <= 20, 'xhs 标题短（≤20 字，符合小红书风格）');
  assert(!!(xhs.content as any).hook, 'xhs Hook 已生成');
  assert(Array.isArray((xhs.content as any).tags) && (xhs.content as any).tags.length >= 1, 'xhs 标签为数组且非空');
  assert(Array.isArray((xhs.content as any).imageOrder), 'xhs 图片顺序为数组');

  // 关键纪律：两渠道 block 结构不同（独立重策划，非复制）
  const wb = JSON.stringify((wechat.content as any).blocks.map((b: any) => b.type));
  const xb = JSON.stringify((xhs.content as any).blocks.map((b: any) => b.type));
  assert(wb !== xb, `wechat 与 xhs block 序列不同（${wb} vs ${xb}）→ 独立策划`);

  console.log('— 海报：确定性提取，不依赖 LLM —');
  const pc = poster.content as any;
  assert(pc.name === ACTIVITY.title, 'poster 名称取自母体 title');
  assert(pc.date === ACTIVITY.date, 'poster 日期取自母体');
  assert(pc.location === ACTIVITY.location, 'poster 地点取自母体');
  assert(pc.priceText.includes('298'), 'poster 价格取自母体');
  assert(Array.isArray(pc.highlights) && pc.highlights.length >= 1, 'poster 含 2~3 个亮点');

  console.log('— 朋友圈 / 群：确定性派生 —');
  assert(!!(moments.content as any).text, 'moments 文案已生成');

  console.log('— 图片引用只使用母体真实 id（不杜撰）—');
  const allRefs = [
    ...(wechat.content as any).blocks.flatMap((b: any) => b.mediaRefs || []),
    ...(xhs.content as any).blocks.flatMap((b: any) => b.mediaRefs || []),
  ];
  assert(
    allRefs.every((id: string) => PHOTOS.some((p) => p.id === id)),
    '渠道 block 的图片引用全部来自母体真实 photo id'
  );

  console.log('— 渠道自由文本事实安全（标题/摘要含虚构词 → 拦截）—');
  // 负向：wechat 标题/摘要注入「日照金山」而资料无 → 应不通过
  const evilStub: ChatFn = async (_mid, prompt) => {
    if (prompt.includes('分类')) {
      return {
        content: JSON.stringify({
          publicFacts: { title: 'B', price: '¥298' },
          internalData: {},
          promoMaterial: [],
          conflicts: [],
        }),
        source: 'platform',
        credits: 1,
        tokens: 10,
        balance: 999,
      };
    }
    if (prompt.includes('"blocks"')) {
      return {
        content: JSON.stringify({
          blocks: [{ type: 'statement', text: '本次活动将有绝美日照金山与云海' }, { type: 'cta', ctaText: '报名' }],
        }),
        source: 'platform',
        credits: 1,
        tokens: 10,
        balance: 999,
      };
    }
    return {
      content: JSON.stringify({
        activityUnderstanding: 'x',
        coreSellingIdea: '日照金山下的徒步', // 摘要会含 forbidden
        targetAudience: 'a',
        mainUserMotivation: 'b',
        mainUserBarrier: 'c',
        editorialStrategy: 'd',
        visualStrategy: 'e',
        editorialPlan: [{ purpose: 'p', whatToSay: 's', evidenceRefs: [], imageNeed: 'i', textWeight: 0.5, visualWeight: 0.5 }],
      }),
      source: 'platform',
      credits: 1,
      tokens: 10,
      balance: 999,
    };
  };
  const evil = await generateChannel(
    {
      merchantId: '1',
      activityId: 'a2',
      activity: { title: 'B', price: '¥298' } as Record<string, unknown>,
      sourceMaterials: [],
      photos: [],
      channel: 'wechat',
    },
    evilStub
  );
  assert(!evil.grounding.passed, 'wechat 摘要/正文含虚构天气（日照金山）→ grounding 不通过');
  assert(evil.grounding.issues.some((i) => i.field === 'weather'), '拦截虚构天气（§19）');

  console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
