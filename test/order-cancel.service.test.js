const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getRefundAmount,
} = require("../services/order-refund-amount.service");
const {
  getSuppliedServerManagedFields,
} = require("../services/order-request-security.service");
const {
  isFragmentPayloadUnavailableError,
  isRefundableFragmentFailure,
} = require("../services/avtoBuy.service");

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

test("Fragment 502 payload errors are refundable", () => {
  const payload = {
    ok: false,
    message: "Stars buy payload olinmadi.",
    code: "FRAGMENT_ERROR",
  };
  const error = new Error("Request failed with status code 502");
  error.response = { status: 502 };

  assert.equal(isFragmentPayloadUnavailableError(payload, error), true);
  assert.equal(isRefundableFragmentFailure(payload, error), true);
});

test("unrecognized Fragment 502 errors are not auto-refunded", () => {
  const payload = {
    ok: false,
    message: "Temporary upstream error",
    code: "FRAGMENT_ERROR",
  };
  const error = new Error("Request failed with status code 502");
  error.response = { status: 502 };

  assert.equal(isFragmentPayloadUnavailableError(payload, error), false);
  assert.equal(isRefundableFragmentFailure(payload, error), false);
});
