const test = require("node:test");
const assert = require("node:assert/strict");

const { buildHistoryFilter } = require("../controller/order.controller");

test("sales history includes only successfully completed products and balance top-ups", () => {
  assert.deepEqual(buildHistoryFilter("sales"), {
    product: { $in: ["star", "premium", "uc", "freefire", "mlbb", "balance"] },
    status: "completed",
    fulfillmentStatus: "success",
  });
});

test("sales history can be filtered by an allowed product", () => {
  assert.deepEqual(buildHistoryFilter("sales", "balance"), {
    product: { $in: ["balance"] },
    status: "completed",
    fulfillmentStatus: "success",
  });
});

test("sales history ignores an unsupported product filter", () => {
  assert.deepEqual(buildHistoryFilter("sales", "nft_withdrawal").product.$in, [
    "star",
    "premium",
    "uc",
    "freefire",
    "mlbb",
    "balance",
  ]);
});
