// Vercel Serverless — Theo dõi & xử lý lại webhook Merchize bị kẹt
//
// GET  /api/webhooks              → số liệu health: done/pending/processing/retry/error/stuck
// POST /api/webhooks              → Merchize gọi vào đây khi có đơn mới (nhận event, lưu vào queue)
// POST /api/webhooks?op=retry     → xử lý lại tối đa 20 event kẹt (cũ → mới)
// POST /api/webhooks?op=push      → (nội bộ) đánh dấu 1 event đã xử lý xong
//
// Dữ liệu lưu trên Upstash Redis (key: pod:webhooks)
// Mỗi event có dạng:
//   { id, receivedAt, status, payload, processedAt?, error?, retries? }
//   status: 'pending' | 'processing' | 'done' | 'retry' | 'error' | 'stuck'
//
// "Stuck" = pending/processing/retry nhưng receivedAt > 10 phút trước (chưa xong)

import { verify } from './auth.js';
import { hasRedis, kvGet, kvSet } from './_redis.js';

const KEY = 'pod:webhooks';
const STUCK_THRESHOLD_MS = 10 * 60 * 1000; // 10 phút
const RETRY_BATCH = 20;

// ── Helper: parse body an toàn ──
function parseBody(req) {
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  return body || {};
}

// ── Helper: đếm stats từ danh sách events ──
function calcStats(events) {
  const now = Date.now();
  let done = 0, pending = 0, processing = 0, retry = 0, error = 0, stuck = 0;
  for (const e of events) {
    if (e.status === 'done') { done++; continue; }
    if (e.status === 'error') { error++; continue; }
    // Kiểm tra kẹt: pending/processing/retry quá lâu chưa xong
    const age = now - (e.receivedAt || 0);
    const isStuck = age > STUCK_THRESHOLD_MS;
    if (e.status === 'pending')    { isStuck ? stuck++ : pending++; }
    else if (e.status === 'processing') { isStuck ? stuck++ : processing++; }
    else if (e.status === 'retry')      { isStuck ? stuck++ : retry++; }
    else { stuck++; } // status lạ → kẹt
  }
  return { done, pending, processing, retry, error, stuck };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Session');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  // ── POST không có op = Merchize gọi webhook vào (không cần session, nhưng cần secret) ──
  if (req.method === 'POST' && !req.query.op) {
    // Tuỳ chọn: xác thực bằng secret header từ Merchize
    // const secret = req.headers['x-merchize-secret'];
    // if (secret !== process.env.MERCHIZE_WEBHOOK_SECRET) { res.status(401).end(); return; }

    if (!hasRedis()) { res.status(200).json({ ok: true, note: 'no-db' }); return; }

    const body = parseBody(req);
    const store = (await kvGet(KEY)) || { events: [] };

    const event = {
      id: body.id || body.orderId || body.order_id || `wh_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
      receivedAt: Date.now(),
      status: 'pending',
      payload: body,
      retries: 0,
    };

    // Tránh trùng id
    const exists = store.events.findIndex(e => e.id === event.id);
    if (exists >= 0) {
      // Event đã có — nếu bị kẹt thì reset lại để xử lý
      const old = store.events[exists];
      const age = Date.now() - (old.receivedAt || 0);
      if (old.status !== 'done' && age > STUCK_THRESHOLD_MS) {
        store.events[exists] = { ...old, status: 'pending', receivedAt: Date.now(), retries: (old.retries || 0) + 1 };
      }
    } else {
      store.events.push(event);
    }

    // Giữ tối đa 5000 events gần nhất để tránh Redis quá to
    if (store.events.length > 5000) {
      store.events = store.events
        .sort((a, b) => (b.receivedAt || 0) - (a.receivedAt || 0))
        .slice(0, 5000);
    }

    await kvSet(KEY, store);
    res.status(200).json({ ok: true, id: event.id });
    return;
  }

  // ── Các route còn lại yêu cầu đăng nhập ──
  const session = verify(req.headers['x-session']);
  if (!session) { res.status(401).json({ error: 'Chưa đăng nhập' }); return; }

  if (!hasRedis()) {
    res.status(501).json({ error: 'Chưa cấu hình database (UPSTASH_REDIS_REST_URL/TOKEN)' });
    return;
  }

  try {
    // ════ GET /api/webhooks — số liệu health ════
    if (req.method === 'GET') {
      const store = (await kvGet(KEY)) || { events: [] };
      const stats = calcStats(store.events);
      res.status(200).json({
        ...stats,
        total: store.events.length,
        updatedAt: Date.now(),
      });
      return;
    }

    if (req.method === 'POST') {
      const op = req.query.op;
      const body = parseBody(req);
      const store = (await kvGet(KEY)) || { events: [] };

      // ════ POST ?op=retry — xử lý lại sự kiện kẹt ════
      if (op === 'retry') {
        const now = Date.now();
        const limit = Math.min(body.limit || RETRY_BATCH, RETRY_BATCH);

        // Lấy các event kẹt, sắp xếp cũ nhất trước
        const stuckIdx = store.events
          .map((e, i) => ({ e, i }))
          .filter(({ e }) => {
            if (e.status === 'done' || e.status === 'error') return false;
            const age = now - (e.receivedAt || 0);
            return age > STUCK_THRESHOLD_MS;
          })
          .sort((a, b) => (a.e.receivedAt || 0) - (b.e.receivedAt || 0))
          .slice(0, limit);

        const processed = stuckIdx.length;

        // Đánh dấu lại là 'pending' để hệ thống xử lý lại
        stuckIdx.forEach(({ i }) => {
          store.events[i] = {
            ...store.events[i],
            status: 'pending',
            receivedAt: now,          // reset thời gian để không bị kẹt ngay
            retries: (store.events[i].retries || 0) + 1,
            retriedAt: now,
          };
        });

        await kvSet(KEY, store);

        // Đếm còn lại sau khi retry
        const statsAfter = calcStats(store.events);

        res.status(200).json({
          ok: true,
          processed,
          remaining: statsAfter.stuck,
          stats: statsAfter,
        });
        return;
      }

      // ════ POST ?op=push — đánh dấu 1 event đã xử lý xong (gọi từ worker nội bộ) ════
      if (op === 'push') {
        const { id, success, errorMsg } = body;
        if (!id) { res.status(400).json({ error: 'Thiếu id' }); return; }

        const idx = store.events.findIndex(e => e.id === id);
        if (idx >= 0) {
          store.events[idx] = {
            ...store.events[idx],
            status: success ? 'done' : 'error',
            processedAt: Date.now(),
            error: errorMsg || null,
          };
          await kvSet(KEY, store);
        }

        res.status(200).json({ ok: true });
        return;
      }

      res.status(400).json({ error: 'op không hợp lệ' });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}
