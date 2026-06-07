// Vercel Serverless — NHẬN webhook đơn hàng từ Merchize
// Merchize tự gọi endpoint này mỗi khi có sự kiện đơn (tạo mới, cập nhật, thanh toán...).
//
// Cấu hình ở Merchize dashboard: Setting → Webhook → Add Webhook
//   Endpoint URL: https://<vercel-url>/api/webhooks/merchize
//   Chọn các sự kiện đơn hàng (order created, updated, paid...).
//
// Bảo mật: Merchize gửi header "merchize-webhook-key" = secret nguyên bản.
//   Đặt MERCHIZE_WEBHOOK_SECRET trên Vercel để app verify (so sánh timing-safe).
//
// Đơn nhận được sẽ lưu vào database chung (pod:orders) — cả team thấy ngay.

import crypto from 'crypto';
import { hasRedis, kvGet, kvSet } from '../_redis.js';

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ba, bb); } catch (e) { return false; }
}

// Chuẩn hoá 1 đơn Merchize về format app
function mapMerchizeOrder(o) {
  const g = (...keys) => { for (const k of keys) { const v = k.split('.').reduce((x, p) => x && x[p], o); if (v !== undefined && v !== null) return v; } return undefined; };
  const readable = g('code', 'order_number', 'number', 'name', 'reference');
  const techId = g('id', '_id');
  const id = String(readable || techId || ('MRZ-' + Math.random().toString(36).slice(2, 8)));
  const items = (g('items', 'line_items', 'order_items', 'products') || []).map(it => ({
    title: it.title || it.name || it.product_title || it.product_name || 'Sản phẩm',
    sku: it.sku || it.variant_sku || it.variant_id || (it.variant || ''),
    qty: it.quantity || it.qty || 1,
    price: '$' + (parseFloat(it.price || it.unit_price || 0)).toFixed(2),
    img: it.image || it.thumbnail || it.preview_url || it.image_url || '',
    personalization: it.personalization || (Array.isArray(it.attributes) ? it.attributes.map(a => `${a.name}: ${a.option}`).join(', ') : '') || '',
    supplier: 'Merchize', ptype: '— Chọn —', material: '— Chọn —', size: '— Chọn —',
    designer: '— Chưa gán —', fulfiller: 'Merchize', confirmed: false,
  }));
  const cust = g('customer.name', 'customer_name', 'shipping_address.name', 'buyer_name') ||
    [g('shipping_address.first_name'), g('shipping_address.last_name')].filter(Boolean).join(' ') || 'Unknown';
  return {
    id, orderNumber: String(readable || ''), external_id: String(g('external_number', 'external_id') || ''),
    account: 'Merchize', shopId: String(g('store_id', 'shop_id') || 'merchize'), shopTitle: g('store_name', 'shop_name') || 'Merchize',
    status: mapStatus(g('status', 'order_status', 'fulfillment_status')),
    created: g('created', 'created_at', 'order_date') || new Date().toISOString(),
    customer: cust,
    country: g('shipping_address.country', 'customer.country', 'country') || '—',
    email: g('customer.email', 'email', 'buyer_email') || '—',
    address: [g('shipping_address.address1', 'address.address1'), g('shipping_address.city'), g('shipping_address.country')].filter(Boolean).join(', '),
    total: '$' + (parseFloat(g('invoice.total', 'total', 'total_price', 'amount') || 0)).toFixed(2),
    items, urgent: false, note: '', pushed: { merchize: true, sellerwix: false, sheet: false }, source: 'merchize',
  };
}
function mapStatus(s) {
  const m = String(s || '').toLowerCase();
  if (m.includes('cancel')) return 'cancelled';
  if (m.includes('done') || m.includes('complete') || m.includes('fulfilled') || m.includes('delivered')) return 'done';
  if (m.includes('process') || m.includes('production') || m.includes('printing')) return 'processing';
  if (m.includes('pending') || m.includes('hold') || m.includes('review')) return 'pending';
  return 'new';
}

export default async function handler(req, res) {
  // GET = chẩn đoán: mở bằng trình duyệt để xem trạng thái
  if (req.method === 'GET') {
    let dbInfo = { configured: hasRedis(), orders: null };
    let lastPayload = null;
    if (hasRedis()) {
      try { const c = await kvGet('pod:orders'); dbInfo.orders = c && c.orders ? c.orders.length : 0; }
      catch (e) { dbInfo.error = e.message; }
      try { lastPayload = await kvGet('pod:last_webhook'); } catch (e) {}
    }
    res.status(200).json({
      ok: true,
      message: 'Webhook Merchize đang hoạt động. Dùng POST để gửi đơn.',
      database: dbInfo,
      secret_configured: !!process.env.MERCHIZE_WEBHOOK_SECRET,
      last_webhook: lastPayload,
    });
    return;
  }

  // Merchize chỉ cần nhận HTTP 200
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  // Verify secret (nếu đã cấu hình). Merchize gửi qua header "merchize-webhook-key".
  const secret = process.env.MERCHIZE_WEBHOOK_SECRET;
  if (secret) {
    const got = req.headers['merchize-webhook-key'] || req.headers['x-merchize-webhook-key'] || req.headers['x-webhook-secret'];
    if (!timingSafeEqual(got, secret)) {
      res.status(200).json({ ok: false, error: 'webhook key không khớp', hint: 'Kiểm tra MERCHIZE_WEBHOOK_SECRET trên Vercel = đúng Secret key của Merchize' });
      return;
    }
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }

  // GHI LẠI payload nhận được (để chẩn đoán: mở GET sẽ thấy Merchize gửi gì)
  if (hasRedis()) {
    try {
      await kvSet('pod:last_webhook', {
        at: new Date().toISOString(),
        headers_keys: Object.keys(req.headers || {}),
        body_type: typeof body,
        body_keys: body && typeof body === 'object' ? Object.keys(body) : null,
        body_sample: JSON.stringify(body).slice(0, 800),
      });
    } catch (e) {}
  }

  // Lấy (các) đơn từ payload — Merchize có thể gửi 1 đơn hoặc mảng, tuỳ event
  let rawOrders = [];
  if (body && body.data) rawOrders = Array.isArray(body.data) ? body.data : [body.data];
  else if (body && body.order) rawOrders = [body.order];
  else if (Array.isArray(body)) rawOrders = body;
  else if (body && body.id) rawOrders = [body]; // payload chính là đơn

  if (!rawOrders.length) { res.status(200).json({ ok: true, note: 'Không có đơn trong payload', received: true }); return; }

  if (!hasRedis()) {
    // Không có DB thì vẫn trả 200 để Merchize không retry, nhưng báo chưa lưu được
    res.status(200).json({ ok: true, note: 'Chưa cấu hình database — đơn không được lưu' });
    return;
  }

  try {
    const KEY = 'pod:orders';
    const current = (await kvGet(KEY)) || { orders: [] };
    const byId = {};
    current.orders.forEach((o, i) => { byId[o.id] = i; });

    let added = 0, updated = 0;
    for (const raw of rawOrders) {
      const mapped = mapMerchizeOrder(raw);
      if (byId[mapped.id] !== undefined) {
        // giữ chỉnh sửa nội bộ của đơn cũ (trạng thái, designer, note, lark...)
        const old = current.orders[byId[mapped.id]];
        current.orders[byId[mapped.id]] = {
          ...mapped,
          status: old.status, urgent: old.urgent, note: old.note, pushed: old.pushed,
          larkLink: old.larkLink, history: old.history || [],
          items: mapped.items.map((it, i) => old.items && old.items[i] ? { ...it, designer: old.items[i].designer, fulfiller: old.items[i].fulfiller, confirmed: old.items[i].confirmed, larkLink: old.items[i].larkLink } : it),
        };
        updated++;
      } else {
        mapped.history = [{ t: Date.now(), by: 'Merchize (webhook)', act: 'Đơn tự động nhận từ Merchize' }];
        current.orders.push(mapped);
        added++;
      }
    }
    current.updatedAt = Date.now();
    current.updatedBy = 'Merchize webhook';
    await kvSet(KEY, current);
    res.status(200).json({ ok: true, added, updated, total: current.orders.length });
  } catch (e) {
    // vẫn trả 200 tránh Merchize retry dồn dập; log lỗi
    res.status(200).json({ ok: false, error: e.message });
  }
}
