const Order = require("../model/order.model");
const User = require("../model/user.model");
const { emitAdminUpdate, emitUserUpdate } = require("../socket");
const { sendTelegramText, editTelegramText } = require("./telegram-notify.service");
const { sendOrderArchive } = require("./order-archive.service");
const { getManagerUsername, getManagerUrl } = require("./star-sell-payout.service");

const READY_STATUSES = new Set([
  "payment_submitted",
  "paid_auto_processed",
  "completed",
  "cancelled",
]);

function getSafeFragmentTx(order) {
  return order?.fragmentTx && typeof order.fragmentTx === "object" && !Array.isArray(order.fragmentTx)
    ? order.fragmentTx
    : {};
}

function buildAdminText(order, statusText) {
  const username = String(order?.tgUsername || "").trim();
  const usernameLabel = username ? `@${username}` : "-";
  const reqAmount = Number(order?.expectedAmount || 0);
  const feePercent = Number(order?.fragmentTx?.nftWithdrawal?.feePercent || 0);
  const netAmount = Number(order?.fragmentTx?.nftWithdrawal?.netAmountUzs || 0);
  return [
    "💸 NFT sotuv balansini yechib olish so'rovi",
    `🧾 Buyurtma: #${order?.orderId || "-"}`,
    `👤 Mijoz: ${usernameLabel} (${String(order?.tgUserId || "-")})`,
    `💳 Mijoz kartasi: ${String(order?.sellCardNumber || "-")}`,
    `💰 So'ralgan summa: ${reqAmount.toLocaleString("uz-UZ")} UZS`,
    `📉 Komissiya: ${feePercent}%`,
    `✅ Mijozga beriladigan: ${netAmount.toLocaleString("uz-UZ")} UZS`,
    statusText,
  ].join("\n");
}

async function syncAdminMessages(order, statusText) {
  const fragmentTx = getSafeFragmentTx(order);
  const items = Array.isArray(fragmentTx?.nftWithdrawalAdminNotifications)
    ? fragmentTx.nftWithdrawalAdminNotifications
    : [];
  if (!items.length) return;
  const text = buildAdminText(order, statusText);
  await Promise.allSettled(
    items.map((item) =>
      editTelegramText(item?.chatId, item?.messageId, text, {
        reply_markup: { inline_keyboard: [] },
      }),
    ),
  );
}

async function confirmNftWithdrawalById(orderId) {
  const order = await Order.findById(orderId);
  if (!order) return { ok: false, reason: "not_found" };
  if (String(order.product || "").toLowerCase() !== "nft_withdrawal") {
    return { ok: false, reason: "not_nft_withdrawal" };
  }
  const status = String(order.status || "");
  if (!READY_STATUSES.has(status) || status === "cancelled") return { ok: false, reason: "not_ready" };
  if (status === "completed") return { ok: true, alreadyCompleted: true, order };

  const now = new Date();
  const fragmentTx = getSafeFragmentTx(order);
  order.status = "completed";
  order.fulfillmentStatus = "success";
  order.completionMode = "manual";
  order.fulfilledAt = now;
  order.fulfillmentError = "";
  order.fragmentTx = {
    ...fragmentTx,
    nftWithdrawal: {
      ...(fragmentTx.nftWithdrawal || {}),
      confirmedByAdmin: true,
      confirmedAt: now.toISOString(),
    },
  };
  await order.save();
  await sendOrderArchive(order, { statusLabel: "Pul o'tkazildi" });
  await syncAdminMessages(order, "✅ Holat: Tasdiqlandi");

  emitAdminUpdate({ type: "nft_withdrawal_confirmed", refreshHistory: true, orderId: order._id });
  if (String(order.tgUserId || "").trim()) {
    emitUserUpdate(String(order.tgUserId), {
      type: "nft_withdrawal_completed",
      refreshOrders: true,
      refreshBalance: true,
      orderId: order._id,
      status: order.status,
      product: order.product,
    });
    await sendTelegramText(order.tgUserId, "✅ NFT sotuvdan pul yechib olish so'rovingiz tasdiqlandi.");
  }
  return { ok: true, alreadyCompleted: false, order };
}

async function cancelNftWithdrawalById(orderId) {
  const order = await Order.findById(orderId);
  if (!order) return { ok: false, reason: "not_found" };
  if (String(order.product || "").toLowerCase() !== "nft_withdrawal") {
    return { ok: false, reason: "not_nft_withdrawal" };
  }
  const status = String(order.status || "");
  if (!READY_STATUSES.has(status)) return { ok: false, reason: "not_ready" };
  if (status === "completed") return { ok: false, reason: "already_completed" };
  if (status === "cancelled") return { ok: true, alreadyCancelled: true, order };

  const amount = Math.max(0, Math.round(Number(order.expectedAmount || 0)));
  const now = new Date();
  const managerUsername = getManagerUsername();
  const managerUrl = getManagerUrl(managerUsername);
  const fragmentTx = getSafeFragmentTx(order);

  if (amount > 0 && String(order.tgUserId || "").trim()) {
    await User.findOneAndUpdate(
      { tgUserId: String(order.tgUserId) },
      { $inc: { balance: amount, nftEarningsBalance: amount } },
      { new: true },
    );
  }

  order.status = "cancelled";
  order.fulfillmentStatus = "failed";
  order.completionMode = "manual";
  order.fulfilledAt = now;
  order.fulfillmentError = "nft_withdrawal_cancelled_by_admin";
  order.fragmentTx = {
    ...fragmentTx,
    nftWithdrawal: {
      ...(fragmentTx.nftWithdrawal || {}),
      cancelledByAdmin: true,
      cancelledAt: now.toISOString(),
      managerUsername,
    },
  };
  await order.save();
  await syncAdminMessages(order, `❌ Holat: Bekor qilindi (support: ${managerUsername})`);

  emitAdminUpdate({ type: "nft_withdrawal_cancelled", refreshHistory: true, orderId: order._id });
  if (String(order.tgUserId || "").trim()) {
    emitUserUpdate(String(order.tgUserId), {
      type: "nft_withdrawal_cancelled",
      refreshOrders: true,
      refreshBalance: true,
      orderId: order._id,
      status: order.status,
      product: order.product,
    });
    await sendTelegramText(order.tgUserId, "❌ NFT sotuvdan pul yechib olish so'rovingiz bekor qilindi.", {
      reply_markup: { inline_keyboard: [[{ text: "Adminga yozish", url: managerUrl }]] },
    });
  }
  return { ok: true, alreadyCancelled: false, order };
}

module.exports = {
  confirmNftWithdrawalById,
  cancelNftWithdrawalById,
  buildAdminText,
};

