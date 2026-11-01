const Order = require("../model/order.model");
const { emitAdminUpdate, emitUserUpdate } = require("../socket");
const { applyBalanceDeltaOnce } = require("./balance-operation.service");
const { sendTelegramText } = require("./telegram-notify.service");
const { sendOrderArchive } = require("./order-archive.service");

function getAdminNotifyIds() {
  return String(process.env.ADMIN_NOTIFY_CHAT_ID || "")
    .split(",").map((item) => item.trim()).filter(Boolean);
}

async function notifyAdminsAboutBalanceReview(order) {
  const adminIds = getAdminNotifyIds();
  if (!adminIds.length || !order) return [];
  const snapshot = order.customerPaymentLevelSnapshot || {};
  const card = order.paymentCardSnapshot || {};
  const paidAt = order.paidAt ? new Date(order.paidAt).toLocaleString("uz-UZ", { timeZone: "Asia/Tashkent" }) : "-";
  const text = [
    "⚠️ Katta balans to'lovi tekshiruvda",
    `🧾 Buyurtma: #${order.orderId || "-"}`,
    `👤 Mijoz: ${order.tgUsername ? `@${order.tgUsername}` : "-"} (${order.tgUserId || "-"})`,
    `🏅 Daraja: ${snapshot.badge || ""} ${snapshot.name || "Bronze"}`.trim(),
    `📊 Bajarilgan orderlar: ${Number(snapshot.completedOrderCount || 0).toLocaleString("uz-UZ")}`,
    `💰 Orderlar summasi: ${Number(snapshot.completedOrderAmount || 0).toLocaleString("uz-UZ")} UZS`,
    `🚦 Avtomatik limit: ${Number(snapshot.maxAutoTopupAmount || 0).toLocaleString("uz-UZ")} UZS`,
    "",
    `💳 Karta: ${card.label || "-"}`,
    `🔢 Karta raqami: ${card.cardNumber || "-"}`,
    `👤 Karta egasi: ${card.cardHolder || "-"}`,
    `🏦 To'lov usuli: ${order.paymentMethod || "-"}`,
    `📍 To'lov manbasi: ${order.paymentProviderName || "Aniqlanmadi"}`,
    `🧾 Provider ma'lumoti: ${order.paymentProviderDetails || "-"}`,
    `🕐 To'lov vaqti: ${paidAt}`,
    `💵 Tushgan summa: ${Number(order.paidAmount || order.paymentGrossAmount || 0).toLocaleString("uz-UZ")} UZS`,
    `➕ Balansga kiritiladigan summa: ${Number(order.balanceCreditAmount || order.paidAmount || 0).toLocaleString("uz-UZ")} UZS`,
    `📉 Komissiya: ${Number(order.paymentFeePercent || 0).toLocaleString("uz-UZ")}%`,
  ].join("\n");
  const results = await Promise.allSettled(adminIds.map((chatId) =>
    sendTelegramText(chatId, text, {
      reply_markup: { inline_keyboard: [[
        { text: "✅ Tasdiqlash", callback_data: `CONFIRM_BALANCE_REVIEW:${order._id}` },
        { text: "❌ Rad etish", callback_data: `REJECT_BALANCE_REVIEW:${order._id}` },
      ]] },
    }),
  ));
  return results.filter((item) => item.status === "fulfilled" && item.value?.ok);
}

async function approveBalanceTopupReview(orderId, reviewer = {}) {
  const now = new Date();
  let order = await Order.findOneAndUpdate(
    { _id: orderId, product: "balance", status: "manual_review", reviewDecision: "pending" },
    { $set: { status: "admin_action_processing", reviewedAt: now, reviewedBy: String(reviewer.id || ""), reviewNote: String(reviewer.note || "") } },
    { new: true },
  ).lean();
  if (!order) {
    const existing = await Order.findById(orderId).lean();
    if (!existing) return { ok: false, reason: "not_found" };
    if (existing.reviewDecision === "approved" && existing.status === "completed") return { ok: true, alreadyProcessed: true, order: existing };
    return { ok: false, reason: "already_processed", order: existing };
  }
  const amount = Number(order.balanceCreditAmount || order.paidAmount || 0);
  const credit = await applyBalanceDeltaOnce({
    tgUserId: order.tgUserId,
    operationKey: `balance-topup:${String(order._id)}`,
    amount,
    upsert: true,
  });
  if (!credit.ok) {
    await Order.updateOne({ _id: order._id, status: "admin_action_processing" }, { $set: { status: "manual_review", reviewedAt: null, reviewedBy: "", fulfillmentStatus: "needs_review", fulfillmentError: credit.reason || "balance_credit_failed" } });
    return { ok: false, reason: credit.reason || "balance_credit_failed", order };
  }
  order = await Order.findOneAndUpdate(
    { _id: order._id, status: "admin_action_processing" },
    { $set: { status: "completed", fulfillmentStatus: "success", completionMode: "manual", fulfilledAt: now, reviewDecision: "approved", fulfillmentError: "" } },
    { new: true },
  ).lean();
  if (!order) {
    await Order.updateOne(
      { _id: orderId, status: "admin_action_processing" },
      { $set: { status: "manual_review", fulfillmentStatus: "needs_review", fulfillmentError: "balance_order_finalize_failed", reviewedAt: null, reviewedBy: "" } },
    );
    return { ok: false, reason: "finalize_failed" };
  }
  emitAdminUpdate({ type: "balance_review_completed", refreshHistory: true, orderId: order._id });
  emitUserUpdate(order.tgUserId, { type: "balance_topup_completed", refreshBalance: true, refreshOrders: true, orderId: order._id, status: "completed", amount, balance: Number(credit.user?.balance || 0) });
  await sendOrderArchive(order, { statusLabel: "Balans admin tomonidan to'ldirildi" }).catch(() => {});
  return { ok: true, order };
}

async function rejectBalanceTopupReview(orderId, reviewer = {}) {
  const order = await Order.findOneAndUpdate(
    { _id: orderId, product: "balance", status: "manual_review", reviewDecision: "pending" },
    { $set: { status: "review_rejected", fulfillmentStatus: "skipped", reviewDecision: "rejected", reviewedAt: new Date(), reviewedBy: String(reviewer.id || ""), reviewNote: String(reviewer.note || "") } },
    { new: true },
  ).lean();
  if (!order) {
    const existing = await Order.findById(orderId).lean();
    if (!existing) return { ok: false, reason: "not_found" };
    if (existing.reviewDecision === "rejected") return { ok: true, alreadyProcessed: true, order: existing };
    return { ok: false, reason: "already_processed", order: existing };
  }
  emitAdminUpdate({ type: "balance_review_rejected", refreshHistory: true, orderId: order._id });
  emitUserUpdate(order.tgUserId, { type: "balance_topup_review_rejected", refreshOrders: true, orderId: order._id, status: order.status });
  return { ok: true, order };
}

module.exports = { notifyAdminsAboutBalanceReview, approveBalanceTopupReview, rejectBalanceTopupReview };
