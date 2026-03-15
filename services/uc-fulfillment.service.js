const Order = require("../model/order.model");

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

module.exports = { confirmUcOrderById };
