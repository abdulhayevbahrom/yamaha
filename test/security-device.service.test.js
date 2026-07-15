const test = require("node:test");
const assert = require("node:assert/strict");

const {
  collectReferralSourceIds,
  formatReferralAlertUser,
} = require("../services/security-device.service");

test("anti-fraud alert exposes username, profile name and Telegram ID", () => {
  assert.equal(
    formatReferralAlertUser({
      username: "ali",
      profileName: "Ali Valiyev",
      tgUserId: "12345",
    }),
    "@username: @ali | Profil: Ali Valiyev | tgUserId: 12345",
  );
});

test("anti-fraud alert includes referrers from the device's full user history", () => {
  assert.deepEqual(
    collectReferralSourceIds([
      { tgUserId: "recent-user" },
      { tgUserId: "older-user-1", referredByUserId: "referrer-1" },
      { tgUserId: "older-user-2", referredByUserId: "referrer-1" },
      { tgUserId: "older-user-3", referredByUserId: "referrer-2" },
    ]),
    ["referrer-1", "referrer-2"],
  );
});
