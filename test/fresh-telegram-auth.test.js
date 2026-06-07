const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createFreshTelegramAuthMiddleware,
} = require("../middleware/fresh-telegram-auth.middleware");

function runMiddleware(authDateSec) {
  const middleware = createFreshTelegramAuthMiddleware();
  const req = {
    telegramAuth: {
      tgUserId: "123456",
      authDateSec,
    },
  };
  const result = {
    statusCode: null,
    payload: null,
    nextCalled: false,
  };
  const res = {
    status(statusCode) {
      result.statusCode = statusCode;
      return this;
    },
    json(payload) {
      result.payload = payload;
      return payload;
    },
  };

  middleware(req, res, () => {
    result.nextCalled = true;
  });
  return result;
}

test("critical Telegram session remains valid for ten minutes by default", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const result = runMiddleware(nowSec - 599);

  assert.equal(result.nextCalled, true);
  assert.equal(result.statusCode, null);
});

test("critical Telegram session expires after ten minutes by default", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const result = runMiddleware(nowSec - 601);

  assert.equal(result.nextCalled, false);
  assert.equal(result.statusCode, 401);
  assert.equal(result.payload?.innerData?.code, "stale_telegram_session");
  assert.equal(result.payload?.innerData?.maxAgeSec, 600);
});
