// Vercel Serverless — Theo dõi tổng SALES các shop Etsy (scrape HTML trang shop)
// Khớp kiểu project: handler(req,res) + auth.js (X-Session) + _redis.js (kvGet/kvSet).
//
// Các action (?action=):
//   shops  (GET)  → lấy danh sách shop + lịch sử
//   save   (POST) → lưu danh sách shop, body: { shops: [{name,url,active}] }
//   run    (GET)  → quét sales tất cả shop active, ghi lịch sử (dùng cho nút bấm & cron)
//
// Cron (Vercel) tự gửi header Authorization: Bearer <CRON_SECRET> → cho phép chạy action=run
// mà không cần đăng nhập. Nút bấm trên web thì dùng X-Session như các API khác.

import { verify } from './auth.js';
import { kvGet, kvSet } from './_redis.js';

// ===== Redis keys =====
const K_SHOPS = 'etsysales:shops';      // mảng [{name,url,active}]
const K_STATE = 'etsysales:state';      // { [shopName]: lastTotalSales }
const K_HISTORY = 'etsysales:history';  // mảng các row, mới nhất đứng đầu

const MAX_HISTORY = 500; // giới hạn số dòng lịch sử lưu lại

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36',
];

// ===== Helpers =====
function toDateOnly(d = new Date()) {
  // Timezone Detroit cho khớp các tính toán khác của bạn
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Detroit',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d); // yyyy-mm-dd
}

function normalizeShopName(s) {
  return String(s || '').trim();
}

function isValidEtsyShopUrl(url) {
  if (!url) return false;
  return /^https:\/\/(www\.)?etsy\.com\/shop\/[A-Za-z0-9_-]+/i.test(String(url).trim());
}

function extractTotalSalesFromHtml(html) {
  // "594 sales" / "1,234 Sales"
  let m = html.match(/([0-9]{1,3}(?:,[0-9]{3})*|[0-9]+)\s+sales\b/i);
  if (m) return parseInt(m[1].replace(/,/g, ''), 10);
  // JSON "transaction_sold_count":1234
  m = html.match(/"transaction_sold_count"\s*:\s*([0-9]+)/i);
  if (m) return parseInt(m[1], 10);
  // JSON "salesCount":1234
  m = html.match(/"salesCount"\s*:\s*([0-9]+)/i);
  if (m) return parseInt(m[1], 10);
  return null;
}

async function fetchEtsyTotalSales(shopUrl, retries = 2) {
  if (!shopUrl) return null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ua = USER_AGENTS[attempt % USER_AGENTS.length];
    try {
      const r = await fetch(shopUrl, {
        redirect: 'follow',
        headers: {
          'User-Agent': ua,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      if (!r.ok) {
        if ((r.status === 403 || r.status === 429) && attempt < retries) {
          await new Promise((res) => setTimeout(res, 800 * (attempt + 1)));
          continue;
        }
        return null;
      }
      const html = await r.text();
      const total = extractTotalSalesFromHtml(html);
      if (total !== null) return total;
    } catch (e) {
      // retry
    }
    if (attempt < retries) await new Promise((res) => setTimeout(res, 500));
  }
  return null;
}

// ===== Lưu/đọc dữ liệu =====
async function getShops() {
  const v = await kvGet(K_SHOPS);
  return Array.isArray(v) ? v : [];
}

async function saveShops(shops) {
  const clean = (shops || [])
    .map((s) => ({
      name: normalizeShopName(s.name),
      url: String(s.url || '').trim(),
      active: s.active !== false,
    }))
    .filter((s) => s.name && isValidEtsyShopUrl(s.url));
  await kvSet(K_SHOPS, clean);
  return clean;
}

async function getHistory() {
  const v = await kvGet(K_HISTORY);
  return Array.isArray(v) ? v : [];
}

// ===== Chạy quét sales =====
async function runDailySales() {
  const shops = await getShops();
  if (!shops.length) {
    return { ok: false, message: 'Chưa có shop nào. Thêm shop rồi Lưu trước.', logged: 0 };
  }

  const dateOnly = toDateOnly();
  const state = (await kvGet(K_STATE)) || {};
  const history = await getHistory();
  const newRows = [];

  for (const shop of shops) {
    const shopName = normalizeShopName(shop.name);
    const shopUrl = String(shop.url || '').trim();
    if (!shopName || shop.active === false || !isValidEtsyShopUrl(shopUrl)) continue;

    const total = await fetchEtsyTotalSales(shopUrl);
    if (total === null) continue; // bỏ qua nếu không lấy được (có thể bị Etsy chặn)

    const lastTotal = Number(state[shopName]) || 0;
    const ordersToday = Math.max(0, total - lastTotal);

    newRows.push({
      dateOnly,
      shopName,
      ordersToday,
      totalSales: total,
      shopUrl,
      ts: Date.now(),
    });
    state[shopName] = total;
  }

  if (newRows.length) {
    // Mới nhất lên đầu, cắt bớt cho khỏi phình
    const merged = [...newRows, ...history].slice(0, MAX_HISTORY);
    await kvSet(K_HISTORY, merged);
    await kvSet(K_STATE, state);
  }

  return {
    ok: true,
    message: `Đã ghi ${newRows.length} dòng cho ngày ${dateOnly}`,
    logged: newRows.length,
    date: dateOnly,
    rows: newRows,
  };
}

// ===== Handler chính =====
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Session');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const action = req.query.action || 'shops';

  // Cron của Vercel gọi action=run với Authorization: Bearer <CRON_SECRET>
  const authHeader = req.headers['authorization'] || '';
  const isCron = !!process.env.CRON_SECRET && authHeader === `Bearer ${process.env.CRON_SECRET}`;

  // Mọi action khác (và run khi bấm tay) đều cần đăng nhập như các API khác
  const session = verify(req.headers['x-session']);

  if (action === 'run' && isCron) {
    try {
      const result = await runDailySales();
      res.status(200).json(result);
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
    return;
  }

  if (!session) { res.status(401).json({ error: 'Chưa đăng nhập' }); return; }

  try {
    if (action === 'shops') {
      const [shops, history] = await Promise.all([getShops(), getHistory()]);
      res.status(200).json({ ok: true, shops, history });
      return;
    }
    if (action === 'save') {
      const shops = (req.body && req.body.shops) || [];
      const saved = await saveShops(shops);
      res.status(200).json({ ok: true, shops: saved });
      return;
    }
    if (action === 'run') {
      const result = await runDailySales();
      res.status(200).json(result);
      return;
    }
    res.status(400).json({ error: 'action không hợp lệ (shops | save | run)' });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
}
