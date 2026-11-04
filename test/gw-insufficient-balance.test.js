const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isGwInsufficientBalance,
} = require("../services/gw-insufficient-balance.service");

test("detects documented GW insufficient balance codes", () => {
  assert.equal(isGwInsufficientBalance({ code: "INSUFFICIENT_BALANCE" }), true);
  assert.equal(isGwInsufficientBalance({ error: "NOT_ENOUGH_BALANCE" }), true);
  assert.equal(
    isGwInsufficientBalance({
      orderCreated: false,
      status: "cancelled",
      error: "INSUFFICIENT BALANCE",
    }),
    true,
  );
});

test("detects GW low balance messages in nested error payloads", () => {
  assert.equal(
    isGwInsufficientBalance({ data: { message: "Insufficient funds" } }),
    true,
  );
  assert.equal(
    isGwInsufficientBalance(null, {
      response: { data: { error: "Provider balance is too low" } },
    }),
    true,
  );
});

test("does not classify unrelated provider failures as low balance", () => {
  assert.equal(
    isGwInsufficientBalance({ code: "PLAYER_NOT_FOUND", message: "Invalid user" }),
    false,
  );
});
