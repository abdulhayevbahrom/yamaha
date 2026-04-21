const Order = require("../model/order.model");
const Plan = require("../model/plan.model");
const { sendOrderArchive } = require("./order-archive.service");
const { emitUserUpdate } = require("../socket");
const { awardReferralCommissionForOrder } = require("./referral.service");
const {
  buyStars: buyStarsFromFragment,
  buyPremium: buyPremiumFromFragment,
} = require("./fragment-api.service");

function getFragmentErrorPayload(error) {
  const fragmentPayload = error?.fragmentPayload;
  if (
    fragmentPayload &&
    typeof fragmentPayload === "object" &&
    !Array.isArray(fragmentPayload)
  ) {
    return fragmentPayload;
  }

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

function buildFragmentTransaction({
  productType,
  recipient,
  amount,
  purchase,
}) {
  return {
    provider: "fragment-api.uz",
    providerVersion: "v1",
    productType,
    recipient,
    amount,
    requestedAt: new Date(),
    purchase: purchase?.raw || null,
    result: purchase?.result || null,
  };
}

async function buyStars(recipient, amount) {
  const purchase = await buyStarsFromFragment(recipient, amount);
  return {
    fragment: buildFragmentTransaction({
      productType: "stars",
      recipient,
      amount,
      purchase,
    }),
  };
}

async function buyPremium(recipient, months) {
  const purchase = await buyPremiumFromFragment(recipient, months);
  return {
    fragment: buildFragmentTransaction({
      productType: "premium",
      recipient,
      amount: months,
      purchase,
    }),
  };
}

async function markFulfillmentSuccess(order, result) {
  await Order.findByIdAndUpdate(order._id, {
    status: "completed",
    fulfillmentStatus: "success",
    fulfilledAt: new Date(),
    fragmentTx: result.fragment || result || null,
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
async function markFulfillmentFailure(order, error) {
  const errorMessage = error.message || "Auto buy xatolik";

  await Order.findByIdAndUpdate(order._id, {
    fulfillmentStatus: "failed",
    fulfillmentError: errorMessage,
    fragmentTx: getFragmentErrorPayload(error),
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

  return { ok: false, error: errorMessage };
}

async function autoFulfillOrder(orderOrId) {
  const orderId =
    typeof orderOrId === "object" && orderOrId?._id
      ? orderOrId._id
      : orderOrId;
  const order = await Order.findById(orderId).lean();

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

    try {
      const result = await buyStars(recipient, amount);
      return markFulfillmentSuccess(order, result);
    } catch (error) {
      return markFulfillmentFailure(order, error);
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

  try {
    let result;
    if (order.product === "star") {
      result = await buyStars(recipient, plan.amount);
    } else {
      result = await buyPremium(recipient, plan.amount);
    }

    return markFulfillmentSuccess(order, result);
  } catch (error) {
    return markFulfillmentFailure(order, error);
  }
}

module.exports = {
  buyStars,
  buyPremium,
  autoFulfillOrder,
};
