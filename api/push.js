// Vercel Serverless Function — Đẩy đơn sang xưởng
// Chỉ ADMIN được đẩy. Gọi POST /api/push với header X-Session.

import { verify } from './auth.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Session');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Chỉ chấp nhận POST' }); return; }

  // Kiểm tra đăng nhập + quyền admin
  const session = verify(req.headers['x-session']);
  if (!session) { res.status(401).json({ error: 'Chưa đăng nhập' }); return; }
  if (session.role !== 'admin') { res.status(403).json({ error: 'Chỉ Admin được đẩy xưởng' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch(e) { body = {}; } }
  const { target, payload, creds = {} } = body || {};

  try {
    let url, opts;

    if (target === 'merchize') {
      const key = process.env.MERCHIZE_KEY || creds.key;
      url = 'https://api.merchize.com/v1/orders';
      opts = { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': key }, body: JSON.stringify(payload) };

    } else if (target === 'sellerwix') {
      const key = process.env.SELLERWIX_KEY || creds.key;
      url = 'https://api.sellerwix.com/api/v1/orders';
      opts = { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` }, body: JSON.stringify(payload) };

    } else if (target === 'sheet') {
      const sheetId = creds.sheetId;
      const sheetToken = creds.sheetToken;
      url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Sheet1!A1:append?valueInputOption=USER_ENTERED`;
      opts = { method: 'POST', headers: { 'Authorization': `Bearer ${sheetToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ values: [payload] }) };

    } else {
      res.status(400).json({ error: 'target không hợp lệ' });
      return;
    }

    const r = await fetch(url, opts);
    const text = await r.text();
    res.status(r.status).setHeader('Content-Type', 'application/json').send(text);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}
