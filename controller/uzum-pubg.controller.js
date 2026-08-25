const response = require("../utils/response");
const Plan = require("../model/plan.model");
const Order = require("../model/order.model");
const User = require("../model/user.model");
const { getNextOrderId } = require("../services/order-id.service");
const { verifyPubgPlayer } = require("../services/gw-api.service");
const { autoFulfillGwPubg, isGwPubgAutobuyEnabled, isPlanReady } = require("../services/gw-pubg-fulfillment.service");
const { emitUserUpdate } = require("../socket");

function normalize(value) {
  return String(value || "").trim();
}

function parseServiceIds() {
  return normalize(process.env.UZUM_PUBG_SERVICE_IDS)
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item > 0);
}

function parseCredentials() {
  return {
    login: normalize(process.env.UZUM_PUBG_LOGIN),
    password: normalize(process.env.UZUM_PUBG_PASSWORD),
  };
}

function decodeBasicAuth(headerValue) {
  const token = normalize(headerValue).split(" ")[1];
  if (!token) return null;
  try {
    const raw = Buffer.from(token, "base64").toString("utf8");
    const [login, password] = raw.split(":");
    if (!login || !password) return null;
    return { login, password };
  } catch (_) {
    return null;
  }
}

function authFailed(res, serviceId) {
  return sendUzumResponse(res, {
    serviceId,
    timestamp: Date.now(),
    status: "FAILED",
    errorCode: "10001",
  });
}

function invalidServiceId(res, serviceId) {
  return sendUzumResponse(res, {
    serviceId,
    timestamp: Date.now(),
    status: "FAILED",
    errorCode: "10006",
  });
}

function missingParams(res, serviceId) {
  return sendUzumResponse(res, {
    serviceId,
    timestamp: Date.now(),
    status: "FAILED",
    errorCode: "10005",
  });
}

function sendUzumResponse(res, payload) {
  if (payload?.status === "FAILED") {
    const httpStatus = payload.errorCode === "99999" ? 500 : 400;
    return res.status(httpStatus).json(payload);
  }
  return res.status(200).json(payload);
}

function applyUzumHttpStatus(res) {
  const json = res.json.bind(res);
  res.json = (payload) => {
    if (payload?.status === "FAILED") {
      res.status(payload.errorCode === "99999" ? 500 : 400);
    } else {
      res.status(200);
    }
    return json(payload);
  };
}

function getPlanCodeFromBody(reqBody) {
  return normalize(
    reqBody?.code ||
      reqBody?.params?.code ||
      reqBody?.planCode ||
      reqBody?.params?.planCode ||
      reqBody?.params?.quantity ||
      reqBody?.params?.amount
  );
}

function getPlayerIdFromBody(reqBody) {
  return normalize(reqBody?.playerId || reqBody?.params?.player_id || reqBody?.params?.playerId);
}

function getTransIdFromBody(reqBody) {
  return normalize(reqBody?.transId || reqBody?.transactionId || reqBody?.params?.transactionId);
}

function getPriceAmountFromBody(reqBody) {
  const raw = reqBody?.price_amount ?? reqBody?.amount ?? reqBody?.params?.price_amount ?? reqBody?.params?.amount;
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
}

function mapPubgPlan(plan) {
  return {
    code: String(plan?.code || ""),
    label: String(plan?.label || ""),
    price: Number(plan?.basePrice || 0),
  };
}

function isAuthValid(req) {
  const expected = parseCredentials();
  if (!expected.login || !expected.password) return false;
  const provided = decodeBasicAuth(req.headers.authorization);
  if (!provided) return false;
  return provided.login === expected.login && provided.password === expected.password;
}

function isServiceIdValid(serviceId) {
  const ids = parseServiceIds();
  return ids.includes(Number(serviceId));
}

async function resolvePlan(planCode) {
  if (!planCode) return null;
  return Plan.findOne({ category: "uc", code: planCode, isActive: true }).lean();
}

async function buildResponsePrice(plan) {
  return Math.max(0, Math.round(Number(plan?.basePrice || 0)));
}

function isFulfillmentSuccessful(order) {
  return order?.status === "completed" && order?.fulfillmentStatus === "success";
}

function isFulfillmentTerminalFailure(order) {
  return (
    ["cancelled", "failed"].includes(String(order?.status || "")) ||
    order?.fulfillmentStatus === "needs_review"
  );
}

function getConfirmWaitMs() {
  const configured = Number(process.env.UZUM_PUBG_CONFIRM_WAIT_MS);
  return Number.isFinite(configured) && configured >= 0 ? configured : 125_000;
}

function getConfirmCheckIntervalMs() {
  const configured = Number(process.env.UZUM_PUBG_CONFIRM_CHECK_INTERVAL_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 500;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFulfillmentResult(order) {
  const deadline = Date.now() + getConfirmWaitMs();
  const intervalMs = getConfirmCheckIntervalMs();
  let latestOrder = order;

  while (
    !isFulfillmentSuccessful(latestOrder) &&
    !isFulfillmentTerminalFailure(latestOrder) &&
    Date.now() < deadline
  ) {
    await wait(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
    latestOrder = await Order.findById(order._id).lean();
    if (!latestOrder) break;
  }

  return latestOrder;
}

function buildConfirmedResponse(serviceId, transId, order) {
  return {
    serviceId,
    transId,
    confirmTime: order?.fulfilledAt
      ? new Date(order.fulfilledAt).getTime()
      : order?.updatedAt
        ? new Date(order.updatedAt).getTime()
        : Date.now(),
    status: "CONFIRMED",
    data: {},
    amount: Math.max(0, Math.round(Number(order?.expectedAmount || order?.paidAmount || 0))) * 100,
  };
}

class UzumPubgController {
  async catalog(req, res) {
    applyUzumHttpStatus(res);
    const serviceId = Number(req.body?.serviceId || 0);
    if (!isServiceIdValid(serviceId)) return invalidServiceId(res, serviceId || req.body?.serviceId);
    if (!isAuthValid(req)) return authFailed(res, serviceId);

    try {
      const plans = await Plan.find({ category: "uc", isActive: true })
        .sort({ amount: 1, createdAt: 1 })
        .lean();
      const items = plans.map(mapPubgPlan);
      return res.json({
        serviceId,
        timestamp: Date.now(),
        status: "OK",
        data: {
          game: { value: "PUBG UC" },
          plans: items,
        },
      });
    } catch (error) {
      return res.json({
        serviceId,
        timestamp: Date.now(),
        status: "FAILED",
        errorCode: "99999",
      });
    }
  }

  async check(req, res) {
    applyUzumHttpStatus(res);
    const serviceId = Number(req.body?.serviceId || 0);
    if (!isServiceIdValid(serviceId)) return invalidServiceId(res, serviceId || req.body?.serviceId);
    if (!isAuthValid(req)) return authFailed(res, serviceId);

    const playerId = getPlayerIdFromBody(req.body);
    const planCode = getPlanCodeFromBody(req.body);

    if (!playerId || !planCode) return missingParams(res, serviceId);
    if (!/^5\d+$/.test(playerId)) {
      return res.json({ serviceId, timestamp: Date.now(), status: "FAILED", errorCode: "10007" });
    }

    const plan = await resolvePlan(planCode);
    if (!plan) {
      return res.json({ serviceId, timestamp: Date.now(), status: "FAILED", errorCode: "10007" });
    }
    if (!Number.isFinite(Number(plan.basePrice)) || Number(plan.basePrice) <= 0) {
      return res.json({ serviceId, timestamp: Date.now(), status: "FAILED", errorCode: "10007" });
    }
    if (isGwPubgAutobuyEnabled() && !isPlanReady(plan)) {
      return res.json({ serviceId, timestamp: Date.now(), status: "FAILED", errorCode: "10003" });
    }

    try {
      const trxid = `UZM-PUBG-CHK-${serviceId}-${Date.now()}`.slice(0, 80);
      const verify = await verifyPubgPlayer(playerId, trxid);
      const profileName = String(verify?.playerName || verify?.name || "").trim();
      if (!verify?.success || !profileName) {
        return res.json({ serviceId, timestamp: Date.now(), status: "FAILED", errorCode: "10007" });
      }

      return res.json({
        serviceId,
        timestamp: Date.now(),
        status: "OK",
        data: {
          player_id: { value: playerId },
          profile_name: { value: profileName },
          amount: { value: String(await buildResponsePrice(plan)) },
        },
      });
    } catch (error) {
      const status = Number(error?.response?.status || 0);
      if ([400, 404, 422].includes(status) || error?.code === "PLAYER_NOT_FOUND") {
        return res.json({ serviceId, timestamp: Date.now(), status: "FAILED", errorCode: "10007" });
      }
      return res.json({ serviceId, timestamp: Date.now(), status: "FAILED", errorCode: "99999" });
    }
  }

  async create(req, res) {
    applyUzumHttpStatus(res);
    const serviceId = Number(req.body?.serviceId || 0);
    if (!isServiceIdValid(serviceId)) return invalidServiceId(res, serviceId || req.body?.serviceId);
    if (!isAuthValid(req)) return authFailed(res, serviceId);

    const transId = getTransIdFromBody(req.body);
    const playerId = getPlayerIdFromBody(req.body);
    const planCode = getPlanCodeFromBody(req.body);
    const priceAmount = getPriceAmountFromBody(req.body);
    if (!transId || !playerId || !planCode || !priceAmount) return missingParams(res, serviceId);
    if (!/^5\d+$/.test(playerId)) {
      return res.json({ serviceId, timestamp: Date.now(), status: "FAILED", errorCode: "10007" });
    }

    const duplicate = await Order.findOne({ paymentEventKey: transId }).lean();
    if (duplicate) {
      return res.json({
        serviceId,
        transId,
        transTime: duplicate?.createdAt ? new Date(duplicate.createdAt).getTime() : Date.now(),
        status: "FAILED",
        errorCode: "10008",
      });
    }

    const plan = await resolvePlan(planCode);
    if (!plan) return res.json({ serviceId, timestamp: Date.now(), status: "FAILED", errorCode: "10007" });
    const expectedAmount = Math.max(0, Math.round(Number(plan.basePrice || 0)));
    if (expectedAmount <= 0) return res.json({ serviceId, timestamp: Date.now(), status: "FAILED", errorCode: "10007" });
    // Uzum sends price_amount in tiyin, while plans and orders store UZS.
    const expectedPriceAmountInTiyin = expectedAmount * 100;
    if (priceAmount !== expectedPriceAmountInTiyin) {
      return res.json({ serviceId, timestamp: Date.now(), status: "FAILED", errorCode: "10011" });
    }

    let profileName = `Player ID: ${playerId}`;
    try {
      const trxid = `UZM-PUBG-CRT-${serviceId}-${Date.now()}`.slice(0, 80);
      const verify = await verifyPubgPlayer(playerId, trxid);
      const verifiedName = String(verify?.playerName || verify?.name || "").trim();
      if (!verify?.success || !verifiedName) {
        return res.json({ serviceId, timestamp: Date.now(), status: "FAILED", errorCode: "10007" });
      }
      profileName = verifiedName;
    } catch (error) {
      const status = Number(error?.response?.status || 0);
      if ([400, 404, 422].includes(status) || error?.code === "PLAYER_NOT_FOUND") {
        return res.json({ serviceId, timestamp: Date.now(), status: "FAILED", errorCode: "10007" });
      }
      return res.json({ serviceId, timestamp: Date.now(), status: "FAILED", errorCode: "99999" });
    }

    const nextOrderId = await getNextOrderId();
    const order = await Order.create({
      orderId: nextOrderId,
      product: "uc",
      planCode,
      username: playerId,
      playerId,
      profileName,
      tgUserId: "",
      tgUsername: "",
      paymentMethod: "uzumbank",
      expectedAmount,
      paymentMatchAmount: expectedAmount,
      paidAmount: expectedAmount,
      paidAt: new Date(),
      status: "paid_auto_processed",
      fulfillmentStatus: "pending",
      completionMode: "auto",
      paymentEventKey: transId,
      sequence: nextOrderId,
      fragmentTx: {
        provider: "uzum",
        source: "uzum",
        transId,
        planCode,
      },
    });

    if (!order) {
      return res.json({ serviceId, timestamp: Date.now(), status: "FAILED", errorCode: "10009" });
    }

    emitUserUpdate(order.tgUserId, {
      type: "order_created",
      refreshOrders: true,
      refreshBalance: false,
      orderId: order._id,
      status: order.status,
      product: order.product,
    });

    return res.json({
      serviceId,
      transId,
      status: "CREATED",
      transTime: order?.createdAt ? new Date(order.createdAt).getTime() : Date.now(),
      data: {},
      amount: expectedPriceAmountInTiyin,
    });
  }

  async confirm(req, res) {
    applyUzumHttpStatus(res);
    const serviceId = Number(req.body?.serviceId || 0);
    if (!isServiceIdValid(serviceId)) return invalidServiceId(res, serviceId || req.body?.serviceId);
    if (!isAuthValid(req)) return authFailed(res, serviceId);

    const transId = getTransIdFromBody(req.body);
    if (!transId) return missingParams(res, serviceId);

    const order = await Order.findOne({ paymentEventKey: transId }).lean();
    if (!order) {
      return res.json({ serviceId, transId, status: "FAILED", errorCode: "10014" });
    }
    if (order.status === "cancelled" || order.status === "failed") {
      return res.json({ serviceId, transId, confirmTime: null, status: "FAILED", errorCode: "10015" });
    }
    if (order.status === "reversed") {
      return res.json({
        serviceId,
        transId,
        status: "REVERSED",
        confirmTime: null,
        reverseTime: order.updatedAt ? new Date(order.updatedAt).getTime() : Date.now(),
        errorCode: "10014",
      });
    }

    let finalOrder = order;
    if (!isFulfillmentSuccessful(finalOrder)) {
      if (!isGwPubgAutobuyEnabled()) {
        return res.json({ serviceId, transId, confirmTime: null, status: "FAILED", errorCode: "10015" });
      }

      let fulfillmentResult;
      try {
        fulfillmentResult = await autoFulfillGwPubg(order);
      } catch (error) {
        console.error("Uzum PUBG auto fulfill error:", order._id, error.message);
        return res.json({ serviceId, transId, status: "FAILED", errorCode: "99999" });
      }

      finalOrder = fulfillmentResult?.order?.toObject
        ? fulfillmentResult.order.toObject()
        : fulfillmentResult?.order || await Order.findById(order._id).lean();

      if (!isFulfillmentSuccessful(finalOrder) && !isFulfillmentTerminalFailure(finalOrder)) {
        finalOrder = await waitForFulfillmentResult(finalOrder || order);
      }
    }

    if (!isFulfillmentSuccessful(finalOrder)) {
      return res.json({ serviceId, transId, confirmTime: null, status: "FAILED", errorCode: "10015" });
    }

    return res.json(buildConfirmedResponse(serviceId, transId, finalOrder));
  }

  async status(req, res) {
    applyUzumHttpStatus(res);
    const serviceId = Number(req.body?.serviceId || 0);
    if (!isServiceIdValid(serviceId)) return invalidServiceId(res, serviceId || req.body?.serviceId);
    if (!isAuthValid(req)) return authFailed(res, serviceId);

    const transId = getTransIdFromBody(req.body);
    if (!transId) return missingParams(res, serviceId);

    const order = await Order.findOne({ paymentEventKey: transId }).lean();
    if (!order) {
      return res.json({ serviceId, transId, status: "FAILED", errorCode: "10014" });
    }

    if (order.status === "reversed") {
      return res.json({
        serviceId,
        transId,
        status: "REVERSED",
        transTime: order.createdAt ? new Date(order.createdAt).getTime() : Date.now(),
        confirmTime: order.updatedAt ? new Date(order.updatedAt).getTime() : Date.now(),
        reverseTime: order.updatedAt ? new Date(order.updatedAt).getTime() : Date.now(),
        errorCode: "10014",
      });
    }

    if (isFulfillmentSuccessful(order)) {
      return res.json({
        serviceId,
        transId,
        status: "CONFIRMED",
        transTime: order.createdAt ? new Date(order.createdAt).getTime() : Date.now(),
        confirmTime: order.updatedAt ? new Date(order.updatedAt).getTime() : Date.now(),
        reverseTime: null,
        data: {
          player_id: { value: String(order.playerId || order.username || "") },
          profile_name: { value: String(order.profileName || "") },
          amount: { value: String(Math.max(0, Math.round(Number(order.expectedAmount || order.paidAmount || 0)))) },
        },
        amount: Math.max(0, Math.round(Number(order.expectedAmount || order.paidAmount || 0))) * 100,
      });
    }

    return res.json({
      serviceId,
      transId,
      status: "FAILED",
      errorCode: "10014",
    });
  }
}

module.exports = new UzumPubgController();
