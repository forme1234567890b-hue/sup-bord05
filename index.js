// ================================================
// SUP BOARD BOT
// Без ManyChat! Instagram + WhatsApp + Telegram
// Телефон: 89051160860
// ================================================

import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// ================================================
// НАСТРОЙКИ — ЗАПОЛНИТЕ ВАШИ ДАННЫЕ
// ================================================
const CONFIG = {
  // Meta / Instagram
  VERIFY_TOKEN: "sup_board_secret_2025",
  PAGE_ACCESS_TOKEN: "",    // ← получите ниже в инструкции
  
  // WhatsApp Cloud API  
  WA_PHONE_ID: "",          // ← получите ниже
  WA_TOKEN: "",             // ← тот же что PAGE_ACCESS_TOKEN
  
  // Telegram уведомления
  TG_TOKEN: "8878884686:AAGmS94pp2nhkQrHj8hkx8LIbBRmtdn92Xk",             // ← токен от @BotFather
  TG_CHAT_ID: "5208172896",           // ← ваш Chat ID
  
  // Ваши данные
  PHONE: "89051160860",
  
  // Цены
  PRICES: {
    "1":   { label: "1 час",    price: 800  },
    "1.5": { label: "1.5 часа", price: 1000 },
    "2":   { label: "2 часа",   price: 1200 },
  },
  
  CAPACITY: 10,
  SLOT_START: "04:00",
  SLOT_END:   "06:00",
};

// ================================================
// БАЗА ДАННЫХ В ПАМЯТИ
// (для постоянного хранения — добавим Google Sheets)
// ================================================
const bookings  = {}; // date -> занято досок
const sessions  = {}; // userId -> состояние диалога
const pendingPayments = {}; // bookingId -> данные

// ================================================
// ПРИВЕТСТВИЯ
// ================================================
const GREETINGS_MAP = {
  // Русский
  "привет":           "Привет! 👋",
  "здравствуйте":     "Здравствуйте! 👋",
  "здравствуй":       "Здравствуйте! 👋",
  "добрый день":      "Добрый день! ☀️",
  "доброе утро":      "Доброе утро! 🌅",
  "добрый вечер":     "Добрый вечер! 🌙",
  "хай":              "Привет! 👋",
  
  // Узбекский / Татарский / Казахский
  "салам":               "Ваалейкум ассалам! 👋",
  "салам алейкум":       "Ваалейкум ассалам! 👋",
  "ассалому алайкум":    "Ваалайкум ассалом! 👋",
  "ас-саламу алейкум":   "Ваалейкум ассалам! 👋",
  "ассаламу алейкум":    "Ваалейкум ассалам! 👋",
  
  // Арабский
  "السلام عليكم":         "وعليكم السلام! 👋",
  "سلام":                "وعليكم السلام! 👋",
  "مرحبا":               "أهلاً وسهلاً! 👋",
};

// Слова о броне
const BOOKING_WORDS = [
  "бронь","бронировать","забронировать",
  "сап","сапборд","sup","сапы","аренда",
  "хочу","записать","записаться","место","доска"
];

// ================================================
// WEBHOOK ВЕРИФИКАЦИЯ (Meta требует)
// ================================================
app.get("/webhook", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  
  if (mode === "subscribe" && token === CONFIG.VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ================================================
// ОСНОВНОЙ WEBHOOK — ПРИЁМ СООБЩЕНИЙ
// ================================================
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;
    
    // ── WhatsApp ──
    if (body.object === "whatsapp_business_account") {
      const msg = body.entry?.[0]
                      ?.changes?.[0]
                      ?.value
                      ?.messages?.[0];
      
      if (msg) {
        const from = msg.from; // номер телефона
        
        if (msg.type === "text") {
          await handleMessage({
            channel: "wa",
            userId:  from,
            text:    msg.text.body.trim(),
            type:    "text"
          });
        }
        
        if (msg.type === "image") {
          await handleMessage({
            channel:    "wa",
            userId:     from,
            type:       "image",
            image_id:   msg.image.id,
          });
        }
      }
    }
    
    // ── Instagram ──
    if (body.object === "instagram") {
      for (const entry of body.entry || []) {
        for (const event of entry.messaging || []) {
          const sender = event.sender?.id;
          
          if (event.message?.text) {
            await handleMessage({
              channel: "ig",
              userId:  sender,
              text:    event.message.text.trim(),
              type:    "text"
            });
          }
          
          if (event.message?.attachments) {
            for (const att of event.message.attachments) {
              if (att.type === "image") {
                await handleMessage({
                  channel:     "ig",
                  userId:      sender,
                  type:        "image",
                  image_url:   att.payload.url,
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
// ГЛАВНАЯ ЛОГИКА ДИАЛОГА
// ================================================
async function handleMessage({ channel, userId, text, type, image_id, image_url }) {
  
  // ── Пришло ФОТО (чек об оплате) ──
  if (type === "image") {
    return await handleReceiptPhoto({ channel, userId, image_id, image_url });
  }
  
  const low = text.toLowerCase().trim();
  let s = sessions[userId] || { step: "start", channel };

  // ── ШАГ: ждём подтверждения ──
  if (s.step === "confirm") {
    return await handleConfirm({ channel, userId, low, s });
  }
  
  // ── ШАГ: ждём дату ──
  if (s.step === "wait_date") {
    return await handleDate({ channel, userId, low, s });
  }
  
  // ── ШАГ: ждём количество ──
  if (s.step === "wait_count") {
    return await handleCount({ channel, userId, low, s });
  }
  
  // ── ШАГ: ждём продолжительность ──
  if (s.step === "wait_duration") {
    return await handleDuration({ channel, userId, low, s });
  }
  
  // ── ШАГ: ждём телефон ──
  if (s.step === "wait_phone") {
    return await handlePhone({ channel, userId, text, s });
  }

  // ── ПЕРВОЕ сообщение / начало ──
  const hasBooking = BOOKING_WORDS.some(w => low.includes(w));
  const greeting   = detectGreeting(low);
  
  // Только приветствие — отвечаем приветствием
  if (greeting && !hasBooking) {
    return await send(channel, userId, greeting);
  }
  
  // Приветствие + желание забронировать
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
      `🏄 Хотите забронировать сапборды!\n` +
      `Сколько досок нужно? (1–10)`
    );
  }
  
  // Только желание забронировать (без приветствия)
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
      `🏄 Забронировать сапборды!\n` +
      `Сколько досок нужно? (1–10)`
    );
  }
  
  // Ничего не поняли — молчим
}

// ================================================
// ОБРАБОТЧИКИ ШАГОВ
// ================================================

async function handleCount({ channel, userId, low, s }) {
  const n = extractNumber(low);
  if (!n || n < 1 || n > CONFIG.CAPACITY) {
    return await send(channel, userId, `Введите число от 1 до ${CONFIG.CAPACITY}`);
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
  
  if (low.includes("1") && !low.includes("1.5") && !low.includes("2")) duration = "1";
  if (low.includes("1.5") || low.includes("полтора"))                   duration = "1.5";
  if (low.includes("2") || low.includes("два"))                         duration = "2";
  if (low === "1" || low === "один")  duration = "1";
  if (low === "2" || low === "два")   duration = "2";
  if (low === "3")                    duration = "1.5";
  
  if (!duration) {
    return await send(channel, userId,
      `Выберите:\n1️⃣ — 1 час\n2️⃣ — 1.5 часа\n3️⃣ — 2 часа`
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
  
  // Проверяем прошедшую дату
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
    return await send(channel, userId,
      `📞 Укажите ваш номер телефона:`
    );
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
  
  // Сохраняем бронь
  bookings[s.date] = (bookings[s.date] || 0) + s.count;
  pendingPayments[bookingId] = { ...s, userId, channel, createdAt: new Date() };
  
  // Уведомляем вас в Telegram
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
    `Для подтверждения после оплаты:\n` +
    `/confirm_${bookingId}\n\n` +
    `Для отмены:\n` +
    `/cancel_${bookingId}`
  );
  
  s.step = "wait_receipt";
  sessions[userId] = s;
  
  return await send(channel, userId,
    `🎉 Бронь создана!\n\n` +
    `🆔 Номер брони: ${bookingId}\n\n` +
    `💳 Для подтверждения оплатите:\n` +
    `Номер телефона: ${CONFIG.PHONE}\n` +
    `Банк: Сбербанк / СБП\n` +
    `Сумма: ${s.total} руб\n\n` +
    `📸 После оплаты скиньте сюда фото чека!\n\n` +
    `⚠️ До получения оплаты\n` +
    `бронь временная (24 часа)`
  );
}

// ================================================
// ОБРАБОТКА ЧЕКА (ФОТО)
// ================================================
async function handleReceiptPhoto({ channel, userId, image_id, image_url }) {
  const s = sessions[userId];
  
  if (!s || s.step !== "wait_receipt") {
    return await send(channel, userId,
      `Чек получен! ✅\n` +
      `Проверяем... ожидайте подтверждения.`
    );
  }
  
  const bookingId = s.bookingId;
  const info      = CONFIG.PRICES[s.duration];
  
  // Уведомляем вас
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
// TELEGRAM КОМАНДЫ (вы подтверждаете оплату)
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
      
      // Отправляем клиенту подтверждение
      await send(booking.channel, booking.userId,
        `🎉 <b>Оплата подтверждена!</b>\n\n` +
        `📋 Ваша бронь:\n` +
        `🆔 ${bookingId}\n` +
        `📅 ${formatDate(booking.date)}\n` +
        `⏱ ${info.label} (${CONFIG.SLOT_START}–${CONFIG.SLOT_END})\n` +
        `🏄 ${booking.count} сапборда\n\n` +
        `Ждём вас! 🏄‍♂️\n` +
        `По вопросам: ${CONFIG.PHONE}`
      );
      
      // Обновляем статус
      if (pendingPayments[bookingId]) {
        pendingPayments[bookingId].status = "confirmed";
      }
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
      
      // Освобождаем места
      if (bookings[booking.date]) {
        bookings[booking.date] = Math.max(0, bookings[booking.date] - booking.count);
      }
      
      // Сообщаем клиенту
      await send(booking.channel, booking.userId,
        `❌ Оплата не подтверждена.\n\n` +
        `Если произошла ошибка — напишите нам: ${CONFIG.PHONE}\n` +
        `Или начните бронь заново.`
      );
      
      delete pendingPayments[bookingId];
      delete sessions[booking.userId];
      await notifyTelegram(`❌ Бронь ${bookingId} отменена`);
    }
    
    res.sendStatus(200);
  } catch(err) {
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
      await axios.post(
        `https://graph.facebook.com/v20.0/${CONFIG.WA_PHONE_ID}/messages`,
        {
          messaging_product: "whatsapp",
          to:   userId,
          type: "text",
          text: { body: text }
        },
        { headers: { Authorization: `Bearer ${CONFIG.WA_TOKEN}` } }
      );
    } else {
      await axios.post(
        `https://graph.facebook.com/v20.0/me/messages`,
        {
          recipient: { id: userId },
          message:   { text }
        },
        {
          params:  { access_token: CONFIG.PAGE_ACCESS_TOKEN },
          headers: { "Content-Type": "application/json" }
        }
      );
    }
  } catch(err) {
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
        text:       text,
        parse_mode: "HTML"
      }
    );
  } catch(err) {
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
    "девять":9,"десять":10
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
  const d = m[1].padStart(2,"0");
  const mo = m[2].padStart(2,"0");
  const y = m[3];
  return `${y}-${mo}-${d}`;
}

function formatDate(iso) {
  const [y,mo,d] = iso.split("-");
  return `${d}.${mo}.${y}`;
}

function generateId() {
  return "SUP" + Date.now().toString(36).toUpperCase();
}

// ================================================
// ЗАПУСК СЕРВЕРА
// ================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🏄 SUP Bot запущен на порту ${PORT}`);
});
