// api/ingest.js — CỬA NHẬN ĐƠN TỪ CÁC TEAM THUÊ (đặt trên Vercel của APP TỔNG)
//
// Mỗi team gọi:  POST /api/ingest
//   Headers: { 'Content-Type': 'application/json', 'X-Team-Key': '<API key của team>' }
//   Body:    { orders: [ ...đơn đã map theo schema app tổng... ] }
//
// API này:
//   1) Kiểm tra X-Team-Key hợp lệ (so với INGEST_KEYS).
//   2) Gắn nhãn team vào mỗi đơn (ingestTeam) để đối soát.
//   3) Gộp vào key "pod:orders" — GIỮ field người dùng đã chỉnh, CHỐNG ghi rỗng.
//   4) Trả về { ok, team, added, updated, total }.
//
// QUAN TRỌNG: file này DÙNG LẠI kvGet/kvSet của app tổng (./_redis.js) để ghi đơn
// y hệt cách /api/data ghi → đảm bảo app tổng đọc lại đúng, không lệch định dạng.
//
// ─────────────── Environment Variables (trên Vercel của APP TỔNG) ───────────────
//   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN   ← đã có sẵn cho /api/data
//   INGEST_KEYS = team1:key_abc,team2:key_def,...       ← danh sách team:key
//
// THÊM/XOÁ TEAM: sửa INGEST_KEYS rồi redeploy. Xoá 1 team = xoá cặp team:key của họ.

import { hasRedis, kvGet, kvSet } from './_redis.js';

const ORDERS_KEY = 'pod:orders';

// ─────────── Đọc kho đơn hiện tại (giống /api/data) ───────────
async function getOrders() {
  const data = await kvGet(ORDERS_KEY);
  if (data && Array.isArray(data.orders)) return data;
  if (Array.isArray(data)) return { orders: data };
  return { orders: [] };
}

// ─────────── Quản lý API key theo team ───────────
// INGEST_KEYS = "team1:key_abc,team2:key_def"
function parseKeys() {
  const raw = process.env.INGEST_KEYS || '';
  const map = {}; // key -> team
  raw.split(',').map(s => s.trim()).filter(Boolean).forEach(pair => {
    const i = pair.indexOf(':');
    if (i > 0) {
      const team = pair.slice(0, i).trim();
      const key = pair.slice(i + 1).trim();
      if (team && key) map[key] = team;
    }
  });
  return map;
}
function teamForKey(key) {
  if (!key) return null;
  return parseKeys()[key] || null;
}

// ─────────── Gộp đơn — GIỮ chỉnh sửa người dùng (giống /api/data op=replace) ───────────
function mergeOrders(existingOrders, incoming, team) {
  const byId = {};
  existingOrders.forEach((o) => { byId[o.id] = o; });
  let added = 0, updated = 0;

  incoming.forEach((raw) => {
    if (!raw || !raw.id) return;            // bỏ đơn thiếu id
    const o = { ...raw, ingestTeam: team }; // gắn nhãn team
    const old = byId[o.id];
    if (old) {
      const oldItems = old.items || [];
      const newItems = o.items || [];
      // Bình thường GIỮ status cũ (không để đồng bộ đè trạng thái gán tay).
      // Ngoại lệ: đơn có cờ forceStatus (vd webhook "đã giao") → cho phép cập nhật status.
      const keepStatus = o.forceStatus ? o.status : old.status;
      const merged_o = {
        ...o,
        status: keepStatus,
        urgent: old.urgent, note: old.note, pushed: old.pushed,
        gdriveLink: old.gdriveLink || o.gdriveLink, larkLink: old.larkLink || o.larkLink,
        tracking: old.tracking || o.tracking,
        ingestTeam: old.ingestTeam || team,
        items: newItems.map((it, i) => oldItems[i] ? {
          ...it,
          supplier: oldItems[i].supplier, ptype: oldItems[i].ptype, material: oldItems[i].material,
          size: oldItems[i].size, designer: oldItems[i].designer, fulfiller: oldItems[i].fulfiller,
          confirmed: oldItems[i].confirmed,
        } : it),
      };
      delete merged_o.forceStatus; // không lưu cờ tạm vào DB
      byId[o.id] = merged_o;
      updated++;
    } else {
      delete o.forceStatus;
      byId[o.id] = o;
      added++;
    }
  });

  return { orders: Object.values(byId), added, updated };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Team-Key');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Chỉ nhận POST' }); return; }

  // 1) Xác thực team
  const key = req.headers['x-team-key'] || '';
  const team = teamForKey(key);
  if (!team) { res.status(401).json({ error: 'API key không hợp lệ' }); return; }

  // 2) DB sẵn sàng?
  if (!hasRedis()) { res.status(501).json({ error: 'Chưa cấu hình database (UPSTASH_REDIS_REST_URL/TOKEN)' }); return; }

  // 3) Đọc body
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const incoming = (body && body.orders) || [];
  if (!Array.isArray(incoming)) { res.status(400).json({ error: 'Thiếu mảng orders' }); return; }

  // 4) CHỐNG ghi rỗng
  if (incoming.length === 0) {
    res.status(200).json({ ok: true, team, added: 0, updated: 0, note: 'orders rỗng — bỏ qua' });
    return;
  }

  // 5) Giới hạn an toàn
  if (incoming.length > 5000) {
    res.status(413).json({ error: 'Quá nhiều đơn trong 1 lần (tối đa 5000)' });
    return;
  }

  try {
    const current = await getOrders();
    const before = current.orders.length;
    const { orders, added, updated } = mergeOrders(current.orders, incoming, team);
    const out = { ...current, orders, updatedAt: Date.now(), updatedBy: `ingest:${team}` };
    await kvSet(ORDERS_KEY, out);

    res.status(200).json({
      ok: true, team,
      received: incoming.length, added, updated,
      total_before: before, total_after: orders.length,
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}
