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
  isFragmentServerError,
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

test("generic Fragment 502 server errors are auto-refunded", () => {
  const payload = {
    ok: false,
    message: "Temporary upstream error",
    code: "FRAGMENT_ERROR",
  };
  const error = new Error("Request failed with status code 502");
  error.response = { status: 502 };

  assert.equal(isFragmentPayloadUnavailableError(payload, error), false);
  assert.equal(isFragmentServerError(payload, error), true);
  assert.equal(isRefundableFragmentFailure(payload, error), true);
});

test("Fragment 4xx validation errors are not auto-refunded as server errors", () => {
  const payload = {
    ok: false,
    message: "Invalid recipient",
    code: "FRAGMENT_ERROR",
  };
  const error = new Error("Request failed with status code 400");
  error.response = { status: 400 };

  assert.equal(isFragmentServerError(payload, error), false);
  assert.equal(isRefundableFragmentFailure(payload, error), false);
});
