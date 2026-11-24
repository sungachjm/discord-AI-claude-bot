const fs = require('fs');
const path = require('path');
const { ActivityType } = require('discord.js');

// Các kiểu trạng thái dùng được trong statuses.json
const TYPES = {
  playing: ActivityType.Playing, // Đang chơi ...
  watching: ActivityType.Watching, // Đang xem ...
  listening: ActivityType.Listening, // Đang nghe ...
  competing: ActivityType.Competing, // Đang thi đấu ...
  custom: ActivityType.Custom, // Hiện đúng dòng chữ, không có chữ "Đang ..."
};
const DEFAULTS = [{ type: 'custom', text: 'Đang hoạt động' }];

function loadStatuses() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'statuses.json'), 'utf8'));
    const list = Array.isArray(raw)
      ? raw.filter((s) => s && typeof s.text === 'string' && s.text.trim())
      : [];
    return list.length ? list : DEFAULTS;
  } catch {
    console.error('⚠️ Không đọc được statuses.json, dùng trạng thái mặc định.');
    return DEFAULTS;
  }
}

// Thay {servers} và {members} bằng số liệu thật
function fill(text, client) {
  const servers = client.guilds.cache.size;
  const members = client.guilds.cache.reduce((n, g) => n + (g.memberCount ?? 0), 0);
  return text
    .replaceAll('{servers}', servers.toLocaleString('vi-VN'))
    .replaceAll('{members}', members.toLocaleString('vi-VN'))
    .slice(0, 128);
}

/**
 * Gọi một lần khi bot đã sẵn sàng: startStatus(client)
 * Tuỳ chọn qua biến môi trường (không bắt buộc):
 *   STATUS_PRESENCE = online | idle | dnd | invisible   (mặc định online)
 *   STATUS_INTERVAL = số giây giữa mỗi lần đổi trạng thái (mặc định 30, tối thiểu 15)
 */
module.exports = function startStatus(client) {
  const statuses = loadStatuses();
  const presence = ['online', 'idle', 'dnd', 'invisible'].includes(process.env.STATUS_PRESENCE)
    ? process.env.STATUS_PRESENCE
    : 'online';
  const seconds = Math.max(15, Number(process.env.STATUS_INTERVAL) || 30);

  let index = 0;
  const update = () => {
    const s = statuses[index % statuses.length];
    index++;

    const type = TYPES[String(s.type ?? 'custom').toLowerCase()] ?? ActivityType.Custom;
    const text = fill(s.text, client);
    const activity =
      type === ActivityType.Custom
        ? { name: 'Custom Status', type, state: text }
        : { name: text, type };

    client.user.setPresence({ status: presence, activities: [activity] });
  };

  update();
  if (statuses.length > 1) setInterval(update, seconds * 1000); // luân phiên các trạng thái
};
