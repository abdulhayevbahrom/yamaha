const test = require("node:test");
const assert = require("node:assert/strict");
const Order = require("../model/order.model");
const User = require("../model/user.model");
const { getUserOrders } = require("../controller/admin.controller");

const recorder = {
  status(code) { return { json: (body) => ({ code, body }) }; },
};

function mockOrders(t, rows = []) {
  const captured = {};
  t.mock.method(User, "exists", async () => ({ _id: "customer" }));
  t.mock.method(Order, "find", (query) => {
    captured.query = query;
    const cursor = {
      sort() { return this; },
      skip() { return this; },
      limit() { return this; },
      select(fields) { captured.fields = fields; return this; },
      async lean() { return rows; },
    };
    return cursor;
  });
  t.mock.method(Order, "countDocuments", async (query) => {
    captured.countQuery = query;
    return rows.length;
  });
  return captured;
}

function request(status = "all") {
  return { params: { tgUserId: "6721906788" }, query: { status } };
}

test("admin customer orders preserve refund and fulfillment state instead of implying delivery from payment", async (t) => {
  const captured = mockOrders(t, [{
    _id: "refunded-order", orderId: 12411, product: "star", planCode: "100",
    expectedAmount: 22000, paidAmount: 22000, paymentMethod: "balance",
    status: "paid_auto_processed", fulfillmentStatus: "failed", fulfillmentError: "Balance refunded",
    fragmentTx: {
      refundedToBalanceAt: "2026-11-25T15:41:35Z", refundReason: "fragment_server_error",
      refundTarget: "webapp_balance", providerSecret: "never-return-this",
    },
  }]);
  const result = await getUserOrders(request(), recorder);
  assert.equal(result.code, 200);
  const order = result.body.innerData.items[0];
  assert.equal(order.status, "paid_auto_processed");
  assert.equal(order.fulfillmentStatus, "failed");
  assert.equal(order.fragmentTx.refundedToBalanceAt, "2026-11-25T15:41:35Z");
  assert.equal(order.fragmentTx.refundTarget, "webapp_balance");
  assert.doesNotMatch(JSON.stringify(result), /never-return-this/);
  assert.equal(captured.fields.fulfillmentStatus, 1);
  assert.equal(captured.fields["fragmentTx.refundedToBalanceAt"], 1);
  assert.deepEqual(captured.countQuery, captured.query);
});

test("completed customer-order filter requires completion and excludes refunded orders", async (t) => {
  const captured = mockOrders(t);
  await getUserOrders(request("completed"), recorder);
  assert.deepEqual(captured.query, {
    tgUserId: "6721906788",
    $or: [{ status: "completed" }, { fulfillmentStatus: "success" }],
    "fragmentTx.refundedToBalanceAt": null,
  });
  assert.deepEqual(captured.countQuery, captured.query);
});

test("refund and failed filters keep refunded failures out of the unrefunded failure list", async (t) => {
  const captured = mockOrders(t);
  const refunds = await getUserOrders(request("refunded"), recorder);
  assert.equal(refunds.body.innerData.filter, "refunded");
  assert.deepEqual(captured.query, {
    tgUserId: "6721906788",
    "fragmentTx.refundedToBalanceAt": { $exists: true, $ne: null },
  });
  const failed = await getUserOrders(request("failed"), recorder);
  assert.equal(failed.body.innerData.filter, "failed");
  assert.deepEqual(captured.query, {
    tgUserId: "6721906788",
    $or: [{ status: "failed" }, { fulfillmentStatus: "failed" }],
    status: { $nin: ["completed", "cancelled"] },
    fulfillmentStatus: { $ne: "success" },
    "fragmentTx.refundedToBalanceAt": null,
  });
  assert.deepEqual(captured.countQuery, captured.query);
});

test("cancelled filter keeps returned payments in the refund list", async (t) => {
  const captured = mockOrders(t);
  await getUserOrders(request("cancelled"), recorder);
  assert.deepEqual(captured.query, {
    tgUserId: "6721906788", status: "cancelled",
    fulfillmentStatus: { $ne: "success" },
    "fragmentTx.refundedToBalanceAt": null,
  });
  assert.deepEqual(captured.countQuery, captured.query);
});
