const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getRefundAmount,
} = require("../services/order-refund-amount.service");
const {
  getSuppliedServerManagedFields,
} = require("../services/order-request-security.service");

test("client financial and lifecycle fields are rejected", () => {
  assert.deepEqual(
    getSuppliedServerManagedFields({
      product: "star",
      customAmount: 5000,
      paymentMethod: "card",
      paidAmount: 10_900_000,
      status: "paid_auto_processed",
    }),
    ["paidAmount", "status"],
  );
});

test("balance payment refunds only the server-calculated order price", () => {
  assert.equal(
    getRefundAmount({
      paymentMethod: "balance",
      expectedAmount: 1_100_000,
      paidAmount: 10_900_000,
      paidAt: new Date(),
    }),
    1_100_000,
  );
});

test("unverified external payment cannot be refunded", () => {
  assert.equal(
    getRefundAmount({
      paymentMethod: "card",
      expectedAmount: 1_100_000,
      paidAmount: 10_900_000,
      paidAt: null,
    }),
    0,
  );
});

test("verified external refund cannot exceed the expected order price", () => {
  assert.equal(
    getRefundAmount({
      paymentMethod: "card",
      expectedAmount: 1_100_000,
      paidAmount: 10_900_000,
      paidAt: new Date(),
    }),
    1_100_000,
  );
});
