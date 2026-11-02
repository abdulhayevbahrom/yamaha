require("dotenv").config();
const path = require("node:path");
const TelegramBot = require("node-telegram-bot-api");
const connectDB = require("../config/dbConfig");
const {
  processTelegramStarsPayment,
} = require("../services/payment-match.service");
const { onGamePaid } = require("../services/notify.service");
const {
  confirmGameOrderById,
  cancelGameOrderById,
} = require("../services/uc-fulfillment.service");
const {
  confirmStarSellPayoutById,
  cancelStarSellPayoutById,
  getManagerUsername,
} = require("../services/star-sell-payout.service");
const {
  confirmNftWithdrawalById,
  cancelNftWithdrawalById,
  buildAdminText,
} = require("../services/nft-withdrawal-payout.service");
const {
  checkForceJoinMembership,
  buildJoinUrl,
} = require("../services/force-join.service");
const { getBotStatus } = require("../services/settings.service");
const {
  approveBalanceTopupReview,
  rejectBalanceTopupReview,
} = require("../services/balance-topup-review.service");
const Order = require("../model/order.model");
const User = require("../model/user.model");
const Broadcast = require("../model/broadcast.model");
const BroadcastDelivery = require("../model/broadcastDelivery.model");
const { bindReferralFromStart } = require("../services/referral.service");
const {
  refreshCounts,
  startBroadcastWorker,
} = require("../services/broadcast-worker.service");

const startCaption =
  "Star, Premium, PUBG UC va MLBB Diamond ni xavfsiz sotib oling.\n\nDo'konga kirish uchun tugmani bosing.";

const getGameProductLabel = (product) => {
  const key = String(product || "").trim().toLowerCase();
  if (key === "mlbb") return "MLBB";
  if (key === "freefire") return "Free Fire";
  if (key === "uc") return "UC";
  return "O'yin";
};

const getPaymentMethodLabel = (paymentMethod) => {
  const key = String(paymentMethod || "").trim().toLowerCase();
  if (key === "stars") return "Telegram Stars";
  if (key === "card") return "Karta";
  if (key === "balance") return "Balans";
  if (key === "bankomat") return "Bankomat";
  if (key === "click") return "Click";
  if (key === "paynet") return "Paynet";
  if (key === "uzumbank") return "UzumBank";
  return key || "-";
};

const splitMlbbAccount = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return { playerId: "", zoneId: "" };
  const separatorIndex = raw.indexOf(":");
  if (separatorIndex < 0) {
    return { playerId: raw, zoneId: "" };
  }
  return {
    playerId: raw.slice(0, separatorIndex).trim(),
    zoneId: raw.slice(separatorIndex + 1).trim(),
  };
};

const buildGameAccountLines = ({ product, username, playerId, zoneId }) => {
  const key = String(product || "").trim().toLowerCase();
  if (key !== "mlbb") {
    return [`🆔 ID: <code>${String(username || "").trim() || "-"}</code>`];
  }

  let resolvedPlayerId = String(playerId || "").trim();
  let resolvedZoneId = String(zoneId || "").trim();

  if (!resolvedPlayerId || !resolvedZoneId) {
    const parsed = splitMlbbAccount(username);
    if (!resolvedPlayerId) resolvedPlayerId = parsed.playerId;
    if (!resolvedZoneId) resolvedZoneId = parsed.zoneId;
  }

  const lines = [
    `🆔 ID: <code>${resolvedPlayerId || String(username || "").trim() || "-"}</code>`,
  ];
  if (resolvedZoneId) {
    lines.push(`🗺 Zone ID: <code>${resolvedZoneId}</code>`);
  }
  return lines;
};

const getSafeFragmentTx = (order) =>
  order?.fragmentTx &&
  typeof order.fragmentTx === "object" &&
  !Array.isArray(order.fragmentTx)
    ? order.fragmentTx
    : {};

const syncGameAdminMessages = async ({
  order,
  statusLine,
  fallbackChatId = null,
  fallbackMessageId = null,
}) => {
  const updatedMessage = [
    `💬 ${getGameProductLabel(order?.product)} to'lov tushdi`,
    `🧾 Buyurtma: <code>${String(order?.orderId || "-")}</code>`,
    ...buildGameAccountLines({
      product: order?.product,
      username: order?.username,
      playerId: order?.playerId,
      zoneId: order?.zoneId,
    }),
    `🎮 Miqdor: <code>${order?.planCode || "-"}</code>`,
    `💵 Summa: <b>${order?.expectedAmount || 0} UZS</b>`,
    statusLine,
  ].join("\n");

  const fragmentTx = getSafeFragmentTx(order);
  const items = Array.isArray(fragmentTx?.gameAdminNotifications)
    ? fragmentTx.gameAdminNotifications
    : [];

  if (items.length) {
    await Promise.allSettled(
      items.map((item) =>
        bot.editMessageText(updatedMessage, {
          chat_id: item?.chatId,
          message_id: item?.messageId,
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [] },
        }),
      ),
    );
    return;
  }

  if (fallbackChatId && fallbackMessageId) {
    await bot.editMessageText(updatedMessage, {
      chat_id: fallbackChatId,
      message_id: fallbackMessageId,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [] },
    });
  }
};

const buildStarSellAdminSummary = (order, statusText) => {
  const username = String(order?.tgUsername || "").trim();
  const usernameLabel = username ? `@${username}` : "-";
  return [
    "⭐ Star sotish to'lovi qabul qilindi",
    `🧾 Buyurtma: #${order?.orderId || "-"}`,
    `👤 Mijoz: ${usernameLabel} (${String(order?.tgUserId || "-")})`,
    `✨ Star: ${Number(order?.customAmount || 0).toLocaleString("uz-UZ")}`,
    `💵 To'lov summasi: ${Number(order?.expectedAmount || 0).toLocaleString("uz-UZ")} UZS`,
    `💳 Mijoz kartasi: ${String(order?.sellCardNumber || "-")}`,
    statusText,
  ].join("\n");
};

const extractOrderIdFromInvoicePayload = (rawPayload) => {
  const payload = String(rawPayload || "").trim();
  if (!payload) return "";

  const knownPrefixes = [
    "stars_order:",
    "stars_sell_order:",
    "star_sell_order:",
    "order:",
  ];
  for (const prefix of knownPrefixes) {
    if (payload.startsWith(prefix)) {
      const candidate = payload.slice(prefix.length).split(":")[0]?.trim();
      if (candidate) return candidate;
    }
  }

  const objectIdMatch = payload.match(/\b[a-f0-9]{24}\b/i);
  return String(objectIdMatch?.[0] || "").trim();
};

const normalizeTelegramEntities = (entities) => {
  if (!Array.isArray(entities)) return [];
  return entities
    .filter((entity) => entity && typeof entity === "object")
    .map((entity) => ({ ...entity }));
};

const BROADCAST_APP_TARGETS = new Set([
  "home",
  "orders",
  "gifts",
  "profile",
  "referral",
  "contest",
  "balance",
  "star-sell",
]);

const parseBroadcastButtons = (value, webAppUrl = "") => {
  const lines = String(value || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return { ok: true, buttons: [] };
  if (lines.length > 8) return { ok: false, reason: "Ko'pi bilan 8 ta tugma kiriting." };
  const buttons = [];
  for (const line of lines) {
    const separator = line.indexOf("|");
    const text = line.slice(0, separator).trim();
    const destination = line.slice(separator + 1).trim();
    if (separator < 1 || !text) {
      return { ok: false, reason: `Noto'g'ri tugma: ${line}\nFormat: Nomi | https://example.com` };
    }
    if (/^app:/i.test(destination)) {
      const target = destination.slice(4).trim().toLowerCase().replace(/^\/+|\/+$/g, "");
      const gameKey = target.startsWith("games/") ? target.slice(6) : "";
      if (!webAppUrl || (!BROADCAST_APP_TARGETS.has(target) && !["stars", "premium", "pubg", "freefire", "mlbb", "hok", "roblox", "bloodstrike", "deltaforce"].includes(gameKey))) {
        return { ok: false, reason: `Web App bo'limi noto'g'ri: ${destination}` };
      }
      let appUrl;
      try {
        appUrl = new URL(webAppUrl);
      } catch (_) {
        return { ok: false, reason: "WEB_APP_URL sozlanmagan yoki noto'g'ri." };
      }
      appUrl.hash = `#/${target}`;
      buttons.push([{ text: text.slice(0, 64), web_app: { url: appUrl.toString() } }]);
      continue;
    }
    if (!/^https?:\/\/\S+$/i.test(destination)) {
      return { ok: false, reason: `Noto'g'ri tugma: ${line}\nFormat: Nomi | app:profile yoki https://example.com` };
    }
    buttons.push([{ text: text.slice(0, 64), url: destination }]);
  }
  return { ok: true, buttons };
};

const parseTashkentSchedule = (value) => {
  const raw = String(value || "").trim().toLowerCase();
  if (["hozir", "now", "/now"].includes(raw)) return new Date();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ t](\d{2}):(\d{2})$/);
  if (!match) return null;
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:00+05:00`);
  if (Number.isNaN(date.getTime()) || date.getTime() < Date.now() - 60_000) return null;
  return date;
};

const formatTashkentDate = (date) =>
  new Intl.DateTimeFormat("uz-UZ", {
    timeZone: "Asia/Tashkent",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(date));

const WEB_APP_BUTTON_TARGETS = [
  ["🏠 Bosh sahifa", "home"],
  ["🛍 Buyurtmalar", "orders"],
  ["🎁 Giftlar", "gifts"],
  ["👤 Profil", "profile"],
  ["👥 Referral", "referral"],
  ["🏆 Konkurs", "contest"],
  ["💳 Balans", "balance"],
  ["⭐ Stars sotish", "star-sell"],
  ["⭐ Stars", "games/stars"],
  ["💎 Premium", "games/premium"],
  ["🎮 PUBG", "games/pubg"],
  ["🔥 Free Fire", "games/freefire"],
  ["💠 MLBB", "games/mlbb"],
  ["👑 HOK", "games/hok"],
  ["🧱 Roblox", "games/roblox"],
  ["🩸 Blood Strike", "games/bloodstrike"],
  ["DF Delta Force", "games/deltaforce"],
];

const buildWebAppTargetKeyboard = (broadcastId) => {
  const rows = [];
  for (let index = 0; index < WEB_APP_BUTTON_TARGETS.length; index += 2) {
    rows.push(
      WEB_APP_BUTTON_TARGETS.slice(index, index + 2).map(([label, target]) => ({
        text: label,
        callback_data: `AD_TARGET:${broadcastId}:${target}`,
      })),
    );
  }
  rows.push([{ text: "🌐 Tashqi URL", callback_data: `AD_EXTERNAL:${broadcastId}` }]);
  return { inline_keyboard: rows };
};

const isTelegramRecipientUnavailableError = (error) => {
  const statusCode = Number(
    error?.response?.statusCode ||
      error?.response?.status ||
      error?.response?.body?.error_code ||
      0,
  );
  const message = String(
    error?.response?.body?.description || error?.message || error || "",
  ).toLowerCase();

  return (
    statusCode === 403 &&
    (message.includes("bot was blocked by the user") ||
      message.includes("user is deactivated") ||
      message.includes("bot can't initiate conversation with a user"))
  );
};

const isTelegramMessageNotModifiedError = (error) => {
  const statusCode = Number(
    error?.response?.statusCode ||
      error?.response?.status ||
      error?.response?.body?.error_code ||
      0,
  );
  const message = String(
    error?.response?.body?.description || error?.message || error || "",
  ).toLowerCase();

  return statusCode === 400 && message.includes("message is not modified");
};

async function startBot({ strict = false } = {}) {
  const token = process.env.BOT_TOKEN;
  const webAppUrl = process.env.WEB_APP_URL;
  const adminNotifyChatId = process.env.ADMIN_NOTIFY_CHAT_ID || "";
  const startPhotoPath =
    process.env.START_PHOTO_PATH || path.join(__dirname, "..", "home.jpg");

  if (!token || !webAppUrl) {
    const message =
      "Bot ishga tushmadi: BOT_TOKEN yoki WEB_APP_URL topilmadi (backend/.env).";
    if (strict) throw new Error(message);
    console.warn(message);
    return null;
  }

  try {
    await connectDB();
  } catch (error) {
    if (strict) throw error;
    console.warn("Telegram bot DB ulanmagan:", error?.message || error);
    return null;
  }

  const bot = new TelegramBot(token, {
    polling: {
      autoStart: true,
      params: {
        allowed_updates: ["message", "callback_query", "pre_checkout_query"],
      },
    },
  });
  const firstSeen = new Set();
  const forceJoinPassedUsers = new Set();
  const adminIds = adminNotifyChatId
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const startPhotoExt = path.extname(startPhotoPath).toLowerCase();
  const startPhotoContentType =
    {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".webp": "image/webp",
    }[startPhotoExt] || "application/octet-stream";

  const isAdmin = (chatId) => adminIds.includes(String(chatId));
  const withSafeHandler = (scope, handler) => {
    return async (...args) => {
      try {
        await handler(...args);
      } catch (error) {
        if (
          scope === "callback_query" &&
          isTelegramMessageNotModifiedError(error)
        ) {
          return;
        }
        if (isTelegramRecipientUnavailableError(error)) {
          console.info(
            `[telegram-bot:${scope}] recipient unavailable; update ignored`,
          );
          return;
        }
        console.error(
          `[telegram-bot:${scope}]`,
          error?.message || "Unknown error",
        );
      }
    };
  };
  const transientTelegramErrorWindowMs = 5 * 60 * 1000;
  const transientTelegramErrorLastLog = new Map();

  const isTransientTelegramTransportError = (error) => {
    const message = String(error?.message || error || "")
      .trim()
      .toUpperCase();
    return (
      message.includes("ETIMEDOUT") ||
      message.includes("ECONNRESET") ||
      message.includes("EAI_AGAIN")
    );
  };

  const logTelegramTransportError = (scope, error) => {
    const message = String(error?.message || error || "Unknown error").trim();
    if (!isTransientTelegramTransportError(error)) {
      console.error(`Telegram ${scope} error:`, message);
      return;
    }

    const now = Date.now();
    const key = String(scope || "unknown");
    const lastLogAt = Number(transientTelegramErrorLastLog.get(key) || 0);
    if (now - lastLogAt < transientTelegramErrorWindowMs) {
      return;
    }

    transientTelegramErrorLastLog.set(key, now);
    console.warn(
      `Telegram ${scope} transient network issue (throttled):`,
      message,
    );
  };

  bot.on("polling_error", (error) => {
    logTelegramTransportError("polling", error);
  });
  bot.on("webhook_error", (error) => {
    logTelegramTransportError("webhook", error);
  });

  try {
    await bot.deleteWebHook({ drop_pending_updates: false });
  } catch (error) {
    console.warn(
      "Webhook disable warning:",
      String(error?.message || error || "").trim(),
    );
  }

  bot.on(
    "pre_checkout_query",
    withSafeHandler("pre_checkout_query", async (query) => {
      let answered = false;
      const safeAnswer = async (ok, errorMessage = "") => {
        if (answered) return;
        answered = true;
        if (ok) {
          await bot.answerPreCheckoutQuery(query.id, true);
          return;
        }
        await bot.answerPreCheckoutQuery(query.id, false, {
          error_message: errorMessage || "To'lovni tekshirishda xatolik",
        });
      };

      const fallbackTimer = setTimeout(() => {
        safeAnswer(false, "Server band. Qayta urinib ko'ring.").catch(() => null);
      }, 8500);

      try {
        const payload = String(query?.invoice_payload || "").trim();
        const currency = String(query?.currency || "").trim().toUpperCase();
        const totalAmount = Math.floor(Number(query?.total_amount || 0));
        const updateUserId = String(query?.from?.id || "").trim();

        const orderMongoId = extractOrderIdFromInvoicePayload(payload);
        if (!orderMongoId) {
          await safeAnswer(false, "Noto'g'ri invoice payload");
          return;
        }

        if (currency !== "XTR") {
          await safeAnswer(false, "Faqat Telegram Stars (XTR) qabul qilinadi");
          return;
        }

        const order = await Promise.race([
          Order.findById(orderMongoId).lean(),
          new Promise((resolve) => setTimeout(() => resolve(null), 4000)),
        ]);
        if (!order) {
          await safeAnswer(false, "Buyurtma topilmadi");
          return;
        }

        if (String(order.paymentMethod || "") !== "stars") {
          await safeAnswer(false, "Stars to'lov faqat stars order uchun");
          return;
        }

        if (String(order.status || "") !== "pending_payment") {
          await safeAnswer(false, "Buyurtma holati to'lovga mos emas");
          return;
        }

        const expectedStars = Math.max(
          0,
          Math.floor(Number(order.starsAmount || 0)),
        );
        if (expectedStars > 0 && totalAmount !== expectedStars) {
          await safeAnswer(
            false,
            "To'lov summasi mos emas. Iltimos qayta urinib ko'ring.",
          );
          return;
        }

        const orderUserId = String(order.tgUserId || "").trim();
        if (orderUserId && updateUserId && orderUserId !== updateUserId) {
          await safeAnswer(false, "Bu invoice boshqa foydalanuvchi uchun");
          return;
        }

        await safeAnswer(true);
      } catch (error) {
        console.error("pre_checkout_query fatal:", error?.message || error);
        await safeAnswer(false, "To'lovni tekshirishda xatolik");
      } finally {
        clearTimeout(fallbackTimer);
      }
    }),
  );

  const ensureBotActive = async (chatId, { silent = false } = {}) => {
    const botStatus = await getBotStatus();
    // Keep the recovery path open for administrators. Otherwise disabling the
    // bot also blocks /start, so an admin cannot reopen the Mini App to enable
    // it again.
    if (botStatus.enabled || isAdmin(chatId)) return true;
    if (!silent) {
      await bot.sendMessage(
        chatId,
        "Hozirda bot ish faoliyatida emas. Birozdan keyin qayta urinib ko'ring.",
      );
    }
    return false;
  };
  const sendToAdmins = async (text, extra = {}) => {
    const results = [];
    for (const adminId of adminIds) {
      try {
        const sent = await bot.sendMessage(adminId, text, extra);
        results.push({
          ok: true,
          chatId: String(sent?.chat?.id || adminId),
          messageId: Number(sent?.message_id || 0),
        });
      } catch (error) {
        console.error("Admin notify error:", adminId, error.message);
        results.push({
          ok: false,
          chatId: String(adminId),
          messageId: 0,
          reason: String(error?.message || "send_failed"),
        });
      }
    }
    return results;
  };

  const ensureUser = async (msg, startPayload = "") => {
    const tgUserId = String(msg?.from?.id || "");
    if (!tgUserId) return;
    const username = String(msg?.from?.username || "");
    await bindReferralFromStart({
      tgUserId,
      username,
      startPayload,
    });
  };

  const getAllUsers = async () => {
    const users = await User.find({ tgUserId: { $exists: true, $ne: "" } })
      .select({ tgUserId: 1 })
      .lean();
    return users.map((u) => String(u.tgUserId));
  };

  const getAdminDraft = (chatId) =>
    Broadcast.findOne({ adminChatId: String(chatId), status: "draft" })
      .sort({ updatedAt: -1 });

  const createDeliverySnapshot = async (broadcastId) => {
    const users = await getAllUsers();
    const operations = users.map((tgUserId) => ({
      updateOne: {
        filter: { broadcastId, tgUserId },
        update: { $setOnInsert: { broadcastId, tgUserId, status: "pending" } },
        upsert: true,
      },
    }));
    for (let index = 0; index < operations.length; index += 1000) {
      await BroadcastDelivery.bulkWrite(operations.slice(index, index + 1000), {
        ordered: false,
      });
    }
    return users.length;
  };

  const sendStartFlow = async (chatId) => {
    await bot.sendPhoto(
      chatId,
      startPhotoPath,
      {
        caption: startCaption,
        reply_markup: {
          inline_keyboard: [[{ text: "Do'konga", web_app: { url: webAppUrl } }]],
        },
      },
      { contentType: startPhotoContentType },
    );

    if (isAdmin(chatId)) {
      await bot.sendMessage(
        chatId,
        "Admin menyu: reklama yuborish uchun tugmani bosing.",
        {
          reply_markup: {
            keyboard: [[{ text: "📣 Reklama yuborish" }]],
            resize_keyboard: true,
          },
        },
      );
    }
  };

  const sendForceJoinPrompt = async (chatId, userId, reason = "") => {
    const forceJoin = await checkForceJoinMembership(userId);
    const channelId = String(forceJoin.channelId || "").trim();
    const joinUrl = buildJoinUrl(channelId, forceJoin.joinUrl);

    await bot.sendMessage(
      chatId,
      reason ||
        "Davom etish uchun kanalga a'zo bo'ling, so'ng A'zo bo'ldim tugmasini bosing.",
      {
        reply_markup: {
          inline_keyboard: [
            ...(joinUrl ? [[{ text: "Kanalga o'tish", url: joinUrl }]] : []),
            [{ text: "A'zo bo'ldim", callback_data: `CHECK_JOIN:${userId}` }],
          ],
        },
      },
    );
  };

  bot.onText(
    /^\/start(?:\s+(.+))?$/,
    withSafeHandler("start", async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = String(msg?.from?.id || "");
    const startPayload = String(match?.[1] || "").trim();
    await ensureUser(msg, startPayload);
    if (!firstSeen.has(chatId)) firstSeen.add(chatId);

    if (!(await ensureBotActive(chatId))) {
      return;
    }

    if (!userId) {
      await sendStartFlow(chatId);
      return;
    }

    const forceJoin = await checkForceJoinMembership(userId);
    if (!forceJoin.enabled) {
      await sendStartFlow(chatId);
      return;
    }

    if (forceJoinPassedUsers.has(userId)) {
      await sendStartFlow(chatId);
      return;
    }

    if (forceJoin.canProceed) {
      forceJoinPassedUsers.add(userId);
      await sendStartFlow(chatId);
      return;
    }

    await sendForceJoinPrompt(
      chatId,
      userId,
      "Avval majburiy kanalga a'zo bo'ling. A'zo bo'lgach, A'zo bo'ldim tugmasini bosing.",
    );
    }),
  );

  bot.on(
    "callback_query",
    withSafeHandler("callback_query", async (query) => {
    const chatId = query.message?.chat?.id;
    if (!chatId) return;

    if (!(await ensureBotActive(chatId, { silent: true }))) {
      await bot.answerCallbackQuery(query.id, {
        text: "Bot hozir faol emas",
        show_alert: true,
      });
      return;
    }

    if (query.data?.startsWith("CHECK_JOIN:")) {
      const userId = String(query.from?.id || "");
      if (!userId) {
        await bot.answerCallbackQuery(query.id, {
          text: "Foydalanuvchi topilmadi",
          show_alert: true,
        });
        return;
      }

      const forceJoin = await checkForceJoinMembership(userId);
      if (!forceJoin.enabled) {
        forceJoinPassedUsers.add(userId);
        await bot.answerCallbackQuery(query.id, { text: "Davom etamiz" });
        await sendStartFlow(chatId);
        return;
      }

      if (!forceJoin.canProceed) {
        if (forceJoin.verificationFailed) {
          await bot.answerCallbackQuery(query.id, {
            text: "Kanal a'zoligini tekshirishda vaqtinchalik xatolik. Qayta urinib ko'ring.",
            show_alert: true,
          });
          return;
        }
        await bot.answerCallbackQuery(query.id, {
          text: "Hali kanalga a'zo emassiz",
          show_alert: true,
        });
        return;
      }

      forceJoinPassedUsers.add(userId);
      await bot.answerCallbackQuery(query.id, {
        text: "Tasdiqlandi. Davom etamiz.",
      });
      await sendStartFlow(chatId);
      return;
    }

    if (query.data?.startsWith("CONFIRM_GAME:")) {
      if (!isAdmin(chatId)) {
        await bot.answerCallbackQuery(query.id, {
          text: "Ruxsat yo'q",
          show_alert: true,
        });
        return;
      }

      const orderId = query.data.replace("CONFIRM_GAME:", "").trim();
      const result = await confirmGameOrderById(orderId);
      const productLabel = getGameProductLabel(result?.order?.product);
      if (result.ok) {
        await bot.answerCallbackQuery(query.id, {
          text: result.alreadyCompleted
            ? `${productLabel} order avval tasdiqlangan`
            : `${productLabel} order yakunlandi`,
        });
        await syncGameAdminMessages({
          order: result.order,
          statusLine: result.alreadyCompleted
            ? "✅ Holat: <b>Avval tasdiqlangan</b>"
            : "✅ Holat: <b>Tasdiqlandi</b>",
          fallbackChatId: chatId,
          fallbackMessageId: query.message?.message_id,
        });
      } else {
        await bot.answerCallbackQuery(query.id, {
          text:
            result.reason === "not_found"
              ? "Buyurtma topilmadi"
              : result.reason === "not_game"
              ? "Bu o'yin orderi emas"
              : result.reason === "already_cancelled"
              ? "Buyurtma avval bekor qilingan"
              : result.reason === "already_processed"
              ? "Buyurtma bo'yicha amal allaqachon bajarilgan"
              : "Tasdiqlash xatolik",
          show_alert: true,
        });
      }
    }

    if (query.data?.startsWith("CONFIRM_BALANCE_REVIEW:")) {
      if (!isAdmin(chatId)) {
        await bot.answerCallbackQuery(query.id, { text: "Ruxsat yo'q", show_alert: true });
        return;
      }
      const orderId = query.data.replace("CONFIRM_BALANCE_REVIEW:", "").trim();
      const result = await approveBalanceTopupReview(orderId, { id: chatId });
      await bot.answerCallbackQuery(query.id, {
        text: result.ok
          ? (result.alreadyProcessed ? "Avval tasdiqlangan" : "Balans to'ldirildi")
          : (result.reason === "not_found" ? "To'lov topilmadi" : "To'lov allaqachon ko'rib chiqilgan yoki xatolik yuz berdi"),
        show_alert: !result.ok,
      });
      if (result.ok && query.message?.message_id) {
        await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id }).catch(() => {});
      }
      return;
    }

    if (query.data?.startsWith("REJECT_BALANCE_REVIEW:")) {
      if (!isAdmin(chatId)) {
        await bot.answerCallbackQuery(query.id, { text: "Ruxsat yo'q", show_alert: true });
        return;
      }
      const orderId = query.data.replace("REJECT_BALANCE_REVIEW:", "").trim();
      const result = await rejectBalanceTopupReview(orderId, { id: chatId });
      await bot.answerCallbackQuery(query.id, {
        text: result.ok ? (result.alreadyProcessed ? "Avval rad etilgan" : "To'lov rad etildi") : (result.reason === "not_found" ? "To'lov topilmadi" : "To'lov allaqachon ko'rib chiqilgan"),
        show_alert: !result.ok,
      });
      if (result.ok && query.message?.message_id) {
        await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id }).catch(() => {});
      }
      return;
    }

    if (query.data?.startsWith("CANCEL_GAME:")) {
      if (!isAdmin(chatId)) {
        await bot.answerCallbackQuery(query.id, {
          text: "Ruxsat yo'q",
          show_alert: true,
        });
        return;
      }

      const orderId = query.data.replace("CANCEL_GAME:", "").trim();
      const result = await cancelGameOrderById(orderId);
      const productLabel = getGameProductLabel(result?.order?.product);
      if (result.ok) {
        await bot.answerCallbackQuery(query.id, {
          text: result.alreadyCancelled
            ? `${productLabel} order avval bekor qilingan`
            : `${productLabel} order bekor qilindi`,
        });
        await syncGameAdminMessages({
          order: result.order,
          statusLine: result.alreadyCancelled
            ? "❌ Holat: <b>Avval bekor qilingan</b>"
            : "❌ Holat: <b>Bekor qilindi</b>",
          fallbackChatId: chatId,
          fallbackMessageId: query.message?.message_id,
        });
      } else {
        await bot.answerCallbackQuery(query.id, {
          text:
            result.reason === "not_found"
              ? "Buyurtma topilmadi"
              : result.reason === "not_game"
              ? "Bu o'yin orderi emas"
              : result.reason === "already_cancelled"
              ? "Buyurtma avval bekor qilingan"
              : result.reason === "already_completed"
              ? "Buyurtma allaqachon tasdiqlangan"
              : result.reason === "already_processed"
              ? "Buyurtma bo'yicha amal allaqachon bajarilgan"
              : result.reason === "not_paid"
              ? "Order hali bekor qilib bo'lmaydigan holatda"
              : result.reason === "refund_not_available"
              ? "Qaytarish ma'lumoti yetarli emas"
              : "Bekor qilish xatolik",
          show_alert: true,
        });
      }
    }

    if (query.data?.startsWith("CONFIRM_STAR_SELL:")) {
      if (!isAdmin(chatId)) {
        await bot.answerCallbackQuery(query.id, {
          text: "Ruxsat yo'q",
          show_alert: true,
        });
        return;
      }

      const orderId = query.data.replace("CONFIRM_STAR_SELL:", "").trim();
      const result = await confirmStarSellPayoutById(orderId);
      if (!result.ok) {
        await bot.answerCallbackQuery(query.id, {
          text:
            result.reason === "not_found"
              ? "Buyurtma topilmadi"
              : result.reason === "not_star_sell"
              ? "Bu star sell emas"
              : "Tasdiqlash xatolik",
          show_alert: true,
        });
        return;
      }

      await bot.answerCallbackQuery(query.id, {
        text: result.alreadyCompleted
          ? "Avval tasdiqlangan"
          : "Pul o'tkazish tasdiqlandi",
      });

      if (query.message?.message_id) {
        await bot.editMessageText(
          buildStarSellAdminSummary(
            result.order,
            result.alreadyCompleted
              ? "✅ Holat: Avval tasdiqlangan"
              : "✅ Holat: Tasdiqlandi",
          ),
          {
            chat_id: chatId,
            message_id: query.message.message_id,
            reply_markup: { inline_keyboard: [] },
          },
        );
      }
      return;
    }

    if (query.data?.startsWith("CANCEL_STAR_SELL:")) {
      if (!isAdmin(chatId)) {
        await bot.answerCallbackQuery(query.id, {
          text: "Ruxsat yo'q",
          show_alert: true,
        });
        return;
      }

      const orderId = query.data.replace("CANCEL_STAR_SELL:", "").trim();
      const result = await cancelStarSellPayoutById(orderId);
      if (!result.ok) {
        const message =
          result.reason === "not_found"
            ? "Buyurtma topilmadi"
            : result.reason === "not_star_sell"
            ? "Bu star sell emas"
            : result.reason === "already_completed"
            ? "Buyurtma allaqachon tasdiqlangan"
            : "Bekor qilish xatolik";
        await bot.answerCallbackQuery(query.id, {
          text: message,
          show_alert: true,
        });
        return;
      }

      await bot.answerCallbackQuery(query.id, {
        text: result.alreadyCancelled
          ? "Avval bekor qilingan"
          : "Buyurtma bekor qilindi",
      });

      if (query.message?.message_id) {
        await bot.editMessageText(
          buildStarSellAdminSummary(
            result.order,
            `❌ Holat: Bekor qilindi (support: ${String(result?.order?.fragmentTx?.starSellPayout?.managerUsername || getManagerUsername())})`,
          ),
          {
            chat_id: chatId,
            message_id: query.message.message_id,
            reply_markup: { inline_keyboard: [] },
          },
        );
      }
      return;
    }

    if (query.data?.startsWith("CONFIRM_NFT_WITHDRAWAL:")) {
      if (!isAdmin(chatId)) {
        await bot.answerCallbackQuery(query.id, { text: "Ruxsat yo'q", show_alert: true });
        return;
      }
      const orderId = query.data.replace("CONFIRM_NFT_WITHDRAWAL:", "").trim();
      const result = await confirmNftWithdrawalById(orderId);
      if (!result.ok) {
        await bot.answerCallbackQuery(query.id, {
          text:
            result.reason === "needs_review"
              ? "Transfer natijasi noaniq. So'rov tekshiruvga o‘tdi."
              : result.reason === "awaiting_recipient_contact"
              ? "Mijozga xizmat akkauntiga yozish uchun xabar yuborildi."
              : result.reason === "insufficient_balance"
              ? "Mijoz balansida xizmat haqi yetarli emas"
              : result.reason === "not_ready"
              ? "So'rov hozir tasdiqlashga tayyor emas"
              : result.errorMessage || result.reason === "transfer_failed"
              ? "NFT yuborilmadi. Telegram ulanishi yoki qabul qiluvchi ma'lumotini tekshiring."
              : "Tasdiqlash xatolik",
          show_alert: true,
        });
        return;
      }
      await bot.answerCallbackQuery(query.id, { text: result.alreadyCompleted ? "Avval tasdiqlangan" : "Pul o'tkazish tasdiqlandi" });
      if (query.message?.message_id) {
        await bot.editMessageText(
          buildAdminText(
            result.order,
            result.alreadyCompleted ? "✅ Holat: Avval tasdiqlangan" : "✅ Holat: Tasdiqlandi",
          ),
          { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: [] } },
        );
      }
      return;
    }

    if (query.data?.startsWith("CANCEL_NFT_WITHDRAWAL:")) {
      if (!isAdmin(chatId)) {
        await bot.answerCallbackQuery(query.id, { text: "Ruxsat yo'q", show_alert: true });
        return;
      }
      const orderId = query.data.replace("CANCEL_NFT_WITHDRAWAL:", "").trim();
      const result = await cancelNftWithdrawalById(orderId);
      if (!result.ok) {
        await bot.answerCallbackQuery(query.id, {
          text:
            result.reason === "not_ready"
              ? "So'rov hozir bekor qilishga tayyor emas"
              : result.reason === "already_completed"
              ? "So'rov allaqachon tasdiqlangan"
              : "Bekor qilish xatolik",
          show_alert: true,
        });
        return;
      }
      await bot.answerCallbackQuery(query.id, { text: result.alreadyCancelled ? "Avval bekor qilingan" : "Buyurtma bekor qilindi" });
      if (query.message?.message_id) {
        await bot.editMessageText(
          buildAdminText(
            result.order,
            `❌ Holat: Bekor qilindi (support: ${String(result?.order?.fragmentTx?.nftWithdrawal?.managerUsername || getManagerUsername())})`,
          ),
          { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: [] } },
        );
      }
      return;
    }

    if (query.data?.startsWith("COPY_UC_ID:")) {
      if (!isAdmin(chatId)) {
        await bot.answerCallbackQuery(query.id, {
          text: "Ruxsat yo'q",
          show_alert: true,
        });
        return;
      }

      const orderId = query.data.replace("COPY_UC_ID:", "").trim();
      const order = await Order.findById(orderId).lean();
      if (!order) {
        await bot.answerCallbackQuery(query.id, {
          text: "Buyurtma topilmadi",
          show_alert: true,
        });
        return;
      }

      await bot.answerCallbackQuery(query.id, { text: "ID yuborildi" });
      await bot.sendMessage(chatId, `🆔 PUBG ID: ${order.username}`);
    }

    if (query.data?.startsWith("AD_BUTTONS:")) {
      if (!isAdmin(chatId)) {
        await bot.answerCallbackQuery(query.id, { text: "Ruxsat yo'q", show_alert: true });
        return;
      }
      const [, choice, broadcastId] = query.data.split(":");
      const draft = await Broadcast.findOne({
        _id: broadcastId,
        adminChatId: String(chatId),
        status: "draft",
        draftStage: "buttons",
      }).lean();
      if (!draft) {
        await bot.answerCallbackQuery(query.id, { text: "Draft topilmadi", show_alert: true });
        return;
      }
      await bot.answerCallbackQuery(query.id);
      if (choice === "NO") {
        await Broadcast.findByIdAndUpdate(draft._id, {
          $set: { buttons: [], draftStage: "schedule", draftButtonText: "" },
        });
        await bot.sendMessage(chatId, "Yuborish vaqtini kiriting:\n• hozir\n• 2026-11-02 21:30\n\nVaqt Toshkent vaqti (UTC+5) bo'yicha.");
        return;
      }
      await Broadcast.findByIdAndUpdate(draft._id, {
        $set: { draftStage: "button_name", draftButtonText: "" },
      });
      await bot.sendMessage(chatId, "Tugmada ko'rinadigan nomni yuboring. Masalan: PUBG UC olish");
      return;
    }

    if (query.data?.startsWith("AD_TARGET:")) {
      if (!isAdmin(chatId)) {
        await bot.answerCallbackQuery(query.id, { text: "Ruxsat yo'q", show_alert: true });
        return;
      }
      const payload = query.data.slice("AD_TARGET:".length);
      const separator = payload.indexOf(":");
      const broadcastId = payload.slice(0, separator);
      const target = payload.slice(separator + 1);
      const draft = await Broadcast.findOne({
        _id: broadcastId,
        adminChatId: String(chatId),
        status: "draft",
        draftStage: "button_target",
      }).lean();
      if (!draft) {
        await bot.answerCallbackQuery(query.id, { text: "Draft topilmadi", show_alert: true });
        return;
      }
      const parsed = parseBroadcastButtons(`${draft.draftButtonText} | app:${target}`, webAppUrl);
      if (!parsed.ok) {
        await bot.answerCallbackQuery(query.id, { text: parsed.reason, show_alert: true });
        return;
      }
      await Broadcast.findByIdAndUpdate(draft._id, {
        $set: { buttons: parsed.buttons, draftStage: "schedule" },
      });
      await bot.answerCallbackQuery(query.id, { text: "Bo'lim tanlandi" });
      await bot.sendMessage(chatId, "Yuborish vaqtini kiriting:\n• hozir\n• 2026-11-02 21:30\n\nVaqt Toshkent vaqti (UTC+5) bo'yicha.");
      return;
    }

    if (query.data?.startsWith("AD_EXTERNAL:")) {
      if (!isAdmin(chatId)) {
        await bot.answerCallbackQuery(query.id, { text: "Ruxsat yo'q", show_alert: true });
        return;
      }
      const broadcastId = query.data.slice("AD_EXTERNAL:".length);
      const draft = await Broadcast.findOne({
        _id: broadcastId,
        adminChatId: String(chatId),
        status: "draft",
        draftStage: "button_target",
      }).lean();
      if (!draft) {
        await bot.answerCallbackQuery(query.id, { text: "Draft topilmadi", show_alert: true });
        return;
      }
      await Broadcast.findByIdAndUpdate(draft._id, { $set: { draftStage: "external_url" } });
      await bot.answerCallbackQuery(query.id);
      await bot.sendMessage(chatId, "Tashqi havolani yuboring. Masalan: https://t.me/example");
      return;
    }

    if (query.data?.startsWith("AD_EDIT:")) {
      if (!isAdmin(chatId)) {
        await bot.answerCallbackQuery(query.id, {
          text: "Ruxsat yo'q",
          show_alert: true,
        });
        return;
      }
      const broadcastId = query.data.replace("AD_EDIT:", "").trim();
      const broadcast = await Broadcast.findById(broadcastId).lean();
      if (!broadcast || ["draft", "scheduled", "processing", "cancelled", "deleted"].includes(broadcast.status)) {
        await bot.answerCallbackQuery(query.id, { text: "Bu reklamani hozir tahrirlab bo'lmaydi", show_alert: true });
        return;
      }
      await Broadcast.updateMany(
        { adminChatId: String(chatId), status: "draft" },
        { $set: { status: "cancelled", draftStage: "" } },
      );
      await Broadcast.create({
        adminChatId: String(chatId),
        status: "draft",
        draftStage: "content",
        type: broadcast.type,
        text: broadcast.text,
        fileId: broadcast.fileId || broadcast.photoFileId,
        fileName: broadcast.fileName,
        buttons: broadcast.buttons || [],
        lastError: `edit:${broadcastId}`,
      });
      await bot.answerCallbackQuery(query.id);
      await bot.sendMessage(
        chatId,
        "Yangi matnni yuboring. Media reklamada faqat caption yangilanadi. /cancel — bekor qilish.",
      );
      return;
    }

    if (query.data?.startsWith("AD_STATUS:")) {
      if (!isAdmin(chatId)) {
        await bot.answerCallbackQuery(query.id, { text: "Ruxsat yo'q", show_alert: true });
        return;
      }
      const broadcastId = query.data.replace("AD_STATUS:", "").trim();
      const broadcast = await Broadcast.findById(broadcastId).lean();
      if (!broadcast) {
        await bot.answerCallbackQuery(query.id, { text: "Reklama topilmadi", show_alert: true });
        return;
      }
      const counts = await refreshCounts(broadcast._id);
      await bot.answerCallbackQuery(query.id);
      await bot.sendMessage(chatId, [
        `📊 Reklama: ${broadcast._id}`,
        `Holat: ${broadcast.status}`,
        `Jami: ${counts.totalCount}`,
        `Yuborildi: ${counts.sentCount}`,
        `Yuborilmadi: ${counts.failedCount}`,
        broadcast.scheduledAt ? `Vaqt: ${formatTashkentDate(broadcast.scheduledAt)}` : "",
      ].filter(Boolean).join("\n"));
      return;
    }

    if (query.data?.startsWith("AD_DEL:")) {
      if (!isAdmin(chatId)) {
        await bot.answerCallbackQuery(query.id, {
          text: "Ruxsat yo'q",
          show_alert: true,
        });
        return;
      }
      const broadcastId = query.data.replace("AD_DEL:", "").trim();
      const broadcast = await Broadcast.findById(broadcastId).lean();
      if (!broadcast) {
        await bot.answerCallbackQuery(query.id, { text: "Reklama topilmadi", show_alert: true });
        return;
      }
      await Broadcast.findByIdAndUpdate(broadcastId, {
        $set: { status: "cancelled", lockUntil: null },
      });
      const deliveries = await BroadcastDelivery.find({
        broadcastId,
        $or: [
          { status: "sent" },
          { status: { $exists: false }, messageId: { $gt: 0 } },
        ],
      }).lean();
      let removed = 0;
      let removeFailed = 0;
      for (const delivery of deliveries) {
        try {
          await bot.deleteMessage(delivery.tgUserId, delivery.messageId);
          await BroadcastDelivery.updateOne({ _id: delivery._id }, { $set: { status: "deleted" } });
          removed += 1;
        } catch (error) {
          removeFailed += 1;
          await BroadcastDelivery.updateOne({ _id: delivery._id }, { $set: { lastError: String(error?.message || error).slice(0, 500) } });
        }
      }
      await Broadcast.findByIdAndUpdate(broadcastId, {
        $set: { status: removeFailed ? "failed" : "deleted", completedAt: new Date(), lastError: removeFailed ? `${removeFailed} ta xabar o'chmadi` : "" },
      });
      await bot.answerCallbackQuery(query.id, { text: "O'chirildi" });
      await bot.sendMessage(
        chatId,
        `✅ Reklama bekor qilindi/o'chirildi. ID: ${broadcastId}\nO'chirildi: ${removed}\nO'chmadi: ${removeFailed}`,
      );
      return;
    }
    }),
  );

  bot.on("message", async (msg) => {
    try {
      if (!msg?.chat?.id) return;
      const chatId = msg.chat.id;
      if (msg.text === "/start") return;

      if (!(await ensureBotActive(chatId))) {
        return;
      }

      if (!isAdmin(chatId)) return;

      if (msg.text === "📣 Reklama yuborish") {
        await Broadcast.updateMany(
          { adminChatId: String(chatId), status: "draft" },
          { $set: { status: "cancelled", draftStage: "" } },
        );
        await Broadcast.create({
          adminChatId: String(chatId),
          status: "draft",
          draftStage: "content",
        });
        await bot.sendMessage(
          chatId,
          "Reklamani yuboring: matn, rasm, video yoki hujjat. Media bilan caption ham bo'lishi mumkin.\n/cancel — bekor qilish.",
        );
        return;
      }

      if (msg.text === "/cancel") {
        await Broadcast.updateMany(
          { adminChatId: String(chatId), status: "draft" },
          { $set: { status: "cancelled", draftStage: "" } },
        );
        await bot.sendMessage(chatId, "Bekor qilindi.");
        return;
      }

      const pending = await getAdminDraft(chatId);
      if (!pending) return;

      if (pending.draftStage === "content" && String(pending.lastError || "").startsWith("edit:")) {
        const newText = String(msg.text || "").trim();
        const newEntities = normalizeTelegramEntities(msg.entities);
        if (!newText) {
          await bot.sendMessage(chatId, "❗ Matn kiriting.");
          return;
        }
        const broadcastId = pending.lastError.slice("edit:".length);
        const broadcast = await Broadcast.findById(broadcastId).lean();
        if (!broadcast) {
          await bot.sendMessage(chatId, "❗ Reklama topilmadi.");
          await Broadcast.findByIdAndUpdate(pending._id, { status: "cancelled", draftStage: "" });
          return;
        }
        await Broadcast.findByIdAndUpdate(broadcast._id, {
          text: newText,
          ...(broadcast.type !== "text"
            ? { captionEntities: newEntities, entities: [] }
            : { entities: newEntities, captionEntities: [] }),
        });
        const deliveries = await BroadcastDelivery.find({
          broadcastId: broadcast._id,
          $or: [
            { status: "sent" },
            { status: { $exists: false }, messageId: { $gt: 0 } },
          ],
        }).lean();
        let edited = 0;
        let editFailed = 0;
        for (const delivery of deliveries) {
          try {
            if (broadcast.type !== "text") {
              await bot.editMessageCaption(newText, {
                chat_id: delivery.tgUserId,
                message_id: delivery.messageId,
                ...(newEntities.length
                  ? { caption_entities: newEntities }
                  : {}),
                ...(broadcast.buttons?.length ? { reply_markup: { inline_keyboard: broadcast.buttons } } : {}),
              });
            } else {
              await bot.editMessageText(newText, {
                chat_id: delivery.tgUserId,
                message_id: delivery.messageId,
                ...(newEntities.length ? { entities: newEntities } : {}),
                ...(broadcast.buttons?.length ? { reply_markup: { inline_keyboard: broadcast.buttons } } : {}),
              });
            }
            edited += 1;
          } catch (error) {
            editFailed += 1;
            await BroadcastDelivery.updateOne({ _id: delivery._id }, { $set: { lastError: String(error?.message || error).slice(0, 500) } });
          }
        }
        await Broadcast.findByIdAndUpdate(pending._id, { status: "cancelled", draftStage: "" });
        await bot.sendMessage(chatId, `✅ Reklama yangilandi.\nYangilandi: ${edited}\nYangilanmadi: ${editFailed}`);
        return;
      }

      if (pending.draftStage === "content") {
        let content = null;
        if (msg.photo?.length) {
          content = {
            type: "photo",
            fileId: msg.photo[msg.photo.length - 1]?.file_id,
            text: String(msg.caption || "").trim(),
            captionEntities: normalizeTelegramEntities(msg.caption_entities),
          };
        } else if (msg.video?.file_id) {
          content = {
            type: "video",
            fileId: msg.video.file_id,
            text: String(msg.caption || "").trim(),
            captionEntities: normalizeTelegramEntities(msg.caption_entities),
          };
        } else if (msg.document?.file_id) {
          content = {
            type: "document",
            fileId: msg.document.file_id,
            fileName: String(msg.document.file_name || ""),
            text: String(msg.caption || "").trim(),
            captionEntities: normalizeTelegramEntities(msg.caption_entities),
          };
        } else if (msg.text && !msg.text.startsWith("/")) {
          content = {
            type: "text",
            text: msg.text.trim(),
            entities: normalizeTelegramEntities(msg.entities),
          };
        }
        if (!content) {
          await bot.sendMessage(chatId, "❗ Matn, rasm, video yoki hujjat yuboring.");
          return;
        }
        await Broadcast.findByIdAndUpdate(pending._id, {
          $set: { ...content, draftStage: "buttons", lastError: "" },
        });
        await bot.sendMessage(
          chatId,
          "Reklamaga tugma qo'shilsinmi?",
          {
            reply_markup: {
              inline_keyboard: [[
                { text: "✅ Ha", callback_data: `AD_BUTTONS:YES:${pending._id}` },
                { text: "❌ Yo'q", callback_data: `AD_BUTTONS:NO:${pending._id}` },
              ]],
            },
          },
        );
        return;
      }

      if (pending.draftStage === "buttons") {
        await bot.sendMessage(chatId, "Yuqoridagi Ha yoki Yo'q tugmasini tanlang.");
        return;
      }

      if (pending.draftStage === "button_name") {
        const buttonText = String(msg.text || "").trim();
        if (!buttonText || buttonText.startsWith("/") || buttonText.length > 64) {
          await bot.sendMessage(chatId, "❗ Tugma nomini kiriting (ko'pi bilan 64 ta belgi).");
          return;
        }
        await Broadcast.findByIdAndUpdate(pending._id, {
          $set: { draftButtonText: buttonText, draftStage: "button_target" },
        });
        await bot.sendMessage(
          chatId,
          "Tugma ochadigan Web App bo'limini tanlang yoki tashqi URL kiriting:",
          { reply_markup: buildWebAppTargetKeyboard(pending._id) },
        );
        return;
      }

      if (pending.draftStage === "button_target") {
        await bot.sendMessage(chatId, "Yuqoridagi Web App bo'limlaridan birini yoki Tashqi URL tugmasini tanlang.");
        return;
      }

      if (pending.draftStage === "external_url") {
        const url = String(msg.text || "").trim();
        const parsed = parseBroadcastButtons(`${pending.draftButtonText} | ${url}`, webAppUrl);
        if (!parsed.ok || /^app:/i.test(url)) {
          await bot.sendMessage(chatId, "❗ To'liq tashqi URL kiriting. Masalan: https://t.me/example");
          return;
        }
        await Broadcast.findByIdAndUpdate(pending._id, {
          $set: { buttons: parsed.buttons, draftStage: "schedule" },
        });
        await bot.sendMessage(chatId, "Yuborish vaqtini kiriting:\n• hozir\n• 2026-11-02 21:30\n\nVaqt Toshkent vaqti (UTC+5) bo'yicha.");
        return;
      }

      if (pending.draftStage === "schedule") {
        const scheduledAt = parseTashkentSchedule(msg.text);
        if (!scheduledAt) {
          await bot.sendMessage(chatId, "❗ Vaqt noto'g'ri yoki o'tib ketgan. Masalan: 2026-11-02 21:30 yoki hozir");
          return;
        }
        const totalCount = await createDeliverySnapshot(pending._id);
        const queued = await Broadcast.findByIdAndUpdate(
          pending._id,
          {
            $set: {
              status: "scheduled",
              draftStage: "",
              scheduledAt,
              totalCount,
              sentCount: 0,
              failedCount: 0,
            },
          },
          { new: true },
        ).lean();
        await bot.sendMessage(
          chatId,
          [
            "✅ Reklama navbatga qo'yildi.",
            `ID: ${queued._id}`,
            `Qabul qiluvchilar: ${totalCount}`,
            `Vaqt: ${formatTashkentDate(scheduledAt)}`,
          ].join("\n"),
          {
            reply_markup: {
              inline_keyboard: [[
                { text: "📊 Holat", callback_data: `AD_STATUS:${queued._id}` },
                { text: "🗑 Bekor qilish", callback_data: `AD_DEL:${queued._id}` },
              ]],
            },
          },
        );
        return;
      }
    } catch (err) {
      console.error("Admin ads error:", err.message);
    }
  });

  bot.on(
    "message",
    withSafeHandler("stars_successful_payment", async (msg) => {
      const payment = msg?.successful_payment;
      if (!payment) return;
      if (String(payment.currency || "").trim().toUpperCase() !== "XTR") return;

      const result = await processTelegramStarsPayment({
        invoicePayload: payment.invoice_payload,
        telegramPaymentChargeId: payment.telegram_payment_charge_id,
        providerPaymentChargeId: payment.provider_payment_charge_id,
        totalAmount: payment.total_amount,
        tgUserId: String(msg?.from?.id || "").trim(),
        currency: payment.currency,
      });

      if (!result?.matched) {
        console.warn(
          "Stars successful_payment ignored:",
          result?.reason || "unknown",
        );
        return;
      }

      const chatId = msg?.chat?.id;
      if (!chatId) return;
      if (String(result?.order?.product || "").toLowerCase() === "star_sell") {
        await bot.sendMessage(
          chatId,
          `✅ Stars qabul qilindi. Buyurtma #${result?.order?.orderId || "-"} admin tekshiruviga yuborildi.`,
        );
      } else {
        await bot.sendMessage(
          chatId,
          `✅ To'lov qabul qilindi. Buyurtma #${result?.order?.orderId || "-"} bajarilmoqda.`,
        );
      }
    }),
  );

  if (adminNotifyChatId) {
    onGamePaid(async (payload) => {
      try {
        const productLabel = getGameProductLabel(payload?.product);
        const message = [
          `💬 ${productLabel} to'lov tushdi`,
          `🧾 Buyurtma: <code>${String(payload.orderCode)}</code>`,
          ...buildGameAccountLines({
            product: payload?.product,
            username: payload?.username,
            playerId: payload?.playerId,
            zoneId: payload?.zoneId,
          }),
          `🎮 Miqdor: <code>${payload.planCode}</code>`,
          `💵 Summa: <b>${payload.expectedAmount} UZS</b>`,
          `💳 To'lov: <b>${getPaymentMethodLabel(payload?.paymentMethod)}</b>`,
        ].join("\n");

        const notifyResults = await sendToAdmins(message, {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "Tasdiqlash",
                  callback_data: `CONFIRM_GAME:${payload.orderId}`,
                },
                {
                  text: "Bekor qilish",
                  callback_data: `CANCEL_GAME:${payload.orderId}`,
                },
              ],
            ],
          },
        });

        const sentNotifications = notifyResults
          .filter((item) => item?.ok && Number(item?.messageId || 0) > 0)
          .map((item) => ({
            chatId: String(item.chatId || ""),
            messageId: Number(item.messageId || 0),
          }))
          .filter((item) => item.chatId && item.messageId > 0);

        if (sentNotifications.length && payload?.orderId) {
          const currentOrder = await Order.findById(payload.orderId)
            .select({ fragmentTx: 1 })
            .lean();
          const fragmentTx =
            currentOrder?.fragmentTx &&
            typeof currentOrder.fragmentTx === "object" &&
            !Array.isArray(currentOrder.fragmentTx)
              ? currentOrder.fragmentTx
              : {};

          await Order.findByIdAndUpdate(payload.orderId, {
            $set: {
              fragmentTx: {
                ...fragmentTx,
                gameAdminNotifications: sentNotifications,
              },
            },
          });
        }
      } catch (err) {
        console.error("Admin notify error:", err.message);
      }
    });
  }

  startBroadcastWorker(bot);
  console.log("Telegram bot ishga tushdi...");
  return bot;
}

module.exports = {
  formatTashkentDate,
  isTelegramRecipientUnavailableError,
  parseBroadcastButtons,
  parseTashkentSchedule,
  startBot,
};

if (require.main === module) {
  startBot({ strict: true }).catch((error) => {
    console.error("Telegram bot start error:", error?.message || error);
    process.exit(1);
  });
}
