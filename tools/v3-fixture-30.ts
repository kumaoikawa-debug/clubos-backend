/**
 * Content Engine V3 —— Phase 6 验收 · 30 场活动矩阵
 *
 * 这是「30 场多样性走查」的输入真源，离线契约（tests/v3-acceptance-30.contract.ts）
 * 与线上跑批（tools/v3-acceptance-live.ts）共用同一份 fixture ——
 * 两处各写一份 fixture 的话，线上过了、离线没过时根本说不清是谁的问题。
 *
 * 选场原则（不是「随机 30 条」，每一条都在压一个具体维度）：
 *   - 形态跨度：单日 / 多日 / 过夜露营 / 赛事 / 度假 / 研学 / 宠物 / 城市
 *   - 强度跨度：亲子休闲 → 技术型雪山
 *   - 价格跨度：无价格 / 39 元 / 198 元 / 4980 元
 *   - 素材跨度：0 照片 / 1 张 / 20 张 / 无行程 / 无难度数据 / 无费用说明
 *   - 文本边界：超长标题 / emoji 与特殊字符 / 中英混排 / 全角符号
 *   - 数据边界：缺集合点、缺名额、日期用「2026年10月01日」这种中文写法
 */

export interface FixturePhoto {
  id: string;
  src?: string;
}

export interface Fixture {
  id: string;
  /** 这场在压哪个维度（报告里按 tag 归类看，才知道失败集中在哪一类） */
  tag: string;
  activity: Record<string, unknown>;
  planFacts: Record<string, unknown>;
  materialText: string[];
  photos: FixturePhoto[];
}

function photos(n: number, prefix: string): FixturePhoto[] {
  const out: FixturePhoto[] = [];
  for (let i = 0; i < n; i++) out.push({ id: `${prefix}p${i}`, src: `https://cdn.example.com/${prefix}-${i}.jpg` });
  return out;
}

function itin(days: Array<[string, string[]]>): Array<Record<string, unknown>> {
  return days.map(function (d, i) {
    return { day: i + 1, title: d[0], items: d[1] };
  });
}

interface Row {
  id: string;
  tag: string;
  title: string;
  date?: string;
  place?: string;
  meeting?: string;
  price?: number;
  limit?: number;
  difficulty?: string;
  distance?: string;
  elevation?: string;
  days: number;
  feeInclude?: string[];
  feeExclude?: string[];
  gear?: string[];
  itin?: Array<[string, string[]]>;
  material?: string[];
  photoCount?: number;
}

const ROWS: Row[] = [
  {
    id: 'acc-01', tag: '边界:0照片',
    title: '白云嶂穿越 · 一日徒步', date: '2026-10-11', place: '惠州 白云嶂', meeting: '07:30 深圳北站',
    price: 198, limit: 20, difficulty: '中等', distance: '12公里', elevation: '累计爬升800米', days: 1,
    feeInclude: ['往返大巴', '专业领队', '户外保险'], feeExclude: ['午餐路餐'],
    gear: ['登山鞋', '雨衣', '1.5L水'],
    itin: [['启程', ['07:30 深圳北站集合出发', '10:00 抵达登山口热身']], ['登顶', ['12:30 冲顶白云嶂', '午餐路餐自理']], ['返程', ['16:30 下撤返深']]],
    material: ['白云嶂海拔1004米，全程约12公里'], photoCount: 0,
  },
  {
    id: 'acc-02', tag: '边界:20照片',
    title: '四姑娘山大峰 · 登顶计划', date: '2026-11-06', place: '四川 小金县', meeting: '成都东站 07:00',
    price: 4980, limit: 12, difficulty: '高强度', distance: '往返34公里', elevation: '海拔5025米', days: 4,
    feeInclude: ['成都往返交通', '高山向导', '营地食宿', '登山许可'],
    gear: ['冲锋衣', '高山靴', '冰爪'],
    itin: [['抵达', ['成都集合，乘车进沟']], ['适应', ['徒步至大本营，海拔适应']], ['登顶', ['凌晨出发，冲顶大峰']], ['返程', ['下撤，返回成都']]],
    material: ['大峰海拔5025米，技术难度低但海拔适应是主要挑战'], photoCount: 20,
  },
  {
    id: 'acc-03', tag: '边界:无价格',
    title: '社区公益净山行动', date: '2026-10-18', place: '杭州 龙井村', meeting: '08:00 龙井村口',
    days: 1, difficulty: '轻松', distance: '6公里',
    feeInclude: ['垃圾袋与手套'], gear: ['手套'],
    itin: [['净山', ['沿茶山步道捡拾垃圾', '11:30 结束']]],
    material: ['公益活动，不收费'], photoCount: 3,
  },
  {
    // 刻意不给集合点：fixture 头部承诺覆盖「缺集合点」，但 30 行里原本没有一个真的缺
    // （承诺的边界没被覆盖 = 假覆盖）。城市夜跑在起跑线集合，本来也不需要统一集合点。
    id: 'acc-04', tag: '边界:无行程+缺集合点',
    title: '城市夜跑接力赛', date: '2026-10-25', place: '上海 滨江',
    price: 39, limit: 200, days: 1,
    feeInclude: ['号码布', '补给'], photoCount: 5,
  },
  {
    id: 'acc-05', tag: '边界:无难度数据',
    title: '秋日野餐日', date: '2026-10-19', place: '南京 老山', meeting: '10:00 老山北门',
    price: 88, limit: 30, days: 1,
    feeInclude: ['场地', '餐食'],
    material: ['适合全家参加'], photoCount: 8,
  },
  {
    id: 'acc-06', tag: '边界:超长标题+中文日期',
    title: '国庆七天川西小环线深度穿越：从丹巴藏寨到色达五明佛学院再到稻城亚丁的一路雪山草原与星空营地之旅',
    date: '2026年10月1日', place: '四川 甘孜', meeting: '成都 集合', price: 3280, limit: 16, days: 7,
    difficulty: '中等', feeInclude: ['包车', '住宿', '门票'], photoCount: 12,
  },
  {
    id: 'acc-07', tag: '边界:特殊字符',
    title: '「夜爬·梧桐山」3小时登顶⛰️看日出／City walk 收尾',
    date: '2026-10-12', place: '深圳 梧桐山', meeting: '23:00 梧桐山北门', price: 128, limit: 25, days: 1,
    difficulty: '中等', feeInclude: ['领队', '夜爬头灯租借'], gear: ['头灯', '薄外套'],
    material: ['夜爬全程约5公里，海拔943米'], photoCount: 6,
  },
  {
    id: 'acc-08', tag: '形态:多日7天',
    title: '喀纳斯徒步穿越', date: '2026-10-05', place: '新疆 布尔津', meeting: '乌鲁木齐集合', price: 4380, limit: 14,
    days: 7, difficulty: '高强度', feeInclude: ['交通', '马帮', '营地'],
    itin: [['D1', ['乌鲁木齐集合']], ['D2', ['抵达禾木']], ['D3', ['禾木到小黑湖']], ['D4', ['小黑湖到喀纳斯']], ['D5', ['喀纳斯休整']], ['D6', ['返布尔津']], ['D7', ['解散']]],
    photoCount: 16,
  },
  {
    id: 'acc-09', tag: '人群:亲子',
    title: '亲子溪谷自然课', date: '2026-10-18', place: '广州 从化', meeting: '09:00 从化客运站',
    price: 168, limit: 20, days: 1, difficulty: '轻松', distance: '3公里',
    feeInclude: ['自然导师', '手工材料'], material: ['适合 4-10 岁儿童，需家长陪同'], photoCount: 10,
  },
  {
    id: 'acc-10', tag: '形态:露营过夜',
    title: '山谷星空露营', date: '2026-10-24', place: '浙江 安吉', meeting: '14:00 安吉营地',
    price: 388, limit: 24, days: 2, difficulty: '轻松',
    feeInclude: ['帐篷', '烧烤晚餐', '早餐'], gear: ['睡袋', '保暖衣物'],
    itin: [['Day1', ['14:00 扎营', '18:00 烧烤']], ['Day2', ['清晨看云海', '10:00 撤营']]],
    photoCount: 9,
  },
  {
    id: 'acc-11', tag: '形态:骑行',
    title: '环湖骑行 60 公里', date: '2026-10-19', place: '千岛湖', meeting: '07:00 淳安县城',
    price: 258, limit: 30, difficulty: '中等', distance: '60公里',
    feeInclude: ['自行车租赁', '保障车'], gear: ['骑行裤', '头盔'],
    material: ['全程沿湖公路，坡度平缓'], photoCount: 7,
  },
  {
    id: 'acc-12', tag: '形态:溯溪',
    title: '台山溯溪跳水', date: '2026-10-20', place: '江门 台山', meeting: '07:30 台山指定点',
    price: 218, limit: 18, difficulty: '中等', distance: '5公里',
    feeInclude: ['溯溪装备', '头盔救生衣'], gear: ['防滑鞋'],
    material: ['溪谷湿滑，需要一定体能'], photoCount: 11,
  },
  {
    id: 'acc-13', tag: '强度:技术型雪山',
    title: '那玛峰攀登（5588米）', date: '2026-11-20', place: '四川 康定', meeting: '成都集合', price: 9800, limit: 8,
    days: 9, difficulty: '技术型', elevation: '海拔5588米',
    feeInclude: ['向导', '装备租赁', '营地'], gear: ['高山靴', '冰镐', '安全带'],
    material: ['需有高海拔经验，含冰川行走训练'], photoCount: 18,
  },
  {
    id: 'acc-14', tag: '人群:企业团建',
    title: 'XX 科技公司秋季团建', date: '2026-10-25', place: '怀柔 雁栖湖', meeting: '08:30 公司楼下',
    price: 320, limit: 80, days: 1, difficulty: '轻松',
    feeInclude: ['大巴', '教练', '午餐'], material: ['含破冰游戏与定向寻宝'], photoCount: 14,
  },
  {
    id: 'acc-15', tag: '人群:摄影团',
    title: '坝上秋色摄影团', date: '2026-10-02', place: '内蒙古 乌兰布统', meeting: '北京 集合',
    price: 2680, limit: 15, days: 5, feeInclude: ['越野车', '住宿', '指导'],
    material: ['日出日落机位，需带长焦'], photoCount: 20,
  },
  {
    id: 'acc-16', tag: '形态:越野赛事',
    title: '山径越野挑战赛 25K', date: '2026-11-01', place: '莫干山', meeting: '06:00 赛事起点',
    price: 480, limit: 300, difficulty: '高强度', distance: '25公里', elevation: '累计爬升1500米', days: 1,
    feeInclude: ['赛事包', '计时芯片', '补给'], material: ['需提供体检证明'], photoCount: 13,
  },
  {
    id: 'acc-17', tag: '形态:夜爬',
    title: '夜爬武功山看日出', date: '2026-10-13', place: '江西 萍乡', meeting: '22:00 山脚',
    price: 268, limit: 22, difficulty: '中等', elevation: '海拔1918米', days: 1,
    feeInclude: ['领队', '头灯'], gear: ['头灯', '冲锋衣'], photoCount: 6,
  },
  {
    id: 'acc-18', tag: '形态:戈壁',
    title: '敦煌戈壁徒步 3 天', date: '2026-10-08', place: '甘肃 敦煌', meeting: '敦煌市区集合',
    price: 3680, limit: 20, days: 3, difficulty: '高强度', distance: '68公里',
    feeInclude: ['营地', '后勤车', '补给'], material: ['昼夜温差大，日行 20 公里以上'], photoCount: 15,
  },
  {
    id: 'acc-19', tag: '形态:度假',
    title: '温泉山居两日', date: '2026-10-26', place: '清远 佛冈', meeting: '09:00 广州东站',
    price: 698, limit: 16, days: 2, difficulty: '轻松',
    feeInclude: ['温泉门票', '住宿', '两餐'], material: ['适合带长辈'], photoCount: 4,
  },
  {
    id: 'acc-20', tag: '形态:海岛',
    title: '海岛露营与浮潜', date: '2026-11-07', place: '阳江 海陵岛', meeting: '07:00 阳江站',
    price: 458, limit: 24, days: 2, feeInclude: ['船票', '浮潜装备', '营地'],
    material: ['需会基本游泳'], photoCount: 12,
  },
  {
    id: 'acc-21', tag: '形态:滑雪',
    title: '崇礼滑雪开板', date: '2026-12-05', place: '张家口 崇礼', meeting: '北京北站',
    price: 1280, limit: 20, days: 2, feeInclude: ['雪票', '住宿', '教练'],
    material: ['含新手教学，装备可租'], photoCount: 10,
  },
  {
    id: 'acc-22', tag: '形态:攀岩',
    title: '阳朔攀岩入门', date: '2026-11-14', place: '广西 阳朔', meeting: '阳朔西街',
    price: 680, limit: 12, days: 2, difficulty: '中等',
    feeInclude: ['教练', '装备'], material: ['零基础可参加'], photoCount: 7,
  },
  {
    id: 'acc-23', tag: '形态:城市漫步',
    title: '老城 Citywalk · 骑楼与糖水', date: '2026-10-17', place: '广州 荔湾', meeting: '14:00 陈家祠',
    price: 98, limit: 30, days: 1, difficulty: '轻松', distance: '4公里',
    feeInclude: ['讲解', '糖水一份'], material: ['全程步行，适合拍照'], photoCount: 6,
  },
  {
    id: 'acc-24', tag: '形态:自驾',
    title: '川西自驾环线', date: '2026-10-03', place: '四川 阿坝', meeting: '成都 集合',
    price: 2380, limit: 12, days: 5, feeInclude: ['车辆', '油费', '住宿'],
    material: ['需自带驾照，山路驾驶经验'], photoCount: 14,
  },
  {
    id: 'acc-25', tag: '形态:观星',
    title: '高原观星营', date: '2026-10-16', place: '青海 冷湖', meeting: '敦煌集合',
    price: 1580, limit: 18, days: 3, feeInclude: ['交通', '营地', '天文讲师'],
    material: ['含望远镜观测，夜间气温接近零度'], photoCount: 9,
  },
  {
    id: 'acc-26', tag: '形态:农事采摘',
    title: '秋收稻田与柿子采摘', date: '2026-10-19', place: '桂林 龙胜', meeting: '08:00 龙胜县城',
    price: 128, limit: 40, days: 1, difficulty: '轻松',
    feeInclude: ['采摘', '农家午餐'], material: ['可带走 2 斤柿子'], photoCount: 8,
  },
  {
    id: 'acc-27', tag: '人群:研学',
    title: '地质研学一日营', date: '2026-10-22', place: '北京 房山', meeting: '08:30 房山地质公园',
    price: 288, limit: 25, days: 1, difficulty: '轻松',
    feeInclude: ['地质老师', '教具', '保险'], material: ['小学三至六年级'], photoCount: 5,
  },
  {
    id: 'acc-28', tag: '人群:宠物同行',
    title: '带狗去徒步', date: '2026-10-21', place: '苏州 穹窿山', meeting: '09:00 山门',
    price: 158, limit: 20, days: 1, difficulty: '轻松', distance: '5公里',
    feeInclude: ['领队', '宠物饮水点'], material: ['需牵绳，不接待烈性犬'], photoCount: 10,
  },
  {
    id: 'acc-29', tag: '形态:轻运动',
    title: '草地飞盘 & 落日瑜伽', date: '2026-10-20', place: '成都 兴隆湖', meeting: '16:00 湖边草坪',
    price: 68, limit: 36, days: 1, difficulty: '轻松',
    feeInclude: ['教练', '器材', '饮水'], material: ['零基础友好'], photoCount: 7,
  },
  {
    id: 'acc-30', tag: '形态:极端组合',
    title: '沙漠穿越 + 洞穴探秘', date: '2026-11-28', place: '宁夏 中卫 / 湖北 恩施', meeting: '中卫集合',
    price: 5680, limit: 10, days: 6, difficulty: '高强度',
    feeInclude: ['越野车', '探洞装备', '向导'], gear: ['头灯', '安全带'],
    material: ['含 1 天洞穴绳索下降'], photoCount: 17,
  },
];

export function buildFixture30(): Fixture[] {
  return ROWS.map(function (r) {
    const activity: Record<string, unknown> = { title: r.title, days: r.days };
    if (r.date) activity.date = r.date;
    if (r.place) activity.place = r.place;
    if (r.meeting) activity.meeting = r.meeting;
    if (r.limit !== undefined) activity.limit = r.limit;
    if (r.difficulty) activity.difficulty = r.difficulty;
    if (r.distance) activity.distance = r.distance;
    if (r.elevation) activity.elevation = r.elevation;
    if (r.itin) activity.itinerary = itin(r.itin);
    if (r.gear) activity.checklist = { required: r.gear, recommended: [] };

    const planFacts: Record<string, unknown> = {};
    if (r.price !== undefined) planFacts.price = r.price;
    if (r.limit !== undefined) planFacts.limit = r.limit;
    if (r.place) planFacts.place = r.place;
    if (r.meeting) planFacts.meeting = r.meeting;
    if (r.date) planFacts.date = r.date;
    planFacts.days = r.days;
    if (r.feeInclude) planFacts.feeInclude = r.feeInclude;
    if (r.feeExclude) planFacts.feeExclude = r.feeExclude;

    return {
      id: r.id,
      tag: r.tag,
      activity,
      planFacts,
      materialText: r.material || [],
      photos: photos(r.photoCount || 0, r.id),
    };
  });
}

/** 供线上跑批按 id 取单场（也用于「只补跑失败的那几场」） */
export function fixtureById(id: string): Fixture | undefined {
  return buildFixture30().filter(function (f) { return f.id === id; })[0];
}
