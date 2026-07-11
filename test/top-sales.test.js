const test = require("node:test");
const assert = require("node:assert/strict");

const { getTopSalePurchaseAmount } = require("../controller/public.controller");

test("top sales uses the actual paid purchase amount", () => {
  assert.equal(
    getTopSalePurchaseAmount({ expectedAmount: 100_000, paidAmount: 60_000 }),
    60_000,
  );
});

test("top sales supports legacy completed purchases without paidAmount", () => {
  assert.equal(getTopSalePurchaseAmount({ expectedAmount: 45_000 }), 45_000);
});
