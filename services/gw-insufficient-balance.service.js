const Order = require("../model/order.model");
const { emitUserUpdate } = require("../socket");
const { refundToBalance } = require("./order-cancel.service");
const { sendTelegramText } = require("./telegram-notify.service");

const LOW_BALANCE_PATTERN = /(?:insufficient|not\s+enough|low)\s+(?:provider\s+)?(?:balance|funds)|balance\s+(?:is\s+)?(?:insufficient|too\s+low)|недостаточно\s+(?:средств|денег)/i;
const LOW_BALANCE_CODES = new Set([
  "INSUFFICIENT_BALANCE",
  "INSUFFICIENT_FUNDS",
  "LOW_BALANCE",
  "NOT_ENOUGH_BALANCE",
  "BALANCE_NOT_ENOUGH",
]);

function collectProviderText(value, depth = 0) {
  if (value == null || depth > 4) return [];
  if (["string", "number", "boolean"].includes(typeof value)) {
    return [String(value)];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectProviderText(item, depth + 1));
  }
  if (typeof value !== "object") return [];
  return Object.entries(value)
    .filter(([key]) => !/stack|config|request|headers/i.test(key))
    .flatMap(([, item]) => collectProviderText(item, depth + 1));
}

function isGwInsufficientBalance(payload, error = null) {
  const candidates = [
    payload,
    error?.response?.data,
    error?.code,
    error?.message,
  ];
  const values = candidates.flatMap((item) => collectProviderText(item));
  return values.some((value) => {
    const normalized = String(value || "").trim();
    return LOW_BALANCE_CODES.has(normalized.toUpperCase()) ||
      LOW_BALANCE_PATTERN.test(normalized);
  });
}

function adminChatIds() {
  return String(process.env.ADMIN_NOTIFY_CHAT_ID || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function notifyAdmins(order, refund, providerMessage) {
  const text = [
    "GW balansida pul qolmagan.",
    `Order: #${order.orderId || "-"}`,
    `Mahsulot: ${order.product || "-"} / ${order.planCode || "-"}`,
    `Mijoz: @${String(order.tgUsername || order.username || "-").replace(/^@/, "")}`,
    `Telegram ID: ${order.tgUserId || "-"}`,
    `Summa: ${Number(refund.refundedAmount || order.expectedAmount || 0).toLocaleString("uz-UZ")} UZS`,
    `Refund: ${refund.ok ? "mijoz balansiga qaytarildi" : `XATO (${refund.reason || "refund_failed"})`}`,
    `GW javobi: ${String(providerMessage || "insufficient balance").slice(0, 500)}`,
  ].join("\n");
  await Promise.allSettled(
    adminChatIds().map((chatId) => sendTelegramText(chatId, text)),
  );
}

async function handleGwInsufficientBalance({
  order,
  payload = null,
  error = null,
  buildTransaction,
}) {
  if (!order || !isGwInsufficientBalance(payload, error)) return null;

  const claimed = await Order.findOneAndUpdate(
    { _id: order._id, fulfillmentStatus: "processing" },
    {
      $set: {
        fulfillmentStatus: "needs_review",
        fulfillmentError: "GW provider balance insufficient; refund processing.",
      },
    },
    { new: true },
  );
  if (!claimed) {
    return { ok: false, handled: true, duplicate: true };
  }

  const providerMessage = collectProviderText(payload || error?.response?.data || error)
    .join(" | ")
    .slice(0, 500);
  const refund = await refundToBalance(claimed, {
    operationKey: `gw-low-balance-refund:${String(claimed._id)}`,
  });
  const handledAt = new Date();
  const extra = {
    gwLowBalanceHandlingAt: handledAt,
    gwLowBalanceHandledAt: handledAt,
    gwLowBalance: true,
    refundReason: "gw_insufficient_balance",
    refundTarget: refund.ok ? "webapp_balance" : "",
    ...(refund.ok
      ? {
          refundedToBalanceAt: handledAt,
          refundedToBalanceAmount: refund.refundedAmount,
        }
      : { refundError: refund.reason || "refund_failed" }),
  };
  const transaction =
    typeof buildTransaction === "function"
      ? buildTransaction(extra)
      : { ...(claimed.fragmentTx || {}), ...extra, response: payload || null };

  const updated = await Order.findByIdAndUpdate(
    claimed._id,
    {
      $set: {
        status: refund.ok ? "cancelled" : claimed.status,
        fulfillmentStatus: refund.ok ? "skipped" : "needs_review",
        fulfillmentError: refund.ok
          ? "GW provider balance insufficient. Customer balance refunded."
          : `GW provider balance insufficient; refund failed: ${refund.reason || "refund_failed"}`,
        fulfilledAt: refund.ok ? handledAt : null,
        fragmentTx: transaction,
      },
    },
    { new: true },
  );

  await notifyAdmins(updated || claimed, refund, providerMessage);
  if (claimed.tgUserId) {
    await sendTelegramText(
      claimed.tgUserId,
      refund.ok
        ? "Buyurtmani bajarishda xatolik yuz berdi. Mablag'ingiz balansingizga qaytarildi. Iltimos, admin bilan bog'laning."
        : "Buyurtmani bajarishda xatolik yuz berdi. Iltimos, admin bilan bog'laning.",
    );
    emitUserUpdate(claimed.tgUserId, {
      type: refund.ok
        ? "game_order_cancelled_refund"
        : "game_order_needs_review",
      refreshBalance: refund.ok,
      refreshOrders: true,
      orderId: claimed._id,
      status: refund.ok ? "cancelled" : claimed.status,
      product: claimed.product,
    });
  }

  return {
    ok: false,
    handled: true,
    cancelled: refund.ok,
    refunded: refund.ok,
    needsReview: !refund.ok,
    reason: "gw_insufficient_balance",
    order: updated || claimed,
  };
}

module.exports = {
  handleGwInsufficientBalance,
  isGwInsufficientBalance,
};
