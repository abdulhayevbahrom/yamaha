const TelegramBot = require("node-telegram-bot-api");
const Plan = require("../model/plan.model");
const {
  parseGwPriceUpdateMessage,
  pickMatchingPlan,
  formatGwAlertMessage,
} = require("../utils/gw-price-update");

let alertBot = null;

function normalize(value) {
  return String(value || "").trim();
}

function getAlertBot() {
  const token = normalize(process.env.GW_PRICE_ALERT_BOT_TOKEN);
  if (!token) return null;
  if (!alertBot) {
    alertBot = new TelegramBot(token, { polling: false });
  }
  return alertBot;
}

async function getActiveGwPlans() {
  return Plan.find({
    provider: "gw",
    isActive: true,
    category: {
      $in: ["uc", "redeem", "freefire", "mlbb", "hok", "roblox", "bloodstrike", "deltaforce"],
    },
  })
    .select("category label amount basePrice providerProductId providerRegion")
    .lean();
}

async function processGwPriceAlertMessage(text) {
  const targetChatId = normalize(process.env.GW_PRICE_ALERT_TARGET_CHAT_ID);
  const bot = getAlertBot();
  if (!bot || !targetChatId) {
    return { ok: false, reason: "gw_price_alert_not_configured", sent: 0, matched: 0 };
  }

  const updates = parseGwPriceUpdateMessage(text);
  if (!updates.length) {
    return { ok: true, sent: 0, matched: 0, skipped: 0 };
  }

  const plans = await getActiveGwPlans();
  let sent = 0;
  let matched = 0;

  for (const update of updates) {
    const plan = pickMatchingPlan(update, plans);
    if (!plan) continue;

    matched += 1;
    await bot.sendMessage(targetChatId, formatGwAlertMessage({ update, plan }));
    sent += 1;
  }

  return {
    ok: true,
    sent,
    matched,
    skipped: Math.max(updates.length - matched, 0),
  };
}

module.exports = {
  processGwPriceAlertMessage,
};
