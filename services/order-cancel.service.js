const Order = require("../model/order.model");
const User = require("../model/user.model");

async function refundToBalance(order) {
  if (!order?.tgUserId || Number(order.paidAmount || 0) <= 0) {
    return { ok: false, reason: "refund_not_available" };
  }

  const user = await User.findOneAndUpdate(
    { tgUserId: String(order.tgUserId) },
    { $inc: { balance: Number(order.paidAmount || 0) } },
    { new: true, upsert: true },
  ).lean();

  return { ok: true, user };
}

async function cancelPaidOrderById(orderId) {
  const order = await Order.findById(orderId);
  if (!order) return { ok: false, reason: "not_found" };
  if (!["paid_auto_processed", "completed", "failed"].includes(order.status)) {
    return { ok: false, reason: "not_cancellable" };
  }

  const refundResult = await refundToBalance(order);
  if (!refundResult.ok) {
    return { ok: false, reason: refundResult.reason };
  }

  order.status = "cancelled";
  order.fulfillmentStatus = "skipped";
  order.fulfillmentError = "Admin cancelled. Balance refunded.";
  order.fulfilledAt = new Date();
  await order.save();

  return { ok: true, order, refundedAmount: Number(order.paidAmount || 0) };
}

module.exports = {
  cancelPaidOrderById,
  refundToBalance,
};
