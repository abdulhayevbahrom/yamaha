const TelegramBot = require("node-telegram-bot-api");

let notifyBot = null;

function getNotifyBot() {
  const token = String(process.env.BOT_TOKEN || "").trim();
  if (!token) return null;
  if (!notifyBot) {
    notifyBot = new TelegramBot(token, { polling: false });
  }
  return notifyBot;
}

async function sendTelegramText(chatId, text, extra = {}) {
  const bot = getNotifyBot();
  const target = String(chatId || "").trim();
  if (!bot || !target || !text) {
    return { ok: false, reason: "notify_not_configured" };
  }

  try {
    await bot.sendMessage(target, text, extra);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error.message || "notify_failed" };
  }
}

module.exports = {
  sendTelegramText,
};
