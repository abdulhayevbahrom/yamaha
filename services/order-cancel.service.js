const Order = require("../model/order.model");
const User = require("../model/user.model");
const { sendTelegramText } = require("./telegram-notify.service");
const { emitUserUpdate } = require("../socket");
const { getRefundAmount } = require("./order-refund-amount.service");
const { applyBalanceDeltaOnce } = require("./balance-operation.service");

async function refundToBalance(order, options = {}) {
  const refundAmount = getRefundAmount(order);
  if (!order?.tgUserId || refundAmount <= 0) {
    return { ok: false, reason: "refund_not_available" };
  }

  const operationKey =
    String(options.operationKey || "").trim() ||
    `order-refund:${String(order._id || order.orderId || "")}`;
  const result = await applyBalanceDeltaOnce({
    tgUserId: order.tgUserId,
    operationKey,
    amount: refundAmount,
    upsert: true,
  });
  if (!result.ok) {
    return { ok: false, reason: result.reason || "refund_failed" };
  }

  return {
    ok: true,
    duplicate: Boolean(result.duplicate),
    user: result.user,
    refundedAmount: refundAmount,
  };
}

async function cancelPaidOrderById(orderId) {
  const order = await Order.findOneAndUpdate(
    {
      _id: orderId,
      fulfillmentStatus: { $nin: ["processing", "needs_review", "success"] },
      status: { $in: ["paid_auto_processed", "failed"] },
    },
    { $set: { status: "admin_action_processing" } },
    { new: false },
  );
  if (!order) {
    const latest = await Order.findById(orderId).lean();
    if (!latest) return { ok: false, reason: "not_found" };
    if (latest.status === "cancelled") {
      return { ok: true, alreadyCancelled: true, order: latest };
    }
    return { ok: false, reason: "not_cancellable" };
  }

  const refundResult = await refundToBalance(order);
  if (!refundResult.ok) {
    await Order.updateOne(
      { _id: order._id, status: "admin_action_processing" },
      { $set: { status: order.status } },
    );
    return { ok: false, reason: refundResult.reason };
  }

  order.status = "cancelled";
  order.fulfillmentStatus = "skipped";
  order.fulfillmentError = "Admin cancelled. Balance refunded.";
  order.fulfilledAt = new Date();
  await order.save();

  if (order.tgUserId) {
    await sendTelegramText(
      order.tgUserId,
      "Xatolik tufayli buyurtma bekor qilindi. To'lovingiz botdagi profilingizga qaytarildi.",
    );
    emitUserUpdate(order.tgUserId, {
      type: "order_cancelled_refund",
      refreshBalance: true,
      refreshOrders: true,
      orderId: order._id,
      status: order.status,
      product: order.product,
    });
  }

  return { ok: true, order, refundedAmount: refundResult.refundedAmount };
}

module.exports = {
  cancelPaidOrderById,
  getRefundAmount,
  refundToBalance,
};
