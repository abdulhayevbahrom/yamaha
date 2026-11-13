const User = require("../model/user.model");
const BroadcastDelivery = require("../model/broadcastDelivery.model");

function getBroadcastChannel() {
  const channel = String(process.env.BROADCAST_CHANNEL_USERNAME || "").trim();
  const archive = String(process.env.ORDER_ARCHIVE_CHAT_ID || "@BuyStarsArxiv").trim();
  if (!/^@[a-zA-Z][a-zA-Z0-9_]{3,31}$/.test(channel)) return "";
  return channel.toLowerCase() === archive.toLowerCase() ? "" : channel;
}

async function createBroadcastDeliverySnapshot(broadcastId, { sendToBot, channel }) {
  const users = sendToBot
    ? await User.find({ tgUserId: { $exists: true, $ne: "" } }).select({ tgUserId: 1 }).lean()
    : [];
  const recipients = new Set(users.map((user) => String(user.tgUserId)));
  if (channel) recipients.add(channel);

  const operations = Array.from(recipients, (tgUserId) => ({
    updateOne: {
      filter: { broadcastId, tgUserId },
      update: { $setOnInsert: { broadcastId, tgUserId, status: "pending" } },
      upsert: true,
    },
  }));
  for (let index = 0; index < operations.length; index += 1000) {
    await BroadcastDelivery.bulkWrite(operations.slice(index, index + 1000), { ordered: false });
  }
  return recipients.size;
}

function getChannelMiniAppUrl(webAppUrl) {
  const username = String(process.env.BOT_USERNAME || "").trim().replace(/^@/, "");
  if (!/^[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(username)) return "";
  try {
    const route = new URL(webAppUrl).hash.match(/^#\/(home|orders|gifts|profile|referral|contest|balance|star-sell|games\/(?:stars|premium|pubg|freefire|mlbb|hok|roblox|bloodstrike|deltaforce))$/)?.[1];
    if (!route) return "";
    return `https://t.me/${username}?startapp=${route.replace("/", "__")}`;
  } catch (_) {
    return "";
  }
}

function broadcastReplyMarkup(broadcast, recipient) {
  if (!broadcast.buttons?.length) return undefined;
  const inlineKeyboard = String(recipient).startsWith("@")
    ? broadcast.buttons.map((row) => row.map((button) =>
      button.web_app?.url ? { text: button.text, url: getChannelMiniAppUrl(button.web_app.url) || button.web_app.url } : button,
    ))
    : broadcast.buttons;
  return { inline_keyboard: inlineKeyboard };
}

module.exports = { getBroadcastChannel, createBroadcastDeliverySnapshot, broadcastReplyMarkup };
