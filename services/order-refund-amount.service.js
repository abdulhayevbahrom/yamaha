function toPositiveAmount(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

function getRefundAmount(order) {
  const expectedAmount = toPositiveAmount(order?.expectedAmount);
  if (!expectedAmount) return 0;

  if (String(order?.paymentMethod || "").trim() === "balance") {
    return expectedAmount;
  }

  if (!order?.paidAt) return 0;

  const paidAmount = toPositiveAmount(order?.paidAmount);
  if (!paidAmount) return 0;
  return Math.min(paidAmount, expectedAmount);
}

module.exports = {
  getRefundAmount,
};
