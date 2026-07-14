import express from "express";
import axios from "axios";
import qrcode from "qrcode";
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";

const app = express();
app.use(express.json());

const CONFIG = {
  TG_TOKEN: "8878884686:AAGmS94pp2nhkQrHj8hkx8LIbBRmtdn92Xk",
  TG_CHAT_ID: "5208172896",
  PHONE: "89051160860",
  INSTRUCTOR: "Имам-Шамиль",
  CAPACITY: 10,
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

const bookings = {};
const sessions = {};
const pendingPayments = {};
const sessionTimers = {};
let lastQR = null;
let waSocket = null;

const SAP_WORDS = ["бронь","бронировать","забронировать","сап","сапборд","sup","аренда","хочу","записаться","доска","доски","board","сапы"];
const PRICE_WORDS = ["сколько стоит","цена","стоимость","расценки","прайс","почем","по чем","тариф","стоит аренда"];
const GREETINGS = [
  { triggers: ["ассаламу алейкум","салам алейкум"], response: "Ваалейкум ассалам!\n\nЧем могу помочь? Хотите забронировать сапборд?" },
  { triggers: ["привет","хай","хей","hey"], response: "Привет!\n\nЧем могу помочь? Хотите забронировать сапборд?" },
  { triggers: ["здравствуйте","здравствуй"], response: "Здравствуйте!\n\nЧем могу помочь? Хотите забронировать сапборд?" },
  { triggers: ["добрый день"], response: "Добрый день!\n\nЧем могу помочь?" },
  { triggers: ["добрый вечер"], response: "Добрый вечер!\n\nЧем могу помочь?" },
  { triggers: ["доброе утро"], response: "Доброе утро!\n\nЧем могу помочь?" },
  { triggers: ["hello","hi"], response: "Hello!\n\nHow can I help you?" },
  { triggers: ["салам","salam"], response: "Ваалейкум ассалам!\n\nЧем могу помочь? Хотите забронировать сапборд?" },
];
const GREETING_REPLIES = ["ваалейкум","вааллейкум","ваалейкум ассалам","и тебе привет","и вам","взаимно"];

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
    if (getBooked(iso,"1") < CONFIG.CAPACITY || getBooked(iso,"2") < CONFIG.CAPACITY) return iso;
  }
  return null;
}

function extractNumber(text) {
  const words = {"один":1,"одну":1,"два":2,"две":2,"три":3,"четыре":4,"пять":5,"шесть":6,"семь":7,"восемь":8,"девять":9,"десять":10};
  for (const [w, n] of Object.entries(words)) {
    if (text.includes(w)) return n;
  }
  const m = text.match(/\b([1-9]|10)\b/);
  return m ? Number(m[1]) : null;
}

function formatISO(date) {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2,"0");
  const d = String(date.getDate()).padStart(2,"0");
  return y + "-" + mo + "-" + d;
}

function parseDate(text) {
  const m1 = text.match(/(\d{1,2})[.\-](\d{1,2})[.\-](\d{4})/);
  if (m1) return m1[3] + "-" + m1[2].padStart(2,"0") + "-" + m1[1].padStart(2,"0");
  const m2 = text.match(/(\d{1,2})[.\-](\d{1,2})/);
  if (m2) return new Date().getFullYear() + "-" + m2[2].padStart(2,"0") + "-" + m2[1].padStart(2,"0");
  return null;
}

function formatDate(iso) {
  const p = iso.split("-");
  const months = ["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"];
  return p[2] + " " + months[Number(p[1]) - 1] + " " + p[0];
}

function generateId() {
  return "SUP" + Date.now().toString(36).toUpperCase();
}

function getPricesText() {
  return "Расценки на аренду сапборда:\n\n1 час — 800 руб\n1.5 часа — 1000 руб\n2 часа — 1200 руб\n\nГруппы:\nУтро: 4:00 - 5:00\nУтро: 5:00 - 6:00";
}

async function notifyTelegram(text) {
  try {
    await axios.post("https://api.telegram.org/bot" + CONFIG.TG_TOKEN + "/sendMessage", { chat_id: CONFIG.TG_CHAT_ID, text: text });
  } catch (err) {
    console.error("TG error:", err.message);
  }
}

async function sendWA(userId, text) {
  try {
    if (!waSocket) { console.error("waSocket не готов"); return; }
    console.log("Отправляю на:", userId, "текст:", text.substring(0,50));
    await waSocket.sendMessage(userId, { text: text });
    console.log("Отправлено успешно!");
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
  if (!s || s.step === "idle" || s.step === "waiting_confirm") return;
  sessionTimers[userId] = setTimeout(async () => {
    const sess = sessions[userId];
    if (sess && sess.step !== "idle" && sess.step !== "waiting_confirm") {
      if (sess.bookingId && pendingPayments[sess.bookingId]) {
        const b = pendingPayments[sess.bookingId];
        if (bookings[b.date] && bookings[b.date][b.group]) {
          bookings[b.date][b.group] = Math.max(0, bookings[b.date][b.group] - b.count);
        }
        delete pendingPayments[sess.bookingId];
        await notifyTelegram("Бронь " + sess.bookingId + " отменена автоматически (таймаут)");
      }
      sessions[userId] = { step: "idle", channel: sess.channel };
      delete sessionTimers[userId];
    }
  }, CONFIG.SESSION_TIMEOUT);
}

app.get("/", (req, res) => {
  res.send("<html><body><h1>SUP Board Bot</h1><p>Работает!</p><a href='/qr'>QR WhatsApp</a></body></html>");
});

app.get("/qr", async (req, res) => {
  if (!lastQR) return res.send("<html><body><h2>WhatsApp подключён!</h2></body></html>");
  const qrImage = await qrcode.toDataURL(lastQR);
  res.send("<html><body style='text-align:center'><h2>Сканируйте QR</h2><img src='" + qrImage + "' style='width:300px'/><script>setTimeout(()=>location.reload(),25000)</script></body></html>");
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
          const b = pendingPayments[id];
          const inf = CONFIG.PRICES[b.duration];
          const grp = CONFIG.GROUPS[b.group];
          list += "ID: " + id + "\nДата: " + formatDate(b.date) + "\nВремя: " + grp.label + "\nДосок: " + b.count + " | " + inf.label + "\nСумма: " + b.total + " руб\n/confirm_" + id + " | /cancel_" + id + "\n\n";
        }
        await notifyTelegram(list);
      }
      return res.sendStatus(200);
    }

    if (text.startsWith("/confirm_")) {
      const bookingId = text.replace("/confirm_","");
      const booking = pendingPayments[bookingId];
      if (!booking) { await notifyTelegram("Бронь " + bookingId + " не найдена"); return res.sendStatus(200); }
      const grp = CONFIG.GROUPS[booking.group];
      await sendMsg(booking.channel, booking.userId, "Оплата подтверждена!\n\nНомер брони: " + bookingId + "\nДата: " + formatDate(booking.date) + "\nВремя: " + grp.label + "\nПриходите " + grp.arrive + "\n\nИнструктор: " + CONFIG.INSTRUCTOR + "\nТел: " + CONFIG.PHONE + "\n\nЖдём вас!");
      delete pendingPayments[bookingId];
      delete sessions[booking.userId];
      await notifyTelegram("Бронь " + bookingId + " подтверждена!");
      return res.sendStatus(200);
    }

    if (text.startsWith("/cancel_")) {
      const bookingId = text.replace("/cancel_","");
      const booking = pendingPayments[bookingId];
      if (!booking) { await notifyTelegram("Бронь " + bookingId + " не найдена"); return res.sendStatus(200); }
      if (bookings[booking.date] && bookings[booking.date][booking.group]) {
        bookings[booking.date][booking.group] = Math.max(0, bookings[booking.date][booking.group] - booking.count);
      }
      await sendMsg(booking.channel, booking.userId, "Оплата не прошла проверку.\nПо вопросам: " + CONFIG.PHONE);
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
});

async function handleMessage({ channel, userId, text }) {
  try {
    const low = text.toLowerCase().trim();
    if (!sessions[userId]) sessions[userId] = { step: "idle", channel };
    const s = sessions[userId];
    s.channel = channel;
    resetTimer(userId);

    if (s.step === "wait_count")    return await stepCount({ channel, userId, low, s });
    if (s.step === "wait_date")     return await stepDate({ channel, userId, low, s });
    if (s.step === "wait_group")    return await stepGroup({ channel, userId, low, s });
    if (s.step === "wait_duration") return await stepDuration({ channel, userId, low, s });
    if (s.step === "confirm")       return await stepConfirm({ channel, userId, low, s });
    if (s.step === "ask_book")      return await stepAskBook({ channel, userId, low, s });
    if (s.step === "wait_receipt")  return await sendMsg(channel, userId, "Ожидаем фото чека. Отправьте фото!");
    if (s.step === "waiting_confirm") return await sendMsg(channel, userId, "Ваш чек получен! Ожидайте подтверждения.");

    const isGreetingReply = GREETING_REPLIES.some(w => low.includes(w));
    if (isGreetingReply) return;

    const hasSap = SAP_WORDS.some(w => low.includes(w));
    const hasPrice = PRICE_WORDS.some(w => low.includes(w));
    const greetMatch = GREETINGS.find(g => g.triggers.some(t => low.includes(t)));

    if (greetMatch) {
      if (hasSap || hasPrice) {
        const count = extractNumber(low);
        if (count) {
          await sendMsg(channel, userId, greetMatch.response);
          s.count = count;
          s.step = "wait_date";
          return await askDate(channel, userId);
        }
        await sendMsg(channel, userId, greetMatch.response);
        s.step = "wait_count";
        return await sendMsg(channel, userId, "Сколько сапбордов вам нужно?\nНапишите цифру (например: 2)");
      }
      s.step = "idle";
      return await sendMsg(channel, userId, greetMatch.response);
    }

    if (hasPrice && !hasSap) {
      s.step = "ask_book";
      return await sendMsg(channel, userId, getPricesText() + "\n\nЗабронировать вам место?");
    }

    if (hasSap || hasPrice) {
      const count = extractNumber(low);
      if (count) {
        s.count = count;
        s.step = "wait_date";
        return await askDate(channel, userId);
      }
      s.step = "wait_count";
      return await sendMsg(channel, userId, "Сколько сапбордов вам нужно?\nНапишите цифру (например: 2)");
    }
  } catch (err) {
    console.error("handleMessage error:", err);
  }
}

async function stepAskBook({ channel, userId, low, s }) {
  const yes = ["да","yes","конечно","ок","хорошо","давай","хочу","бронировать"];
  const no = ["нет","no","не надо","не хочу","отмена"];
  if (yes.some(w => low.includes(w))) {
    const count = extractNumber(low);
    if (count) { s.count = count; s.step = "wait_date"; return await askDate(channel, userId); }
    s.step = "wait_count";
    return await sendMsg(channel, userId, "Сколько сапбордов вам нужно?\nНапишите цифру (например: 2)");
  }
  if (no.some(w => low.includes(w))) {
    s.step = "idle";
    return await sendMsg(channel, userId, "Хорошо! Если понадобится — пишите!");
  }
  const count = extractNumber(low);
  if (count) { s.count = count; s.step = "wait_date"; return await askDate(channel, userId); }
  return await sendMsg(channel, userId, "Забронировать вам место? Ответьте: Да или Нет");
}

async function stepCount({ channel, userId, low, s }) {
  const n = extractNumber(low);
  if (!n || n < 1 || n > CONFIG.CAPACITY) return await sendMsg(channel, userId, "Введите число от 1 до " + CONFIG.CAPACITY);
  s.count = n;
  s.step = "wait_date";
  return await askDate(channel, userId);
}

async function askDate(channel, userId) {
  const today = new Date();
  today.setHours(0,0,0,0);
  const d1 = new Date(today); d1.setDate(d1.getDate() + 1);
  const d2 = new Date(today); d2.setDate(d2.getDate() + 2);
  return await sendMsg(channel, userId, "На какую дату?\n\nСегодня — " + formatDate(formatISO(today)) + "\nЗавтра — " + formatDate(formatISO(d1)) + "\nПослезавтра — " + formatDate(formatISO(d2)) + "\n\nИли напишите дату: 25.07");
}

async function stepDate({ channel, userId, low, s }) {
  const hasDate = /\d{1,2}[.\-]\d{1,2}/.test(low);
  const hasKeyword = low.includes("сегодня") || low.includes("завтра") || low.includes("послезавтра");
  if (!hasDate && !hasKeyword) return await sendMsg(channel, userId, "Не понял дату.\nНапишите: Сегодня, Завтра, Послезавтра или 25.07");
  let date = null;
  const today = new Date();
  today.setHours(0,0,0,0);
  if (low.includes("послезавтра")) { const d = new Date(today); d.setDate(d.getDate() + 2); date = formatISO(d); }
  else if (low.includes("завтра")) { const d = new Date(today); d.setDate(d.getDate() + 1); date = formatISO(d); }
  else if (low.includes("сегодня")) { date = formatISO(today); }
  else { date = parseDate(low); }
  if (!date) return await sendMsg(channel, userId, "Не понял дату.\nНапишите: Сегодня, Завтра, Послезавтра или 25.07");
  const dateObj = new Date(date);
  dateObj.setHours(0,0,0,0);
  if (dateObj < today) return await sendMsg(channel, userId, "Эта дата уже прошла.\nВведите будущую дату.");
  const free1 = CONFIG.CAPACITY - getBooked(date,"1");
  const free2 = CONFIG.CAPACITY - getBooked(date,"2");
  if (free1 <= 0 && free2 <= 0) {
    const next = getNextAvailableDate(date);
    if (next) return await sendMsg(channel, userId, "На " + formatDate(date) + " нет свободных досок.\n\nЕсть места на " + formatDate(next) + ".\nЗабронировать?");
    return await sendMsg(channel, userId, "К сожалению нет мест. Попробуйте другую дату.");
  }
  s.date = date;
  s.step = "wait_group";
  const show1 = free1 >= s.count ? "1 — с 4:00 до 5:00" : free1 > 0 ? "1 — с 4:00 до 5:00 (доступно " + free1 + " досок)" : "1 — с 4:00 до 5:00 (мест нет)";
  const show2 = free2 >= s.count ? "2 — с 5:00 до 6:00" : free2 > 0 ? "2 — с 5:00 до 6:00 (доступно " + free2 + " досок)" : "2 — с 5:00 до 6:00 (мест нет)";
  return await sendMsg(channel, userId, "На " + formatDate(date) + " выберите время:\n\n" + show1 + "\n" + show2 + "\n\nНапишите 1 или 2");
}

async function stepGroup({ channel, userId, low, s }) {
  let group = null;
  if (low === "1" || low.includes("первую") || low.includes("4:00")) group = "1";
  if (low === "2" || low.includes("вторую") || low.includes("5:00")) group = "2";
  if (!group) return await sendMsg(channel, userId, "Напишите:\n1 — с 4:00 до 5:00\n2 — с 5:00 до 6:00");
  const free = CONFIG.CAPACITY - getBooked(s.date, group);
  if (free <= 0) {
    const other = group === "1" ? "2" : "1";
    const otherFree = CONFIG.CAPACITY - getBooked(s.date, other);
    if (otherFree >= s.count) return await sendMsg(channel, userId, "В это время мест нет.\n\nЕсть места " + CONFIG.GROUPS[other].label + "\nНапишите " + other + " чтобы выбрать.");
    return await sendMsg(channel, userId, "Нет мест. Попробуйте другую дату.");
  }
  if (free < s.count) return await sendMsg(channel, userId, "Доступно только " + free + " досок.\nХотите забронировать " + free + "? Или выберите другое время.");
  s.group = group;
  s.step = "wait_duration";
  return await sendMsg(channel, userId, "На сколько времени?\n\n1 — 1 час (800 руб)\n2 — 1.5 часа (1000 руб)\n3 — 2 часа (1200 руб)");
}

async function stepDuration({ channel, userId, low, s }) {
  let duration = null;
  if (low === "1" || low.includes("1 час") || low.includes("один час")) duration = "1";
  if (low === "2" || low.includes("1.5") || low.includes("полтора")) duration = "1.5";
  if (low === "3" || low.includes("2 часа") || low.includes("два часа")) duration = "2";
  if (!duration) return await sendMsg(channel, userId, "Выберите:\n1 — 1 час\n2 — 1.5 часа\n3 — 2 часа");
  s.duration = duration;
  s.step = "confirm";
  s.total = CONFIG.PRICES[duration].price * s.count;
  const info = CONFIG.PRICES[duration];
  const grp = CONFIG.GROUPS[s.group];
  return await sendMsg(channel, userId, "Ваш заказ:\n\nДата: " + formatDate(s.date) + "\nВремя: " + grp.label + "\nДосок: " + s.count + "\nДлит: " + info.label + "\nИтого: " + s.total + " руб\n\nУсловия:\n— При неявке оплата не возвращается\n— При плохой погоде — перенос или возврат\n\nПодтверждаете? Да или Нет");
}

async function stepConfirm({ channel, userId, low, s }) {
  const yes = ["да","yes","подтверждаю","конечно","ок","хорошо","давай"];
  const no = ["нет","no","отмена","отменить","не надо"];
  if (yes.some(w => low.includes(w))) {
    if (!bookings[s.date]) bookings[s.date] = {};
    if (!bookings[s.date][s.group]) bookings[s.date][s.group] = 0;
    bookings[s.date][s.group] += s.count;
    const bookingId = generateId();
    s.bookingId = bookingId;
    s.step = "wait_receipt";
    const info = CONFIG.PRICES[s.duration];
    const grp = CONFIG.GROUPS[s.group];
    pendingPayments[bookingId] = { userId, channel, date: s.date, group: s.group, count: s.count, duration: s.duration, total: s.total, bookingId, createdAt: new Date().toISOString() };
    await notifyTelegram("НОВАЯ БРОНЬ!\n\nID: " + bookingId + "\nДата: " + formatDate(s.date) + "\nВремя: " + grp.label + "\nДосок: " + s.count + "\nДлит: " + info.label + "\nСумма: " + s.total + " руб\n\n/confirm_" + bookingId + "\n/cancel_" + bookingId);
    return await sendMsg(channel, userId, "Отлично! Осталось оплатить.\n\nНомер брони: " + bookingId + "\n\nПереведите " + s.total + " руб на:\n" + CONFIG.PHONE + " (Сбербанк / СБП)\n\nПосле оплаты отправьте фото чека.\nБронь действует 1 час.");
  }
  if (no.some(w => low.includes(w))) {
    sessions[userId] = { step: "idle", channel };
    return await sendMsg(channel, userId, "Бронь отменена. Если захотите — пишите снова!");
  }
  return await sendMsg(channel, userId, "Ответьте: Да или Нет");
}

async function handleReceiptPhoto({ channel, userId }) {
  const s = sessions[userId];
  if (!s || s.step !== "wait_receipt") return;
  const grp = CONFIG.GROUPS[s.group];
  await notifyTelegram("ЧЕК ПОЛУЧЕН!\n\nID: " + s.bookingId + "\nДата: " + formatDate(s.date) + "\nВремя: " + grp.label + "\nДосок: " + s.count + "\nСумма: " + s.total + " руб\n\n/confirm_" + s.bookingId + "\n/cancel_" + s.bookingId);
  s.step = "waiting_confirm";
  if (sessionTimers[userId]) { clearTimeout(sessionTimers[userId]); delete sessionTimers[userId]; }
  return await sendMsg(channel, userId, "Чек получен!\n\nБронь за вами закреплена!\n\nОплату проверит " + CONFIG.INSTRUCTOR + "\nПо всем вопросам: " + CONFIG.PHONE);
}

async function startWhatsApp() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState("/app/auth_info_business");
    const { version } = await fetchLatestBaileysVersion();

    waSocket = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: "silent" }),
      browser: ["SUP Bot", "Chrome", "1.0.0"],
    });

    waSocket.ev.on("creds.update", saveCreds);

    waSocket.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        lastQR = qr;
        console.log("QR готов! Зайди на /qr");
      }
      if (connection === "open") {
        lastQR = null;
        console.log("WhatsApp подключён!");
        await notifyTelegram("WhatsApp подключён и готов!");
      }
      if (connection === "close") {
        const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
        console.log("Соединение закрыто, код:", code);
        if (code === DisconnectReason.loggedOut) {
          console.log("Разлогинен!");
          await notifyTelegram("WhatsApp разлогинен! Нужно заново сканировать QR.");
        } else {
          console.log("Переподключение через 3 сек...");
          setTimeout(startWhatsApp, 3000);
        }
      }
    });

    waSocket.ev.on("messages.upsert", async ({ messages, type }) => {
      try {
        console.log("Получено событие messages.upsert, тип:", type);
        if (type !== "notify") return;

        for (const msg of messages) {
          if (!msg.message) continue;
          if (msg.key.fromMe) continue;

          const jid = msg.key.remoteJid;
          if (!jid) continue;
          if (msg.message?.reactionMessage) continue;

          const isLid = jid.endsWith("@lid");
          const isUser = jid.endsWith("@s.whatsapp.net");
          if (!isLid && !isUser) continue;

          const waUserId = jid;
          console.log("Сообщение от JID:", waUserId);

          if (
            msg.message?.imageMessage ||
            msg.message?.documentWithCaptionMessage
          ) {
            console.log("Фото получено от:", waUserId);
            await handleReceiptPhoto({ channel: "wa", userId: waUserId });
            continue;
          }

          const text =
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            msg.message?.buttonsResponseMessage?.selectedDisplayText ||
            msg.message?.listResponseMessage?.title ||
            "";

          console.log("Текст от", waUserId, ":", text);

          if (text && text.trim().length > 0) {
            await handleMessage({ channel: "wa", userId: waUserId, text: text.trim() });
          }
        }
      } catch (err) {
        console.error("Ошибка WA messages.upsert:", err);
      }
    });

  } catch (err) {
    console.error("Ошибка запуска WA:", err);
    setTimeout(startWhatsApp, 5000);
  }
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, async () => {
  console.log("Сервер запущен на порту " + PORT);
  await notifyTelegram("Сервер запущен! Бот готов к работе.");
  startWhatsApp();
});
