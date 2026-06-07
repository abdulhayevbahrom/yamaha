const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const Order = require("../model/order.model");
const UserGift = require("../model/user-gift.model");
const UserNft = require("../model/user-nft.model");
const { parseAmountFromText } = require("../services/payment-match.service");
const {
  isAmbiguousExternalError,
} = require("../services/external-operation.service");
const {
  createTurnstileGuard,
} = require("../middleware/turnstile.middleware");

test("payment text parser handles Uzbek thousands separators", () => {
  assert.equal(parseAmountFromText("+ 109.000 UZS"), 109000);
  assert.equal(parseAmountFromText("➕ 10,900,000 UZS"), 10900000);
});

test("ambiguous provider failures are held for manual review", () => {
  assert.equal(
    isAmbiguousExternalError({ code: "ETIMEDOUT", message: "timeout" }),
    true,
  );
  assert.equal(
    isAmbiguousExternalError({
      response: { status: 400 },
      message: "insufficient funds",
    }),
    false,
  );
});

test("financial state machines include lock and review states", () => {
  const orderStatuses =
    Order.schema.path("status").options.enum || [];
  const fulfillmentStatuses =
    Order.schema.path("fulfillmentStatus").options.enum || [];
  const giftStatuses =
    UserGift.schema.path("status").options.enum || [];
  const nftTransferStatuses =
    UserNft.schema.path("transferStatus").options.enum || [];

  assert.ok(orderStatuses.includes("payment_processing"));
  assert.ok(orderStatuses.includes("admin_action_processing"));
  assert.ok(fulfillmentStatuses.includes("needs_review"));
  assert.ok(giftStatuses.includes("sending"));
  assert.ok(giftStatuses.includes("send_needs_review"));
  assert.ok(nftTransferStatuses.includes("processing"));
  assert.ok(nftTransferStatuses.includes("needs_review"));
});

test("enabled Turnstile rejects protected writes without a token", async () => {
  const previousEnabled = process.env.TURNSTILE_ENABLED;
  const previousSecret = process.env.TURNSTILE_SECRET_KEY;
  process.env.TURNSTILE_ENABLED = "true";
  process.env.TURNSTILE_SECRET_KEY = "test-secret";

  let statusCode = 200;
  let payload = null;
  let nextCalled = false;
  const middleware = createTurnstileGuard({
    protectedPrefixes: ["/orders"],
  });

  try {
    await middleware(
      {
        method: "POST",
        path: "/orders",
        headers: {},
        body: {},
        ip: "127.0.0.1",
      },
      {
        status(code) {
          statusCode = code;
          return this;
        },
        json(value) {
          payload = value;
          return value;
        },
      },
      () => {
        nextCalled = true;
      },
    );
  } finally {
    if (previousEnabled == null) delete process.env.TURNSTILE_ENABLED;
    else process.env.TURNSTILE_ENABLED = previousEnabled;
    if (previousSecret == null) delete process.env.TURNSTILE_SECRET_KEY;
    else process.env.TURNSTILE_SECRET_KEY = previousSecret;
  }

  assert.equal(nextCalled, false);
  assert.equal(statusCode, 401);
  assert.equal(payload?.innerData?.code, "turnstile_token_missing");
});

test("HTTP payment injection endpoints are not exposed", () => {
  const routerSource = fs.readFileSync(
    path.join(__dirname, "..", "router", "router.js"),
    "utf8",
  );

  assert.doesNotMatch(routerSource, /\/integrations\/orders\/process-payment/);
  assert.doesNotMatch(routerSource, /\/admin\/orders\/process-payment/);
});
