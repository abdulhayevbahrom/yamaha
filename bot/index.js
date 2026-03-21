require("dotenv").config();
const path = require("node:path");
const TelegramBot = require("node-telegram-bot-api");
const { processIncomingPayment } = require("../services/payment-match.service");
const { onUcPaid } = require("../services/notify.service");
const { confirmUcOrderById } = require("../services/uc-fulfillment.service");
const { checkForceJoinMembership, buildJoinUrl } = require("../services/force-join.service");
const { getBotStatus } = require("../services/settings.service");
const Order = require("../model/order.model");
const User = require("../model/user.model");
const Broadcast = require("../model/broadcast.model");
const BroadcastDelivery = require("../model/broadcastDelivery.model");

const startCaption =
  "Star, Premium va PUBG UC ni xavfsiz sotib oling.\n\nDo'konga kirish uchun tugmani bosing.";

const normalizeOptionalId = (value) => {
  const cleaned = String(value || "").trim();
  if (!cleaned) return "";
  if (["shartmas", "none", "null", "undefined", "-"].includes(cleaned.toLowerCase())) {
    return "";
  }
  return cleaned;
};

function startBot({ strict = false } = {}) {
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

  const bot = new TelegramBot(token, { polling: true });
  const firstSeen = new Set();
  const forceJoinPassedUsers = new Set();
  const adminIds = adminNotifyChatId
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const pendingByAdmin = new Map();

  const isAdmin = (chatId) => adminIds.includes(String(chatId));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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

  const ensureUser = async (msg) => {
    const tgUserId = String(msg?.from?.id || "");
    if (!tgUserId) return;
    const username = String(msg?.from?.username || "");
    await User.findOneAndUpdate(
      { tgUserId },
      {
        $set: { username },
        $unset: {
          firstName: "",
          lastName: "",
          photoUrl: "",
          photo_url: "",
        },
      },
      { upsert: true, new: true },
    ).lean();
  };

  const getAllUsers = async () => {
    const users = await User.find({ tgUserId: { $exists: true, $ne: "" } })
      .select({ tgUserId: 1 })
      .lean();
    return users.map((u) => String(u.tgUserId));
  };

  const sendStartFlow = async (chatId) => {
    await bot.sendPhoto(chatId, startPhotoPath, {
      caption: startCaption,
      reply_markup: {
        inline_keyboard: [[{ text: "Do'konga", web_app: { url: webAppUrl } }]],
      },
    });

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

  bot.onText(/^\/start$/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = String(msg?.from?.id || "");
    await ensureUser(msg);
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
  });

  bot.on("callback_query", async (query) => {
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

    if (query.data?.startsWith("CONFIRM_UC:")) {
      if (!isAdmin(chatId)) {
        await bot.answerCallbackQuery(query.id, {
          text: "Ruxsat yo'q",
          show_alert: true,
        });
        return;
      }

      const orderId = query.data.replace("CONFIRM_UC:", "").trim();
      const result = await confirmUcOrderById(orderId);
      if (result.ok) {
        await bot.answerCallbackQuery(query.id, {
          text: result.alreadyCompleted
            ? "UC order avval tasdiqlangan"
            : "UC order yakunlandi",
        });
        const updatedMessage = [
          "💬 UC to'lov tushdi",
          `🧾 Buyurtma: <code>${String(result.order.orderId)}</code>`,
          `🆔 ID: <code>${result.order.username}</code>`,
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
  });

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
        await Broadcast.findByIdAndUpdate(broadcast._id, { text: newText });
        const deliveries = await BroadcastDelivery.find({
          broadcastId: broadcast._id,
        }).lean();
        for (const delivery of deliveries) {
          try {
            if (broadcast.type === "photo") {
              await bot.editMessageCaption(newText, {
                chat_id: delivery.tgUserId,
                message_id: delivery.messageId,
              });
            } else {
              await bot.editMessageText(newText, {
                chat_id: delivery.tgUserId,
                message_id: delivery.messageId,
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
          const broadcast = await Broadcast.create({
            adminChatId: String(chatId),
            type: "photo",
            text: caption,
            photoFileId: fileId,
          });
          for (const tgUserId of users) {
            try {
              const sent = await bot.sendPhoto(
                tgUserId,
                fileId,
                caption ? { caption } : undefined,
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
          const broadcast = await Broadcast.create({
            adminChatId: String(chatId),
            type: "text",
            text: payload,
          });
          for (const tgUserId of users) {
            try {
              const sent = await bot.sendMessage(tgUserId, payload);
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
    onUcPaid(async (payload) => {
      try {
        const message = [
          "💬 UC to'lov tushdi",
          `🧾 Buyurtma: <code>${String(payload.orderCode)}</code>`,
          `🆔 ID: <code>${payload.username}</code>`,
          `🎮 Miqdor: <code>${payload.planCode}</code>`,
          `💵 Summa: <b>${payload.expectedAmount} UZS</b>`,
        ].join("\n");

        await sendToAdmins(message, {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "Tasdiqlash",
                  callback_data: `CONFIRM_UC:${payload.orderId}`,
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
  startBot({ strict: true });
}
