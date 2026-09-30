const initSqlJs = require('sql.js');
const { join } = require('path');
const { readFileSync, writeFileSync, existsSync } = require('fs');

const DB_PATH = join(__dirname, '..', 'bills.db');

let db;
let SQL; // sql.js module instance

async function open() {
  if (db) return db;
  SQL = await initSqlJs();

  if (existsSync(DB_PATH)) {
    const buffer = readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.run('PRAGMA foreign_keys = ON');
  initTables();
  save();
  return db;
}

function save() {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  writeFileSync(DB_PATH, buffer);
}

function initTables() {
  db.run(`
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      time TEXT,
      category TEXT,
      counterparty TEXT NOT NULL DEFAULT '',
      description TEXT DEFAULT '',
      direction TEXT NOT NULL CHECK(direction IN ('expense','income')),
      amount REAL NOT NULL DEFAULT 0,
      payment_method TEXT DEFAULT '',
      status TEXT DEFAULT '',
      source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('wechat','alipay','manual')),
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  db.run('CREATE INDEX IF NOT EXISTS idx_txns_date ON transactions(date)');
  db.run('CREATE INDEX IF NOT EXISTS idx_txns_category ON transactions(category)');
  db.run('CREATE INDEX IF NOT EXISTS idx_txns_source ON transactions(source)');

  // Migration: add necessity column if not exists (v2)
  try { db.run('ALTER TABLE transactions ADD COLUMN necessity TEXT DEFAULT NULL'); } catch (_) {}

  db.run(`
    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      necessity TEXT NOT NULL DEFAULT 'unset' CHECK(necessity IN ('need','want','maybe','unset')),
      keywords TEXT DEFAULT '',
      icon TEXT DEFAULT '',
      color TEXT NOT NULL DEFAULT '#636e72',
      source TEXT NOT NULL DEFAULT 'user' CHECK(source IN ('system','user'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS import_history (
      id TEXT PRIMARY KEY,
      time TEXT NOT NULL,
      file_name TEXT NOT NULL,
      source TEXT NOT NULL,
      total_rows INTEGER NOT NULL DEFAULT 0,
      new_rows INTEGER NOT NULL DEFAULT 0,
      skipped_rows INTEGER NOT NULL DEFAULT 0
    )
  `);
  save();

  // Seed default categories if empty
  const result = db.exec('SELECT COUNT(*) as c FROM categories');
  const count = result[0]?.values[0]?.[0] ?? 0;
  if (count === 0) seedDefaults();
}

function seedDefaults() {
  const defaults = [
    { id:'cat_food',     name:'餐饮美食', necessity:'need',  keywords:'餐厅,饭店,外卖,美团,饿了么,肯德基,麦当劳,奶茶,咖啡,面包,烧烤,火锅,食堂,小吃,水果,零食,面馆,米线,饺子,快餐,拉面,麻辣烫,串串,烤鱼,卤味,甜品,蛋糕,冰淇淋,茶,饮品,星巴克,瑞幸,costa,蜜雪冰城,喜茶,奈雪,一点点,coco,茶百道,古茗,必胜客,汉堡,炸鸡,沙拉,轻食,麻辣香锅,冒菜,米粉,螺蛳粉,酸辣粉,凉皮,肉夹馍,煎饼,包子,馒头,粥,豆浆,油条,早餐,午餐,晚餐,夜宵,盒饭,便当,食堂卡,饭卡', icon:'🍜', color:'#e94560', source:'system' },
    { id:'cat_transport', name:'交通出行', necessity:'need',  keywords:'地铁,公交,滴滴,打车,出租车,高铁,火车,机票,航班,加油,充电,停车,单车,骑行,哈啰,曹操,花小猪,高德打车,嘀嗒,首汽,如祺,t3,享道,阳光,神州专车,一嗨,联动云,gofun,摩捷,摩范,轻享,evcard,曹操出行,高德,出租车费,过路费,etc,高速,通行费,地铁卡,公交卡,一卡通,交通卡,汽车票,长途,大巴,客运,船票,轮渡,代驾', icon:'🚇', color:'#4ecdc4', source:'system' },
    { id:'cat_shopping',  name:'购物消费', necessity:'maybe', keywords:'淘宝,京东,拼多多,唯品会,超市,便利店,商场,优衣库,沃尔玛,盒马,永辉,大润发,华润,物美,联华,家乐福,麦德龙,山姆,costco,罗森,全家,711,便利蜂,天猫,闲鱼,得物,网易严选,小米有品,当当,孔夫子,多抓鱼,苏宁,国美,什么值得买,海淘,代购,屈臣氏,丝芙兰,名创优品,无印良品,muji,nome,kkv,thegreenparty,杂物社,酷乐潮玩,泡泡玛特,乐高', icon:'🛒', color:'#f0a050', source:'system' },
    { id:'cat_housing',   name:'住房日用', necessity:'need',  keywords:'房租,水电,物业,燃气,网费,话费,日用品,洗衣,纸巾,电费,水费,煤气,暖气,垃圾费,宽带,路由器,网线,wifi,洗漱,牙膏,牙刷,毛巾,洗发水,沐浴露,洗衣液,洗洁精,垃圾袋,拖把,扫帚,清洁,消毒,洗手液,口罩,卫生巾,纸巾,湿巾,电池,灯泡,插座,收纳,衣架', icon:'🏠', color:'#6c5ce7', source:'system' },
    { id:'cat_education', name:'教育学习', necessity:'need',  keywords:'书,课程,培训,考试,考证,教材,学费,打印,知网,文具,笔,笔记本,书店,图书馆,考研,雅思,托福,gre,四六级,英语,日语,法语,编程,网课,慕课,学堂在线,coursera,udemy,得到,樊登,知乎,知识付费,付费专栏,会员,订阅,kindle,微信读书,掌阅,蜗牛,多看,咪咕,喜马拉雅,得到,极客时间,掘金,csdn,慕课网,实验楼', icon:'📚', color:'#a29bfe', source:'system' },
    { id:'cat_medical',   name:'医疗健康', necessity:'need',  keywords:'医院,药,诊所,体检,挂号,牙科,眼科,药店,处方,中药,西药,感冒,发烧,咳嗽,止痛,消炎,创可贴,碘伏,酒精,口罩,体温计,血压,血糖,胰岛素,过敏,鼻炎,哮喘,皮炎,湿疹,脚气,胃药,腹泻,便秘,维生素,钙片,蛋白粉,鱼油,褪黑素,益生菌,保健品,按摩,推拿,针灸,拔罐,正骨,理疗', icon:'💊', color:'#fd79a8', source:'system' },
    { id:'cat_entertainment', name:'娱乐休闲', necessity:'want', keywords:'游戏,电影,ktv,剧本杀,密室,酒吧,演唱会,音乐节,b站,bilibili,steam,网易,会员,视频,音乐,直播,网咖,网吧,电玩,桌游,棋牌,麻将,台球,保龄球,溜冰,滑雪,游泳,健身,瑜伽,舞蹈,攀岩,蹦床,卡丁车,射箭,射击,真人cs,鬼屋,密室逃脱,游乐场,游乐园,迪士尼,环球影城,欢乐谷,方特,海洋馆,动物园,植物园,博物馆,美术馆,展览,话剧,音乐剧,脱口秀,相声,戏曲,歌剧,交响,livehouse,club,夜店,蹦迪', icon:'🎮', color:'#ff7675', source:'system' },
    { id:'cat_digital',   name:'数码电子', necessity:'maybe', keywords:'手机,电脑,耳机,充电宝,硬盘,数据线,配件,数码,平板,笔记本,台式机,显示器,键盘,鼠标,音箱,蓝牙,airpods,airtag,apple,华为,小米,三星,oppo,vivo,荣耀,一加,真我,努比亚,红魔,黑鲨,rog,雷蛇,罗技,赛睿,cherry,filco,ikbc,akko,达尔优,漫步者,索尼,bose,b&o,sennheiser,akg,铁三角,舒尔,威士顿,ue,earpods,beats,jbl,哈曼,马歇尔,b&w,kef,丹拿,真力,iloud,presonus,focusrite,雅马哈,罗兰', icon:'📱', color:'#74b9ff', source:'system' },
    { id:'cat_fashion',   name:'服饰美容', necessity:'want',  keywords:'衣服,鞋,包,化妆品,护肤,理发,美甲,香水,饰品,裤子,裙子,t恤,衬衫,外套,羽绒服,大衣,毛衣,卫衣,内衣,袜子,帽子,围巾,手套,墨镜,眼镜,手表,首饰,项链,手链,耳环,戒指,发夹,头绳,口红,粉底,眼影,腮红,眉笔,睫毛膏,卸妆,洗面奶,爽肤水,乳液,面霜,精华,防晒,面膜,眼霜,颈霜,身体乳,护手霜,润唇膏,发膜,护发素,染发,烫发,接发,植发,纹眉,美瞳,隐形眼镜,护理液,化妆棉,化妆刷', icon:'👗', color:'#e17055', source:'system' },
    { id:'cat_social',    name:'社交人情', necessity:'maybe', keywords:'红包,转账,礼物,聚餐,份子,请客,婚礼,生日,过年,过节,压岁钱,随礼,礼金,伴手礼,聚餐aa,团建,聚会,派对,送礼,贺礼,满月,乔迁,升职,毕业,入学,升学,谢师,探望,慰问,白事,帛金,花圈,花篮,请吃饭,aa收款,群收款', icon:'🎁', color:'#ff6348', source:'system' },
    { id:'cat_telecom',   name:'通讯网络', necessity:'need',  keywords:'话费,流量,宽带,充值,手机费,固话,vpn,代理,云服务,服务器,域名,空间,cdn,oss,腾讯云,阿里云,华为云,aws,azure,gcp,vercel,netlify,cloudflare,github,gitlab,bitbucket,notion,obsidian,logseq,roam,flomo,cubox,readwise,instapaper,pocket,feedly,inoreader,newsletter', icon:'📡', color:'#00b894', source:'system' },
    { id:'cat_delivery',  name:'快递物流', necessity:'need',  keywords:'快递,顺丰,中通,圆通,菜鸟,运费,邮政,ems,韵达,百世,极兔,德邦,京东物流,跨越,安能,壹米滴答,优速,速尔,宅急送,日日顺,申通,丰巢,快递柜,驿站,菜鸟裹裹,退货,换货,到付,保价,代收,货到付款,物流,货运,搬家,拉货,货拉拉,快狗,运满满', icon:'📦', color:'#00cec9', source:'system' },
    { id:'cat_income',    name:'收入',     necessity:'need',  keywords:'工资,奖金,兼职,稿费,退款,返利,报销,红包,转账,收款,零钱,提现,转入', icon:'💰', color:'#4ecdc4', source:'system' },
    { id:'cat_other',     name:'其他',     necessity:'unset', keywords:'', icon:'📌', color:'#636e72', source:'system' },
  ];

  const stmt = db.prepare('INSERT INTO categories (id, name, necessity, keywords, icon, color, source) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const c of defaults) {
    stmt.run([c.id, c.name, c.necessity, c.keywords, c.icon, c.color, c.source]);
  }
  stmt.free();
  save();
}

// ── Helpers ──

function rowsToObjects(result) {
  if (!result || result.length === 0) return [];
  const cols = result[0].columns;
  const objects = [];
  for (const row of result[0].values) {
    const obj = {};
    for (let i = 0; i < cols.length; i++) obj[cols[i]] = row[i];
    objects.push(obj);
  }
  return objects;
}

// ── Transactions ──

function getTransactions() {
  const r = db.exec('SELECT * FROM transactions ORDER BY date DESC, time DESC');
  return rowsToObjects(r);
}

function importTransactions(txns) {
  const r = db.exec('SELECT id FROM transactions');
  const existingIds = new Set();
  if (r.length > 0) {
    for (const row of r[0].values) existingIds.add(row[0]);
  }

  const newTxns = txns.filter(t => !existingIds.has(t.id));
  const skipped = txns.length - newTxns.length;

  const stmt = db.prepare(
    'INSERT OR IGNORE INTO transactions (id, date, time, category, counterparty, description, direction, amount, payment_method, status, source, necessity) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  for (const t of newTxns) {
    stmt.run([t.id, t.date, t.time||null, t.category||null, t.counterparty||'', t.description||'', t.direction, t.amount, t.payment_method||'', t.status||'', t.source||'manual', t.necessity||null]);
  }
  stmt.free();

  // Verify before save
  const totalCount = db.exec('SELECT COUNT(*) FROM transactions')[0].values[0][0];
  console.log(`[bills-db] Before save: DB has ${totalCount} rows, inserting ${newTxns.length}, skipping ${skipped}`);

  save();

  const afterCount = db.exec('SELECT COUNT(*) FROM transactions')[0].values[0][0];
  console.log(`[bills-db] After save: DB has ${afterCount} rows`);

  return { newCount: newTxns.length, skippedCount: skipped };
}

function updateTxnCategory(id, category) {
  db.run('UPDATE transactions SET category = ? WHERE id = ?', [category, id]);
  save();
}

function updateTxnNecessity(id, necessity) {
  db.run('UPDATE transactions SET necessity = ? WHERE id = ?', [necessity||null, id]);
  save();
}

function deleteTransaction(id) {
  db.run('DELETE FROM transactions WHERE id = ?', [id]);
  save();
}

// ── Categories ──

function getCategories() {
  const r = db.exec('SELECT * FROM categories ORDER BY source DESC, id');
  return rowsToObjects(r);
}

function upsertCategory(cat) {
  // sql.js doesn't support ON CONFLICT, use manual upsert
  const existing = db.exec('SELECT id FROM categories WHERE id = ?', [cat.id]);
  if (existing.length > 0 && existing[0].values.length > 0) {
    db.run(
      'UPDATE categories SET name=?, necessity=?, keywords=?, icon=?, color=? WHERE id=?',
      [cat.name, cat.necessity||'unset', cat.keywords||'', cat.icon||'', cat.color||'#636e72', cat.id]
    );
  } else {
    db.run(
      'INSERT INTO categories (id, name, necessity, keywords, icon, color, source) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [cat.id, cat.name, cat.necessity||'unset', cat.keywords||'', cat.icon||'', cat.color||'#636e72', cat.source||'user']
    );
  }
  save();
}

function deleteCategory(id) {
  const r = db.exec('SELECT name, source FROM categories WHERE id = ?', [id]);
  if (r.length === 0 || r[0].values.length === 0) return null;
  const catName = r[0].values[0][0];
  const catSource = r[0].values[0][1];
  if (catSource === 'system') return { error: 'cannot delete system category' };

  db.run('DELETE FROM categories WHERE id = ?', [id]);
  db.run('UPDATE transactions SET category = ? WHERE category = ?', ['其他', catName]);
  save();
  return { name: catName };
}

// ── Import history ──

function getImports() {
  const r = db.exec('SELECT * FROM import_history ORDER BY time DESC');
  return rowsToObjects(r);
}

function addImport(imp) {
  db.run(
    'INSERT OR REPLACE INTO import_history (id, time, file_name, source, total_rows, new_rows, skipped_rows) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [imp.id, imp.time, imp.fileName, imp.source, imp.totalRows, imp.newRows, imp.skippedRows]
  );
  // Keep max 50
  db.run('DELETE FROM import_history WHERE id NOT IN (SELECT id FROM import_history ORDER BY time DESC LIMIT 50)');
  save();
}

// ── Server init ──

function close() {
  if (db) { db.close(); db = null; }
}

module.exports = {
  open, close,
  getTransactions, importTransactions, updateTxnCategory, updateTxnNecessity, deleteTransaction,
  getCategories, upsertCategory, deleteCategory,
  getImports, addImport,
};
