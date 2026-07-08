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
  TG_TOKEN:   "8878884686:AAGmS94pp2nhkQrHj8hkx8LIbBRmtdn92Xk",
  TG_CHAT_ID: "5208172896",
  PHONE:      "89051160860",
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
let   waSocket        = null;

// ================================================
// СТРАНИЦЫ
// ================================================
app.get("/", (req, res) => {
  res.send(
    "<html><body style='font-family:sans-serif;padding:40px'>" +
    "<h1>SUP Board Bot v4.0</h1>" +
    "<p>Сервер работает</p>" +
    "<a href='/qr'>Открыть QR-код WhatsApp</a>" +
    "</body></html>"
  );
});

app.get("/qr", async (req, res) => {
  if (!lastQR) {
    return res.send(
      "<html><body style='font-family:sans-serif;text-align:center;padding:40px'>" +
      "<h2>WhatsApp подключён!</h2>" +
      "<p>Бот работает</p>" +
      "<script>setTimeout(()=>location.reload(),10000)</script>" +
      "</body></html>"
    );
  }
  const qrImage = await qrcode.toDataURL(lastQR);
  res.send(
    "<html><body style='font-family:sans-serif;text-align:center;padding:40px;background:#f0f0f0'>" +
    "<h2>Сканируйте QR-код WhatsApp</h2>" +
    "<p>WhatsApp → Связанные устройства → Привязать устройство</p>" +
    "<img src='" + qrImage + "' style='width:300px;border:3px solid #25D366;border-radius:12px'/>" +
    "<script>setTimeout(()=>location.reload(),25000)</script>" +
    "</body></html>"
  );
});

// ================================================
// WHATSAPP
// ================================================
async function startWhatsApp() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState("auth_info");
    const { version }          = await fetchLatestBaileysVersion();

    waSocket = makeWASocket({
      version,
      auth:              state,
      logger:            pino({ level: "silent" }),
      printQRInTerminal: true,
      getMessage:        async () => ({ conversation: "" }),
    });

    waSocket.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        lastQR = qr;
        console.log("QR готов! Откройте /qr");
      }

      if (connection === "close") {
        const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
        console.log("WA closed, code:", code);
        if (code !== DisconnectReason.loggedOut) {
          console.log("Переподключение через 3 сек...");
          setTimeout(startWhatsApp, 3000);
        } else {
          lastQR = null;
        }
      }

      if (connection === "open") {
        lastQR = null;
        console.log("WhatsApp подключён!");
        await notifyTelegram("WhatsApp бот подключён!");
      }
    });

    waSocket.ev.on("creds.update", saveCreds);

    waSocket.ev.on("messages.upsert", async (m) => {
      try {
        const messages = m.messages;
        if (!messages || messages.length === 0) return;

        for (const msg of messages) {
          if (msg.key.fromMe) continue;
          if (msg.key.remoteJid.endsWith("@g.us")) continue;
          if (!msg.message) continue;

          const userId = msg.key.remoteJid;

          const text =
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            msg.message?.buttonsResponseMessage?.selectedDisplayText ||
            msg.message?.listResponseMessage?.title ||
            "";

          if (msg.message?.imageMessage || msg.message?.documentMessage) {
            console.log("Фото от " + userId);
            await handleReceiptPhoto({ userId });
            continue;
          }

          if (text && text.trim().length > 0) {
            console.log("Сообщение от " + userId + ": " + text);
            await handleMessage({ userId, text: text.trim() });
          }
        }
      } catch (err) {
        console.error("Ошибка обработки:", err);
      }
    });

  } catch (err) {
    console.error("Ошибка запуска WhatsApp:", err);
    setTimeout(startWhatsApp, 5000);
  }
}

startWhatsApp();

// ================================================
// ГЛАВНАЯ ЛОГИКА
// ================================================
async function handleMessage({ userId, text }) {
  try {
    const low = text.toLowerCase().trim();

    if (!sessions[userId]) {
      sessions[userId] = { step: "start" };
    }

    const s = sessions[userId];
    console.log("Сессия " + userId + " шаг: " + s.step);

    if (s.step === "wait_count")    return await handleCount({ userId, low, s });
    if (s.step === "wait_duration") return await handleDuration({ userId, low, s });
    if (s.step === "wait_date")     return await handleDate({ userId, low, s });
    if (s.step === "confirm")       return await handleConfirm({ userId, low, s });
    if (s.step === "wait_phone")    return await handlePhone({ userId, text, s });

    if (s.step === "wait_receipt") {
      return await sendWA(userId,
        "Ожидаем фото чека об оплате.\n" +
        "Сфотографируйте чек и отправьте сюда"
      );
    }

    if (s.step === "waiting_confirm") {
      return await sendWA(userId,
        "Ваш чек уже получен!\n" +
        "Ожидайте подтверждения (5-10 минут)"
      );
    }

    // Стартовый шаг
    const BOOKING_WORDS = [
      "бронь","бронировать","забронировать",
      "сап","сапборд","sup","аренда",
      "хочу","записаться","доска","доски",
    ];

    const GREETINGS = [
      "привет","здравствуйте","здравствуй",
      "добрый","доброе","хай","салам",
    ];

    const hasBooking  = BOOKING_WORDS.some(w => low.includes(w));
    const hasGreeting = GREETINGS.some(w => low.includes(w));

    if (hasGreeting && !hasBooking) {
      return await sendWA(userId,
        "Привет!\n\n" +
        "Хотите забронировать сапборд?\n" +
        "Напишите: Хочу забронировать 2 доски"
      );
    }

    if (hasBooking) {
      const count = extractNumber(low);
      if (count) {
        s.step  = "wait_duration";
        s.count = count;
        return await sendWA(userId,
          "Отлично! " + count + " сапборда.\n\n" +
          "На сколько времени?\n\n" +
          "1 - 1 час (800 руб)\n" +
          "2 - 1.5 часа (1000 руб)\n" +
          "3 - 2 часа (1200 руб)"
        );
      }
      s.step = "wait_count";
      return await sendWA(userId,
        "Сколько досок нужно? (1-10)\n" +
        "Напишите цифру"
      );
    }

    return await sendWA(userId,
      "Привет! Я бот аренды сапбордов.\n\n" +
      "Напишите:\n" +
      "Хочу забронировать\n\n" +
      "И я помогу!"
    );

  } catch (err) {
    console.error("handleMessage error:", err);
  }
}

// ================================================
// ШАГИ
// ================================================
async function handleCount({ userId, low, s }) {
  const n = extractNumber(low);
  if (!n || n < 1 || n > CONFIG.CAPACITY) {
    return await sendWA(userId, "Введите число от 1 до " + CONFIG.CAPACITY);
  }
  s.count = n;
  s.step  = "wait_duration";
  return await sendWA(userId,
    "На сколько времени?\n\n" +
    "1 - 1 час (800 руб)\n" +
    "2 - 1.5 часа (1000 руб)\n" +
    "3 - 2 часа (1200 руб)"
  );
}

async function handleDuration({ userId, low, s }) {
  let duration = null;

  if (low === "1" || low.includes("один час") || low.includes("1 час")) duration = "1";
  if (low === "2" || low.includes("два часа") || low.includes("2 часа")) duration = "2";
  if (low === "3" || low.includes("1.5") || low.includes("полтора"))     duration = "1.5";

  if (!duration) {
    return await sendWA(userId,
      "Выберите цифру:\n\n" +
      "1 - 1 час (800 руб)\n" +
      "2 - 1.5 часа (1000 руб)\n" +
      "3 - 2 часа (1200 руб)"
    );
  }

  s.duration = duration;
  s.step     = "wait_date";

  const info = CONFIG.PRICES[duration];
  return await sendWA(userId,
    "Отлично! " + info.label + " - " + info.price + " руб за доску\n\n" +
    "На какую дату?\n\n" +
    "Можете написать:\n" +
    "- Сегодня\n" +
    "- Завтра\n" +
    "- Послезавтра\n" +
    "- Или дату: 20.07.2025"
  );
}

async function handleDate({ userId, low, s }) {
  let date = null;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (low.includes("послезавтра")) {
    const d = new Date(today);
    d.setDate(d.getDate() + 2);
    date = formatISO(d);
  } else if (low.includes("завтра")) {
    const d = new Date(today);
    d.setDate(d.getDate() + 1);
    date = formatISO(d);
  } else if (low.includes("сегодня")) {
    date = formatISO(today);
  } else {
    date = parseDate(low);
  }

  if (!date) {
    return await sendWA(userId,
      "Не понял дату.\n\n" +
      "Напишите:\n" +
      "- Сегодня\n" +
      "- Завтра\n" +
      "- Послезавтра\n" +
      "- Или: 20.07.2025"
    );
  }

  const dateObj = new Date(date);
  dateObj.setHours(0, 0, 0, 0);

  if (dateObj < today) {
    return await sendWA(userId,
      "Эта дата уже прошла.\n" +
      "Введите сегодня, завтра или будущую дату."
    );
  }

  const booked    = bookings[date] || 0;
  const remaining = CONFIG.CAPACITY - booked;

  if (remaining < s.count) {
    return await sendWA(userId,
      "На " + formatDate(date) + " осталось только " + remaining + " мест.\n" +
      "Выберите другую дату или меньше досок."
    );
  }

  s.date  = date;
  s.step  = "confirm";

  const info  = CONFIG.PRICES[s.duration];
  const total = info.price * s.count;
  s.total     = total;

  return await sendWA(userId,
    "Места есть на " + formatDate(date) + "!\n\n" +
    "Ваш заказ:\n" +
    s.count + " сапборда\n" +
    info.label + "\n" +
    formatDate(date) + "\n" +
    "Итого: " + total + " руб\n\n" +
    "УСЛОВИЯ:\n" +
    "При неявке - оплата не возвращается\n" +
    "При плохой погоде - перенос или возврат\n\n" +
    "Подтверждаете? Ответьте: Да или Нет"
  );
}

async function handleConfirm({ userId, low, s }) {
  if (["да","yes","подтверждаю","конечно","ок","хорошо"].some(w => low.includes(w))) {
    s.step = "wait_phone";
    return await sendWA(userId,
      "Укажите ваш номер телефона:\n" +
      "Например: +79001234567"
    );
  }

  if (["нет","no","отмена","отменить"].some(w => low.includes(w))) {
    delete sessions[userId];
    return await sendWA(userId,
      "Бронь отменена.\n" +
      "Если захотите - напишите снова!"
    );
  }

  return await sendWA(userId,
    "Пожалуйста ответьте:\n" +
    "Да - подтвердить\n" +
    "Нет - отменить"
  );
}

async function handlePhone({ userId, text, s }) {
  const phone = text.replace(/[\s\-\(\)]/g, "");

  if (phone.length < 10) {
    return await sendWA(userId,
      "Введите корректный номер\n" +
      "Например: +79001234567"
    );
  }

  s.phone = phone;
  const bookingId = generateId();
  s.bookingId     = bookingId;

  bookings[s.date] = (bookings[s.date] || 0) + s.count;

  pendingPayments[bookingId] = {
    ...s, userId, createdAt: new Date(),
  };

  const info = CONFIG.PRICES[s.duration];

  await notifyTelegram(
    "НОВАЯ БРОНЬ!\n\n" +
    "ID: " + bookingId + "\n" +
    "Тел: " + phone + "\n" +
    formatDate(s.date) + "\n" +
    info.label + "\n" +
    s.count + " сапборда\n" +
    s.total + " руб\n\n" +
    "Подтвердить: /confirm_" + bookingId + "\n" +
    "Отменить: /cancel_" + bookingId
  );

  s.step = "wait_receipt";

  return await sendWA(userId,
    "Бронь создана!\n\n" +
    "Номер брони: " + bookingId + "\n\n" +
    "Оплатите:\n" +
    "Номер: " + CONFIG.PHONE + "\n" +
    "Банк: Сбербанк / СБП\n" +
    "Сумма: " + s.total + " руб\n\n" +
    "После оплаты отправьте фото чека!\n\n" +
    "Бронь действует 24 часа"
  );
}

async function handleReceiptPhoto({ userId }) {
  const s = sessions[userId];

  if (!s || (s.step !== "wait_receipt" && s.step !== "waiting_confirm")) {
    return await sendWA(userId, "Фото получено! Спасибо.");
  }

  const bookingId = s.bookingId;
  const info      = CONFIG.PRICES[s.duration];

  await notifyTelegram(
    "ЧЕК ПОЛУЧЕН!\n\n" +
    "ID: " + bookingId + "\n" +
    "Тел: " + s.phone + "\n" +
    formatDate(s.date) + "\n" +
    info.label + "\n" +
    s.count + " сапборда\n" +
    s.total + " руб\n\n" +
    "Подтвердить: /confirm_" + bookingId + "\n" +
    "Отменить: /cancel_" + bookingId
  );

  s.step = "waiting_confirm";

  return await sendWA(userId,
    "Чек получен!\n\n" +
    "Проверяем оплату...\n" +
    "Подтверждение придёт в течение 5-10 минут\n\n" +
    "Ваша бронь: " + bookingId
  );
}

// ================================================
// TELEGRAM КОМАНДЫ
// ================================================
app.post("/tg_webhook", async (req, res) => {
  try {
    const msg = req.body.message;
    if (!msg?.text) return res.sendStatus(200);

    const text = msg.text.trim();

    if (text.startsWith("/confirm_")) {
      const bookingId = text.replace("/confirm_", "");
      const booking   = pendingPayments[bookingId];

      if (!booking) {
        await notifyTelegram("Бронь " + bookingId + " не найдена");
        return res.sendStatus(200);
      }

      const info = CONFIG.PRICES[booking.duration];

      await sendWA(booking.userId,
        "Оплата подтверждена!\n\n" +
        "Ваша бронь:\n" +
        "ID: " + bookingId + "\n" +
        formatDate(booking.date) + "\n" +
        info.label + "\n" +
        booking.count + " сапборда\n\n" +
        "Ждём вас!\n" +
        "По вопросам: " + CONFIG.PHONE
      );

      delete sessions[booking.userId];
      await notifyTelegram("Бронь " + bookingId + " подтверждена!");
    }

    if (text.startsWith("/cancel_")) {
      const bookingId = text.replace("/cancel_", "");
      const booking   = pendingPayments[bookingId];

      if (!booking) {
        await notifyTelegram("Бронь " + bookingId + " не найдена");
        return res.sendStatus(200);
      }

      if (bookings[booking.date]) {
        bookings[booking.date] = Math.max(0, bookings[booking.date] - booking.count);
      }

      await sendWA(booking.userId,
        "Оплата не подтверждена.\n\n" +
        "Если ошибка - напишите нам:\n" +
        CONFIG.PHONE
      );

      delete pendingPayments[bookingId];
      delete sessions[booking.userId];
      await notifyTelegram("Бронь " + bookingId + " отменена");
    }

    if (text === "/bookings") {
      const list = Object.entries(pendingPayments)
        .map(([id, b]) => {
          const info = CONFIG.PRICES[b.duration];
          return "ID: " + id + "\n" +
                 formatDate(b.date) + "\n" +
                 b.count + " шт | " + info.label + "\n" +
                 b.total + " руб | " + b.phone;
        })
        .join("\n---\n");

      await notifyTelegram(list || "Нет активных броней");
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
async function sendWA(userId, text) {
  try {
    if (!waSocket) {
      console.error("WA socket не готов");
      return;
    }
    await waSocket.sendMessage(userId, { text });
    console.log("Отправлено: " + userId);
  } catch (err) {
    console.error("Send error:", err?.message);
  }
}

async function notifyTelegram(text) {
  try {
    await axios.post(
      "https://api.telegram.org/bot" + CONFIG.TG_TOKEN + "/sendMessage",
      { chat_id: CONFIG.TG_CHAT_ID, text }
    );
  } catch (err) {
    console.error("TG error:", err.message);
  }
}

// ================================================
// ВСПОМОГАТЕЛЬНЫЕ
// ================================================
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

function formatISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + d;
}

function parseDate(text) {
  const m1 = text.match(/(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{4})/);
  if (m1) {
    const d = m1[1].padStart(2,"0");
    const mo = m1[2].padStart(2,"0");
    const y = m1[3];
    return y + "-" + mo + "-" + d;
  }
  const m2 = text.match(/(\d{1,2})[.\-\/](\d{1,2})/);
  if (m2) {
    const d = m2[1].padStart(2,"0");
    const mo = m2[2].padStart(2,"0");
    const y = new Date().getFullYear();
    return y + "-" + mo + "-" + d;
  }
  return null;
}

function formatDate(iso) {
  const [y, m, d] = iso.split("-");
  const months = [
    "января","февраля","марта","апреля",
    "мая","июня","июля","августа",
    "сентября","октября","ноября","декабря"
  ];
  return d + " " + months[Number(m) - 1] + " " + y;
}

function generateId() {
  return "SUP" + Date.now().toString(36).toUpperCase();
}

// ================================================
// ЗАПУСК
// ================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Сервер запущен на порту " + PORT);
});
