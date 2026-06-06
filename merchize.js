// Vercel Serverless — Merchize proxy: KÉO ĐƠN TỪ MERCHIZE về app
// Yêu cầu đăng nhập (header X-Session).
//
// Cấu hình trên Vercel (Environment Variables):
//   MERCHIZE_BASE_URL   = https://ten-store.merchize.store/bo-api   (có thể kèm hoặc bỏ /bo-api)
//   MERCHIZE_API_KEY    = access token lấy từ Merchize dashboard → menu API
//
// LƯU Ý: token Merchize hết hạn hàng tháng, phải cập nhật lại định kỳ.
//
// Các action (?action=):
//   orders  → lấy danh sách đơn (thử nhiều endpoint phổ biến, trả về cái nào chạy)
//   probe   → CHẨN ĐOÁN: thử lần lượt các endpoint, báo cái nào trả dữ liệu (để biết đúng đường)

import { verify } from './auth.js';

function getConfig(req, session) {
  let base = process.env.MERCHIZE_BASE_URL || '';
  let key = process.env.MERCHIZE_API_KEY || '';
  // Cho phép admin truyền tạm qua header (test nhanh)
  if (session.role === 'admin') {
    if (req.headers['x-mrz-base']) base = req.headers['x-mrz-base'];
    if (req.headers['x-mrz-key']) key = req.headers['x-mrz-key'];
  }
  // Chuẩn hoá: bỏ dấu / cuối
  base = base.replace(/\/+$/, '');
  return { base, key };
}

// Gọi 1 endpoint Merchize, thử cả cách xác thực qua header lẫn query
async function tryFetch(url, key) {
  const attempts = [
    { headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' }, url },
    { headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' }, url },
    { headers: { 'Content-Type': 'application/json' }, url: url + (url.includes('?') ? '&' : '?') + 'api_key=' + encodeURIComponent(key) },
  ];
  for (const a of attempts) {
    try {
      const r = await fetch(a.url, { headers: a.headers });
      const text = await r.text();
      let json; try { json = JSON.parse(text); } catch (e) { json = null; }
      if (r.ok && json) return { ok: true, status: r.status, json, auth: a.headers['X-API-KEY'] ? 'x-api-key' : (a.headers['Authorization'] ? 'bearer' : 'query') };
      // lưu lỗi gần nhất
      var last = { ok: false, status: r.status, json, text: text.slice(0, 200) };
    } catch (e) { var last = { ok: false, status: 0, error: e.message }; }
  }
  return last;
}

// Trích mảng đơn từ nhiều kiểu response khác nhau
function extractOrders(json) {
  if (!json) return null;
  if (Array.isArray(json)) return json;
  if (Array.isArray(json.data)) return json.data;
  if (json.data && Array.isArray(json.data.records)) return json.data.records;
  if (Array.isArray(json.records)) return json.records;
  if (Array.isArray(json.orders)) return json.orders;
  if (json.data && Array.isArray(json.data.orders)) return json.data.orders;
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Session, X-Mrz-Base, X-Mrz-Key');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const session = verify(req.headers['x-session']);
  if (!session) { res.status(401).json({ error: 'Chưa đăng nhập' }); return; }

  const { base, key } = getConfig(req, session);
  if (!base || !key) { res.status(400).json({ error: 'Chưa cấu hình MERCHIZE_BASE_URL và MERCHIZE_API_KEY' }); return; }

  const action = req.query.action || 'orders';

  // Các đường dẫn endpoint phổ biến của Merchize bo-api để thử
  const candidates = [
    '/orders',
    '/order',
    '/orders/list',
    '/api/orders',
    '/seller/orders',
    '/v1/orders',
  ];
  const sep = base.endsWith('/bo-api') ? '' : '/bo-api';
  const root = base.endsWith('/bo-api') ? base : base + sep;

  try {
    if (action === 'probe') {
      const out = [];
      for (const path of candidates) {
        const url = `${root}${path}?limit=5`;
        const r = await tryFetch(url, key);
        const orders = r.ok ? extractOrders(r.json) : null;
        out.push({ path, http: r.status, ok: r.ok, auth: r.auth || '-', found_orders: orders ? orders.length : (r.ok ? 'ok-nhưng-không-rõ-mảng' : 0), note: r.error || (r.text ? r.text.slice(0, 80) : '') });
        if (orders && orders.length) break; // tìm được rồi thì dừng
      }
      res.status(200).json({ root, probe: out });
      return;
    }

    // action=orders: thử lần lượt tới khi lấy được
    const limit = req.query.limit || 50;
    for (const path of candidates) {
      const url = `${root}${path}?limit=${limit}`;
      const r = await tryFetch(url, key);
      if (r.ok) {
        const orders = extractOrders(r.json);
        if (orders) { res.status(200).json({ ok: true, endpoint: path, count: orders.length, data: orders }); return; }
      }
    }
    res.status(404).json({ error: 'Không tìm thấy endpoint đơn hàng phù hợp. Dùng action=probe để chẩn đoán, hoặc gửi tài liệu API Merchize.' });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}
