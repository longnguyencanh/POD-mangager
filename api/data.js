// Vercel Serverless — Lưu/đọc dữ liệu đơn DÙNG CHUNG cho cả team
// GET  /api/data           → đọc toàn bộ đơn đã lưu (kèm metadata sửa đổi)
// POST /api/data           → ghi đè toàn bộ danh sách đơn (body: {orders})
// POST /api/data?op=patch  → cập nhật 1 đơn (body: {order})
//
// Dữ liệu lưu trên Upstash Redis (key: pod:orders). Cả team thấy giống nhau.

import { verify } from './auth.js';
import { hasRedis, kvGet, kvSet } from './_redis.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Session');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  // ── CẤU HÌNH CHUNG (skuMap...) — cho phép GET không cần auth chặt (chỉ đọc, không nhạy cảm) ──
  if (req.query.op === 'config' && req.method === 'GET') {
    if (!hasRedis()) { res.status(200).json({ error: 'no-db' }); return; }
    try { const cfg = await kvGet('pod:config'); res.status(200).json(cfg || {}); }
    catch (e) { res.status(200).json({ error: e.message }); }
    return;
  }

  const session = verify(req.headers['x-session']);
  if (!session) { res.status(401).json({ error: 'Chưa đăng nhập' }); return; }

  if (!hasRedis()) {
    res.status(501).json({ error: 'Chưa cấu hình database (UPSTASH_REDIS_REST_URL/TOKEN)' });
    return;
  }

  const KEY = 'pod:orders';
  const CFG_KEY = 'pod:config';

  try {
    // ── CẤU HÌNH CHUNG (skuMap, v.v.) — dùng chung cả team ──
    if (req.query.op === 'config') {
      if (req.method === 'GET') {
        const cfg = await kvGet(CFG_KEY);
        res.status(200).json(cfg || {});
        return;
      }
      if (req.method === 'POST') {
        let body = req.body;
        if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
        await kvSet(CFG_KEY, body || {});
        res.status(200).json({ ok: true });
        return;
      }
    }

    if (req.method === 'GET') {
      const data = await kvGet(KEY);
      res.status(200).json(data || { orders: [], updatedAt: null, updatedBy: null });
      return;
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
      const op = req.query.op || 'replace';

      const current = (await kvGet(KEY)) || { orders: [] };

      if (op === 'patch') {
        // Cập nhật 1 đơn theo id (giữ các đơn khác nguyên vẹn)
        const o = body.order;
        if (!o || !o.id) { res.status(400).json({ error: 'Thiếu order.id' }); return; }
        const idx = current.orders.findIndex(x => x.id === o.id);
        if (idx >= 0) current.orders[idx] = o; else current.orders.push(o);
      } else if (op === 'delete') {
        const id = body.id;
        current.orders = current.orders.filter(x => x.id !== id);
      } else {
        // replace toàn bộ — nhưng GIỮ chỉnh sửa nội bộ nếu đơn đã tồn tại
        const incoming = body.orders || [];
        const byId = {};
        current.orders.forEach(o => { byId[o.id] = o; });
        current.orders = incoming.map(o => {
          const old = byId[o.id];
          if (old) {
            // giữ lại các field do người dùng chỉnh (trạng thái, designer, note, pushed...)
            return { ...o, status: old.status, urgent: old.urgent, note: old.note, pushed: old.pushed,
              items: o.items.map((it, i) => old.items && old.items[i] ? { ...it,
                supplier: old.items[i].supplier, ptype: old.items[i].ptype, material: old.items[i].material,
                size: old.items[i].size, designer: old.items[i].designer, fulfiller: old.items[i].fulfiller,
                confirmed: old.items[i].confirmed } : it) };
          }
          return o;
        });
      }

      current.updatedAt = Date.now();
      current.updatedBy = session.name || session.user;
      await kvSet(KEY, current);
      res.status(200).json({ ok: true, count: current.orders.length, updatedAt: current.updatedAt, updatedBy: current.updatedBy });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}
