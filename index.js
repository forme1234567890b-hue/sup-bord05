// ================================================
// SUP BOARD BOT v2.0
// WhatsApp (whatsapp-web.js) + Instagram Директ
// Телефон: 89051160860
// ================================================

import express from "express";
import axios from "axios";
import pkg from "whatsapp-web.js";
const { Client, LocalAuth, MessageMedia } = pkg;
import qrcode from "qrcode-terminal";

const app = express();
app.use(express.json());

// ================================================
// НАСТРОЙКИ
// ================================================
const CONFIG = {
  // Instagram / Meta
  VERIFY_TOKEN:       "sup_board_secret_2025",
  PAGE_ACCESS_TOKEN:  "", // ← заполним ниже

  // Telegram
  TG_TOKEN:   "8878884686:AAGmS94pp2nhkQrHj8hkx8LIbBRmtdn92Xk",
  TG_CHAT_ID: "5208172896",

  // Ваши данные
  PHONE: "89051160860",

  // Цены
  PRICES: {
    "1":   { label: "1 час",    price: 800  },
    "1.5": { label: "1.5 часа", price: 1000 },
    "2":   { label: "2 часа",   price: 1200 },
  },

  CAPACITY:   10,
  SLOT_START: "04:00",
  SLOT_END:   "06:00",
};

// ================================================
// БАЗА ДАННЫХ В ПАМЯТИ
// ================================================
const bookings        = {}; // date -> занято досок
const sessions        = {}; // userId -> состояние
const pendingPayments = {}; // bookingId -> данные

// ================================================
// WHATSAPP КЛИЕНТ
// ================================================
const waClient = new Client({
  authStrategy: new LocalAuth({ clientId: "sup-bot" }),
  puppeteer: {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  },
});

// QR-код для входа
waClient.on("qr", (qr) => {
  console.log("\n📱 СКАНИРУЙТЕ QR-КОД ТЕЛЕФОНОМ:\n");
  qrcode.generate(qr, { small: true });
  console.log("\nWhatsApp → Связанные устройства → Привязать устройство\n");
});

waClient.on("ready", () => {
  console.log("✅ WhatsApp подключён!");
  notifyTelegram("✅ <b>WhatsApp бот запущен!</b>");
});

waClient.on("disconnected", (reason) => {
  console.log("❌ WhatsApp отключён:", reason);
  notifyTelegram("❌ <b>WhatsApp бот отключён!</b>\nПричина: " + reason);
});

// Получаем сообщения WhatsApp
waClient.on("message", async (msg) => {
  try {
    // Игнорируем групповые чаты
    if (msg.from.includes("@g.us")) return;
    // Игнорируем системные
    if (msg.type === "e2e_notification") return;

    const userId = msg.from; // номер@c.us

    if (msg.type === "chat") {
      await handleMessage({
        channel: "wa",
        userId,
        text: msg.body.trim(),
        type: "text",
        waMsg: msg,
      });
    }

    // Фото (чек об оплате)
    if (msg.type === "image" || msg.hasMedia) {
      await handleMessage({
        channel: "wa",
        userId,
        type: "image",
        waMsg: msg,
      });
    }
  } catch (err) {
    console.error("WA message error:", err);
  }
});

waClient.initialize();

// ================================================
// INSTAGRAM WEBHOOK — ВЕРИФИКАЦИЯ
// ================================================
app.get("/webhook", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === CONFIG.VERIFY_TOKEN) {
    console.log("✅ Instagram Webhook verified");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ================================================
// INSTAGRAM WEBHOOK — ПРИЁМ СООБЩЕНИЙ
// ================================================
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;

    if (body.object === "instagram") {
      for (const entry of body.entry || []) {
        for (const event of entry.messaging || []) {
          const sender = event.sender?.id;
          if (!sender) continue;

          // Текст
          if (event.message?.text) {
            await handleMessage({
              channel: "ig",
              userId:  sender,
              text:    event.message.text.trim(),
              type:    "text",
            });
          }

          // Фото (чек)
          if (event.message?.attachments) {
            for (const att of event.message.attachments) {
              if (att.type === "image") {
                await handleMessage({
                  channel:   "ig",
                  userId:    sender,
                  type:      "image",
                  image_url: att.payload.url,
                });
              }
            }
          }
        }
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err);
    res.sendStatus(500);
  }
});

// ================================================
// ПРИВЕТСТВИЯ
// ================================================
const GREETINGS_MAP = {
  "привет":              "Привет! 👋",
  "здравствуйте":        "Здравствуйте! 👋",
  "здравствуй":          "Здравствуйте! 👋",
  "добрый день":         "Добрый день! ☀️",
  "доброе утро":         "Доброе утро! 🌅",
  "добрый вечер":        "Добрый вечер! 🌙",
  "хай":                 "Привет! 👋",
  "салам":               "Ваалейкум ассалам! 👋",
  "салам алейкум":       "Ваалейкум ассалам! 👋",
  "ассалому алайкум":    "Ваалайкум ассалом! 👋",
  "ас-саламу алейкум":   "Ваалейкум ассалам! 👋",
  "ассаламу алейкум":    "Ваалейкум ассалам! 👋",
  "السلام عليكم":        "وعليكم السلام! 👋",
  "سلام":                "وعليكم السلام! 👋",
  "مرحبا":               "أهلاً وسهلاً! 👋",
};

const BOOKING_WORDS = [
  "бронь","бронировать","забронировать",
  "сап","сапборд","sup","сапы","аренда",
  "хочу","записать","записаться","место","доска",
];

// ================================================
// ГЛАВНАЯ ЛОГИКА ДИАЛОГА
// ================================================
async function handleMessage({ channel, userId, text, type, waMsg, image_url }) {

  // ── Фото (чек) ──
  if (type === "image") {
    return await handleReceiptPhoto({ channel, userId, waMsg, image_url });
  }

  const low = text.toLowerCase().trim();
  let s = sessions[userId] || { step: "start", channel };

  // ── Шаги диалога ──
  if (s.step === "confirm")       return await handleConfirm({ channel, userId, low, s });
  if (s.step === "wait_date")     return await handleDate({ channel, userId, low, s });
  if (s.step === "wait_count")    return await handleCount({ channel, userId, low, s });
  if (s.step === "wait_duration") return await handleDuration({ channel, userId, low, s });
  if (s.step === "wait_phone")    return await handlePhone({ channel, userId, text, s });

  // ── Первое сообщение ──
  const hasBooking = BOOKING_WORDS.some(w => low.includes(w));
  const greeting   = detectGreeting(low);

  // Только приветствие
  if (greeting && !hasBooking) {
    return await send(channel, userId,
      `${greeting}\n\n` +
      `🏄 Добро пожаловать!\n` +
      `Хотите забронировать сапборд?\n` +
      `Напишите сколько досок нужно!`
    , waMsg);
  }

  // Приветствие + бронь
  if (greeting && hasBooking) {
    const count = extractNumber(low);
    if (count) {
      s = { step: "wait_duration", channel, count };
      sessions[userId] = s;
      return await send(channel, userId,
        `${greeting}\n\n` +
        `🏄 ${count} сапборда — отлично!\n\n` +
        `⏱ На сколько времени?\n\n` +
        `1️⃣ — 1 час (800 руб)\n` +
        `2️⃣ — 1.5 часа (1000 руб)\n` +
        `3️⃣ — 2 часа (1200 руб)`
      , waMsg);
    }
    s = { step: "wait_count", channel };
    sessions[userId] = s;
    return await send(channel, userId,
      `${greeting}\n\n` +
      `🏄 Хотите забронировать сапборд!\n` +
      `Сколько досок нужно? (1–10)`
    , waMsg);
  }

  // Только бронь
  if (hasBooking) {
    const count = extractNumber(low);
    if (count) {
      s = { step: "wait_duration", channel, count };
      sessions[userId] = s;
      return await send(channel, userId,
        `🏄 ${count} сапборда — хорошо!\n\n` +
        `⏱ На сколько времени?\n\n` +
        `1️⃣ — 1 час (800 руб)\n` +
        `2️⃣ — 1.5 часа (1000 руб)\n` +
        `3️⃣ — 2 часа (1200 руб)`
      , waMsg);
    }
    s = { step: "wait_count", channel };
    sessions[userId] = s;
    return await send(channel, userId,
      `🏄 Забронировать сапборд!\n` +
      `Сколько досок нужно? (1–10)`
    , waMsg);
  }
}

// ================================================
// ОБРАБОТЧИКИ ШАГОВ
// ================================================
async function handleCount({ channel, userId, low, s }) {
  const n = extractNumber(low);
  if (!n || n < 1 || n > CONFIG.CAPACITY) {
    return await send(channel, userId,
      `Введите число от 1 до ${CONFIG.CAPACITY}`
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

  if (low === "1" || low === "один")  duration = "1";
  if (low === "2" || low === "два")   duration = "2";
  if (low === "3")                    duration = "1.5";
  if (low.includes("1.5") || low.includes("полтора")) duration = "1.5";
  if (low.includes("два часа") || low.includes("2 часа")) duration = "2";
  if (low.includes("час") && !low.includes("1.5") && !low.includes("два")) duration = "1";

  if (!duration) {
    return await send(channel, userId,
      `Выберите:\n` +
      `1️⃣ — 1 час\n` +
      `2️⃣ — 1.5 часа\n` +
      `3️⃣ — 2 часа`
    );
  }

  s.duration = duration;
  s.step = "wait_date";
  sessions[userId] = s;

  const info = CONFIG.PRICES[duration];
  return await send(channel, userId,
    `✅ ${info.label} — ${info.price} руб за доску\n\n` +
    `📅 На какую дату?\n` +
    `Формат: дд.мм.гггг\n` +
    `Пример: 20.07.2025`
  );
}

async function handleDate({ channel, userId, low, s }) {
  const date = parseDate(low);
  if (!date) {
    return await send(channel, userId,
      `❌ Не понял дату.\n` +
      `Напишите в формате: 20.07.2025`
    );
  }

  if (new Date(date) < new Date(new Date().toDateString())) {
    return await send(channel, userId,
      `❌ Эта дата уже прошла.\nВведите будущую дату.`
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

  s.date = date;
  s.step = "confirm";
  sessions[userId] = s;

  const info  = CONFIG.PRICES[s.duration];
  const total = info.price * s.count;
  s.total     = total;

  return await send(channel, userId,
    `✅ Есть места на ${formatDate(date)}!\n\n` +
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
  if (low === "да" || low === "yes" || low === "подтверждаю") {
    s.step = "wait_phone";
    sessions[userId] = s;
    return await send(channel, userId, `📞 Укажите ваш номер телефона:`);
  }

  if (low === "нет" || low === "no" || low === "отмена") {
    delete sessions[userId];
    return await send(channel, userId,
      `Хорошо, бронь отменена.\n` +
      `Если захотите — напишите снова 🏄`
    );
  }

  return await send(channel, userId, `Ответьте: Да или Нет`);
}

async function handlePhone({ channel, userId, text, s }) {
  const phone = text.replace(/\s/g, "");

  if (phone.length < 10) {
    return await send(channel, userId,
      `❌ Введите корректный номер телефона`
    );
  }

  s.phone = phone;
  const bookingId = generateId();
  s.bookingId = bookingId;

  // Сохраняем
  bookings[s.date] = (bookings[s.date] || 0) + s.count;
  pendingPayments[bookingId] = {
    ...s, userId, channel, createdAt: new Date()
  };

  const info = CONFIG.PRICES[s.duration];

  await notifyTelegram(
    `🆕 <b>НОВАЯ БРОНЬ!</b>\n\n` +
    `🆔 Бронь: <code>${bookingId}</code>\n` +
    `👤 Телефон: ${phone}\n` +
    `📅 Дата: ${formatDate(s.date)}\n` +
    `⏱ ${info.label}\n` +
    `🏄 ${s.count} сапборда\n` +
    `💰 ${s.total} руб\n` +
    `📱 Канал: ${channel === "ig" ? "Instagram" : "WhatsApp"}\n\n` +
    `⏳ Ожидает оплату...\n\n` +
    `✅ Подтвердить: /confirm_${bookingId}\n` +
    `❌ Отменить: /cancel_${bookingId}`
  );

  s.step = "wait_receipt";
  sessions[userId] = s;

  return await send(channel, userId,
    `🎉 Бронь создана!\n\n` +
    `🆔 Номер брони: ${bookingId}\n\n` +
    `💳 Оплатите:\n` +
    `Номер: ${CONFIG.PHONE}\n` +
    `Банк: Сбербанк / СБП\n` +
    `Сумма: ${s.total} руб\n\n` +
    `📸 После оплаты скиньте фото чека!\n\n` +
    `⚠️ Бронь временная (24 часа)`
  );
}

// ================================================
// ОБРАБОТКА ФОТО ЧЕКА
// ================================================
async function handleReceiptPhoto({ channel, userId, waMsg, image_url }) {
  const s = sessions[userId];

  if (!s || s.step !== "wait_receipt") {
    return await send(channel, userId,
      `Чек получен! ✅\nПроверяем... ожидайте.`
    );
  }

  const bookingId = s.bookingId;
  const info      = CONFIG.PRICES[s.duration];

  await notifyTelegram(
    `📸 <b>ПОЛУЧЕН ЧЕК!</b>\n\n` +
    `🆔 Бронь: <code>${bookingId}</code>\n` +
    `👤 Тел: ${s.phone}\n` +
    `📅 ${formatDate(s.date)}\n` +
    `⏱ ${info.label}\n` +
    `🏄 ${s.count} сапборда\n` +
    `💰 ${s.total} руб\n\n` +
    `✅ Подтвердить: /confirm_${bookingId}\n` +
    `❌ Отклонить: /cancel_${bookingId}`
  );

  s.step = "waiting_confirm";
  sessions[userId] = s;

  return await send(channel, userId,
    `✅ Чек получен!\n\n` +
    `Проверяем оплату...\n` +
    `Подтверждение придёт в течение 5–10 минут ⏳\n\n` +
    `🆔 Ваша бронь: ${bookingId}`
  );
}

// ================================================
// TELEGRAM — ПОДТВЕРЖДЕНИЕ / ОТМЕНА
// ================================================
app.post(`/tg_${CONFIG.TG_TOKEN}`, async (req, res) => {
  try {
    const msg = req.body.message;
    if (!msg?.text) return res.sendStatus(200);

    const text = msg.text.trim();

    // /confirm_SUPXXX
    if (text.startsWith("/confirm_")) {
      const bookingId = text.replace("/confirm_", "");
      const booking   = pendingPayments[bookingId];

      if (!booking) {
        await notifyTelegram(`❌ Бронь ${bookingId} не найдена`);
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
      await notifyTelegram(`✅ Бронь ${bookingId} подтверждена!`);
    }

    // /cancel_SUPXXX
    if (text.startsWith("/cancel_")) {
      const bookingId = text.replace("/cancel_", "");
      const booking   = pendingPayments[bookingId];

      if (!booking) {
        await notifyTelegram(`❌ Бронь ${bookingId} не найдена`);
        return res.sendStatus(200);
      }

      if (bookings[booking.date]) {
        bookings[booking.date] = Math.max(
          0, bookings[booking.date] - booking.count
        );
      }

      await send(booking.channel, booking.userId,
        `❌ Оплата не подтверждена.\n\n` +
        `Если ошибка — напишите: ${CONFIG.PHONE}\n` +
        `Или начните бронь заново.`
      );

      delete pendingPayments[bookingId];
      delete sessions[booking.userId];
      await notifyTelegram(`❌ Бронь ${bookingId} отменена`);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

// ================================================
// ОТПРАВКА СООБЩЕНИЙ
// ================================================
async function send(channel, userId, text, waMsg = null) {
  try {
    if (channel === "wa") {
      // Через whatsapp-web.js
      const chatId = userId.includes("@c.us")
        ? userId
        : `${userId}@c.us`;
      await waClient.sendMessage(chatId, text);

    } else {
      // Instagram
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
  if (!CONFIG.TG_TOKEN || !CONFIG.TG_CHAT_ID) return;
  try {
    await axios.post(
      `https://api.telegram.org/bot${CONFIG.TG_TOKEN}/sendMessage`,
      {
        chat_id:    CONFIG.TG_CHAT_ID,
        text,
        parse_mode: "HTML",
      }
    );
  } catch (err) {
    console.error("Telegram error:", err.message);
  }
}

// ================================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
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
    "два":2,"две":2,
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
  const m = text.match(/(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{4})/);
  if (!m) return null;
  const d  = m[1].padStart(2, "0");
  const mo = m[2].padStart(2, "0");
  const y  = m[3];
  return `${y}-${mo}-${d}`;
}

function formatDate(iso) {
  const [y, mo, d] = iso.split("-");
  return `${d}.${mo}.${y}`;
}

function generateId() {
  return "SUP" + Date.now().toString(36).toUpperCase();
}

// ================================================
// ЗАПУСК
// ================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🏄 SUP Bot v2.0 запущен на порту ${PORT}`);
});
