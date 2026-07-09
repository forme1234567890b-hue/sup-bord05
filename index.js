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
// КОНФИГ
// ================================================
const CONFIG = {
  VERIFY_TOKEN:      "sup_board_secret_2025",
  TG_TOKEN:          "8878884686:AAGmS94pp2nhkQrHj8hkx8LIbBRmtdn92Xk",
  TG_CHAT_ID:        "5208172896",
  PHONE:             "89051160860",
  CAPACITY:          10,
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

// bookings[date][group] = количество забронированных досок
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
    "<h1>SUP Board Bot</h1><p>Сервер работает!</p>" +
    "<a href='/qr'>Открыть QR WhatsApp</a>" +
    "</body></html>"
  );
});

app.get("/qr", async (req, res) => {
  if (!lastQR) {
    return res.send(
      "<html><body style='font-family:sans-serif;text-align:center;padding:40px'>" +
      "<h2>WhatsApp подключён!</h2><p>Бот работает</p>" +
      "<script>setTimeout(()=>location.reload(),10000)</script>" +
      "</body></html>"
    );
  }
  const qrImage = await qrcode.toDataURL(lastQR);
  res.send(
    "<html><body style='font-family:sans-serif;text-align:center;padding:40px'>" +
    "<h2>Сканируйте QR WhatsApp</h2>" +
    "<img src='" + qrImage + "' style='width:300px'/>" +
    "<script>setTimeout(()=>location.reload(),25000)</script>" +
    "</body></html>"
  );
});

// ================================================
// TELEGRAM WEBHOOK
// ================================================
app.post("/tg_webhook", async (req, res) => {
  try {
    const msg = req.body.message;
    if (!msg || !msg.text) return res.sendStatus(200);

    const text = msg.text.trim();
    console.log("TG команда: " + text);

    if (text === "/start" || text === "/help") {
      await notifyTelegram(
        "Команды админа:\n\n" +
        "/bookings — список активных броней\n" +
        "/confirm_ID — подтвердить оплату\n" +
        "/cancel_ID — отменить бронь"
      );
      return res.sendStatus(200);
    }

    if (text === "/bookings") {
      const keys = Object.keys(pendingPayments);
      if (keys.length === 0) {
        await notifyTelegram("Нет активных броней ожидающих подтверждения");
      } else {
        let list = "Активные брони:\n\n";
        for (const id of keys) {
          const b    = pendingPayments[id];
          const info = CONFIG.PRICES[b.duration];
          const grp  = CONFIG.GROUPS[b.group];
          list +=
            "ID: " + id + "\n" +
            "Дата: " + formatDate(b.date) + "\n" +
            "Время: " + grp.label + "\n" +
            "Досок: " + b.count + "\n" +
            info.label + " — " + b.total + " руб\n" +
            "Тел: " + b.phone + "\n" +
            "Канал: " + (b.channel === "wa" ? "WhatsApp" : "Instagram") + "\n" +
            "/confirm_" + id + " | /cancel_" + id + "\n\n";
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
      const info = CONFIG.PRICES[booking.duration];
      const grp  = CONFIG.GROUPS[booking.group];
      await sendMsg(booking.channel, booking.userId,
        "✅ Оплата подтверждена!\n\n" +
        "Ваша бронь: " + bookingId + "\n" +
        "Дата: " + formatDate(booking.date) + "\n" +
        "Время: " + grp.label + "\n" +
        info.label + " | " + booking.count + " сапборда\n\n" +
        "Бронь за вами закреплена, приходите " + grp.arrive + "\n" +
        "Будем ждать вас перед МЧС, не забудьте поставить будильник 🙌"
      );
      delete pendingPayments[bookingId];
      delete sessions[booking.userId];
      await notifyTelegram("✅ Бронь " + bookingId + " подтверждена!");
      return res.sendStatus(200);
    }

    if (text.startsWith("/cancel_")) {
      const bookingId = text.replace("/cancel_", "");
      const booking   = pendingPayments[bookingId];
      if (!booking) {
        await notifyTelegram("Бронь " + bookingId + " не найдена");
        return res.sendStatus(200);
      }
      // Возвращаем места
      if (bookings[booking.date] && bookings[booking.date][booking.group]) {
        bookings[booking.date][booking.group] = Math.max(
          0,
          bookings[booking.date][booking.group] - booking.count
        );
      }
      await sendMsg(booking.channel, booking.userId,
        "❌ Оплата не подтверждена.\n" +
        "Если произошла ошибка — свяжитесь с нами:\n" +
        CONFIG.PHONE
      );
      delete pendingPayments[bookingId];
      delete sessions[booking.userId];
      await notifyTelegram("❌ Бронь " + bookingId + " отменена");
      return res.sendStatus(200);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("TG webhook error:", err);
    res.sendStatus(500);
  }
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
        console.log("WA закрыт, код: " + code);
        if (code !== DisconnectReason.loggedOut) {
          setTimeout(startWhatsApp, 3000);
        } else {
          lastQR = null;
        }
      }

      if (connection === "open") {
        lastQR = null;
        console.log("WhatsApp подключён!");
        await notifyTelegram("✅ WhatsApp бот подключён и работает!");
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
            msg.message?.listResponseMessage?.title ||
            "";

          if (msg.message?.imageMessage || msg.message?.documentMessage) {
            await handleReceiptPhoto({ channel: "wa", userId });
            continue;
          }

          if (text && text.trim().length > 0) {
            console.log("WA от " + userId + ": " + text);
            await handleMessage({
              channel: "wa",
              userId,
              text:    text.trim(),
            });
          }
        }
      } catch (err) {
        console.error("Ошибка обработки WA:", err);
      }
    });

  } catch (err) {
    console.error("Ошибка запуска WA:", err);
    setTimeout(startWhatsApp, 5000);
  }
}

startWhatsApp();

// ================================================
// ГЛАВНАЯ ЛОГИКА
// ================================================
async function handleMessage({ channel, userId, text }) {
  try {
    const low = text.toLowerCase().trim();

    if (!sessions[userId]) {
      sessions[userId] = { step: "idle", channel };
    }

    const s   = sessions[userId];
    s.channel = channel;

    console.log("Сессия " + userId + " шаг: " + s.step);

    // ----- Активные шаги бронирования -----
    if (s.step === "wait_count")    return await stepCount({ channel, userId, low, text, s });
    if (s.step === "wait_date")     return await stepDate({ channel, userId, low, s });
    if (s.step === "wait_group")    return await stepGroup({ channel, userId, low, s });
    if (s.step === "wait_duration") return await stepDuration({ channel, userId, low, s });
    if (s.step === "confirm")       return await stepConfirm({ channel, userId, low, s });
    if (s.step === "wait_phone")    return await stepPhone({ channel, userId, text, s });

    if (s.step === "wait_receipt") {
      return await sendMsg(channel, userId,
        "Ожидаем фото чека об оплате.\n" +
        "Пожалуйста, отправьте фото чека!"
      );
    }

    if (s.step === "waiting_confirm") {
      return await sendMsg(channel, userId,
        "Ваш чек уже получен!\n" +
        "Ожидайте подтверждения (5-10 минут) 🙏"
      );
    }

    // ----- Определяем тип сообщения -----
    const SAP_WORDS = [
      "бронь","бронировать","забронировать",
      "сап","сапборд","sup","аренда",
      "хочу","записаться","доска","доски","board",
    ];

    const GREET_WORDS = [
      "привет","здравствуйте","здравствуй","добрый",
      "доброе","хай","салам","hello","hi","добро",
    ];

    const hasSap    = SAP_WORDS.some(w => low.includes(w));
    const hasGreet  = GREET_WORDS.some(w => low.includes(w));

    // Если в сообщении есть про сапы — начинаем бронирование
    if (hasSap) {
      const count = extractNumber(low);
      if (count) {
        s.count = count;
        s.step  = "wait_date";
        return await askDate(channel, userId);
      }
      s.step = "wait_count";
      return await sendMsg(channel, userId,
        "Сколько сапбордов вам нужно?\n" +
        "Напишите цифру (например: 2)"
      );
    }

    // Если только приветствие — отвечаем и ждём
    if (hasGreet) {
      s.step = "idle";
      return await sendMsg(channel, userId,
        "Привет! 👋"
      );
    }

    // Любое другое сообщение — бот молчит
    // (не отвечаем вообще)
    return;

  } catch (err) {
    console.error("handleMessage error:", err);
  }
}

// ================================================
// ШАГИ БРОНИРОВАНИЯ
// ================================================

async function stepCount({ channel, userId, low, text, s }) {
  // Если написал что-то не по теме сапов — сбрасываем в idle, молчим
  const SAP_WORDS = [
    "бронь","бронировать","забронировать",
    "сап","сапборд","sup","аренда",
    "хочу","записаться","доска","доски","board",
  ];
  const hasSap = SAP_WORDS.some(w => low.includes(w));

  const n = extractNumber(low);

  if (!n && !hasSap) {
    // Не по теме — сбрасываем сессию, молчим
    sessions[userId] = { step: "idle", channel };
    return;
  }

  if (!n || n < 1 || n > CONFIG.CAPACITY) {
    return await sendMsg(channel, userId,
      "Пожалуйста, введите число от 1 до " + CONFIG.CAPACITY
    );
  }

  s.count = n;
  s.step  = "wait_date";
  return await askDate(channel, userId);
}

async function askDate(channel, userId) {
  const today = new Date();
  const dates = [];
  for (let i = 0; i <= 6; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    dates.push(formatISO(d));
  }

  let msg = "На какую дату хотите забронировать?\n\n";
  msg += "Сегодня — " + formatDate(dates[0]) + "\n";
  msg += "Завтра — " + formatDate(dates[1]) + "\n";
  msg += "Послезавтра — " + formatDate(dates[2]) + "\n\n";
  msg += "Или напишите дату: 25.07";

  return await sendMsg(channel, userId, msg);
}

async function stepDate({ channel, userId, low, s }) {
  // Если написал не по теме — сбрасываем
  const SAP_WORDS = [
    "бронь","бронировать","забронировать",
    "сап","сапборд","sup","аренда",
    "хочу","записаться","доска","доски","board",
    "сегодня","завтра","послезавтра",
  ];
  const hasSap    = SAP_WORDS.some(w => low.includes(w));
  const hasDate   = /\d{1,2}[.\-\/]\d{1,2}/.test(low);
  const hasNumber = /\d/.test(low);

  if (!hasSap && !hasDate && !hasNumber) {
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
    return await sendMsg(channel, userId,
      "Не понял дату.\n\n" +
      "Напишите:\n" +
      "— Сегодня\n" +
      "— Завтра\n" +
      "— Послезавтра\n" +
      "— Или дату: 25.07"
    );
  }

  const dateObj = new Date(date);
  dateObj.setHours(0, 0, 0, 0);

  if (dateObj < today) {
    return await sendMsg(channel, userId,
      "Эта дата уже прошла.\n" +
      "Введите сегодня, завтра или будущую дату."
    );
  }

  // Проверяем доступность групп на эту дату
  const grp1 = getBooked(date, "1");
  const grp2 = getBooked(date, "2");
  const free1 = CONFIG.CAPACITY - grp1;
  const free2 = CONFIG.CAPACITY - grp2;

  // Если вообще нет мест ни в одной группе
  if (free1 <= 0 && free2 <= 0) {
    const nextDate = getNextAvailableDate(date);
    if (nextDate) {
      return await sendMsg(channel, userId,
        "К сожалению, на " + formatDate(date) + " уже нет свободных досок 😔\n\n" +
        "Забронировать на " + formatDate(nextDate) + "?"
      );
    } else {
      return await sendMsg(channel, userId,
        "К сожалению, на " + formatDate(date) + " уже нет свободных досок 😔\n\n" +
        "Попробуйте другую дату."
      );
    }
  }

  s.date = date;
  s.step = "wait_group";

  // Показываем доступные группы
  let msg = "Отлично! На " + formatDate(date) + " есть места.\n\n";
  msg += "Выберите время:\n\n";

  if (free1 >= s.count) {
    msg += "1 — с 4:00 до 5:00\n";
  } else if (free1 > 0) {
    msg += "1 — с 4:00 до 5:00 (мест меньше чем вы хотите)\n";
  } else {
    msg += "1 — с 4:00 до 5:00 (мест нет)\n";
  }

  if (free2 >= s.count) {
    msg += "2 — с 5:00 до 6:00\n";
  } else if (free2 > 0) {
    msg += "2 — с 5:00 до 6:00 (мест меньше чем вы хотите)\n";
  } else {
    msg += "2 — с 5:00 до 6:00 (мест нет)\n";
  }

  msg += "\nНапишите 1 или 2";
  return await sendMsg(channel, userId, msg);
}

async function stepGroup({ channel, userId, low, s }) {
  let group = null;
  if (low === "1" || low.includes("первую") || low.includes("первая") || low.includes("4:00") || low.includes("4-5")) group = "1";
  if (low === "2" || low.includes("вторую") || low.includes("вторая") || low.includes("5:00") || low.includes("5-6")) group = "2";

  if (!group) {
    return await sendMsg(channel, userId,
      "Напишите:\n1 — с 4:00 до 5:00\n2 — с 5:00 до 6:00"
    );
  }

  const booked = getBooked(s.date, group);
  const free   = CONFIG.CAPACITY - booked;

  if (free <= 0) {
    const otherGroup = group === "1" ? "2" : "1";
    const otherFree  = CONFIG.CAPACITY - getBooked(s.date, otherGroup);
    const otherInfo  = CONFIG.GROUPS[otherGroup];

    if (otherFree >= s.count) {
      return await sendMsg(channel, userId,
        "К сожалению, в это время уже нет мест 😔\n\n" +
        "Есть места в группе " + otherInfo.label + "\n" +
        "Перенести туда?"
      );
    } else {
      return await sendMsg(channel, userId,
        "К сожалению, в это время уже нет мест 😔\n\n" +
        "Попробуйте другую дату."
      );
    }
  }

  if (free < s.count) {
    return await sendMsg(channel, userId,
      "В это время доступно только " + free + " досок.\n\n" +
      "Хотите забронировать " + free + " досок?\n" +
      "Или выберите другое время/дату."
    );
  }

  s.group = group;
  s.step  = "wait_duration";

  return await sendMsg(channel, userId,
    "На сколько времени?\n\n" +
    "1 — 1 час (800 руб)\n" +
    "2 — 1.5 часа (1000 руб)\n" +
    "3 — 2 часа (1200 руб)"
  );
}

async function stepDuration({ channel, userId, low, s }) {
  let duration = null;

  if (low === "1" || low.includes("один час") || low.includes("1 час"))         duration = "1";
  if (low === "2" || low.includes("1.5") || low.includes("полтора"))            duration = "1.5";
  if (low === "3" || low.includes("два часа") || low.includes("2 часа"))        duration = "2";

  if (!duration) {
    return await sendMsg(channel, userId,
      "Выберите цифру:\n\n" +
      "1 — 1 час (800 руб)\n" +
      "2 — 1.5 часа (1000 руб)\n" +
      "3 — 2 часа (1200 руб)"
    );
  }

  s.duration = duration;
  s.step     = "confirm";

  const info  = CONFIG.PRICES[duration];
  const grp   = CONFIG.GROUPS[s.group];
  const total = info.price * s.count;
  s.total     = total;

  return await sendMsg(channel, userId,
    "Ваш заказ:\n\n" +
    "📅 " + formatDate(s.date) + "\n" +
    "🕐 " + grp.label + "\n" +
    "🏄 " + s.count + " сапборда\n" +
    "⏱ " + info.label + "\n" +
    "💰 Итого: " + total + " руб\n\n" +
    "УСЛОВИЯ:\n" +
    "— При неявке оплата не возвращается\n" +
    "— При плохой погоде — перенос или возврат\n\n" +
    "Подтверждаете бронь?\n" +
    "Ответьте: Да или Нет"
  );
}

async function stepConfirm({ channel, userId, low, s }) {
  const yes = ["да","yes","подтверждаю","конечно","ок","хорошо","давай","подтвердить"];
  const no  = ["нет","no","отмена","отменить","не надо","не хочу"];

  if (yes.some(w => low.includes(w))) {
    s.step = "wait_phone";
    return await sendMsg(channel, userId,
      "Укажите ваш номер телефона:\n" +
      "Например: +79001234567"
    );
  }

  if (no.some(w => low.includes(w))) {
    sessions[userId] = { step: "idle", channel };
    return await sendMsg(channel, userId,
      "Бронь отменена.\n" +
      "Если захотите — напишите снова! 😊"
    );
  }

  return await sendMsg(channel, userId,
    "Пожалуйста, ответьте:\n" +
    "Да — подтвердить\n" +
    "Нет — отменить"
  );
}

async function stepPhone({ channel, userId, text, s }) {
  const phone = text.replace(/[\s\-\(\)]/g, "");

  if (phone.length < 10) {
    return await sendMsg(channel, userId,
      "Введите корректный номер телефона.\n" +
      "Например: +79001234567"
    );
  }

  s.phone = phone;

  // Бронируем место
  if (!bookings[s.date]) bookings[s.date] = {};
  if (!bookings[s.date][s.group]) bookings[s.date][s.group] = 0;
  bookings[s.date][s.group] += s.count;

  const bookingId = generateId();
  s.bookingId     = bookingId;

  const info = CONFIG.PRICES[s.duration];
  const grp  = CONFIG.GROUPS[s.group];

  pendingPayments[bookingId] = {
    userId,
    channel,
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
    "🆕 НОВАЯ БРОНЬ!\n\n" +
    "ID: " + bookingId + "\n" +
    "Тел: " + phone + "\n" +
    "Дата: " + formatDate(s.date) + "\n" +
    "Время: " + grp.label + "\n" +
    "Досок: " + s.count + "\n" +
    "Длит: " + info.label + "\n" +
    "Сумма: " + s.total + " руб\n" +
    "Канал: " + (channel === "wa" ? "WhatsApp" : "Instagram") + "\n\n" +
    "✅ /confirm_" + bookingId + "\n" +
    "❌ /cancel_" + bookingId
  );

  s.step = "wait_receipt";

  return await sendMsg(channel, userId,
    "Отлично! Осталось оплатить 💳\n\n" +
    "Номер брони: " + bookingId + "\n\n" +
    "Переведите " + s.total + " руб на номер:\n" +
    CONFIG.PHONE + " (Сбербанк / СБП)\n\n" +
    "После оплаты отправьте фото чека сюда 📸\n\n" +
    "Бронь действует 24 часа"
  );
}

async function handleReceiptPhoto({ channel, userId }) {
  const s = sessions[userId];

  if (!s || s.step !== "wait_receipt") {
    return;
  }

  const info = CONFIG.PRICES[s.duration];
  const grp  = CONFIG.GROUPS[s.group];

  await notifyTelegram(
    "📸 ЧЕК ПОЛУЧЕН!\n\n" +
    "ID: " + s.bookingId + "\n" +
    "Тел: " + s.phone + "\n" +
    "Дата: " + formatDate(s.date) + "\n" +
    "Время: " + grp.label + "\n" +
    "Досок: " + s.count + "\n" +
    "Длит: " + info.label + "\n" +
    "Сумма: " + s.total + " руб\n\n" +
    "✅ /confirm_" + s.bookingId + "\n" +
    "❌ /cancel_" + s.bookingId
  );

  s.step = "waiting_confirm";

  return await sendMsg(channel, userId,
    "Чек получен! 📸\n\n" +
    "Проверяем оплату...\n" +
    "Подтверждение придёт в течение 5-10 минут 🙏\n\n" +
    "Номер вашей брони: " + s.bookingId
  );
}

// ================================================
// ОТПРАВКА
// ================================================
async function sendMsg(channel, userId, text) {
  if (channel === "wa") return await sendWA(userId, text);
  return await sendIG(userId, text);
}

async function sendWA(userId, text) {
  try {
    if (!waSocket) { console.error("WA socket не готов"); return; }
    await waSocket.sendMessage(userId, { text });
    console.log("WA отправлено: " + userId);
  } catch (err) {
    console.error("WA send error:", err.message);
  }
}

async function sendIG(userId, text
