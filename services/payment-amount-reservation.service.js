const crypto = require("node:crypto");
const Order = require("../model/order.model");
const PaymentAmountReservation = require("../model/payment-amount-reservation.model");

function normalizeAmount(value) {
  const amount = Math.round(Number(value || 0));
  return Number.isSafeInteger(amount) && amount > 0 ? amount : 0;
}

async function hasActiveOrderForAmount(amount, now = new Date()) {
  return Order.exists({
    status: "pending_payment",
    expiresAt: { $gt: now },
    $or: [
      { paymentMatchAmount: amount },
      { paymentAlternateMatchAmount: amount },
      { expectedAmount: amount },
      {
        product: "balance",
        paymentMethod: "bankomat",
        balanceCreditAmount: amount,
      },
    ],
  });
}

async function tryReserveAmount(amount, expiresAt) {
  const now = new Date();
  if (await hasActiveOrderForAmount(amount, now)) return null;

  const token = crypto.randomUUID();
  const recycled = await PaymentAmountReservation.findOneAndUpdate(
    { amount, expiresAt: { $lte: now } },
    {
      $set: {
        token,
        orderId: null,
        expiresAt,
      },
    },
    { new: true },
  ).lean();
  if (recycled) return recycled;

  try {
    return await PaymentAmountReservation.create({
      amount,
      token,
      expiresAt,
    });
  } catch (error) {
    if (error?.code === 11000) return null;
    throw error;
  }
}

async function reservePaymentAmount({
  baseAmount,
  expiresAt,
  allowOffset = true,
  maxOffset = 5000,
}) {
  const normalizedBase = normalizeAmount(baseAmount);
  const normalizedExpiry = new Date(expiresAt);
  if (!normalizedBase || Number.isNaN(normalizedExpiry.getTime())) {
    throw new Error("Payment amount reservation ma'lumoti noto'g'ri");
  }

  const limit = allowOffset ? Math.max(0, Math.min(Number(maxOffset || 0), 50_000)) : 0;
  for (let offset = 0; offset <= limit; offset += 1) {
    const reservation = await tryReserveAmount(
      normalizedBase + offset,
      normalizedExpiry,
    );
    if (reservation) {
      return {
        amount: normalizedBase + offset,
        token: reservation.token,
        reservationId: reservation._id,
      };
    }
  }

  return null;
}

async function attachReservationToOrder(token, orderId) {
  if (!token || !orderId) return null;
  return PaymentAmountReservation.findOneAndUpdate(
    { token, orderId: null },
    { $set: { orderId } },
    { new: true },
  ).lean();
}

async function releasePaymentReservation(token) {
  if (!token) return;
  await PaymentAmountReservation.deleteOne({ token });
}

async function releaseReservationForOrder(order) {
  if (!order) return;
  const conditions = [];
  const tokens = Array.isArray(order.paymentReservationTokens)
    ? order.paymentReservationTokens.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  if (tokens.length) {
    conditions.push({ token: { $in: tokens } });
  }
  if (order.paymentReservationToken) {
    conditions.push({ token: String(order.paymentReservationToken) });
  }
  if (order._id) {
    conditions.push({ orderId: order._id });
  }
  if (!conditions.length) return;
  await PaymentAmountReservation.deleteMany({ $or: conditions });
}

module.exports = {
  attachReservationToOrder,
  releasePaymentReservation,
  releaseReservationForOrder,
  reservePaymentAmount,
};
