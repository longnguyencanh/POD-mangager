// api/ytrends.js
// Proxy trung gian: frontend 79ECOM gọi vào đây, đây gọi tiếp YTrends MCP.
// Đặt ở Vercel region iad1 (US East) cho đồng bộ với api/etsy.js.
export const config = { regions: ['iad1'] };

const MCP_URL = 'https://mcp.trends.ytuong.ai/mcp';

// Nếu YTrends cần key: vào Vercel > Settings > Environment Variables,
// thêm YTRENDS_KEY = <token của Long>. Không cần thì để trống, vẫn chạy.
const YTRENDS_KEY = process.env.YTRENDS_KEY || '';

// 14 tool được phép gọi — chặn gọi linh tinh.
const ALLOWED = new Set([
  'ytrends_scout_opportunities',
  'ytrends_find_hidden_gems',
  'ytrends_find_trending_keywords',
  'ytrends_trend_calendar',
  'ytrends_explore_niche',
  'ytrends_research_keyword',
  'ytrends_analyze_competition',
  'ytrends_get_keyword_rank',
  'ytrends_find_hot_listings',
  'ytrends_browse_new_listings',
  'ytrends_browse_rankings',
  'ytrends_search',
  'ytrends_market_snapshot',
  'ytrends_fetch',
]);

// Gọi 1 method MCP (JSON-RPC) và đọc kết quả.
// YTrends MCP trả về dạng SSE (text/event-stream) nên cần bóc dòng "data:".
async function mcpCall(method, params, sessionId) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  };
  if (YTRENDS_KEY) headers['Authorization'] = `Bearer ${YTRENDS_KEY}`;
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;

  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });

  const newSession = res.headers.get('mcp-session-id') || sessionId;
  const text = await res.text();

  // Server có thể trả JSON thuần HOẶC SSE. Xử lý cả hai.
  let payload = null;
  if (text.includes('data:')) {
    // Bóc dòng data: cuối cùng trong stream SSE
    const lines = text.split('\n').filter((l) => l.startsWith('data:'));
    const last = lines[lines.length - 1];
    if (last) payload = JSON.parse(last.slice(5).trim());
  } else if (text.trim()) {
    payload = JSON.parse(text);
  }

  return { payload, sessionId: newSession, status: res.status };
}

export default async function handler(req, res) {
  // CORS cho chính domain của Long
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Session');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Chỉ nhận POST' });
  }

  try {
    const { tool, args } = req.body || {};
    if (!tool || !ALLOWED.has(tool)) {
      return res.status(400).json({ error: `Tool không hợp lệ: ${tool}` });
    }

    // MCP yêu cầu bắt tay initialize trước, lấy session, rồi mới gọi tool.
    const init = await mcpCall(
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: '79ecom', version: '1.0' },
      },
      null
    );
    const sessionId = init.sessionId;

    // Báo server là client đã sẵn sàng (notification, không cần đợi kết quả).
    if (sessionId) {
      try {
        await fetch(MCP_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
            'Mcp-Session-Id': sessionId,
            ...(YTRENDS_KEY ? { Authorization: `Bearer ${YTRENDS_KEY}` } : {}),
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'notifications/initialized',
          }),
        });
      } catch (_) {}
    }

    // Gọi tool thật sự.
    const result = await mcpCall(
      'tools/call',
      { name: tool, arguments: args || {} },
      sessionId
    );

    if (!result.payload) {
      return res
        .status(502)
        .json({ error: 'YTrends không trả về dữ liệu', raw: result.status });
    }
    if (result.payload.error) {
      return res.status(502).json({ error: result.payload.error });
    }

    // Bóc nội dung text từ kết quả MCP cho gọn (thường là JSON trong content[0].text).
    const content = result.payload.result?.content || [];
    const textBlock = content.find((c) => c.type === 'text');
    let data = textBlock ? textBlock.text : result.payload.result;
    try {
      data = JSON.parse(data);
    } catch (_) {
      /* để nguyên nếu không phải JSON */
    }

    return res.status(200).json({ ok: true, tool, data });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
}
