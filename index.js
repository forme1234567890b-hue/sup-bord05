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
  INSTRUCTOR: "Имам-Шамиль",
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
  SESSION_TIMEOUT: 60 * 60 * 1000,
};

const bookings          = {};
const sessions          = {};
const pendingPayments   = {};
const sessionTimers     = {};
const confirmedBookings = {};
let   lastQR            = null;
let   waSocket          = null;

const SAP_WORDS = [
  "бронь","бронировать","забронировать","сап","сапборд",
  "sup","аренда","хочу","записаться","доска","доски","board","сапы",
];

const PRICE_WORDS = [
  "сколько стоит","цена","стоимость","расценки",
  "прайс","почем","по чем","тариф","стоит аренда",
];

const GREETINGS = [
  { triggers: ["ассаламу алейкум","ассалам алейкум","салам алейкум","السلام عليكم"], response: "Ваалейкум ассалам! 🙏\n\nЧем могу помочь? Хотите забронировать сапборд?" },
  { triggers: ["السلام","مرحبا","اهلا","أهلا"], response: "وعليكم السلام! 🙏" },
  { triggers: ["привет","хай","хей","hey"], response: "Привет! 👋\n\nЧем могу помочь? Хотите забронировать сапборд?" },
  { triggers: ["здравствуйте","здравствуй"], response: "Здравствуйте! 👋\n\nЧем могу помочь? Хотите забронировать сапборд?" },
  { triggers: ["добрый день"], response: "Добрый день! 👋\n\nЧем могу помочь?" },
  { triggers: ["добрый вечер"], response: "Добрый вечер! 👋\n\nЧем могу помочь?" },
  { triggers: ["доброе утро"], response: "Доброе утро! 👋\n\nЧем могу помочь?" },
  { triggers: ["hello","hi"], response: "Hello! 👋\n\nHow can I help you?" },
  { triggers: ["салам","salam"], response: "Ваалейкум ассалам! 🙏\n\nЧем могу помочь? Хотите забронировать сапборд?" },
];

const GREETING_REPLIES = [
  "ваалейкум","вааалейкум","ваалейкум ассалам",
  "и тебе привет","и вам","взаимно","пожалуйста",
  "وعليكم السلام",
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
    if (getBooked(iso,"1") < CONFIG.CAPACITY || getBooked(iso,"2") < CONFIG.CAPACITY) {
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
  const mo = String(date.getMonth() + 1).padStart(2,"0");
  const d  = String(date.getDate()).padStart(2,"0");
  return y + "-" + mo + "-" + d;
}

function parseDate(text) {
  const m1 = text.match(/(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{4})/);
  if (m1) return m1[3] + "-" + m1[2].padStart(2,"0") + "-" + m1[1].padStart(2,"0");
  const m2 = text.match(/(\d{1,2})[.\-\/](\d{1,2})/);
  if (m2) return new Date().getFullYear() + "-" + m2[2].padStart(2,"0") + "-" + m2[1].padStart(2,"0");
  return null;
}

function formatDate(iso) {
  const p = iso.split("-");
  const months = ["января","февраля","марта","апреля","мая","июня",
    "июля","августа","сентября","октября","ноября","декабря"];
  return p[2] + " " + months[Number(p[1]) - 1] + " " + p[0];
}

function generateId() {
  return "SUP" + Date.now().toString(36).toUpperCase();
}

function getPricesText() {
  return "Расценки на аренду сапборда:\n\n"
    + "1 час - 800 руб\n"
    + "1.5 часа - 1000 руб\n"
    + "2 часа - 1200 руб\n\n"
    + "Группы:\n"
    + "Утро: 4:00 - 5:00\n"
    + "Утро: 5:00 - 6:00";
}

async function notifyTelegram(text) {
  try {
    await axios.post(
      "https://api.telegram.org/bot" + CONFIG.TG_TOKEN + "/sendMessage",
      { chat_id: CONFIG.TG_CHAT_ID, text: text }
    );
  } catch (err) {
    console.error("TG error:", err.message);
  }
}

async function sendWA(userId, text) {
  try {
    if (!waSocket) return;
    await waSocket.sendMessage(userId, { text: text });
  } catch (err) {
    console.error("WA send error:", err.message);
  }
}

async function sendMsg(channel, userId, text) {
  if (channel === "wa") return await sendWA(userId, text);
}

function resetTimer(userId) {
  if (sessionTimers[userId]) clearTimeout(sessionTimers[userId]);
  const s = sessions[userId];
  if (!s || s.step === "idle") return;
  if (confirmedBookings[userId]) return;

  sessionTimers[userId] = setTimeout(async () => {
    const sess = sessions[userId];
    if (!sess || sess.step === "idle") return;
    if (sess.bookingId && pendingPayments[sess.bookingId]) {
      const b = pendingPayments[sess.bookingId];
      if (bookings[b.date] && bookings[b.date][b.group]) {
        bookings[b.date][b.group] = Math.max(0, bookings[b.date][b.group] - b.count);
      }
      delete pendingPayments[sess.bookingId];
      await notifyTelegram("Бронь " + sess.bookingId + " автоматически отменена (таймаут 1 час)");
      await sendMsg(sess.channel, userId,
        "Время ожидания истекло ⏰\n\n"
        + "Ваша бронь была отменена так как не была завершена в течение 1 часа.\n"
        + "Если хотите забронировать снова — просто напишите нам!"
      );
    }
    sessions[userId] = { step: "idle", channel: sess.channel };
    delete sessionTimers[userId];
    console.log("Сессия сброшена по таймауту: " + userId);
  }, CONFIG.SESSION_TIMEOUT);
}

app.get("/", (req, res) => {
  res.send("<html><body style='font-family:sans-serif;padding:40px'>"
    + "<h1>SUP Board Bot</h1><p>Сервер работает!</p>"
    + "<a href='/qr'>Открыть QR WhatsApp</a>"
    + "</body></html>");
});

app.get("/qr", async (req, res) => {
  if (!lastQR) {
    return res.send("<html><body style='text-align:center;padding:40px'>"
      + "<h2>WhatsApp подключён!</h2>"
      + "<script>setTimeout(()=>location.reload(),10000)</script>"
      + "</body></html>");
  }
  const qrImage = await qrcode.toDataURL(lastQR);
  res.send("<html><body style='text-align:center;padding:40px'>"
    + "<h2>Сканируйте QR WhatsApp</h2>"
    + "<img src='" + qrImage + "' style='width:300px'/>"
    + "<script>setTimeout(()=>location.reload(),25000)</script>"
    + "</body></html>");
});

app.post("/tg_webhook", async (req, res) => {
  try {
    const msg = req.body.message;
    if (!msg || !msg.text) return res.sendStatus(200);
    const text = msg.text.trim();

    if (text === "/start" || text === "/help") {
      await notifyTelegram("Команды:\n/bookings\n/confirm_ID\n/cancel_ID");
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
            + "/confirm_" + id + " | /cancel_" + id + "\n\n";
        }
        await notifyTelegram(list);
      }
      return res.sendStatus(200);
    }

    if (text.startsWith("/confirm_")) {
      const bookingId = text.replace("/confirm_","");
      const booking   = pendingPayments[bookingId];
      if (!booking) {
        await notifyTelegram("Бронь " + bookingId + " не найдена");
        return res.sendStatus(200);
      }
      confirmedBookings[booking.userId] = {
        bookingId,
        date:     booking.date,
        group:    booking.group,
        count:    booking.count,
        duration: booking.duration,
        total:    booking.total,
        confirmedAt: new Date().toISOString(),
      };
      if (sessionTimers[booking.userId]) {
        clearTimeout(sessionTimers[booking.userId]);
        delete sessionTimers[booking.userId];
      }
      const grp = CONFIG.GROUPS[booking.group];
      await sendMsg(booking.channel, booking.userId,
        "✅ Оплата подтверждена!\n\n"
        + "Номер брони: " + bookingId + "\n"
        + "Дата: " + formatDate(booking.date) + "\n"
        + "Время: " + grp.label + "\n"
        + "Приходите " + grp.arrive + "\n\n"
        + "Инструктор: " + CONFIG.INSTRUCTOR + "\n"
        + "Тел: " + CONFIG.PHONE + "\n\n"
        + "Ждём вас! 🏄"
      );
      delete pendingPayments[bookingId];
      sessions[booking.userId] = { step: "idle", channel: booking.channel };
      await notifyTelegram("Бронь " + bookingId + " подтверждена! Клиент уведомлён.");
      return res.sendStatus(200);
    }

    if (text.startsWith("/cancel_")) {
      const bookingId = text.replace("/cancel_","");
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
        "❌ Оплата не прошла проверку.\n\nПо вопросам: " + CONFIG.PHONE
      );
      delete pendingPayments[bookingId];
      sessions[booking.userId] = { step: "idle", channel: booking.channel };
      await notifyTelegram("Бронь " + bookingId + " отменена");
      return res.sendStatus(200);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("TG webhook error:", err);
    res.sendStatus(500);
  }
});

async function startWhatsApp() {
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
      if (qr) { lastQR = qr; console.log("QR готов!"); }
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
          console.log("=== СООБЩЕНИЕ ===");
          console.log("fromMe:", msg.key.fromMe);
          console.log("jid:", msg.key.remoteJid);
          console.log("type:", m.type);
          console.log("text:", msg.message?.conversation || msg.message?.extendedTextMessage?.text || "нет текста");
          console.log("=================");

          if (msg.key.fromMe) continue;
          if (msg.key.remoteJid.endsWith("@g.us")) continue;
          if (!msg.message) continue;

          const userId = msg.key.remoteJid.endsWith("@lid")
            ? (msg.key.senderPn || msg.key.remoteJid)
            : msg.key.remoteJid;

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

    if (confirmedBookings[userId]) {
      const cb  = confirmedBookings[userId];
      const grp = CONFIG.GROUPS[cb.group];
      return await sendMsg(channel, userId,
        "У вас уже есть подтверждённая бронь! ✅\n\n"
        + "Номер: " + cb.bookingId + "\n"
        + "Дата: " + formatDate(cb.date) + "\n"
        + "Время: " + grp.label + "\n\n"
        + "По вопросам: " + CONFIG.PHONE
      );
    }

    resetTimer(userId);

    if (s.step === "wait_count")    return await stepCount({ channel, userId, low, s });
    if (s.step === "wait_date")     return await stepDate({ channel, userId, low, s });
    if (s.step === "wait_group")    return await stepGroup({ channel, userId, low, s });
    if (s.step === "wait_duration") return await stepDuration({ channel, userId, low, s });
    if (s.step === "confirm")       return await stepConfirm({ channel, userId, low, s });
    if (s.step === "ask_book")      return await stepAskBook({ channel, userId, low, s });

    if (s.step === "wait_receipt") {
      return await sendMsg(channel, userId,
        "Ожидаем фото чека.\nОтправьте фото чека об оплате! 📸"
      );
    }
    if (s.step === "waiting_confirm") {
      return await sendMsg(channel, userId,
        "Ваш чек получен! Ожидайте подтверждения оплаты."
      );
    }

    const isGreetingReply = GREETING_REPLIES.some(w => low.includes(w));
    if (isGreetingReply) return;

    const hasSap     = SAP_WORDS.some(w => low.includes(w));
    const hasPrice   = PRICE_WORDS.some(w => low.includes(w));
    const greetMatch = GREETINGS.find(g => g.triggers.some(t => low.includes(t)));

    if (greetMatch) {
      s.step = "idle";
      if (hasSap || hasPrice) {
        await sendMsg(channel, userId, greetMatch.response);
        const count = extractNumber(low);
        if (count) {
          s.count = count;
          s.step  = "wait_date";
          return await askDate(channel, userId);
        }
        s.step = "wait_count";
        return await sendMsg(channel, userId,
          "Сколько сапбордов вам нужно?\nНапишите цифру (например: 2)"
        );
      }
      return await sendMsg(channel, userId, greetMatch.response);
    }

    if (hasPrice && !hasSap) {
      s.step = "ask_book";
      return await sendMsg(channel, userId,
        getPricesText() + "\n\nЗабронировать вам место? 😊"
      );
    }

    if (hasSap || hasPrice) {
      const count = extractNumber(low);
      if (count) {
        s.count = count;
        s.step  = "wait_date";
        return await askDate(channel, userId);
      }
      s.step = "wait_count";
      return await sendMsg(channel, userId,
        "Сколько сапбордов вам нужно?\nНапишите цифру (например: 2)"
      );
    }

    return;
  } catch (err) {
    console.error("handleMessage error:", err);
  }
}

async function stepAskBook({ channel, userId, low, s }) {
  const yes = ["да","yes","конечно","ок","хорошо","давай","хочу","бронировать"];
  const no  = ["нет","no","не надо","не хочу","отмена"];
  if (yes.some(w => low.includes(w))) {
    const count = extractNumber(low);
    if (count) {
      s.count = count;
      s.step  = "wait_date";
      return await askDate(channel, userId);
    }
    s.step = "wait_count";
    return await sendMsg(channel, userId,
      "Сколько сапбордов вам нужно?\nНапишите цифру (например: 2)"
    );
  }
  if (no.some(w => low.includes(w))) {
    s.step = "idle";
    return await sendMsg(channel, userId, "Хорошо! Если понадобится - пишите 😊");
  }
  const count = extractNumber(low);
  if (count) {
    s.count = count;
    s.step  = "wait_date";
    return await askDate(channel, userId);
  }
  return await sendMsg(channel, userId, "Забронировать вам место? Ответьте: Да или Нет");
}

async function stepCount({ channel, userId, low, s }) {
  const n = extractNumber(low);
  if (!n || n < 1 || n > CONFIG.CAPACITY) {
    return await sendMsg(channel, userId, "Введите число от 1 до " + CONFIG.CAPACITY);
  }
  s.count = n;
  s.step  = "wait_date";
  return await askDate(channel, userId);
}

async function askDate(channel, userId) {
  const today = new Date();
  today.setHours(0,0,0,0);
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
    return await sendMsg(channel, userId,
      "Не понял дату.\nНапишите: Сегодня, Завтра, Послезавтра или 25.07"
    );
  }
  let date = null;
  const today = new Date();
  today.setHours(0,0,0,0);
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
    return await sendMsg(channel, userId,
      "Не понял дату.\nНапишите: Сегодня, Завтра, Послезавтра или 25.07"
    );
  }
  const dateObj = new Date(date);
  dateObj.setHours(0,0,0,0);
  if (dateObj < today) {
    return await sendMsg(channel, userId,
      "Эта дата уже прошла.\nВведите будущую дату."
    );
  }
  const free1 = CONFIG.CAPACITY - getBooked(date,"1");
  const free2 = CONFIG.CAPACITY - getBooked(date,"2");
  if (free1 <= 0 && free2 <= 0) {
    const next = getNextAvailableDate(date);
    if (next) {
      return await sendMsg(channel, userId,
        "На " + formatDate(date) + " нет свободных досок 😔\n\n"
        + "Есть места на " + formatDate(next) + ".\nЗабронировать?"
      );
    }
    return await sendMsg(channel, userId, "К сожалению нет мест. Попробуйте другую дату.");
  }
  s.date = date;
  s.step = "wait_group";
  const show1 = free1 >= s.count ? "1 - с 4:00 до 5:00"
    : free1 > 0 ? "1 - с 4:00 до 5:00 (доступно " + free1 + " досок)"
    : "1 - с 4:00 до 5:00 (мест нет)";
  const show2 = free2 >= s.count ? "2 - с 5:00 до 6:00"
    : free2 > 0 ? "2 - с 5:00 до 6:00 (доступно " + free2 + " досок)"
    : "2 - с 5:00 до 6:00 (мест нет)";
  return await sendMsg(channel, userId,
    "На " + formatDate(date) + " выберите время:\n\n"
    + show1 + "\n" + show2 + "\n\nНапишите 1 или 2"
  );
}

async function stepGroup({ channel, userId, low, s }) {
  let group = null;
  if (low === "1" || low.includes("первую") || low.includes("4:00")) group = "1";
  if (low === "2" || low.includes("вторую") || low.includes("5:00")) group = "2";
  if (!group) {
    return await sendMsg(channel, userId, "Напишите:\n1 - с 4:00 до 5:00\n2 - с 5:00 до 6:00");
  }
  const free = CONFIG.CAPACITY - getBooked(s.date, group);
  if (free <= 0) {
    const other     = group === "1" ? "2" : "1";
    const otherFree = CONFIG.CAPACITY - getBooked(s.date, other);
    if (otherFree >= s.count) {
      return await sendMsg(channel, userId,
        "В это время мест нет 😔\n\n"
        + "Есть места " + CONFIG.GROUPS[other].label + "\n"
        + "Напишите " + other + " чтобы выбрать."
      );
    }
    return await sendMsg(channel, userId, "Нет мест. Попробуйте другую дату.");
  }
  if (free < s.count) {
    return await sendMsg(channel, userId,
      "Доступно только " + free + " досок.\n"
      + "Хотите забронировать " + free + "? Или выберите другое время."
    );
  }
  s.group = group;
  s.step  = "wait_duration";
  return await sendMsg(channel, userId,
    "На сколько времени?\n\n"
    + "1 - 1 час (800 руб)\n"
    + "2 - 1.5 часа (1000 руб)\n"
    + "3 - 2 часа (1200 руб)"
  );
}

async function stepDuration({ channel, userId, low, s }) {
  let duration = null;
  if (low === "1" || low.includes("1 час") || low.includes("один час")) duration = "1";
  if (low === "2" || low.includes("1.5") || low.includes("полтора"))    duration = "1.5";
  if (low === "3" || low.includes("2 часа") || low.includes("два часа")) duration = "2";
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
      + "Дата: " + formatDate(s.date) + "\n"
      + "Время: " + grp.label + "\n"
      + "Досок: " + s.count + "\n"
      + "Длит: " + info.label + "\n"
      + "Сумма: " + s.total + " руб\n\n"
      + "/confirm_" + bookingId + "\n"
      + "/cancel_" + bookingId
    );
    return await sendMsg(channel, userId,
      "Отлично! Осталось оплатить. 💳\n\n"
      + "Номер брони: " + bookingId + "\n\n"
      + "Переведите " + s.total + " руб:\n"
      + CONFIG.PHONE + " (Сбербанк / СБП)\n\n"
      + "После оплаты отправьте фото чека. 📸\n"
      + "Бронь действует 1 час."
    );
  }
  if (no.some(w => low.includes(w))) {
    if (bookings[s.date] && bookings[s.date][s.group]) {
      bookings[s.date][s.group] = Math.max(0, bookings[s.date][s.group] - s.count);
    }
    sessions[userId] = { step: "idle", channel };
    return await sendMsg(channel, userId, "Бронь отменена. Если захотите - пишите снова! 😊");
  }
  return await sendMsg(channel, userId, "Ответьте: Да или Нет");
}

async function handleReceiptPhoto({ channel, userId }) {
  const s = sessions[userId];
  if (!s || s.step !== "wait_receipt") return;
  const info = CONFIG.PRICES[s.duration];
  const grp  = CONFIG.GROUPS[s.group];
  await notifyTelegram(
    "ЧЕК ПОЛУЧЕН! 📸\n\n"
    + "ID: " + s.bookingId + "\n"
    + "Дата: " + formatDate(s.date) + "\n"
    + "Время: " + grp.label + "\n"
    + "Досок: " + s.count + "\n"
    + "Сумма: " + s.total + " руб\n\n"
    + "/confirm_" + s.bookingId + "\n"
    + "/cancel_" + s.bookingId
  );
  s.step = "waiting_confirm";
  if (sessionTimers[userId]) {
    clearTimeout(sessionTimers[userId]);
    delete sessionTimers[userId];
  }
  return await sendMsg(channel, userId,
    "Чек получен! 📸\n\n"
    + "Бронь за вами закреплена!\n\n"
    + "Оплату проверит " + CONFIG.INSTRUCTOR + " (инструктор)\n"
    + "По всем вопросам: " + CONFIG.PHONE
  );
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log("Сервер запущен на порту " + PORT);
  await notifyTelegram("Сервер запущен! Бот готов к работе.");
  startWhatsApp();
});
