const test = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");
const Counter = require("../model/counter.model");
const Order = require("../model/order.model");
const Plan = require("../model/plan.model");
const User = require("../model/user.model");
const { calculatePrice, createOrder } = require("../controller/order.controller");
const { getCatalog } = require("../controller/public.controller");

const responseRecorder = {
  status(code) {
    return { json: (body) => ({ code, body }) };
  },
};

test("GW checkout only debits a confirmed price after cost, fixed price, or pricing mode changes", async (t) => {
  const originalRedeemEnabled = process.env.GW_PUBG_REDEEM_ENABLED;
  process.env.GW_PUBG_REDEEM_ENABLED = "false";
  t.after(() => {
    if (originalRedeemEnabled === undefined) delete process.env.GW_PUBG_REDEEM_ENABLED;
    else process.env.GW_PUBG_REDEEM_ENABLED = originalRedeemEnabled;
  });

  const plan = {
    category: "redeem",
    code: "60",
    label: "60 UC",
    amount: 60,
    basePrice: 9000,
    currency: "UZS",
    isActive: true,
    provider: "gw",
    providerAvailable: true,
    providerSyncedAt: new Date(),
    providerPriceUsd: 1.03,
    markupPercent: 12.5,
  };
  const fixedNeighbor = { ...plan, code: "300", basePrice: 44_444, markupPercent: null };
  t.mock.method(axios, "get", async () => ({
    data: [{ Ccy: "USD", Rate: "12100" }],
  }));
  t.mock.method(Plan, "find", () => ({ lean: async () => [{ ...plan }, fixedNeighbor] }));
  t.mock.method(Plan, "findOne", () => ({ lean: async () => ({ ...plan }) }));
  t.mock.method(Order, "updateMany", async () => ({ modifiedCount: 0 }));
  t.mock.method(Order, "findOne", () => ({ sort: () => ({ lean: async () => null }) }));
  t.mock.method(Counter, "findOneAndUpdate", () => ({ lean: async () => ({ seq: 1001 }) }));
  t.mock.method(User, "findOne", () => ({
    select: () => ({ lean: async () => ({ balance: 50_000 }) }),
  }));
  const debit = t.mock.method(User, "findOneAndUpdate", () => ({
    lean: async () => ({ balance: 35_200 }),
  }));
  const recordOrder = t.mock.method(Order, "create", async (order) => ({ ...order, _id: "order-1001" }));

  const request = {
    telegramAuth: { verified: true, tgUserId: "1" },
    body: { product: "redeem", planCode: "60" },
  };
  function submitOrder(quotedAmount) {
    const body = quotedAmount === undefined ? request.body : { ...request.body, quotedAmount };
    return createOrder({ ...request, body }, responseRecorder);
  }
  async function expectPriceChange(quotedAmount, amount) {
    const debitCount = debit.mock.callCount();
    const orderCount = recordOrder.mock.callCount();
    const result = await submitOrder(quotedAmount);
    assert.equal(result.code, 400);
    assert.deepEqual(result.body.innerData, { code: "PRICE_CHANGED", amount });
    assert.equal(debit.mock.callCount(), debitCount);
    assert.equal(recordOrder.mock.callCount(), orderCount);
  }
  async function expectCharge(quotedAmount, amount) {
    const debitCount = debit.mock.callCount();
    const orderCount = recordOrder.mock.callCount();
    const result = await submitOrder(quotedAmount);
    assert.equal(result.code, 201);
    assert.equal(result.body.innerData.expectedAmount, amount);
    assert.equal(result.body.innerData.paidAmount, amount);
    assert.equal(debit.mock.callCount(), debitCount + 1);
    assert.equal(debit.mock.calls[debitCount].arguments[1].$inc.balance, -amount);
    assert.equal(recordOrder.mock.callCount(), orderCount + 1);
  }

  const catalog = await getCatalog({}, responseRecorder);
  const [visiblePlan, visibleFixedPlan] = catalog.body.innerData.redeem.plans;
  assert.equal(visiblePlan.basePrice, 14_100);
  assert.equal(visiblePlan.requiresPriceConfirmation, true);
  assert.equal(visibleFixedPlan.basePrice, 44_444);
  assert.equal(visibleFixedPlan.requiresPriceConfirmation, true);
  assert.equal(Object.hasOwn(visiblePlan, "markupPercent"), false);
  assert.equal(Object.hasOwn(visiblePlan, "providerPriceUsd"), false);
  const quote = await calculatePrice(request, responseRecorder);
  assert.equal(quote.body.innerData.amount, visiblePlan.basePrice);

  await expectPriceChange(undefined, 14_100);
  plan.providerPriceUsd = 1.08;
  await expectPriceChange(visiblePlan.basePrice, 14_800);
  await expectCharge(14_800, 14_800);

  plan.markupPercent = null;
  plan.basePrice = 16_543;
  const fixedCatalog = await getCatalog({}, responseRecorder);
  const fixedPlan = fixedCatalog.body.innerData.redeem.plans[0];
  assert.equal(fixedPlan.basePrice, 16_543);
  assert.equal(fixedPlan.requiresPriceConfirmation, true);
  await expectPriceChange(undefined, fixedPlan.basePrice);
  await expectPriceChange(14_800, fixedPlan.basePrice);
  await expectCharge(fixedPlan.basePrice, fixedPlan.basePrice);

  plan.basePrice = 16_600;
  await expectPriceChange(fixedPlan.basePrice, 16_600);

  plan.markupPercent = 0;
  await expectPriceChange(16_600, 13_100);
  await expectCharge(13_100, 13_100);

  delete plan.markupPercent;
  plan.basePrice = 9_000.5;
  await expectPriceChange(9_000, 9_001);
  await expectCharge(9_001, 9_001);
  await expectCharge(undefined, 9_001);

  plan.provider = "manual";
  await expectCharge(undefined, 9_001);
});
