const SERVER_MANAGED_ORDER_FIELDS = [
  "orderId",
  "expectedAmount",
  "paidAmount",
  "paidAt",
  "status",
  "fulfillmentStatus",
  "completionMode",
  "fulfillmentError",
  "fulfilledAt",
  "expiresAt",
  "sequence",
  "paymentCardId",
  "paymentCardSnapshot",
  "tgUserId",
  "tgUsername",
];

function getSuppliedServerManagedFields(body) {
  const payload =
    body && typeof body === "object" && !Array.isArray(body) ? body : {};

  return SERVER_MANAGED_ORDER_FIELDS.filter((field) =>
    Object.prototype.hasOwnProperty.call(payload, field),
  );
}

module.exports = {
  getSuppliedServerManagedFields,
};
