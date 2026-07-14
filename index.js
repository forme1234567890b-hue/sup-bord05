// ─── WhatsApp подключение ────────────────────────────────────────────────────

async function startWhatsApp() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState("auth_info_business");
    const { version }          = await fetchLatestBaileysVersion();

    waSocket = makeWASocket({
      version,
      auth:              state,
      logger:            pino({ level: "silent" }),
      printQRInTerminal: true,
      browser:           ["SUP Bot", "Chrome", "1.0.0"],
      getMessage:        async () => ({ conversation: "" }),
    });

    waSocket.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        lastQR = qr;
        console.log("✅ QR готов! Зайди на /qr и отсканируй");
      }
      if (connection === "close") {
        lastQR = null;
        const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
        console.log("❌ Соединение закрыто, код:", code);
        if (code !== DisconnectReason.loggedOut) {
          console.log("🔄 Переподключение...");
          setTimeout(startWhatsApp, 3000);
        } else {
          console.log("🚫 Вышли из аккаунта. Удали папку auth_info_business и перезапусти");
        }
      }
      if (connection === "open") {
        lastQR = null;
        console.log("✅ WhatsApp Business подключён!");
        await notifyTelegram("✅ WhatsApp Business бот подключён и работает!");
      }
    });

    waSocket.ev.on("creds.update", saveCreds);

    waSocket.ev.on("messages.upsert", async (m) => {
      try {
        if (!m.messages) return;
        if (m.type !== "notify") return;

        for (const msg of m.messages) {
          // Пропускаем свои сообщения
          if (msg.key.fromMe) continue;

          const jid = msg.key.remoteJid || "";

          // Пропускаем группы и статусы
          if (jid.endsWith("@g.us")) continue;
          if (jid === "status@broadcast") continue;
          if (!msg.message) continue;
          if (msg.message?.protocolMessage) continue;
          if (msg.message?.senderKeyDistributionMessage) continue;
          if (msg.message?.reactionMessage) continue;

          // Принимаем @lid и @s.whatsapp.net
          const isLid  = jid.endsWith("@lid");
          const isUser = jid.endsWith("@s.whatsapp.net");
          if (!isLid && !isUser) continue;

          // Для @lid пробуем получить реальный номер
          let userId = jid;
          if (isLid) {
            try {
              const realJid = await waSocket.onWhatsApp(jid);
              if (realJid && realJid[0] && realJid[0].jid) {
                userId = realJid[0].jid;
                console.log("✅ LID конвертирован:", jid, "→", userId);
              } else {
                userId = jid;
                console.log("⚠️ LID не конвертирован, используем как есть:", userId);
              }
            } catch (e) {
              userId = jid;
              console.log("⚠️ Ошибка конвертации LID:", e.message);
            }
          }

          console.log("📨 Сообщение от:", userId);

          // Получаем текст
          const text =
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            msg.message?.buttonsResponseMessage?.selectedDisplayText ||
            msg.message?.listResponseMessage?.title || "";

          // Проверяем фото/чек
          if (
            msg.message?.imageMessage ||
            msg.message?.documentMessage ||
            msg.message?.documentWithCaptionMessage
          ) {
            console.log("📸 Фото получено от:", userId);
            await handleReceiptPhoto({ channel: "wa", userId });
            continue;
          }

          // Обрабатываем текст
          if (text && text.trim().length > 0) {
            console.log("💬 Текст:", text, "| от:", userId);
            await handleMessage({ channel: "wa", userId, text: text.trim() });
          }
        }
      } catch (err) {
        console.error("❌ Ошибка WA messages.upsert:", err);
      }
    });

  } catch (err) {
    console.error("❌ Ошибка запуска WA:", err);
    setTimeout(startWhatsApp, 5000);
  }
}

// ─── Основной обработчик сообщений ──────────────────────────────────────────

async function handleMessage({ channel, userId, text }) {
  try {
    console.log("🔥 handleMessage | userId:", userId, "| text:", text);

    const low = text.toLowerCase().trim();
    if (!sessions[userId]) sessions[userId] = { step: "idle", channel };
    const s = sessions[userId];
    s.channel = channel;

    console.log("📌 step:", s.step);

    resetTimer(userId);

    // Если есть активный шаг — отправляем туда
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

    // Пропускаем ответные приветствия
    const isGreetingReply = GREETING_REPLIES.some(w => low.includes(w));
    if (isGreetingReply) return;

    const hasSap     = SAP_WORDS.some(w => low.includes(w));
    const hasPrice   = PRICE_WORDS.some(w => low.includes(w));
    const greetMatch = GREETINGS.find(g => g.triggers.some(t => low.includes(t)));

    console.log("🔍 hasSap:", hasSap, "| hasPrice:", hasPrice, "| greet:", greetMatch ? "ДА" : "НЕТ");

    // Приветствие
    if (greetMatch) {
      // Если в сообщении есть и приветствие и слово про сап
      if (hasSap || hasPrice) {
        const count = extractNumber(low);
        if (count) {
          await sendMsg(channel, userId, greetMatch.response);
          s.count = count;
          s.step  = "wait_date";
          return await askDate(channel, userId);
        }
        await sendMsg(channel, userId, greetMatch.response);
        s.step = "wait_count";
        return await sendMsg(channel, userId,
          "Сколько сапбордов вам нужно?\nНапишите цифру (например: 2)"
        );
      }
      s.step = "idle";
      return await sendMsg(channel, userId, greetMatch.response);
    }

    // Только цена
    if (hasPrice && !hasSap) {
      s.step = "ask_book";
      return await sendMsg(channel, userId,
        getPricesText() + "\n\nЗабронировать вам место? 😊"
      );
    }

    // Сап или бронь
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

    // Неизвестное сообщение
    console.log("⚠️ Неизвестное сообщение, не отвечаем");
    return;

  } catch (err) {
    console.error("❌ handleMessage error:", err);
  }
}

// ─── Шаги бронирования ───────────────────────────────────────────────────────

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
    return await sendMsg(channel, userId, "Хорошо! Если понадобится — пишите 😊");
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
    + "Сегодня — " + formatDate(formatISO(today)) + "\n"
    + "Завтра — " + formatDate(formatISO(d1)) + "\n"
    + "Послезавтра — " + formatDate(formatISO(d2)) + "\n\n"
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
  const show1 = free1 >= s.count ? "1 — с 4:00 до 5:00"
    : free1 > 0 ? "1 — с 4:00 до 5:00 (доступно " + free1 + " досок)"
    : "1 — с 4:00 до 5:00 (мест нет)";
  const show2 = free2 >= s.count ? "2 — с 5:00 до 6:00"
    : free2 > 0 ? "2 — с 5:00 до 6:00 (доступно " + free2 + " досок)"
    : "2 — с 5:00 до 6:00 (мест нет)";
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
    return await sendMsg(channel, userId, "Напишите:\n1 — с 4:00 до 5:00\n2 — с 5:00 до 6:00");
  }
  const free = CONFIG.CAPACITY - getBooked(s.date, group);
  if (free <= 0) {
    const other = group === "1" ? "2" : "1";
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
    + "1 — 1 час (800 руб)\n"
    + "2 — 1.5 часа (1000 руб)\n"
    + "3 — 2 часа (1200 руб)"
  );
}

async function stepDuration({ channel, userId, low, s }) {
  let duration = null;
  if (low === "1" || low.includes("1 час") || low.includes("один час"))   duration = "1";
  if (low === "2" || low.includes("1.5")   || low.includes("полтора"))    duration = "1.5";
  if (low === "3" || low.includes("2 часа") || low.includes("два часа"))  duration = "2";
  if (!duration) {
    return await sendMsg(channel, userId,
      "Выберите:\n1 — 1 час\n2 — 1.5 часа\n3 — 2 часа"
    );
  }
  s.duration = duration;
  s.step     = "confirm";
  s.total    = CONFIG.PRICES[duration].price * s.count;
  const info = CONFIG.PRICES[duration];
  const grp  = CONFIG.GROUPS[s.group];
  return await sendMsg(channel, userId,
    "Ваш заказ:\n\n"
    + "📅 Дата: " + formatDate(s.date) + "\n"
    + "⏰ Время: " + grp.label + "\n"
    + "🏄 Досок: " + s.count + "\n"
    + "⌛ Длит: " + info.label + "\n"
    + "💰 Итого: " + s.total + " руб\n\n"
    + "Условия:\n"
    + "— При неявке оплата не возвращается\n"
    + "— При плохой погоде — перенос или возврат\n\n"
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
      date:      s.date,
      group:     s.group,
      count:     s.count,
      duration:  s.duration,
      total:     s.total,
      bookingId,
      createdAt: new Date().toISOString(),
    };
    await notifyTelegram(
      "🆕 НОВАЯ БРОНЬ!\n\n"
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
      + "Переведите " + s.total + " руб на:\n"
      + CONFIG.PHONE + " (Сбербанк / СБП)\n\n"
      + "После оплаты отправьте фото чека 📸\n"
      + "Бронь действует 1 час."
    );
  }

  if (no.some(w => low.includes(w))) {
    sessions[userId] = { step: "idle", channel };
    return await sendMsg(channel, userId,
      "Бронь отменена. Если захотите — пишите снова! 😊"
    );
  }

  return await sendMsg(channel, userId, "Ответьте: Да или Нет");
}

// ─── Обработка фото чека ─────────────────────────────────────────────────────

async function handleReceiptPhoto({ channel, userId }) {
  const s = sessions[userId];
  if (!s || s.step !== "wait_receipt") {
    console.log("⚠️ Фото получено но step не wait_receipt, step:", s?.step);
    return;
  }
  const info = CONFIG.PRICES[s.duration];
  const grp  = CONFIG.GROUPS[s.group];
  await notifyTelegram(
    "📸 ЧЕК ПОЛУЧЕН!\n\n"
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

// ─── Запуск сервера ──────────────────────────────────────────────────────────

const PORT = process.env.PORT || 8080;
app.listen(PORT, async () => {
  console.log("✅ Сервер запущен на порту " + PORT);
  await notifyTelegram("✅ Сервер запущен! Бот готов к работе.");
  startWhatsApp();
});
