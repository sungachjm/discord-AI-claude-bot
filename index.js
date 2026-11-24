require('dotenv').config();
const startStatus = require('./status');
const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  SlashCommandBuilder,
  InteractionContextType,
  MessageFlags,
} = require('discord.js');

const missing = ['TOKEN', 'GEMINI_API_KEY'].filter((k) => !process.env[k]?.trim());
if (missing.length) {
  console.error(`❌ Thiếu biến môi trường: ${missing.join(', ')}`);
  process.exit(1);
}

const { ask, friendlyError, MODEL } = require('./ai');
const { splitMessage, createLimiter } = require('./util');

const { TOKEN, GUILD_ID } = process.env;

// Chỉ trả lời trong các kênh này (để trống = mọi kênh). Ví dụ: AI_CHANNEL_IDS=123,456
const CHANNELS = new Set((process.env.AI_CHANNEL_IDS || '').split(/[,\s]+/).filter(Boolean));
const checkLimit = createLimiter({
  perMinute: Number(process.env.AI_RATE_PER_MINUTE) || 5,
  perDay: Number(process.env.AI_DAILY_LIMIT) || 40,
});

const MAX_HISTORY_MESSAGES = 20; // 10 lượt hỏi đáp gần nhất
const MAX_HISTORY_CHARS = 12_000;
const MAX_IMAGES = 3;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp']; // Gemini không đọc ảnh GIF
const NO_PING = { parse: [], repliedUser: false }; // câu trả lời của AI không bao giờ ping ai

const client = new Client({
  // Không cần Message Content Intent: Discord vẫn gửi nội dung tin nhắn có nhắc bot và tin nhắn DM
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel],
});

// ---------- Slash commands ----------
const everywhere = [InteractionContextType.Guild, InteractionContextType.BotDM];
const commands = [
  new SlashCommandBuilder()
    .setName('ask')
    .setDescription('Hỏi AI một câu')
    .addStringOption((o) =>
      o.setName('question').setDescription('Câu hỏi của bạn').setRequired(true).setMaxLength(2000),
    )
    .addAttachmentOption((o) => o.setName('image').setDescription('Ảnh để AI xem (không bắt buộc)'))
    .setContexts(...everywhere),
  new SlashCommandBuilder()
    .setName('reset')
    .setDescription('Xoá trí nhớ cuộc trò chuyện của AI trong kênh này')
    .setContexts(...everywhere),
].map((c) => c.toJSON());

// ---------- Trí nhớ cuộc trò chuyện ----------
const histories = new Map(); // key -> { msgs: [{ role, content }], ts }
const locks = new Map(); // key -> Promise (mỗi kênh chỉ xử lý một yêu cầu tại một thời điểm)

// DM: mỗi người một trí nhớ riêng. Trong server: mỗi kênh một trí nhớ chung.
const keyFor = (channelId, userId, isDM) => (isDM ? `dm:${userId}` : `ch:${channelId}`);

function remember(key, userText, reply) {
  const entry = histories.get(key) ?? { msgs: [], ts: 0 };
  entry.msgs.push({ role: 'user', content: userText }, { role: 'assistant', content: reply });

  const total = () => entry.msgs.reduce((n, m) => n + m.content.length, 0);
  while (entry.msgs.length > MAX_HISTORY_MESSAGES || (total() > MAX_HISTORY_CHARS && entry.msgs.length > 2)) {
    entry.msgs.splice(0, 2); // bỏ cả một lượt hỏi đáp để luôn bắt đầu bằng tin của người dùng
  }
  entry.ts = Date.now();
  histories.set(key, entry);
}

function withLock(key, fn) {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(key, next);
  next
    .finally(() => {
      if (locks.get(key) === next) locks.delete(key);
    })
    .catch(() => {});
  return next;
}

// Dọn trí nhớ của các cuộc trò chuyện đã im lặng hơn 2 giờ
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [key, entry] of histories) if (entry.ts < cutoff) histories.delete(key);
}, 30 * 60 * 1000).unref();

// ---------- Ảnh ----------
const isImage = (a) =>
  IMAGE_TYPES.includes(a.contentType?.split(';')[0]) && (a.size ?? 0) <= MAX_IMAGE_BYTES;

async function loadImages(attachments) {
  const list = [...attachments].filter(isImage).slice(0, MAX_IMAGES);
  return Promise.all(
    list.map(async (a) => {
      const res = await fetch(a.url);
      if (!res.ok) throw new Error('Không tải được ảnh đính kèm.');
      return {
        mediaType: a.contentType.split(';')[0],
        data: Buffer.from(await res.arrayBuffer()).toString('base64'),
      };
    }),
  );
}

// ---------- Xử lý chung cho tin nhắn và slash command ----------
/**
 * sendFirst / sendMore: hàm gửi tin nhắn đầu tiên và các tin nhắn tiếp theo (nếu câu trả lời dài)
 */
async function respond({ key, userId, name, text, attachments, sendFirst, sendMore, isDM }) {
  const limited = checkLimit(userId);
  if (limited) return sendFirst(limited);

  const queuedAt = Date.now();
  return withLock(key, async () => {
    const waited = Date.now() - queuedAt;
    if (waited > 1500) console.log(`⏱ Phải đợi hàng đợi của kênh ${(waited / 1000).toFixed(1)}s`);
    try {
      const images = await loadImages(attachments);
      const userText = (isDM ? text : `${name}: ${text}`) || '(chỉ gửi ảnh)';
      const history = histories.get(key)?.msgs ?? [];

      const reply = await ask({ history, text: userText, images });
      remember(key, images.length ? `${userText} [đã gửi ${images.length} ảnh]` : userText, reply);

      const parts = splitMessage(reply);
      await sendFirst(parts[0]);
      for (const part of parts.slice(1)) await sendMore(part);
    } catch (err) {
      console.error('Lỗi AI:', err?.status ?? '', err?.message ?? err);
      await sendFirst(friendlyError(err)).catch(() => {});
    }
  });
}

// ---------- Trả lời khi bị nhắc tên hoặc nhắn DM ----------
client.on(Events.MessageCreate, async (msg) => {
  try {
    if (msg.author.bot) return;

    const isDM = !msg.guild;
    const mentioned = msg.mentions.has(client.user, { ignoreEveryone: true, ignoreRoles: true });
    if (!isDM && !mentioned) return;
    if (!isDM && CHANNELS.size && !CHANNELS.has(msg.channelId)) return;

    const text = msg.content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
    const images = [...msg.attachments.values()].filter(isImage);
    if (!text && !images.length) {
      return void msg.reply({ content: 'Bạn muốn hỏi gì nào? 😊', allowedMentions: NO_PING });
    }

    // Hiện "đang nhập..." trong lúc chờ AI trả lời
    msg.channel.sendTyping().catch(() => {});
    const typing = setInterval(() => msg.channel.sendTyping().catch(() => {}), 8000);

    try {
      await respond({
        key: keyFor(msg.channelId, msg.author.id, isDM),
        userId: msg.author.id,
        name: msg.member?.displayName ?? msg.author.globalName ?? msg.author.username,
        text,
        attachments: msg.attachments.values(),
        isDM,
        sendFirst: (content) => msg.reply({ content, allowedMentions: NO_PING }),
        sendMore: (content) => msg.channel.send({ content, allowedMentions: NO_PING }),
      });
    } finally {
      clearInterval(typing);
    }
  } catch (err) {
    console.error(err);
  }
});

// ---------- Slash commands ----------
client.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand()) return;
  try {
    const isDM = !i.guild;
    const key = keyFor(i.channelId, i.user.id, isDM);

    if (i.commandName === 'reset') {
      histories.delete(key);
      return await i.reply({ content: '🧹 Đã xoá trí nhớ cuộc trò chuyện.', flags: MessageFlags.Ephemeral });
    }

    if (i.commandName === 'ask') {
      if (!isDM && CHANNELS.size && !CHANNELS.has(i.channelId)) {
        return await i.reply({ content: '❌ Hãy dùng lệnh này trong kênh AI của server.', flags: MessageFlags.Ephemeral });
      }
      await i.deferReply();
      const image = i.options.getAttachment('image');
      return await respond({
        key,
        userId: i.user.id,
        name: i.member?.displayName ?? i.user.globalName ?? i.user.username,
        text: i.options.getString('question', true),
        attachments: image ? [image] : [],
        isDM,
        sendFirst: (content) => i.editReply({ content, allowedMentions: NO_PING }),
        sendMore: (content) => i.followUp({ content, allowedMentions: NO_PING }),
      });
    }
  } catch (err) {
    console.error(err);
    const payload = { content: '❌ Có lỗi xảy ra, thử lại sau nhé.' };
    if (i.deferred || i.replied) await i.editReply(payload).catch(() => {});
    else await i.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Đăng nhập: ${c.user.tag} • Model: ${MODEL}`);
  startStatus(c); // đặt trạng thái cho bot
  if (GUILD_ID) {
    const guild = await c.guilds.fetch(GUILD_ID).catch(() => null);
    if (guild) await guild.commands.set(commands);
    else console.error('❌ GUILD_ID sai hoặc bot chưa ở trong server đó.');
  } else {
    await c.application.commands.set(commands);
  }
  console.log('📌 Đã đăng ký lệnh');
});

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

// Server HTTP nhỏ cho Render (cần cổng mở) và để UptimeRobot ping giữ bot thức
if (process.env.PORT) {
  require('http')
    .createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Bot is alive');
    })
    .listen(process.env.PORT, () => console.log('🌐 HTTP server đang chạy'));
}

client.login(TOKEN);
          
