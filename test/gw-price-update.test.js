const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseGwPriceUpdateMessage,
  pickMatchingPlan,
  formatGwAlertMessage,
} = require("../utils/gw-price-update");

test("GW update parser extracts multiple decreased products", () => {
  const items = parseGwPriceUpdateMessage(`
💰 PRICE UPDATE ALERT

📉 Price decreased
━━━━━━━━━━━━━━━━

FREE FIRE (MENA) KEYS · FF530P53
   $4.65 → $4.63

PUBG MOBILE KEYS · 8100UC
   $88.70 → $88.00
`);

  assert.equal(items.length, 2);
  assert.deepEqual(items[0], {
    direction: "decreased",
    gameTitle: "FREE FIRE (MENA) KEYS",
    productLabel: "FF530P53",
    category: "freefire",
    region: "",
    providerProductId: "FF530P53",
    amount: 530,
    previousUsd: 4.65,
    nextUsd: 4.63,
    rawProductLine: "FREE FIRE (MENA) KEYS · FF530P53",
    rawPriceLine: "$4.65 → $4.63",
  });
  assert.equal(items[1].category, "uc");
  assert.equal(items[1].amount, 8100);
});

test("GW update matcher prefers provider product id and region-aware amount", () => {
  const pubgUpdate = parseGwPriceUpdateMessage(`
💰 PRICE UPDATE ALERT

📉 Price decreased
━━━━━━━━━━━━━━━━

PUBG MOBILE KEYS · 8100UC
   $88.70 → $88.00
`)[0];
  const mlbbUpdate = parseGwPriceUpdateMessage(`
💰 PRICE UPDATE ALERT

📉 Price decreased
━━━━━━━━━━━━━━━━

MOBILE LEGEND (MALAYSIA) · 355 Diamonds
   $6.02 → $5.99
`)[0];

  const plans = [
    { category: "uc", label: "8100 UC", amount: 8100, basePrice: 1250000, providerProductId: "PUBG8100", providerRegion: "global" },
    { category: "mlbb", label: "355 Diamonds", amount: 355, basePrice: 82000, providerProductId: "GWMLMY355", providerRegion: "my" },
    { category: "mlbb", label: "355 Diamonds", amount: 355, basePrice: 83000, providerProductId: "GWMLSG355", providerRegion: "sg" },
    { category: "freefire", label: "530 Diamonds", amount: 530, basePrice: 70000, providerProductId: "FF530P53", providerRegion: "global" },
  ];

  assert.equal(pickMatchingPlan(pubgUpdate, plans)?.label, "8100 UC");
  assert.equal(pickMatchingPlan(mlbbUpdate, plans)?.providerRegion, "my");
});

test("GW alert formatter returns admin-friendly summary", () => {
  const update = {
    direction: "increased",
    gameTitle: "PUBG MOBILE KEYS",
    productLabel: "8100UC",
    previousUsd: 88.7,
    nextUsd: 89,
  };
  const message = formatGwAlertMessage({
    update,
    plan: { basePrice: 1250000 },
  });

  assert.match(message, /O'yin: PUBG MOBILE KEYS/);
  assert.match(message, /Holat: narx oshdi/);
  assert.match(message, /Oldingi API narx: \$88.70/);
  assert.match(message.replace(/\u00a0/g, " "), /Bizdagi oldingi narx: 1 250 000 so'm/);
});
