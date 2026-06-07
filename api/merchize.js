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

// Gọi 1 endpoint Merchize, thử cả cách xác thực qua header lẫn query; hỗ trợ GET/POST
async function tryFetch(url, key, method = 'GET') {
  const body = method === 'POST' ? JSON.stringify({ limit: 50, page: 1 }) : undefined;
  const attempts = [
    { headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' }, url },
    { headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' }, url },
    { headers: { 'Content-Type': 'application/json' }, url: url + (url.includes('?') ? '&' : '?') + 'api_key=' + encodeURIComponent(key) },
  ];
  let last = { ok: false, status: 0 };
  for (const a of attempts) {
    try {
      const opts = { method, headers: a.headers };
      if (body) opts.body = body;
      const r = await fetch(a.url, opts);
      const text = await r.text();
      let json; try { json = JSON.parse(text); } catch (e) { json = null; }
      if (r.ok && json) return { ok: true, status: r.status, json, auth: a.headers['Authorization'] ? 'bearer' : (a.headers['X-API-KEY'] ? 'x-api-key' : 'query') };
      last = { ok: false, status: r.status, json, text: text.slice(0, 200) };
    } catch (e) { last = { ok: false, status: 0, error: e.message }; }
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
  // (/order trả 200 "order management service" → endpoint thật nằm dưới /order)
  const candidates = [
    { path: '/order/get-orders', method: 'GET' },
    { path: '/order/getOrders', method: 'GET' },
    { path: '/order/list-order', method: 'GET' },
    { path: '/order/list-orders', method: 'GET' },
    { path: '/order/get-list-order', method: 'GET' },
    { path: '/order-list', method: 'GET' },
    { path: '/order/lists', method: 'GET' },
    { path: '/order/list', method: 'GET' },
    { path: '/order/search', method: 'GET' },
    { path: '/order/all', method: 'GET' },
    { path: '/order/data', method: 'GET' },
    { path: '/order/items', method: 'GET' },
    { path: '/order/get-list', method: 'GET' },
  ];
  const sep = base.endsWith('/bo-api') ? '' : '/bo-api';
  const root = base.endsWith('/bo-api') ? base : base + sep;

  try {
    // action=details: lấy chi tiết theo DANH SÁCH MÃ ĐƠN (endpoint chính thức Merchize)
    // POST /order/external/orders/list-orders-detail  body:{orders:[{code/external_number}]}
    if (action === 'details') {
      let codes = [];
      try { const b = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; codes = (b && b.codes) || []; } catch (e) {}
      if (!codes.length) { res.status(400).json({ error: 'Thiếu danh sách mã đơn (codes)' }); return; }
      const debug = req.query.debug === '1';
      if (!key) { res.status(200).json({ error: 'Chưa có API key', hint: 'Nhập API Key Merchize trong Cài đặt rồi Lưu', base }); return; }
      const rootD = base.endsWith('/bo-api') ? base : base + '/bo-api';
      const url = `${rootD}/order/external/orders/list-orders-detail`;
      const ordersBody = codes.map(c => {
        const s = String(c).trim();
        return /^[A-Z]{2}-/i.test(s) ? { code: s } : { external_number: s };
      });
      const body = JSON.stringify({ orders: ordersBody });
      // Thử nhiều cách xác thực
      const authMethods = [
        { name: 'bearer', headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' }, u: url },
        { name: 'x-api-key', headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' }, u: url },
        { name: 'api-key', headers: { 'api-key': key, 'Content-Type': 'application/json' }, u: url },
        { name: 'token', headers: { 'X-Merchize-Api-Key': key, 'Content-Type': 'application/json' }, u: url },
        { name: 'query', headers: { 'Content-Type': 'application/json' }, u: url + '?api_key=' + encodeURIComponent(key) },
      ];
      const tried = [];
      for (const m of authMethods) {
        try {
          const r = await fetch(m.u, { method: 'POST', headers: m.headers, body });
          const text = await r.text();
          let json; try { json = JSON.parse(text); } catch (e) { json = null; }
          tried.push({ method: m.name, http: r.status, ok: r.ok, sample: text.slice(0, 120) });
          if (r.ok && json && (json.data || json.orders || json.success)) {
            const data = json.data || json.orders || [];
            res.status(200).json({ ok: true, authUsed: m.name, count: Array.isArray(data) ? data.length : 0, data, ...(debug ? { tried } : {}) });
            return;
          }
        } catch (e) { tried.push({ method: m.name, error: e.message }); }
      }
      // Tất cả đều fail
      res.status(200).json({ error: 'Merchize từ chối mọi cách xác thực', http: 403, base: rootD, url, keyLen: key.length, tried });
      return;
    }

    if (action === 'probe') {
      const out = [];
      for (const c of candidates) {
        const q = c.method === 'GET' ? '?limit=5&page=1&per_page=5' : '';
        const url = `${root}${c.path}${q}`;
        const r = await tryFetch(url, key, c.method);
        const orders = r.ok ? extractOrders(r.json) : null;
        out.push({ path: `${c.method} ${c.path}`, http: r.status, ok: r.ok, auth: r.auth || '-', found_orders: orders ? orders.length : (r.ok ? 'ok-?mảng' : 0), note: r.error || (r.text ? r.text.slice(0, 70) : '') });
        if (orders && orders.length) break; // tìm được rồi thì dừng
      }
      res.status(200).json({ root, probe: out });
      return;
    }

    // action=orders: thử lần lượt tới khi lấy được
    const limit = req.query.limit || 50;
    for (const c of candidates) {
      const q = c.method === 'GET' ? `?limit=${limit}&page=1&per_page=${limit}` : '';
      const url = `${root}${c.path}${q}`;
      const r = await tryFetch(url, key, c.method);
      if (r.ok) {
        const orders = extractOrders(r.json);
        if (orders) { res.status(200).json({ ok: true, endpoint: `${c.method} ${c.path}`, count: orders.length, data: orders }); return; }
      }
    }
    res.status(404).json({ error: 'Không tìm thấy endpoint đơn hàng phù hợp. Dùng action=probe để chẩn đoán, hoặc gửi tài liệu API Merchize.' });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}
