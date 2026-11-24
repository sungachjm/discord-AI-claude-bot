// Cắt câu trả lời dài thành nhiều tin nhắn (giới hạn 2000 ký tự của Discord),
// ưu tiên cắt ở xuống dòng, và đóng/mở lại khối code bị cắt giữa chừng.
function splitMessage(text, max = 1900) {
  const chunks = [];
  let rest = String(text ?? '').trim();

  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.5) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);

  let open = false; // đang ở trong khối ``` hay không
  return chunks.map((chunk) => {
    let out = chunk;
    if (open) out = `\`\`\`\n${out}`;
    const fences = (chunk.match(/```/g) || []).length;
    if (fences % 2 === 1) open = !open;
    if (open) out += '\n```';
    return out;
  });
}

// Giới hạn số lượt hỏi: tối đa perMinute lượt/phút và perDay lượt/ngày cho mỗi người
function createLimiter({ perMinute = 5, perDay = 40 } = {}) {
  const usage = new Map(); // userId -> { times: number[], day: string, count: number }

  return function check(userId) {
    const now = Date.now();
    const today = new Date().toISOString().slice(0, 10);
    const u = usage.get(userId) ?? { times: [], day: today, count: 0 };

    if (u.day !== today) {
      u.day = today;
      u.count = 0;
    }
    u.times = u.times.filter((t) => now - t < 60_000);

    if (u.times.length >= perMinute) {
      usage.set(userId, u);
      return '⏳ Bạn hỏi nhanh quá, chờ một chút rồi hỏi tiếp nhé.';
    }
    if (u.count >= perDay) {
      usage.set(userId, u);
      return `🚫 Hôm nay bạn đã dùng hết ${perDay} lượt hỏi, mai quay lại nhé.`;
    }

    u.times.push(now);
    u.count++;
    usage.set(userId, u);
    return null; // được phép
  };
}

module.exports = { splitMessage, createLimiter };
    
