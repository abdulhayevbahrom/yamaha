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
  if (order.status === "cancelled") {
    return { ok: false, reason: "already_cancelled" };
  }
  if (order.status !== "paid_auto_processed") {
    return { ok: false, reason: "not_paid" };
  }

  const lockedOrder = await Order.findOneAndUpdate(
    { _id: orderId, status: "paid_auto_processed" },
    { $set: { status: "admin_action_processing" } },
    { new: true },
  );
  if (!lockedOrder) {
    const latest = await Order.findById(orderId);
    if (!latest) return { ok: false, reason: "not_found" };
    if (latest.status === "completed") {
      return { ok: true, order: latest, alreadyCompleted: true };
    }
    if (latest.status === "cancelled") {
      return { ok: false, reason: "already_cancelled" };
    }
    return { ok: false, reason: "already_processed" };
  }

  lockedOrder.status = "completed";
  lockedOrder.fulfillmentStatus = "success";
  lockedOrder.completionMode = "manual";
  lockedOrder.fulfilledAt = new Date();
  lockedOrder.fulfillmentError = "";
  await lockedOrder.save();
  await sendOrderArchive(lockedOrder, { statusLabel: "Tasdiqlandi" });
  if (lockedOrder.tgUserId) {
    emitUserUpdate(lockedOrder.tgUserId, {
      type: "game_order_confirmed",
      refreshOrders: true,
      orderId: lockedOrder._id,
      status: lockedOrder.status,
      product: lockedOrder.product,
    });
  }

  try {
    await awardReferralCommissionForOrder(lockedOrder);
  } catch (error) {
    console.error(
      "Referral commission apply error:",
      lockedOrder._id?.toString?.() || lockedOrder._id,
      error.message,
    );
  }

  return { ok: true, order: lockedOrder };
}

async function cancelGameOrderById(orderId) {
  const order = await Order.findById(orderId);
  if (!order) return { ok: false, reason: "not_found" };
  if (!isManualGameProduct(order.product)) {
    return { ok: false, reason: "not_game" };
  }
  if (order.status === "cancelled") {
    return { ok: true, order, alreadyCancelled: true };
  }
  if (order.status === "completed") {
    return { ok: false, reason: "already_completed" };
  }
  if (order.status !== "paid_auto_processed") {
    return { ok: false, reason: "not_paid" };
  }

  const lockedOrder = await Order.findOneAndUpdate(
    { _id: orderId, status: "paid_auto_processed" },
    { $set: { status: "admin_action_processing" } },
    { new: true },
  );
  if (!lockedOrder) {
    const latest = await Order.findById(orderId);
    if (!latest) return { ok: false, reason: "not_found" };
    if (latest.status === "cancelled") {
      return { ok: true, order: latest, alreadyCancelled: true };
    }
    if (latest.status === "completed") {
      return { ok: false, reason: "already_completed" };
    }
    return { ok: false, reason: "already_processed" };
  }

  const refundResult = await refundToBalance(lockedOrder);
  if (!refundResult.ok) {
    await Order.findByIdAndUpdate(lockedOrder._id, {
      $set: { status: "paid_auto_processed" },
    });
    return { ok: false, reason: refundResult.reason };
  }

  lockedOrder.status = "cancelled";
  lockedOrder.fulfillmentStatus = "skipped";
  lockedOrder.fulfillmentError = "Game order cancelled by admin. Balance refunded.";
  lockedOrder.fulfilledAt = new Date();
  await lockedOrder.save();

  if (lockedOrder.tgUserId) {
    await sendTelegramText(
      lockedOrder.tgUserId,
      "Xatolik tufayli buyurtma bekor qilindi. To'lovingiz botdagi profilingizga qaytarildi.",
    );
    emitUserUpdate(lockedOrder.tgUserId, {
      type: "game_order_cancelled_refund",
      refreshBalance: true,
      refreshOrders: true,
      orderId: lockedOrder._id,
      status: lockedOrder.status,
      product: lockedOrder.product,
    });
  }

  return { ok: true, order: lockedOrder, refundedAmount: Number(lockedOrder.paidAmount || 0) };
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
