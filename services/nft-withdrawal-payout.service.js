const Order = require("../model/order.model");
const User = require("../model/user.model");
const { emitAdminUpdate, emitUserUpdate } = require("../socket");
const { applyBalanceDeltaOnce } = require("./balance-operation.service");
const { sendTelegramText, editTelegramText } = require("./telegram-notify.service");
const { sendOrderArchive } = require("./order-archive.service");
const { getManagerUsername, getManagerUrl } = require("./star-sell-payout.service");
const { getSupportConfig } = require("./settings.service");

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
  const order = await Order.findOneAndUpdate(
    {
      _id: orderId,
      product: "nft_withdrawal",
      status: { $in: ["payment_submitted", "paid_auto_processed"] },
    },
    { $set: { status: "admin_action_processing" } },
    { new: false },
  );
  if (!order) {
    const latest = await Order.findById(orderId);
    if (!latest) return { ok: false, reason: "not_found" };
    if (String(latest.product || "").toLowerCase() !== "nft_withdrawal") {
      return { ok: false, reason: "not_nft_withdrawal" };
    }
    if (latest.status === "completed") {
      return { ok: true, alreadyCompleted: true, order: latest };
    }
    return { ok: false, reason: "not_ready" };
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
  const order = await Order.findOneAndUpdate(
    {
      _id: orderId,
      product: "nft_withdrawal",
      status: { $in: [...READY_STATUSES].filter((status) => status !== "completed") },
    },
    { $set: { status: "admin_action_processing" } },
    { new: false },
  );
  if (!order) {
    const latest = await Order.findById(orderId);
    if (!latest) return { ok: false, reason: "not_found" };
    if (String(latest.product || "").toLowerCase() !== "nft_withdrawal") {
      return { ok: false, reason: "not_nft_withdrawal" };
    }
    if (latest.status === "completed") {
      return { ok: false, reason: "already_completed" };
    }
    if (latest.status === "cancelled") {
      return { ok: true, alreadyCancelled: true, order: latest };
    }
    return { ok: false, reason: "not_ready" };
  }

  const amount = Math.max(0, Math.round(Number(order.expectedAmount || 0)));
  const now = new Date();
  const supportConfig = await getSupportConfig().catch(() => null);
  const managerUsername = String(supportConfig?.username || getManagerUsername()).trim();
  const managerUrl = getManagerUrl(managerUsername);
  const fragmentTx = getSafeFragmentTx(order);

  if (amount > 0 && String(order.tgUserId || "").trim()) {
    const creditResult = await applyBalanceDeltaOnce({
      tgUserId: order.tgUserId,
      operationKey: `nft-withdrawal-cancel:${String(order._id)}`,
      amount,
      extraIncrement: { nftEarningsBalance: amount },
    });
    if (!creditResult.ok) {
      await Order.updateOne(
        { _id: order._id, status: "admin_action_processing" },
        { $set: { status: order.status } },
      );
      return { ok: false, reason: creditResult.reason || "refund_failed" };
    }
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
