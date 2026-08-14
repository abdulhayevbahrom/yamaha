const Order = require("../model/order.model");
const Plan = require("../model/plan.model");
const { createRedeemOrder } = require("./gw-api.service");
const { refundToBalance } = require("./order-cancel.service");
const { sendOrderArchive } = require("./order-archive.service");
const { emitUserUpdate } = require("../socket");

const enabled = (value) => ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
const isGwPubgRedeemEnabled = () => enabled(process.env.GW_PUBG_REDEEM_ENABLED ?? process.env.GW_PUBG_AUTOBUY_ENABLED);

function extractRedeemCodes(payload) {
  const source = payload?.data || payload?.order || payload || {};
  const candidates = [source.codes, source.keys, source.gameKeys, source.redeemCodes, source.code, source.key, source.pin];
  return [...new Set(candidates.flatMap((value) => Array.isArray(value) ? value : [value])
    .map((value) => typeof value === "object" ? value?.code || value?.key || value?.pin : value)
    .map((value) => String(value || "").trim()).filter(Boolean))];
}

function isPlanReady(plan) {
  const syncedAt = new Date(plan?.providerSyncedAt || 0).getTime();
  const maxAge = Math.max(60_000, Number(process.env.GW_PUBG_CATALOG_MAX_AGE_MS || 30 * 60_000));
  return Boolean(plan?.provider === "gw" && plan?.providerProductId && plan?.providerAvailable && syncedAt && Date.now() - syncedAt <= maxAge);
}

async function autoFulfillGwPubgRedeem(orderOrId) {
  if (!isGwPubgRedeemEnabled()) return { skipped: true, reason: "disabled" };
  const order = await Order.findOneAndUpdate(
    { _id: orderOrId?._id || orderOrId, product: "redeem", status: "paid_auto_processed", fulfillmentStatus: { $in: ["pending", "failed", "skipped"] } },
    { $set: { fulfillmentStatus: "processing", fulfillmentStartedAt: new Date(), fulfillmentError: "" } },
    { new: true },
  );
  if (!order) return { skipped: true, reason: "not_claimed" };
  const plan = await Plan.findOne({ category: "redeem", code: order.planCode }).lean();
  if (!isPlanReady(plan)) {
    await Order.findByIdAndUpdate(order._id, { $set: { fulfillmentStatus: "needs_review", fulfillmentError: "GW redeem plan mapping unavailable" } });
    return { ok: false, needsReview: true };
  }
  const trxid = `YMH-REDEEM-${order.orderId}`;
  try {
    const payload = await createRedeemOrder({ pid: plan.providerProductId, trxid, idempotencyKey: trxid });
    const codes = extractRedeemCodes(payload);
    if (!codes.length) throw new Error("GW javobida redeem kod topilmadi");
    const updated = await Order.findByIdAndUpdate(order._id, { $set: {
      status: "completed", fulfillmentStatus: "success", completionMode: "auto", fulfilledAt: new Date(), fulfillmentError: "",
      fragmentTx: { provider: "gw", productType: "pubg_redeem", providerProductId: plan.providerProductId,
        providerOrderId: String(payload?.orderId || payload?.data?.orderId || payload?.id || ""), redeemCodes: codes, completedAt: new Date() },
    } }, { new: true });
    await sendOrderArchive(updated, { statusLabel: "Redeem kod berildi" });
    emitUserUpdate(updated.tgUserId, { type: "redeem_code_ready", refreshOrders: true, orderId: updated._id, status: updated.status, product: updated.product });
    return { ok: true, order: updated };
  } catch (error) {
    const refund = await refundToBalance(order);
    await Order.findByIdAndUpdate(order._id, { $set: {
      status: refund.ok ? "cancelled" : order.status,
      fulfillmentStatus: refund.ok ? "skipped" : "needs_review",
      fulfillmentError: String(error?.response?.data?.error || error?.message || "GW redeem order failed").slice(0, 500),
    } });
    return { ok: false, refunded: refund.ok, needsReview: !refund.ok };
  }
}

module.exports = { isGwPubgRedeemEnabled, isPlanReady, extractRedeemCodes, autoFulfillGwPubgRedeem };
