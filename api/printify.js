// Vercel Serverless — Printify proxy ĐA TÀI KHOẢN
// Yêu cầu đăng nhập (header X-Session).
//
// Cấu hình token trên Vercel (Environment Variables), chọn 1 trong 2 cách:
//  (A) Nhiều tài khoản — biến PRINTIFY_TOKENS = JSON:
//      [{"name":"Shop Vợ","token":"eyJ..."},{"name":"Shop Em","token":"eyJ..."}]
//  (B) Một tài khoản — biến PRINTIFY_TOKEN = "eyJ..."
//
// Các action (query ?action=):
//   accounts   → trả về danh sách shop của TẤT CẢ token: [{account, shopId, title, token_idx}]
//   allorders  → gộp đơn từ TẤT CẢ shop của TẤT CẢ token (mỗi đơn gắn _account, _shopId)
//   (mặc định) → proxy 1 path Printify, dùng token đầu tiên hoặc theo ?token_idx=

import { verify } from './auth.js';

function getTokens() {
  // Ưu tiên nhiều token
  if (process.env.PRINTIFY_TOKENS) {
    try {
      const arr = JSON.parse(process.env.PRINTIFY_TOKENS);
      if (Array.isArray(arr) && arr.length) return arr.map((t, i) => ({ name: t.name || `Tài khoản ${i + 1}`, token: t.token }));
    } catch (e) {}
  }
  if (process.env.PRINTIFY_TOKEN) return [{ name: 'Tài khoản chính', token: process.env.PRINTIFY_TOKEN }];
  return [];
}

async function pfetch(token, path, query = {}) {
  const extra = Object.entries(query).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const sep = path.includes('?') ? '&' : '?';
  const url = `https://api.printify.com/v1${path}${extra ? sep + extra : ''}`;
  const r = await fetch(url, { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'POD-Manager/1.0' } });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch (e) { json = null; }
  return { ok: r.ok, status: r.status, json, text };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Session');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  // Đăng nhập
  const session = verify(req.headers['x-session']);
  if (!session) { res.status(401).json({ error: 'Chưa đăng nhập hoặc phiên hết hạn' }); return; }

  let tokens = getTokens();
  // Nếu chưa cấu hình server và là admin, cho phép token tạm qua header
  if (!tokens.length && session.role === 'admin') {
    const t = (req.headers.authorization || '').replace('Bearer ', '');
    if (t) tokens = [{ name: 'Tài khoản tạm', token: t }];
  }
  if (!tokens.length) { res.status(401).json({ error: 'Chưa cấu hình PRINTIFY_TOKEN(S) trên Vercel' }); return; }

  const action = req.query.action || '';

  try {
    // ── Liệt kê tất cả shop của tất cả token ──
    if (action === 'accounts') {
      const out = [];
      for (let i = 0; i < tokens.length; i++) {
        const r = await pfetch(tokens[i].token, '/shops.json');
        if (r.ok && Array.isArray(r.json)) {
          r.json.forEach(s => out.push({ account: tokens[i].name, token_idx: i, shopId: s.id, title: s.title, channel: s.sales_channel || '' }));
        } else {
          out.push({ account: tokens[i].name, token_idx: i, error: `Lỗi ${r.status}` });
        }
      }
      res.status(200).json({ accounts: out });
      return;
    }

    // ── Gộp đơn từ TẤT CẢ shop ──
    if (action === 'allorders') {
      const limit = req.query.limit || 50;
      const all = [];
      for (let i = 0; i < tokens.length; i++) {
        const sh = await pfetch(tokens[i].token, '/shops.json');
        if (!sh.ok || !Array.isArray(sh.json)) continue;
        for (const shop of sh.json) {
          const od = await pfetch(tokens[i].token, `/shops/${shop.id}/orders.json`, { limit });
          if (od.ok && od.json) {
            const list = od.json.data || (Array.isArray(od.json) ? od.json : []);
            list.forEach(o => { o._account = tokens[i].name; o._shopId = shop.id; o._shopTitle = shop.title; all.push(o); });
          }
        }
      }
      res.status(200).json({ data: all });
      return;
    }

    // ── Proxy thường (1 path) ──
    const idx = parseInt(req.query.token_idx || '0') || 0;
    const tk = (tokens[idx] || tokens[0]).token;
    const path = req.query.path || '/shops.json';
    const query = {};
    Object.entries(req.query).forEach(([k, v]) => { if (!['path', 'action', 'token_idx'].includes(k)) query[k] = v; });
    const r = await pfetch(tk, path, query);
    res.status(r.status).setHeader('Content-Type', 'application/json').send(r.text);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}
