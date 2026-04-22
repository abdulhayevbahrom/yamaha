require("dotenv").config();
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");
const { processIncomingPayment } = require("../services/payment-match.service");
const connectDB = require("../config/dbConfig");
const { getTelegramCredentials } = require("../config/telegram-credentials");
const { acquireTelegramSessionLock } = require("../utils/telegram-session-lock");
const { buildTelegramClientOptions } = require("../utils/telegram-client-options");

const telegramCredentials = getTelegramCredentials("cardxabar");
const apiId = telegramCredentials.apiId;
const apiHash = telegramCredentials.apiHash;
const sessionString = telegramCredentials.sessionString;
const stringSession = new StringSession(sessionString || "");
const cardxabarChatId = String(process.env.CARDXABAR_CHAT_ID || "").trim();
const cardxabarUsername = String(
  process.env.CARDXABAR_USERNAME || "CardXabarBot",
).trim();
const adminNotifyChatId = process.env.ADMIN_NOTIFY_CHAT_ID || "";
const botToken = process.env.BOT_TOKEN || "";
const statusPollIntervalMs = Number(
  process.env.USER_CLIENT_STATUS_POLL_MS || 5000,
);

let sessionAlertSent = false;
let sessionLockHandle = null;
let startPromise = null;
let activeClient = null;
let shutdownHooksRegistered = false;
const runtimeStatus = {
  running: false,
  dbReady: false,
  sessionConfigured: Boolean(sessionString),
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
  statusWatcherRunning: false,
  lastSavedMessageId: 0,
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
    `Saved Messages kuzatuvi: ${runtimeStatus.statusWatcherRunning ? "Yoqilgan" : "O'chirilgan"}`,
    `Oxirgi Saved Messages ID: ${runtimeStatus.lastSavedMessageId || "-"}`,
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

async function releaseSessionLock() {
  if (!sessionLockHandle) return;
  const lock = sessionLockHandle;
  sessionLockHandle = null;
  await lock.release().catch(() => {});
}

function registerShutdownHooks() {
  if (shutdownHooksRegistered) return;
  shutdownHooksRegistered = true;

  const handleSignal = (signal, code) => {
    Promise.resolve(releaseSessionLock())
      .catch(() => {})
      .finally(() => {
        process.exit(code);
      });
  };

  process.once("SIGINT", () => handleSignal("SIGINT", 130));
  process.once("SIGTERM", () => handleSignal("SIGTERM", 143));
  process.once("beforeExit", () => {
    void releaseSessionLock();
  });
}

if (!apiId || !apiHash) {
  throw new Error(
    `Cardxabar Telegram account sozlanmagan. ${telegramCredentials.acceptedKeys.apiId.join(" yoki ")} va ${telegramCredentials.acceptedKeys.apiHash.join(" yoki ")} kerak.`,
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
    "Sabab: cardxabar session eskirgan yoki yaroqsiz.",
    `Xatolik: ${reason}`,
    `Yechim: yangi session olib, backend/.env dagi ${telegramCredentials.preferredKeys.session} ni yangilang.`,
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

async function startSavedMessagesStatusWatcher(client) {
  let inFlight = false;
  let lastSeenId = 0;

  const readRecentMessages = async () => {
    const recent = await client.getMessages("me", { limit: 5 });
    return Array.isArray(recent) ? recent : Array.from(recent || []);
  };

  const checkSavedMessages = async () => {
    if (inFlight || !runtimeStatus.running || !client.connected) return;

    inFlight = true;
    try {
      const recent = await readRecentMessages();
      const freshMessages = recent
        .filter((message) => Number(message?.id || 0) > lastSeenId)
        .sort((left, right) => Number(left.id || 0) - Number(right.id || 0));

      for (const message of freshMessages) {
        const messageId = Number(message?.id || 0);
        if (messageId > lastSeenId) {
          lastSeenId = messageId;
          runtimeStatus.lastSavedMessageId = messageId;
        }

        const text = String(message?.message || message?.rawText || "").trim();
        if (!isStatusCommand(text)) continue;

        runtimeStatus.lastCommandAt = new Date().toISOString();
        await client.sendMessage("me", {
          message: buildStatusMessage(),
          replyTo: message.id,
        });
      }
    } catch (error) {
      markRuntimeError(error.message);
    } finally {
      inFlight = false;
    }
  };

  try {
    const seedMessages = await readRecentMessages();
    const latestMessage = seedMessages[0];
    lastSeenId = Number(latestMessage?.id || 0);
    runtimeStatus.lastSavedMessageId = lastSeenId;
  } catch (error) {
    markRuntimeError(error.message);
  }

  runtimeStatus.statusWatcherRunning = true;
  const timer = setInterval(() => {
    void checkSavedMessages();
  }, Math.max(statusPollIntervalMs, 2000));

  if (typeof timer.unref === "function") {
    timer.unref();
  }

  void checkSavedMessages();
  return timer;
}

async function startUserClient({ strict = false } = {}) {
  if (activeClient?.connected) {
    return activeClient;
  }

  if (startPromise) {
    return startPromise;
  }

  startPromise = (async () => {
    try {
      await ensureDbReady();
    } catch (err) {
      markRuntimeError(err.message);
      if (strict) throw err;
      console.warn("User-client DB ulanmagan:", err.message);
      return null;
    }

    if (!sessionString) {
      const error = new Error(
        `${telegramCredentials.acceptedKeys.session.join(" yoki ")} topilmadi. Avval session string yarating va backend/.env ga yozing.`,
      );
      markRuntimeError(error.message);
      await notifyAdminsAboutSessionIssue(error.message);
      throw error;
    }

    try {
      if (!sessionLockHandle) {
        sessionLockHandle = await acquireTelegramSessionLock({
          scope: "cardxabar-user-client",
          sessionString,
        });
        registerShutdownHooks();
      }
    } catch (lockError) {
      markRuntimeError(lockError.message);
      if (strict) throw lockError;
      console.warn("User-client session lock olinmadi:", lockError.message);
      return null;
    }

    const client = new TelegramClient(stringSession, apiId, apiHash, {
      ...buildTelegramClientOptions({ connectionRetries: 5 }),
    });

    try {
      await client.connect();
      runtimeStatus.startedAt = new Date().toISOString();
      runtimeStatus.connectedAt = new Date().toISOString();
      const isAuthorized = await client.checkAuthorization();
      if (!isAuthorized) {
        const error = new Error(
          `${telegramCredentials.resolvedKeys.session || telegramCredentials.preferredKeys.session} yaroqsiz yoki eskirgan. Yangi session string yarating.`,
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
      await startSavedMessagesStatusWatcher(client);
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

      activeClient = client;
      return client;
    } catch (error) {
      await releaseSessionLock();
      throw error;
    }
  })();

  try {
    return await startPromise;
  } finally {
    startPromise = null;
  }
}

module.exports = { startUserClient, buildStatusMessage };

if (require.main === module) {
  startUserClient({ strict: true }).catch(async (err) => {
    try {
      const rawError = String(err.message || "").toUpperCase();
      if (rawError.includes("SESSION")) {
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
