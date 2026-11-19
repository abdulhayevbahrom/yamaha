const TelegramBot = require("node-telegram-bot-api");
const Plan = require("../model/plan.model");
const { getPlanPricingRate, getPlanPrice, hasGwMarkup } = require("./plan-pricing.service");
const {
  parseGwPriceUpdateMessage,
  isGwPriceAlertText,
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
    .select("category label amount basePrice provider providerProductId providerRegion markupPercent")
    .lean();
}

async function processGwPriceAlertMessage(text) {
  const targetChatId = normalize(process.env.GW_PRICE_ALERT_TARGET_CHAT_ID);
  const bot = getAlertBot();
  if (!bot || !targetChatId) {
    return {
      ok: false,
      reason: "gw_price_alert_not_configured",
      sent: 0,
      matched: 0,
      parsed: 0,
      skipped: 0,
      unmatched: [],
    };
  }

  if (!isGwPriceAlertText(text)) {
    return {
      ok: true,
      reason: "not_gw_price_alert",
      sent: 0,
      matched: 0,
      parsed: 0,
      skipped: 0,
      unmatched: [],
    };
  }

  const updates = parseGwPriceUpdateMessage(text);
  if (!updates.length) {
    return {
      ok: true,
      reason: "price_lines_not_found",
      sent: 0,
      matched: 0,
      parsed: 0,
      skipped: 0,
      unmatched: [],
    };
  }

  const plans = await getActiveGwPlans();
  let sent = 0;
  let matched = 0;
  const unmatched = [];
  const sendFailures = [];
  let rate;

  for (const update of updates) {
    const plan = pickMatchingPlan(update, plans);
    if (!plan) {
      unmatched.push({
        gameTitle: update.gameTitle,
        productLabel: update.productLabel,
        category: update.category,
        region: update.region,
      });
      continue;
    }

    matched += 1;
    try {
      let customerPrices;
      if (hasGwMarkup(plan)) {
        if (rate === undefined) rate = await getPlanPricingRate([plan]);
        customerPrices = {
          previous: getPlanPrice({ ...plan, providerPriceUsd: update.previousUsd }, rate),
          next: getPlanPrice({ ...plan, providerPriceUsd: update.nextUsd }, rate),
        };
      }
      await bot.sendMessage(targetChatId, formatGwAlertMessage({ update, plan, customerPrices }));
      sent += 1;
    } catch (error) {
      sendFailures.push({
        gameTitle: update.gameTitle,
        productLabel: update.productLabel,
        error: String(error?.message || error).slice(0, 300),
      });
    }
  }

  return {
    ok: sendFailures.length === 0,
    reason:
      sendFailures.length > 0
        ? "send_failed"
        : sent > 0
          ? "sent"
          : matched > 0
            ? "matched_but_not_sent"
            : "no_matching_active_plan",
    sent,
    matched,
    parsed: updates.length,
    skipped: Math.max(updates.length - matched, 0),
    unmatched,
    sendFailures,
  };
}

module.exports = {
  processGwPriceAlertMessage,
};
