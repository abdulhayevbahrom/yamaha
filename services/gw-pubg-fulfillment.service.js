const Order = require("../model/order.model");
const Plan = require("../model/plan.model");
const { createOrder, getOrder } = require("./gw-api.service");
const { refundToBalance } = require("./order-cancel.service");
const { isAmbiguousExternalError } = require("./external-operation.service");
const { sendOrderArchive } = require("./order-archive.service");
const { awardReferralCommissionForOrder } = require("./referral.service");
const { emitUserUpdate } = require("../socket");

const pollTimers = new Map();
const enabled = (value) => ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
const isGwPubgAutobuyEnabled = () => enabled(process.env.GW_PUBG_AUTOBUY_ENABLED);
const normalizeStatus = (payload) => String(payload?.status || payload?.order?.status || "").trim().toLowerCase();
const providerOrderId = (payload) => String(payload?.orderId || payload?.id || payload?.order?.orderId || "").trim();
const providerError = (payload, fallback = "") => String(payload?.error || payload?.code || payload?.message || fallback || "GW order failed").trim();

function getCatalogMaxAgeMs() {
  return Math.max(
    60_000,
    Number(process.env.GW_PUBG_CATALOG_MAX_AGE_MS || 30 * 60_000),
  );
}

function isPlanReady(plan) {
  const syncedAt = new Date(plan?.providerSyncedAt || 0).getTime();
  return Boolean(
    plan &&
      plan.provider === "gw" &&
      plan.providerProductId &&
      plan.providerAvailable &&
      syncedAt > 0 &&
      Date.now() - syncedAt <= getCatalogMaxAgeMs(),
  );
}

function isDefinitiveSubmitFailure(error, payload) {
  const status = Number(error?.response?.status || 0);
  const code = String(payload?.code || payload?.error || "").trim().toUpperCase();
  if ([400, 401, 403].includes(status)) return true;
  if (
    status === 503 &&
    ["MAINTENANCE", "API_ORDER_DISABLED"].includes(code)
  ) {
    return true;
  }
  return false;
}

function providerTx(order, payload, extra = {}) {
  const previous =
    order?.fragmentTx && typeof order.fragmentTx === "object"
      ? order.fragmentTx
      : {};
  return {
    provider: "gw",
    providerVersion: "v1",
    productType: "pubg",
    providerOrderId: providerOrderId(payload) || previous.providerOrderId || "",
    providerStatus: normalizeStatus(payload),
    trxid: `YMH-PUBG-${String(order.orderId)}`,
    requestedAt: order?.fragmentTx?.requestedAt || new Date(),
    providerProductId: previous.providerProductId || "",
    providerPriceUsd: Number(previous.providerPriceUsd || 0),
    customerPriceUzs: Number(previous.customerPriceUzs || order?.expectedAmount || 0),
    updatedAt: new Date(),
    response: payload || null,
    ...extra,
  };
}

async function complete(order, payload) {
  const updated = await Order.findOneAndUpdate(
    { _id: order._id, fulfillmentStatus: "processing" },
    { $set: {
      status: "completed", fulfillmentStatus: "success", completionMode: "auto",
      fulfillmentError: "", fulfilledAt: new Date(),
      fragmentTx: providerTx(order, payload, { completedAt: new Date() }),
    } },
    { new: true },
  );
  if (!updated) return { ok: false, reason: "state_changed" };
  await sendOrderArchive(updated, { statusLabel: "Avtomatik bajarildi" });
  emitUserUpdate(updated.tgUserId, {
    type: "game_order_confirmed", refreshOrders: true, orderId: updated._id,
    status: updated.status, product: updated.product,
  });
  await awardReferralCommissionForOrder(updated).catch((error) => {
    console.error("GW PUBG referral error:", updated._id, error.message);
  });
  return { ok: true, order: updated };
}

async function cancelAndRefund(order, payload) {
  if (order?.paymentMethod === "uzumbank") {
    const updated = await Order.findByIdAndUpdate(order._id, { $set: {
      status: "cancelled", fulfillmentStatus: "skipped",
      fulfillmentError: providerError(payload), fulfilledAt: new Date(),
      fragmentTx: providerTx(order, payload, { cancelledAt: new Date() }),
    } }, { new: true });
    emitUserUpdate(updated.tgUserId, {
      type: "game_order_cancelled", refreshOrders: true,
      orderId: updated._id, status: updated.status, product: updated.product,
    });
    return { ok: false, cancelled: true, order: updated };
  }

  const refund = await refundToBalance(order);
  if (!refund.ok) {
    await Order.findByIdAndUpdate(order._id, { $set: {
      fulfillmentStatus: "needs_review",
      fulfillmentError: `GW cancelled; refund failed: ${refund.reason}`,
      fragmentTx: providerTx(order, payload),
    } });
    return { ok: false, needsReview: true, reason: refund.reason };
  }
  const updated = await Order.findByIdAndUpdate(order._id, { $set: {
    status: "cancelled", fulfillmentStatus: "skipped",
    fulfillmentError: providerError(payload), fulfilledAt: new Date(),
    fragmentTx: providerTx(order, payload, {
      refundedToBalanceAt: new Date(), refundedToBalanceAmount: refund.refundedAmount,
    }),
  } }, { new: true });
  emitUserUpdate(updated.tgUserId, {
    type: "game_order_cancelled_refund", refreshBalance: true, refreshOrders: true,
    orderId: updated._id, status: updated.status, product: updated.product,
  });
  return { ok: false, cancelled: true, order: updated };
}

function schedulePoll(orderId) {
  const key = String(orderId);
  if (pollTimers.has(key)) return;
  const delay = Math.max(3000, Number(process.env.GW_PUBG_POLL_INTERVAL_MS || 5000));
  const timer = setTimeout(() => {
    pollTimers.delete(key);
    pollGwPubgOrder(key).catch((error) => console.error("GW PUBG poll error:", key, error.message));
  }, delay);
  timer.unref?.();
  pollTimers.set(key, timer);
}

function scheduleSubmitRecovery(orderId) {
  const key = String(orderId);
  if (pollTimers.has(key)) return;
  const delay = Math.max(3_000, Number(process.env.GW_PUBG_POLL_INTERVAL_MS || 5_000));
  const timer = setTimeout(() => {
    pollTimers.delete(key);
    recoverGwPubgSubmit(key).catch((error) =>
      console.error("GW PUBG submit recovery error:", key, error.message),
    );
  }, delay);
  timer.unref?.();
  pollTimers.set(key, timer);
}

async function handlePayload(order, payload) {
  const status = normalizeStatus(payload);
  if (status === "completed") return complete(order, payload);
  if (["cancelled", "failed"].includes(status) || payload?.orderCreated === false) {
    return cancelAndRefund(order, payload);
  }
  const attempts = Number(order?.fragmentTx?.pollAttempts || 0) + 1;
  const maxAttempts = Math.max(1, Number(process.env.GW_PUBG_POLL_MAX_ATTEMPTS || 24));
  await Order.findByIdAndUpdate(order._id, { $set: {
    fulfillmentStatus: attempts >= maxAttempts ? "needs_review" : "processing",
    fulfillmentError: attempts >= maxAttempts ? "GW status polling timeout" : "",
    fragmentTx: providerTx(order, payload, { phase: "polling", pollAttempts: attempts }),
  } });
  if (attempts < maxAttempts) schedulePoll(order._id);
  return { ok: false, processing: attempts < maxAttempts, needsReview: attempts >= maxAttempts };
}

async function pollGwPubgOrder(orderId) {
  if (!isGwPubgAutobuyEnabled()) return { skipped: true, reason: "disabled" };
  const order = await Order.findById(orderId);
  if (!order || order.fulfillmentStatus !== "processing") return { skipped: true, reason: "not_processing" };
  const id = String(order?.fragmentTx?.providerOrderId || "").trim();
  if (!id) {
    await Order.findByIdAndUpdate(order._id, { $set: { fulfillmentStatus: "needs_review", fulfillmentError: "GW order id missing" } });
    return { ok: false, needsReview: true };
  }
  try {
    return handlePayload(order, await getOrder(id));
  } catch (error) {
    if (isAmbiguousExternalError(error)) {
      const attempts = Number(order?.fragmentTx?.pollAttempts || 0) + 1;
      const maxAttempts = Math.max(
        1,
        Number(process.env.GW_PUBG_POLL_MAX_ATTEMPTS || 24),
      );
      const needsReview = attempts >= maxAttempts;
      await Order.findByIdAndUpdate(order._id, { $set: {
        fulfillmentStatus: needsReview ? "needs_review" : "processing",
        fulfillmentError: needsReview ? "GW status result unknown" : "",
        fragmentTx: providerTx(order, null, {
          phase: "polling",
          pollAttempts: attempts,
          lastPollError: String(error.message || "network error").slice(0, 300),
        }),
      } });
      if (!needsReview) schedulePoll(order._id);
      return { ok: false, processing: !needsReview, needsReview };
    }
    await Order.findByIdAndUpdate(order._id, { $set: { fulfillmentStatus: "needs_review", fulfillmentError: error.message } });
    return { ok: false, needsReview: true };
  }
}

async function recoverGwPubgSubmit(orderId) {
  if (!isGwPubgAutobuyEnabled()) return { skipped: true, reason: "disabled" };
  const order = await Order.findById(orderId);
  if (
    !order ||
    order.fulfillmentStatus !== "processing" ||
    !["submit_started", "submit_unknown"].includes(order?.fragmentTx?.phase)
  ) {
    return { skipped: true, reason: "not_recoverable" };
  }

  const attempts = Number(order?.fragmentTx?.submitRecoveryAttempts || 0) + 1;
  const maxAttempts = Math.max(
    1,
    Number(process.env.GW_PUBG_SUBMIT_RECOVERY_MAX_ATTEMPTS || 6),
  );
  const plan = await Plan.findOne({ category: "uc", code: order.planCode }).lean();
  if (!plan?.providerProductId) {
    await Order.findByIdAndUpdate(order._id, { $set: {
      fulfillmentStatus: "needs_review",
      fulfillmentError: "GW submit recovery plan mapping unavailable",
    } });
    return { ok: false, needsReview: true };
  }

  const trxid = `YMH-PUBG-${String(order.orderId)}`;
  try {
    return handlePayload(order, await createOrder({
      pid: plan.providerProductId,
      userId: String(order.username || "").trim(),
      trxid,
      idempotencyKey: trxid,
    }));
  } catch (error) {
    const payload = error?.response?.data;
    if (payload && isDefinitiveSubmitFailure(error, payload)) {
      return cancelAndRefund(order, payload);
    }
    const needsReview = attempts >= maxAttempts;
    await Order.findByIdAndUpdate(order._id, { $set: {
      fulfillmentStatus: needsReview ? "needs_review" : "processing",
      fulfillmentError: needsReview ? "GW submit result unknown" : "",
      fragmentTx: providerTx(order, payload, {
        phase: "submit_unknown",
        ambiguous: true,
        submitRecoveryAttempts: attempts,
      }),
    } });
    if (!needsReview) scheduleSubmitRecovery(order._id);
    return { ok: false, needsReview, processing: !needsReview };
  }
}

async function autoFulfillGwPubg(orderOrId) {
  if (!isGwPubgAutobuyEnabled()) return { skipped: true, reason: "disabled" };
  const claimed = await Order.findOneAndUpdate(
    { _id: orderOrId?._id || orderOrId, product: "uc", status: "paid_auto_processed", fulfillmentStatus: { $in: ["pending", "failed", "skipped"] } },
    { $set: { fulfillmentStatus: "processing", fulfillmentStartedAt: new Date(), fulfillmentError: "" } },
    { new: true },
  );
  if (!claimed) return { skipped: true, reason: "not_claimed" };
  const plan = await Plan.findOne({ category: "uc", code: claimed.planCode }).lean();
  if (!isPlanReady(plan)) {
    await Order.findByIdAndUpdate(claimed._id, { $set: { fulfillmentStatus: "needs_review", fulfillmentError: "GW plan mapping unavailable" } });
    return { ok: false, needsReview: true };
  }
  const trxid = `YMH-PUBG-${String(claimed.orderId)}`;
  claimed.fragmentTx = providerTx(claimed, null, {
    phase: "submit_started",
    providerProductId: plan.providerProductId,
    providerPriceUsd: Number(plan.providerPriceUsd || 0),
    customerPriceUzs: Number(claimed.expectedAmount || 0),
    submitRecoveryAttempts: 0,
  });
  await Order.findByIdAndUpdate(claimed._id, {
    $set: { fragmentTx: claimed.fragmentTx },
  });
  try {
    return handlePayload(claimed, await createOrder({
      pid: plan.providerProductId, userId: String(claimed.username || "").trim(),
      trxid, idempotencyKey: trxid,
    }));
  } catch (error) {
    const payload = error?.response?.data;
    if (payload && isDefinitiveSubmitFailure(error, payload)) {
      return cancelAndRefund(claimed, payload);
    }
    await Order.findByIdAndUpdate(claimed._id, { $set: {
      fulfillmentStatus: "processing", fulfillmentError: "",
      fragmentTx: providerTx(claimed, payload, {
        phase: "submit_unknown",
        ambiguous: true,
        submitRecoveryAttempts: 0,
      }),
    } });
    scheduleSubmitRecovery(claimed._id);
    return { ok: false, processing: true };
  }
}

async function resumeGwPubgPolling() {
  if (!isGwPubgAutobuyEnabled()) return 0;
  const rows = await Order.find({ product: "uc", fulfillmentStatus: "processing", "fragmentTx.provider": "gw" }).select({ _id: 1 }).lean();
  const fullRows = await Order.find({
    _id: { $in: rows.map((row) => row._id) },
  }).select({ _id: 1, fragmentTx: 1 }).lean();
  fullRows.forEach((row) => {
    if (["submit_started", "submit_unknown"].includes(row?.fragmentTx?.phase)) {
      scheduleSubmitRecovery(row._id);
    }
    else schedulePoll(row._id);
  });
  return rows.length;
}

module.exports = {
  isGwPubgAutobuyEnabled,
  autoFulfillGwPubg,
  pollGwPubgOrder,
  recoverGwPubgSubmit,
  resumeGwPubgPolling,
  normalizeStatus,
  isPlanReady,
};
