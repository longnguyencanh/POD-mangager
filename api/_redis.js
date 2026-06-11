// Helper gọi Upstash Redis qua REST API (không cần cài thư viện)
// Cần 2 Environment Variable trên Vercel:
//   UPSTASH_REDIS_REST_URL
//   UPSTASH_REDIS_REST_TOKEN

const URL = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

export function hasRedis() { return !!(URL && TOKEN); }

// Chạy 1 lệnh Redis qua REST (POST với body JSON là mảng [cmd, ...args])
async function cmd(args, retry = 1) {
  try {
    const r = await fetch(URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!r.ok) {
      // Lỗi tạm thời (5xx) → thử lại 1 lần
      if (r.status >= 500 && retry > 0) return cmd(args, retry - 1);
      throw new Error('Redis HTTP ' + r.status);
    }
    const data = await r.json();
    if (data.error) throw new Error(data.error);
    return data.result;
  } catch (e) {
    // Lỗi mạng → thử lại 1 lần
    if (retry > 0) return cmd(args, retry - 1);
    throw e;
  }
}

// Lưu một giá trị JSON theo key
export async function kvSet(key, value) {
  return cmd(['SET', key, JSON.stringify(value)]);
}

// Đọc một giá trị JSON theo key
export async function kvGet(key) {
  const res = await cmd(['GET', key]);
  if (res == null) return null;
  try { return JSON.parse(res); } catch (e) { return res; }
}

// Xoá key
export async function kvDel(key) {
  return cmd(['DEL', key]);
}
