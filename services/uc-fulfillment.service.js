const Order = require("../model/order.model");
const { refundToBalance } = require("./order-cancel.service");
const { sendTelegramText } = require("./telegram-notify.service");
const { sendOrderArchive } = require("./order-archive.service");
const { emitUserUpdate } = require("../socket");
const { awardReferralCommissionForOrder } = require("./referral.service");

const MANUAL_GAME_PRODUCTS = ["uc", "freefire", "mlbb"];

function isManualGameProduct(product) {
  return MANUAL_GAME_PRODUCTS.includes(product);
}

async function confirmGameOrderById(orderId) {
  const order = await Order.findById(orderId);
  if (!order) return { ok: false, reason: "not_found" };
  if (!isManualGameProduct(order.product)) {
    return { ok: false, reason: "not_game" };
  }
  if (order.status === "completed") {
    return { ok: true, order, alreadyCompleted: true };
  }
  if (order.status !== "paid_auto_processed") {
    return { ok: false, reason: "not_paid" };
  }

  order.status = "completed";
  order.fulfillmentStatus = "success";
  order.completionMode = "manual";
  order.fulfilledAt = new Date();
  order.fulfillmentError = "";
  await order.save();
  await sendOrderArchive(order, { statusLabel: "Tasdiqlandi" });
  if (order.tgUserId) {
    emitUserUpdate(order.tgUserId, {
      type: "game_order_confirmed",
      refreshOrders: true,
      orderId: order._id,
      status: order.status,
      product: order.product,
    });
  }

  try {
    await awardReferralCommissionForOrder(order);
  } catch (error) {
    console.error(
      "Referral commission apply error:",
      order._id?.toString?.() || order._id,
      error.message,
    );
  }

  return { ok: true, order };
}

async function cancelGameOrderById(orderId) {
  const order = await Order.findById(orderId);
  if (!order) return { ok: false, reason: "not_found" };
  if (!isManualGameProduct(order.product)) {
    return { ok: false, reason: "not_game" };
  }
  if (!["paid_auto_processed", "completed"].includes(order.status)) {
    return { ok: false, reason: "not_paid" };
  }

  const refundResult = await refundToBalance(order);
  if (!refundResult.ok) {
    return { ok: false, reason: refundResult.reason };
  }

  order.status = "cancelled";
  order.fulfillmentStatus = "skipped";
  order.fulfillmentError = "Game order cancelled by admin. Balance refunded.";
  order.fulfilledAt = new Date();
  await order.save();

  if (order.tgUserId) {
    await sendTelegramText(
      order.tgUserId,
      "Xatolik tufayli buyurtma bekor qilindi. To'lovingiz botdagi profilingizga qaytarildi.",
    );
    emitUserUpdate(order.tgUserId, {
      type: "game_order_cancelled_refund",
      refreshBalance: true,
      refreshOrders: true,
      orderId: order._id,
      status: order.status,
      product: order.product,
    });
  }

  return { ok: true, order, refundedAmount: Number(order.paidAmount || 0) };
}

async function confirmUcOrderById(orderId) {
  return confirmGameOrderById(orderId);
}

async function cancelUcOrderById(orderId) {
  return cancelGameOrderById(orderId);
}

module.exports = {
  MANUAL_GAME_PRODUCTS,
  isManualGameProduct,
  confirmGameOrderById,
  cancelGameOrderById,
  confirmUcOrderById,
  cancelUcOrderById,
};
