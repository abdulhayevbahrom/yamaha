const test = require("node:test");
const assert = require("node:assert/strict");
const { parseCardxabarPaymentProvider, isLevelReviewPaymentProvider } = require("../utils/cardxabar-payment-provider");

test("detects CLICK from the CardXabar location line", () => {
  const parsed = parseCardxabarPaymentProvider("🟢 Perevod na kartu\n➕ 50 000.00 UZS\n💳 ***6539\n📍 CLICK P2P H2UEW, UZ\n🕓 31.10.26 21:27");
  assert.deepEqual(parsed, { code: "click", name: "CLICK", details: "CLICK P2P H2UEW, UZ" });
  assert.equal(isLevelReviewPaymentProvider(parsed.code), true);
});

test("detects ALIF from the CardXabar location line", () => {
  const parsed = parseCardxabarPaymentProvider("🟢 Perevod na kartu\n➕ 11 000.00 UZS\n💳 ***6539\n📍 ALIF UZ H2U, UZ\n🕓 31.10.26 09:59");
  assert.deepEqual(parsed, { code: "alif", name: "ALIF", details: "ALIF UZ H2U, UZ" });
  assert.equal(isLevelReviewPaymentProvider(parsed.code), true);
});

test("other providers do not trigger level-based review", () => {
  const parsed = parseCardxabarPaymentProvider("➕ 50 000.00 UZS\n📍 PAYNET P2P, UZ");
  assert.equal(parsed.code, "other");
  assert.equal(parsed.details, "PAYNET P2P, UZ");
  assert.equal(isLevelReviewPaymentProvider(parsed.code), false);
});
