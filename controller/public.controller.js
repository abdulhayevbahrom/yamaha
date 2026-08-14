const response = require("../utils/response");
const mongoose = require("mongoose");
const Plan = require("../model/plan.model");
const Order = require("../model/order.model");
const User = require("../model/user.model");
const HeroSlide = require("../model/hero-slide.model");
const {
  getStarPricing,
  getGameStarsPaymentConfig,
  getStarSellPricing,
  getForceJoin,
  getBankomatTopupConfig,
  getReferralConfig,
  getBotStatus,
  getNftWithdrawalConfig,
  getSupportConfig,
} = require("../services/settings.service");
const { checkForceJoinMembership } = require("../services/force-join.service");
const {
  checkTelegramPremium,
  isTelegramPremiumCheckConfigured,
} = require("../services/telegram-premium-check.service");
const { normalizeCardBin, lookupCardBinInfo } = require("../services/card-bin.service");
const { getTelegramUserInfo } = require("../services/fragment-api.service");
const { verifyPubgPlayer } = require("../services/gw-api.service");
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

function isGwPubgAutobuyEnabled() {
  return ["1", "true", "yes", "on"].includes(
    String(process.env.GW_PUBG_AUTOBUY_ENABLED || "").trim().toLowerCase(),
  );
}

function isGwPlanFresh(plan) {
  const maxAge = Math.max(
    60_000,
    Number(process.env.GW_PUBG_CATALOG_MAX_AGE_MS || 30 * 60_000),
  );
  const syncedAt = new Date(plan?.providerSyncedAt || 0).getTime();
  return syncedAt > 0 && Date.now() - syncedAt <= maxAge;
}

function getTopSalePurchaseAmount(order) {
  const paidAmount = Number(order?.paidAmount || 0);
  if (Number.isFinite(paidAmount) && paidAmount > 0) return paidAmount;

  // Old completed orders can lack paidAmount; their order price is the safe
  // fallback. Balance top-ups are filtered out before this value is used.
  const expectedAmount = Number(order?.expectedAmount || 0);
  return Number.isFinite(expectedAmount) && expectedAmount > 0 ? expectedAmount : 0;
}

function getTopSalesOrderFilter(startDate) {
  return {
    // Only orders whose purchase was successfully fulfilled belong in the
    // leaderboard. `paid_auto_processed` is only an intermediate state and
    // can still be cancelled when fulfillment fails (for example, because
    // the provider balance is insufficient).
    product: { $in: TOP_SALES_PRODUCTS, $ne: "balance" },
    status: "completed",
    fulfillmentStatus: "success",
    $or: [{ paidAt: { $gte: startDate } }, { createdAt: { $gte: startDate } }],
  };
}

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
  const normalizedUsername = normalizeLookupUsername(username);
  if (!normalizedUsername) return null;

  try {
    const lookup = await getTelegramUserInfo(normalizedUsername);
    const profileName = String(lookup?.profileName || "").trim();
    if (!profileName) return null;
    return {
      username: normalizedUsername,
      profileName,
    };
  } catch (lookupError) {
    console.warn(
      `[lookup-profile] fragment getInfo failed for @${normalizedUsername}: ${lookupError?.message || lookupError}`,
    );
    return null;
  }
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
      stockQuantity:
        plan.category === "uc" &&
        plan.providerQuantity !== null &&
        plan.providerQuantity !== undefined &&
        Number.isFinite(Number(plan.providerQuantity))
          ? Math.max(0, Math.floor(Number(plan.providerQuantity)))
          : null,
      available:
        plan.category === "uc" && isGwPubgAutobuyEnabled()
          ? plan.provider === "gw" &&
            Boolean(plan.providerAvailable) &&
            isGwPlanFresh(plan)
          : plan.provider === "gw"
            ? Boolean(plan.providerAvailable)
            : true,
    });
  });

  return grouped;
}

function mapHeroSlide(doc) {
  return {
    _id: String(doc?._id || ""),
    title: String(doc?.title || "").trim(),
    imageUrl: String(doc?.imageUrl || "").trim(),
    targetTab: String(doc?.targetTab || "").trim(),
    sortOrder: Number(doc?.sortOrder || 0),
    isActive: Boolean(doc?.isActive),
    createdAt: doc?.createdAt || null,
    updatedAt: doc?.updatedAt || null,
  };
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

function normalizeUsername(value) {
  return String(value || "")
    .trim()
    .replace(/^@+/, "");
}

function resolveTopSalesActor(order, user) {
  const tgUserId = sanitizeProfileDisplay(order?.tgUserId || user?.tgUserId);
  const usernameRaw = sanitizeProfileDisplay(user?.username || order?.tgUsername);
  const username = normalizeUsername(usernameRaw);
  const profileName = sanitizeProfileDisplay(user?.profileName);

  const displayName =
    profileName ||
    (username ? `@${username}` : "") ||
    tgUserId ||
    "-";

  const key = tgUserId || (username ? `u:${username.toLowerCase()}` : `o:${String(order?._id || "")}`);

  return {
    key,
    tgUserId,
    username,
    displayName,
  };
}

const health = async (_, res) => {
  const dbConnected = mongoose.connection.readyState === 1;
  if (!dbConnected) {
    return res.status(503).json({
      state: false,
      message: "API vaqtincha tayyor emas",
      innerData: { database: "disconnected" },
    });
  }
  return response.success(res, "API ishlayapti", {
    database: "connected",
  });
};

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
    const nftWithdrawalConfig = await getNftWithdrawalConfig();
    const supportConfig = await getSupportConfig();
    return response.success(res, "Settings", {
      starPricing,
      gameStarsPaymentConfig,
      starSellPricing,
      forceJoin,
      bankomatTopupConfig,
      referralConfig,
      botStatus,
      nftWithdrawalConfig,
      supportConfig,
    });
  } catch (error) {
    return response.serverError(res, "Settings olishda xatolik", error.message);
  }
};

const getHeroSlides = async (_, res) => {
  try {
    const items = await HeroSlide.find({ isActive: true })
      .sort({ sortOrder: 1, createdAt: -1 })
      .lean();
    return response.success(res, "Hero slides", items.map(mapHeroSlide));
  } catch (error) {
    return response.serverError(res, "Hero slides olishda xatolik", error.message);
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

    const orders = await Order.find(getTopSalesOrderFilter(startDate))
      .sort({ paidAt: -1, createdAt: -1 })
      .lean();

    const actorIds = orders
      .map((order) => sanitizeProfileDisplay(order?.tgUserId))
      .filter(Boolean);
    const users = actorIds.length
      ? await User.find({ tgUserId: { $in: actorIds } })
          .select({ tgUserId: 1, username: 1, profileName: 1 })
          .lean()
      : [];
    const userMap = new Map(users.map((u) => [sanitizeProfileDisplay(u?.tgUserId), u]));

    const groupedByActor = new Map();
    orders.forEach((order) => {
      const user = userMap.get(sanitizeProfileDisplay(order?.tgUserId)) || null;
      const actor = resolveTopSalesActor(order, user);
      const amount = getTopSalePurchaseAmount(order);
      const paidAt = order?.paidAt ? new Date(order.paidAt).getTime() : 0;
      const createdAt = order?.createdAt ? new Date(order.createdAt).getTime() : 0;
      const orderTime = paidAt || createdAt || 0;
      const current = groupedByActor.get(actor.key);

      if (!current) {
        groupedByActor.set(actor.key, {
          orderId: order.orderId,
          product: order.product,
          tgUserId: actor.tgUserId,
          username: actor.username,
          buyerProfileName: actor.displayName,
          amount,
          paidAt: order.paidAt || null,
          createdAt: order.createdAt || null,
          sortTime: orderTime,
        });
        return;
      }

      current.amount += amount;
      if (orderTime > current.sortTime) {
        current.sortTime = orderTime;
        current.orderId = order.orderId;
        current.product = order.product;
        current.paidAt = order.paidAt || null;
        current.createdAt = order.createdAt || null;
      }
    });

    const items = Array.from(groupedByActor.values())
      .sort((a, b) => {
        if (b.amount !== a.amount) return b.amount - a.amount;
        return b.sortTime - a.sortTime;
      })
      .slice(0, 10)
      .map((item) => ({
        orderId: item.orderId,
        product: item.product,
        tgUserId: item.tgUserId || "",
        username: item.username || "",
        buyerProfileName: item.buyerProfileName,
        amount: Number(item.amount || 0),
        paidAt: item.paidAt || null,
        createdAt: item.createdAt || null,
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

const checkPubgPlayer = async (req, res) => {
  const playerId = String(req.body?.playerId || "").trim();
  if (!/^5\d+$/.test(playerId)) {
    return response.error(res, "Player ID noto‘g‘ri");
  }

  try {
    const tgUserId = String(req.telegramAuth?.tgUserId || "user").trim();
    const trxid = `CHK-PUBG-${tgUserId}-${Date.now()}`.slice(0, 80);
    const result = await verifyPubgPlayer(playerId, trxid);
    const playerName = String(result?.playerName || result?.name || "").trim();
    if (!result?.success || !playerName) {
      const providerError = String(result?.error || "").trim();
      const message = /player\s*not\s*found/i.test(providerError)
        ? "PUBG profil topilmadi"
        : providerError || "PUBG profil topilmadi";
      return response.error(res, message);
    }
    return response.success(res, "PUBG profil topildi", { playerId, playerName });
  } catch (error) {
    const providerMessage = error?.response?.data?.error || error?.message;
    return response.serverError(res, "PUBG profil tekshirishda xatolik", providerMessage);
  }
};

module.exports = {
  health,
  getCatalog,
  getSettings,
  getHeroSlides,
  getCardBinInfo,
  getTopSales,
  checkForceJoin,
  lookupProfile,
  checkPremiumStatus,
  checkMlbbRole,
  checkPubgPlayer,
  getTopSalePurchaseAmount,
  getTopSalesOrderFilter,
};
