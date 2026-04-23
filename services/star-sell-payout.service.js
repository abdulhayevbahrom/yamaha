const Order = require("../model/order.model");
const { emitAdminUpdate, emitUserUpdate } = require("../socket");
const { sendTelegramText, editTelegramText } = require("./telegram-notify.service");
const { sendOrderArchive } = require("./order-archive.service");

const STAR_SELL_READY_STATUSES = new Set([
  "payment_submitted",
  "paid_auto_processed",
  "completed",
  "cancelled",
]);

function getManagerUsername() {
  const raw = String(
    process.env.STAR_SELL_SUPPORT_USERNAME || "@manager_premium",
  ).trim();
  if (!raw) return "@manager_premium";
  return raw.startsWith("@") ? raw : `@${raw}`;
}

function getManagerUrl(username) {
  return `https://t.me/${String(username || "").replace(/^@+/, "")}`;
}

function getSafeFragmentTx(order) {
  return order?.fragmentTx &&
    typeof order.fragmentTx === "object" &&
    !Array.isArray(order.fragmentTx)
    ? order.fragmentTx
    : {};
}

function buildAdminResolutionText(order, statusText) {
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
}

async function syncAdminNotificationMessages(order, statusText) {
  const fragmentTx = getSafeFragmentTx(order);
  const items = Array.isArray(fragmentTx?.starSellAdminNotifications)
    ? fragmentTx.starSellAdminNotifications
    : [];
  if (!items.length) return;

  const text = buildAdminResolutionText(order, statusText);
  await Promise.allSettled(
    items.map((item) =>
      editTelegramText(item?.chatId, item?.messageId, text, {
        reply_markup: { inline_keyboard: [] },
      }),
    ),
  );
}

async function confirmStarSellPayoutById(orderId) {
  const order = await Order.findById(orderId);
  if (!order) {
    return { ok: false, reason: "not_found" };
  }

  if (String(order.product || "").toLowerCase() !== "star_sell") {
    return { ok: false, reason: "not_star_sell" };
  }

  const status = String(order.status || "");
  if (!STAR_SELL_READY_STATUSES.has(status) || status === "cancelled") {
    return { ok: false, reason: "not_ready" };
  }

  if (status === "completed") {
    return { ok: true, alreadyCompleted: true, order };
  }

  const now = new Date();
  const fragmentTx = getSafeFragmentTx(order);

  order.status = "completed";
  order.fulfillmentStatus = "success";
  order.completionMode = "manual";
  order.fulfilledAt = now;
  order.fulfillmentError = "";
  order.fragmentTx = {
    ...fragmentTx,
    starSellPayout: {
      confirmedByAdmin: true,
      confirmedAt: now.toISOString(),
    },
  };
  await order.save();
  await sendOrderArchive(order, { statusLabel: "Pul o'tkazildi" });
  await syncAdminNotificationMessages(order, "✅ Holat: Tasdiqlandi");

  emitAdminUpdate({
    type: "star_sell_payout_confirmed",
    refreshHistory: true,
    orderId: order._id,
    orderCode: order.orderId,
    product: order.product,
    tgUserId: order.tgUserId,
  });

  if (String(order.tgUserId || "").trim()) {
    emitUserUpdate(String(order.tgUserId), {
      type: "star_sell_payout_completed",
      refreshOrders: true,
      refreshBalance: false,
      orderId: order._id,
      status: order.status,
      product: order.product,
    });

    const msg = [
      "✅ Star sotish buyurtmangiz bo'yicha pul o'tkazilishi tasdiqlandi.",
      `🧾 Buyurtma: #${order.orderId || "-"}`,
      `✨ Star: ${Number(order.customAmount || 0).toLocaleString("uz-UZ")}`,
      `💵 To'lanadigan summa: ${Number(order.expectedAmount || 0).toLocaleString("uz-UZ")} UZS`,
    ].join("\n");
    await sendTelegramText(order.tgUserId, msg);
  }

  return { ok: true, alreadyCompleted: false, order };
}

async function cancelStarSellPayoutById(orderId) {
  const order = await Order.findById(orderId);
  if (!order) {
    return { ok: false, reason: "not_found" };
  }

  if (String(order.product || "").toLowerCase() !== "star_sell") {
    return { ok: false, reason: "not_star_sell" };
  }

  const status = String(order.status || "");
  if (!STAR_SELL_READY_STATUSES.has(status)) {
    return { ok: false, reason: "not_ready" };
  }
  if (status === "completed") {
    return { ok: false, reason: "already_completed" };
  }
  if (status === "cancelled") {
    return { ok: true, alreadyCancelled: true, order };
  }

  const now = new Date();
  const managerUsername = getManagerUsername();
  const managerUrl = getManagerUrl(managerUsername);
  const fragmentTx = getSafeFragmentTx(order);

  order.status = "cancelled";
  order.fulfillmentStatus = "failed";
  order.completionMode = "manual";
  order.fulfilledAt = now;
  order.fulfillmentError = "star_sell_payout_cancelled_by_admin";
  order.fragmentTx = {
    ...fragmentTx,
    starSellPayout: {
      cancelledByAdmin: true,
      cancelledAt: now.toISOString(),
      managerUsername,
    },
  };
  await order.save();
  await syncAdminNotificationMessages(
    order,
    `❌ Holat: Bekor qilindi (support: ${managerUsername})`,
  );

  emitAdminUpdate({
    type: "star_sell_payout_cancelled",
    refreshHistory: true,
    orderId: order._id,
    orderCode: order.orderId,
    product: order.product,
    tgUserId: order.tgUserId,
  });

  if (String(order.tgUserId || "").trim()) {
    emitUserUpdate(String(order.tgUserId), {
      type: "star_sell_payout_cancelled",
      refreshOrders: true,
      refreshBalance: false,
      orderId: order._id,
      status: order.status,
      product: order.product,
    });

    const msg = [
      "❌ Buyurtma ma'lum sababga ko'ra bekor qilindi.",
      "Adminga murojaat qiling.",
    ].join("\n");
    await sendTelegramText(order.tgUserId, msg, {
      reply_markup: {
        inline_keyboard: [[{ text: "Adminga yozish", url: managerUrl }]],
      },
    });
  }

  return { ok: true, alreadyCancelled: false, order };
}

module.exports = {
  confirmStarSellPayoutById,
  cancelStarSellPayoutById,
  getManagerUsername,
  getManagerUrl,
};
