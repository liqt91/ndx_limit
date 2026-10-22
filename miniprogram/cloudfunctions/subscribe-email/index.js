/**
 * 云函数：把小程序里的邮箱订阅转发到网页版那套订阅接口。
 *
 * 为什么不直接 wx.request：小程序的 request 合法域名必须已备案，
 * 而 ndx.liqt91.top 托管在境外、无法完成 ICP 备案。云函数出网不受这个限制，
 * 所以由它转发到同一个 EdgeOne 接口——名单还是在原来的 KV 里，小程序只是又一个入口。
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const API = 'https://ndx.liqt91.top/api/subscribe';

exports.main = async (event) => {
  const email = String((event && event.email) || '').trim();
  if (!email) return { ok: false, error: '缺少邮箱' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: '邮箱格式不对' };

  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: email }),
    });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch (e) {
      body = { raw: text.slice(0, 200) };
    }
    if (!res.ok) {
      return { ok: false, error: `接口返回 ${res.status}`, detail: body };
    }
    return { ok: true, status: res.status, detail: body };
  } catch (e) {
    return { ok: false, error: '请求失败：' + (e && e.message ? e.message : e) };
  }
};
