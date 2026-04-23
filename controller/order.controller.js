const response = require("../utils/response");
const axios = require("axios");
const Plan = require("../model/plan.model");
const Order = require("../model/order.model");
const User = require("../model/user.model");
const UserGift = require("../model/user-gift.model");
const UserNft = require("../model/user-nft.model");
const NftOffer = require("../model/nft-offer.model");
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
const {
  getStarPricing,
  getGameStarsPaymentConfig,
  getStarSellPricing,
} = require("../services/settings.service");
const { getTelegramUserFromRequest } = require("../utils/tg-user");
const { selectPaymentCardForType } = require("../services/payment-card.service");
const {
  confirmStarSellPayoutById,
} = require("../services/star-sell-payout.service");

let sequence = 1;
const PENDING_TTL_MS = 10 * 60 * 1000;
const ORDER_PAYMENT_METHODS = ["card", "bankomat", "uzumbank", "paynet", "click", "balance", "stars"];
const STARS_INVOICE_PRODUCTS = new Set(["uc", "freefire", "mlbb", "star_sell"]);

function normalizeCardNumber(value) {
  return String(value || "").replace(/\D/g, "").slice(0, 16);
}

function getOrderProductLabel(product) {
  const key = String(product || "").trim().toLowerCase();
  if (key === "star") return "Telegram Star";
  if (key === "star_sell") return "Star Sell";
  if (key === "premium") return "Telegram Premium";
  if (key === "uc") return "PUBG UC";
  if (key === "mlbb") return "MLBB Diamond";
  if (key === "freefire") return "Free Fire Diamond";
  return "Buyurtma";
}

async function createTelegramStarsInvoiceLink({
  order,
  starsAmount,
  payload,
}) {
  const botToken = String(process.env.BOT_TOKEN || "").trim();
  if (!botToken) {
    throw new Error("BOT_TOKEN topilmadi");
  }

  const title = `${getOrderProductLabel(order?.product)} #${order?.orderId || "-"}`.slice(0, 32);
  const description = `Buyurtma #${order?.orderId || "-"} uchun Telegram Stars to'lovi`.slice(0, 255);
  const apiUrl = `https://api.telegram.org/bot${botToken}/createInvoiceLink`;

  const telegramResponse = await axios.post(
    apiUrl,
    {
      title,
      description,
      payload,
      provider_token: "",
      currency: "XTR",
      prices: [
        {
          label: `Order #${order?.orderId || "-"}`.slice(0, 32),
          amount: Math.max(1, Math.floor(Number(starsAmount || 0))),
        },
      ],
    },
    { timeout: 12_000 },
  );

  const invoiceLink = String(telegramResponse?.data?.result || "").trim();
  if (!telegramResponse?.data?.ok || !invoiceLink) {
    throw new Error(
      String(telegramResponse?.data?.description || "Telegram invoice link yaratilmadi"),
    );
  }

  return invoiceLink;
}

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
    const normalizedPaymentMethod = String(paymentMethod || "card")
      .trim()
      .toLowerCase();
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
    if (!["star", "premium", "uc", "freefire", "mlbb", "star_sell"].includes(product)) {
      return response.error(res, "Tanlangan mahsulot noto'g'ri");
    }
    if (!ORDER_PAYMENT_METHODS.includes(normalizedPaymentMethod)) {
      return response.error(res, "To'lov usuli noto'g'ri");
    }
    if (
      normalizedPaymentMethod === "stars" &&
      !STARS_INVOICE_PRODUCTS.has(String(product || "").toLowerCase())
    ) {
      return response.error(
        res,
        "Stars orqali to'lov bu mahsulot uchun mavjud emas",
      );
    }
    if (String(product || "").toLowerCase() === "star_sell" && normalizedPaymentMethod !== "stars") {
      return response.error(res, "Star sotishda to'lov usuli faqat stars bo'lishi kerak");
    }
    const normalizedPlayerId = String(playerId || "").trim();
    const normalizedZoneId = String(zoneId || "").trim();
    const normalizedUsername = String(username || "").trim();

    if (product === "mlbb") {
      if (!normalizedPlayerId || !normalizedZoneId) {
        return response.error(res, "Player ID va Zone ID kiriting");
      }
    } else if (product !== "star_sell" && !normalizedUsername) {
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

    if (String(product || "").toLowerCase() === "star_sell") {
      const pricing = await getStarSellPricing();
      const qty = Number(customAmount || 0);
      const sellCardNumber = normalizeCardNumber(req.body?.sellCardNumber);
      if (!qty || qty < pricing.min || qty > pricing.max) {
        return response.error(res, "Tanlangan miqdor noto'g'ri");
      }
      if (sellCardNumber.length !== 16) {
        return response.error(res, "Karta raqami 16 ta bo'lishi kerak");
      }
      resolvedAmount = qty;
      resolvedBasePrice = qty * Number(pricing.pricePerStar || 0);
      plan = { basePrice: resolvedBasePrice, amount: qty };
    } else if (isCustomStar) {
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

    if (normalizedPaymentMethod === "balance") {
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
      if (normalizedPaymentMethod === "stars") {
        expected = Number(resolvedBasePrice || 0);
      } else {
        expected = await getUniquePendingAmount({
          product,
          planCode,
          basePrice: resolvedBasePrice,
        });
      }
      expiresAt = new Date(Date.now() + PENDING_TTL_MS);
    }

    if (
      normalizedPaymentMethod !== "balance" &&
      normalizedPaymentMethod !== "stars"
    ) {
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
    const normalizedSellCardNumber =
      String(product || "").toLowerCase() === "star_sell"
        ? normalizeCardNumber(req.body?.sellCardNumber)
        : "";
    const starSellPricing =
      String(product || "").toLowerCase() === "star_sell"
        ? await getStarSellPricing()
        : null;
    const order = await Order.create({
      orderId: nextOrderId,
      product,
      planCode: String(product || "").toLowerCase() === "star_sell" ? "sell" : planCode,
      customAmount: Number(customAmount || 0),
      username:
        String(product || "").toLowerCase() === "star_sell"
          ? String(tgUsername || normalizedUsername || tgUserId).trim()
          : product === "mlbb"
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
      paymentMethod: normalizedPaymentMethod,
      sellCardNumber: normalizedSellCardNumber,
      sellPricePerStar: Number(starSellPricing?.pricePerStar || 0),
      starsAmount:
        String(product || "").toLowerCase() === "star_sell"
          ? Math.max(1, Math.floor(Number(customAmount || 0)))
          : 0,
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
          paymentMethod: order.paymentMethod,
        });
      }

      if (product === "star" || product === "premium") {
        await autoFulfillOrder(order);
      }
    }

    emitUserUpdate(tgUserId, {
      type: "order_created",
      refreshOrders: true,
      refreshBalance: normalizedPaymentMethod === "balance",
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
    { sellCardNumber: safeRegex },
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

  if (scope === "star_sell") {
    return {
      product: "star_sell",
    };
  }

  return {};
}

function toTimeMs(value) {
  const timestamp = new Date(value || 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function buildNftGiftSearchRegex(search) {
  const normalized = normalizeSearch(search);
  if (!normalized) return null;
  return new RegExp(escapeRegExp(normalized), "i");
}

async function getNftGiftHistory({ page, limit, search }) {
  const regex = buildNftGiftSearchRegex(search);
  const numeric = Number(normalizeSearch(search));
  const hasNumeric = Number.isFinite(numeric);

  const giftFilter = {};
  if (regex) {
    const giftConditions = [
      { giftId: regex },
      { title: regex },
      { tgUserId: regex },
      { tgUsername: regex },
      { status: regex },
      { sentToValue: regex },
      { sentToResolved: regex },
    ];
    if (hasNumeric) {
      giftConditions.push({ priceUzs: Math.floor(numeric) });
      giftConditions.push({ stars: Math.floor(numeric) });
    }
    giftFilter.$or = giftConditions;
  }

  const offerFilter = { status: "accepted" };
  if (regex) {
    const offerConditions = [
      { nftId: regex },
      { buyerTgUserId: regex },
      { buyerUsername: regex },
      { buyerProfileName: regex },
      { sellerTgUserId: regex },
      { sellerUsername: regex },
      { sellerProfileName: regex },
      { status: regex },
    ];
    if (hasNumeric) {
      offerConditions.push({ offeredPriceUzs: Math.floor(numeric) });
      offerConditions.push({ listingPriceUzs: Math.floor(numeric) });
    }
    offerFilter.$or = offerConditions;
  }

  const [gifts, acceptedOffers] = await Promise.all([
    UserGift.find(giftFilter)
      .sort({ createdAt: -1 })
      .limit(5000)
      .lean(),
    NftOffer.find(offerFilter)
      .sort({ acceptedAt: -1, respondedAt: -1, createdAt: -1 })
      .limit(5000)
      .select({
        nftId: 1,
        buyerTgUserId: 1,
        buyerUsername: 1,
        buyerProfileName: 1,
        sellerTgUserId: 1,
        sellerUsername: 1,
        sellerProfileName: 1,
        offeredPriceUzs: 1,
        acceptedAt: 1,
        respondedAt: 1,
        createdAt: 1,
      })
      .lean(),
  ]);

  const nftIds = Array.from(
    new Set(acceptedOffers.map((item) => normalizeSearch(item?.nftId)).filter(Boolean)),
  );
  const nftDocs = nftIds.length
    ? await UserNft.find({ nftId: { $in: nftIds } }).select({ nftId: 1, title: 1 }).lean()
    : [];
  const nftTitleMap = new Map(
    nftDocs.map((item) => [normalizeSearch(item?.nftId), normalizeSearch(item?.title)]),
  );

  const giftItems = gifts.flatMap((gift) => {
    const base = {
      _id: `gift_${String(gift?._id || "")}`,
      type: "gift",
      giftId: normalizeSearch(gift?.giftId),
      title: normalizeSearch(gift?.title) || "Gift",
      emoji: normalizeSearch(gift?.emoji) || "🎁",
      amountUzs: Number(gift?.priceUzs || 0),
      tgUserId: normalizeSearch(gift?.tgUserId),
      tgUsername: normalizeSearch(gift?.tgUsername),
      createdAt: gift?.createdAt || null,
      updatedAt: gift?.updatedAt || null,
    };

    const items = [];
    if (gift?.createdAt) {
      items.push({
        ...base,
        eventKey: `gift_purchase_${String(gift?._id || "")}`,
        action: "purchased",
        timestamp: gift.createdAt,
      });
    }
    if (gift?.sentAt) {
      items.push({
        ...base,
        eventKey: `gift_sent_${String(gift?._id || "")}`,
        action: "sent",
        recipient:
          normalizeSearch(gift?.sentToResolved) || normalizeSearch(gift?.sentToValue),
        timestamp: gift.sentAt,
      });
    }
    return items;
  });

  const nftItems = acceptedOffers.map((offer) => {
    const nftId = normalizeSearch(offer?.nftId);
    const title = normalizeSearch(nftTitleMap.get(nftId)) || "NFT Gift";
    const timestamp = offer?.acceptedAt || offer?.respondedAt || offer?.createdAt || null;
    return {
      _id: `nft_${String(offer?._id || "")}`,
      type: "nft",
      eventKey: `nft_trade_${String(offer?._id || "")}`,
      nftId,
      title,
      amountUzs: Number(offer?.offeredPriceUzs || 0),
      buyerTgUserId: normalizeSearch(offer?.buyerTgUserId),
      buyerUsername: normalizeSearch(offer?.buyerUsername),
      buyerProfileName: normalizeSearch(offer?.buyerProfileName),
      sellerTgUserId: normalizeSearch(offer?.sellerTgUserId),
      sellerUsername: normalizeSearch(offer?.sellerUsername),
      sellerProfileName: normalizeSearch(offer?.sellerProfileName),
      action: "trade",
      timestamp,
      createdAt: offer?.createdAt || null,
      updatedAt: offer?.respondedAt || offer?.acceptedAt || offer?.createdAt || null,
    };
  });

  const merged = [...giftItems, ...nftItems].sort(
    (left, right) => toTimeMs(right?.timestamp) - toTimeMs(left?.timestamp),
  );

  const totalItems = merged.length;
  const totalPages = Math.max(1, Math.ceil(Number(totalItems || 0) / limit));
  const safePage = Math.min(page, totalPages);
  const items = merged.slice((safePage - 1) * limit, safePage * limit);

  return {
    items,
    pagination: {
      page: safePage,
      limit,
      totalItems: Number(totalItems || 0),
      totalPages,
    },
  };
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

    if (scope === "nft_gift") {
      const result = await getNftGiftHistory({ page, limit, search });
      return response.success(res, "Tarix", {
        items: result.items,
        pagination: result.pagination,
        scope,
        search,
      });
    }

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

const createStarsInvoice = async (req, res) => {
  try {
    const { tgUserId } = getTelegramUserFromRequest(req);
    const orderId = String(req.params?.id || "").trim();
    if (!tgUserId) {
      return response.error(
        res,
        "Telegram profilingiz aniqlanmadi. Ilovani qayta ochib ko'ring.",
      );
    }
    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      return response.notFound(res, "Buyurtma topilmadi");
    }

    await expirePendingOrders();

    const order = await Order.findOne({
      _id: new mongoose.Types.ObjectId(orderId),
      tgUserId: String(tgUserId),
      paymentMethod: "stars",
    });
    if (!order) {
      return response.notFound(res, "Stars to'lovli buyurtma topilmadi");
    }
    if (!STARS_INVOICE_PRODUCTS.has(String(order.product || "").toLowerCase())) {
      return response.error(
        res,
        "Stars invoice bu mahsulot uchun yaratilmaydi",
      );
    }

    if (order.status !== "pending_payment") {
      return response.error(res, "Bu buyurtma uchun Stars to'lov ochib bo'lmaydi");
    }

    if (order.expiresAt && new Date(order.expiresAt).getTime() <= Date.now()) {
      order.status = "cancelled";
      await order.save();
      return response.error(res, "Buyurtma muddati tugagan");
    }

    let starsAmount = 0;
    let payloadPrefix = "stars_order";
    if (String(order.product || "").toLowerCase() === "star_sell") {
      starsAmount = Math.max(
        1,
        Math.floor(Number(order.customAmount || order.starsAmount || 0)),
      );
      payloadPrefix = "stars_sell_order";
    } else {
      const gameStarsPricing = await getGameStarsPaymentConfig();
      const pricePerStar = Math.max(
        1,
        Number(gameStarsPricing?.pricePerStar || 220),
      );
      starsAmount = Math.max(
        1,
        Math.ceil(Number(order.expectedAmount || 0) / pricePerStar),
      );
    }
    const payload = `${payloadPrefix}:${String(order._id)}:${Date.now()}`;
    const invoiceLink = await createTelegramStarsInvoiceLink({
      order,
      starsAmount,
      payload,
    });

    order.starsAmount = starsAmount;
    order.starsInvoicePayload = payload;
    order.starsInvoiceLink = invoiceLink;
    await order.save();

    return response.success(res, "Stars invoice yaratildi", {
      orderId: order.orderId,
      orderMongoId: String(order._id),
      starsAmount,
      invoiceLink,
      expiresAt: order.expiresAt,
    });
  } catch (error) {
    return response.serverError(
      res,
      "Stars invoice yaratishda xatolik",
      error.message,
    );
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

const confirmStarSellPayout = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await confirmStarSellPayoutById(id);
    if (!result.ok) {
      if (result.reason === "not_found") {
        return response.notFound(res, "Order topilmadi");
      }
      if (result.reason === "not_star_sell") {
        return response.error(res, "Bu order star sell orderi emas");
      }
      return response.error(res, "Order hali payout uchun tayyor emas");
    }
    if (result.alreadyCompleted) {
      return response.success(
        res,
        "Order allaqachon tasdiqlangan",
        result.order,
      );
    }

    return response.success(res, "Star sell payout tasdiqlandi", result.order);
  } catch (error) {
    return response.serverError(
      res,
      "Star sell payout tasdiqlashda xatolik",
      error.message,
    );
  }
};

module.exports = {
  calculatePrice,
  createOrder,
  createStarsInvoice,
  getReports,
  getHistory,
  processCardPayment,
  retryFulfillment,
  markAutobuyOrderCompleted,
  confirmStarSellPayout,
  confirmUcOrder,
  cancelUcOrder,
  cancelOrder,
};


