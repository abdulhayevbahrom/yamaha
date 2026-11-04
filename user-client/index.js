require("dotenv").config();
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");
const PaymentLog = require("../model/payment-log.model");
const { processIncomingPayment } = require("../services/payment-match.service");
const connectDB = require("../config/dbConfig");
const { getTelegramCredentials } = require("../config/telegram-credentials");
const { acquireTelegramSessionLock } = require("../utils/telegram-session-lock");
const { buildTelegramClientOptions } = require("../utils/telegram-client-options");
const {
  shouldProcessCardxabarMessage,
} = require("../utils/cardxabar-message-filter");
const {
  processGwPriceAlertMessage,
} = require("../services/gw-price-alert.service");
const {
  isGwPriceAlertText,
} = require("../utils/gw-price-update");

const telegramCredentials = getTelegramCredentials("cardxabar");
const apiId = telegramCredentials.apiId;
const apiHash = telegramCredentials.apiHash;
const sessionString = telegramCredentials.sessionString;
const stringSession = new StringSession(sessionString || "");
const cardxabarChatId = String(process.env.CARDXABAR_CHAT_ID || "").trim();
const cardxabarUsername = String(
  process.env.CARDXABAR_USERNAME || "CardXabarBot",
).trim();
const gwPriceAlertChatId = String(process.env.GW_PRICE_ALERT_SOURCE_CHAT_ID || "").trim();
const gwPriceAlertUsername = String(
  process.env.GW_PRICE_ALERT_SOURCE_USERNAME || "gwbotupdate",
).trim();
const adminNotifyChatId = process.env.ADMIN_NOTIFY_CHAT_ID || "";
const botToken = process.env.BOT_TOKEN || "";
const statusPollIntervalMs = Number(
  process.env.USER_CLIENT_STATUS_POLL_MS || 5000,
);
const historyPollIntervalMs = Number(
  process.env.CARDXABAR_HISTORY_POLL_MS || 15000,
);
const historyPollLimit = Math.min(
  Math.max(Number(process.env.CARDXABAR_HISTORY_POLL_LIMIT || 100), 10),
  500,
);
const historyProcessingRetryMs = 30_000;
const historyLookbackMs = Math.max(
  Number(process.env.CARDXABAR_HISTORY_LOOKBACK_MS || 15 * 60 * 1000),
  60_000,
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
  gwAlertChatId: gwPriceAlertChatId,
  gwAlertUsername: gwPriceAlertUsername,
  lastCommandAt: null,
  lastMonitoredMessageAt: null,
  lastGwAlertAt: null,
  lastPaymentProcessedAt: null,
  processedPayments: 0,
  matchedPayments: 0,
  processedGwAlerts: 0,
  lastGwAlertReason: "",
  lastGwAlertSource: "",
  statusWatcherRunning: false,
  historyRecoveryRunning: false,
  lastHistoryRecoveryAt: null,
  lastHistoryRecoveryCount: 0,
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
    `GW alert chat ID: ${runtimeStatus.gwAlertChatId || "sozlanmagan"}`,
    `GW alert username: ${runtimeStatus.gwAlertUsername || "sozlanmagan"}`,
    `Oxirgi tekshirilgan buyruq: ${formatStatusTime(runtimeStatus.lastCommandAt)}`,
    `Saved Messages kuzatuvi: ${runtimeStatus.statusWatcherRunning ? "Yoqilgan" : "O'chirilgan"}`,
    `CardXabar history recovery: ${runtimeStatus.historyRecoveryRunning ? "Yoqilgan" : "O'chirilgan"}`,
    `Oxirgi history recovery: ${formatStatusTime(runtimeStatus.lastHistoryRecoveryAt)}`,
    `Oxirgi recovery xabarlari: ${runtimeStatus.lastHistoryRecoveryCount}`,
    `Oxirgi Saved Messages ID: ${runtimeStatus.lastSavedMessageId || "-"}`,
    `Oxirgi kuzatilgan xabar: ${formatStatusTime(runtimeStatus.lastMonitoredMessageAt)}`,
    `Oxirgi GW alert: ${formatStatusTime(runtimeStatus.lastGwAlertAt)}`,
    `Oxirgi GW alert sababi: ${runtimeStatus.lastGwAlertReason || "-"}`,
    `Oxirgi GW alert manbasi: ${runtimeStatus.lastGwAlertSource || "-"}`,
    `Oxirgi qayta ishlangan to'lov: ${formatStatusTime(runtimeStatus.lastPaymentProcessedAt)}`,
    `Qayta ishlangan to'lovlar soni: ${runtimeStatus.processedPayments}`,
    `Mos tushgan to'lovlar soni: ${runtimeStatus.matchedPayments}`,
    `Qayta ishlangan GW alertlar: ${runtimeStatus.processedGwAlerts}`,
    `Oxirgi xato: ${lastError}`,
  ].join("\n");
}

function isStatusCommand(text) {
  return /^\/status(?:@\w+)?$/i.test(String(text || "").trim());
}

function normalizeIdentity(value) {
  return String(value || "").trim().toLowerCase().replace(/^@/, "");
}

function getMessageChatId(message) {
  if (typeof message?.chatId?.toString === "function") {
    return message.chatId.toString();
  }
  return String(message?.chatId || cardxabarChatId || "").trim();
}

function getMessageDate(message) {
  const rawDate = message?.date;
  if (rawDate instanceof Date && Number.isFinite(rawDate.getTime())) {
    return rawDate;
  }
  const numericDate = Number(rawDate || 0);
  if (Number.isFinite(numericDate) && numericDate > 0) {
    return new Date(
      numericDate < 10_000_000_000 ? numericDate * 1000 : numericDate,
    );
  }
  return new Date();
}

function collectMessageSourceCandidates(message, sender) {
  const messageChat = message?.chat || null;
  const peerId =
    typeof message?.chatId?.toString === "function"
      ? message.chatId.toString()
      : String(message?.chatId || "").trim();

  return {
    chatId: peerId,
    usernames: [
      sender?.username,
      messageChat?.username,
      message?.chat?.username,
    ]
      .map((value) => normalizeIdentity(value))
      .filter(Boolean),
    labels: [
      sender?.firstName,
      sender?.title,
      messageChat?.title,
      messageChat?.username,
    ]
      .map((value) => String(value || "").trim())
      .filter(Boolean),
  };
}

function isGwAlertSourceMessage({ message, sender, text }) {
  const expectedChatId = String(gwPriceAlertChatId || "").trim();
  const expectedUsername = normalizeIdentity(gwPriceAlertUsername);
  const source = collectMessageSourceCandidates(message, sender);

  const chatIdMatches = Boolean(
    expectedChatId && source.chatId && String(source.chatId) === expectedChatId,
  );
  const usernameMatches = Boolean(
    expectedUsername && source.usernames.some((value) => value === expectedUsername),
  );
  const looksLikeGwAlert = isGwPriceAlertText(text);

  if (chatIdMatches || usernameMatches) {
    return {
      matched: true,
      reason: chatIdMatches ? "source_chat_id" : "source_username",
      source,
    };
  }

  if (!expectedChatId && expectedUsername && looksLikeGwAlert) {
    return {
      matched: true,
      reason: "price_alert_text_fallback",
      source,
    };
  }

  return {
    matched: false,
    reason: looksLikeGwAlert ? "source_identity_mismatch" : "not_gw_alert_text",
    source,
  };
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
      const processingMessageKeys = new Set();

      const processTelegramMessage = async (message) => {
        try {
          if (!message) return;

          const text = String(message.message || "").trim();
          if (!text) return;

          const chatId = getMessageChatId(message);

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
          const gwSourceMatch = isGwAlertSourceMessage({
            message,
            sender,
            text,
          });
          if (gwSourceMatch.matched) {
            const alertResult = await processGwPriceAlertMessage(text);
            runtimeStatus.lastGwAlertAt = new Date().toISOString();
            runtimeStatus.lastGwAlertReason = String(alertResult?.reason || gwSourceMatch.reason || "").trim();
            runtimeStatus.lastGwAlertSource = [
              `chat:${gwSourceMatch.source?.chatId || "-"}`,
              `user:${(gwSourceMatch.source?.usernames || [])[0] || "-"}`,
              `mode:${gwSourceMatch.reason}`,
            ].join(" | ");
            if (alertResult?.sent > 0) {
              runtimeStatus.processedGwAlerts += Number(alertResult.sent || 0);
            }
            console.log(
              "[gw-price-alert]",
              JSON.stringify({
                reason: alertResult?.reason || "",
                parsed: Number(alertResult?.parsed || 0),
                matched: Number(alertResult?.matched || 0),
                sent: Number(alertResult?.sent || 0),
                skipped: Number(alertResult?.skipped || 0),
                unmatched: Array.isArray(alertResult?.unmatched)
                  ? alertResult.unmatched.slice(0, 5)
                  : [],
                sendFailures: Array.isArray(alertResult?.sendFailures)
                  ? alertResult.sendFailures.slice(0, 3)
                  : [],
                source: gwSourceMatch.source,
              }),
            );
          }
          else if (isGwPriceAlertText(text)) {
            runtimeStatus.lastGwAlertAt = new Date().toISOString();
            runtimeStatus.lastGwAlertReason = gwSourceMatch.reason;
            runtimeStatus.lastGwAlertSource = [
              `chat:${gwSourceMatch.source?.chatId || "-"}`,
              `user:${(gwSourceMatch.source?.usernames || [])[0] || "-"}`,
              `mode:${gwSourceMatch.reason}`,
            ].join(" | ");
            console.log(
              "[gw-price-alert]",
              JSON.stringify({
                reason: gwSourceMatch.reason,
                source: gwSourceMatch.source,
              }),
            );
          }

          if (
            !shouldProcessCardxabarMessage({
              configuredChatId: cardxabarChatId,
              configuredUsername: cardxabarUsername,
              messageChatId: chatId,
              senderUsername,
            })
          ) {
            return;
          }

          runtimeStatus.lastMonitoredMessageAt = new Date().toISOString();
          const externalMessageId = `${chatId}:${message.id}`;
          if (processingMessageKeys.has(externalMessageId)) return;

          processingMessageKeys.add(externalMessageId);
          try {
            const result = await processIncomingPayment({
              rawText: text,
              externalMessageId,
              source: "cardxabar-user",
              occurredAt: getMessageDate(message),
            });
            runtimeStatus.lastPaymentProcessedAt = new Date().toISOString();
            runtimeStatus.processedPayments += 1;
            if (result?.matched) {
              runtimeStatus.matchedPayments += 1;
            }
          } finally {
            processingMessageKeys.delete(externalMessageId);
          }
        } catch (err) {
          markRuntimeError(err.message);
          console.error("User-client message error:", err.message);
        }
      };

      const handleIncomingTelegramMessage = async (event) => {
        await processTelegramMessage(event.message);
      };

      client.addEventHandler(handleIncomingTelegramMessage, new NewMessage({}));

      let historyRecoveryInFlight = false;
      const recoverCardxabarHistory = async () => {
        if (
          historyRecoveryInFlight ||
          !runtimeStatus.running ||
          !client.connected
        ) {
          return;
        }

        historyRecoveryInFlight = true;
        try {
          const historyTargets = [cardxabarChatId, cardxabarUsername].filter(
            (value, index, values) => value && values.indexOf(value) === index,
          );
          if (historyTargets.length === 0) return;

          let recent = null;
          let historyError = null;
          for (const historyTarget of historyTargets) {
            try {
              recent = await client.getMessages(historyTarget, {
                limit: historyPollLimit,
              });
              break;
            } catch (error) {
              historyError = error;
            }
          }
          if (recent == null) {
            throw historyError || new Error("CardXabar chat tarixi topilmadi");
          }
          const messages = (Array.isArray(recent)
            ? recent
            : Array.from(recent || []))
            .filter(Boolean)
            .filter(
              (message) =>
                getMessageDate(message).getTime() >=
                Date.now() - historyLookbackMs,
            )
            .sort((left, right) => Number(left.id || 0) - Number(right.id || 0));

          const messageKeyPairs = messages.map((message) => {
            const chatId = getMessageChatId(message);
            return {
              message,
              externalMessageId: `${chatId}:${message.id}`,
            };
          });
          const existingLogs = await PaymentLog.find({
            source: "cardxabar-user",
            externalMessageId: {
              $in: messageKeyPairs.map((item) => item.externalMessageId),
            },
          })
            .select({ externalMessageId: 1, status: 1, createdAt: 1 })
            .lean();
          const staleBefore = Date.now() - historyProcessingRetryMs;
          const existingKeys = new Set(
            existingLogs
              .filter(
                (item) =>
                  item.status !== "processing" ||
                  new Date(item.createdAt || 0).getTime() > staleBefore,
              )
              .map((item) => String(item.externalMessageId || "")),
          );
          const missingMessages = messageKeyPairs
            .filter((item) => !existingKeys.has(item.externalMessageId))
            .map((item) => item.message);

          for (const message of missingMessages) {
            await processTelegramMessage(message);
          }

          runtimeStatus.lastHistoryRecoveryAt = new Date().toISOString();
          runtimeStatus.lastHistoryRecoveryCount = missingMessages.length;
        } catch (error) {
          markRuntimeError(error.message);
          console.error("CardXabar history recovery error:", error.message);
        } finally {
          historyRecoveryInFlight = false;
        }
      };

      runtimeStatus.historyRecoveryRunning = true;
      const historyTimer = setInterval(() => {
        void recoverCardxabarHistory();
      }, Math.max(historyPollIntervalMs, 5000));
      if (typeof historyTimer.unref === "function") {
        historyTimer.unref();
      }
      void recoverCardxabarHistory();

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
