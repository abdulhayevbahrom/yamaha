require("dotenv").config();
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const mongoose = require("mongoose");
const { processIncomingPayment } = require("../services/payment-match.service");
const connectDB = require("../config/dbConfig");

const apiId = Number(process.env.TG_API_ID || 0);
const apiHash = process.env.TG_API_HASH || "";
const stringSession = new StringSession(process.env.TG_USER_SESSION || "");
const cardxabarChatId = process.env.CARDXABAR_CHAT_ID || "";
const cardxabarUsername = process.env.CARDXABAR_USERNAME || "CardXabarBot";
const logMessages = process.env.TG_LOG_MESSAGES === "1";

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
    throw new Error(
      "TG_USER_SESSION topilmadi. Avval session string yarating va backend/.env ga yozing.",
    );
  }

  await client.start({}); // StringSession bo'lsa avtomatik auth
  console.log("User-client ishga tushdi.");

  client.addEventHandler(async (event) => {
    try {
      const message = event.message;
      if (!message || !message.message) return;

      const chatId = String(message.chatId || "");
      const sender = message.sender;
      const senderUsername = sender?.username || "";
      if (cardxabarChatId && chatId !== String(cardxabarChatId)) return;
      if (!cardxabarChatId && senderUsername !== cardxabarUsername) return;
      // if (logMessages) {
      // console.log(
      //   `[TG] chatId=${chatId} msgId=${message.id} text=${message.message}`
      // );
      // }

      const externalMessageId = `${chatId}:${message.id}`;
      await processIncomingPayment({
        rawText: message.message,
        externalMessageId,
        source: "cardxabar-user",
      });
    } catch (err) {
      console.error("User-client message error:", err.message);
    }
  }, new NewMessage({}));

  return client;
}

module.exports = { startUserClient };

if (require.main === module) {
  startUserClient({ strict: true }).catch((err) => {
    console.error("User-client start error:", err.message);
    process.exit(1);
  });
}
