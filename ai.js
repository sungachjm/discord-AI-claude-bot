const fs = require('fs');
const path = require('path');

// Gọi thẳng REST API của Gemini bằng fetch (Node 18+), không cần cài thư viện
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.AI_MODEL || 'gemini-3.1-flash-lite';
const MAX_TOKENS = Number(process.env.AI_MAX_TOKENS) || 2048;
const endpoint = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

// Đọc file văn bản trong thư mục bot (bỏ các dòng bắt đầu bằng # là ghi chú)
function readTextFile(name) {
  try {
    return fs
      .readFileSync(path.join(__dirname, name), 'utf8')
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n')
      .trim();
  } catch {
    return '';
  }
}

// Tính cách của bot: sửa trong persona.txt. Thông tin về server: sửa trong server-info.txt
const PERSONA =
  readTextFile('persona.txt') || 'Bạn là một trợ lý AI thân thiện, trả lời bằng tiếng Việt, ngắn gọn và dễ hiểu.';
const SERVER_INFO = readTextFile('server-info.txt').slice(0, 8000);

function buildSystem() {
  const today = new Date().toLocaleDateString('vi-VN', {
    dateStyle: 'full',
    timeZone: 'Asia/Ho_Chi_Minh',
  });
  const serverInfo = SERVER_INFO
    ? [
        '',
        'Thông tin về server này (chỉ dùng để trả lời câu hỏi liên quan đến server; nếu thông tin không có ở đây thì nói là không chắc và gợi ý hỏi staff, tuyệt đối đừng bịa):',
        SERVER_INFO,
      ]
    : [];
  return [
    PERSONA,
    ...serverInfo,
    '',
    'Quy tắc cố định:',
    '- Trả lời bằng ngôn ngữ mà người dùng đang dùng.',
    '- Giữ câu trả lời gọn (dưới khoảng 1500 ký tự nếu có thể) và dùng Markdown của Discord.',
    '- Trong server, mỗi tin nhắn của người dùng bắt đầu bằng "Tên: " để bạn biết ai đang nói. Đừng lặp lại tiền tố này trong câu trả lời.',
    '- Không tạo @everyone, @here hoặc mention người khác.',
    '- Nếu không chắc chắn thì nói thẳng là không chắc, không bịa thông tin.',
    `Hôm nay là ${today}.`,
  ].join('\n');
}

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function callOnce(body) {
  const res = await fetch(endpoint(MODEL), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data?.error?.message ?? `HTTP ${res.status}`);
  return data;
}

// Thử lại 1 lần khi Gemini báo lỗi máy chủ (5xx) hoặc mạng chập chờn
async function callGemini(body) {
  const waits = [1000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await callOnce(body);
    } catch (err) {
      const retryable =
        err instanceof ApiError ? err.status >= 500 : ['TimeoutError', 'TypeError'].includes(err.name);
      if (!retryable || attempt >= waits.length) throw err;
      console.warn(`⚠️ Gemini lỗi (${err.status ?? err.name}), thử lại sau ${waits[attempt] / 1000}s...`);
      await new Promise((resolve) => setTimeout(resolve, waits[attempt]));
    }
  }
}

/**
 * Hỏi Gemini.
 * history: mảng { role: 'user' | 'assistant', content: string } đã diễn ra trước đó
 * images: mảng { mediaType, data (base64) }
 */
async function ask({ history = [], text, images = [] }) {
  const parts = [
    ...images.map((img) => ({ inlineData: { mimeType: img.mediaType, data: img.data } })),
    { text },
  ];

  const t0 = Date.now();
  const data = await callGemini({
    systemInstruction: { parts: [{ text: buildSystem() }] },
    contents: [
      ...history.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
      { role: 'user', parts },
    ],
    generationConfig: { maxOutputTokens: MAX_TOKENS },
  });

  console.log(`⏱ Gemini (${MODEL}) trả lời sau ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const candidate = data.candidates?.[0];
  const reply = (candidate?.content?.parts ?? [])
    .filter((p) => typeof p.text === 'string' && !p.thought)
    .map((p) => p.text)
    .join('')
    .trim();

  if (reply) return reply;
  if (data.promptFeedback?.blockReason || candidate?.finishReason === 'SAFETY') {
    throw new ApiError(0, 'BLOCKED');
  }
  throw new ApiError(0, 'EMPTY');
}

// Đổi lỗi kỹ thuật thành câu dễ hiểu cho người dùng
function friendlyError(err) {
  const msg = String(err?.message ?? '');
  if (msg === 'BLOCKED') return '🙅 AI từ chối trả lời nội dung này, bạn thử hỏi cách khác nhé.';
  if (msg === 'EMPTY') return 'Mình chưa nghĩ ra câu trả lời, bạn thử hỏi lại nhé.';
  if (/API key not valid|API_KEY_INVALID/i.test(msg) || err?.status === 401) {
    return '❌ Bot chưa cấu hình đúng API key Gemini, hãy báo admin.';
  }
  if (err?.status === 403) return '❌ API key không có quyền dùng Gemini hoặc bị chặn, hãy báo admin.';
  if (err?.status === 404) return '❌ Tên model AI không đúng hoặc đã ngừng hỗ trợ, hãy báo admin đổi AI_MODEL.';
  if (err?.status === 429) return '⏳ AI đang hết lượt dùng tạm thời, thử lại sau ít phút nhé.';
  if (err?.status >= 500) return '⏳ AI đang quá tải, thử lại sau nhé.';
  if (err?.status === 400) return '❌ Yêu cầu không hợp lệ (có thể ảnh sai định dạng hoặc quá lớn).';
  return '❌ Có lỗi xảy ra khi gọi AI, thử lại sau nhé.';
}

module.exports = { ask, friendlyError, MODEL };
  
