// ================================================
// SUP BOARD BOT v3.0
// Baileys (WhatsApp) + Instagram Директ
// Railway совместимый
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

// ================================================
// НАСТРОЙКИ
// ================================================
const CONFIG = {
  VERIFY_TOKEN:      "sup_board_secret_2025",
  PAGE_ACCESS_TOKEN: "", // ← вставь Instagram токен

  TG_TOKEN:   "8878884686:AAGmS94pp2nhkQrHj8hkx8LIbBRmtdn92Xk",
  TG_CHAT_ID: "5208172896",

  PHONE: "89051160860",

  PRICES: {
    "1":   { label: "1 час",    price: 800  },
    "1.5": { label: "1.5 часа", price: 1000 },
    "2":   { label: "2 часа",   price: 1200 },
  },

  CAPACITY: 10,
};

// ================================================
// БАЗА ДАННЫХ В ПАМЯТИ
// ================================================
const bookings        = {};
const sessions        = {};
const pendingPayments = {};

// ================================================
// QR-КОД СТРАНИЦА (открываешь в браузере)
// ================================================
let lastQR = null;

app.get("/qr", async (req, res) => {
  if (!lastQR) {
    return res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px">
        <h2>⏳ QR код ещё не готов</h2>
        <p>Обновите страницу через 5 секунд</p>
        <script>setTimeout(()=>location.reload(),5000)</script>
      </body></html>
    `);
  }

  const qrImage = await qrcode.toDataURL(lastQR);
  res.send(`
    <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#f0f0f0">
      <h2>📱 Сканируйте QR-код WhatsApp</h2>
      <p>WhatsApp → Связанные устройства → Привязать устройство</p>
      <img src="${qrImage}" style="width:300px;border:3px solid #25D366;border-radius:12px"/>
      <p style="color:gray">Страница обновится автоматически после входа</p>
      <script>setTimeout(()=>location.reload(),30000)</script>
    </body></html>
  `);
});

app.get("/", (req, res) => {
  res.send(`
    <html><body style="font-family:sans-serif;padding:40px">
      <h1>🏄 SUP Board Bot</h1>
      <p>✅ Сервер работает</p>
      <p><a href="/qr">📱 Открыть QR-код WhatsApp</a></p>
    </body></html>
  `);
});

// ================================================
// WHATSAPP — BAILEYS
// ================================================
let waSocket = null;

async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");
  const { version }          = await fetchLatestBaileysVersion();

  waSocket = makeWASocket({
    version,
    auth:   state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: true, // QR в терминале Railway
  });

  // Сохраняем QR для браузера
  waSocket.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      lastQR = qr;
      console.log("\n📱 QR готов! Откройте: https://ВАШ_ДОМЕН.railway.app/qr\n");
    }

    if (connection === "close") {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;

      console.log("WA disconnected, code:", code);

      if (shouldReconnect) {
        console.log("🔄 Переподключение...");
        setTimeout(startWhatsApp, 3000);
      } else {
        console.log("❌ Выполнен выход. Удалите папку auth_info");
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

  // Входящие сообщения
  waSocket.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      try {
        // Игнорируем свои сообщения
        if (msg.key.fromMe) continue;
        // Игнорируем группы
        if (msg.key.remoteJid.includes("@g.us")) continue;

        const userId = msg.key.remoteJid;
        const text   = msg.message?.conversation
                    || msg.message?.extendedTextMessage?.text
                    || "";

        // Фото (чек)
        if (msg.message?.imageMessage) {
          await handleMessage({
            channel: "wa",
            userId,
            type: "image",
          });
          continue;
        }

        if (text) {
          await handleMessage({
            channel: "wa",
            userId,
            text: text.trim(),
            type: "text",
          });
        }
      } catch (err) {
        console.error("WA msg error:", err);
      }
    }
  });
}

startWhatsApp();

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

          if (event.message?.text) {
            await handleMessage({
              channel: "ig",
              userId:  sender,
              text:    event.message.text.trim(),
              type:    "text",
            });
          }

          if (event.message?.attachments) {
            for (const att of event.message.attachments) {
              if (att.type === "image") {
                await handleMessage({
                  channel: "ig",
                  userId:  sender,
                  type:    "image",
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
  "привет":             "Привет! 👋",
  "здравствуйте":       "Здравствуйте! 👋",
  "здравствуй":         "Здравствуйте! 👋",
  "добрый день":        "Добрый день! ☀️",
  "доброе утро":        "Доброе утро! 🌅",
  "добрый вечер":       "Добрый вечер! 🌙",
  "хай":                "Привет! 👋",
  "салам":              "Ваалейкум ассалам! 👋",
  "салам алейкум":      "Ваалейкум ассалам! 👋",
  "ассалому алайкум":   "Ваалайкум ассалом! 👋",
  "ас-саламу алейкум":  "Ваалейкум ассалам! 👋",
  "السلام عليكم":       "وعليكم السلام! 👋",
  "سلام":               "وعليكم السلام! 👋",
  "مرحبا":              "أهلاً وسهلاً! 👋",
};

const BOOKING_WORDS = [
  "бронь","бронировать","забронировать",
  "сап","сапборд","sup","сапы","аренда",
  "хочу","записать","записаться","место","доска",
];

// ================================================
// ГЛАВНАЯ ЛОГИКА
// ================================================
async function handleMessage({ channel, userId, text, type }) {

  if (type === "image") {
    return await handleReceiptPhoto({ channel, userId });
  }

  const low = text.toLowerCase().trim();
  let s = sessions[userId] || { step: "start", channel };

  if (s.step === "confirm")       return await handleConfirm({ channel, userId, low, s });
  if (s.step === "wait_date")     return await handleDate({ channel, userId, low, s });
  if (s.step === "wait_count")    return await handleCount({ channel, userId, low, s });
  if (s.step === "wait_duration") return await handleDuration({ channel, userId, low, s });
  if (s.step === "wait_phone")    return await handlePhone({ channel, userId, text, s });

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
      );
    }
    s = { step: "wait_count", channel };
    sessions[userId] = s;
    return await send(channel, userId,
      `${greeting}\n\n` +
      `🏄 Хотите забронировать сапборд!\n` +
      `Сколько досок нужно? (1–10)`
    );
  }

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
      );
    }
    s = { step: "wait_count", channel };
    sessions[userId] = s;
    return await send(channel, userId,
      `🏄 Забронировать сапборд!\n` +
      `Сколько досок нужно? (1–10)`
    );
  }
}

// ================================================
// ШАГИ ДИАЛОГА
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

  if (low === "1" || low === "один")                            duration = "1";
  if (low === "2" || low === "два")                             duration = "2";
  if (low === "3")                                              duration = "1.5";
  if (low.includes("1.5") || low.includes("полтора"))          duration = "1.5";
  if (low.includes("два часа") || low.includes("2 часа"))      duration = "2";
  if (low.includes("час") && !low.includes("1.5")
      && !low.includes("два") && !low.includes("полтора"))     duration = "1";

  if (!duration) {
    return await send(channel, userId,
      `Выберите:\n` +
      `1️⃣ — 1 час\n` +
      `2️⃣ — 1.5 часа\n` +
      `3️⃣ — 2 часа`
    );
  }

  s.duration = duration;
  s.step     = "wait_date";
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
      `❌ Не понял дату.\nНапишите: 20.07.2025`
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
  if (["да","yes","подтверждаю"].includes(low)) {
    s.step = "wait_phone";
    sessions[userId] = s;
    return await send(channel, userId, `📞 Укажите ваш номер телефона:`);
  }

  if (["нет","no","отмена"].includes(low)) {
    delete sessions[userId];
    return await send(channel, userId,
      `Хорошо, бронь отменена.\nЕсли захотите — напишите снова 🏄`
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
    `✅ /confirm_${bookingId}\n` +
    `❌ /cancel_${bookingId}`
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
// ЧЕК
// ================================================
async function handleReceiptPhoto({ channel, userId }) {
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
    `✅ /confirm_${bookingId}\n` +
    `❌ /cancel_${bookingId}`
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
// TELEGRAM КОМАНДЫ
// ================================================
app.post(`/tg_${CONFIG.TG_TOKEN}`, async (req, res) => {
  try {
    const msg = req.body.message;
    if (!msg?.text) return res.sendStatus(200);

    const text = msg.text.trim();

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
async function send(channel, userId, text) {
  try {
    if (channel === "wa") {
      if (!waSocket) return;
      await waSocket.sendMessage(userId, { text });
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
  console.log(`🏄 SUP Bot v3.0 запущен на порту ${PORT}`);
  console.log(`📱 QR-код: https://ВАШ_ДОМЕН.railway.app/qr`);
});
