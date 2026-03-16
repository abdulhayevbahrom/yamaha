require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { processIncomingPayment } = require("../services/payment-match.service");
const { onUcPaid } = require("../services/notify.service");
const { confirmUcOrderById } = require("../services/uc-fulfillment.service");
const Order = require("../model/order.model");
const User = require("../model/user.model");
const Broadcast = require("../model/broadcast.model");
const BroadcastDelivery = require("../model/broadcastDelivery.model");

const initialText =
  "Assalomu alaykum. StarShop botiga xush kelibsiz.\n\nBoshlash tugmasini bosing.";

const startCaption =
  "Star, Premium va PUBG UC ni xavfsiz sotib oling.\n\nQuyidagi tugma orqali Mini App oching.";

function startBot({ strict = false } = {}) {
  const token = process.env.BOT_TOKEN;
  const webAppUrl = process.env.WEB_APP_URL;
  const cardxabarSourceChatId = process.env.CARDXABAR_SOURCE_CHAT_ID || "";
  const cardxabarNotifyChatId =
    process.env.CARDXABAR_NOTIFY_CHAT_ID || cardxabarSourceChatId || "";
  const adminNotifyChatId = process.env.ADMIN_NOTIFY_CHAT_ID || "";
  const startPhotoUrl =
    process.env.START_PHOTO_URL ||
    "https://images.unsplash.com/photo-1511512578047-dfb367046420?auto=format&fit=crop&w=1200&q=80";

  if (!token || !webAppUrl) {
    const message =
      "Bot ishga tushmadi: BOT_TOKEN yoki WEB_APP_URL topilmadi (backend/.env).";
    if (strict) throw new Error(message);
    console.warn(message);
    return null;
  }

  const bot = new TelegramBot(token, { polling: true });
  const firstSeen = new Set();
  const adminIds = adminNotifyChatId
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  const isAdmin = (chatId) => adminIds.includes(String(chatId));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const ensureUser = async (msg) => {
    const tgUserId = String(msg?.from?.id || "");
    if (!tgUserId) return;
    const username = String(msg?.from?.username || "");
    const firstName = String(msg?.from?.first_name || "");
    const lastName = String(msg?.from?.last_name || "");
    await User.findOneAndUpdate(
      { tgUserId },
      {
        $set: {
          username,
          firstName,
          lastName,
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

  const sendBroadcastToUsers = async (users, sendFn) => {
    let sent = 0;
    let failed = 0;
    for (const tgUserId of users) {
      try {
        const message = await sendFn(tgUserId);
        sent += 1;
        if (sent % 20 === 0) await sleep(300);
        if (message?.message_id) {
          await BroadcastDelivery.create({
            broadcastId: sendFn.broadcastId,
            tgUserId,
            messageId: message.message_id,
          });
        }
      } catch (_) {
        failed += 1;
      }
    }
    return { sent, failed };
  };

  bot.onText(/^\/start$/, async (msg) => {
    const chatId = msg.chat.id;
    const seen = firstSeen.has(chatId);
    await ensureUser(msg);

    if (!seen) {
      firstSeen.add(chatId);
      await bot.sendMessage(chatId, initialText, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Boshlash", callback_data: "OPEN_START" }],
          ],
        },
      });
      return;
    }

    await bot.sendPhoto(chatId, startPhotoUrl, {
      caption: startCaption,
      reply_markup: {
        inline_keyboard: [
          [{ text: "Mini App Ochish", web_app: { url: webAppUrl } }],
        ],
      },
    });
  });

  bot.on("message", async (msg) => {
    try {
      if (!isAdmin(msg.chat?.id)) return;

      const text = String(msg.text || "").trim();

      if (text.startsWith("/broadcast_edit")) {
        const [, idRaw, ...rest] = text.split(" ");
        const newText = rest.join(" ").trim();
        if (!idRaw || !newText) {
          await bot.sendMessage(
            msg.chat.id,
            "❗ Format: /broadcast_edit <id> <yangi matn>",
          );
          return;
        }
        const broadcast = await Broadcast.findById(idRaw).lean();
        if (!broadcast) {
          await bot.sendMessage(msg.chat.id, "❗ Broadcast topilmadi");
          return;
        }
        if (broadcast.type === "forward") {
          await bot.sendMessage(msg.chat.id, "❗ Forward xabarni edit qilib bo'lmaydi");
          return;
        }
        await Broadcast.findByIdAndUpdate(idRaw, { text: newText });
        const deliveries = await BroadcastDelivery.find({ broadcastId: idRaw }).lean();
        let updated = 0;
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
            updated += 1;
          } catch (_) {
            // ignore
          }
        }
        await bot.sendMessage(
          msg.chat.id,
          `✅ Broadcast yangilandi. ID: ${idRaw} (update: ${updated})`,
        );
        return;
      }

      if (text.startsWith("/broadcast_delete")) {
        const [, idRaw] = text.split(" ");
        if (!idRaw) {
          await bot.sendMessage(msg.chat.id, "❗ Format: /broadcast_delete <id>");
          return;
        }
        const deliveries = await BroadcastDelivery.find({ broadcastId: idRaw }).lean();
        let removed = 0;
        for (const delivery of deliveries) {
          try {
            await bot.deleteMessage(delivery.tgUserId, delivery.messageId);
            removed += 1;
          } catch (_) {
            // ignore
          }
        }
        await Broadcast.deleteOne({ _id: idRaw });
        await BroadcastDelivery.deleteMany({ broadcastId: idRaw });
        await bot.sendMessage(
          msg.chat.id,
          `✅ Broadcast o'chirildi. ID: ${idRaw} (delete: ${removed})`,
        );
        return;
      }

      if (text.startsWith("/broadcast") || text.startsWith("/reklama")) {
        const payload = text.replace(/^\/(broadcast|reklama)\s*/i, "").trim();
        if (!payload) {
          await bot.sendMessage(
            msg.chat.id,
            "❗ Matn kiriting: /broadcast <xabar>",
          );
          return;
        }

        const broadcast = await Broadcast.create({
          adminChatId: String(msg.chat.id),
          type: "text",
          text: payload,
        });
        const users = await getAllUsers();
        const sendFn = async (tgUserId) => bot.sendMessage(tgUserId, payload);
        sendFn.broadcastId = broadcast._id;

        const { sent, failed } = await sendBroadcastToUsers(users, sendFn);
        await bot.sendMessage(
          msg.chat.id,
          `✅ Broadcast yakunlandi. ID: ${broadcast._id}\nYuborildi: ${sent}, xatolik: ${failed}`,
        );
        return;
      }

      if (msg.photo?.length) {
        const fileId = msg.photo[msg.photo.length - 1]?.file_id;
        if (!fileId) return;
        const caption = String(msg.caption || "").trim();
        const broadcast = await Broadcast.create({
          adminChatId: String(msg.chat.id),
          type: "photo",
          text: caption,
          photoFileId: fileId,
        });
        const users = await getAllUsers();
        const sendFn = async (tgUserId) =>
          bot.sendPhoto(tgUserId, fileId, caption ? { caption } : undefined);
        sendFn.broadcastId = broadcast._id;
        const { sent, failed } = await sendBroadcastToUsers(users, sendFn);
        await bot.sendMessage(
          msg.chat.id,
          `✅ Broadcast yakunlandi. ID: ${broadcast._id}\nYuborildi: ${sent}, xatolik: ${failed}`,
        );
        return;
      }

      if (msg.forward_date) {
        const broadcast = await Broadcast.create({
          adminChatId: String(msg.chat.id),
          type: "forward",
          sourceChatId: String(msg.chat.id),
          sourceMessageId: msg.message_id,
        });
        const users = await getAllUsers();
        const sendFn = async (tgUserId) =>
          bot.forwardMessage(tgUserId, msg.chat.id, msg.message_id);
        sendFn.broadcastId = broadcast._id;
        const { sent, failed } = await sendBroadcastToUsers(users, sendFn);
        await bot.sendMessage(
          msg.chat.id,
          `✅ Broadcast yakunlandi. ID: ${broadcast._id}\nYuborildi: ${sent}, xatolik: ${failed}`,
        );
      }
    } catch (err) {
      console.error("Broadcast error:", err.message);
    }
  });

  bot.on("callback_query", async (query) => {
    const chatId = query.message?.chat?.id;
    if (!chatId) return;

    if (query.data === "OPEN_START") {
      await bot.answerCallbackQuery(query.id);
      await bot.sendPhoto(chatId, startPhotoUrl, {
        caption: startCaption,
        reply_markup: {
          inline_keyboard: [
            [{ text: "Mini App Ochish", web_app: { url: webAppUrl } }],
          ],
        },
      });
    }

    if (query.data?.startsWith("CONFIRM_UC:")) {
      if (String(chatId) !== String(adminNotifyChatId)) {
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
          text: "UC order yakunlandi",
        });
        const updatedMessage = [
          "💬 UC to'lov tushdi",
          `🧾 Order: <code>${String(result.order.orderId)}</code>`,
          `🆔 ID: <code>${result.order.username}</code>`,
          `🎮 Plan: <code>${result.order.planCode}</code>`,
          `💵 Summa: <b>${result.order.expectedAmount} UZS</b>`,
          "✅ Status: <b>Tasdiqlandi</b>",
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
      if (String(chatId) !== String(adminNotifyChatId)) {
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
          text: "Order topilmadi",
          show_alert: true,
        });
        return;
      }

      await bot.answerCallbackQuery(query.id, { text: "ID yuborildi" });
      await bot.sendMessage(chatId, `🆔 PUBG ID: ${order.username}`);
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
            `✅ To'lov matched\nOrder: ${result.order.orderId}\nSumma: ${result.amount}`,
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
          `🧾 Order: <code>${String(payload.orderCode)}</code>`,
          `🆔 ID: <code>${payload.username}</code>`,
          `🎮 Plan: <code>${payload.planCode}</code>`,
          `💵 Summa: <b>${payload.expectedAmount} UZS</b>`,
        ].join("\n");

        await bot.sendMessage(adminNotifyChatId, message, {
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
