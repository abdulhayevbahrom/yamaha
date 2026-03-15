require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { processIncomingPayment } = require("../services/payment-match.service");
const { onUcPaid } = require("../services/notify.service");
const { confirmUcOrderById } = require("../services/uc-fulfillment.service");
const Order = require("../model/order.model");

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

  bot.onText(/^\/start$/, async (msg) => {
    const chatId = msg.chat.id;
    const seen = firstSeen.has(chatId);

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
          `🧾 Order: <code>${result.order.orderId}</code>`,
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
          `🧾 Order: <code>${payload.orderCode}</code>`,
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
