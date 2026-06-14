// Vercel Serverless — Etsy OAuth: KẾT NỐI SHOP để app được phép đọc đơn.
// Mỗi chủ shop tự bấm "Allow"; token lưu riêng theo shop vào Upstash Redis.
//
// CHẠY Ở VÙNG MỸ để request tới Etsy đi từ IP Mỹ (xem vercel.json bên dưới).
//
// Cấu hình trên Vercel (Environment Variables):
//   ETSY_KEYSTRING        = keystring (API key) của app Etsy
//   ETSY_REDIRECT_URI     = https://<ten-app>.vercel.app/api/etsy-auth?action=callback
//   UPSTASH_REDIS_REST_URL   = (Upstash cấp)
//   UPSTASH_REDIS_REST_TOKEN = (Upstash cấp)
//
// Các action (?action=):
//   start    → tạo link Etsy cho chủ shop bấm Allow (trả {url})
//   callback → Etsy gọi về sau khi Allow; đổi code lấy token, lưu vào Upstash
//   list     → liệt kê các shop đã kết nối (để app hiển thị)

import { verify } from './auth.js';
import crypto from 'crypto';

const ETSY_OAUTH = 'https://www.etsy.com/oauth/connect';
const ETSY_TOKEN = 'https://api.etsy.com/v3/public/oauth/token';
const ETSY_API = 'https://api.etsy.com/v3/application';
const SCOPES = 'transactions_r shops_r';

// ---- Upstash Redis REST helpers ----
async function redis(cmd) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const j = await r.json();
  return j.result;
}
const rGet = (k) => redis(['GET', k]);
const rSet = (k, v) => redis(['SET', k, v]);
const rSAdd = (k, v) => redis(['SADD', k, v]);
const rSMembers = (k) => redis(['SMEMBERS', k]);

// PKCE
function pkce() {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function cfg() {
  return {
    key: process.env.ETSY_KEYSTRING || '',
    secret: process.env.ETSY_SHARED_SECRET || '',
    redirect: process.env.ETSY_REDIRECT_URI || '',
  };
}
// Etsy yêu cầu x-api-key dạng "keystring:shared_secret" cho request đã xác thực
function apiKeyHeader() {
  const k = process.env.ETSY_KEYSTRING || '';
  const s = process.env.ETSY_SHARED_SECRET || '';
  return s ? `${k}:${s}` : k;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Session');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const action = req.query.action || 'start';
  const { key, redirect } = cfg();
  if (!key || !redirect) { res.status(400).json({ error: 'Chưa cấu hình ETSY_KEYSTRING / ETSY_REDIRECT_URI' }); return; }

  try {
    // ---- start: tạo link cho chủ shop bấm Allow ----
    if (action === 'start') {
      // bắt buộc đăng nhập app (chỉ người dùng app mới tạo được link kết nối)
      const session = verify(req.headers['x-session']);
      if (!session) { res.status(401).json({ error: 'Chưa đăng nhập' }); return; }

      const { verifier, challenge } = pkce();
      const state = crypto.randomBytes(16).toString('hex');
      // lưu tạm verifier theo state (hết hạn 10 phút)
      await redis(['SET', `etsy:pkce:${state}`, verifier, 'EX', 600]);

      const params = new URLSearchParams({
        response_type: 'code',
        client_id: key,
        redirect_uri: redirect,
        scope: SCOPES,
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });
      res.status(200).json({ ok: true, url: `${ETSY_OAUTH}?${params}` });
      return;
    }

    // ---- callback: Etsy gọi về sau khi chủ shop Allow ----
    if (action === 'callback') {
      const { code, state } = req.query;
      if (!code || !state) { res.status(400).send('Thiếu code/state'); return; }

      const verifier = await rGet(`etsy:pkce:${state}`);
      if (!verifier) { res.status(400).send('Phiên kết nối hết hạn, thử lại'); return; }

      // đổi code lấy token
      const tokenRes = await fetch(ETSY_TOKEN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: key,
          redirect_uri: redirect,
          code,
          code_verifier: verifier,
        }),
      });
      const tok = await tokenRes.json();
      if (!tok.access_token) { res.status(400).json({ error: 'Đổi token thất bại', detail: tok }); return; }

      // access_token có dạng "<user_id>.<...>"; user_id đứng trước dấu chấm
      const userId = String(tok.access_token).split('.')[0];

      // Lấy shop_id THẬT của user. Etsy v3: GET /users/{user_id}/shops
      // (lưu user_id KHÁC shop_id — không được dùng user_id thay shop_id)
      let shopId = null, shopName = '';
      try {
        const sr = await fetch(`${ETSY_API}/users/${userId}/shops`, {
          headers: { 'x-api-key': apiKeyHeader(), Authorization: `Bearer ${tok.access_token}` },
        });
        const sj = await sr.json();
        // Etsy có thể trả: {results:[{shop_id,...}]} hoặc trực tiếp {shop_id,...}
        let shop = null;
        if (Array.isArray(sj?.results) && sj.results.length) shop = sj.results[0];
        else if (sj && sj.shop_id) shop = sj;
        if (shop && shop.shop_id) { shopId = shop.shop_id; shopName = shop.shop_name || ''; }
      } catch (e) {}

      if (!shopId) {
        res.status(400).json({
          error: 'Không lấy được shop_id của tài khoản này. Tài khoản có thể chưa mở shop, hoặc thiếu scope shops_r.',
          user_id: userId,
        });
        return;
      }

      const record = {
        shop_id: shopId,
        shop_name: shopName,
        user_id: userId,
        access_token: tok.access_token,
        refresh_token: tok.refresh_token,
        obtained_at: Date.now(),
        expires_in: tok.expires_in,
      };
      await rSet(`etsy:shop:${shopId}`, JSON.stringify(record));
      await rSAdd('etsy:shops', String(shopId));

      // trang thông báo đơn giản, tự đóng
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(`<!doctype html><meta charset=utf-8>
        <body style="font-family:sans-serif;text-align:center;padding:40px">
        <h2>Đã kết nối shop ${shopName || shopId} </h2>
        <p>Bạn có thể đóng tab này và quay lại app.</p>
        <script>setTimeout(()=>window.close(),1500)</script></body>`);
      return;
    }

    // ---- list: danh sách shop đã kết nối ----
    if (action === 'list') {
      const session = verify(req.headers['x-session']);
      if (!session) { res.status(401).json({ error: 'Chưa đăng nhập' }); return; }
      const ids = (await rSMembers('etsy:shops')) || [];
      const shops = [];
      for (const id of ids) {
        const raw = await rGet(`etsy:shop:${id}`);
        if (raw) { const s = JSON.parse(raw); shops.push({ shop_id: s.shop_id, shop_name: s.shop_name, connected_at: s.obtained_at }); }
      }
      res.status(200).json({ ok: true, count: shops.length, shops });
      return;
    }

    // ---- remove: xoá 1 shop khỏi danh sách ----
    if (action === 'remove') {
      const session = verify(req.headers['x-session']);
      if (!session) { res.status(401).json({ error: 'Chưa đăng nhập' }); return; }
      const id = req.query.shop_id;
      if (!id) { res.status(400).json({ error: 'Thiếu shop_id' }); return; }
      await redis(['DEL', `etsy:shop:${id}`]);
      await redis(['SREM', 'etsy:shops', String(id)]);
      res.status(200).json({ ok: true, removed: id });
      return;
    }

    res.status(400).json({ error: 'action không hợp lệ' });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}
