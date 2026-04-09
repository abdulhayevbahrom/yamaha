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

  if (pending.product === "balance" && pending.tgUserId) {
    const balanceIncrease = Number(
      pending.balanceCreditAmount || parsedAmount || 0,
    );
    await User.findOneAndUpdate(
      { tgUserId: pending.tgUserId },
      { $inc: { balance: balanceIncrease } },
      { upsert: true, new: true },
    );
    await Order.findByIdAndUpdate(pending._id, {
      status: "completed",
      fulfillmentStatus: "success",
      fulfilledAt: new Date(),
      fulfillmentError: "",
    });
    await sendOrderArchive({ ...pending, status: "completed" }, {
      statusLabel: "Balans to'ldirildi",
    });
  }

  if (isManualGameProduct(pending.product)) {
    emitAdminUpdate({
      type: "game_paid",
      refreshHistory: true,
      orderId: pending._id,
      orderCode: pending.orderId,
      product: pending.product,
      username: pending.username,
      planCode: pending.planCode,
      expectedAmount: pending.expectedAmount,
      paidAmount: pending.paidAmount,
      paidAt: pending.paidAt,
    });
    notifyGamePaid({
      orderId: pending._id,
      orderCode: pending.orderId,
      product: pending.product,
      username: pending.username,
      playerId: pending.playerId,
      zoneId: pending.zoneId,
      planCode: pending.planCode,
      expectedAmount: pending.expectedAmount,
    });
  }

  if (pending.tgUserId) {
    emitUserUpdate(pending.tgUserId, {
      type:
        pending.product === "balance"
          ? "balance_topup_completed"
          : "payment_matched",
      refreshBalance: pending.product === "balance",
      refreshOrders: true,
      orderId: pending._id,
      status: pending.product === "balance" ? "completed" : "paid_auto_processed",
      product: pending.product,
    });
  }

  let fulfillment = null;
  try {
    fulfillment = await autoFulfillOrder(pending);
  } catch (error) {
    fulfillment = { ok: false, error: error.message || "auto_fulfill_failed" };
  }

  return {
    matched: true,
    amount: parsedAmount,
    order: pending,
    fulfillment,
  };
}

module.exports = {
  parseAmountFromText,
  processIncomingPayment,
};
