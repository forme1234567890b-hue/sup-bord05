// ================================================
// SUP BOARD BOT v4.0 — ИСПРАВЛЕННЫЙ
// ================================================

import express from "express";
import axios from "axios";
import qrcode from "qrcode";
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";

const app = express();
app.use(express.json());

const CONFIG = {
  VERIFY_TOKEN:      "sup_board_secret_2025",
  PAGE_ACCESS_TOKEN: "",
  TG_TOKEN:          "8878884686:AAGmS94pp2nhkQrHj8hkx8LIbBRmtdn92Xk",
  TG_CHAT_ID:        "5208172896",
  PHONE:             "89051160860",
  PRICES: {
    "1":   { label: "1 час",    price: 800  },
    "1.5": { label: "1.5 часа", price: 1000 },
    "2":   { label: "2 часа",   price: 1200 },
  },
  CAPACITY: 10,
};

const bookings        = {};
const sessions        = {};
const pendingPayments = {};
let   lastQR          = null;

// ================================================
// СТРАНИЦЫ
// ================================================
app.get("/qr", async (req, res) => {
  if (!lastQR) {
    return res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px">
        <h2>✅ WhatsApp подключён!</h2>
        <p>Бот работает</p>
        <script>setTimeout(()=>location.reload(),10000)</script>
      </body></html>
    `);
  }
  const qrImage = await qrcode.toDataURL(lastQR);
  res.send(`
    <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#f0f0f0">
      <h2>📱 Сканируйте QR-код WhatsApp</h2>
      <p>WhatsApp → Связанные устройства → Привязать устройство</p>
      <img src="${qrImage}" style="width:300px;border:3px solid #25D366;border-radius:12px"/>
      <script>setTimeout(()=>location.reload(),25000)</script>
    </body></html>
  `);
});

app.get("/", (req, res) => {
  res.send(`
    <html><body style="font-family:sans-serif;padding:40px">
      <h1>🏄 SUP Board Bot v4.0</h1>
      <p>✅ Сервер работает</p>
      <a href="/qr">📱 QR-код WhatsApp</a>
    </body></html>
  `);
});

// ================================================
// WHATSAPP
// ================================================
let waSocket = null;

async function startWhatsApp() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState("auth_info");
    const { version }          = await fetchLatestBaileysVersion();

    waSocket = makeWASocket({
      version,
      auth:              state,
      logger:            pino({ level: "silent" }),
      printQRInTerminal: true,
      // ✅ Важно: получаем сообщения от всех
      getMessage: async () => ({ conversation: "" }),
    });

    waSocket.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        lastQR = qr;
        console.log("📱 QR готов! Откройте /qr");
      }

      if (connection === "close") {
        const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
        console.log("WA closed, code:", code);

        if (code !== DisconnectReason.loggedOut) {
          console.log("🔄 Переподключение через 3 сек...");
          setTimeout(startWhatsApp, 3000);
        } else {
          console.log("❌ Выход выполнен");
          lastQR = null;
        }
      }

      if (connection === "open") {
        lastQR = null;
        console.log("✅ WhatsApp подключён!");
        await notifyTelegram("✅ <b>WhatsApp бот подключён!</b>");
      }
    });

    waSocket.ev.on("creds.update", saveCreds);

    // ✅ ИСПРАВЛЕНИЕ: правильная обработка сообщений
    waSocket.ev.on("messages.upsert", async (m) => {
      try {
        const messages = m.messages;
        if (!messages || messages.length === 0) return;

        for (const msg of messages) {
          // Пропускаем свои сообщения
          if (msg.key.fromMe) continue;
          
          // Пропускаем группы
          if (msg.key.remoteJid.endsWith("@g.us")) continue;
          
          // Пропускаем пустые
          if (!msg.message) continue;

          const userId = msg.key.remoteJid;

          // Получаем текст из разных типов сообщений
          const text =
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            msg.message?.buttonsResponseMessage?.selectedDisplayText ||
            msg.message?.listResponseMessage?.title ||
            "";

          // Фото (чек об оплате)
          if (
            msg.message?.imageMessage ||
            msg.message?.documentMessage
          ) {
            console.log(`📸 Фото от ${userId}`);
            await handleMessage({
              channel: "wa",
              userIdchannel, userId,
        `⏳ Ожидаем фото чека об оплате.\n` +
        `Сфотографируйте чек и отправьте сюда 📸`
      );
    }
    if (s.step === "waiting_confirm") {
      return await send(channel, userId,
        `✅ Ваш чек уже получен!\n` +
        `Ожидайте подтверждения (5–10 минут) ⏳`
      );
    }

    // Стартовый шаг
    const hasBooking = BOOKING_WORDS.some(w => low.includes(w));
    const greeting   = detectGreeting(low);

    if (greeting && !hasBooking) {
      return await send(channel, userId,
        `${greeting}\n\n` +
        `🏄 Добро пожаловать!\n` +
        `Хотите забронировать сапборд?\n` +
        `Напишите сколько досок нужно!`
      );
    }

    if (hasBooking || (greeting && hasBooking)) {
      const count = extractNumber(low);
      if (count) {
        s.step  = "wait_duration";
        s.count = count;
        sessions[userId] = s;
        const gr = greeting ? `${greeting}\n\n` : "";
        return await send(channel, userId,
          `${gr}🏄 ${count} сапборда — отлично!\n\n` +
          `⏱ На сколько времени?\n\n` +
          `1️⃣ — 1 час (800 руб)\n` +
          `2️⃣ — 1.5 часа (1000 руб)\n` +
          `3️⃣ — 2 часа (1200 руб)`
        );
      }
      s.step = "wait_count";
      sessions[userId] = s;
      const gr = greeting ? `${greeting}\n\n` : "";
      return await send(channel, userId,
        `${gr}🏄 Хотите забронировать сапборд!\n` +
        `Сколько досок нужно? (1–10)`
      );
    }

    // Если непонятное сообщение
    return await send(channel, userId,
      `🏄 Привет! Я бот аренды сапбордов.\n\n` +
      `Напишите:\n` +
      `• "Хочу забронировать"\n` +
      `• "Сапборд на 2 часа"\n` +
      `• "2 доски на завтра"\n\n` +
      `И я помогу с бронированием! 😊`
    );

  } catch (err) {
    console.error("handleMessage error:", err);
  }
}

// ================================================
// ШАГИ
// ================================================
async function handleCount({ channel, userId, low, s }) {
  const n = extractNumber(low);
  if (!n || n < 1 || n > CONFIG.CAPACITY) {
    return await send(channel, userId,
      `Введите число от 1 до ${CONFIG.CAPACITY}\n` +
      `Например: 2`
    );
  }
  s.count = n;
  s.step  = "wait_duration";
  sessions[userId] = s;
  return await send(channel, userId,
    `⏱ На сколько времени?\n\n` +
    `1️⃣ — 1 час (800 руб)\n` +
    `2️⃣ — 1.5 часа (1000 руб)\n` +
    `3️⃣ — 2 часа (1200 руб)`
  );
}

async function handleDuration({ channel, userId, low, s }) {
  let duration = null;

  if (low === "1" || low.includes("один час") || (low.includes("1 час") && !low.includes("1.5"))) duration = "1";
  if (low === "2" || low.includes("два часа") || low.includes("2 часа"))  duration = "2";
  if (low === "3" || low.includes("1.5") || low.includes("полтора"))      duration = "1.5";

  // Дополнительная проверка
  if (!duration && low === "1") duration = "1";
  if (!duration && low === "2") duration = "2";
  if (!duration && low === "3") duration = "1.5";

  if (!duration) {
    return await send(channel, userId,
      `Выберите цифру:\n\n` +
      `1️⃣ — 1 час (800 руб)\n` +
      `2️⃣ — 1.5 часа (1000 руб)\n` +
      `3️⃣ — 2 часа (1200 руб)`
    );
  }

  s.duration       = duration;
  s.step           = "wait_date";
  sessions[userId] = s;

  const info = CONFIG.PRICES[duration];
  return await send(channel, userId,
    `✅ ${info.label} — ${info.price} руб за доску\n\n` +
    `📅 На какую дату?\n\n` +
    `Можете написать:\n` +
    `• Сегодня\n` +
    `• Завтра\n` +
    `• Послезавтра\n` +
    `• Или дату: 20.07.2025`
  );
}

async function handleDate({ channel, userId, low, s }) {
  // ✅ ИСПРАВЛЕНИЕ: понимаем завтра/послезавтра/сегодня
  let date = null;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (low.includes("сегодня")) {
    date = formatISO(today);
  } else if (low.includes("послезавтра")) {
    const d = new Date(today);
    d.setDate(d.getDate() + 2);
    date = formatISO(d);
  } else if (low.includes("завтра")) {
    const d = new Date(today);
    d.setDate(d.getDate() + 1);
    date = formatISO(d);
  } else {
    date = parseDate(low);
  }

  if (!date) {
    return await send(channel, userId,
      `❌ Не понял дату.\n\n` +
      `Напишите:\n` +
      `• Сегодня\n` +
      `• Завтра\n` +
      `• Послезавтра\n` +
      `• Или: 20.07.2025`
    );
  }

  const dateObj = new Date(date);
  dateObj.setHours(0, 0, 0, 0);

  if (dateObj < today) {
    return await send(channel, userId,
      `❌ Эта дата уже прошла.\n` +
      `Введите сегодня, завтра или будущую дату.`
    );
  }

  const booked    = bookings[date] || 0;
  const remaining = CONFIG.CAPACITY - booked;

  if (remaining < s.count) {
    return await send(channel, userId,
      `😔 На ${formatDate(date)} осталось только ${remaining} мест.\n` +
      `Выберите другую дату или меньше досок.`
    );
  }

  s.date           = date;
  s.step           = "confirm";
  sessions[userId] = s;

  const info  = CONFIG.PRICES[s.duration];
  const total = info.price * s.count;
  s.total     = total;

  return await send(channel, userId,
    `✅ Места есть на ${formatDate(date)}!\n\n` +
    `📋 Ваш заказ:\n` +
    `🏄 ${s.count} сапборда\n` +
    `⏱ ${info.label}\n` +
    `📅 ${formatDate(date)}\n` +
    `💰 Итого: ${total} руб\n\n` +
    `⚠️ УСЛОВИЯ:\n` +
    `❌ При неявке — оплата не возвращается\n` +
    `🌧 При плохой погоде — перенос или возврат\n\n` +
    `Подтверждаете? Ответьте: Да / Нет`
  );
}

async function handleConfirm({ channel, userId, low, s }) {
  if (["да","yes","подтверждаю","конечно","ок","хорошо"].some(w => low.includes(w))) {
    s.step = "wait_phone";
    sessions[userId] = s;
    return await send(channel, userId,
      `📞 Укажите ваш номер телефона:\n` +
      `Например: +79001234567`
    );
  }

  if (["нет","no","отмена","отменить"].some(w => low.includes(w))) {
    delete sessions[userId];
    return await send(channel, userId,
      `Хорошо, бронь отменена.\n` +
      `Если захотите — напишите снова 🏄`
    );
  }

  return await send(channel, userId,
    `Пожалуйста ответьте:\n✅ Да — подтвердить\n❌ Нет — отменить`
  );
}

async function handlePhone({ channel, userId, text, s }) {
  const phone = text.replace(/[\s\-\(\)]/g, "");

  if (phone.length < 10) {
    return await send(channel, userId,
      `❌ Введите корректный номер\n` +
      `Например: +79001234567`
    );
  }

  s.phone = phone;
  const bookingId  = generateId();
  s.bookingId      = bookingId;
  sessions[userId] = s;

  bookings[s.date] = (bookings[s.date] || 0) + s.count;

  pendingPayments[bookingId] = {
    ...s, userId, channel, createdAt: new Date(),
  };

  const info = CONFIG.PRICES[s.duration];

  await notifyTelegram(
    `🆕 <b>НОВАЯ БРОНЬ!</b>\n\n` +
    `🆔 <code>${bookingId}</code>\n` +
    `👤 Тел: ${phone}\n` +
    `📅 ${formatDate(s.date)}\n` +
    `⏱ ${info.label}\n` +
    `🏄 ${s.count} сапборда\n` +
    `💰 ${s.total} руб\n` +
    `📱 ${channel === "ig" ? "Instagram" : "WhatsApp"}\n\n` +
    `✅ /confirm_${bookingId}\n` +
    `❌ /cancel_${bookingId}`
  );

  s.step           = "wait_receipt";
  sessions[userId] = s;

  return await send(channel, userId,
    `🎉 Бронь создана!\n\n` +
    `🆔 Номер брони: ${bookingId}\n\n` +
    `💳 Оплатите:\n` +
    `📱 Номер: ${CONFIG.PHONE}\n` +
    `🏦 Банк: Сбербанк / СБП\n` +
    `💰 Сумма: ${s.total} руб\n\n` +
    `📸 После оплаты отправьте фото чека сюда!\n\n` +
    `⚠️ Бронь действует 24 часа`
  );
}

// ================================================
// ЧЕК
// ================================================
async function handleReceiptPhoto({ channel, userId }) {
  const s = sessions[userId];

  if (!s || (s.step !== "wait_receipt" && s.step !== "waiting_confirm")) {
    return await send(channel, userId,
      `📸 Фото получено!\n` +
      `Если это чек об оплате — укажите номер брони`
    );
  }

  const bookingId = s.bookingId;
  const info      = CONFIG.PRICES[s.duration];

  await notifyTelegram(
    `📸 <b>ЧЕК ПОЛУЧЕН!</b>\n\n` +
    `🆔 <code>${bookingId}</code>\n` +
    `👤 ${s.phone}\n` +
    `📅 ${formatDate(s.date)}\n` +
    `⏱ ${info.label}\n` +
    `🏄 ${s.count} сапборда\n` +
    `💰 ${s.total} руб\n\n` +
    `✅ /confirm_${bookingId}\n` +
    `❌ /cancel_${bookingId}`
  );

  s.step           = "waiting_confirm";
  sessions[userId] = s;

  return await send(channel, userId,
    `✅ Чек получен!\n\n` +
    `🔍 Проверяем оплату...\n` +
    `⏳ Подтверждение придёт в течение 5–10 минут\n\n` +
    `🆔 Ваша бронь: ${bookingId}`
  );
}

// ================================================
// TELEGRAM КОМАНДЫ
// ================================================
async function setupTelegramWebhook() {
  try {
    const domain = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.DOMAIN;
    if (!domain) return;
    
    await axios.post(
      `https://api.telegram.org/bot${CONFIG.TG_TOKEN}/setWebhook`,
      { url: `https://${domain}/tg_${CONFIG.TG_TOKEN}` }
    );
    console.log("✅ Telegram webhook установлен");
  } catch (err) {
    console.error("Telegram webhook error:", err.message);
  }
}

app.post(`/tg_${CONFIG.TG_TOKEN}`, async (req, res) => {
  try {
    const msg = req.body.message;
    if (!msg?.text) return res.sendStatus(200);

    const text = msg.text.trim();

    if (text.startsWith("/confirm_")) {
      const bookingId = text.replace("/confirm_", "");
      const booking   = pendingPayments[bookingId];

      if (!booking) {
        await notifyTelegram(`❌ Бронь <code>${bookingId}</code> не найдена`);
        return res.sendStatus(200);
      }

      const info = CONFIG.PRICES[booking.duration];

      await send(booking.channel, booking.userId,
        `🎉 Оплата подтверждена!\n\n` +
        `📋 Ваша бронь:\n` +
        `🆔 ${bookingId}\n` +
        `📅 ${formatDate(booking.date)}\n` +
        `⏱ ${info.label}\n` +
        `🏄 ${booking.count} сапборда\n\n` +
        `Ждём вас! 🏄‍♂️\n` +
        `По вопросам: ${CONFIG.PHONE}`
      );

      pendingPayments[bookingId].status = "confirmed";
      delete sessions[booking.userId];
      await notifyTelegram(`✅ Бронь <code>${bookingId}</code> подтверждена!`);
    }

    if (text.startsWith("/cancel_")) {
      const bookingId = text.replace("/cancel_", "");
      const booking   = pendingPayments[bookingId];

      if (!booking) {
        await notifyTelegram(`❌ Бронь <code>${bookingId}</code> не найдена`);
        return res.sendStatus(200);
      }

      if (bookings[booking.date]) {
        bookings[booking.date] = Math.max(
          0, bookings[booking.date] - booking.count
        );
      }

      await send(booking.channel, booking.userId,
        `❌ Оплата не подтверждена.\n\n` +
        `Если ошибка — напишите нам:\n📞 ${CONFIG.PHONE}`
      );

      delete pendingPayments[bookingId];
      delete sessions[booking.userId];
      await notifyTelegram(`❌ Бронь <code>${bookingId}</code> отменена`);
    }

    // Список броней
    if (text === "/bookings") {
      const list = Object.entries(pendingPayments)
        .filter(([, b]) => b.status !== "confirmed")
        .map(([id, b]) => {
          const info = CONFIG.PRICES[b.duration];
          return `🆔 ${id}\n📅 ${formatDate(b.date)}\n🏄 ${b.count} шт | ${info.label}\n💰 ${b.total} руб\n📱 ${b.phone}`;
        })
        .join("\n──────\n");

      await notifyTelegram(
        list ? `📋 <b>Активные брони:</b>\n\n${list}` : "📋 Нет активных броней"
      );
    }

    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

// ================================================
// ОТПРАВКА
// ================================================
async function send(channel, userId, text) {
  try {
    if (channel === "wa") {
      if (!waSocket) {
        console.error("WA socket не готов");
        return;
      }
      await waSocket.sendMessage(userId, { text });
      console.log(`✅ Отправлено ${userId}`);
    } else {
      await axios.post(
        `https://graph.facebook.com/v20.0/me/messages`,
        {
          recipient: { id: userId },
          message:   { text },
        },
        {
          params:  { access_token: CONFIG.PAGE_ACCESS_TOKEN },
          headers: { "Content-Type": "application/json" },
        }
      );
    }
  } catch (err) {
    console.error("Send error:", err?.response?.data || err.message);
  }
}

async function notifyTelegram(text) {
  try {
    await axios.post(
      `https://api.telegram.org/bot${CONFIG.TG_TOKEN}/sendMessage`,
      { chat_id: CONFIG.TG_CHAT_ID, text, parse_mode: "HTML" }
    );
  } catch (err) {
    console.error("TG error:", err.message);
  }
}

// ================================================
// ВСПОМОГАТЕЛЬНЫЕ
// ================================================
function detectGreeting(low) {
  for (const [key, reply] of Object.entries(GREETINGS_MAP)) {
    if (low.includes(key)) return reply;
  }
  return null;
}

function extractNumber(text) {
  const words = {
    "один":1,"одну":1,"одного":1,
    "два":2,"две":2,"двух":2,
    "три":3,"четыре":4,"пять":5,
    "шесть":6,"семь":7,"восемь":8,
    "девять":9,"десять":10,
  };
  for (const [w, n] of Object.entries(words)) {
    if (text.includes(w)) return n;
  }
  const m = text.match(/\b([1-9]|10)\b/);
  return m ? Number(m[1]) : null;
}

function parseDate(text) {
  const m = text.match(/(\d{1,2}
