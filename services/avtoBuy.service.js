const Order = require("../model/order.model");
const Plan = require("../model/plan.model");
const { sendOrderArchive } = require("./order-archive.service");
const { sendTelegramText } = require("./telegram-notify.service");
const {
  getRefundAmount,
  refundToBalance,
} = require("./order-cancel.service");
const { emitUserUpdate } = require("../socket");
const { awardReferralCommissionForOrder } = require("./referral.service");
const {
  buyStars: buyStarsFromFragment,
  buyPremium: buyPremiumFromFragment,
} = require("./fragment-api.service");
const User = require("../model/user.model");
const { applyBalanceDeltaOnce } = require("./balance-operation.service");
const { isAmbiguousExternalError } = require("./external-operation.service");

function getFragmentErrorPayload(error) {
  const fragmentPayload = error?.fragmentPayload;
  if (
    fragmentPayload &&
    typeof fragmentPayload === "object" &&
    !Array.isArray(fragmentPayload)
  ) {
    return fragmentPayload;
  }

  const responseData = error?.response?.data;
  if (
    responseData &&
    typeof responseData === "object" &&
    !Array.isArray(responseData)
  ) {
    return responseData;
  }
  if (responseData) {
    return { error: String(responseData) };
  }
  if (error?.message) {
    return { error: String(error.message) };
  }
  return null;
}

function parseAdminNotifyIds() {
  return String(process.env.ADMIN_NOTIFY_CHAT_ID || "")
    .split(",")
    .map((id) => String(id).trim())
    .filter(Boolean);
}

function normalizeFragmentErrorText(payload, fallback = "") {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return String(
      payload.message || payload.error || payload.code || fallback || "",
    )
      .trim()
      .toLowerCase();
  }

  return String(fallback || "").trim().toLowerCase();
}

function isFragmentLowBalanceError(payload, fallback = "") {
  const code = String(payload?.code || "").trim().toUpperCase();
  const text = normalizeFragmentErrorText(payload, fallback);

  return (
    code === "INSUFFICIENT_FUNDS" ||
    text.includes("hamyonda to'lov uchun yetarli ton yo'q") ||
    text.includes("yetarli ton yo'q") ||
    text.includes("insufficient funds")
  );
}

async function notifyAdminsAboutFragmentLowBalance(order, payload) {
  const adminIds = parseAdminNotifyIds();
  if (!adminIds.length) return false;

  const orderCode = String(order?.orderId || order?._id || "").trim() || "-";
  const product = String(order?.product || "").trim() || "-";
  const username = String(order?.username || "").trim() || "-";
  const amount =
    order?.product === "star"
      ? Number(order?.customAmount || 0) || String(order?.planCode || "").trim()
      : String(order?.planCode || "").trim() || "-";
  const paymentMethod = String(order?.paymentMethod || "").trim() || "-";
  const paidAmount = Number(order?.paidAmount || 0).toLocaleString("uz-UZ");
  const reason = String(
    payload?.message || payload?.error || payload?.code || "Unknown error",
  ).trim();

  const message = [
    "Fragment hamyonida TON yetarli emas.",
    "Balansni to'ldirish kerak.",
    `Order: ${orderCode}`,
    `Mahsulot: ${product}`,
    `Username: ${username}`,
    `Miqdor/Paket: ${amount}`,
    `To'lov turi: ${paymentMethod}`,
    `To'langan summa: ${paidAmount} UZS`,
    `Xabar: ${reason}`,
  ].join("\n");

  const results = await Promise.allSettled(
    adminIds.map((adminId) => sendTelegramText(adminId, message)),
  );

  return results.some((result) => result.status === "fulfilled" && result.value?.ok);
}

function getOrderChargeAmount(order) {
  return getRefundAmount(order);
}

function hasRefundToBalanceMarker(order) {
  return Boolean(order?.fragmentTx?.refundedToBalanceAt);
}

function stripRefundMarkers(fragmentTx) {
  if (!fragmentTx || typeof fragmentTx !== "object" || Array.isArray(fragmentTx)) {
    return null;
  }

  const next = { ...fragmentTx };
  delete next.refundedToBalanceAt;
  delete next.refundedToBalanceAmount;
  delete next.refundReason;
  delete next.refundTarget;
  delete next.adminLowBalanceAlertSentAt;
  return Object.keys(next).length ? next : null;
}

async function rechargeRefundedBalanceOrder(order) {
  if (String(order?.paymentMethod || "").trim() !== "balance") {
    return { ok: true };
  }
  if (!hasRefundToBalanceMarker(order)) {
    return { ok: true };
  }

  const chargeAmount = getOrderChargeAmount(order);
  if (!order?.tgUserId || chargeAmount <= 0) {
    return { ok: false, error: "Balansni qayta yechish uchun ma'lumot yetarli emas" };
  }

  const refundMarker = String(order?.fragmentTx?.refundedToBalanceAt || "");
  const chargeResult = await applyBalanceDeltaOnce({
    tgUserId: order.tgUserId,
    operationKey: `order-refund-recharge:${String(order._id)}:${refundMarker}`,
    amount: -chargeAmount,
  });

  if (!chargeResult.ok) {
    return { ok: false, error: "Balans yetarli emas" };
  }

  const cleanedFragmentTx = stripRefundMarkers(order.fragmentTx);
  await Order.findByIdAndUpdate(order._id, {
    fragmentTx: cleanedFragmentTx,
  });
  order.fragmentTx = cleanedFragmentTx;

  emitUserUpdate(order.tgUserId, {
    type: "order_created",
    refreshOrders: true,
    refreshBalance: true,
    orderId: order._id,
    status: order.status,
    product: order.product,
  });

  return { ok: true };
}

function buildFragmentTransaction({
  productType,
  recipient,
  amount,
  purchase,
}) {
  return {
    provider: "fragment-api.uz",
    providerVersion: "v1",
    productType,
    recipient,
    amount,
    requestedAt: new Date(),
    purchase: purchase?.raw || null,
    result: purchase?.result || null,
  };
}

async function buyStars(recipient, amount, options = {}) {
  const purchase = await buyStarsFromFragment(recipient, amount, options);
  return {
    fragment: buildFragmentTransaction({
      productType: "stars",
      recipient,
      amount,
      purchase,
    }),
  };
}

async function buyPremium(recipient, months, options = {}) {
  const purchase = await buyPremiumFromFragment(recipient, months, options);
  return {
    fragment: buildFragmentTransaction({
      productType: "premium",
      recipient,
      amount: months,
      purchase,
    }),
  };
}

async function markFulfillmentSuccess(order, result) {
  const completedOrder = await Order.findOneAndUpdate(
    { _id: order._id, fulfillmentStatus: "processing" },
    {
      $set: {
        status: "completed",
        fulfillmentStatus: "success",
        completionMode: "auto",
        fulfilledAt: new Date(),
        fragmentTx: result.fragment || result || null,
        fulfillmentError: "",
      },
    },
    { new: true },
  ).lean();
  if (!completedOrder) {
    return {
      ok: false,
      needsReview: true,
      error: "fulfillment_state_finalize_failed",
    };
  }

  await sendOrderArchive(completedOrder);
  if (completedOrder.tgUserId) {
    emitUserUpdate(completedOrder.tgUserId, {
      type: "order_fulfilled",
      refreshOrders: true,
      orderId: completedOrder._id,
      status: completedOrder.status,
      fulfillmentStatus: "success",
      product: completedOrder.product,
    });
  }

  try {
    await awardReferralCommissionForOrder(completedOrder);
  } catch (error) {
    console.error(
      "Referral commission apply error:",
      completedOrder._id?.toString?.() || completedOrder._id,
      error.message,
    );
  }

  return { ok: true, result };
}
async function markFulfillmentFailure(order, error) {
  const errorMessage = error.message || "Auto buy xatolik";
  const payload = getFragmentErrorPayload(error);
  const ambiguousFailure = isAmbiguousExternalError(error);
  const shouldNotifyAdmins =
    isFragmentLowBalanceError(payload, errorMessage) &&
    !order?.fragmentTx?.adminLowBalanceAlertSentAt;
  let adminAlertSentAt = null;
  let refundSentAt = null;
  let refundTarget = "";
  let nextStatus = order?.status;
  let nextFulfillmentStatus = "failed";
  let nextErrorMessage = errorMessage;

  if (shouldNotifyAdmins) {
    const sent = await notifyAdminsAboutFragmentLowBalance(order, payload);
    if (sent) {
      adminAlertSentAt = new Date();
    }
  }

  const isLowBalanceError =
    !ambiguousFailure && isFragmentLowBalanceError(payload, errorMessage);
  const alreadyRefunded = hasRefundToBalanceMarker(order);

  if (isLowBalanceError && !alreadyRefunded) {
    const refundResult = await refundToBalance(order);
    if (refundResult?.ok) {
      refundSentAt = new Date();
      refundTarget = "webapp_balance";

      if (String(order?.paymentMethod || "").trim() === "balance") {
        nextErrorMessage =
          "Texnik sababga ko'ra buyurtma vaqtincha bajarilmadi. Mablag'ingiz balansda saqlanib turibdi, keyinroq qayta urinib ko'ring.";
      } else {
        nextStatus = "cancelled";
        nextFulfillmentStatus = "skipped";
        nextErrorMessage =
          "Texnik sababga ko'ra to'lovingiz webapp balansiga qaytarildi.";
      }
    }
  }

  const fragmentTx =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? {
          ...payload,
          ...(adminAlertSentAt
            ? { adminLowBalanceAlertSentAt: adminAlertSentAt }
            : {}),
          ...(refundSentAt
            ? {
                refundedToBalanceAt: refundSentAt,
                refundedToBalanceAmount: getOrderChargeAmount(order),
                refundReason: "fragment_low_balance",
                refundTarget,
              }
            : {}),
        }
      : payload;

  if (ambiguousFailure) {
    nextFulfillmentStatus = "needs_review";
    nextErrorMessage =
      "Provayder javobi noaniq. Takroriy xaridni oldini olish uchun admin tekshiruvi talab qilinadi.";
  }

  await Order.findOneAndUpdate(
    { _id: order._id, fulfillmentStatus: "processing" },
    {
      $set: {
        status: nextStatus,
        fulfillmentStatus: nextFulfillmentStatus,
        fulfillmentError: nextErrorMessage,
        fragmentTx,
      },
    },
  );
  if (order.tgUserId) {
    emitUserUpdate(order.tgUserId, {
      type:
        nextStatus === "cancelled"
          ? "order_cancelled_refund"
          : "order_fulfillment_failed",
      refreshBalance: Boolean(refundSentAt),
      refreshOrders: true,
      orderId: order._id,
      status: nextStatus,
      fulfillmentStatus: nextFulfillmentStatus,
      product: order.product,
    });
  }

  return { ok: false, error: nextErrorMessage };
}

async function autoFulfillOrder(orderOrId) {
  const orderId =
    typeof orderOrId === "object" && orderOrId?._id
      ? orderOrId._id
      : orderOrId;
  const order = await Order.findOneAndUpdate(
    {
      _id: orderId,
      status: "paid_auto_processed",
      product: { $in: ["star", "premium"] },
      $or: [
        { fulfillmentStatus: { $in: ["pending", "failed", "skipped"] } },
        { fulfillmentStatus: { $exists: false } },
      ],
    },
    {
      $set: {
        fulfillmentStatus: "processing",
        fulfillmentStartedAt: new Date(),
        fulfillmentError: "",
      },
    },
    { new: true },
  ).lean();

  if (!order) {
    const latest = await Order.findById(orderId).lean();
    if (!latest) return { skipped: true, reason: "order_not_found" };
    if (latest.status !== "paid_auto_processed") {
      return { skipped: true, reason: "not_paid" };
    }
    if (!["star", "premium"].includes(latest.product)) {
      return { skipped: true, reason: "unsupported_product" };
    }
    if (latest.fulfillmentStatus === "success") {
      return { skipped: true, reason: "already_fulfilled" };
    }
    if (latest.fulfillmentStatus === "needs_review") {
      return { skipped: true, reason: "manual_review_required" };
    }
    return { skipped: true, reason: "already_processing" };
  }

  const rechargeResult = await rechargeRefundedBalanceOrder(order);
  if (!rechargeResult?.ok) {
    return markFulfillmentFailure(order, new Error(rechargeResult.error || "Balans yetarli emas"));
  }

  const plan = await Plan.findOne({
    category: order.product,
    code: order.planCode,
  }).lean();
  if (!plan && order.product === "star" && order.planCode === "custom") {
    // custom amount for stars
    const amount = Number(order.customAmount || 0);
    if (!amount) {
      await Order.findByIdAndUpdate(order._id, {
        fulfillmentStatus: "failed",
        fulfillmentError: "Custom star miqdori topilmadi",
      });
      return { ok: false, error: "Custom star miqdori topilmadi" };
    }

    const recipient = String(order.username || "")
      .replace(/^@/, "")
      .trim();

    try {
      const result = await buyStars(recipient, amount, {
        idempotencyKey: `yamaha-order-${String(order._id)}`,
      });
      return markFulfillmentSuccess(order, result);
    } catch (error) {
      return markFulfillmentFailure(order, error);
    }
  }

  if (!plan) {
    await Order.findByIdAndUpdate(order._id, {
      fulfillmentStatus: "failed",
      fulfillmentError: "Plan topilmadi",
    });
    return { ok: false, error: "Plan topilmadi" };
  }

  const recipient = String(order.username || "")
    .replace(/^@/, "")
    .trim();

  try {
    let result;
    if (order.product === "star") {
      result = await buyStars(recipient, plan.amount, {
        idempotencyKey: `yamaha-order-${String(order._id)}`,
      });
    } else {
      result = await buyPremium(recipient, plan.amount, {
        idempotencyKey: `yamaha-order-${String(order._id)}`,
      });
    }

    return markFulfillmentSuccess(order, result);
  } catch (error) {
    return markFulfillmentFailure(order, error);
  }
}

module.exports = {
  buyStars,
  buyPremium,
  autoFulfillOrder,
};
