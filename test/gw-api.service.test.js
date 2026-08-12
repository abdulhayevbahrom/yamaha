const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isPubgTopup,
  extractUcAmount,
  normalizeProduct,
} = require("../services/gw-api.service");
const {
  normalizeStatus,
  isPlanReady,
} = require("../services/gw-pubg-fulfillment.service");

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
  });
  assert.equal(item.providerProductId, "GWPUBG60");
  assert.equal(item.amount, 60);
  assert.equal(item.priceUsd, 0.858);
  assert.equal(item.available, true);
  assert.equal(Object.hasOwn(item, "basePrice"), false);
});

test("GW UC amount and order status accept documented response shapes", () => {
  assert.equal(extractUcAmount({ serviceName: "3,850 UC" }), 3850);
  assert.equal(normalizeStatus({ status: "processing" }), "processing");
  assert.equal(normalizeStatus({ order: { status: "completed" } }), "completed");
});
