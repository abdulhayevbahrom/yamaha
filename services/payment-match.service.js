const Order = require("../model/order.model");
const PaymentLog = require("../model/payment-log.model");
const User = require("../model/user.model");
const { autoFulfillOrder } = require("./avtoBuy.service");
const { emitAdminUpdate, emitUserUpdate } = require("../socket");
const { notifyGamePaid } = require("./notify.service");
const { sendOrderArchive } = require("./order-archive.service");
const { isManualGameProduct } = require("./uc-fulfillment.service");

function parseAmountFromText(text) {
  const raw = String(text || "");
  const lines = raw.split(/\r?\n/).map((line) => line.trim());
  const plusLine = lines.find((line) => /^(\+|➕)/.test(line));
  if (plusLine) {
    const match = plusLine.match(/(\+|➕)\s*([\d\s.,]+)\s*UZS/i);
    if (match && match[2]) {
      const rawAmount = match[2].trim();
      const normalized = rawAmount.replace(/\s+/g, "");
      const value = normalized.includes(".")
        ? Number(normalized.replace(/,/g, ""))
        : Number(normalized.replace(/[^\d]/g, ""));
      if (Number.isFinite(value) && value > 0) return Math.round(value);
    }
  }

  return null;
}

async function expirePendingOrders() {
  const now = new Date();
  await Order.updateMany(
    { status: "pending_payment", expiresAt: { $lt: now } },
    { $set: { status: "cancelled" } },
  );
}

async function handlePostPaymentEffects(order, paidAmount, { userEventType = "payment_matched" } = {}) {
  if (!order) return { order: null, fulfillment: null };

  if (order.product === "balance" && order.tgUserId) {
    const balanceIncrease = Number(order.balanceCreditAmount || paidAmount || 0);
    await User.findOneAndUpdate(
      { tgUserId: order.tgUserId },
      { $inc: { balance: balanceIncrease } },
      { upsert: true, new: true },
    );
    await Order.findByIdAndUpdate(order._id, {
      status: "completed",
      fulfillmentStatus: "success",
      completionMode: "auto",
      fulfilledAt: new Date(),
      fulfillmentError: "",
    });
    await sendOrderArchive(
      { ...order, status: "completed" },
      { statusLabel: "Balans to'ldirildi" },
    );
  }

  if (isManualGameProduct(order.product)) {
    emitAdminUpdate({
      type: "game_paid",
      refreshHistory: true,
      orderId: order._id,
      orderCode: order.orderId,
      product: order.product,
      username: order.username,
      planCode: order.planCode,
      expectedAmount: order.expectedAmount,
      paidAmount: order.paidAmount,
      paidAt: order.paidAt,
    });
    notifyGamePaid({
      orderId: order._id,
      orderCode: order.orderId,
      product: order.product,
      username: order.username,
      playerId: order.playerId,
      zoneId: order.zoneId,
      planCode: order.planCode,
      expectedAmount: order.expectedAmount,
      paymentMethod: order.paymentMethod,
    });
  }

  if (order.tgUserId) {
    emitUserUpdate(order.tgUserId, {
      type: order.product === "balance" ? "balance_topup_completed" : userEventType,
      refreshBalance: order.product === "balance",
      refreshOrders: true,
      orderId: order._id,
      status: order.product === "balance" ? "completed" : "paid_auto_processed",
      product: order.product,
    });
  }

  let fulfillment = null;
  try {
    fulfillment = await autoFulfillOrder(order);
  } catch (error) {
    fulfillment = { ok: false, error: error.message || "auto_fulfill_failed" };
  }

  return { order, fulfillment };
}

async function processIncomingPayment({
  rawText = "",
  amount = null,
  externalMessageId = null,
  source = "cardxabar",
}) {
  await expirePendingOrders();

  const parsedAmount = Number(amount || parseAmountFromText(rawText) || 0);
  if (!parsedAmount) {
    await PaymentLog.create({
      source,
      externalMessageId,
      amount: 0,
      rawText,
      status: "invalid",
    });
    return { matched: false, reason: "amount_not_found", amount: 0 };
  }

  if (externalMessageId) {
    const exists = await PaymentLog.findOne({
      source,
      externalMessageId,
    }).lean();
    if (exists) {
      return {
        matched: false,
        duplicate: true,
        reason: "duplicate_message",
        amount: parsedAmount,
      };
    }
  }

  const now = new Date();
  const pending = await Order.findOneAndUpdate(
    {
      status: "pending_payment",
      expectedAmount: parsedAmount,
      expiresAt: { $gt: now },
    },
    {
      $set: {
        status: "paid_auto_processed",
        paidAmount: parsedAmount,
        paidAt: now,
      },
    },
    {
      sort: { createdAt: 1 },
      new: true,
    },
  ).lean();

  if (!pending) {
    await PaymentLog.create({
      source,
      externalMessageId,
      amount: parsedAmount,
      rawText,
      status: "unmatched",
    });
    return {
      matched: false,
      reason: "pending_not_found",
      amount: parsedAmount,
    };
  }

  await PaymentLog.create({
    source,
    externalMessageId,
    amount: parsedAmount,
    rawText,
    status: "matched",
    matchedOrderId: pending._id,
  });

  const { fulfillment } = await handlePostPaymentEffects(pending, parsedAmount, {
    userEventType: "payment_matched",
  });

  return {
    matched: true,
    amount: parsedAmount,
    order: pending,
    fulfillment,
  };
}

async function processTelegramStarsPayment({
  invoicePayload = "",
  telegramPaymentChargeId = "",
  providerPaymentChargeId = "",
  totalAmount = 0,
  tgUserId = "",
  currency = "XTR",
}) {
  await expirePendingOrders();

  const payload = String(invoicePayload || "").trim();
  if (!payload) {
    return { matched: false, reason: "payload_required" };
  }

  const expectedPrefix = "stars_order:";
  if (!payload.startsWith(expectedPrefix)) {
    return { matched: false, reason: "payload_invalid" };
  }

  const orderId = payload.slice(expectedPrefix.length).split(":")[0]?.trim();
  if (!orderId) {
    return { matched: false, reason: "order_id_missing" };
  }

  const order = await Order.findById(orderId).lean();
  if (!order) {
    return { matched: false, reason: "order_not_found" };
  }
  if (String(order.paymentMethod || "") !== "stars") {
    return { matched: false, reason: "not_stars_order", order };
  }
  if (String(order.status || "") !== "pending_payment") {
    return { matched: false, reason: "already_processed", order, duplicate: true };
  }
  if (String(currency || "").toUpperCase() !== "XTR") {
    return { matched: false, reason: "currency_invalid", order };
  }

  const paidStars = Math.max(0, Math.floor(Number(totalAmount || 0)));
  const expectedStars = Math.max(0, Math.floor(Number(order.starsAmount || 0)));
  if (expectedStars > 0 && paidStars !== expectedStars) {
    return {
      matched: false,
      reason: "stars_amount_mismatch",
      paidStars,
      expectedStars,
      order,
    };
  }

  const normalizedOrderUserId = String(order.tgUserId || "").trim();
  const normalizedUpdateUserId = String(tgUserId || "").trim();
  if (
    normalizedOrderUserId &&
    normalizedUpdateUserId &&
    normalizedOrderUserId !== normalizedUpdateUserId
  ) {
    return { matched: false, reason: "user_mismatch", order };
  }

  const now = new Date();
  const paidAmountUzs = Number(order.expectedAmount || 0);
  const fragmentTx =
    order.fragmentTx && typeof order.fragmentTx === "object" && !Array.isArray(order.fragmentTx)
      ? order.fragmentTx
      : {};

  const updated = await Order.findOneAndUpdate(
    { _id: order._id, status: "pending_payment" },
    {
      $set: {
        status: "paid_auto_processed",
        paidAmount: paidAmountUzs,
        paidAt: now,
        starsTelegramChargeId: String(telegramPaymentChargeId || "").trim(),
        fragmentTx: {
          ...fragmentTx,
          starsPayment: {
            payload,
            totalAmount: paidStars,
            currency: "XTR",
            telegramPaymentChargeId: String(telegramPaymentChargeId || "").trim(),
            providerPaymentChargeId: String(providerPaymentChargeId || "").trim(),
            paidAt: now.toISOString(),
          },
        },
      },
    },
    { new: true },
  ).lean();

  if (!updated) {
    return { matched: false, reason: "race_condition", order, duplicate: true };
  }

  const { fulfillment } = await handlePostPaymentEffects(updated, paidAmountUzs, {
    userEventType: "payment_matched",
  });

  return {
    matched: true,
    order: updated,
    fulfillment,
    paidStars,
    paidAmountUzs,
  };
}

module.exports = {
  parseAmountFromText,
  processIncomingPayment,
  processTelegramStarsPayment,
};
