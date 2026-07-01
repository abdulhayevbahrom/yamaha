function toPlainObject(value) {
  if (!value) return {};
  if (typeof value.toObject === "function") {
    return value.toObject({ depopulate: true, versionKey: false });
  }
  return { ...value };
}

function sanitizePaymentCardSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return null;
  return {
    type: String(snapshot.type || ""),
    label: String(snapshot.label || ""),
    cardNumber: String(snapshot.cardNumber || ""),
    cardHolder: String(snapshot.cardHolder || ""),
    notes: String(snapshot.notes || ""),
    isFallback: Boolean(snapshot.isFallback),
  };
}

function sanitizeFragmentTx(fragmentTx) {
  if (!fragmentTx || typeof fragmentTx !== "object") return null;
  return {
    refundedToBalanceAt: fragmentTx.refundedToBalanceAt || null,
    refundReason: String(fragmentTx.refundReason || ""),
    refundTarget: String(fragmentTx.refundTarget || ""),
  };
}

function sanitizePublicOrder(order) {
  if (!order) return null;
  const plain = toPlainObject(order);

  return {
    _id: String(plain._id || ""),
    orderId: Number(plain.orderId || 0),
    product: String(plain.product || ""),
    planCode: String(plain.planCode || ""),
    customAmount: Number(plain.customAmount || 0),
    username: String(plain.username || ""),
    playerId: String(plain.playerId || ""),
    zoneId: String(plain.zoneId || ""),
    profileName: String(plain.profileName || ""),
    paymentCardSnapshot: sanitizePaymentCardSnapshot(plain.paymentCardSnapshot),
    paymentMethod: String(plain.paymentMethod || ""),
    sellCardNumber: String(plain.sellCardNumber || ""),
    sellPricePerStar: Number(plain.sellPricePerStar || 0),
    starsAmount: Number(plain.starsAmount || 0),
    paymentGrossAmount: Number(plain.paymentGrossAmount || 0),
    balanceCreditAmount: Number(plain.balanceCreditAmount || 0),
    paymentFeePercent: Number(plain.paymentFeePercent || 0),
    expectedAmount: Number(plain.expectedAmount || 0),
    paymentMatchAmount: Number(plain.paymentMatchAmount || 0),
    paymentAlternateMatchAmount: Number(plain.paymentAlternateMatchAmount || 0),
    paidAmount: Number(plain.paidAmount || 0),
    paidAt: plain.paidAt || null,
    status: String(plain.status || ""),
    fulfillmentStatus: String(plain.fulfillmentStatus || ""),
    completionMode: String(plain.completionMode || ""),
    fulfillmentError: String(plain.fulfillmentError || ""),
    fragmentTx: sanitizeFragmentTx(plain.fragmentTx),
    fulfillmentStartedAt: plain.fulfillmentStartedAt || null,
    fulfilledAt: plain.fulfilledAt || null,
    expiresAt: plain.expiresAt || null,
    createdAt: plain.createdAt || null,
    updatedAt: plain.updatedAt || null,
  };
}

module.exports = {
  sanitizePublicOrder,
  sanitizePaymentCardSnapshot,
};
