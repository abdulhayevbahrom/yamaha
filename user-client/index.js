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
const logMessages = process.env.TG_LOG_MESSAGES === "1";
const adminNotifyChatId = process.env.ADMIN_NOTIFY_CHAT_ID || "";
const botToken = process.env.BOT_TOKEN || "";

let sessionAlertSent = false;

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
}

async function startUserClient({ strict = false } = {}) {
  try {
    await ensureDbReady();
  } catch (err) {
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
    await notifyAdminsAboutSessionIssue(error.message);
    throw error;
  }

  await client.connect();
  const isAuthorized = await client.checkAuthorization();
  if (!isAuthorized) {
    const error = new Error(
      "TG_USER_SESSION yaroqsiz yoki eskirgan. Yangi session string yarating.",
    );
    await notifyAdminsAboutSessionIssue(error.message);
    throw error;
  }
  console.log(
    `User-client ishga tushdi. CARDXABAR_CHAT_ID=${cardxabarChatId || "-"} CARDXABAR_USERNAME=${cardxabarUsername || "-"}`,
  );

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
          if (logMessages) {
            console.log(
              `[TG] skip chatId=${chatId} sender=${senderUsername || "-"} msgId=${message.id}`,
            );
          }
          return;
        }
      }

      if (logMessages) {
        console.log(
          `[TG] matched chatId=${chatId} sender=${senderUsername || "-"} msgId=${message.id} text=${text}`,
        );
      }

      const externalMessageId = `${chatId}:${message.id}`;
      const result = await processIncomingPayment({
        rawText: text,
        externalMessageId,
        source: "cardxabar-user",
      });
      if (logMessages) {
        console.log(
          `[TG] payment result matched=${Boolean(result?.matched)} reason=${result?.reason || "-"} amount=${result?.amount || 0}`,
        );
      }
    } catch (err) {
      console.error("User-client message error:", err.message);
    }
  }, new NewMessage({}));

  return client;
}

module.exports = { startUserClient };

if (require.main === module) {
  startUserClient({ strict: true }).catch(async (err) => {
    try {
      if (String(err.message || "").includes("TG_USER_SESSION")) {
        await notifyAdminsAboutSessionIssue(err.message);
      }
    } catch (_) {
      // ignore admin notify error
    }
    console.error("User-client start error:", err.message);
    process.exit(1);
  });
}
