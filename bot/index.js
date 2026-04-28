require("dotenv").config();
const path = require("node:path");
const TelegramBot = require("node-telegram-bot-api");
const connectDB = require("../config/dbConfig");
const {
  processIncomingPayment,
  processTelegramStarsPayment,
} = require("../services/payment-match.service");
const { onGamePaid } = require("../services/notify.service");
const { confirmGameOrderById } = require("../services/uc-fulfillment.service");
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
const Order = require("../model/order.model");
const User = require("../model/user.model");
const Broadcast = require("../model/broadcast.model");
const BroadcastDelivery = require("../model/broadcastDelivery.model");
const { bindReferralFromStart } = require("../services/referral.service");

const startCaption =
  "Star, Premium, PUBG UC va MLBB Diamond ni xavfsiz sotib oling.\n\nDo'konga kirish uchun tugmani bosing.";

const normalizeOptionalId = (value) => {
  const cleaned = String(value || "").trim();
  if (!cleaned) return "";
  if (
    ["shartmas", "none", "null", "undefined", "-"].includes(
      cleaned.toLowerCase(),
    )
  ) {
    return "";
  }
  return cleaned;
};

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

async function startBot({ strict = false } = {}) {
  const token = process.env.BOT_TOKEN;
  const webAppUrl = process.env.WEB_APP_URL;
  const cardxabarSourceChatId = normalizeOptionalId(
    process.env.CARDXABAR_SOURCE_CHAT_ID,
  );
  const cardxabarNotifyChatId =
    normalizeOptionalId(process.env.CARDXABAR_NOTIFY_CHAT_ID) ||
    cardxabarSourceChatId ||
    "";
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
  const pendingByAdmin = new Map();
  const startPhotoExt = path.extname(startPhotoPath).toLowerCase();
  const startPhotoContentType =
    {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".webp": "image/webp",
    }[startPhotoExt] || "application/octet-stream";

  const isAdmin = (chatId) => adminIds.includes(String(chatId));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const withSafeHandler = (scope, handler) => {
    return async (...args) => {
      try {
        await handler(...args);
      } catch (error) {
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
    if (botStatus.enabled) return true;
    if (!silent) {
      await bot.sendMessage(
        chatId,
        "Hozirda bot ish faoliyatida emas. Birozdan keyin qayta urinib ko'ring.",
      );
    }
    return false;
  };
  const sendToAdmins = async (text, extra = {}) => {
    for (const adminId of adminIds) {
      try {
        await bot.sendMessage(adminId, text, extra);
      } catch (error) {
        console.error("Admin notify error:", adminId, error.message);
      }
    }
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
        const updatedMessage = [
          `💬 ${productLabel} to'lov tushdi`,
          `🧾 Buyurtma: <code>${String(result.order.orderId)}</code>`,
          ...buildGameAccountLines({
            product: result?.order?.product,
            username: result?.order?.username,
            playerId: result?.order?.playerId,
            zoneId: result?.order?.zoneId,
          }),
          `🎮 Miqdor: <code>${result.order.planCode}</code>`,
          `💵 Summa: <b>${result.order.expectedAmount} UZS</b>`,
          result.alreadyCompleted
            ? "✅ Holat: <b>Avval tasdiqlangan</b>"
            : "✅ Holat: <b>Tasdiqlandi</b>",
        ].join("\n");

        if (query.message?.message_id) {
          await bot.editMessageText(updatedMessage, {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [] },
          });
        }
      } else {
        await bot.answerCallbackQuery(query.id, {
          text: "Tasdiqlash xatolik",
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
        await bot.answerCallbackQuery(query.id, { text: "Tasdiqlash xatolik", show_alert: true });
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
        await bot.answerCallbackQuery(query.id, { text: "Bekor qilish xatolik", show_alert: true });
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

    if (query.data?.startsWith("AD_EDIT:")) {
      if (!isAdmin(chatId)) {
        await bot.answerCallbackQuery(query.id, {
          text: "Ruxsat yo'q",
          show_alert: true,
        });
        return;
      }
      const broadcastId = query.data.replace("AD_EDIT:", "").trim();
      pendingByAdmin.set(String(chatId), {
        mode: "edit",
        broadcastId,
      });
      await bot.answerCallbackQuery(query.id);
      await bot.sendMessage(
        chatId,
        "Yangi matnni yuboring (caption ham shu matn bilan yangilanadi).",
      );
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
      const deliveries = await BroadcastDelivery.find({ broadcastId }).lean();
      let removed = 0;
      for (const delivery of deliveries) {
        try {
          await bot.deleteMessage(delivery.tgUserId, delivery.messageId);
          removed += 1;
        } catch (_) {
          // ignore
        }
      }
      await Broadcast.deleteOne({ _id: broadcastId });
      await BroadcastDelivery.deleteMany({ broadcastId });
      await bot.answerCallbackQuery(query.id, { text: "O'chirildi" });
      await bot.sendMessage(
        chatId,
        `✅ Reklama o'chirildi. ID: ${broadcastId} (o'chirildi: ${removed})`,
      );
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
        pendingByAdmin.set(String(chatId), { mode: "create" });
        await bot.sendMessage(
          chatId,
          "Reklama xabarini yuboring (matn yoki rasm+matn). Bekor qilish uchun /cancel.",
        );
        return;
      }

      if (msg.text === "/cancel") {
        pendingByAdmin.delete(String(chatId));
        await bot.sendMessage(chatId, "Bekor qilindi.");
        return;
      }

      const pending = pendingByAdmin.get(String(chatId));
      if (!pending) return;

      if (pending.mode === "edit") {
        const newText = String(msg.text || "").trim();
        const newEntities = normalizeTelegramEntities(msg.entities);
        if (!newText) {
          await bot.sendMessage(chatId, "❗ Matn kiriting.");
          return;
        }
        const broadcast = await Broadcast.findById(pending.broadcastId).lean();
        if (!broadcast) {
          await bot.sendMessage(chatId, "❗ Reklama topilmadi.");
          pendingByAdmin.delete(String(chatId));
          return;
        }
        await Broadcast.findByIdAndUpdate(broadcast._id, {
          text: newText,
          ...(broadcast.type === "photo"
            ? { captionEntities: newEntities, entities: [] }
            : { entities: newEntities, captionEntities: [] }),
        });
        const deliveries = await BroadcastDelivery.find({
          broadcastId: broadcast._id,
        }).lean();
        for (const delivery of deliveries) {
          try {
            if (broadcast.type === "photo") {
              await bot.editMessageCaption(newText, {
                chat_id: delivery.tgUserId,
                message_id: delivery.messageId,
                ...(newEntities.length
                  ? { caption_entities: newEntities }
                  : {}),
              });
            } else {
              await bot.editMessageText(newText, {
                chat_id: delivery.tgUserId,
                message_id: delivery.messageId,
                ...(newEntities.length ? { entities: newEntities } : {}),
              });
            }
          } catch (_) {
            // ignore
          }
        }
        pendingByAdmin.delete(String(chatId));
        await bot.sendMessage(chatId, "✅ Reklama yangilandi.");
        return;
      }

      if (pending.mode === "create") {
        const users = await getAllUsers();
        let sentCount = 0;

        if (msg.photo?.length) {
          const fileId = msg.photo[msg.photo.length - 1]?.file_id;
          const caption = String(msg.caption || "").trim();
          const captionEntities = normalizeTelegramEntities(msg.caption_entities);
          const broadcast = await Broadcast.create({
            adminChatId: String(chatId),
            type: "photo",
            text: caption,
            photoFileId: fileId,
            captionEntities,
          });
          for (const tgUserId of users) {
            try {
              const sent = await bot.sendPhoto(
                tgUserId,
                fileId,
                caption
                  ? {
                      caption,
                      ...(captionEntities.length
                        ? { caption_entities: captionEntities }
                        : {}),
                    }
                  : undefined,
              );
              await BroadcastDelivery.create({
                broadcastId: broadcast._id,
                tgUserId,
                messageId: sent.message_id,
              });
              sentCount += 1;
              if (sentCount % 20 === 0) await sleep(300);
            } catch (_) {
              // ignore
            }
          }
          await bot.sendMessage(
            chatId,
            `✅ Reklama yuborildi. ID: ${broadcast._id}`,
            {
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: "✏️ Tahrirlash",
                      callback_data: `AD_EDIT:${broadcast._id}`,
                    },
                    {
                      text: "🗑 O'chirish",
                      callback_data: `AD_DEL:${broadcast._id}`,
                    },
                  ],
                ],
              },
            },
          );
          pendingByAdmin.delete(String(chatId));
          return;
        }

        if (msg.text && !msg.text.startsWith("/")) {
          const payload = msg.text.trim();
          const entities = normalizeTelegramEntities(msg.entities);
          const broadcast = await Broadcast.create({
            adminChatId: String(chatId),
            type: "text",
            text: payload,
            entities,
          });
          for (const tgUserId of users) {
            try {
              const sent = await bot.sendMessage(tgUserId, payload, {
                ...(entities.length ? { entities } : {}),
              });
              await BroadcastDelivery.create({
                broadcastId: broadcast._id,
                tgUserId,
                messageId: sent.message_id,
              });
              sentCount += 1;
              if (sentCount % 20 === 0) await sleep(300);
            } catch (_) {
              // ignore
            }
          }
          await bot.sendMessage(
            chatId,
            `✅ Reklama yuborildi. ID: ${broadcast._id}`,
            {
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: "✏️ Tahrirlash",
                      callback_data: `AD_EDIT:${broadcast._id}`,
                    },
                    {
                      text: "🗑 O'chirish",
                      callback_data: `AD_DEL:${broadcast._id}`,
                    },
                  ],
                ],
              },
            },
          );
          pendingByAdmin.delete(String(chatId));
        }
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

  if (cardxabarSourceChatId) {
    bot.on("message", async (msg) => {
      try {
        if (!msg?.text) return;
        if (String(msg.chat?.id) !== String(cardxabarSourceChatId)) return;
        if (msg.text.startsWith("/")) return;

        const externalMessageId = `${msg.chat.id}:${msg.message_id}`;
        const result = await processIncomingPayment({
          rawText: msg.text,
          externalMessageId,
          source: "cardxabar",
        });

        if (!cardxabarNotifyChatId) return;
        if (result.matched) {
          await bot.sendMessage(
            cardxabarNotifyChatId,
            `✅ To'lov mos tushdi\nBuyurtma: ${result.order.orderId}\nSumma: ${result.amount}`,
          );
        }
      } catch (err) {
        console.error("CardXabar message process error:", err.message);
      }
    });
  }

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

        await sendToAdmins(message, {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "Tasdiqlash",
                  callback_data: `CONFIRM_GAME:${payload.orderId}`,
                },
              ],
            ],
          },
        });
      } catch (err) {
        console.error("Admin notify error:", err.message);
      }
    });
  }

  console.log("Telegram bot ishga tushdi...");
  return bot;
}

module.exports = { startBot };

if (require.main === module) {
  startBot({ strict: true }).catch((error) => {
    console.error("Telegram bot start error:", error?.message || error);
    process.exit(1);
  });
}
