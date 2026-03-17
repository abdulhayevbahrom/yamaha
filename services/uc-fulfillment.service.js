const Order = require("../model/order.model");
const { refundToBalance } = require("./order-cancel.service");

async function confirmUcOrderById(orderId) {
  const order = await Order.findById(orderId);
  if (!order) return { ok: false, reason: "not_found" };
  if (order.product !== "uc") return { ok: false, reason: "not_uc" };
  if (order.status !== "paid_auto_processed") {
    return { ok: false, reason: "not_paid" };
  }

  order.status = "completed";
  order.fulfillmentStatus = "success";
  order.fulfilledAt = new Date();
  order.fulfillmentError = "";
  await order.save();

  return { ok: true, order };
}

async function cancelUcOrderById(orderId) {
  const order = await Order.findById(orderId);
  if (!order) return { ok: false, reason: "not_found" };
  if (order.product !== "uc") return { ok: false, reason: "not_uc" };
  if (!["paid_auto_processed", "completed"].includes(order.status)) {
    return { ok: false, reason: "not_paid" };
  }

  const refundResult = await refundToBalance(order);
  if (!refundResult.ok) {
    return { ok: false, reason: refundResult.reason };
  }

  order.status = "cancelled";
  order.fulfillmentStatus = "skipped";
  order.fulfillmentError = "UC order cancelled by admin. Balance refunded.";
  order.fulfilledAt = new Date();
  await order.save();

  return { ok: true, order, refundedAmount: Number(order.paidAmount || 0) };
}

module.exports = { confirmUcOrderById, cancelUcOrderById };
