const test = require("node:test");
const assert = require("node:assert/strict");

const {
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
