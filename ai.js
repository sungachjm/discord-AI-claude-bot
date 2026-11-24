const fs = require('fs');
const path = require('path');
const AnthropicSDK = require('@anthropic-ai/sdk');

const Anthropic = AnthropicSDK.default ?? AnthropicSDK;

const MODEL = process.env.AI_MODEL || 'claude-haiku-5-5';
const MAX_TOKENS = Number(process.env.AI_MAX_TOKENS) || 1024;

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  timeout: 60_000,
});

// Tính cách của bot: sửa trong file persona.txt (dòng bắt đầu bằng # là ghi chú)
function loadPersona() {
  try {
    return fs
      .readFileSync(path.join(__dirname, 'persona.txt'), 'utf8')
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n')
      .trim();
  } catch {
    return '';
  }
}
const PERSONA =
  loadPersona() || 'Bạn là một trợ lý AI thân thiện, trả lời bằng tiếng Việt, ngắn gọn và dễ hiểu.';

function buildSystem() {
  const today = new Date().toLocaleDateString('vi-VN', {
    dateStyle: 'full',
    timeZone: 'Asia/Ho_Chi_Minh',
  });
  return [
    PERSONA,
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

/**
 * Hỏi Claude.
 * history: mảng { role: 'user' | 'assistant', content: string } đã diễn ra trước đó
 * images: mảng { mediaType, data (base64) }
 */
async function ask({ history = [], text, images = [] }) {
  const content = [
    // Ảnh đặt trước chữ để Claude hiểu tốt hơn
    ...images.map((img) => ({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.data },
    })),
    { type: 'text', text },
  ];

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: buildSystem(),
    messages: [...history, { role: 'user', content }],
  });

  const reply = res.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();

  return reply || '(Mình chưa nghĩ ra câu trả lời, bạn thử hỏi lại nhé.)';
}

// Đổi lỗi kỹ thuật thành câu dễ hiểu cho người dùng
function friendlyError(err) {
  const msg = String(err?.message ?? '');
  if (err?.status === 401) return '❌ Bot chưa cấu hình đúng API key, hãy báo admin.';
  if (/credit balance/i.test(msg)) return '❌ Tài khoản API đã hết credit, hãy báo admin.';
  if (err?.status === 429) return '⏳ AI đang bị giới hạn lượt dùng, thử lại sau ít phút nhé.';
  if (err?.status >= 500 || err?.status === 529) return '⏳ AI đang quá tải, thử lại sau nhé.';
  if (err?.status === 400) return '❌ Yêu cầu không hợp lệ (có thể ảnh quá lớn hoặc sai định dạng).';
  return '❌ Có lỗi xảy ra khi gọi AI, thử lại sau nhé.';
}

module.exports = { ask, friendlyError, MODEL };
               
