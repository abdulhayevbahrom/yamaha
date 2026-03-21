require("dotenv").config();
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");
const { processIncomingPayment } = require("../services/payment-match.service");
const connectDB = require("../config/dbConfig");

const apiId = Number(process.env.TG_API_ID || 0);
const apiHash = process.env.TG_API_HASH || "";
const stringSession = new StringSession(process.env.TG_USER_SESSION || "");
const cardxabarChatId = String(process.env.CARDXABAR_CHAT_ID || "").trim();
const cardxabarUsername = String(
  process.env.CARDXABAR_USERNAME || "CardXabarBot",
).trim();
const adminNotifyChatId = process.env.ADMIN_NOTIFY_CHAT_ID || "";
const botToken = process.env.BOT_TOKEN || "";

let sessionAlertSent = false;
const runtimeStatus = {
  running: false,
  dbReady: false,
  sessionConfigured: Boolean(process.env.TG_USER_SESSION),
  authorized: false,
  startedAt: null,
  connectedAt: null,
  selfId: "",
  selfUsername: "",
  monitoredChatId: cardxabarChatId,
  monitoredUsername: cardxabarUsername,
  lastCommandAt: null,
  lastMonitoredMessageAt: null,
  lastPaymentProcessedAt: null,
  processedPayments: 0,
  matchedPayments: 0,
  lastError: "",
  lastErrorAt: null,
};

function markRuntimeError(reason) {
  runtimeStatus.lastError = String(reason || "").trim();
  runtimeStatus.lastErrorAt = new Date().toISOString();
}

function formatStatusTime(value) {
  if (!value) return "-";

  try {
    return new Date(value).toLocaleString("uz-UZ", {
      hour12: false,
      timeZone: process.env.TZ || "Asia/Tashkent",
    });
  } catch (_) {
    return String(value);
  }
}

function buildStatusMessage() {
  const stateLabel = runtimeStatus.running
    ? "Ishlayapti"
    : "Ishlamayapti";
  const sessionLabel = runtimeStatus.sessionConfigured
    ? runtimeStatus.authorized
      ? "Ulangan"
      : "Session bor, lekin ulanmagan"
    : "Session sozlanmagan";
  const monitorChat = runtimeStatus.monitoredChatId || "sozlanmagan";
  const monitorUser = runtimeStatus.monitoredUsername || "sozlanmagan";
  const lastError = runtimeStatus.lastError
    ? `${runtimeStatus.lastError} (${formatStatusTime(runtimeStatus.lastErrorAt)})`
    : "Yo'q";

  return [
    "🤖 User client holati",
    `Holat: ${stateLabel}`,
    `Session: ${sessionLabel}`,
    `DB: ${runtimeStatus.dbReady ? "Ulangan" : "Ulanmagan"}`,
    `Profil: ${runtimeStatus.selfUsername ? `@${runtimeStatus.selfUsername}` : "-"} ${runtimeStatus.selfId ? `(ID: ${runtimeStatus.selfId})` : ""}`.trim(),
    `Ishga tushgan vaqti: ${formatStatusTime(runtimeStatus.startedAt)}`,
    `Ulangan vaqti: ${formatStatusTime(runtimeStatus.connectedAt)}`,
    `Monitoring chat ID: ${monitorChat}`,
    `Monitoring username: ${monitorUser}`,
    `Oxirgi tekshirilgan buyruq: ${formatStatusTime(runtimeStatus.lastCommandAt)}`,
    `Oxirgi kuzatilgan xabar: ${formatStatusTime(runtimeStatus.lastMonitoredMessageAt)}`,
    `Oxirgi qayta ishlangan to'lov: ${formatStatusTime(runtimeStatus.lastPaymentProcessedAt)}`,
    `Qayta ishlangan to'lovlar soni: ${runtimeStatus.processedPayments}`,
    `Mos tushgan to'lovlar soni: ${runtimeStatus.matchedPayments}`,
    `Oxirgi xato: ${lastError}`,
  ].join("\n");
}

function isStatusCommand(text) {
  return /^\/status(?:@\w+)?$/i.test(String(text || "").trim());
}

if (!apiId || !apiHash) {
  throw new Error(
    "TG_API_ID yoki TG_API_HASH topilmadi. backend/.env ga kiriting.",
  );
}

if (!cardxabarChatId) {
  console.warn(
    "CARDXABAR_CHAT_ID topilmadi. User-client xabarlarni filter qilmaydi.",
  );
}

async function notifyAdminsAboutSessionIssue(reason) {
  if (sessionAlertSent) return;
  if (!botToken || !adminNotifyChatId) return;

  sessionAlertSent = true;
  const adminIds = adminNotifyChatId
    .split(",")
    .map((id) => String(id).trim())
    .filter(Boolean);

  if (adminIds.length === 0) return;

  const bot = new TelegramBot(botToken, { polling: false });
  const message = [
    "User-client ishlamayapti.",
    "Sabab: TG_USER_SESSION eskirgan yoki yaroqsiz.",
    `Xatolik: ${reason}`,
    "Yechim: yangi session olib, backend/.env dagi TG_USER_SESSION ni yangilang.",
  ].join("\n");

  await Promise.allSettled(
    adminIds.map((adminId) => bot.sendMessage(adminId, message)),
  );
}

async function ensureDbReady() {
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI topilmadi. backend/.env ga kiriting.");
  }
  await connectDB();
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connection.asPromise();
  }
  runtimeStatus.dbReady = true;
}

async function startUserClient({ strict = false } = {}) {
  try {
    await ensureDbReady();
  } catch (err) {
    markRuntimeError(err.message);
    if (strict) throw err;
    console.warn("User-client DB ulanmagan:", err.message);
    return null;
  }
  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
  });

  if (!process.env.TG_USER_SESSION) {
    const error = new Error(
      "TG_USER_SESSION topilmadi. Avval session string yarating va backend/.env ga yozing.",
    );
    markRuntimeError(error.message);
    await notifyAdminsAboutSessionIssue(error.message);
    throw error;
  }

  await client.connect();
  runtimeStatus.startedAt = new Date().toISOString();
  runtimeStatus.connectedAt = new Date().toISOString();
  const isAuthorized = await client.checkAuthorization();
  if (!isAuthorized) {
    const error = new Error(
      "TG_USER_SESSION yaroqsiz yoki eskirgan. Yangi session string yarating.",
    );
    markRuntimeError(error.message);
    await notifyAdminsAboutSessionIssue(error.message);
    throw error;
  }
  const me = await client.getMe();
  runtimeStatus.authorized = true;
  runtimeStatus.running = true;
  runtimeStatus.selfId = String(me?.id || "");
  runtimeStatus.selfUsername = String(me?.username || "").trim();
  console.log("User-client ishga tushdi.");

  client.addEventHandler(async (event) => {
    try {
      const message = event.message;
      if (!message) return;

      const text = String(message.message || "").trim();
      if (!text) return;

      const chatId =
        typeof message.chatId?.toString === "function"
          ? message.chatId.toString()
          : String(message.chatId || "").trim();

      if (chatId && runtimeStatus.selfId && chatId === runtimeStatus.selfId) {
        if (isStatusCommand(text)) {
          runtimeStatus.lastCommandAt = new Date().toISOString();
          await client.sendMessage("me", {
            message: buildStatusMessage(),
            replyTo: message.id,
          });
        }
        return;
      }

      if (message.out) {
        return;
      }

      const sender =
        message.sender || (typeof message.getSender === "function"
          ? await message.getSender()
          : null);
      const senderUsername = String(sender?.username || "").trim();
      const usernameMatch =
        cardxabarUsername &&
        senderUsername.toLowerCase() === cardxabarUsername.toLowerCase();
      const chatMatch = cardxabarChatId && chatId === cardxabarChatId;

      if (cardxabarChatId || cardxabarUsername) {
        if (!chatMatch && !usernameMatch) {
          return;
        }
      }

      runtimeStatus.lastMonitoredMessageAt = new Date().toISOString();
      const externalMessageId = `${chatId}:${message.id}`;
      const result = await processIncomingPayment({
        rawText: text,
        externalMessageId,
        source: "cardxabar-user",
      });
      runtimeStatus.lastPaymentProcessedAt = new Date().toISOString();
      runtimeStatus.processedPayments += 1;
      if (result?.matched) {
        runtimeStatus.matchedPayments += 1;
      }
    } catch (err) {
      markRuntimeError(err.message);
      console.error("User-client message error:", err.message);
    }
  }, new NewMessage({}));

  return client;
}

module.exports = { startUserClient, buildStatusMessage };

if (require.main === module) {
  startUserClient({ strict: true }).catch(async (err) => {
    try {
      if (String(err.message || "").includes("TG_USER_SESSION")) {
        await notifyAdminsAboutSessionIssue(err.message);
      }
    } catch (_) {
      // ignore admin notify error
    }
    markRuntimeError(err.message);
    console.error("User-client start error:", err.message);
    process.exit(1);
  });
}
