const response = require("../utils/response");
const Plan = require("../model/plan.model");
const Order = require("../model/order.model");
const {
  getStarPricing,
  getGameStarsPaymentConfig,
  getStarSellPricing,
  getForceJoin,
  getBankomatTopupConfig,
  getReferralConfig,
  getBotStatus,
} = require("../services/settings.service");
const { checkForceJoinMembership } = require("../services/force-join.service");
const {
  checkTelegramPremium,
  isTelegramPremiumCheckConfigured,
} = require("../services/telegram-premium-check.service");
const { normalizeCardBin, lookupCardBinInfo } = require("../services/card-bin.service");
// const { ensureDefaultPlans } = require("../services/plan.service");

const categoryNames = {
  star: "Telegram Star",
  premium: "Telegram Premium",
  uc: "PUBG UC",
  freefire: "Free Fire Diamond",
  mlbb: "MLBB Diamond",
};

const LOOKUP_CACHE_TTL_MS = 5 * 60 * 1000;
const LOOKUP_CACHE_LIMIT = 500;
const profileLookupCache = new Map();
const profileLookupInFlight = new Map();
const TOP_SALES_PRODUCTS = ["star", "premium", "uc", "freefire", "mlbb"];
const TOP_SALES_PERIODS = new Set(["today", "week", "month"]);

function normalizeLookupUsername(value) {
  return String(value || "")
    .trim()
    .replace(/^@+/, "");
}

function getLookupCacheKey(username) {
  return normalizeLookupUsername(username).toLowerCase();
}

function readProfileLookupCache(username) {
  const key = getLookupCacheKey(username);
  if (!key) return null;

  const cached = profileLookupCache.get(key);
  if (!cached) return null;

  if (cached.expiresAt <= Date.now()) {
    profileLookupCache.delete(key);
    return null;
  }

  return cached.value;
}

function writeProfileLookupCache(username, value) {
  const key = getLookupCacheKey(username);
  if (!key || !value?.profileName) return;

  if (profileLookupCache.size >= LOOKUP_CACHE_LIMIT) {
    const oldestKey = profileLookupCache.keys().next().value;
    if (oldestKey) profileLookupCache.delete(oldestKey);
  }

  profileLookupCache.set(key, {
    value,
    expiresAt: Date.now() + LOOKUP_CACHE_TTL_MS,
  });
}

async function fetchProfileLookup(username) {
  const url = `${process.env.API_BASE}/star/recipient/search?username=${encodeURIComponent(
    username,
  )}&quantity=1`;
  const headers = { "API-Key": process.env.API_KEY };

  const external = await fetch(url, { headers });
  const data = await external.json();
  const profileName = data?.name;

  if (!profileName) return null;
  return {
    username,
    profileName,
  };
}

function mapCatalog(plans) {
  const grouped = {
    star: { name: categoryNames.star, plans: [] },
    premium: { name: categoryNames.premium, plans: [] },
    uc: { name: categoryNames.uc, plans: [] },
    freefire: { name: categoryNames.freefire, plans: [] },
    mlbb: { name: categoryNames.mlbb, plans: [] },
  };

  plans.forEach((plan) => {
    if (!grouped[plan.category]) return;
    grouped[plan.category].plans.push({
      code: plan.code,
      label: plan.label,
      amount: plan.amount,
      basePrice: plan.basePrice,
      currency: plan.currency,
      isActive: plan.isActive,
    });
  });

  return grouped;
}

function getTopSalesStartDate(period) {
  const now = new Date();
  if (period === "today") {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }
  if (period === "week") {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const day = start.getDay();
    const diff = day === 0 ? 6 : day - 1;
    start.setDate(start.getDate() - diff);
    start.setHours(0, 0, 0, 0);
    return start;
  }
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

function sanitizeProfileDisplay(value) {
  let text = String(value || "").trim();
  if (!text) return "";
  text = text
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, "")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length > 64) {
    text = `${text.slice(0, 61)}...`;
  }
  return text;
}

function buildTopSalesBuyerName(order) {
  const profileName = sanitizeProfileDisplay(order?.profileName);
  if (profileName) return profileName;

  const username = sanitizeProfileDisplay(order?.username || order?.tgUsername);
  if (!username) return sanitizeProfileDisplay(order?.tgUserId) || "-";
  if (/^@/.test(username) || /^\d+$/.test(username)) return username;
  return `@${username}`;
}

const health = async (_, res) => response.success(res, "API ishlayapti");

const getCatalog = async (_, res) => {
  try {
    const plans = await Plan.find({ isActive: true }).lean();
    return response.success(res, "Catalog", mapCatalog(plans));
  } catch (error) {
    return response.serverError(res, "Catalog olishda xatolik", error.message);
  }
};

const getSettings = async (_, res) => {
  try {
    const starPricing = await getStarPricing();
    const gameStarsPaymentConfig = await getGameStarsPaymentConfig();
    const starSellPricing = await getStarSellPricing();
    const forceJoin = await getForceJoin();
    const bankomatTopupConfig = await getBankomatTopupConfig();
    const referralConfig = await getReferralConfig();
    const botStatus = await getBotStatus();
    return response.success(res, "Settings", {
      starPricing,
      gameStarsPaymentConfig,
      starSellPricing,
      forceJoin,
      bankomatTopupConfig,
      referralConfig,
      botStatus,
    });
  } catch (error) {
    return response.serverError(res, "Settings olishda xatolik", error.message);
  }
};

const getCardBinInfo = async (req, res) => {
  const bin = normalizeCardBin(req.params?.bin);
  if (bin.length < 6) {
    return response.error(res, "BIN kamida 6 ta raqam bo'lishi kerak");
  }

  try {
    const payload = await lookupCardBinInfo(bin);
    return response.success(res, "BIN info", payload);
  } catch (_) {
    return response.success(res, "BIN info", {
      bin,
      found: false,
      bankName: "",
      scheme: "",
      type: "",
      country: "",
    });
  }
};

const getTopSales = async (req, res) => {
  try {
    const rawPeriod = String(req.query.period || "today").toLowerCase();
    const period = TOP_SALES_PERIODS.has(rawPeriod) ? rawPeriod : "today";
    const startDate = getTopSalesStartDate(period);

    const orders = await Order.find({
      product: { $in: TOP_SALES_PRODUCTS },
      status: { $in: ["paid_auto_processed", "completed"] },
      $or: [
        { paidAt: { $gte: startDate } },
        { createdAt: { $gte: startDate } },
      ],
    })
      .sort({ expectedAmount: -1, paidAt: -1, createdAt: -1 })
      .limit(10)
      .lean();

    const items = orders.map((order) => ({
      orderId: order.orderId,
      product: order.product,
      buyerProfileName: buildTopSalesBuyerName(order),
      amount: Number(order.expectedAmount || 0),
      paidAt: order.paidAt || null,
      createdAt: order.createdAt || null,
    }));

    return response.success(res, "Top sales", {
      period,
      items,
    });
  } catch (error) {
    return response.serverError(
      res,
      "Top sotuvlarni olishda xatolik",
      error.message,
    );
  }
};

const checkForceJoin = async (req, res) => {
  try {
    const tgUserId = String(req.headers["x-tg-user-id"] || "").trim();
    const result = await checkForceJoinMembership(tgUserId);
    return response.success(res, "Force join status", result);
  } catch (error) {
    return response.serverError(
      res,
      "Force join tekshirishda xatolik",
      error.message,
    );
  }
};

const lookupProfile = async (req, res) => {
  const { username } = req.query;
  if (!username) return response.error(res, "Username kiriting");

  const cleaned = normalizeLookupUsername(username);
  if (!cleaned) return response.error(res, "Username kiriting");

  try {
    const cached = readProfileLookupCache(cleaned);
    if (cached) {
      return response.success(res, "Profile topildi", cached);
    }

    const lookupKey = getLookupCacheKey(cleaned);
    let pendingLookup = profileLookupInFlight.get(lookupKey);

    if (!pendingLookup) {
      pendingLookup = fetchProfileLookup(cleaned)
        .then((result) => {
          if (result) writeProfileLookupCache(cleaned, result);
          return result;
        })
        .finally(() => {
          profileLookupInFlight.delete(lookupKey);
        });
      profileLookupInFlight.set(lookupKey, pendingLookup);
    }

    const result = await pendingLookup;
    if (!result?.profileName) return response.error(res, "Profil topilmadi");

    return response.success(res, "Profile topildi", result);
  } catch (error) {
    return response.serverError(
      res,
      "Profil qidirishda xatolik",
      error.message,
    );
  }
};

const checkPremiumStatus = async (req, res) => {
  const identifier = String(
    req.query.username || req.query.tgUserId || req.query.identifier || "",
  ).trim();

  if (!identifier) {
    return response.error(res, "Username yoki tgUserId kiriting");
  }

  if (!isTelegramPremiumCheckConfigured()) {
    return response.serverError(
      res,
      "Telegram premium check sozlanmagan",
    );
  }

  try {
    const result = await checkTelegramPremium(identifier);
    return response.success(res, "Premium status aniqlandi", result);
  } catch (error) {
    return response.serverError(
      res,
      "Premium status tekshirishda xatolik",
      error.message,
    );
  }
};

const checkMlbbRole = async (req, res) => {
  const playerId = String(req.query.playerId || req.query.user_id || "").trim();
  const zoneId = String(req.query.zoneId || req.query.zone_id || "").trim();

  if (!playerId || !zoneId) {
    return response.error(res, "Player ID va Zone ID kiriting");
  }

  try {
    const external = await fetch(
      "https://www.smile.one/merchant/mobilelegends/checkrole",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          user_id: playerId,
          zone_id: zoneId,
        }),
      },
    );

    const data = await external.json().catch(() => null);
    const profileName = String(
      data?.username || data?.name?.value || "",
    ).trim();

    if (!external.ok || data?.status === "FAILED" || data?.code === 201 || !profileName) {
      return response.error(res, "Profil topilmadi");
    }

    return response.success(res, "MLBB profile topildi", {
      playerId,
      zoneId,
      profileName,
      payload: data,
    });
  } catch (error) {
    return response.serverError(
      res,
      "MLBB profil qidirishda xatolik",
      error.message,
    );
  }
};

module.exports = {
  health,
  getCatalog,
  getSettings,
  getCardBinInfo,
  getTopSales,
  checkForceJoin,
  lookupProfile,
  checkPremiumStatus,
  checkMlbbRole,
};
