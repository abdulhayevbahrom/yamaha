const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isTelegramRecipientUnavailableError,
} = require("../bot");

test("Telegram 403 blocked-user errors are treated as unavailable recipients", () => {
  assert.equal(
    isTelegramRecipientUnavailableError({
      response: {
        statusCode: 403,
        body: {
          error_code: 403,
          description: "Forbidden: bot was blocked by the user",
        },
      },
    }),
    true,
  );
});

test("other Telegram errors are not hidden", () => {
  assert.equal(
    isTelegramRecipientUnavailableError({
      response: {
        statusCode: 409,
        body: {
          error_code: 409,
          description: "Conflict: terminated by other getUpdates request",
        },
      },
    }),
    false,
  );
});
