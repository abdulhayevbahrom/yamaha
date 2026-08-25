const test = require("node:test");
const assert = require("node:assert/strict");

const Order = require("../model/order.model");

const controllerPath = require.resolve("../controller/uzum-pubg.controller");
const fulfillmentServicePath = require.resolve("../services/gw-pubg-fulfillment.service");
const fulfillmentService = require(fulfillmentServicePath);

function buildRequest(body) {
  return {
    body,
    headers: {
      authorization: `Basic ${Buffer.from("test-login:test-password").toString("base64")}`,
    },
  };
}

function buildResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return payload;
    },
  };
}

async function withController(autoFulfillGwPubg, run) {
  const previousEnv = {
    serviceIds: process.env.UZUM_PUBG_SERVICE_IDS,
    login: process.env.UZUM_PUBG_LOGIN,
    password: process.env.UZUM_PUBG_PASSWORD,
    waitMs: process.env.UZUM_PUBG_CONFIRM_WAIT_MS,
    intervalMs: process.env.UZUM_PUBG_CONFIRM_CHECK_INTERVAL_MS,
  };
  const originalServiceExports = require.cache[fulfillmentServicePath].exports;
  const originalFindOne = Order.findOne;
  const originalFindById = Order.findById;

  process.env.UZUM_PUBG_SERVICE_IDS = "7814652";
  process.env.UZUM_PUBG_LOGIN = "test-login";
  process.env.UZUM_PUBG_PASSWORD = "test-password";
  process.env.UZUM_PUBG_CONFIRM_WAIT_MS = "100";
  process.env.UZUM_PUBG_CONFIRM_CHECK_INTERVAL_MS = "5";

  require.cache[fulfillmentServicePath].exports = {
    ...fulfillmentService,
    autoFulfillGwPubg,
    isGwPubgAutobuyEnabled: () => true,
  };
  delete require.cache[controllerPath];

  try {
    await run(require(controllerPath));
  } finally {
    delete require.cache[controllerPath];
    require.cache[fulfillmentServicePath].exports = originalServiceExports;
    Order.findOne = originalFindOne;
    Order.findById = originalFindById;

    const restoreEnv = (key, value) => {
      if (typeof value === "undefined") delete process.env[key];
      else process.env[key] = value;
    };
    restoreEnv("UZUM_PUBG_SERVICE_IDS", previousEnv.serviceIds);
    restoreEnv("UZUM_PUBG_LOGIN", previousEnv.login);
    restoreEnv("UZUM_PUBG_PASSWORD", previousEnv.password);
    restoreEnv("UZUM_PUBG_CONFIRM_WAIT_MS", previousEnv.waitMs);
    restoreEnv("UZUM_PUBG_CONFIRM_CHECK_INTERVAL_MS", previousEnv.intervalMs);
  }
}

test("Uzum PUBG confirm waits for a processing GW sale to complete", async () => {
  const initialOrder = {
    _id: "order-1",
    status: "paid_auto_processed",
    fulfillmentStatus: "pending",
    expectedAmount: 12000,
  };
  const processingOrder = { ...initialOrder, fulfillmentStatus: "processing" };
  const completedOrder = {
    ...initialOrder,
    status: "completed",
    fulfillmentStatus: "success",
    fulfilledAt: new Date("2026-08-25T12:00:00.000Z"),
  };

  await withController(async () => ({ ok: false, processing: true }), async (controller) => {
    let findByIdCalls = 0;
    Order.findOne = () => ({ lean: async () => initialOrder });
    Order.findById = () => ({
      lean: async () => (findByIdCalls++ === 0 ? processingOrder : completedOrder),
    });

    const res = buildResponse();
    await controller.confirm(buildRequest({ serviceId: 7814652, transId: "uzum-1" }), res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, "CONFIRMED");
    assert.equal(res.body.amount, 1200000);
    assert.equal(res.body.errorCode, undefined);
  });
});

test("Uzum PUBG confirm returns 10015 when the GW sale is cancelled", async () => {
  const initialOrder = {
    _id: "order-2",
    status: "paid_auto_processed",
    fulfillmentStatus: "pending",
    expectedAmount: 12000,
  };
  const cancelledOrder = {
    ...initialOrder,
    status: "cancelled",
    fulfillmentStatus: "skipped",
  };

  await withController(async () => ({ ok: false, cancelled: true, order: cancelledOrder }), async (controller) => {
    Order.findOne = () => ({ lean: async () => initialOrder });

    const res = buildResponse();
    await controller.confirm(buildRequest({ serviceId: 7814652, transId: "uzum-2" }), res);

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.status, "FAILED");
    assert.equal(res.body.errorCode, "10015");
    assert.equal(res.body.confirmTime, null);
  });
});

test("Uzum PUBG status does not confirm a sale that is still processing", async () => {
  const processingOrder = {
    _id: "order-3",
    status: "paid_auto_processed",
    fulfillmentStatus: "processing",
    expectedAmount: 12000,
  };

  await withController(async () => ({ ok: false, processing: true }), async (controller) => {
    Order.findOne = () => ({ lean: async () => processingOrder });

    const res = buildResponse();
    await controller.status(buildRequest({ serviceId: 7814652, transId: "uzum-3" }), res);

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.status, "FAILED");
    assert.equal(res.body.errorCode, "10014");
  });
});
