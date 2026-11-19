const test = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");

const { getUsdUzsRate } = require("../services/usd-exchange-rate.service");
const { getPortalsGramRateUzs } = require("../services/portals-market.service");

test("USD quotes are shared across callers and Portals can force a fresh rate", async (t) => {
  let currency = "EUR";
  let rate = "12000.50";
  const get = t.mock.method(axios, "get", async () => ({ data: [{ Ccy: currency, Rate: rate }] }));

  await assert.rejects(getUsdUzsRate(), /USD\/UZS/);
  currency = "USD";
  assert.deepEqual(await Promise.all([getUsdUzsRate(), getUsdUzsRate()]), [12000.5, 12000.5]);
  assert.equal(get.mock.callCount(), 2);

  const originalKey = process.env.PORTALS_PARTNER_API_KEY;
  process.env.PORTALS_PARTNER_API_KEY = "test-key";
  t.after(() => {
    if (originalKey === undefined) delete process.env.PORTALS_PARTNER_API_KEY;
    else process.env.PORTALS_PARTNER_API_KEY = originalKey;
  });
  t.mock.method(axios, "create", () => ({
    get: async () => ({ data: { usd_course: 2 } }),
  }));

  const initial = await getPortalsGramRateUzs();
  assert.equal(initial.usdUzs, 12000.5);
  assert.equal(initial.gramUzs, 24001);
  assert.equal(initial.source, "portals_usd_x_cbu_uzs");
  assert.equal(get.mock.callCount(), 2);

  rate = "12100.25";
  const refreshed = await getPortalsGramRateUzs({ force: true });
  assert.equal(refreshed.usdUzs, 12100.25);
  assert.equal(refreshed.gramUzs, 24200.5);
  assert.equal(await getUsdUzsRate(), 12100.25);
  assert.equal(get.mock.callCount(), 3);
});
