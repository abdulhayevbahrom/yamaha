const response = require("../utils/response");
const Plan = require("../model/plan.model");
const Order = require("../model/order.model");
const User = require("../model/user.model");
const mongoose = require("mongoose");
const { getNextOrderId } = require("../services/order-id.service");
const { processIncomingPayment } = require("../services/payment-match.service");
const { autoFulfillOrder } = require("../services/avtoBuy.service");
const {
  confirmGameOrderById,
  cancelGameOrderById,
  isManualGameProduct,
} = require("../services/uc-fulfillment.service");
const { cancelPaidOrderById } = require("../services/order-cancel.service");
const { notifyGamePaid } = require("../services/notify.service");
const { emitAdminUpdate, emitUserUpdate } = require("../socket");
const { getStarPricing } = require("../services/settings.service");
const { getTelegramUserFromRequest } = require("../utils/tg-user");
const { selectPaymentCardForType } = require("../services/payment-card.service");

let sequence = 1;
const PENDING_TTL_MS = 10 * 60 * 1000;

async function resolvePaymentCardSelection(type) {
  const selected = await selectPaymentCardForType(type);
  if (!selected?.paymentCardSnapshot) {
    throw new Error("Hozircha to'lov kartasi mavjud emas");
  }
  return selected;
}

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
      freefire: recent.filter((o) => o.product === "freefire").length,
      mlbb: recent.filter((o) => o.product === "mlbb").length,
      balance: recent.filter((o) => o.product === "balance").length,
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
    await expirePendingOrders();

    if (product === "star") {
      const isCustom =
        planCode === "custom" || Number(customAmount || 0) > 0;
      if (isCustom) {
        const pricing = await getStarPricing();
        const qty = Number(customAmount || 0);
        if (!qty || qty < pricing.min || qty > pricing.max) {
          return response.error(res, "Tanlangan miqdor noto'g'ri");
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
    if (!plan) return response.error(res, "Tanlangan paket topilmadi");

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
      playerId = "",
      zoneId = "",
      profileName = "",
      customAmount,
      expectedAmount,
      paidAmount = 0,
      paymentMethod = "card",
      status,
    } = req.body;
    const { tgUserId, username: tgUsername } = getTelegramUserFromRequest(req);

    if (!tgUserId) {
      return response.error(
        res,
        "Telegram profilingiz aniqlanmadi. Ilovani qayta ochib ko'ring.",
      );
    }
    const currentUser = await User.findOne({ tgUserId })
      .select({ isBlocked: 1 })
      .lean();
    if (currentUser?.isBlocked) {
      return response.error(res, "Foydalanuvchi bloklangan");
    }
    if (!["star", "premium", "uc", "freefire", "mlbb"].includes(product)) {
      return response.error(res, "Tanlangan mahsulot noto'g'ri");
    }
    const normalizedPlayerId = String(playerId || "").trim();
    const normalizedZoneId = String(zoneId || "").trim();
    const normalizedUsername = String(username || "").trim();

    if (product === "mlbb") {
      if (!normalizedPlayerId || !normalizedZoneId) {
        return response.error(res, "Player ID va Zone ID kiriting");
      }
    } else if (!normalizedUsername) {
      return response.error(res, "Username kiriting");
    }

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
        return response.error(res, "Tanlangan miqdor noto'g'ri");
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
      if (!plan) return response.error(res, "Tanlangan paket topilmadi");
      resolvedAmount = plan.amount;
      resolvedBasePrice = plan.basePrice;
    }

    let paid = Number(paidAmount || 0);
    let expected = Number(expectedAmount || 0);
    let expiresAt = null;
    let finalStatus = status;
    let paidAt = null;
    let paymentCardId = null;
    let paymentCardSnapshot = null;

    if (paymentMethod === "balance") {
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

    if (paymentMethod !== "balance") {
      let selectedCard;
      try {
        selectedCard = await resolvePaymentCardSelection("purchase");
      } catch (selectionError) {
        if (
          selectionError?.message === "Hozircha to'lov kartasi mavjud emas"
        ) {
          return response.error(res, selectionError.message);
        }
        throw selectionError;
      }
      paymentCardId = selectedCard.paymentCardId;
      paymentCardSnapshot = selectedCard.paymentCardSnapshot;
    }

    const nextOrderId = await getNextOrderId();
    const order = await Order.create({
      orderId: nextOrderId,
      product,
      planCode,
      customAmount: Number(customAmount || 0),
      username:
        product === "mlbb"
          ? `${normalizedPlayerId}:${normalizedZoneId}`
          : normalizedUsername,
      playerId: normalizedPlayerId,
      zoneId: normalizedZoneId,
      profileName:
        product === "mlbb"
          ? `Player ID: ${normalizedPlayerId} | Zone ID: ${normalizedZoneId}`
          : profileName,
      paymentCardId,
      paymentCardSnapshot,
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
      if (isManualGameProduct(product)) {
        emitAdminUpdate({
          type: "game_paid",
          refreshHistory: true,
          orderId: order._id,
          orderCode: order.orderId,
          product,
          username: order.username,
          planCode: order.planCode,
          expectedAmount: order.expectedAmount,
          paidAmount: order.paidAmount,
          paidAt: order.paidAt,
        });
        notifyGamePaid({
          orderId: order._id,
          orderCode: order.orderId,
          product,
          username: order.username,
          playerId: order.playerId,
          zoneId: order.zoneId,
          planCode: order.planCode,
          expectedAmount: order.expectedAmount,
        });
      }

      if (product === "star" || product === "premium") {
        await autoFulfillOrder(order);
      }
    }

    emitUserUpdate(tgUserId, {
      type: "order_created",
      refreshOrders: true,
      refreshBalance: paymentMethod === "balance",
      orderId: order._id,
      status: finalStatus,
      product,
    });

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

function normalizeScope(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeSearch(value) {
  return String(value || "").trim();
}

function parseOrderIdSearch(value) {
  const raw = normalizeSearch(value);
  if (!raw) return null;
  const normalized = raw.replace(/^#/, "");
  if (!/^\d+$/.test(normalized)) return null;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;
  return Math.floor(parsed);
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildSearchFilter(rawSearch) {
  const normalized = normalizeSearch(rawSearch);
  if (!normalized) return null;

  const safeRegex = new RegExp(escapeRegExp(normalized), "i");
  const conditions = [
    { username: safeRegex },
    { tgUsername: safeRegex },
    { tgUserId: safeRegex },
    { profileName: safeRegex },
    { planCode: safeRegex },
    { product: safeRegex },
    { status: safeRegex },
    { paymentMethod: safeRegex },
    { completionMode: safeRegex },
    { fulfillmentStatus: safeRegex },
    { fulfillmentError: safeRegex },
    { playerId: safeRegex },
    { zoneId: safeRegex },
    { "paymentCardSnapshot.label": safeRegex },
    { "paymentCardSnapshot.cardNumber": safeRegex },
    { "paymentCardSnapshot.cardHolder": safeRegex },
  ];

  const numeric = Number(normalized);
  if (Number.isFinite(numeric)) {
    conditions.push({ orderId: Math.floor(numeric) });
    conditions.push({ expectedAmount: Math.floor(numeric) });
    conditions.push({ paidAmount: Math.floor(numeric) });
    conditions.push({ customAmount: Math.floor(numeric) });
  }

  if (mongoose.Types.ObjectId.isValid(normalized)) {
    conditions.push({ _id: new mongoose.Types.ObjectId(normalized) });
  }

  return { $or: conditions };
}

function buildHistoryFilter(scope) {
  if (scope === "sales" || scope === "reports") {
    return {
      status: { $in: ["paid_auto_processed", "completed"] },
    };
  }

  if (scope === "uc_paid") {
    return {
      product: { $in: ["uc", "freefire", "mlbb"] },
      status: "paid_auto_processed",
    };
  }

  if (scope === "autobuy_errors") {
    return {
      product: { $in: ["star", "premium"] },
      fulfillmentStatus: { $in: ["failed", "processing"] },
    };
  }

  return {};
}

const getHistory = async (req, res) => {
  try {
    await expirePendingOrders();
    const scope = normalizeScope(req.query?.scope || "all");
    const search = normalizeSearch(req.query?.search || "");
    const requestedLimit = Number(req.query?.limit || 3000);
    const limit =
      Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(10000, Math.floor(requestedLimit))
        : 3000;
    const requestedPage = Number(req.query?.page || 1);
    const page =
      Number.isFinite(requestedPage) && requestedPage > 0
        ? Math.floor(requestedPage)
        : 1;
    const scopeFilter = buildHistoryFilter(scope);
    const searchFilter = buildSearchFilter(search);
    const parsedOrderId = parseOrderIdSearch(search);
    let filter = searchFilter
      ? { $and: [scopeFilter, searchFilter] }
      : scopeFilter;

    if (parsedOrderId !== null) {
      const exactOrderFilter = { $and: [scopeFilter, { orderId: parsedOrderId }] };
      const hasExactOrderMatch = await Order.exists(exactOrderFilter);
      if (hasExactOrderMatch) {
        filter = exactOrderFilter;
      }
    }

    const totalItems = await Order.countDocuments(filter);
    const totalPages = Math.max(1, Math.ceil(Number(totalItems || 0) / limit));
    const safePage = Math.min(page, totalPages);

    const orders = await Order.find(filter)
      .sort({ updatedAt: -1, createdAt: -1 })
      .skip((safePage - 1) * limit)
      .limit(limit)
      .lean();
    return response.success(res, "Tarix", {
      items: orders,
      pagination: {
        page: safePage,
        limit,
        totalItems: Number(totalItems || 0),
        totalPages,
      },
      scope,
      search,
    });
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
    const result = await confirmGameOrderById(id);
    if (!result.ok) {
      if (result.reason === "not_found") {
        return response.notFound(res, "Order topilmadi");
      }
      if (result.reason === "not_game") {
        return response.error(res, "Bu order o'yin orderi emas");
      }
      if (result.reason === "not_paid") {
        return response.error(res, "Order hali to'lanmagan");
      }
      return response.error(res, "O'yin orderini tasdiqlashda xatolik");
    }

    return response.success(res, "O'yin orderi yakunlandi", result.order);
  } catch (error) {
    return response.serverError(
      res,
      "O'yin orderini tasdiqlashda xatolik",
      error.message,
    );
  }
};

const cancelUcOrder = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await cancelGameOrderById(id);
    if (!result.ok) {
      if (result.reason === "not_found") {
        return response.notFound(res, "Order topilmadi");
      }
      if (result.reason === "not_game") {
        return response.error(res, "Bu order o'yin orderi emas");
      }
      if (result.reason === "not_paid") {
        return response.error(res, "Order hali bekor qilib bo'lmaydigan holatda");
      }
      if (result.reason === "refund_not_available") {
        return response.error(res, "Balansga qaytarish uchun tgUserId yoki paidAmount topilmadi");
      }
      return response.error(res, "O'yin orderini bekor qilishda xatolik");
    }

    return response.success(res, "O'yin orderi bekor qilindi", result.order);
  } catch (error) {
    return response.serverError(
      res,
      "O'yin orderini bekor qilishda xatolik",
      error.message,
    );
  }
};

const cancelOrder = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await cancelPaidOrderById(id);
    if (!result.ok) {
      if (result.reason === "not_found") {
        return response.notFound(res, "Order topilmadi");
      }
      if (result.reason === "not_cancellable") {
        return response.error(res, "Bu orderni hozir bekor qilib bo'lmaydi");
      }
      if (result.reason === "refund_not_available") {
        return response.error(res, "Balansga qaytarish uchun tgUserId yoki paidAmount topilmadi");
      }
      return response.error(res, "Orderni bekor qilishda xatolik");
    }

    return response.success(res, "Order bekor qilindi", result.order);
  } catch (error) {
    return response.serverError(res, "Orderni bekor qilishda xatolik", error.message);
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

const markAutobuyOrderCompleted = async (req, res) => {
  try {
    const { id } = req.params;
    const order = await Order.findById(id);
    if (!order) return response.notFound(res, "Order topilmadi");

    if (!["star", "premium"].includes(String(order.product || ""))) {
      return response.error(
        res,
        "Faqat star/premium auto buy orderlari uchun ruxsat berilgan",
      );
    }

    if (order.status === "completed" && order.fulfillmentStatus === "success") {
      return response.success(res, "Order allaqachon bajarilgan", order);
    }

    if (order.status !== "paid_auto_processed") {
      return response.error(
        res,
        "Faqat paid_auto_processed holatidagi orderni bajarilgan deb belgilash mumkin",
      );
    }

    const manualCompleteAt = new Date();
    const previousFragmentTx =
      order.fragmentTx && typeof order.fragmentTx === "object" && !Array.isArray(order.fragmentTx)
        ? order.fragmentTx
        : {};

    order.status = "completed";
    order.fulfillmentStatus = "success";
    order.completionMode = "manual";
    order.fulfillmentError = "";
    order.fulfilledAt = manualCompleteAt;
    order.fragmentTx = {
      ...previousFragmentTx,
      manuallyCompletedByAdmin: true,
      manualCompletedAt: manualCompleteAt.toISOString(),
    };
    await order.save();

    emitAdminUpdate({
      type: "autobuy_manually_completed",
      refreshHistory: true,
      orderId: order._id,
      orderCode: order.orderId,
      product: order.product,
      tgUserId: order.tgUserId,
    });

    if (String(order.tgUserId || "").trim()) {
      emitUserUpdate(String(order.tgUserId || ""), {
        type: "order_fulfilled",
        refreshOrders: true,
        refreshBalance: false,
        orderId: order._id,
        product: order.product,
        status: order.status,
        fulfillmentStatus: order.fulfillmentStatus,
      });
    }

    return response.success(res, "Order bajarildi deb belgilandi", order);
  } catch (error) {
    return response.serverError(
      res,
      "Orderni bajarilgan deb belgilashda xatolik",
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
  markAutobuyOrderCompleted,
  confirmUcOrder,
  cancelUcOrder,
  cancelOrder,
};


