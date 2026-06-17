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

  // ── CẤU HÌNH CHUNG (skuMap...) — GET+POST không cần auth chặt (chỉ skuMap, không nhạy cảm) ──
  if (req.query.op === 'config') {
    if (!hasRedis()) { res.status(200).json({ error: 'no-db' }); return; }
    if (req.method === 'GET') {
      try { const cfg = await kvGet('pod:config'); res.status(200).json(cfg || {}); }
      catch (e) { res.status(200).json({ error: e.message }); }
      return;
    }
    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
      try {
        // MERGE thông minh: gộp với config hiện tại để tránh mất dữ liệu khi nhiều người lưu cùng lúc
        const existing = (await kvGet('pod:config')) || {};
        const merged = { ...existing, ...body };
        // Với các mảng có id (ideas) → gộp theo id, không ghi đè mất phần tử của người khác
        if (Array.isArray(body.ideas) && Array.isArray(existing.ideas)) {
          const map = {};
          existing.ideas.forEach(it => { if (it && it.id) map[it.id] = it; });
          // áp dụng thay đổi từ body (thêm mới / cập nhật)
          body.ideas.forEach(it => { if (it && it.id) map[it.id] = it; });
          // các id bị xoá: chỉ xoá nếu body cố ý gửi danh sách đầy đủ (có cờ _fullIdeas)
          if (body._fullIdeas) {
            const keepIds = new Set(body.ideas.map(it => it && it.id).filter(Boolean));
            Object.keys(map).forEach(id => { if (!keepIds.has(id)) delete map[id]; });
          }
          merged.ideas = Object.values(map);
        }
        // designLog + notifs → gộp (nối thêm, khử trùng theo nội dung+thời gian), giữ tối đa
        const mergeLog = (a, b, cap) => {
          const seen = new Set(); const out = [];
          [...(b || []), ...(a || [])].forEach(x => {
            const k = JSON.stringify([x.ideaId || x.orderId || '', x.at || '', x.text || x.col || '']);
            if (!seen.has(k)) { seen.add(k); out.push(x); }
          });
          return out.slice(0, cap);
        };
        if (Array.isArray(body.designLog)) merged.designLog = mergeLog(existing.designLog, body.designLog, 1000);
        if (Array.isArray(body.notifs)) merged.notifs = mergeLog(existing.notifs, body.notifs, 100);
        delete merged._fullIdeas;
        await kvSet('pod:config', merged);
        res.status(200).json({ ok: true });
      }
      catch (e) { res.status(200).json({ ok: false, error: e.message }); }
      return;
    }
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
        // AN TOÀN: nếu client gửi rỗng nhưng DB đang có đơn → KHÔNG ghi đè (tránh mất sạch dữ liệu)
        if (incoming.length === 0 && current.orders.length > 0) {
          res.status(200).json({ ok: true, skipped: 'empty-payload-protected', count: current.orders.length });
          return;
        }
        const byId = {};
        current.orders.forEach(o => { byId[o.id] = o; });
        const incomingIds = new Set(incoming.map(o => o.id));
        const merged = incoming.map(o => {
          const old = byId[o.id];
          if (old) {
            const oldItems = old.items || [];
            const newItems = o.items || [];
            // giữ lại các field do người dùng chỉnh (trạng thái, designer, note, pushed...)
            return { ...o, status: old.status, urgent: old.urgent, note: old.note, pushed: old.pushed,
              gdriveLink: old.gdriveLink || o.gdriveLink, larkLink: old.larkLink || o.larkLink,
              ingestTeam: old.ingestTeam || o.ingestTeam,
              items: newItems.map((it, i) => oldItems[i] ? { ...it,
                supplier: oldItems[i].supplier, ptype: oldItems[i].ptype, material: oldItems[i].material,
                size: oldItems[i].size, designer: oldItems[i].designer, fulfiller: oldItems[i].fulfiller,
                confirmed: oldItems[i].confirmed } : it) };
          }
          return o;
        });
        // BẢO TOÀN đơn do hệ thống tự kéo về (ingest/Etsy) mà trình duyệt KHÔNG gửi lên.
        // Trình duyệt của user chỉ giữ danh sách đơn nó từng thấy; nếu nó lưu đè, các đơn
        // Etsy mới ingest (chưa có trên máy user) sẽ bị mất. Giữ lại chúng ở đây.
        current.orders.forEach(o => {
          if (!incomingIds.has(o.id) && (o.ingestTeam || o.source === 'etsy')) {
            merged.push(o);
          }
        });
        current.orders = merged;
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
