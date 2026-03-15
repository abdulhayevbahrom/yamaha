const response = require("../utils/response");
const Plan = require("../model/plan.model");
const Order = require("../model/order.model");
const User = require("../model/user.model");
const { getNextOrderId } = require("../services/order-id.service");
// const { ensureDefaultPlans } = require("../services/plan.service");
const { processIncomingPayment } = require("../services/payment-match.service");
const { autoFulfillOrder } = require("../services/avtoBuy.service");
const { confirmUcOrderById } = require("../services/uc-fulfillment.service");
const { notifyUcPaid } = require("../services/notify.service");
const { getIO } = require("../socket");
const { getStarPricing } = require("../services/settings.service");

let sequence = 1;
const PENDING_TTL_MS = 10 * 60 * 1000;

async function syncSequence() {
  const latest = await Order.findOne().sort({ createdAt: -1 }).lean();
  if (latest?.sequence && latest.sequence >= sequence) {
    sequence = latest.sequence + 1;
  }
}

async function expirePendingOrders() {
  const now = new Date();
  await Order.updateMany(
    { status: "pending_payment", expiresAt: { $lt: now } },
    { $set: { status: "cancelled" } },
  );
}

async function getUniquePendingAmount({ product, planCode, basePrice }) {
  const now = Date.now();
  const aliveFrom = new Date(now - PENDING_TTL_MS);
  const pendingCount = await Order.countDocuments({
    status: "pending_payment",
    createdAt: { $gte: aliveFrom },
    expiresAt: { $gt: new Date(now) },
  });

  return Number(basePrice) + Number(pendingCount);
}

async function getReport(period) {
  const periodDays = { week: 7, month: 30, year: 365 };
  const days = periodDays[period] || 30;
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const recent = await Order.find({ createdAt: { $gte: startDate } }).lean();

  const totalAmount = recent.reduce(
    (sum, order) => sum + order.expectedAmount,
    0,
  );
  const paidAmount = recent.reduce((sum, order) => sum + order.paidAmount, 0);

  return {
    period,
    totalAmount: Number(totalAmount.toFixed(0)),
    paidAmount: Number(paidAmount.toFixed(0)),
    totalOrders: recent.length,
    byType: {
      star: recent.filter((o) => o.product === "star").length,
      premium: recent.filter((o) => o.product === "premium").length,
      uc: recent.filter((o) => o.product === "uc").length,
    },
    trend: Array.from({ length: 7 }).map((_, i) => {
      const dayStart = new Date(Date.now() - (6 - i) * 24 * 60 * 60 * 1000);
      const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
      const dayOrders = recent.filter((order) => {
        const created = new Date(order.createdAt);
        return created >= dayStart && created < dayEnd;
      });

      return {
        label: dayStart.toLocaleDateString("uz-UZ", {
          month: "short",
          day: "numeric",
        }),
        amount: Number(
          dayOrders
            .reduce((sum, order) => sum + order.expectedAmount, 0)
            .toFixed(0),
        ),
      };
    }),
  };
}

const calculatePrice = async (req, res) => {
  try {
    const { product, planCode, customAmount } = req.body;
    // await ensureDefaultPlans();
    await expirePendingOrders();

    if (product === "star") {
      const isCustom =
        planCode === "custom" || Number(customAmount || 0) > 0;
      if (isCustom) {
        const pricing = await getStarPricing();
        const qty = Number(customAmount || 0);
        if (!qty || qty < pricing.min || qty > pricing.max) {
          return response.error(res, "custom amount noto'g'ri");
        }
        const basePrice = qty * Number(pricing.pricePerStar || 0);
        const amount = await getUniquePendingAmount({
          product,
          planCode: "custom",
          basePrice,
        });
        return response.success(res, "Narx hisoblandi", {
          product,
          planCode: "custom",
          amount,
          baseAmount: basePrice,
          expiresInSeconds: 600,
          currency: "UZS",
        });
      }
    }

    const plan = await Plan.findOne({
      category: product,
      code: planCode,
      isActive: true,
    }).lean();
    if (!plan) return response.error(res, "invalid plan");

    const amount = await getUniquePendingAmount({
      product,
      planCode,
      basePrice: plan.basePrice,
    });
    return response.success(res, "Narx hisoblandi", {
      product,
      planCode,
      amount,
      baseAmount: plan.basePrice,
      expiresInSeconds: 600,
      currency: plan.currency || "UZS",
    });
  } catch (error) {
    return response.serverError(res, "Narx hisoblashda xatolik", error.message);
  }
};

const createOrder = async (req, res) => {
  try {
    const {
      product,
      planCode,
      username,
      profileName = "",
      customAmount,
      expectedAmount,
      paidAmount = 0,
      paymentMethod = "card",
      status,
    } = req.body;
    const tgUserId = String(req.headers["x-tg-user-id"] || "").trim();
    const tgUsername = String(req.headers["x-tg-username"] || "").trim();

    if (!["star", "premium", "uc"].includes(product))
      return response.error(res, "invalid product");
    if (!username) return response.error(res, "username required");

    // await ensureDefaultPlans();
    await expirePendingOrders();
    await syncSequence();

    let plan = null;
    let resolvedAmount = 0;
    let resolvedBasePrice = 0;

    const isCustomStar =
      product === "star" &&
      (planCode === "custom" ||
        Number(customAmount || 0) > 0 ||
        /^[0-9]+$/.test(String(planCode || "")));

    if (isCustomStar) {
      const pricing = await getStarPricing();
      const qty = Number(customAmount || planCode || 0);
      if (!qty || qty < pricing.min || qty > pricing.max) {
        return response.error(res, "custom amount noto'g'ri");
      }
      resolvedAmount = qty;
      resolvedBasePrice = qty * Number(pricing.pricePerStar || 0);
      plan = { basePrice: resolvedBasePrice, amount: qty };
    } else {
      plan = await Plan.findOne({
        category: product,
        code: planCode,
        isActive: true,
      }).lean();
      if (!plan) return response.error(res, "invalid plan");
      resolvedAmount = plan.amount;
      resolvedBasePrice = plan.basePrice;
    }

    let paid = Number(paidAmount || 0);
    let expected = Number(expectedAmount || 0);
    let expiresAt = null;
    let finalStatus = status;
    let paidAt = null;

    if (paymentMethod === "balance") {
      if (!tgUserId) return response.error(res, "tg_user_id required");
      expected = Number(resolvedBasePrice || 0);
      const user = await User.findOneAndUpdate(
        { tgUserId, balance: { $gte: expected } },
        { $inc: { balance: -expected } },
        { new: true },
      ).lean();
      if (!user) return response.error(res, "Balans yetarli emas");

      paid = expected;
      paidAt = new Date();
      finalStatus = "paid_auto_processed";
      expiresAt = null;
    } else if (!finalStatus) {
      finalStatus =
        paid >= expected && expected > 0
          ? "paid_auto_processed"
          : "pending_payment";
    }

    if (finalStatus === "pending_payment") {
      expected = await getUniquePendingAmount({
        product,
        planCode,
        basePrice: resolvedBasePrice,
      });
      expiresAt = new Date(Date.now() + PENDING_TTL_MS);
    }

    const nextOrderId = await getNextOrderId();
    const order = await Order.create({
      orderId: nextOrderId,
      product,
      planCode,
      customAmount: Number(customAmount || 0),
      username,
      profileName,
      paymentMethod,
      expectedAmount: expected,
      paidAmount: paid,
      paidAt,
      status: finalStatus,
      expiresAt,
      sequence,
      tgUserId,
      tgUsername,
    });

    if (finalStatus === "paid_auto_processed") {
      if (product === "uc") {
        const io = getIO();
        if (io) {
          io.emit("admin-uc-paid", {
            orderId: order._id,
            orderCode: order.orderId,
            username: order.username,
            planCode: order.planCode,
            expectedAmount: order.expectedAmount,
            paidAmount: order.paidAmount,
            paidAt: order.paidAt,
          });
        }
        notifyUcPaid({
          orderId: order._id,
          orderCode: order.orderId,
          username: order.username,
          planCode: order.planCode,
          expectedAmount: order.expectedAmount,
        });
      }

      if (product === "star" || product === "premium") {
        await autoFulfillOrder(order);
      }
    }

    sequence += 1;
    return response.created(res, "Buyurtma yaratildi", order);
  } catch (error) {
    return response.serverError(
      res,
      "Buyurtma yaratishda xatolik",
      error.message,
    );
  }
};

const getReports = async (req, res) => {
  try {
    await expirePendingOrders();
    const period = String(req.query.period || "month");
    return response.success(res, "Report", await getReport(period));
  } catch (error) {
    return response.serverError(res, "Hisobot olishda xatolik", error.message);
  }
};

const getHistory = async (_, res) => {
  try {
    await expirePendingOrders();
    const orders = await Order.find().sort({ createdAt: -1 }).limit(100).lean();
    return response.success(res, "Tarix", orders);
  } catch (error) {
    return response.serverError(res, "Tarix olishda xatolik", error.message);
  }
};

const processCardPayment = async (req, res) => {
  try {
    const {
      text = "",
      amount = null,
      externalMessageId = null,
      source = "cardxabar",
    } = req.body;
    const result = await processIncomingPayment({
      rawText: text,
      amount,
      externalMessageId,
      source,
    });

    if (result.matched) {
      return response.success(
        res,
        "To'lov matched va order paid bo'ldi",
        result,
      );
    }
    return response.warning(
      res,
      "To'lov qayta ishlangan, lekin order topilmadi",
      result,
    );
  } catch (error) {
    return response.serverError(
      res,
      "To'lov xabarini qayta ishlashda xatolik",
      error.message,
    );
  }
};

const confirmUcOrder = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await confirmUcOrderById(id);
    if (!result.ok) {
      if (result.reason === "not_found")
        return response.notFound(res, "Order topilmadi");
      if (result.reason === "not_uc")
        return response.error(res, "Bu order UC emas");
      if (result.reason === "not_paid")
        return response.error(res, "Order hali to'lanmagan");
      return response.error(res, "UC tasdiqlashda xatolik");
    }

    return response.success(res, "UC order yakunlandi", result.order);
  } catch (error) {
    return response.serverError(res, "UC tasdiqlashda xatolik", error.message);
  }
};

const retryFulfillment = async (req, res) => {
  try {
    const { id } = req.params;
    const order = await Order.findById(id).lean();
    if (!order) return response.notFound(res, "Order topilmadi");

    const result = await autoFulfillOrder(order);
    if (result?.ok) {
      return response.success(res, "Auto buy qayta bajarildi", result);
    }
    return response.warning(res, "Auto buy bajarilmadi", result);
  } catch (error) {
    return response.serverError(
      res,
      "Auto buy retry xatolik",
      error.message,
    );
  }
};

module.exports = {
  calculatePrice,
  createOrder,
  getReports,
  getHistory,
  processCardPayment,
  retryFulfillment,
  confirmUcOrder,
};
