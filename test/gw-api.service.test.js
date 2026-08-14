const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isPubgTopup,
  isMlbbTopup,
  extractUcAmount,
  normalizeProduct,
} = require("../services/gw-api.service");
const {
  normalizeStatus,
  isPlanReady,
} = require("../services/gw-pubg-fulfillment.service");
const { isPlanReady: isMlbbPlanReady } = require("../services/gw-mlbb-fulfillment.service");

test("GW catalog keeps PUBG topups and excludes redeem codes", () => {
  assert.equal(
    isPubgTopup({ gameName: "PUBG Mobile", serviceName: "60 UC" }),
    true,
  );
  assert.equal(
    isPubgTopup({ gameName: "Game Keys — PUBG Mobile", category: "gamekeypubg" }),
    false,
  );
});

test("GW catalog recognizes Mobile Legends products", () => {
  assert.equal(isMlbbTopup({ id: "GWML86", gameName: "Mobile Legends", serviceName: "86 Diamonds" }), true);
  assert.equal(isMlbbTopup({ category: "giftcard", serviceName: "MLBB code" }), false);
});

test("GW MLBB plan must be mapped, available and fresh", () => {
  const previous = process.env.GW_MLBB_CATALOG_MAX_AGE_MS;
  process.env.GW_MLBB_CATALOG_MAX_AGE_MS = "60000";
  try {
    assert.equal(isMlbbPlanReady({ provider: "gw", providerProductId: "GWML86", providerAvailable: true, providerSyncedAt: new Date() }), true);
  } finally {
    if (typeof previous === "undefined") delete process.env.GW_MLBB_CATALOG_MAX_AGE_MS;
    else process.env.GW_MLBB_CATALOG_MAX_AGE_MS = previous;
  }
});

test("GW plan must be mapped, available and freshly synced", () => {
  const previous = process.env.GW_PUBG_CATALOG_MAX_AGE_MS;
  process.env.GW_PUBG_CATALOG_MAX_AGE_MS = "60000";
  try {
    assert.equal(
      isPlanReady({
        provider: "gw",
        providerProductId: "GWPUBG60",
        providerAvailable: true,
        providerSyncedAt: new Date(),
      }),
      true,
    );
    assert.equal(
      isPlanReady({
        provider: "gw",
        providerProductId: "GWPUBG60",
        providerAvailable: true,
        providerSyncedAt: new Date(Date.now() - 120000),
      }),
      false,
    );
  } finally {
    if (typeof previous === "undefined") delete process.env.GW_PUBG_CATALOG_MAX_AGE_MS;
    else process.env.GW_PUBG_CATALOG_MAX_AGE_MS = previous;
  }
});

test("GW PUBG product normalization keeps provider price separate", () => {
  const item = normalizeProduct({
    id: "GWPUBG60",
    gameName: "PUBG Mobile",
    serviceName: "60 UC",
    price: 0.858,
    status: "active",
    quantity: 947,
  });
  assert.equal(item.providerProductId, "GWPUBG60");
  assert.equal(item.amount, 60);
  assert.equal(item.priceUsd, 0.858);
  assert.equal(item.available, true);
  assert.equal(item.stockQuantity, 947);
  assert.equal(Object.hasOwn(item, "basePrice"), false);
});

test("GW product without quantity does not invent a stock count", () => {
  const item = normalizeProduct({
    id: "GWP325",
    gameName: "PUBG Mobile",
    serviceName: "325 UC",
    price: 4.45,
  });
  assert.equal(item.stockQuantity, null);
});

test("GW UC amount and order status accept documented response shapes", () => {
  assert.equal(extractUcAmount({ serviceName: "3,850 UC" }), 3850);
  assert.equal(normalizeStatus({ status: "processing" }), "processing");
  assert.equal(normalizeStatus({ order: { status: "completed" } }), "completed");
});

test("GW PUBG Growth Packs without digits remain in the catalog", () => {
  const products = [
    ["GWPSFP", "FIRST PURCHASE PACK", 1],
    ["GWPSMP", "MATERIAL PACK", 2],
    ["GWPSMYTH", "MYTHIC EMBLEM PACK", 3],
    ["GWWEMBLM", "WEEKLY EMBLEM", 4],
  ];

  products.forEach(([id, serviceName, expectedAmount]) => {
    const raw = { id, category: "Growth Packs", serviceName, price: 1.25 };
    assert.equal(isPubgTopup(raw), true);
    assert.equal(normalizeProduct(raw).amount, expectedAmount);
  });
});
