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
  CAPACITY:   10,
  GROUPS: {
    "1": { label: "4:00 - 5:00", arrive: "в 3:50" },
    "2": { label: "5:00 - 6:00", arrive: "в 5:00" },
  },
  PRICES: {
    "1":   { label: "1 час",    price: 800  },
    "1.5": { label: "1.5 часа", price: 1000 },
    "2":   { label: "2 часа",   price: 1200 },
  },
};

const bookings        = {};
const sessions        = {};
const pendingPayments = {};
let   lastQR          = null;
let   waSocket        = null;

const SAP_WORDS = [
  "бронь","бронировать","забронировать","сап","сапборд",
  "sup","аренда","хочу","записаться","доска","доски","board","сапы",
];
const GREET_WORDS = [
  "привет","здравствуйте","здравствуй","добрый",
  "доброе","хай","салам","hello","hi",
];

function getBooked(date, group) {
  if (!bookings[date]) return 0;
  if (!bookings[date][group]) return 0;
  return bookings[date][group];
}

function getNextAvailableDate(fromDate) {
  const d = new Date(fromDate);
  for (let i = 1; i <= 30; i++) {
    d.setDate(d.getDate() + 1);
    const iso = formatISO(d);
    if (getBooked(iso, "1") < CONFIG.CAPACITY || getBooked(iso, "2") < CONFIG.CAPACITY) {
      return iso;
    }
  }
  return null;
}

function extractNumber(text) {
  const words = {
    "один":1,"одну":1,"одного":1,"одной":1,
    "два":2,"две":2,"двух":2,"двое":2,
    "три":3,"трёх":3,"трех":3,"трое":3,
    "четыре":4,"четырёх":4,"четырех":4,
    "пять":5,"шесть":6,"семь":7,
    "восемь":8,"девять":9,"десять":10,
  };
  for (const [w, n] of Object.entries(words)) {
    if (text.includes(w)) return n;
  }
  const m = text.match(/\b([1-9]|10)\b/);
  return m ? Number(m[1]) : null;
}

function formatISO(date) {
  const y  = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, "0");
  const d  = String(date.getDate()).padStart(2, "0");
  return y + "-" + mo + "-" + d;
}

function parseDate(text) {
  const m1 = text.match(/(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{4})/);
  if (m1) {
    return m1[3] + "-" + m1[2].padStart(2,"0") + "-" + m1[1].padStart(2,"0");
  }
  const m2 = text.match(/(\d{1,2})[.\-\/](\d{1,2})/);
  if (m2) {
    const y = new Date().getFullYear();
    return y + "-" + m2[2].padStart(2,"0") + "-" + m2[1].padStart(2,"0");
  }
  return null;
}

function formatDate(iso) {
  const parts = iso.split("-");
  const m = Number(parts[1]);
  const months = [
    "января","февраля","марта","апреля","мая","июня",
    "июля","августа","сентября","октября","ноября","декабря",
  ];
  return parts[2] + " " + months[m - 1] + " " + parts[0];
}

function generateId() {
  return "SUP" + Date.now().toString(36).toUpperCase();
}

async function notifyTelegram(text) {
  try {
    await axios.post(
      "https://api.telegram.org/bot" + CONFIG.TG_TOKEN + "/sendMessage",
      { chat_id: CONFIG.TG_CHAT_ID, text: text }
    );
  } catch (err) {
    console.error("TG notify error:", err.message);
  }
}

async function sendWA(userId, text) {
  try {
    if (!waSocket) { console.error("WA socket не готов"); return; }
    await waSocket.sendMessage(userId, { text: text });
  } catch (err) {
    console.error("WA send error:", err.message);
  }
}

async function sendMsg(channel, userId, text) {
  if (channel === "wa") return await sendWA(userId, text);
}

app.get("/", (req, res) => {
  res.send(
    "<html><body style='font-family:sans-serif;padding:40px'>" +
    "<h1>SUP Board Bot</h1><p>Сервер работает!</p>" +
    "<a href='/qr'>Открыть QR WhatsApp</a>" +
    "</body></html>"
  );
});

app.get("/qr", async (req, res) => {
  if (!lastQR) {
    return res.send(
      "<html><body style='text-align:center;padding:40px'>" +
      "<h2>WhatsApp подключён!</h2>" +
      "<script>setTimeout(()=>location.reload(),10000)</script>" +
      "</body></html>"
    );
  }
  const qrImage = await qrcode.toDataURL(lastQR);
  res.send(
    "<html><body style='text-align:center;padding:40px'>" +
    "<h2>Сканируйте QR WhatsApp</h2>" +
    "<img src='" + qrImage + "' style='width:300px'/>" +
    "<script>setTimeout(()=>location.reload(),25000)</script>" +
    "</body></html>"
  );
});

app.post("/tg_webhook", async (req, res) => {
  try {
    const msg = req.body.message;
    if (!msg || !msg.text) return res.sendStatus(200);
    const text = msg.text.trim();

    if (text === "/start" || text === "/help") {
      await notifyTelegram(
        "Команды:\n/bookings - список броней\n/confirm_ID - подтвердить\n/cancel_ID - отменить"
      );
      return res.sendStatus(200);
    }

    if (text === "/bookings") {
      const keys = Object.keys(pendingPayments);
      if (keys.length === 0) {
        await notifyTelegram("Нет активных броней");
      } else {
        let list = "Активные брони:\n\n";
        for (const id of keys) {
          const b   = pendingPayments[id];
          const inf = CONFIG.PRICES[b.duration];
          const grp = CONFIG.GROUPS[b.group];
          list += "ID: " + id + "\n"
            + "Дата: " + formatDate(b.date) + "\n"
            + "Время: " + grp.label + "\n"
            + "Досок: " + b.count + " | " + inf.label + "\n"
            + "Сумма: " + b.total + " руб\n"
            + "Тел: " + b.phone + "\n"
            + "/confirm_" + id + " | /cancel_" + id + "\n\n";
        }
        await notifyTelegram(list);
      }
      return res.sendStatus(200);
    }

    if (text.startsWith("/confirm_")) {
      const bookingId = text.replace("/confirm_", "");
      const booking   = pendingPayments[bookingId];
      if (!booking) {
        await notifyTelegram("Бронь " + bookingId + " не найдена");
        return res.sendStatus(200);
      }
      const grp = CONFIG.GROUPS[booking.group];
      const inf = CONFIG.PRICES[booking.duration];
      await sendMsg(booking.channel, booking.userId,
        "Оплата подтверждена!\n\n"
        + "Номер брони: " + bookingId + "\n"
        + "Дата: " + formatDate(booking.date) + "\n"
        + "Время: " + grp.label + "\n"
        + inf.label + " | " + booking.count + " сапборда\n\n"
        + "Бронь за вами закреплена, приходите " + grp.arrive + "\n"
        + "Будем ждать вас перед МЧС, не забудьте поставить будильник 🙌"
      );
      delete pendingPayments[bookingId];
      delete sessions[booking.userId];
      await notifyTelegram("Бронь " + bookingId + " подтверждена!");
      return res.sendStatus(200);
    }

    if (text.startsWith("/cancel_")) {
      const bookingId = text.replace("/cancel_", "");
      const booking   = pendingPayments[bookingId];
      if (!booking) {
        await notifyTelegram("Бронь " + bookingId + " не найдена");
        return res.sendStatus(200);
      }
      if (bookings[booking.date] && bookings[booking.date][booking.group]) {
        bookings[booking.date][booking.group] = Math.max(
          0, bookings[booking.date][booking.group] - booking.count
        );
      }
      await sendMsg(booking.channel, booking.userId,
        "Оплата не подтверждена.\nЕсли ошибка - свяжитесь: " + CONFIG.PHONE
      );
      delete pendingPayments[bookingId];
      delete sessions[booking.userId];
      await notifyTelegram("Бронь " + bookingId + " отменена");
      return res.sendStatus(200);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("TG webhook error:", err);
    res.sendStatus(500);
  }
});async function startWhatsApp() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState("auth_info");
    const { version }          = await fetchLatestBaileysVersion();

    waSocket = makeWASocket({
      version,
      auth:              state,
      logger:            pino({ level: "silent" }),
      printQRInTerminal: false,
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
        if (code !== DisconnectReason.loggedOut) {
          setTimeout(startWhatsApp, 3000);
        } else {
          lastQR = null;
        }
      }
      if (connection === "open") {
        lastQR = null;
        console.log("WhatsApp подключён!");
        await notifyTelegram("WhatsApp бот подключён и работает!");
      }
    });

    waSocket.ev.on("creds.update", saveCreds);

    waSocket.ev.on("messages.upsert", async (m) => {
      try {
        if (!m.messages) return;
        for (const msg of m.messages) {
          if (msg.key.fromMe) continue;
          if (msg.key.remoteJid.endsWith("@g.us")) continue;
          if (!msg.message) continue;
          const userId = msg.key.remoteJid;
          const text =
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            msg.message?.buttonsResponseMessage?.selectedDisplayText ||
            msg.message?.listResponseMessage?.title || "";
          if (msg.message?.imageMessage || msg.message?.documentMessage) {
            await handleReceiptPhoto({ channel: "wa", userId });
            continue;
          }
          if (text && text.trim().length > 0) {
            await handleMessage({ channel: "wa", userId, text: text.trim() });
          }
        }
      } catch (err) {
        console.error("Ошибка WA:", err);
      }
    });

  } catch (err) {
    console.error("Ошибка запуска WA:", err);
    setTimeout(startWhatsApp, 5000);
  }
}

async function handleMessage({ channel, userId, text }) {
  try {
    const low = text.toLowerCase().trim();
    if (!sessions[userId]) sessions[userId] = { step: "idle", channel };
    const s = sessions[userId];
    s.channel = channel;

    if (s.step === "wait_count")    return await stepCount({ channel, userId, low, s });
    if (s.step === "wait_date")     return await stepDate({ channel, userId, low, s });
    if (s.step === "wait_group")    return await stepGroup({ channel, userId, low, s });
    if (s.step === "wait_duration") return await stepDuration({ channel, userId, low, s });
    if (s.step === "confirm")       return await stepConfirm({ channel, userId, low, s });
    if (s.step === "wait_phone")    return await stepPhone({ channel, userId, text, s });

    if (s.step === "wait_receipt") {
      return await sendMsg(channel, userId, "Ожидаем фото чека. Пожалуйста, отправьте фото!");
    }
    if (s.step === "waiting_confirm") {
      return await sendMsg(channel, userId, "Ваш чек получен! Ожидайте подтверждения (5-10 минут)");
    }

    const hasSap   = SAP_WORDS.some(w => low.includes(w));
    const hasGreet = GREET_WORDS.some(w => low.includes(w));

    if (hasSap) {
      const count = extractNumber(low);
      if (count) {
        s.count = count;
        s.step  = "wait_date";
        return await askDate(channel, userId);
      }
      s.step = "wait_count";
      return await sendMsg(channel, userId, "Сколько сапбордов вам нужно?\nНапишите цифру (например: 2)");
    }

    if (hasGreet) {
      s.step = "idle";
      return await sendMsg(channel, userId, "Привет! 👋");
    }

    return;
  } catch (err) {
    console.error("handleMessage error:", err);
  }
}

async function stepCount({ channel, userId, low, s }) {
  const hasSap = SAP_WORDS.some(w => low.includes(w));
  const n      = extractNumber(low);
  if (!n && !hasSap) {
    sessions[userId] = { step: "idle", channel };
    return;
  }
  if (!n || n < 1 || n > CONFIG.CAPACITY) {
    return await sendMsg(channel, userId, "Введите число от 1 до " + CONFIG.CAPACITY);
  }
  s.count = n;
  s.step  = "wait_date";
  return await askDate(channel, userId);
}

async function askDate(channel, userId) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d1 = new Date(today); d1.setDate(d1.getDate() + 1);
  const d2 = new Date(today); d2.setDate(d2.getDate() + 2);
  return await sendMsg(channel, userId,
    "На какую дату?\n\n"
    + "Сегодня - " + formatDate(formatISO(today)) + "\n"
    + "Завтра - " + formatDate(formatISO(d1)) + "\n"
    + "Послезавтра - " + formatDate(formatISO(d2)) + "\n\n"
    + "Или напишите дату: 25.07"
  );
}

async function stepDate({ channel, userId, low, s }) {
  const hasDate    = /\d{1,2}[.\-\/]\d{1,2}/.test(low);
  const hasKeyword = low.includes("сегодня") || low.includes("завтра") || low.includes("послезавтра");

  if (!hasDate && !hasKeyword) {
    const hasSap = SAP_WORDS.some(w => low.includes(w));
    if (hasSap) return await askDate(channel, userId);
    sessions[userId] = { step: "idle", channel };
    return;
  }

  let date = null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (low.includes("послезавтра")) {
    const d = new Date(today); d.setDate(d.getDate() + 2); date = formatISO(d);
  } else if (low.includes("завтра")) {
    const d = new Date(today); d.setDate(d.getDate() + 1); date = formatISO(d);
  } else if (low.includes("сегодня")) {
    date = formatISO(today);
  } else {
    date = parseDate(low);
  }

  if (!date) {
    return await sendMsg(channel, userId, "Не понял дату.\nНапишите: Сегодня, Завтра, Послезавтра или 25.07");
  }

  const dateObj = new Date(date);
  dateObj.setHours(0, 0, 0, 0);
  if (dateObj < today) {
    return await sendMsg(channel, userId, "Эта дата уже прошла.\nВведите сегодня, завтра или будущую дату.");
  }

  const free1 = CONFIG.CAPACITY - getBooked(date, "1");
  const free2 = CONFIG.CAPACITY - getBooked(date, "2");

  if (free1 <= 0 && free2 <= 0) {
    const next = getNextAvailableDate(date);
    if (next) {
      return await sendMsg(channel, userId,
        "К сожалению, на " + formatDate(date) + " уже нет свободных досок.\n\n"
        + "Есть места на " + formatDate(next) + ".\nЗабронировать на эту дату?"
      );
    }
    return await sendMsg(channel, userId, "К сожалению, нет мест. Попробуйте другую дату.");
  }

  s.date = date;
  s.step = "wait_group";

  const show1 = free1 >= s.count
    ? "1 - с 4:00 до 5:00"
    : free1 > 0
      ? "1 - с 4:00 до 5:00 (доступно " + free1 + " досок)"
      : "1 - с 4:00 до 5:00 (мест нет)";

  const show2 = free2 >= s.count
    ? "2 - с 5:00 до 6:00"
    : free2 > 0
      ? "2 - с 5:00 до 6:00 (доступно " + free2 + " досок)"
      : "2 - с 5:00 до 6:00 (мест нет)";

  return await sendMsg(channel, userId,
    "На " + formatDate(date) + " выберите время:\n\n" + show1 + "\n" + show2 + "\n\nНапишите 1 или 2"
  );
}

async function stepGroup({ channel, userId, low, s }) {
  let group = null;
  if (low === "1" || low.includes("первую") || low.includes("первая") || low.includes("4:00")) group = "1";
  if (low === "2" || low.includes("вторую") || low.includes("вторая") || low.includes("5:00")) group = "2";

  if (!group) {
    return await sendMsg(channel, userId, "Напишите:\n1 - с 4:00 до 5:00\n2 - с 5:00 до 6:00");
  }

  const free = CONFIG.CAPACITY - getBooked(s.date, group);

  if (free <= 0) {
    const other     = group === "1" ? "2" : "1";
    const otherFree = CONFIG.CAPACITY - getBooked(s.date, other);
    const otherGrp  = CONFIG.GROUPS[other];
    if (otherFree >= s.count) {
      return await sendMsg(channel, userId,
        "К сожалению в это время уже нет мест.\n\n"
        + "Есть места в " + otherGrp.label + "\n"
        + "Напишите " + other + " чтобы выбрать это время."
      );
    }
    return await sendMsg(channel, userId, "К сожалению нет мест. Попробуйте другую дату.");
  }

  if (free < s.count) {
    return await sendMsg(channel, userId,
      "В это время доступно только " + free + " досок.\n"
      + "Хотите забронировать " + free + " досок? Или выберите другое время."
    );
  }

  s.group = group;
  s.step  = "wait_duration";

  return await sendMsg(channel, userId,
    "На сколько времени?\n\n1 - 1 час (800 руб)\n2 - 1.5 часа (1000 руб)\n3 - 2 часа (1200 руб)"
  );
}

async function stepDuration({ channel, userId, low, s }) {
  let duration = null;
  if (low === "1" || low.includes("один час") || low.includes("1 час"))  duration = "1";
  if (low === "2" || low.includes("1.5") || low.includes("полтора"))     duration = "1.5";
  if (low === "3" || low.includes("два часа") || low.includes("2 часа")) duration = "2";

  if (!duration) {
    return await sendMsg(channel, userId, "Выберите:\n1 - 1 час\n2 - 1.5 часа\n3 - 2 часа");
  }

  s.duration = duration;
  s.step     = "confirm";
  s.total    = CONFIG.PRICES[duration].price * s.count;

  const info = CONFIG.PRICES[duration];
  const grp  = CONFIG.GROUPS[s.group];

  return await sendMsg(channel, userId,
    "Ваш заказ:\n\n"
    + "Дата: " + formatDate(s.date) + "\n"
    + "Время: " + grp.label + "\n"
    + "Досок: " + s.count + "\n"
    + "Длит: " + info.label + "\n"
    + "Итого: " + s.total + " руб\n\n"
    + "Условия:\n"
    + "- При неявке оплата не возвращается\n"
    + "- При плохой погоде - перенос или возврат\n\n"
    + "Подтверждаете? Да или Нет"
  );
}

async function stepConfirm({ channel, userId, low, s }) {
  const yes = ["да","yes","подтверждаю","конечно","ок","хорошо","давай"];
  const no  = ["нет","no","отмена","отменить","не надо"];

  if (yes.some(w => low.includes(w))) {
    s.step = "wait_phone";
    return await sendMsg(channel, userId, "Укажите ваш номер телефона:\nНапример: +79001234567");
  }
  if (no.some(w => low.includes(w))) {
    sessions[userId] = { step: "idle", channel };
    return await sendMsg(channel, userId, "Бронь отменена. Если захотите - напишите снова!");
  }
  return await sendMsg(channel, userId, "Ответьте: Да или Нет");
}

async function stepPhone({ channel, userId, text, s }) {
  const phone = text.replace(/[\s\-\(\)]/g, "");
  if (phone.length < 10) {
    return await sendMsg(channel, userId, "Введите корректный номер.\nНапример: +79001234567");
  }

  s.phone = phone;

  if (!bookings[s.date]) bookings[s.date] = {};
  if (!bookings[s.date][s.group]) bookings[s.date][s.group] = 0;
  bookings[s.date][s.group] += s.count;

  const bookingId = generateId();
  s.bookingId     = bookingId;
  s.step          = "wait_receipt";

  const info = CONFIG.PRICES[s.duration];
  const grp  = CONFIG.GROUPS[s.group];

  pendingPayments[bookingId] = {
    userId, channel,
    phone:    s.phone,
    date:     s.date,
    group:    s.group,
    count:    s.count,
    duration: s.duration,
    total:    s.total,
    bookingId,
    createdAt: new Date().toISOString(),
  };

  await notifyTelegram(
    "НОВАЯ БРОНЬ!\n\n"
    + "ID: " + bookingId + "\n"
    + "Тел: " + phone + "\n"
    + "Дата: " + formatDate(s.date) + "\n"
    + "Время: " + grp.label + "\n"
    + "Досок: " + s.count + "\n"
    + "Длит: " + info.label + "\n"
    + "Сумма: " + s.total + " руб\n\n"
    + "/confirm_" + bookingId + "\n"
    + "/cancel_" + bookingId
  );

  return await sendMsg(channel, userId,
    "Отлично! Осталось оплатить.\n\n"
    + "Номер брони: " + bookingId + "\n\n"
    + "Переведите " + s.total + " руб:\n"
    + CONFIG.PHONE + " (Сбербанк / СБП)\n\n"
    + "После оплаты отправьте фото чека.\n"
    + "Бронь действует 24 часа."
  );
}

async function handleReceiptPhoto({ channel, userId }) {
  const s = sessions[userId];
  if (!s || s.step !== "wait_receipt") return;

  const info = CONFIG.PRICES[s.duration];
  const grp  = CONFIG.GROUPS[s.group];

  await notifyTelegram(
    "ЧЕК ПОЛУЧЕН!\n\n"
    + "ID: " + s.bookingId + "\n"
    + "Тел: " + s.phone + "\n"
    + "Дата: " + formatDate(s.date) + "\n"
    + "Время: " + grp.label + "\n"
    + "Досок: " + s.count + "\n"
    + "Сумма: " + s.total + " руб\n\n"
    + "/confirm_" + s.bookingId + "\n"
    + "/cancel_" + s.bookingId
  );

  s.step = "waiting_confirm";

  return await sendMsg(channel, userId,
    "Чек получен!\n\nПроверяем оплату...\nПодтверждение придет в течение 5-10 минут."
  );
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log("Сервер запущен на порту " + PORT);
  await notifyTelegram("Сервер запущен! Бот готов к работе.");
  startWhatsApp();
});
