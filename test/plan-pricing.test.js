const test = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");
const { getPlanPrice, getPlanPricingRate } = require("../services/plan-pricing.service");

test("GW prices follow provider cost and use the same percentage after a sync", () => {
  const plan = { provider: "gw", providerPriceUsd: 1.03, markupPercent: 12.5 };
  assert.equal(getPlanPrice(plan, 12_100), 14_100);
  assert.equal(getPlanPrice({ ...plan, providerPriceUsd: 1.08 }, 12_100), 14_800);
});

test("GW prices support zero markup and keep exact hundreds unchanged", () => {
  const plan = { provider: "gw", providerPriceUsd: 1.1, markupPercent: 0 };
  assert.equal(getPlanPrice(plan, 11_000), 12_100);
  assert.equal(getPlanPrice(plan, 11_001), 12_200);
});

test("fixed GW prices do not depend on provider cost or the exchange rate", async (t) => {
  const fetchRate = t.mock.method(axios, "get", async () => {
    throw new Error("Unexpected exchange rate request");
  });
  const fixedPlan = { provider: "gw", basePrice: 12_345, markupPercent: null };
  const legacyPlan = { provider: "gw", basePrice: 9_000 };
  const manualPlan = { provider: "manual", basePrice: 8_000, markupPercent: 20 };

  assert.equal(await getPlanPricingRate([fixedPlan, legacyPlan, manualPlan]), null);
  assert.equal(fetchRate.mock.callCount(), 0);
  assert.equal(getPlanPrice({ ...fixedPlan, providerPriceUsd: 1 }, 12_100), 12_345);
  assert.equal(getPlanPrice({ ...fixedPlan, providerPriceUsd: 2 }, 12_500), 12_345);
  assert.equal(getPlanPrice(legacyPlan), 9_000);
  assert.equal(getPlanPrice(manualPlan), 8_000);
});

test("configured GW packages need a usable cost and exchange rate", () => {
  const plan = { provider: "gw", providerPriceUsd: 1, markupPercent: 10, basePrice: 5_000 };
  assert.equal(getPlanPrice(plan, null), null);
  assert.equal(getPlanPrice({ ...plan, providerPriceUsd: 0 }, 12_000), null);
  assert.equal(getPlanPrice({ ...plan, markupPercent: -10 }, 12_000), null);
});
