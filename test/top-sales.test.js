const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getTopSalePurchaseAmount,
  getTopSalesOrderFilter,
} = require("../controller/public.controller");

test("top sales uses the actual paid purchase amount", () => {
  assert.equal(
    getTopSalePurchaseAmount({ expectedAmount: 100_000, paidAmount: 60_000 }),
    60_000,
  );
});

test("top sales supports legacy completed purchases without paidAmount", () => {
  assert.equal(getTopSalePurchaseAmount({ expectedAmount: 45_000 }), 45_000);
});

test("top sales only queries successfully completed purchases", () => {
  const startDate = new Date("2026-08-01T00:00:00.000Z");
  const filter = getTopSalesOrderFilter(startDate);

  assert.equal(filter.status, "completed");
  assert.equal(filter.fulfillmentStatus, "success");
  assert.deepEqual(filter.product.$in, ["star", "premium", "uc", "freefire", "mlbb", "hok", "roblox", "bloodstrike", "deltaforce"]);
  assert.equal(filter.product.$ne, "balance");
  assert.deepEqual(filter.$or, [
    { paidAt: { $gte: startDate } },
    { createdAt: { $gte: startDate } },
  ]);
});
