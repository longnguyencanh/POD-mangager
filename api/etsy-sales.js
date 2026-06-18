// Vercel Serverless — Theo doi SALES nhieu shop Etsy.
// Du lieu duoc Google Apps Script SCRAPE (khong bi Etsy chan) roi DAY sang day qua action=ingest.
// Tool chi luu + hien thi. Khong scrape o phia Vercel.
//
// Cau truc luu: ma tran ngay x shop.
//   K_MATRIX = { shops:[ten shop...], rows:{ 'YYYY-MM-DD': { [shop]: soDon } } }
//
// Cac action (?action=):
//   data    (GET)         -> tra ve toan bo ma tran (ngay x shop) + danh sach shop
//   ingest  (POST)        -> Apps Script day du lieu 1 ngay sang. Body:
//                            { date:'YYYY-MM-DD', shops:{NEOPAWS:110, GOGMERCH:0, ...} }
//                            hoac { date, rows:[{shop, orders}] }
//                            Xac thuc bang ?key=<INGEST_KEY> (bien moi truong tren Vercel)
//   clear   (POST)        -> xoa het du lieu (can dang nhap)

import { verify } from './auth.js';
import { kvGet, kvSet } from './_redis.js';

const K_MATRIX = 'etsysales:matrix';

function emptyMatrix() { return { shops: [], rows: {} }; }
async function getMatrix() {
  const v = await kvGet(K_MATRIX);
  if (!v || typeof v !== 'object') return emptyMatrix();
  return { shops: Array.isArray(v.shops) ? v.shops : [], rows: (v.rows && typeof v.rows === 'object') ? v.rows : {} };
}

function normalizeDate(d) {
  const s = String(d || '').trim();
  // chap nhan YYYY-MM-DD
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  // chap nhan DD/MM/YYYY -> doi sang YYYY-MM-DD
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) {
    const dd = m[1].padStart(2, '0'), mm = m[2].padStart(2, '0');
    return m[3] + '-' + mm + '-' + dd;
  }
  return s;
}

// Nhan du lieu 1 ngay tu Apps Script
async function ingest(body) {
  const date = normalizeDate(body && body.date);
  if (!date) return { ok: false, message: 'Thieu hoac sai dinh dang date (can YYYY-MM-DD).' };

  // chuan hoa input: shops object hoac rows array
  let dayData = {};
  if (body.shops && typeof body.shops === 'object' && !Array.isArray(body.shops)) {
    dayData = body.shops;
  } else if (Array.isArray(body.rows)) {
    body.rows.forEach((r) => {
      const name = String(r.shop || r.name || '').trim();
      if (name) dayData[name] = Number(r.orders ?? r.value ?? 0) || 0;
    });
  } else {
    return { ok: false, message: 'Thieu du lieu shops/rows.' };
  }

  const matrix = await getMatrix();
  const shopSet = new Set(matrix.shops);
  Object.keys(dayData).forEach((name) => {
    const n = String(name).trim();
    if (n) shopSet.add(n);
  });
  matrix.shops = [...shopSet];

  // ghi de du lieu ngay do (idempotent — day lai cung ngay se cap nhat)
  const clean = {};
  Object.entries(dayData).forEach(([name, v]) => {
    const n = String(name).trim();
    if (n) clean[n] = Number(v) || 0;
  });
  matrix.rows[date] = clean;

  await kvSet(K_MATRIX, matrix);
  const dayCount = Object.keys(matrix.rows).length;
  return { ok: true, message: 'Da nhan du lieu ngay ' + date + ' (' + Object.keys(clean).length + ' shop). Tong so ngay: ' + dayCount + '.', date, shops: Object.keys(clean).length, days: dayCount };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Session');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const action = req.query.action || 'data';

  // ingest: xac thuc bang INGEST_KEY (cho Apps Script goi, khong can dang nhap)
  if (action === 'ingest') {
    const key = process.env.INGEST_KEY || '';
    const provided = req.query.key || req.headers['x-ingest-key'] || '';
    if (!key || provided !== key) {
      res.status(401).json({ ok: false, message: 'Sai hoac thieu INGEST_KEY' });
      return;
    }
    try {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
      res.status(200).json(await ingest(body || {}));
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
    return;
  }

  // Cac action con lai can dang nhap
  const session = verify(req.headers['x-session']);
  if (!session) { res.status(401).json({ error: 'Chua dang nhap' }); return; }

  try {
    if (action === 'data') {
      const matrix = await getMatrix();
      res.status(200).json({ ok: true, shops: matrix.shops, rows: matrix.rows });
      return;
    }
    if (action === 'clear') {
      await kvSet(K_MATRIX, emptyMatrix());
      res.status(200).json({ ok: true, message: 'Da xoa het du lieu.' });
      return;
    }
    res.status(400).json({ error: 'action khong hop le (data | ingest | clear)' });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
}
