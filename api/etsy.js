// Vercel Serverless — Etsy proxy: KÉO ĐƠN TỪ ETSY về app.
// Dùng token đã lưu trong Upstash (do etsy-auth.js tạo); tự refresh khi hết hạn.
// Trả về format { ok, count, data } giống merchize.js để index tái dùng.
//
// CHẠY Ở VÙNG MỸ (xem vercel.json) → request tới Etsy đi từ IP Mỹ.
//
// Cấu hình trên Vercel (Environment Variables): giống etsy-auth.js
//   ETSY_KEYSTRING, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
//
// Các action (?action=):
//   orders  → lấy đơn của 1 shop:  ?action=orders&shop_id=123&limit=50
//   summary → tổng doanh thu gộp của 1 shop trong các đơn lấy được

import { verify } from './auth.js';

const ETSY_TOKEN = 'https://api.etsy.com/v3/public/oauth/token';
const ETSY_API = 'https://api.etsy.com/v3/application';

async function redis(cmd) {
  const r = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  return (await r.json()).result;
}
const rGet = (k) => redis(['GET', k]);
const rSet = (k, v) => redis(['SET', k, v]);

const KEY = () => process.env.ETSY_KEYSTRING || '';

// Lấy record shop; nếu token sắp hết hạn thì refresh và lưu lại
async function getValidToken(shopId) {
  const raw = await rGet(`etsy:shop:${shopId}`);
  if (!raw) return null;
  const rec = JSON.parse(raw);
  const ageMs = Date.now() - (rec.obtained_at || 0);
  const lifeMs = ((rec.expires_in || 3600) - 120) * 1000; // refresh sớm 2 phút
  if (ageMs < lifeMs) return rec;

  // refresh
  const r = await fetch(ETSY_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: KEY(),
      refresh_token: rec.refresh_token,
    }),
  });
  const t = await r.json();
  if (!t.access_token) return rec; // refresh fail → trả cái cũ, để caller xử lý lỗi
  rec.access_token = t.access_token;
  if (t.refresh_token) rec.refresh_token = t.refresh_token;
  rec.obtained_at = Date.now();
  rec.expires_in = t.expires_in;
  await rSet(`etsy:shop:${shopId}`, JSON.stringify(rec));
  return rec;
}

function money(m) {
  if (!m) return 0;
  return (m.amount || 0) / (m.divisor || 1);
}

// Chuẩn hoá 1 receipt Etsy → đơn hàng theo khuôn app dùng
function mapReceipt(r, shopId) {
  return {
    source: 'etsy',
    shop_id: shopId,
    order_id: r.receipt_id,
    external_number: String(r.receipt_id),
    status: r.status,
    buyer: r.name,
    date: r.created_timestamp ? new Date(r.created_timestamp * 1000).toISOString() : null,
    grandtotal: money(r.grandtotal),
    subtotal: money(r.subtotal),
    shipping: money(r.total_shipping_cost),
    tax: money(r.total_tax_cost),
    currency: r.grandtotal?.currency_code || 'USD',
    items: (r.transactions || []).map(t => ({
      title: t.title,
      quantity: t.quantity,
      price: money(t.price),
      sku: t.sku || '',
    })),
  };
}

async function fetchAllReceipts(shopId, token, limit) {
  const out = [];
  let offset = 0;
  const pageSize = Math.min(limit || 50, 100);
  while (out.length < (limit || 50)) {
    const url = `${ETSY_API}/shops/${shopId}/receipts?limit=${pageSize}&offset=${offset}`;
    const r = await fetch(url, { headers: { 'x-api-key': KEY(), Authorization: `Bearer ${token}` } });
    if (!r.ok) { const text = await r.text(); throw new Error(`Etsy ${r.status}: ${text.slice(0, 160)}`); }
    const j = await r.json();
    const batch = j.results || [];
    out.push(...batch);
    const total = j.count || 0;
    offset += pageSize;
    if (offset >= total || batch.length === 0) break;
    await new Promise(s => setTimeout(s, 250)); // tôn trọng rate limit
  }
  return out.slice(0, limit || 50);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Session');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const session = verify(req.headers['x-session']);
  if (!session) { res.status(401).json({ error: 'Chưa đăng nhập' }); return; }
  if (!KEY()) { res.status(400).json({ error: 'Chưa cấu hình ETSY_KEYSTRING' }); return; }

  const action = req.query.action || 'orders';
  const shopId = req.query.shop_id;
  if (!shopId) { res.status(400).json({ error: 'Thiếu shop_id. Kết nối shop trước qua /api/etsy-auth' }); return; }

  try {
    const rec = await getValidToken(shopId);
    if (!rec) { res.status(404).json({ error: `Shop ${shopId} chưa kết nối` }); return; }

    const limit = parseInt(req.query.limit || '50', 10);
    const receipts = await fetchAllReceipts(shopId, rec.access_token, limit);
    const orders = receipts.map(r => mapReceipt(r, shopId));

    if (action === 'summary') {
      const sum = orders.reduce((a, o) => {
        a.gross += o.grandtotal; a.shipping += o.shipping; a.tax += o.tax; return a;
      }, { gross: 0, shipping: 0, tax: 0 });
      res.status(200).json({
        ok: true, shop_id: shopId, order_count: orders.length,
        gross_revenue: +sum.gross.toFixed(2), total_shipping: +sum.shipping.toFixed(2),
        total_tax: +sum.tax.toFixed(2), currency: orders[0]?.currency || 'USD',
      });
      return;
    }

    res.status(200).json({ ok: true, shop_id: shopId, count: orders.length, data: orders });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}
