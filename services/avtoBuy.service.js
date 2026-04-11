const axios = require("axios");
const { getTonkeeperService } = require("./tonkeeper/tonkeeper.service");
const Order = require("../model/order.model");
const Plan = require("../model/plan.model");
const { sendOrderArchive } = require("./order-archive.service");
const { emitUserUpdate } = require("../socket");
const { awardReferralCommissionForOrder } = require("./referral.service");

const API_KEY = process.env.ROBYNHOOD_API_KEY;
const API_URL =
  process.env.ROBYNHOOD_API_URL || "https://robynhood.parssms.info/api";
const FRAGMENT_TEST_MODE =
  String(process.env.FRAGMENT_TEST_MODE || "false") === "true";
const FRAGMENT_PAY_TON =
  String(process.env.FRAGMENT_PAY_TON || "true") !== "false";

const api = axios.create({
  baseURL: API_URL,
  headers: {
    "Content-Type": "application/json",
    "X-API-Key": API_KEY,
  },
  timeout: 30000,
});

const tonkeeper = getTonkeeperService();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const DUPLICATE_IDEMPOTENCY_MESSAGE =
  "Fragment so'rovi oldin yuborilgan. Natija tekshirilmoqda.";

function buildFragmentIdempotencyKey(productType, recipient, transactionId) {
  return `${productType}_${String(recipient || "").replace(
    /[@\W]/g,
    "",
  )}_${transactionId}`;
}

function getFragmentErrorPayload(error) {
  const responseData = error?.response?.data;
  if (
    responseData &&
    typeof responseData === "object" &&
    !Array.isArray(responseData)
  ) {
    return responseData;
  }
  if (responseData) {
    return { error: String(responseData) };
  }
  if (error?.message) {
    return { error: String(error.message) };
  }
  return null;
}

function getFragmentErrorMessage(error) {
  const payload = getFragmentErrorPayload(error);
  return String(
    payload?.error || payload?.message || error?.message || "",
  ).trim();
}

function isDuplicateIdempotencyError(error) {
  const normalized = getFragmentErrorMessage(error).toLowerCase();
  return (
    normalized.includes("transaction already exists with idempotency key") ||
    (normalized.includes("idempotency key") &&
      normalized.includes("already exists"))
  );
}

function appendIdempotencyKey(payload, idempotencyKey) {
  if (!idempotencyKey) return payload || null;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return {
      ...payload,
      idempotencyKey,
    };
  }
  return {
    data: payload || null,
    idempotencyKey,
  };
}

const retryOperation = async (operation, maxRetries = 3) => {
  let lastError;
  for (let i = 0; i < maxRetries; i += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (isDuplicateIdempotencyError(error)) {
        console.warn(
          "Fragment duplicate idempotency aniqlandi:",
          getFragmentErrorPayload(error) || error.message,
        );
        break;
      }
      console.error(
        `Fragment urinish ${i + 1}/${maxRetries} muvaffaqiyatsiz:`,
        error.response?.data || error.message,
      );
      if (i < maxRetries - 1) {
        await sleep(5000);
      }
    }
  }
  throw lastError;
};

function ensureApiKey() {
  if (!API_KEY) {
    throw new Error("ROBYNHOOD_API_KEY .env da topilmadi");
  }
}

async function getProductPriceTON(productType, { quantity, months, amount }) {
  ensureApiKey();
  const params = { product_type: productType };
  if (quantity) params.quantity = String(quantity);
  if (months) params.months = String(months);
  if (amount) params.amount = String(amount);

  const response = await api.get("/api/prices", { params });
  let priceObj = response.data;
  if (Array.isArray(priceObj)) priceObj = priceObj[0];

  if (priceObj.currency !== "TON") {
    throw new Error(
      `Kutilmagan valyuta: ${priceObj.currency}. Faqat TON qo'llab-quvvatlanadi.`,
    );
  }

  const priceInTON = parseFloat(priceObj.price);
  if (Number.isNaN(priceInTON) || priceInTON <= 0) {
    throw new Error("Narx noto'g'ri: " + JSON.stringify(response.data));
  }

  return priceInTON;
}

async function getTonPrice(productType, amount) {
  if (productType === "stars") {
    return getProductPriceTON("stars", { quantity: amount });
  }
  if (productType === "premium") {
    return getProductPriceTON("premium", { months: amount });
  }
  throw new Error(`Noto'g'ri product type: ${productType}`);
}

async function getAccountInfo() {
  ensureApiKey();
  const response = await api.get("/api/balance");
  return response.data;
}

async function createTopupInvoice(amount) {
  ensureApiKey();
  const payload = { amount: Number(amount) };
  const response = await api.post("/merchants/topup", payload, {
    headers: { "X-API-Key": API_KEY },
  });
  return response.data;
}

async function ensureFragmentBalance(requiredTonAmount) {
  const fragmentAccount = await getAccountInfo();
  const currentBalance = parseFloat(fragmentAccount.mainnet_balance || 0);

  const SAFETY_MARGIN = 0.05;
  const minRequired = requiredTonAmount + SAFETY_MARGIN;

  if (currentBalance >= requiredTonAmount) return true;

  const topupAmount = Number((minRequired - currentBalance + 0.01).toFixed(6));
  const invoice = await createTopupInvoice(topupAmount);

  const sendAmount = parseFloat(invoice.amount);
  const walletAddress = invoice.wallet_address;

  const tkBalance = await tonkeeper.getBalance();
  if (tkBalance >= sendAmount) {
    await tonkeeper.sendTon(
      walletAddress,
      sendAmount,
      "Auto top-up to Fragment",
    );
  } else {
    throw new Error(
      `Tonkeeper balansida yetarli TON yo'q. Kerak: ${sendAmount.toFixed(
        6,
      )} TON, Bor: ${tkBalance.toFixed(6)} TON`,
    );
  }

  for (let i = 0; i < 18; i += 1) {
    await sleep(5000);
    const updatedAccount = await getAccountInfo();
    const newBalance = parseFloat(updatedAccount.mainnet_balance || 0);
    if (newBalance >= requiredTonAmount) return true;
  }

  throw new Error("Deposit 90 soniyada tasdiqlanmadi.");
}

async function purchaseFragment({
  productType,
  recipient,
  quantity,
  months,
  transactionId,
  isTest = false,
}) {
  const endpoint = isTest ? "/test/purchase" : "/api/purchase";
  const idempotencyKey = buildFragmentIdempotencyKey(
    productType,
    recipient,
    transactionId,
  );
  const payload = {
    product_type: productType,
    recipient,
    idempotency_key: idempotencyKey,
  };
  if (quantity) payload.quantity = String(quantity);
  if (months) payload.months = String(months);

  const response = await api.post(endpoint, payload);
  return {
    data: response.data,
    idempotencyKey,
  };
}

async function buyStars(recipient, amount, transactionId, options = {}) {
  const tonAmount = await getTonPrice("stars", amount);
  const payTon = options.payTon !== false;
  const isTest = options.isTest === true;

  if (payTon && !isTest) {
    await ensureFragmentBalance(tonAmount);
  }

  const { data: fragment, idempotencyKey } = await retryOperation(() =>
    purchaseFragment({
      productType: "stars",
      recipient,
      quantity: amount,
      transactionId,
      isTest,
    }),
  );

  return { fragment, tonAmount, idempotencyKey };
}

async function buyPremium(recipient, months, transactionId, options = {}) {
  const tonAmount = await getTonPrice("premium", months);
  const payTon = options.payTon !== false;
  const isTest = options.isTest === true;

  if (payTon && !isTest) {
    await ensureFragmentBalance(tonAmount);
  }

  const { data: fragment, idempotencyKey } = await retryOperation(() =>
    purchaseFragment({
      productType: "premium",
      recipient,
      months,
      transactionId,
      isTest,
    }),
  );

  return { fragment, tonAmount, idempotencyKey };
}

function buildDuplicateFragmentTx(order, error, idempotencyKey) {
  const previousTx =
    order?.fragmentTx &&
    typeof order.fragmentTx === "object" &&
    !Array.isArray(order.fragmentTx)
      ? order.fragmentTx
      : {};

  return {
    ...previousTx,
    duplicateIdempotency: true,
    duplicateCount: Number(previousTx.duplicateCount || 0) + 1,
    duplicateDetectedAt: new Date(),
    lastError: getFragmentErrorPayload(error),
    idempotencyKey: idempotencyKey || previousTx.idempotencyKey || "",
  };
}

async function markFulfillmentSuccess(order, result) {
  await Order.findByIdAndUpdate(order._id, {
    fulfillmentStatus: "success",
    fulfilledAt: new Date(),
    tonAmount: result.tonAmount || 0,
    fragmentTx: appendIdempotencyKey(
      result.fragment || result,
      result.idempotencyKey,
    ),
    fulfillmentError: "",
  });
  await sendOrderArchive(order);
  if (order.tgUserId) {
    emitUserUpdate(order.tgUserId, {
      type: "order_fulfilled",
      refreshOrders: true,
      orderId: order._id,
      status: order.status,
      fulfillmentStatus: "success",
      product: order.product,
    });
  }

  try {
    await awardReferralCommissionForOrder(order);
  } catch (error) {
    console.error(
      "Referral commission apply error:",
      order._id?.toString?.() || order._id,
      error.message,
    );
  }

  return { ok: true, result };
}

async function markDuplicateFulfillment(order, error, idempotencyKey) {
  await Order.findByIdAndUpdate(order._id, {
    fulfillmentStatus: "processing",
    fulfillmentError: DUPLICATE_IDEMPOTENCY_MESSAGE,
    fragmentTx: buildDuplicateFragmentTx(order, error, idempotencyKey),
  });
  if (order.tgUserId) {
    emitUserUpdate(order.tgUserId, {
      type: "order_fulfillment_processing",
      refreshOrders: true,
      orderId: order._id,
      status: order.status,
      fulfillmentStatus: "processing",
      product: order.product,
    });
  }

  return {
    ok: false,
    duplicate: true,
    recoverable: true,
    error: DUPLICATE_IDEMPOTENCY_MESSAGE,
    idempotencyKey,
  };
}

async function markFulfillmentFailure(order, error, idempotencyKey) {
  const errorMessage = error.message || "Auto buy xatolik";
  await Order.findByIdAndUpdate(order._id, {
    fulfillmentStatus: "failed",
    fulfillmentError: errorMessage,
    fragmentTx: appendIdempotencyKey(
      getFragmentErrorPayload(error),
      idempotencyKey,
    ),
  });
  if (order.tgUserId) {
    emitUserUpdate(order.tgUserId, {
      type: "order_fulfillment_failed",
      refreshOrders: true,
      orderId: order._id,
      status: order.status,
      fulfillmentStatus: "failed",
      product: order.product,
    });
  }

  return { ok: false, error: errorMessage, idempotencyKey };
}

async function autoFulfillOrder(orderOrId) {
  const order =
    typeof orderOrId === "object" && orderOrId?._id
      ? orderOrId
      : await Order.findById(orderOrId).lean();

  if (!order) return { skipped: true, reason: "order_not_found" };
  if (order.status !== "paid_auto_processed") {
    return { skipped: true, reason: "not_paid" };
  }
  if (!["star", "premium"].includes(order.product)) {
    return { skipped: true, reason: "unsupported_product" };
  }
  if (order.fulfillmentStatus === "processing") {
    return { skipped: true, reason: "already_processing" };
  }
  if (order.fulfillmentStatus === "success") {
    return { skipped: true, reason: "already_fulfilled" };
  }

  const plan = await Plan.findOne({
    category: order.product,
    code: order.planCode,
  }).lean();
  if (!plan && order.product === "star" && order.planCode === "custom") {
    // custom amount for stars
    const amount = Number(order.customAmount || 0);
    if (!amount) {
      await Order.findByIdAndUpdate(order._id, {
        fulfillmentStatus: "failed",
        fulfillmentError: "Custom star miqdori topilmadi",
      });
      return { ok: false, error: "Custom star miqdori topilmadi" };
    }

    await Order.findByIdAndUpdate(order._id, {
      fulfillmentStatus: "processing",
      fulfillmentStartedAt: new Date(),
      fulfillmentError: "",
    });

    const recipient = String(order.username || "")
      .replace(/^@/, "")
      .trim();
    const transactionId = String(order.orderId || order._id);

    try {
      const result = await buyStars(recipient, amount, transactionId, {
        payTon: FRAGMENT_PAY_TON,
        isTest: FRAGMENT_TEST_MODE,
      });

      return markFulfillmentSuccess(order, result);
    } catch (error) {
      if (isDuplicateIdempotencyError(error)) {
        return markDuplicateFulfillment(
          order,
          error,
          buildFragmentIdempotencyKey("stars", recipient, transactionId),
        );
      }

      return markFulfillmentFailure(
        order,
        error,
        buildFragmentIdempotencyKey("stars", recipient, transactionId),
      );
    }
  }

  if (!plan) {
    await Order.findByIdAndUpdate(order._id, {
      fulfillmentStatus: "failed",
      fulfillmentError: "Plan topilmadi",
    });
    return { ok: false, error: "Plan topilmadi" };
  }

  await Order.findByIdAndUpdate(order._id, {
    fulfillmentStatus: "processing",
    fulfillmentStartedAt: new Date(),
    fulfillmentError: "",
  });

  const recipient = String(order.username || "")
    .replace(/^@/, "")
    .trim();
  const transactionId = String(order.orderId || order._id);

  try {
    let result;
    if (order.product === "star") {
      result = await buyStars(recipient, plan.amount, transactionId, {
        payTon: FRAGMENT_PAY_TON,
        isTest: FRAGMENT_TEST_MODE,
      });
    } else {
      result = await buyPremium(recipient, plan.amount, transactionId, {
        payTon: FRAGMENT_PAY_TON,
        isTest: FRAGMENT_TEST_MODE,
      });
    }

    return markFulfillmentSuccess(order, result);
  } catch (error) {
    const productType = order.product === "premium" ? "premium" : "stars";
    if (isDuplicateIdempotencyError(error)) {
      return markDuplicateFulfillment(
        order,
        error,
        buildFragmentIdempotencyKey(productType, recipient, transactionId),
      );
    }

    return markFulfillmentFailure(
      order,
      error,
      buildFragmentIdempotencyKey(productType, recipient, transactionId),
    );
  }
}

module.exports = {
  buyStars,
  buyPremium,
  autoFulfillOrder,
};
