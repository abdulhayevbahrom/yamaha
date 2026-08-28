const { getBalance } = require("./gw-api.service");
const { sendTelegramText } = require("./telegram-notify.service");

const THRESHOLDS = [20, 50, 100];

function normalize(value) {
  return String(value || "").trim();
}

function isEnabled(value) {
  return ["1", "true", "yes", "on"].includes(normalize(value).toLowerCase());
}

function getTargetChatId() {
  return normalize(
    process.env.GW_BALANCE_ALERT_TARGET_CHAT_ID ||
      process.env.ADMIN_NOTIFY_CHAT_ID,
  );
}

function pickThreshold(balanceUsd) {
  return THRESHOLDS.find((threshold) => balanceUsd <= threshold) || null;
}

function formatAlert(balanceUsd, threshold) {
  const balance = balanceUsd.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return [
    "⚠️ GW balans ogohlantirishi",
    `Joriy balans: $${balance}`,
    `Ogohlantirish chegarasi: $${threshold}`,
    "GW hisobini to'ldirish tavsiya etiladi.",
  ].join("\n");
}

async function checkGwBalanceAndNotify() {
  if (!isEnabled(process.env.GW_BALANCE_ALERT_ENABLED)) {
    return { ok: true, skipped: true, reason: "disabled" };
  }

  const targetChatId = getTargetChatId();
  if (!targetChatId) {
    return { ok: false, skipped: true, reason: "target_chat_id_missing" };
  }

  const payload = await getBalance();
  const balanceUsd = Number(payload?.balanceUsd);
  if (!payload?.success || !Number.isFinite(balanceUsd) || balanceUsd < 0) {
    throw new Error("GW balans javobi noto'g'ri");
  }

  const threshold = pickThreshold(balanceUsd);
  const shouldNotify = threshold !== null;

  if (shouldNotify) {
    const sent = await sendTelegramText(targetChatId, formatAlert(balanceUsd, threshold));
    if (!sent.ok) throw new Error(`Telegram ogohlantirishi yuborilmadi: ${sent.reason}`);
  }

  return { ok: true, balanceUsd, notified: shouldNotify, threshold };
}

function checkGwBalanceAfterSale(orderId) {
  void checkGwBalanceAndNotify().catch((error) => {
    console.error("GW balance alert error:", String(orderId || "-"), error?.message || error);
  });
}

module.exports = {
  checkGwBalanceAndNotify,
  checkGwBalanceAfterSale,
};
