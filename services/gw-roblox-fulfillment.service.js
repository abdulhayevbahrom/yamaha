const Order = require("../model/order.model");
const Plan = require("../model/plan.model");
const { createPidOrder, getOrder } = require("./gw-api.service");
const { refundToBalance } = require("./order-cancel.service");
const { isAmbiguousExternalError } = require("./external-operation.service");
const { sendOrderArchive } = require("./order-archive.service");
const { awardReferralCommissionForOrder } = require("./referral.service");
const { emitUserUpdate } = require("../socket");

const timers = new Map();
const enabled = (value) => ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
const isGwRobloxAutobuyEnabled = () => enabled(process.env.GW_ROBLOX_AUTOBUY_ENABLED);
const statusOf = (payload) => String(payload?.status || payload?.order?.status || "").trim().toLowerCase();
const externalId = (payload) => String(payload?.orderId || payload?.id || payload?.order?.orderId || "").trim();
const errorOf = (payload, fallback = "") => String(payload?.error || payload?.code || payload?.message || fallback || "GW order failed").trim();
const maxAge = () => Math.max(60_000, Number(process.env.GW_ROBLOX_CATALOG_MAX_AGE_MS || 30 * 60_000));

function isGwRobloxPlanReady(plan) {
  const syncedAt = new Date(plan?.providerSyncedAt || 0).getTime();
  return Boolean(plan?.provider === "gw" && plan?.providerProductId && plan?.providerAvailable && syncedAt && Date.now() - syncedAt <= maxAge());
}

function isDefinitiveSubmitFailure(error, payload) {
  const status = Number(error?.response?.status || 0);
  const code = String(payload?.code || payload?.error || "").trim().toUpperCase();
  if ([400, 401, 403].includes(status)) return true;
  if (status === 503 && ["MAINTENANCE", "API_ORDER_DISABLED"].includes(code)) return true;
  return false;
}

function tx(order, payload, extra = {}) {
  const old = order?.fragmentTx || {};
  return {
    provider: "gw",
    providerVersion: "v1",
    productType: "roblox",
    providerOrderId: externalId(payload) || old.providerOrderId || "",
    providerStatus: statusOf(payload),
    trxid: `YMH-ROBLOX-${order.orderId}`,
    requestedAt: old.requestedAt || new Date(),
    providerProductId: old.providerProductId || "",
    providerPriceUsd: Number(old.providerPriceUsd || 0),
    customerPriceUzs: Number(old.customerPriceUzs || order.expectedAmount || 0),
    updatedAt: new Date(),
    response: payload || null,
    ...extra,
  };
}

async function complete(order, payload) {
  const updated = await Order.findOneAndUpdate(
    { _id: order._id, fulfillmentStatus: "processing" },
    { $set: { status: "completed", fulfillmentStatus: "success", completionMode: "auto", fulfillmentError: "", fulfilledAt: new Date(), fragmentTx: tx(order, payload, { completedAt: new Date() }) } },
    { new: true },
  );
  if (!updated) return { ok: false, reason: "state_changed" };
  await sendOrderArchive(updated, { statusLabel: "Avtomatik bajarildi" });
  emitUserUpdate(updated.tgUserId, { type: "game_order_confirmed", refreshOrders: true, orderId: updated._id, status: updated.status, product: updated.product });
  await awardReferralCommissionForOrder(updated).catch((error) => console.error("GW Roblox referral error:", updated._id, error.message));
  return { ok: true, order: updated };
}

async function cancelAndRefund(order, payload) {
  const refund = await refundToBalance(order);
  if (!refund.ok) {
    await Order.findByIdAndUpdate(order._id, { $set: { fulfillmentStatus: "needs_review", fulfillmentError: `GW cancelled; refund failed: ${refund.reason}`, fragmentTx: tx(order, payload) } });
    return { ok: false, needsReview: true };
  }
  const updated = await Order.findByIdAndUpdate(order._id, { $set: {
    status: "cancelled",
    fulfillmentStatus: "skipped",
    fulfillmentError: errorOf(payload),
    fulfilledAt: new Date(),
    fragmentTx: tx(order, payload, { refundedToBalanceAt: new Date(), refundedToBalanceAmount: refund.refundedAmount }),
  } }, { new: true });
  emitUserUpdate(updated.tgUserId, { type: "game_order_cancelled_refund", refreshBalance: true, refreshOrders: true, orderId: updated._id, status: updated.status, product: updated.product });
  return { ok: false, cancelled: true, order: updated };
}

function schedule(orderId) {
  const key = String(orderId);
  if (timers.has(key)) return;
  const timer = setTimeout(() => {
    timers.delete(key);
    pollGwRobloxOrder(key).catch((error) => console.error("GW Roblox poll error:", key, error.message));
  }, Math.max(3000, Number(process.env.GW_ROBLOX_POLL_INTERVAL_MS || 5000)));
  timer.unref?.();
  timers.set(key, timer);
}

function scheduleSubmitRecovery(orderId) {
  const key = String(orderId);
  if (timers.has(key)) return;
  const timer = setTimeout(() => {
    timers.delete(key);
    recoverGwRobloxSubmit(key).catch((error) => console.error("GW Roblox submit recovery error:", key, error.message));
  }, Math.max(3000, Number(process.env.GW_ROBLOX_POLL_INTERVAL_MS || 5000)));
  timer.unref?.();
  timers.set(key, timer);
}

async function handle(order, payload) {
  const status = statusOf(payload);
  if (["completed", "done", "success"].includes(status)) return complete(order, payload);
  if (["cancelled", "failed"].includes(status) || payload?.orderCreated === false) return cancelAndRefund(order, payload);
  const attempts = Number(order?.fragmentTx?.pollAttempts || 0) + 1;
  const limit = Math.max(1, Number(process.env.GW_ROBLOX_POLL_MAX_ATTEMPTS || 24));
  const needsReview = attempts >= limit;
  await Order.findByIdAndUpdate(order._id, { $set: { fulfillmentStatus: needsReview ? "needs_review" : "processing", fulfillmentError: needsReview ? "GW Roblox status polling timeout" : "", fragmentTx: tx(order, payload, { pollAttempts: attempts }) } });
  if (!needsReview) schedule(order._id);
  return { ok: false, processing: !needsReview, needsReview };
}

async function pollGwRobloxOrder(orderId) {
  if (!isGwRobloxAutobuyEnabled()) return { skipped: true, reason: "disabled" };
  const order = await Order.findById(orderId);
  if (!order || order.fulfillmentStatus !== "processing") return { skipped: true, reason: "not_processing" };
  const id = String(order?.fragmentTx?.providerOrderId || "").trim();
  if (!id) {
    await Order.findByIdAndUpdate(order._id, { $set: { fulfillmentStatus: "needs_review", fulfillmentError: "GW Roblox order id missing" } });
    return { ok: false, needsReview: true };
  }
  try {
    return await handle(order, await getOrder(id));
  } catch (error) {
    if (isAmbiguousExternalError(error)) {
      const attempts = Number(order?.fragmentTx?.pollAttempts || 0) + 1;
      const limit = Math.max(1, Number(process.env.GW_ROBLOX_POLL_MAX_ATTEMPTS || 24));
      const needsReview = attempts >= limit;
      await Order.findByIdAndUpdate(order._id, { $set: {
        fulfillmentStatus: needsReview ? "needs_review" : "processing",
        fulfillmentError: needsReview ? "GW Roblox status result unknown" : "",
        fragmentTx: tx(order, null, {
          phase: "polling",
          pollAttempts: attempts,
          lastPollError: String(error.message || "network error").slice(0, 300),
        }),
      } });
      if (!needsReview) schedule(order._id);
      return { ok: false, processing: !needsReview, needsReview };
    }
    await Order.findByIdAndUpdate(order._id, { $set: { fulfillmentStatus: "needs_review", fulfillmentError: error.message } });
    return { ok: false, needsReview: true };
  }
}

async function recoverGwRobloxSubmit(orderId) {
  if (!isGwRobloxAutobuyEnabled()) return { skipped: true, reason: "disabled" };
  const order = await Order.findById(orderId);
  if (!order || order.fulfillmentStatus !== "processing" || !["submit_started", "submit_unknown"].includes(order?.fragmentTx?.phase)) {
    return { skipped: true, reason: "not_recoverable" };
  }

  const attempts = Number(order?.fragmentTx?.submitRecoveryAttempts || 0) + 1;
  const limit = Math.max(1, Number(process.env.GW_ROBLOX_SUBMIT_RECOVERY_MAX_ATTEMPTS || 6));
  const plan = await Plan.findOne({ category: "roblox", code: order.planCode }).lean();
  if (!plan?.providerProductId) {
    await Order.findByIdAndUpdate(order._id, { $set: { fulfillmentStatus: "needs_review", fulfillmentError: "GW Roblox submit recovery plan mapping unavailable" } });
    return { ok: false, needsReview: true };
  }

  const trxid = `YMH-ROBLOX-${order.orderId}`;
  try {
    return await handle(order, await createPidOrder({
      pid: plan.providerProductId,
      uid: String(order.playerId || order.username || "").trim(),
      userId: String(order.playerId || order.username || "").trim(),
      trxid,
      idempotencyKey: trxid,
    }));
  } catch (error) {
    const payload = error?.response?.data;
    if (payload && isDefinitiveSubmitFailure(error, payload)) return cancelAndRefund(order, payload);
    const needsReview = attempts >= limit;
    await Order.findByIdAndUpdate(order._id, { $set: {
      fulfillmentStatus: needsReview ? "needs_review" : "processing",
      fulfillmentError: needsReview ? "GW Roblox submit result unknown" : "",
      fragmentTx: tx(order, payload, { phase: "submit_unknown", ambiguous: true, submitRecoveryAttempts: attempts }),
    } });
    if (!needsReview) scheduleSubmitRecovery(order._id);
    return { ok: false, processing: !needsReview, needsReview };
  }
}

async function autoFulfillGwRoblox(orderOrId) {
  if (!isGwRobloxAutobuyEnabled()) return { skipped: true, reason: "disabled" };
  const order = await Order.findOneAndUpdate(
    { _id: orderOrId?._id || orderOrId, product: "roblox", status: "paid_auto_processed", fulfillmentStatus: { $in: ["pending", "failed", "skipped"] } },
    { $set: { fulfillmentStatus: "processing", fulfillmentStartedAt: new Date(), fulfillmentError: "" } },
    { new: true },
  );
  if (!order) return { skipped: true, reason: "not_claimed" };
  emitUserUpdate(order.tgUserId, { type: "order_fulfillment_processing", refreshOrders: true, orderId: order._id, status: order.status, fulfillmentStatus: "processing", product: order.product });
  const plan = await Plan.findOne({ category: "roblox", code: order.planCode }).lean();
  if (!isGwRobloxPlanReady(plan)) {
    await Order.findByIdAndUpdate(order._id, { $set: { fulfillmentStatus: "needs_review", fulfillmentError: "GW Roblox plan mapping unavailable" } });
    return { ok: false, needsReview: true };
  }
  const trxid = `YMH-ROBLOX-${order.orderId}`;
  order.fragmentTx = tx(order, null, {
    phase: "submit_started",
    providerProductId: plan.providerProductId,
    providerPriceUsd: Number(plan.providerPriceUsd || 0),
    customerPriceUzs: Number(order.expectedAmount || 0),
    submitRecoveryAttempts: 0,
  });
  await Order.findByIdAndUpdate(order._id, { $set: { fragmentTx: order.fragmentTx } });
  try {
    return await handle(order, await createPidOrder({
      pid: plan.providerProductId,
      uid: String(order.playerId || order.username || "").trim(),
      userId: String(order.playerId || order.username || "").trim(),
      trxid,
      idempotencyKey: trxid,
    }));
  } catch (error) {
    const payload = error?.response?.data;
    if (payload && isDefinitiveSubmitFailure(error, payload)) return cancelAndRefund(order, payload);
    await Order.findByIdAndUpdate(order._id, { $set: {
      fulfillmentStatus: "processing",
      fulfillmentError: "",
      fragmentTx: tx(order, payload, { phase: "submit_unknown", ambiguous: true, submitRecoveryAttempts: 0 }),
    } });
    scheduleSubmitRecovery(order._id);
    return { ok: false, processing: true };
  }
}

async function resumeGwRobloxPolling() {
  if (!isGwRobloxAutobuyEnabled()) return 0;
  const rows = await Order.find({ product: "roblox", fulfillmentStatus: "processing", "fragmentTx.provider": "gw" }).select({ _id: 1, fragmentTx: 1 }).lean();
  rows.forEach((row) => {
    if (["submit_started", "submit_unknown"].includes(row?.fragmentTx?.phase)) {
      scheduleSubmitRecovery(row._id);
    } else {
      schedule(row._id);
    }
  });
  return rows.length;
}

module.exports = {
  autoFulfillGwRoblox,
  pollGwRobloxOrder,
  recoverGwRobloxSubmit,
  resumeGwRobloxPolling,
  isGwRobloxAutobuyEnabled,
  isGwRobloxPlanReady,
};
