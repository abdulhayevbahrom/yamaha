const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isPubgTopup,
  isPubgRedeem,
  isMlbbTopup,
  isHokTopup,
  isGenshinTopup,
  isRobloxTopup,
  isBloodStrikeTopup,
  isDeltaForceTopup,
  extractMlbbRegion,
  extractHokRegion,
  extractUcAmount,
  normalizeProduct,
} = require("../services/gw-api.service");
const {
  normalizeStatus,
  isPlanReady,
} = require("../services/gw-pubg-fulfillment.service");
const { isPlanReady: isMlbbPlanReady } = require("../services/gw-mlbb-fulfillment.service");
const { isGwHokPlanReady } = require("../services/gw-hok-fulfillment.service");
const { getMlbbBonusTier, isMlbbBonusPlan, isBonusTierAvailable } = require("../services/gw-mlbb-verification.service");
const {
  normalizeResult: normalizeVolseverHokResult,
  verifyVolseverBloodStrikePlayer,
  verifyVolseverDeltaForcePlayer,
} = require("../services/volsever-hok-verification.service");

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

test("GW catalog recognizes PUBG redeem codes separately", () => {
  assert.equal(isPubgRedeem({ gameName: "Game Keys — PUBG Mobile", category: "gamekeypubg", serviceName: "60 UC code" }), true);
  assert.equal(isPubgRedeem({ gameName: "PUBG Mobile", serviceName: "60 UC" }), false);
});

test("GW catalog recognizes Mobile Legends products", () => {
  assert.equal(isMlbbTopup({ id: "GWML86", gameName: "Mobile Legends", serviceName: "86 Diamonds" }), true);
  assert.equal(isMlbbTopup({ category: "giftcard", serviceName: "MLBB code" }), false);
});

test("GW catalog recognizes Honor of Kings products", () => {
  assert.equal(isHokTopup({ id: "GWHKWC", gameName: "Honor of Kings", serviceName: "Weekly Card" }), true);
  assert.equal(isHokTopup({ id: "GWPSN50", category: "giftcard", serviceName: "PlayStation" }), false);
});

test("GW HOK products are assigned to their storefront region", () => {
  assert.equal(extractHokRegion({ serviceName: "Honor of Kings Asia 80 Tokens" }), "asia");
  assert.equal(extractHokRegion({ serviceName: "Honor of Kings Europe Weekly Card" }), "europe");
  assert.equal(extractHokRegion({ serviceName: "Honor of Kings America Tokens" }), "america");
  assert.equal(extractHokRegion({ serviceName: "Honor of Kings TW/HK/MO Tokens" }), "tw_hk_mo");
  assert.equal(extractHokRegion({ serviceName: "Honor of Kings 80 Tokens" }), "global");
});

test("GW catalog recognizes Genshin Impact products", () => {
  assert.equal(isGenshinTopup({ id: "GWG980", serviceName: "980 Genesis Crystals" }), true);
  assert.equal(isGenshinTopup({ id: "GWGI60", gameName: "Genshin Impact", serviceName: "60 Genesis Crystals" }), true);
  assert.equal(isGenshinTopup({ serviceName: "HoYoverse Genshin Top Up" }), true);
  assert.equal(isGenshinTopup({ product: { name: "Blessing of the Welkin Moon" }, service: { name: "Genshin Impact" } }), true);
  assert.equal(isGenshinTopup({ id: "GI980", service: { name: "980 Genesis Crystals" } }), true);
  assert.equal(isGenshinTopup({ serviceName: "300 Chronal Nexus" }), true);
  assert.equal(isGenshinTopup({ id: "GWGP50", serviceName: "Google Play 50 Gift Card" }), false);
  assert.equal(isGenshinTopup({ category: "giftcard", serviceName: "Genshin Impact Giftcard" }), false);
});

test("GW catalog recognizes Roblox and Robux giftcard products", () => {
  assert.equal(isRobloxTopup({ slug: "giftcardroblox", gameName: "Giftcard — Roblox USD", serviceName: "Roblox 10 USD" }), true);
  assert.equal(isRobloxTopup({ slug: "giftcardrobux", gameName: "Giftcard — Robux", serviceName: "Robux 800" }), true);
  assert.equal(isRobloxTopup({ gameName: "Roblox", serviceName: "400 Robux" }), true);
  assert.equal(isRobloxTopup({ slug: "giftcardpsn", gameName: "Giftcard — PlayStation USD", serviceName: "PSN 10 USD" }), false);
});

test("GW catalog recognizes Blood Strike topup products", () => {
  assert.equal(isBloodStrikeTopup({ slug: "bloodstrike", gameName: "Blood Strike", serviceName: "100 Gold" }), true);
  assert.equal(isBloodStrikeTopup({ slug: "blood-strike", gameName: "Blood Strike", serviceName: "Weekly Pass" }), true);
  assert.equal(isBloodStrikeTopup({ id: "GWBS100", serviceName: "100 Gold" }), true);
  assert.equal(isBloodStrikeTopup({ slug: "giftcardbloodstrike", gameName: "Giftcard — Blood Strike", serviceName: "Code" }), false);
});

test("GW catalog recognizes Delta Force topup products", () => {
  assert.equal(isDeltaForceTopup({ slug: "deltaforce", gameName: "Delta Force", serviceName: "60 Delta Coins" }), true);
  assert.equal(isDeltaForceTopup({ slug: "delta-force", gameName: "Delta Force", serviceName: "Weekly Pass" }), true);
  assert.equal(isDeltaForceTopup({ id: "GWDF100", serviceName: "100 Delta Coins" }), true);
  assert.equal(isDeltaForceTopup({ slug: "giftcarddeltaforce", gameName: "Giftcard — Delta Force", serviceName: "Code" }), false);
});

test("GW HOK plan must be mapped, available and fresh", () => {
  const previous = process.env.GW_HOK_CATALOG_MAX_AGE_MS;
  process.env.GW_HOK_CATALOG_MAX_AGE_MS = "60000";
  try {
    assert.equal(isGwHokPlanReady({ provider: "gw", providerProductId: "GWHKWC", providerAvailable: true, providerSyncedAt: new Date() }), true);
  } finally {
    if (typeof previous === "undefined") delete process.env.GW_HOK_CATALOG_MAX_AGE_MS;
    else process.env.GW_HOK_CATALOG_MAX_AGE_MS = previous;
  }
});

test("Volsever HOK response exposes the verified player", () => {
  assert.deepEqual(normalizeVolseverHokResult({ status: true, code: 200, data: {
    game: "Honor of Kings", username: "Test Player", user_id: "89829050619124578",
  } }, "89829050619124578"), {
    valid: true, playerId: "89829050619124578", playerName: "Test Player",
    game: "Honor of Kings", payload: { status: true, code: 200, data: {
      game: "Honor of Kings", username: "Test Player", user_id: "89829050619124578",
    } },
  });
});

test("Volsever Blood Strike validates numeric player ids", async () => {
  await assert.rejects(
    verifyVolseverBloodStrikePlayer("abc"),
    /Blood Strike Player ID noto'g'ri/,
  );
});

test("Volsever Delta Force validates numeric player ids", async () => {
  await assert.rejects(
    verifyVolseverDeltaForcePlayer("abc"),
    /Delta Force Player ID noto'g'ri/,
  );
});

test("GW MLBB products are assigned to their storefront region", () => {
  assert.equal(extractMlbbRegion({ slug: "mobile-legends-ph", serviceName: "86 Diamonds" }), "ph");
  assert.equal(extractMlbbRegion({ gameName: "Mobile Legends Indonesia" }), "id");
  assert.equal(extractMlbbRegion({ gameName: "Mobile Legends Global" }), "global");
  assert.equal(extractMlbbRegion({ id: "GWMP11", gameName: "Mobile Legends" }), "ph");
  assert.equal(extractMlbbRegion({ id: "GWMLMY42", gameName: "Mobile Legends" }), "my");
  assert.equal(extractMlbbRegion({ id: "GWMLTU44", gameName: "Mobile Legends" }), "tr");
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

test("GW MLBB first bonus eligibility matches the exact tier", () => {
  const plan = { label: "50+50 First Bonus" };
  const verification = { firstTimeBonus: [
    { tier: "50+50", status: "available" },
    { tier: "150+150", status: "already_claimed" },
  ] };
  assert.equal(isMlbbBonusPlan(plan), true);
  assert.equal(getMlbbBonusTier(plan), "50+50");
  assert.equal(isBonusTierAvailable(verification, "50+50"), true);
  assert.equal(isBonusTierAvailable(verification, "150+150"), false);
  assert.equal(isMlbbBonusPlan({ label: "86 Diamonds" }), false);
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

test("GW product normalization reads nested provider fields", () => {
  const item = normalizeProduct({
    id: "GI980",
    service: { name: "980 Genesis Crystals" },
    usdPrice: 14.99,
    status: "active",
  });
  assert.equal(item.providerProductId, "GI980");
  assert.equal(item.amount, 980);
  assert.equal(item.label, "980 Genesis Crystals");
  assert.equal(item.priceUsd, 14.99);
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
