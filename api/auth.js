// Vercel Serverless — Đăng nhập, phân quyền & QUẢN LÝ TÀI KHOẢN
// Tài khoản lưu trong database (Upstash, key "pod:users"), mật khẩu được HASH (không lưu chữ thường).
// Lần đầu chạy: tự tạo admin mặc định = ADMIN_DEFAULT_USER / ADMIN_DEFAULT_PASS (mặc định admin/abc13579).
//
// Các action (POST, body.action):
//   login                          → {user, pass} → trả {token, role, name, user}
//   change_pass                    → {oldPass, newPass} (cần đăng nhập)  → tự đổi pass của mình
//   admin_list                     → (admin) liệt kê user
//   admin_add  {user,pass,role,name}  → (admin) thêm user
//   admin_reset {user, newPass}    → (admin) reset pass user
//   admin_del  {user}              → (admin) xoá user
//
// Nếu CHƯA cấu hình database: chạy chế độ tạm bằng USERS_JSON (chỉ login, không đổi pass được).

import crypto from 'crypto';
import { hasRedis, kvGet, kvSet } from './_redis.js';

const SECRET = process.env.AUTH_SECRET || 'CHANGE_ME_SECRET_KEY';
const UKEY = 'pod:users';

// ── hash mật khẩu (PBKDF2, có salt) ──
function hashPass(pass, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(pass, salt, 100000, 32, 'sha256').toString('hex');
  return `${salt}:${hash}`;
}
function verifyPass(pass, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt] = stored.split(':');
  return hashPass(pass, salt) === stored;
}

// ── session token (ký HMAC) ──
function sign(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}
export function verify(token) {
  if (!token) return null;
  const [data, sig] = token.split('.');
  if (!data || !sig) return null;
  const expect = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
  if (sig !== expect) return null;
  try {
    const p = JSON.parse(Buffer.from(data, 'base64url').toString());
    if (p.exp && Date.now() > p.exp) return null;
    return p;
  } catch (e) { return null; }
}

// ── đọc/khởi tạo danh sách user ──
async function loadUsers() {
  if (!hasRedis()) return null; // không có DB → fallback USERS_JSON
  let users = await kvGet(UKEY);
  if (!users || !Array.isArray(users) || !users.length) {
    // Tạo admin mặc định lần đầu
    const u = process.env.ADMIN_DEFAULT_USER || 'admin';
    const p = process.env.ADMIN_DEFAULT_PASS || 'abc13579';
    users = [{ user: u, pass: hashPass(p), role: 'admin', name: 'Long Nguyên' }];
    await kvSet(UKEY, users);
  }
  return users;
}
async function saveUsers(users) { await kvSet(UKEY, users); }

function publicUser(u) { return { user: u.user, role: u.role, name: u.name }; }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Session');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const action = body.action || 'login';

  try {
    const users = await loadUsers();

    // ── LOGIN ──
    if (action === 'login') {
      const { user, pass } = body;
      if (users) {
        const found = users.find(u => u.user === user);
        if (!found || !verifyPass(pass, found.pass)) { res.status(401).json({ error: 'Sai tài khoản hoặc mật khẩu' }); return; }
        const exp = Date.now() + 30 * 24 * 3600 * 1000;
        res.status(200).json({ token: sign({ user: found.user, role: found.role, name: found.name, exp }), ...publicUser(found) });
        return;
      }
      // Fallback USERS_JSON (chưa có DB) — pass dạng chữ thường
      let list = [];
      try { list = JSON.parse(process.env.USERS_JSON || '[]'); } catch (e) {}
      if (!list.length) list = [{ user: 'admin', pass: 'abc13579', role: 'admin', name: 'Long Nguyên' }];
      const f = list.find(u => u.user === user && u.pass === pass);
      if (!f) { res.status(401).json({ error: 'Sai tài khoản hoặc mật khẩu' }); return; }
      const exp = Date.now() + 30 * 24 * 3600 * 1000;
      res.status(200).json({ token: sign({ user: f.user, role: f.role, name: f.name, exp }), ...publicUser(f) });
      return;
    }

    // ── QUÊN MẬT KHẨU (gửi pass mới qua Telegram) ──
    if (action === 'forgot') {
      const { user } = body;
      if (!users) { res.status(501).json({ error: 'Cần cấu hình database' }); return; }
      const found = users.find(u => u.user === user);
      // Chỉ cho admin reset; luôn trả về "đã gửi" để không lộ tài khoản nào tồn tại
      const botToken = process.env.TELEGRAM_BOT_TOKEN || '';
      const chatId = process.env.TELEGRAM_CHAT_ID || '';
      if (found && found.role === 'admin' && botToken && chatId) {
        // tạo mật khẩu mới ngẫu nhiên
        const newPass = 'LN' + Math.random().toString(36).slice(2, 8) + Math.floor(Math.random() * 90 + 10);
        found.pass = hashPass(newPass);
        await saveUsers(users);
        // gửi Telegram
        try {
          const text = `🔐 POD Manager — Đặt lại mật khẩu\n\nTài khoản: ${user}\nMật khẩu mới: ${newPass}\n\nĐăng nhập rồi đổi lại mật khẩu trong mục Đổi mật khẩu.`;
          await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text }),
          });
        } catch (e) {}
      }
      // luôn trả về thông báo giống nhau (bảo mật)
      res.status(200).json({ ok: true, message: 'Nếu tài khoản hợp lệ, mật khẩu mới đã được gửi vào Telegram.' });
      return;
    }

    // Các action sau cần đăng nhập
    const session = verify(req.headers['x-session']);
    if (!session) { res.status(401).json({ error: 'Chưa đăng nhập' }); return; }
    if (!users) { res.status(501).json({ error: 'Cần cấu hình database (Upstash) để đổi mật khẩu' }); return; }

    // ── ĐỔI PASS CỦA MÌNH ──
    if (action === 'change_pass') {
      const { oldPass, newPass } = body;
      if (!newPass || newPass.length < 6) { res.status(400).json({ error: 'Mật khẩu mới tối thiểu 6 ký tự' }); return; }
      const me = users.find(u => u.user === session.user);
      if (!me || !verifyPass(oldPass, me.pass)) { res.status(401).json({ error: 'Mật khẩu cũ không đúng' }); return; }
      me.pass = hashPass(newPass);
      await saveUsers(users);
      res.status(200).json({ ok: true });
      return;
    }

    // ── CÁC ACTION ADMIN ──
    if (session.role !== 'admin') { res.status(403).json({ error: 'Chỉ Admin được thao tác' }); return; }

    if (action === 'admin_list') {
      res.status(200).json({ users: users.map(publicUser) });
      return;
    }
    if (action === 'admin_add') {
      const { user, pass, role, name } = body;
      if (!user || !pass) { res.status(400).json({ error: 'Thiếu tài khoản/mật khẩu' }); return; }
      if (users.find(u => u.user === user)) { res.status(400).json({ error: 'Tài khoản đã tồn tại' }); return; }
      const validRoles = ['admin', 'seller', 'design', 'support', 'staff'];
      const safeRole = validRoles.includes(role) ? role : 'seller';
      users.push({ user, pass: hashPass(pass), role: safeRole, name: name || user });
      await saveUsers(users);
      res.status(200).json({ ok: true });
      return;
    }
    if (action === 'admin_reset') {
      const { user, newPass } = body;
      const t = users.find(u => u.user === user);
      if (!t) { res.status(404).json({ error: 'Không tìm thấy tài khoản' }); return; }
      if (!newPass || newPass.length < 6) { res.status(400).json({ error: 'Mật khẩu tối thiểu 6 ký tự' }); return; }
      t.pass = hashPass(newPass);
      await saveUsers(users);
      res.status(200).json({ ok: true });
      return;
    }
    if (action === 'admin_del') {
      const { user } = body;
      if (user === session.user) { res.status(400).json({ error: 'Không thể tự xoá chính mình' }); return; }
      const before = users.length;
      const next = users.filter(u => u.user !== user);
      if (next.length === before) { res.status(404).json({ error: 'Không tìm thấy tài khoản' }); return; }
      await saveUsers(next);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(400).json({ error: 'Action không hợp lệ' });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}
