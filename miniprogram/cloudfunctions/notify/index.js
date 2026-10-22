/**
 * 云函数：订阅消息额度与每日推送
 *
 * 两个动作：
 *   action=query    查当前用户还剩几次推送额度
 *   action=add      攒额度（用户每点一次「+1 次通知」调一次，count 累加）
 *   action=dispatch 每日推送：给所有额度 > 0 的用户发一条订阅消息，发一条扣一次
 *
 * 额度存在云数据库（不是本地存储）：换设备、清缓存、重新安装都不影响。
 * 发送失败**不扣**额度——用户攒了 50 次结果一次都没发出去，是最坏的体验。
 *
 * 定时触发：dispatch 需要在云开发控制台给本函数配一个定时触发器
 * （每天 14:50 触发一次，对齐抓取的收盘前那次）。开发工具里改 config.json 无效，
 * 触发器要在控制台配。详见 miniprogram/README.md。
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const COLLECTION = 'subs';
const MAX_QUOTA = 60;

/** 订阅消息模板。字段名必须与自己申请模板时选的一致，否则发送会报 47003。 */
const DISPATCH = {
  templateId: '',
  // 例：{ thing1: '事件', date2: '时间', thing3: '内容' }
  fields: {},
  miniprogramState: 'formal',
  page: 'pages/index/index',
};

async function readSummary() {
  try {
    const ctx = cloud.getWXContext();
    const envId = ctx.ENV || '';
    if (!envId) return null;
    const res = await cloud.downloadFile({ fileID: `cloud://${envId}/data/bundle.json` });
    const bundle = JSON.parse(res.fileContent.toString('utf8'));
    return bundle.summary || null;
  } catch (e) {
    return null;
  }
}

exports.main = async (event) => {
  const action = (event && event.action) || 'query';

  // ── 定时推送：不需要用户上下文 ──
  if (action === 'dispatch') {
    if (!DISPATCH.templateId) return { ok: false, error: '模板未配置' };
    const summary = await readSummary();
    if (!summary) return { ok: false, error: '云存储里没有 bundle.json' };

    let sent = 0;
    let failed = 0;
    let cursor = 0;
    const pageSize = 100;
    for (;;) {
      const res = await db
        .collection(COLLECTION)
        .where({ quota: _.gt(0) })
        .skip(cursor)
        .limit(pageSize)
        .get();
      const list = res.data || [];
      if (!list.length) break;
      for (const u of list) {
        try {
          await cloud.openapi.subscribeMessage.send({
            touser: u._id,
            templateId: DISPATCH.templateId,
            page: DISPATCH.page,
            miniprogramState: DISPATCH.miniprogramState,
            data: buildData(summary),
          });
          await db.collection(COLLECTION).doc(u._id).update({ data: { quota: _.inc(-1) } });
          sent++;
        } catch (e) {
          failed++; // 不扣额度
        }
      }
      cursor += list.length;
      if (list.length < pageSize) break;
    }
    return { ok: true, sent: sent, failed: failed };
  }

  // ── 以下都要用户上下文 ──
  const ctx = cloud.getWXContext();
  const openid = ctx.OPENID;
  if (!openid) return { ok: false, error: '拿不到 openid' };

  if (action === 'query') {
    const cur = await db
      .collection(COLLECTION)
      .doc(openid)
      .get()
      .catch(() => null);
    const quota = cur && cur.data && typeof cur.data.quota === 'number' ? cur.data.quota : 0;
    return { ok: true, quota: quota };
  }

  if (action === 'add') {
    let count = Number(event.count);
    if (!isFinite(count) || count < 1) count = 1;
    if (count > 10) count = 10; // 单次最多加 10，攒 50 次要点 5 下太累

    const cur = await db
      .collection(COLLECTION)
      .doc(openid)
      .get()
      .catch(() => null);
    const have = cur && cur.data && typeof cur.data.quota === 'number' ? cur.data.quota : 0;
    if (have >= MAX_QUOTA) return { ok: true, quota: have, capped: true };

    const add = Math.min(count, MAX_QUOTA - have);
    try {
      await db.collection(COLLECTION).doc(openid).update({ data: { quota: _.inc(add), updatedAt: Date.now() } });
    } catch (e) {
      // 文档还不存在 → 建一个
      await db.collection(COLLECTION).doc(openid).set({ data: { quota: add, updatedAt: Date.now() } });
    }
    const after = await db.collection(COLLECTION).doc(openid).get();
    const quota = after && after.data && typeof after.data.quota === 'number' ? after.data.quota : 0;
    return { ok: true, quota: quota, capped: quota >= MAX_QUOTA };
  }

  return { ok: false, error: '未知动作：' + action };
};

/**
 * 把摘要填进模板字段。
 * 模板字段名由申请模板时选定，这里按 DISPATCH.fields 的映射填空；
 * 没配映射就退化成一句纯文本（text 类型的模板）。
 */
function buildData(summary) {
  const text = `${summary.headline}。${summary.summaryDelta || ''}`.trim();
  const data = {};
  for (const key of Object.keys(DISPATCH.fields)) {
    const kind = DISPATCH.fields[key];
    if (kind === 'headline') data[key] = { value: summary.headline };
    else if (kind === 'summary') data[key] = { value: summary.summaryDelta || '—' };
    else if (kind === 'date') data[key] = { value: summary.updatedLabel };
    else data[key] = { value: text.slice(0, 20) };
  }
  if (!Object.keys(data).length) {
    // 没配字段映射：只能按最常见的 thing1 猜。字段名对不上会报 47003，
    // 那种情况是模板配错了，不是数据问题——不扣额度，重试即可。
    data.thing1 = { value: text.slice(0, 20) };
  }
  return data;
}
