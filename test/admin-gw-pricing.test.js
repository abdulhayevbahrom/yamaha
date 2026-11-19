const assert = require("node:assert/strict");
const test = require("node:test");
const axios = require("axios");
const Plan = require("../model/plan.model");
const { updatePlan } = require("../controller/admin.controller");
const { updatePlanValidation } = require("../validations/admin.validation");

const responseRecorder = {
  status(code) {
    return { json: (body) => ({ code, body }) };
  },
};

function patchPlan(body) {
  return updatePlan({
    body,
    params: { id: "plan-1" },
    validated: updatePlanValidation({ body }),
  }, responseRecorder);
}

test("admin can switch an active GW package between fixed and percentage pricing", async (t) => {
  const plan = { provider: "gw", basePrice: 15_000, providerPriceUsd: 1.03, isActive: true };
  t.mock.method(axios, "get", async () => ({ data: [{ Ccy: "USD", Rate: "12100" }] }));
  t.mock.method(Plan, "findById", () => ({ lean: async () => ({ ...plan }) }));
  const write = t.mock.method(Plan, "findOneAndUpdate", (filter, changes) => ({
    lean: async () => {
      if (Object.hasOwn(filter, "markupPercent")) {
        assert.equal(filter.markupPercent, plan.markupPercent ?? null);
        assert.equal(filter.basePrice, plan.basePrice);
      }
      Object.assign(plan, changes);
      return { ...plan };
    },
  }));

  const legacy = await patchPlan({ label: "Updated name" });
  assert.equal(legacy.code, 200);
  assert.equal(Object.hasOwn(plan, "markupPercent"), false);

  const fixed = await patchPlan({ basePrice: 15_500 });
  assert.equal(fixed.code, 200);
  assert.deepEqual(write.mock.calls.at(-1).arguments[1], { basePrice: 15_500, markupPercent: null });

  const percentage = await patchPlan({ markupPercent: 0 });
  assert.equal(percentage.code, 200);
  assert.equal(percentage.body.innerData.basePrice, 12_500);
  assert.equal(percentage.body.innerData.fixedPrice, 15_500);
  assert.equal(plan.basePrice, 15_500);

  const previousWrites = write.mock.callCount();
  for (const body of [
    { basePrice: 13_000 },
    { basePrice: 13_000, markupPercent: 10 },
    { markupPercent: null },
    { basePrice: 0, markupPercent: null },
    { basePrice: 13_000.25, markupPercent: null },
    { basePrice: Number.MAX_SAFE_INTEGER + 1, markupPercent: null },
  ]) {
    assert.equal((await patchPlan(body)).code, 400);
  }
  assert.equal(write.mock.callCount(), previousWrites);

  const restored = await patchPlan({ markupPercent: null, basePrice: 16_543 });
  assert.equal(restored.code, 200);
  assert.equal(restored.body.innerData.basePrice, 16_543);
  assert.deepEqual(write.mock.calls.at(-1).arguments[1], { basePrice: 16_543, markupPercent: null });
  assert.equal(plan.isActive, true);
});

test("admin can activate a dormant GW package at a fixed price and edit manual packages", async (t) => {
  const fetchRate = t.mock.method(axios, "get", async () => {
    throw new Error("Fixed prices do not need an exchange rate");
  });
  const plan = { provider: "gw", basePrice: 0, isActive: false };
  t.mock.method(Plan, "findById", () => ({ lean: async () => ({ ...plan }) }));
  t.mock.method(Plan, "findOneAndUpdate", (_, changes) => ({
    lean: async () => ({ ...Object.assign(plan, changes) }),
  }));

  assert.equal((await patchPlan({ label: "Dormant" })).code, 200);
  assert.equal((await patchPlan({ isActive: true })).code, 400);
  assert.equal((await patchPlan({ basePrice: 7_999, isActive: true })).code, 200);
  assert.equal(plan.markupPercent, null);
  assert.equal(fetchRate.mock.callCount(), 0);

  plan.provider = "manual";
  delete plan.markupPercent;
  assert.equal((await patchPlan({ markupPercent: null, basePrice: 9_000 })).code, 400);
  assert.equal((await patchPlan({ markupPercent: 10 })).code, 400);
  assert.equal((await patchPlan({ basePrice: 9_000 })).code, 200);
  assert.equal(Object.hasOwn(plan, "markupPercent"), false);
});
