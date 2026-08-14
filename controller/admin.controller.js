const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const response = require("../utils/response");
const Plan = require("../model/plan.model");
const PaymentCard = require("../model/payment-card.model");
const StaticGift = require("../model/static-gift.model");
const HeroSlide = require("../model/hero-slide.model");
const User = require("../model/user.model");
const Order = require("../model/order.model");
const UserGift = require("../model/user-gift.model");
const UserNft = require("../model/user-nft.model");
const NftOffer = require("../model/nft-offer.model");
const UserBalanceAdjustment = require("../model/user-balance-adjustment.model");
const {
  getStarPricing,
  getGameStarsPaymentConfig,
  getStarSellPricing,
  getForceJoin,
  getBotStatus,
  getBotBroadcastConfig,
  getPaymentCardConfig,
  getBankomatTopupConfig,
  getReferralConfig,
  getReferralRewardConfig,
  getNftMarketplaceConfig,
  getNftWithdrawalConfig,
  getSupportConfig,
  updateStarPricing,
  updateGameStarsPaymentConfig,
  updateStarSellPricing,
  updateForceJoin,
  updateBotStatus,
  updateBotBroadcastConfig,
  updatePaymentCardConfig,
  updateBankomatTopupConfig,
  updateReferralConfig,
  updateReferralRewardConfig,
  updateNftMarketplaceConfig,
  updateNftWithdrawalConfig,
  updateSupportConfig,
} = require("../services/settings.service");
const {
  broadcastBotResumed,
  broadcastBotPaused,
} = require("../services/bot-broadcast.service");
const { emitUserUpdate } = require("../socket");
const {
  listPaymentCardsForAdmin,
} = require("../services/payment-card.service");
const {
  getTelegramUserProfilePhoto,
} = require("../services/telegram-profile-photo.service");
const {
  listSuspiciousDevices,
} = require("../services/security-device.service");
const {
  listReferralPromoCodes: listReferralPromoCodesService,
  markReferralPromoCodeUsed: markReferralPromoCodeUsedService,
} = require("../services/referral-promo-code.service");
const { syncGwPubgCatalog, syncGwMlbbCatalog } = require("../services/gw-catalog.service");

const PURCHASE_PRODUCTS = ["star", "premium", "uc", "freefire", "mlbb"];
const PAID_STATUSES = ["paid_auto_processed", "completed"];

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeGiftId(value) {
  const normalized = normalizeString(value);
  if (!normalized) return "";
  try {
    if (/^\d+$/.test(normalized)) return BigInt(normalized).toString();
  } catch (_) {
    // ignore
  }
  return normalized;
}

function normalizeUsername(value) {
  return normalizeString(value).replace(/^@+/, "");
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeDisplayName(user) {
  if (!user || typeof user !== "object") return "";
  const profile = normalizeString(user.profileName);
  if (profile) return profile;
  const username = normalizeUsername(user.username);
  if (username) return `@${username}`;
  return normalizeString(user.tgUserId);
}

function buildAdminUserPhotoUrl(tgUserId) {
  const normalized = normalizeString(tgUserId);
  if (!normalized) return "";
  return `/api/admin/users/${encodeURIComponent(normalized)}/photo`;
}

function queueBotStatusBroadcast(type) {
  const runner =
    type === "resumed" ? broadcastBotResumed : type === "paused" ? broadcastBotPaused : null;
  if (!runner) return;

  setImmediate(() => {
    runner().catch((error) => {
      console.error(
        `[admin-settings] Bot ${type} broadcast error:`,
        error?.message || error,
      );
    });
  });
}

function parseNftSlugAndNumber(value) {
  const normalized = normalizeString(value);
  if (!normalized) {
    return {
      slug: "",
      nftNumber: 0,
      nftNumberText: "",
    };
  }

  const match = normalized.match(/^(.*)-(\d{1,18})$/);
  if (!match) {
    return {
      slug: "",
      nftNumber: 0,
      nftNumberText: "",
    };
  }

  const slug = normalizeString(match[1]).replace(/[-_]+$/, "");
  const nftNumberText = normalizeString(match[2]);
  const nftNumber = Number(nftNumberText);

  if (!slug || !Number.isFinite(nftNumber) || nftNumber <= 0) {
    return {
      slug: "",
      nftNumber: 0,
      nftNumberText: "",
    };
  }

  return {
    slug,
    nftNumber,
    nftNumberText,
  };
}

function extractTelegramNftSearchMeta(query) {
  const rawQuery = normalizeString(query);
  if (!rawQuery) {
    return {
      candidate: "",
      slug: "",
      nftNumber: 0,
      nftNumberText: "",
      titleFromSlug: "",
    };
  }

  let candidate = rawQuery;
  const directMatch = rawQuery.match(
    /(?:https?:\/\/)?(?:t(?:elegram)?\.me)\/nft\/([^\s/?#]+)/i,
  );

  if (directMatch?.[1]) {
    candidate = directMatch[1];
  } else {
    const normalizedRaw = rawQuery.replace(/^https?:\/\//i, "");
    if (/^(?:t(?:elegram)?\.me)\/nft\//i.test(normalizedRaw)) {
      const inline = normalizedRaw.match(/^(?:t(?:elegram)?\.me)\/nft\/([^\s/?#]+)/i);
      if (inline?.[1]) candidate = inline[1];
    }
  }

  if (!directMatch?.[1]) {
    try {
      const candidateUrl = rawQuery.includes("://") ? rawQuery : "https://" + rawQuery;
      const url = new URL(candidateUrl);
      const parts = String(url.pathname || "")
        .split("/")
        .filter(Boolean);
      const nftIndex = parts.findIndex((part) => /^nft$/i.test(part));
      if (nftIndex >= 0 && parts[nftIndex + 1]) {
        candidate = parts[nftIndex + 1];
      }
    } catch (_) {
      // ignore invalid URL input
    }
  }

  const candidateRaw = String(candidate || "").split(/[?#]/)[0].replace(/\/+$/, "");
  let decodedCandidate = normalizeString(candidateRaw);
  try {
    decodedCandidate = normalizeString(decodeURIComponent(candidateRaw));
  } catch (_) {
    decodedCandidate = normalizeString(candidateRaw);
  }

  const parsed = parseNftSlugAndNumber(decodedCandidate);
  const titleFromSlug = parsed.slug
    ? normalizeString(
        parsed.slug
          .replace(/[-_]+/g, " ")
          .replace(/([a-z])([A-Z])/g, "$1 $2"),
      )
    : "";

  return {
    candidate: decodedCandidate,
    slug: parsed.slug,
    nftNumber: parsed.nftNumber,
    nftNumberText: parsed.nftNumberText,
    titleFromSlug,
  };
}
async function resolveUserByIdentifier(identifier) {
  const raw = normalizeString(identifier);
  if (!raw) return null;

  const normalizedUsername = normalizeUsername(raw);
  const conditions = [{ tgUserId: raw }];
  if (normalizedUsername) {
    conditions.push({ username: normalizedUsername });
  }

  return User.findOne({ $or: conditions }).lean();
}

async function cancelPendingOffersForNftAdmin(nftId, reason = "admin_nft_action") {
  const normalizedNftId = normalizeString(nftId);
  if (!normalizedNftId) return 0;

  const pending = await NftOffer.find({
    nftId: normalizedNftId,
    status: "pending",
  })
    .select({ _id: 1, buyerTgUserId: 1, sellerTgUserId: 1 })
    .lean();

  if (!pending.length) return 0;

  const now = new Date();
  await NftOffer.updateMany(
    { _id: { $in: pending.map((item) => item._id) }, status: "pending" },
    {
      $set: {
        status: "cancelled",
        cancelledAt: now,
        respondedAt: now,
        cancelReason: normalizeString(reason) || "admin_nft_action",
      },
    },
  );

  for (const offer of pending) {
    emitUserUpdate(normalizeString(offer.buyerTgUserId), {
      type: "nft_offer_cancelled",
      refreshNfts: true,
      refreshNftOffers: true,
      nftId: normalizedNftId,
      offerId: String(offer._id),
    });
    emitUserUpdate(normalizeString(offer.sellerTgUserId), {
      type: "nft_offer_cancelled",
      refreshNftOffers: true,
      nftId: normalizedNftId,
      offerId: String(offer._id),
    });
  }

  return pending.length;
}

function mapAdminGiftItem(doc) {
  const normalizedGiftId = normalizeString(doc?.giftId);
  return {
    userGiftId: String(doc?._id || ""),
    giftId: normalizedGiftId,
    title: normalizeString(doc?.title) || "Gift",
    emoji: normalizeString(doc?.emoji) || "🎁",
    status: normalizeString(doc?.status) || "owned",
    priceUzs: Number(doc?.priceUzs || 0),
    stars: Number(doc?.stars || 0),
    imageUrl: normalizedGiftId
      ? "/api/gifts/image/" + encodeURIComponent(normalizedGiftId)
      : "",
    createdAt: doc?.createdAt || null,
    sentAt: doc?.sentAt || null,
  };
}

function mapAdminGiftHistoryItems(doc) {
  const items = [];
  const giftId = normalizeString(doc?.giftId);
  const title = normalizeString(doc?.title) || "Gift";
  const emoji = normalizeString(doc?.emoji) || "🎁";
  const amount = Number(doc?.priceUzs || 0);
  const imageUrl = giftId ? "/api/gifts/image/" + encodeURIComponent(giftId) : "";
  const createdAt = doc?.createdAt || null;
  const sentAt = doc?.sentAt || null;

  if (createdAt) {
    items.push({
      type: "gift",
      action: "purchased",
      itemId: String(doc?._id || ""),
      giftId,
      title,
      emoji,
      amountUzs: amount,
      timestamp: createdAt,
      imageUrl,
    });
  }

  if (sentAt) {
    items.push({
      type: "gift",
      action: "sent",
      itemId: String(doc?._id || ""),
      giftId,
      title,
      emoji,
      amountUzs: amount,
      timestamp: sentAt,
      imageUrl,
      recipient: normalizeString(doc?.sentToResolved || doc?.sentToValue),
    });
  }

  return items;
}

function mapAdminNftItem(doc) {
  const normalizedNftId = normalizeString(doc?.nftId);
  const patternStatus = normalizeString(doc?.patternAssetStatus) || "unknown";
  const patternImageUrl =
    patternStatus === "available" && normalizedNftId
      ? "/api/gifts/nft-pattern/" + encodeURIComponent(normalizedNftId)
      : "";

  return {
    nftId: normalizedNftId,
    giftId: normalizeString(doc?.giftId),
    slug: normalizeString(doc?.slug),
    title: normalizeString(doc?.title) || "NFT Gift",
    nftNumber: Number(doc?.nftNumber || 0),
    ownerTgUserId: normalizeString(doc?.ownerTgUserId),
    ownerUsername: normalizeString(doc?.ownerUsername),
    marketStatus: normalizeString(doc?.marketStatus) || "owned",
    listingPriceUzs: Number(doc?.listingPriceUzs || 0),
    isTelegramPresent: Boolean(doc?.isTelegramPresent),
    imageUrl:
      "/api/gifts/nft-image/" + encodeURIComponent(normalizedNftId),
    backdrop: normalizeString(doc?.backdrop),
    backdropRarity: normalizeString(doc?.backdropRarity),
    backdropColors: {
      center: normalizeString(doc?.backdropColors?.center) || "#346d2b",
      edge: normalizeString(doc?.backdropColors?.edge) || "#2d5f24",
      pattern: normalizeString(doc?.backdropColors?.pattern) || "#8ec95d",
      text: normalizeString(doc?.backdropColors?.text) || "#eaffdc",
    },
    patternAsset: {
      status: patternStatus,
      sourceMethod: normalizeString(doc?.patternAssetSourceMethod),
      sourceLabel: normalizeString(doc?.patternAssetSourceLabel),
      path: normalizeString(doc?.patternAssetPath),
      mimeType: normalizeString(doc?.patternAssetMimeType),
      missingReason: normalizeString(doc?.patternAssetMissingReason),
      imageUrl: patternImageUrl,
    },
    createdAt: doc?.createdAt || null,
    updatedAt: doc?.updatedAt || null,
  };
}

function buildNftTradeHistoryItem(offer, selfTgUserId, nftTitleMap) {
  const isBuyer =
    normalizeString(offer?.buyerTgUserId) === normalizeString(selfTgUserId);
  const nftId = normalizeString(offer?.nftId);
  const title = normalizeString(nftTitleMap.get(nftId)) || "NFT Gift";
  const timestamp = offer?.acceptedAt || offer?.respondedAt || offer?.createdAt || null;

  return {
    type: "nft",
    action: isBuyer ? "buy" : "sell",
    itemId: String(offer?._id || ""),
    nftId,
    title,
    amountUzs: Number(offer?.offeredPriceUzs || 0),
    timestamp,
    counterparty: isBuyer
      ? normalizeString(
          offer?.sellerProfileName || offer?.sellerUsername || offer?.sellerTgUserId,
        )
      : normalizeString(
          offer?.buyerProfileName || offer?.buyerUsername || offer?.buyerTgUserId,
        ),
  };
}

async function measureSingleOrderCreateSeconds() {
  const now = Date.now();
  const random = Math.floor(Math.random() * 1000);
  const uniqueId = Number(`${now}${String(random).padStart(3, "0")}`);
  let createdOrderId = null;

  const start = process.hrtime.bigint();
  let end = start;
  try {
    const created = await Order.create({
      orderId: uniqueId,
      product: "star",
      planCode: "diag_speed_test",
      customAmount: 0,
      username: "diag_speed_test",
      tgUserId: "",
      tgUsername: "",
      profileName: "",
      paymentMethod: "card",
      expectedAmount: 1,
      paidAmount: 0,
      status: "failed",
      sequence: uniqueId,
    });
    createdOrderId = created?._id || null;
    end = process.hrtime.bigint();
  } finally {
    if (createdOrderId) {
      await Order.deleteOne({ _id: createdOrderId });
    }
  }
  return Number(end - start) / 1e9;
}

async function buildAdminUserList(items) {
  const users = Array.isArray(items) ? items : [];
  const userIds = users.map((item) => normalizeString(item.tgUserId)).filter(Boolean);
  if (!userIds.length) return [];

  const [orderRows, inviteRows] = await Promise.all([
    Order.aggregate([
      {
        $match: {
          tgUserId: { $in: userIds },
        },
      },
      {
        $group: {
          _id: "$tgUserId",
          totalOrders: { $sum: 1 },
          totalSpent: {
            $sum: {
              $cond: [{ $gt: ["$paidAmount", 0] }, "$paidAmount", 0],
            },
          },
        },
      },
    ]),
    User.aggregate([
      {
        $match: {
          referredByUserId: { $in: userIds },
        },
      },
      {
        $group: {
          _id: "$referredByUserId",
          inviteCount: { $sum: 1 },
          activeInviteCount: {
            $sum: {
              $cond: [{ $eq: ["$referralExcludedAt", null] }, 1, 0],
            },
          },
          excludedInviteCount: {
            $sum: {
              $cond: [{ $ne: ["$referralExcludedAt", null] }, 1, 0],
            },
          },
        },
      },
    ]),
  ]);

  const orderMap = new Map(orderRows.map((item) => [String(item._id), item]));
  const inviteMap = new Map(inviteRows.map((item) => [String(item._id), item]));

  return users.map((user) => {
    const orderRow = orderMap.get(String(user.tgUserId)) || {};
    const inviteRow = inviteMap.get(String(user.tgUserId)) || {};

    return {
      _id: user._id,
      tgUserId: String(user.tgUserId || ""),
      username: String(user.username || ""),
      profileName: String(user.profileName || ""),
      displayName: normalizeDisplayName(user),
      photoUrl: buildAdminUserPhotoUrl(user.tgUserId),
      balance: Number(user.balance || 0),
      isBlocked: Boolean(user.isBlocked),
      blockedAt: user.blockedAt || null,
      blockedReason: String(user.blockedReason || ""),
      referralBlockedAt: user.referralBlockedAt || null,
      referralBlockedReason: String(user.referralBlockedReason || ""),
      referralEarningsTotal: Number(user.referralEarningsTotal || 0),
      createdAt: user.createdAt || null,
      updatedAt: user.updatedAt || null,
      stats: {
        totalOrders: Number(orderRow.totalOrders || 0),
        totalSpent: Number(orderRow.totalSpent || 0),
        inviteCount: Number(inviteRow.activeInviteCount ?? inviteRow.inviteCount ?? 0),
        totalInviteCount: Number(inviteRow.inviteCount || 0),
        excludedInviteCount: Number(inviteRow.excludedInviteCount || 0),
      },
    };
  });
}

const parseAllowlist = () => {
  const raw =
    process.env.ADMIN_ALLOWED_TG_IDS ||
    process.env.ADMIN_NOTIFY_CHAT_ID ||
    "";
  return raw
    .split(",")
    .map((id) => String(id).trim())
    .filter(Boolean);
};

const isAllowedAdmin = (req) => {
  const allowlist = parseAllowlist();
  if (allowlist.length === 0) return false;
  const userId = normalizeString(req?.telegramAuth?.tgUserId);
  return allowlist.includes(userId);
};

const checkAccess = async (req, res) => {
  if (!isAllowedAdmin(req)) {
    return response.unauthorized(res, "Admin ruxsat yo'q");
  }
  return response.success(res, "Admin ruxsat bor", { allowed: true });
};

const login = async (req, res) => {
  const { username, password, tgUserId } = req.validated;
  const adminLogin = normalizeString(process.env.ADMIN_LOGIN);
  const adminPasswordHash = normalizeString(process.env.ADMIN_PASSWORD_HASH);

  if (!isAllowedAdmin(req)) {
    return response.unauthorized(res, "Admin ruxsat yo'q");
  }
  if (normalizeString(tgUserId) !== normalizeString(req?.telegramAuth?.tgUserId)) {
    return response.unauthorized(res, "Admin Telegram user mos emas");
  }

  if (!adminLogin || !adminPasswordHash) {
    return response.serverError(
      res,
      "Admin login sozlamalari to'liq emas (ADMIN_LOGIN/ADMIN_PASSWORD_HASH)",
    );
  }

  if (!username || username !== adminLogin) {
    return response.unauthorized(res, "Login yoki parol noto'g'ri");
  }

  const isValidPassword = await bcrypt.compare(String(password || ""), adminPasswordHash);
  if (!isValidPassword) {
    return response.unauthorized(res, "Login yoki parol noto'g'ri");
  }

  const secret = process.env.JWT_SECRET_KEY;
  if (!secret) {
    return response.serverError(res, "JWT_SECRET_KEY topilmadi");
  }

  const token = jwt.sign(
    {
      role: "admin",
      username,
      tgUserId: normalizeString(req.telegramAuth.tgUserId),
      jti: crypto.randomUUID(),
    },
    secret,
    {
      expiresIn: normalizeString(process.env.ADMIN_JWT_TTL) || "2h",
      issuer: "yamaha-api",
      audience: "yamaha-admin",
    },
  );
  return response.success(res, "Admin login muvaffaqiyatli", {
    token,
    username,
  });
};

const getPlans = async (_, res) => {
  try {
    const plans = await Plan.find().sort({ category: 1, amount: 1 }).lean();
    return response.success(res, "Plans", plans);
  } catch (error) {
    return response.serverError(
      res,
      "Planlarni olishda xatolik",
      error.message,
    );
  }
};

const createPlan = async (req, res) => {
  try {
    const payload = req.validated;
    const exists = await Plan.findOne({
      category: payload.category,
      code: payload.code,
    }).lean();
    if (exists) {
      return response.error(res, "Bu category+code allaqachon mavjud");
    }

    const plan = await Plan.create(payload);
    return response.created(res, "Yangi plan qo'shildi", plan);
  } catch (error) {
    return response.serverError(res, "Plan qo'shishda xatolik", error.message);
  }
};

const updatePlan = async (req, res) => {
  try {
    const { id } = req.params;
    const payload = req.validated;

    const existing = await Plan.findById(id).lean();
    if (!existing) return response.notFound(res, "Plan topilmadi");
    if (
      existing.provider === "gw" &&
      typeof payload.amount === "number" &&
      Number(payload.amount) !== Number(existing.amount)
    ) {
      return response.error(res, "GW paket miqdorini qo'lda o'zgartirib bo'lmaydi");
    }
    const nextActive =
      typeof payload.isActive === "boolean" ? payload.isActive : existing.isActive;
    const nextPrice =
      typeof payload.basePrice === "number" ? payload.basePrice : existing.basePrice;
    if (nextActive && (!Number.isFinite(nextPrice) || nextPrice <= 0)) {
      return response.error(
        res,
        "Paketni faollashtirishdan oldin mijoz narxini 0 dan katta kiriting",
      );
    }

    const updated = await Plan.findByIdAndUpdate(id, payload, {
      new: true,
      runValidators: true,
    }).lean();

    if (!updated) return response.notFound(res, "Plan topilmadi");
    return response.success(res, "Plan yangilandi", updated);
  } catch (error) {
    return response.serverError(res, "Plan yangilashda xatolik", error.message);
  }
};

const deletePlan = async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await Plan.findById(id).lean();
    if (!existing) return response.notFound(res, "Plan topilmadi");
    if (existing.provider === "gw") {
      return response.error(
        res,
        "GW paketini o'chirmang; kerak bo'lsa nofaol holatga o'tkazing",
      );
    }
    const deleted = await Plan.findByIdAndDelete(id).lean();
    if (!deleted) return response.notFound(res, "Plan topilmadi");
    return response.success(res, "Plan o'chirildi", deleted);
  } catch (error) {
    return response.serverError(res, "Plan o'chirishda xatolik", error.message);
  }
};

const syncGwPubgPlans = async (_, res) => {
  try {
    const plans = await syncGwPubgCatalog();
    return response.success(res, "GW PUBG katalogi yangilandi", plans);
  } catch (error) {
    const status = Number(error?.response?.status || 0);
    const payload = error?.response?.data;
    const code = String(payload?.code || payload?.error || "").trim().toUpperCase();
    const knownMessages = {
      MISSING_API_KEY: "GW API kaliti serverda topilmadi",
      INVALID_API_KEY: "GW API kaliti noto'g'ri yoki bekor qilingan",
      INVALID_API_KEY_FORMAT: "GW API kaliti formati noto'g'ri",
      API_DISABLED: "GW profilingizda API access yoqilmagan",
      API_DISABLED_BY_ADMIN: "GW API access administrator tomonidan o'chirilgan",
      API_NOT_ELIGIBLE: "GW profilingiz API ishlatish talablariga mos emas",
      IP_ALLOWLIST_REQUIRED: "GW profilida server IPv4 manzilini allowlistga kiriting",
      IP_NOT_ALLOWED: "Serverning chiqish IPv4 manzili GW allowlistda yo'q",
      ACCOUNT_BANNED: "GW hisob bloklangan",
      ACCOUNT_RESTRICTED: "GW hisob vaqtincha cheklangan",
      RATE_LIMIT: "GW API so'rov limiti oshdi; birozdan keyin qayta urinib ko'ring",
    };
    const detail =
      knownMessages[code] ||
      (status === 401
        ? "GW API autentifikatsiyasi muvaffaqiyatsiz"
        : status === 403
          ? "GW API ushbu serverga ruxsat bermadi"
          : status === 429
            ? "GW API so'rov limiti oshdi"
            : status >= 500
              ? "GW API vaqtincha ishlamayapti"
              : String(error?.message || "GW katalogini olib bo'lmadi").slice(0, 300));
    console.error("GW PUBG catalog sync failed:", {
      status,
      code: code || "UNKNOWN",
      message: String(error?.message || "").slice(0, 300),
    });
    return response.error(res, detail, {
      code: code || "GW_CATALOG_SYNC_FAILED",
      providerStatus: status || null,
    });
  }
};

const syncGwMlbbPlans = async (_, res) => {
  const traceId = `admin-mlbb-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  try {
    const plans = await syncGwMlbbCatalog({ traceId });
    return response.success(res, "GW MLBB katalogi yangilandi", plans);
  } catch (error) {
    const status = Number(error?.response?.status || 0);
    const payload = error?.response?.data;
    const code = String(payload?.code || payload?.error || "").trim().toUpperCase();
    const knownMessages = {
      MISSING_API_KEY: "GW API kaliti serverda topilmadi",
      INVALID_API_KEY: "GW API kaliti noto'g'ri yoki bekor qilingan",
      API_DISABLED: "GW profilingizda API access yoqilmagan",
      IP_ALLOWLIST_REQUIRED: "GW profilida server IPv4 manzilini allowlistga kiriting",
      IP_NOT_ALLOWED: "Serverning chiqish IPv4 manzili GW allowlistda yo'q",
      RATE_LIMIT: "GW API so'rov limiti oshdi; birozdan keyin qayta urinib ko'ring",
    };
    const detail = knownMessages[code] || String(payload?.message || payload?.error || error?.message || "GW MLBB katalogini olib bo'lmadi").slice(0, 300);
    console.error("[GW_MLBB_SYNC_REQUEST]", JSON.stringify({ traceId, stage: "failed", status, code: code || "UNKNOWN", message: error?.message, stack: error?.stack }));
    return response.error(res, detail, {
      code: code || "GW_CATALOG_SYNC_FAILED", providerStatus: status || null, traceId,
    });
  }
};

const getSettings = async (_, res) => {
  try {
    const starPricing = await getStarPricing();
    const gameStarsPaymentConfig = await getGameStarsPaymentConfig();
    const starSellPricing = await getStarSellPricing();
    const forceJoin = await getForceJoin();
    const botStatus = await getBotStatus();
    const botBroadcastConfig = await getBotBroadcastConfig();
    const paymentCardConfig = await getPaymentCardConfig();
    const bankomatTopupConfig = await getBankomatTopupConfig();
    const referralConfig = await getReferralConfig();
    const referralRewardConfig = await getReferralRewardConfig();
    const nftMarketplaceConfig = await getNftMarketplaceConfig();
    const nftWithdrawalConfig = await getNftWithdrawalConfig();
    const supportConfig = await getSupportConfig();

    return response.success(res, "Settings", {
      starPricing,
      gameStarsPaymentConfig,
      starSellPricing,
      forceJoin,
      botStatus,
      botBroadcastConfig,
      paymentCardConfig,
      bankomatTopupConfig,
      referralConfig,
      referralRewardConfig,
      nftMarketplaceConfig,
      nftWithdrawalConfig,
      supportConfig,
    });
  } catch (error) {
    return response.serverError(res, "Settings xatolik", error.message);
  }
};

const updateSettings = async (req, res) => {
  try {
    const {
      starPricing,
      gameStarsPaymentConfig,
      starSellPricing,
      forceJoin,
      botStatus,
      botBroadcastConfig,
      paymentCardConfig,
      bankomatTopupConfig,
      referralConfig,
      referralRewardConfig,
      nftMarketplaceConfig,
      nftWithdrawalConfig,
      supportConfig,
    } = req.body || {};

    if (
      !starPricing &&
      !gameStarsPaymentConfig &&
      !starSellPricing &&
      !forceJoin &&
      !botStatus &&
      !botBroadcastConfig &&
      !paymentCardConfig &&
      !bankomatTopupConfig &&
      !referralConfig &&
      !referralRewardConfig &&
      !nftMarketplaceConfig &&
      !nftWithdrawalConfig &&
      !supportConfig
    ) {
      return response.error(
        res,
        "starPricing yoki gameStarsPaymentConfig yoki starSellPricing yoki forceJoin yoki botStatus yoki botBroadcastConfig yoki paymentCardConfig yoki bankomatTopupConfig yoki referralConfig yoki referralRewardConfig yoki nftMarketplaceConfig yoki nftWithdrawalConfig yoki supportConfig required",
      );
    }

    const out = {};
    const prevBotStatus = botStatus ? await getBotStatus() : null;

    if (starPricing) out.starPricing = await updateStarPricing(starPricing);
    if (gameStarsPaymentConfig) {
      out.gameStarsPaymentConfig = await updateGameStarsPaymentConfig(
        gameStarsPaymentConfig,
      );
    }
    if (starSellPricing) {
      out.starSellPricing = await updateStarSellPricing(starSellPricing);
    }
    if (forceJoin) out.forceJoin = await updateForceJoin(forceJoin);
    if (botStatus) out.botStatus = await updateBotStatus(botStatus);
    if (botBroadcastConfig) {
      out.botBroadcastConfig = await updateBotBroadcastConfig(botBroadcastConfig);
    }
    if (paymentCardConfig) {
      out.paymentCardConfig = await updatePaymentCardConfig(paymentCardConfig);
    }
    if (bankomatTopupConfig) {
      out.bankomatTopupConfig = await updateBankomatTopupConfig(
        bankomatTopupConfig,
      );
    }
    if (referralConfig) {
      out.referralConfig = await updateReferralConfig(referralConfig);
    }
    if (referralRewardConfig) {
      out.referralRewardConfig = await updateReferralRewardConfig(
        referralRewardConfig,
      );
    }
    if (nftMarketplaceConfig) {
      out.nftMarketplaceConfig = await updateNftMarketplaceConfig(
        nftMarketplaceConfig,
      );
    }
    if (nftWithdrawalConfig) {
      out.nftWithdrawalConfig = await updateNftWithdrawalConfig(
        nftWithdrawalConfig,
      );
    }
    if (supportConfig) {
      out.supportConfig = await updateSupportConfig(supportConfig);
    }

    const shouldBroadcastResume = Boolean(
      botStatus &&
        prevBotStatus &&
        !prevBotStatus.enabled &&
        out.botStatus?.enabled,
    );
    const shouldBroadcastPause = Boolean(
      botStatus &&
        prevBotStatus &&
        prevBotStatus.enabled &&
        out.botStatus &&
        !out.botStatus.enabled,
    );

    if (shouldBroadcastResume) {
      out.broadcast = { queued: true, type: "resumed" };
      queueBotStatusBroadcast("resumed");
    }

    if (shouldBroadcastPause) {
      out.broadcast = { queued: true, type: "paused" };
      queueBotStatusBroadcast("paused");
    }

    return response.success(res, "Settings yangilandi", out);
  } catch (error) {
    return response.serverError(
      res,
      "Settings yangilashda xatolik",
      error.message,
    );
  }
};

const getReferralPromoCodes = async (req, res) => {
  try {
    const query = String(req.query?.q || req.query?.query || "").trim();
    const requestedPage = Number(req.query?.page || 1);
    const requestedLimit = Number(req.query?.limit || 20);
    const page =
      Number.isFinite(requestedPage) && requestedPage > 0
        ? Math.floor(requestedPage)
        : 1;
    const limit =
      Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(100, Math.floor(requestedLimit))
        : 20;

    const result = await listReferralPromoCodesService({ query, page, limit });
    return response.success(res, "Referral promo codes", result);
  } catch (error) {
    return response.serverError(
      res,
      "Referral promo code'larni olishda xatolik",
      error.message,
    );
  }
};

const markReferralPromoCodeUsed = async (req, res) => {
  try {
    const code = String(req.body?.code || req.params?.code || "").trim();
    const usedPurpose = String(req.body?.usedPurpose || "").trim();
    const adminNote = String(req.body?.adminNote || "").trim();
    const result = await markReferralPromoCodeUsedService({
      code,
      usedPurpose,
      adminId: req?.admin?.tgUserId || "",
      adminUsername: req?.admin?.username || "",
      adminNote,
    });

    if (!result?.ok) {
      return response.error(
        res,
        result?.reason === "not_found"
          ? "Promo kod topilmadi"
          : "Promo kodni yangilab bo'lmadi",
        { code: result?.reason || "promo_code_update_failed" },
      );
    }

    return response.success(
      res,
      result.alreadyUsed ? "Promo kod avval ishlatilgan" : "Promo kod ishlatilgan",
      result,
    );
  } catch (error) {
    return response.serverError(
      res,
      "Promo kodni yangilashda xatolik",
      error.message,
    );
  }
};

const getPaymentCards = async (_, res) => {
  try {
    const result = await listPaymentCardsForAdmin();
    return response.success(res, "Payment cards", result);
  } catch (error) {
    return response.serverError(
      res,
      "To'lov kartalarini olishda xatolik",
      error.message,
    );
  }
};

const createPaymentCard = async (req, res) => {
  try {
    const card = await PaymentCard.create(req.validated);
    return response.created(res, "To'lov kartasi qo'shildi", card);
  } catch (error) {
    return response.serverError(
      res,
      "To'lov kartasi qo'shishda xatolik",
      error.message,
    );
  }
};

const updatePaymentCard = async (req, res) => {
  try {
    const updated = await PaymentCard.findByIdAndUpdate(
      req.params.id,
      req.validated,
      { new: true, runValidators: true },
    ).lean();

    if (!updated) return response.notFound(res, "To'lov kartasi topilmadi");
    return response.success(res, "To'lov kartasi yangilandi", updated);
  } catch (error) {
    return response.serverError(
      res,
      "To'lov kartasini yangilashda xatolik",
      error.message,
    );
  }
};

const deletePaymentCard = async (req, res) => {
  try {
    const deleted = await PaymentCard.findByIdAndDelete(req.params.id).lean();
    if (!deleted) return response.notFound(res, "To'lov kartasi topilmadi");
    return response.success(res, "To'lov kartasi o'chirildi", deleted);
  } catch (error) {
    return response.serverError(
      res,
      "To'lov kartasini o'chirishda xatolik",
      error.message,
    );
  }
};

const searchUsers = async (req, res) => {
  try {
    const rawQuery = normalizeString(req.query.q);
    if (!rawQuery) {
      return response.success(res, "Users", {
        query: "",
        items: [],
      });
    }

    const normalizedUsername = normalizeUsername(rawQuery);
    const usernameRegex = normalizedUsername
      ? new RegExp(escapeRegex(normalizedUsername), "i")
      : null;

    const conditions = [{ tgUserId: rawQuery }];
    if (normalizedUsername) {
      conditions.push({ username: normalizedUsername });
      conditions.push({ username: { $regex: usernameRegex } });
    }

    const users = await User.find({ $or: conditions })
      .sort({ updatedAt: -1, createdAt: -1 })
      .limit(20)
      .lean();

    const uniqueUsers = Array.from(
      new Map(users.map((item) => [String(item.tgUserId), item])).values(),
    ).sort((left, right) => {
      const leftUsername = normalizeUsername(left.username).toLowerCase();
      const rightUsername = normalizeUsername(right.username).toLowerCase();
      const queryLower = rawQuery.toLowerCase();
      const queryUsername = normalizedUsername.toLowerCase();

      const getRank = (itemUsername, itemUserId) => {
        if (String(itemUserId) === rawQuery) return 0;
        if (itemUsername === queryUsername) return 1;
        if (itemUsername.startsWith(queryUsername)) return 2;
        if (itemUsername.includes(queryUsername)) return 3;
        return 4;
      };

      return (
        getRank(leftUsername, left.tgUserId) -
          getRank(rightUsername, right.tgUserId) ||
        new Date(right.updatedAt || right.createdAt || 0) -
          new Date(left.updatedAt || left.createdAt || 0)
      );
    });

    const items = await buildAdminUserList(uniqueUsers);
    return response.success(res, "Users", {
      query: rawQuery,
      items,
    });
  } catch (error) {
    return response.serverError(
      res,
      "Foydalanuvchilarni qidirishda xatolik",
      error.message,
    );
  }
};

const getUserReferrals = async (req, res) => {
  try {
    const tgUserId = normalizeString(req.params.tgUserId);
    if (!tgUserId) {
      return response.error(res, "Foydalanuvchi topilmadi");
    }

    const user = await User.findOne({ tgUserId }).lean();
    if (!user) {
      return response.notFound(res, "Foydalanuvchi topilmadi");
    }

    const requestedPage = Number(req.query?.page || 1);
    const requestedLimit = Number(req.query?.limit || 20);
    const page =
      Number.isFinite(requestedPage) && requestedPage > 0
        ? Math.floor(requestedPage)
        : 1;
    const limit =
      Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(100, Math.floor(requestedLimit))
        : 20;

    const [totalItems, activeItems, excludedItems] = await Promise.all([
      User.countDocuments({ referredByUserId: tgUserId }),
      User.countDocuments({ referredByUserId: tgUserId, referralExcludedAt: null }),
      User.countDocuments({ referredByUserId: tgUserId, referralExcludedAt: { $ne: null } }),
    ]);
    const totalPages = Math.max(1, Math.ceil(Number(totalItems || 0) / limit));
    const safePage = Math.min(page, totalPages);

    const items = totalItems
      ? await User.find({ referredByUserId: tgUserId })
          .sort({ referredAt: -1, createdAt: -1 })
          .skip((safePage - 1) * limit)
          .limit(limit)
          .select({
            tgUserId: 1,
            username: 1,
            profileName: 1,
            referredAt: 1,
            referralActivatedAt: 1,
            referralExcludedAt: 1,
            referralExcludedReason: 1,
            referralExcludedByAdminId: 1,
            referralRestoredAt: 1,
            isBlocked: 1,
            createdAt: 1,
          })
          .lean()
      : [];

    return response.success(res, "User referrals", {
      user: {
        tgUserId: String(user.tgUserId || ""),
        username: String(user.username || ""),
        referralBlockedAt: user.referralBlockedAt || null,
        referralBlockedReason: String(user.referralBlockedReason || ""),
      },
      pagination: {
        page: safePage,
        limit,
        totalItems: Number(totalItems || 0),
        activeItems: Number(activeItems || 0),
        excludedItems: Number(excludedItems || 0),
        totalPages,
      },
      items: items.map((item) => ({
        tgUserId: String(item.tgUserId || ""),
        username: String(item.username || ""),
        profileName: String(item.profileName || ""),
        referredAt: item.referredAt || item.createdAt || null,
        referralActivatedAt: item.referralActivatedAt || null,
        referralExcludedAt: item.referralExcludedAt || null,
        referralExcludedReason: String(item.referralExcludedReason || ""),
        referralExcludedByAdminId: String(item.referralExcludedByAdminId || ""),
        referralRestoredAt: item.referralRestoredAt || null,
        isBlocked: Boolean(item.isBlocked),
        isReferralExcluded: Boolean(item.referralExcludedAt),
      })),
    });
  } catch (error) {
    return response.serverError(
      res,
      "Taklif qilgan mijozlarni olishda xatolik",
      error.message,
    );
  }
};

const updateUserReferralExclusion = async (req, res) => {
  try {
    const referrerTgUserId = normalizeString(req.params.tgUserId);
    const referredTgUserId = normalizeString(req.params.referredTgUserId);
    const excluded = Boolean(req.body?.excluded);
    const reason = normalizeString(req.body?.reason);

    if (!referrerTgUserId || !referredTgUserId) {
      return response.error(res, "Referral ma'lumotlari noto'g'ri");
    }

    const referredUser = await User.findOne({
      tgUserId: referredTgUserId,
      referredByUserId: referrerTgUserId,
    }).lean();
    if (!referredUser) {
      return response.notFound(res, "Taklif qilingan mijoz topilmadi");
    }

    const now = new Date();
    const adminId = normalizeString(req?.telegramAuth?.tgUserId || req?.admin?.tgUserId);
    const update = excluded
      ? {
          referralExcludedAt: now,
          referralExcludedReason: reason || "Admin tomonidan bekor qilindi",
          referralExcludedByAdminId: adminId,
        }
      : {
          referralExcludedAt: null,
          referralExcludedReason: "",
          referralExcludedByAdminId: "",
          referralRestoredAt: now,
          referralRestoredByAdminId: adminId,
        };

    const updated = await User.findOneAndUpdate(
      { tgUserId: referredTgUserId, referredByUserId: referrerTgUserId },
      { $set: update },
      { new: true },
    )
      .select({
        tgUserId: 1,
        username: 1,
        profileName: 1,
        referredAt: 1,
        referralActivatedAt: 1,
        referralExcludedAt: 1,
        referralExcludedReason: 1,
        referralExcludedByAdminId: 1,
        referralRestoredAt: 1,
        isBlocked: 1,
        createdAt: 1,
      })
      .lean();

    return response.success(
      res,
      excluded ? "Referral hisobdan chiqarildi" : "Referral qayta hisobga qo'shildi",
      {
        tgUserId: String(updated.tgUserId || ""),
        username: String(updated.username || ""),
        profileName: String(updated.profileName || ""),
        referredAt: updated.referredAt || updated.createdAt || null,
        referralActivatedAt: updated.referralActivatedAt || null,
        referralExcludedAt: updated.referralExcludedAt || null,
        referralExcludedReason: String(updated.referralExcludedReason || ""),
        referralExcludedByAdminId: String(updated.referralExcludedByAdminId || ""),
        referralRestoredAt: updated.referralRestoredAt || null,
        isBlocked: Boolean(updated.isBlocked),
        isReferralExcluded: Boolean(updated.referralExcludedAt),
      },
    );
  } catch (error) {
    return response.serverError(
      res,
      "Referral holatini yangilashda xatolik",
      error.message,
    );
  }
};

const excludeAllUserReferrals = async (req, res) => {
  try {
    const referrerTgUserId = normalizeString(req.params.tgUserId);
    const reason = normalizeString(req.body?.reason) || "Admin tomonidan hammasi bekor qilindi";
    if (!referrerTgUserId) {
      return response.error(res, "Foydalanuvchi topilmadi");
    }

    const now = new Date();
    const adminId = normalizeString(req?.telegramAuth?.tgUserId || req?.admin?.tgUserId);
    const result = await User.updateMany(
      {
        referredByUserId: referrerTgUserId,
        referralExcludedAt: null,
      },
      {
        $set: {
          referralExcludedAt: now,
          referralExcludedReason: reason,
          referralExcludedByAdminId: adminId,
        },
      },
    );

    return response.success(res, "Referral takliflari bekor qilindi", {
      modifiedCount: Number(result.modifiedCount || 0),
    });
  } catch (error) {
    return response.serverError(
      res,
      "Referral takliflarini bekor qilishda xatolik",
      error.message,
    );
  }
};

const updateUserReferralSystemBlock = async (req, res) => {
  try {
    const tgUserId = normalizeString(req.params.tgUserId);
    const blocked = Boolean(req.body?.blocked);
    const reason = normalizeString(req.body?.reason);
    if (!tgUserId) return response.error(res, "Foydalanuvchi topilmadi");

    const adminId = normalizeString(req?.telegramAuth?.tgUserId || req?.admin?.tgUserId);
    const update = blocked
      ? {
          referralBlockedAt: new Date(),
          referralBlockedReason: reason || "Referral qoidasi buzilgani uchun bloklandi",
          referralBlockedByAdminId: adminId,
        }
      : {
          referralBlockedAt: null,
          referralBlockedReason: "",
          referralBlockedByAdminId: "",
        };
    const user = await User.findOneAndUpdate(
      { tgUserId },
      { $set: update },
      { new: true },
    ).lean();
    if (!user) return response.notFound(res, "Foydalanuvchi topilmadi");

    emitUserUpdate(tgUserId, {
      type: "referral_system_block_changed",
      refreshReferral: true,
      referralBlocked: blocked,
    });
    return response.success(
      res,
      blocked ? "Referral tizimi bloklandi" : "Referral tizimi qayta yoqildi",
      {
        tgUserId: String(user.tgUserId || ""),
        referralBlockedAt: user.referralBlockedAt || null,
        referralBlockedReason: String(user.referralBlockedReason || ""),
      },
    );
  } catch (error) {
    return response.serverError(res, "Referral tizimini yangilashda xatolik", error.message);
  }
};

const getUserAssets = async (req, res) => {
  try {
    const tgUserId = normalizeString(req.params.tgUserId);
    if (!tgUserId) {
      return response.error(res, "Foydalanuvchi topilmadi");
    }

    const user = await User.findOne({ tgUserId }).lean();
    if (!user) {
      return response.notFound(res, "Foydalanuvchi topilmadi");
    }

    const [gifts, nfts, acceptedOffers] = await Promise.all([
      UserGift.find({ tgUserId })
        .sort({ createdAt: -1 })
        .limit(300)
        .lean(),
      UserNft.find({
        ownerTgUserId: tgUserId,
        isTelegramPresent: true,
      })
        .sort({ updatedAt: -1, createdAt: -1 })
        .limit(300)
        .lean(),
      NftOffer.find({
        status: "accepted",
        $or: [{ buyerTgUserId: tgUserId }, { sellerTgUserId: tgUserId }],
      })
        .sort({ acceptedAt: -1, respondedAt: -1, createdAt: -1 })
        .limit(300)
        .select({
          nftId: 1,
          buyerTgUserId: 1,
          buyerProfileName: 1,
          buyerUsername: 1,
          sellerTgUserId: 1,
          sellerProfileName: 1,
          sellerUsername: 1,
          offeredPriceUzs: 1,
          acceptedAt: 1,
          respondedAt: 1,
          createdAt: 1,
        })
        .lean(),
    ]);

    const nftIds = Array.from(
      new Set(acceptedOffers.map((item) => normalizeString(item?.nftId)).filter(Boolean)),
    );
    const nftDocs = nftIds.length
      ? await UserNft.find({ nftId: { $in: nftIds } }).select({ nftId: 1, title: 1 }).lean()
      : [];
    const nftTitleMap = new Map(
      nftDocs.map((item) => [normalizeString(item?.nftId), normalizeString(item?.title)]),
    );

    const history = [
      ...gifts.flatMap((item) => mapAdminGiftHistoryItems(item)),
      ...acceptedOffers.map((offer) => buildNftTradeHistoryItem(offer, tgUserId, nftTitleMap)),
    ]
      .sort((left, right) => {
        const leftTime = new Date(left?.timestamp || 0).getTime();
        const rightTime = new Date(right?.timestamp || 0).getTime();
        return rightTime - leftTime;
      })
      .slice(0, 500);

    return response.success(res, "User assets", {
      user: {
        tgUserId: normalizeString(user.tgUserId),
        username: normalizeString(user.username),
        profileName: normalizeString(user.profileName),
      },
      gifts: gifts.map(mapAdminGiftItem),
      nfts: nfts.map(mapAdminNftItem),
      history,
    });
  } catch (error) {
    return response.serverError(
      res,
      "Foydalanuvchi assetlarini olishda xatolik",
      error.message,
    );
  }
};

const searchAssets = async (req, res) => {
  try {
    const rawQuery = normalizeString(req.query.q);
    const rawType = normalizeString(req.query.type).toLowerCase();
    const type = ["nft", "gift", "all"].includes(rawType) ? rawType : "all";
    const requestedLimit = Number(req.query.limit || 30);
    const limit =
      Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(100, Math.floor(requestedLimit))
        : 30;

    if (!rawQuery) {
      return response.success(res, "Asset search", {
        query: "",
        type,
        nfts: [],
        gifts: [],
      });
    }

    const regex = new RegExp(escapeRegex(rawQuery), "i");

    let nftDocs = [];
    let giftDocs = [];

    if (type === "all" || type === "nft") {
      const nftMeta = extractTelegramNftSearchMeta(rawQuery);
      const nftOr = [
        { nftId: rawQuery },
        { nftId: { $regex: regex } },
        { title: { $regex: regex } },
        { slug: { $regex: regex } },
        { giftId: { $regex: regex } },
        { ownerTgUserId: rawQuery },
        { ownerUsername: { $regex: regex } },
        { ownerName: { $regex: regex } },
      ];

      if (nftMeta.candidate && nftMeta.candidate !== rawQuery) {
        const candidateRegex = new RegExp(escapeRegex(nftMeta.candidate), "i");
        nftOr.push({ nftId: nftMeta.candidate });
        nftOr.push({ nftId: { $regex: candidateRegex } });
        nftOr.push({ slug: { $regex: candidateRegex } });
      }

      if (nftMeta.slug) {
        const slugRegex = new RegExp(escapeRegex(nftMeta.slug), "i");
        nftOr.push({ slug: nftMeta.slug });
        nftOr.push({ slug: { $regex: slugRegex } });

        if (nftMeta.titleFromSlug) {
          const titleFromSlugRegex = new RegExp(
            escapeRegex(nftMeta.titleFromSlug).replace(/\s+/g, "\\s*"),
            "i",
          );
          nftOr.push({ title: { $regex: titleFromSlugRegex } });
        }
      }

      if (nftMeta.nftNumber > 0) {
        nftOr.push({ nftNumber: nftMeta.nftNumber });
        nftOr.push({ nftId: nftMeta.nftNumberText });

        const nftNumberRegex = new RegExp(
          "(?:^|\\D)" + escapeRegex(nftMeta.nftNumberText) + "(?:\\D|$)",
          "i",
        );
        nftOr.push({ nftId: { $regex: nftNumberRegex } });
      }

      if (nftMeta.slug && nftMeta.nftNumberText) {
        const composite = nftMeta.slug + "-" + nftMeta.nftNumberText;
        const compositeRegex = new RegExp(escapeRegex(composite), "i");
        nftOr.push({ nftId: composite });
        nftOr.push({ nftId: { $regex: compositeRegex } });
      }

      nftDocs = await UserNft.find({
        isTelegramPresent: true,
        $or: nftOr,
      })
        .sort({ updatedAt: -1, createdAt: -1 })
        .limit(limit)
        .lean();
    }

    if (type === "all" || type === "gift") {
      giftDocs = await UserGift.find({
        $or: [
          { giftId: rawQuery },
          { giftId: { $regex: regex } },
          { title: { $regex: regex } },
          { tgUserId: rawQuery },
          { tgUsername: { $regex: regex } },
        ],
      })
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();
    }

    const ownerIds = Array.from(
      new Set(
        [
          ...nftDocs.map((item) => normalizeString(item.ownerTgUserId)),
          ...giftDocs.map((item) => normalizeString(item.tgUserId)),
        ].filter(Boolean),
      ),
    );

    const ownerDocs = ownerIds.length
      ? await User.find({ tgUserId: { $in: ownerIds } })
          .select({ tgUserId: 1, username: 1, profileName: 1 })
          .lean()
      : [];

    const ownerMap = new Map(
      ownerDocs.map((item) => [normalizeString(item.tgUserId), item]),
    );

    const mapOwner = ({ tgUserId, username }) => {
      const safeUserId = normalizeString(tgUserId);
      const ownerUser = ownerMap.get(safeUserId);
      const safeUsername = normalizeString(ownerUser?.username || username);
      const safeProfileName = normalizeString(ownerUser?.profileName);
      return {
        tgUserId: safeUserId,
        username: safeUsername,
        profileName: safeProfileName,
        photoUrl: buildAdminUserPhotoUrl(safeUserId),
        displayName:
          safeProfileName ||
          (safeUsername ? `@${normalizeUsername(safeUsername)}` : safeUserId),
      };
    };

    const nfts = nftDocs.map((doc) => ({
      ...mapAdminNftItem(doc),
      owner: mapOwner({
        tgUserId: doc.ownerTgUserId,
        username: doc.ownerUsername,
      }),
    }));

    const gifts = giftDocs.map((doc) => ({
      ...mapAdminGiftItem(doc),
      owner: mapOwner({
        tgUserId: doc.tgUserId,
        username: doc.tgUsername,
      }),
    }));

    return response.success(res, "Asset search", {
      query: rawQuery,
      type,
      nfts,
      gifts,
    });
  } catch (error) {
    return response.serverError(
      res,
      "Asset qidirishda xatolik",
      error.message,
    );
  }
};

function mapStaticGift(doc) {
  return {
    _id: String(doc?._id || ""),
    giftId: normalizeString(doc?.giftId),
    title: normalizeString(doc?.title) || "Gift",
    emoji: normalizeString(doc?.emoji) || "🎁",
    stars: Number(doc?.stars || 0),
    imageUrl: normalizeString(doc?.imageUrl),
    isActive: Boolean(doc?.isActive),
    sortOrder: Number(doc?.sortOrder || 0),
    createdAt: doc?.createdAt || null,
    updatedAt: doc?.updatedAt || null,
  };
}

function mapHeroSlide(doc) {
  return {
    _id: String(doc?._id || ""),
    title: normalizeString(doc?.title),
    imageUrl: normalizeString(doc?.imageUrl),
    targetTab: normalizeString(doc?.targetTab),
    sortOrder: Number(doc?.sortOrder || 0),
    isActive: Boolean(doc?.isActive),
    createdAt: doc?.createdAt || null,
    updatedAt: doc?.updatedAt || null,
  };
}

const getStaticGifts = async (_, res) => {
  try {
    const items = await StaticGift.find({})
      .sort({ sortOrder: 1, createdAt: -1 })
      .lean();
    return response.success(res, "Static gifts", items.map(mapStaticGift));
  } catch (error) {
    return response.serverError(
      res,
      "Static giftlarni olishda xatolik",
      error.message,
    );
  }
};

const createStaticGift = async (req, res) => {
  try {
    const payload = {
      ...req.validated,
      giftId: normalizeGiftId(req.validated?.giftId),
    };
    const exists = await StaticGift.findOne({ giftId: payload.giftId }).lean();
    if (exists) {
      return response.error(res, "Bu giftId allaqachon mavjud");
    }
    const created = await StaticGift.create(payload);
    return response.created(res, "Static gift qo'shildi", mapStaticGift(created));
  } catch (error) {
    return response.serverError(
      res,
      "Static gift qo'shishda xatolik",
      error.message,
    );
  }
};

const updateStaticGift = async (req, res) => {
  try {
    const { id } = req.params;
    const payload = {
      ...req.validated,
    };
    if (typeof payload.giftId !== "undefined") {
      payload.giftId = normalizeGiftId(payload.giftId);
    }
    if (payload.giftId) {
      const exists = await StaticGift.findOne({
        giftId: payload.giftId,
        _id: { $ne: id },
      }).lean();
      if (exists) {
        return response.error(res, "Bu giftId allaqachon mavjud");
      }
    }
    const updated = await StaticGift.findByIdAndUpdate(id, payload, {
      new: true,
      runValidators: true,
    }).lean();
    if (!updated) return response.notFound(res, "Static gift topilmadi");
    return response.success(res, "Static gift yangilandi", mapStaticGift(updated));
  } catch (error) {
    return response.serverError(
      res,
      "Static gift yangilashda xatolik",
      error.message,
    );
  }
};

const deleteStaticGift = async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await StaticGift.findByIdAndDelete(id).lean();
    if (!deleted) return response.notFound(res, "Static gift topilmadi");
    return response.success(res, "Static gift o'chirildi", mapStaticGift(deleted));
  } catch (error) {
    return response.serverError(
      res,
      "Static gift o'chirishda xatolik",
      error.message,
    );
  }
};

const getHeroSlides = async (_, res) => {
  try {
    const items = await HeroSlide.find({})
      .sort({ sortOrder: 1, createdAt: -1 })
      .lean();
    return response.success(res, "Hero slides", items.map(mapHeroSlide));
  } catch (error) {
    return response.serverError(
      res,
      "Hero slide'larni olishda xatolik",
      error.message,
    );
  }
};

const createHeroSlide = async (req, res) => {
  try {
    const payload = {
      ...req.validated,
      title: normalizeString(req.validated?.title),
      imageUrl: normalizeString(req.validated?.imageUrl),
      targetTab: normalizeString(req.validated?.targetTab),
    };
    if (!payload.imageUrl) {
      return response.error(res, "imageUrl required");
    }
    const created = await HeroSlide.create(payload);
    return response.created(res, "Hero slide qo'shildi", mapHeroSlide(created));
  } catch (error) {
    return response.serverError(
      res,
      "Hero slide qo'shishda xatolik",
      error.message,
    );
  }
};

const updateHeroSlide = async (req, res) => {
  try {
    const { id } = req.params;
    const payload = {
      ...req.validated,
    };
    if (typeof payload.title !== "undefined") {
      payload.title = normalizeString(payload.title);
    }
    if (typeof payload.imageUrl !== "undefined") {
      payload.imageUrl = normalizeString(payload.imageUrl);
    }
    if (typeof payload.targetTab !== "undefined") {
      payload.targetTab = normalizeString(payload.targetTab);
    }
    const updated = await HeroSlide.findByIdAndUpdate(id, payload, {
      new: true,
      runValidators: true,
    }).lean();
    if (!updated) return response.notFound(res, "Hero slide topilmadi");
    return response.success(res, "Hero slide yangilandi", mapHeroSlide(updated));
  } catch (error) {
    return response.serverError(
      res,
      "Hero slide yangilashda xatolik",
      error.message,
    );
  }
};

const deleteHeroSlide = async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await HeroSlide.findByIdAndDelete(id).lean();
    if (!deleted) return response.notFound(res, "Hero slide topilmadi");
    return response.success(res, "Hero slide o'chirildi", mapHeroSlide(deleted));
  } catch (error) {
    return response.serverError(
      res,
      "Hero slide o'chirishda xatolik",
      error.message,
    );
  }
};

const getUserProfilePhoto = async (req, res) => {
  try {
    const tgUserId = normalizeString(req.params.tgUserId);
    if (!tgUserId) {
      return res.status(204).end();
    }

    const exists = await User.exists({ tgUserId });
    if (!exists) {
      return res.status(204).end();
    }

    const image = await getTelegramUserProfilePhoto(tgUserId);
    if (!image?.buffer || !Buffer.isBuffer(image.buffer) || !image.buffer.length) {
      return res.status(204).end();
    }

    res.setHeader("Cache-Control", "private, max-age=300");
    res.setHeader("Content-Type", normalizeString(image.mimeType) || "image/jpeg");
    return res.status(200).send(image.buffer);
  } catch (_) {
    return res.status(204).end();
  }
};

const resetPaymentCardLimit = async (req, res) => {
  try {
    const now = new Date();
    const updated = await PaymentCard.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          dailyUsageResetAt: now,
          usageDay: "",
          usageCount: 0,
        },
      },
      { new: true, runValidators: true },
    ).lean();

    if (!updated) return response.notFound(res, "To'lov kartasi topilmadi");
    return response.success(res, "Karta limiti reset qilindi", updated);
  } catch (error) {
    return response.serverError(
      res,
      "Karta limitini reset qilishda xatolik",
      error.message,
    );
  }
};

const adminRemoveUserNft = async (req, res) => {
  try {
    const ownerTgUserId = normalizeString(req.params.tgUserId);
    const nftId = normalizeString(req.params.nftId);
    if (!ownerTgUserId || !nftId) {
      return response.error(res, "Foydalanuvchi yoki NFT topilmadi");
    }

    const owner = await User.findOne({ tgUserId: ownerTgUserId }).lean();
    if (!owner) {
      return response.notFound(res, "Foydalanuvchi topilmadi");
    }

    const nft = await UserNft.findOne({
      nftId,
      ownerTgUserId,
      isTelegramPresent: true,
    }).lean();
    if (!nft) {
      return response.error(res, "NFT topilmadi");
    }

    await UserNft.updateOne(
      { nftId, ownerTgUserId },
      {
        $set: {
          isTelegramPresent: false,
          marketStatus: "owned",
          listingPriceUzs: 0,
          listedAt: null,
          listedByTgUserId: "",
          withdrawnAt: new Date(),
          withdrawnTo: "admin_manual_remove",
        },
      },
    );

    await cancelPendingOffersForNftAdmin(nftId, "admin_manual_remove");

    emitUserUpdate(ownerTgUserId, {
      type: "admin_nft_removed",
      refreshNfts: true,
      refreshNftOffers: true,
      nftId,
    });

    return response.success(res, "NFT foydalanuvchi profilidan o'chirildi", {
      nftId,
      ownerTgUserId,
    });
  } catch (error) {
    return response.serverError(
      res,
      "NFTni o'chirishda xatolik",
      error.message,
    );
  }
};

const adminTransferUserNft = async (req, res) => {
  try {
    const ownerTgUserId = normalizeString(req.params.tgUserId);
    const nftId = normalizeString(req.params.nftId);
    const targetIdentifier = normalizeString(
      req.body?.toTgUserId ||
        req.body?.toUsername ||
        req.body?.target ||
        req.body?.recipient,
    );

    if (!ownerTgUserId || !nftId) {
      return response.error(res, "Foydalanuvchi yoki NFT topilmadi");
    }
    if (!targetIdentifier) {
      return response.error(res, "Qabul qiluvchi tgUserId yoki username kiriting");
    }

    const [owner, targetUser] = await Promise.all([
      User.findOne({ tgUserId: ownerTgUserId }).lean(),
      resolveUserByIdentifier(targetIdentifier),
    ]);

    if (!owner) {
      return response.notFound(res, "Foydalanuvchi topilmadi");
    }
    if (!targetUser) {
      return response.error(res, "Qabul qiluvchi topilmadi");
    }

    const targetTgUserId = normalizeString(targetUser.tgUserId);
    if (!targetTgUserId) {
      return response.error(res, "Qabul qiluvchi topilmadi");
    }
    if (targetTgUserId === ownerTgUserId) {
      return response.error(res, "Qabul qiluvchi hozirgi egasi bilan bir xil");
    }

    const nft = await UserNft.findOne({
      nftId,
      ownerTgUserId,
      isTelegramPresent: true,
    }).lean();
    if (!nft) {
      return response.error(res, "NFT topilmadi");
    }

    await UserNft.updateOne(
      { nftId, ownerTgUserId },
      {
        $set: {
          ownerTgUserId: targetTgUserId,
          ownerUsername: normalizeString(targetUser.username),
          ownerName: normalizeDisplayName(targetUser),
          marketStatus: "owned",
          listingPriceUzs: 0,
          listedAt: null,
          listedByTgUserId: "",
          withdrawnAt: null,
          withdrawnTo: "",
        },
      },
    );

    await cancelPendingOffersForNftAdmin(nftId, "admin_manual_transfer");

    emitUserUpdate(ownerTgUserId, {
      type: "admin_nft_transferred_out",
      refreshNfts: true,
      refreshNftOffers: true,
      nftId,
      toTgUserId: targetTgUserId,
    });
    emitUserUpdate(targetTgUserId, {
      type: "admin_nft_transferred_in",
      refreshNfts: true,
      refreshNftOffers: true,
      nftId,
      fromTgUserId: ownerTgUserId,
    });

    return response.success(res, "NFT boshqa foydalanuvchiga o'tkazildi", {
      nftId,
      from: {
        tgUserId: ownerTgUserId,
        username: normalizeString(owner.username),
      },
      to: {
        tgUserId: targetTgUserId,
        username: normalizeString(targetUser.username),
      },
    });
  } catch (error) {
    return response.serverError(
      res,
      "NFTni o'tkazishda xatolik",
      error.message,
    );
  }
};


const topupUserBalance = async (req, res) => {
  try {
    const tgUserId = normalizeString(req.params.tgUserId);
    const amount = Number(req.body?.amount || 0);
    const operation = normalizeString(req.body?.operation || "increase").toLowerCase();
    const isDecrease = operation === "decrease";
    const isIncrease = operation === "increase";
    const roundedAmount = Math.round(amount);
    const signedAmount = isDecrease ? -roundedAmount : roundedAmount;

    if (!tgUserId) {
      return response.error(res, "Foydalanuvchi topilmadi");
    }
    if (!isIncrease && !isDecrease) {
      return response.error(res, "operation noto'g'ri");
    }
    if (!Number.isFinite(amount) || roundedAmount <= 0) {
      return response.error(res, "Miqdor noto'g'ri");
    }

    const user = await User.findOne({ tgUserId }).lean();
    if (!user) {
      return response.notFound(res, "Foydalanuvchi topilmadi");
    }

    const updated = await User.findOneAndUpdate(
      isDecrease ? { tgUserId, balance: { $gte: roundedAmount } } : { tgUserId },
      { $inc: { balance: signedAmount } },
      { new: true },
    ).lean();
    if (!updated) {
      return response.error(res, "Balans yetarli emas");
    }

    await UserBalanceAdjustment.create({
      tgUserId,
      username: String(updated?.username || user.username || ""),
      amount: signedAmount,
      beforeBalance: Number(user.balance || 0),
      afterBalance: Number(updated?.balance || 0),
      adminTgUserId: normalizeString(req.admin?.tgUserId),
      adminUsername: normalizeString(req.admin?.username),
      note: isDecrease ? "Admin panel decrement" : "Admin panel topup",
    });

    emitUserUpdate(tgUserId, {
      type: "admin_balance_adjusted",
      refreshBalance: true,
      refreshProfile: true,
      amount: signedAmount,
      operation: isDecrease ? "decrease" : "increase",
    });

    const [item] = await buildAdminUserList([updated]);
    return response.success(
      res,
      isDecrease ? "Balans kamaytirildi" : "Balans to'ldirildi",
      item || updated,
    );
  } catch (error) {
    return response.serverError(
      res,
      "Balans to'ldirishda xatolik",
      error.message,
    );
  }
};

const updateUserBlockStatus = async (req, res) => {
  try {
    const tgUserId = normalizeString(req.params.tgUserId);
    const blocked = req.body?.blocked;
    const reason = normalizeString(req.body?.reason);

    if (!tgUserId) {
      return response.error(res, "Foydalanuvchi topilmadi");
    }
    if (typeof blocked !== "boolean") {
      return response.error(res, "blocked boolean bo'lishi kerak");
    }

    const updated = await User.findOneAndUpdate(
      { tgUserId },
      {
        $set: {
          isBlocked: blocked,
          blockedAt: blocked ? new Date() : null,
          blockedReason: blocked ? reason : "",
          blockedByAdminId: blocked
            ? normalizeString(req.admin?.tgUserId)
            : "",
          blockedByAdminUsername: blocked
            ? normalizeString(req.admin?.username)
            : "",
        },
      },
      { new: true },
    ).lean();

    if (!updated) {
      return response.notFound(res, "Foydalanuvchi topilmadi");
    }

    emitUserUpdate(tgUserId, {
      type: blocked ? "user_blocked" : "user_unblocked",
      refreshProfile: true,
      isBlocked: blocked,
      blockedReason: blocked ? reason : "",
      blockedAt: blocked ? new Date().toISOString() : null,
    });

    const [item] = await buildAdminUserList([updated]);
    return response.success(
      res,
      blocked ? "Foydalanuvchi bloklandi" : "Foydalanuvchi blokdan chiqarildi",
      item || updated,
    );
  } catch (error) {
    return response.serverError(
      res,
      "Foydalanuvchini bloklashda xatolik",
      error.message,
    );
  }
};

const getDiagnostics = async (_, res) => {
  try {
    const [
      totalUsers,
      blockedUsers,
      purchaseTurnoverRows,
      starSellTurnoverRows,
      balanceTopupRows,
      nftWithdrawalRows,
      giftsTurnoverRows,
      nftOfferTradeTurnoverRows,
      nftMarketTradeTurnoverRows,
    ] = await Promise.all([
      User.countDocuments({}),
      User.countDocuments({ isBlocked: true }),
      Order.aggregate([
        {
          $match: {
            product: { $in: PURCHASE_PRODUCTS },
            status: { $in: PAID_STATUSES },
            paidAmount: { $gt: 0 },
          },
        },
        {
          $group: {
            _id: null,
            totalUzs: { $sum: "$paidAmount" },
          },
        },
      ]),
      Order.aggregate([
        {
          $match: {
            product: "star_sell",
            status: { $in: ["payment_submitted", "completed"] },
            expectedAmount: { $gt: 0 },
          },
        },
        { $group: { _id: null, totalUzs: { $sum: "$expectedAmount" } } },
      ]),
      Order.aggregate([
        {
          $match: {
            product: "balance",
            paymentMethod: { $in: ["card", "bankomat"] },
            planCode: { $in: ["card_topup", "bankomat"] },
            status: { $in: PAID_STATUSES },
            paidAmount: { $gt: 0 },
          },
        },
        { $group: { _id: null, totalUzs: { $sum: "$paidAmount" } } },
      ]),
      Order.aggregate([
        {
          $match: {
            product: "nft_withdrawal",
            status: { $in: ["payment_submitted", "completed"] },
            expectedAmount: { $gt: 0 },
          },
        },
        { $group: { _id: null, totalUzs: { $sum: "$expectedAmount" } } },
      ]),
      UserGift.aggregate([
        {
          $match: {
            priceUzs: { $gt: 0 },
          },
        },
        {
          $group: {
            _id: null,
            totalUzs: { $sum: "$priceUzs" },
          },
        },
      ]),
      NftOffer.aggregate([
        {
          $match: {
            status: "accepted",
            offeredPriceUzs: { $gt: 0 },
          },
        },
        {
          $group: {
            _id: null,
            totalUzs: { $sum: "$offeredPriceUzs" },
          },
        },
      ]),
      UserNft.aggregate([
        {
          $match: {
            lastSoldPriceUzs: { $gt: 0 },
            lastSoldAt: { $ne: null },
          },
        },
        {
          $group: {
            _id: null,
            totalUzs: { $sum: "$lastSoldPriceUzs" },
          },
        },
      ]),
    ]);

    const orderCreateSeconds = await measureSingleOrderCreateSeconds();

    const ordersTurnoverUzs = Number(purchaseTurnoverRows?.[0]?.totalUzs || 0);
    const starSellTurnoverUzs = Number(starSellTurnoverRows?.[0]?.totalUzs || 0);
    const balanceTopupUzs = Number(balanceTopupRows?.[0]?.totalUzs || 0);
    const nftWithdrawalUzs = Number(nftWithdrawalRows?.[0]?.totalUzs || 0);
    const giftsTurnoverUzs = Number(giftsTurnoverRows?.[0]?.totalUzs || 0);
    const nftOfferTurnoverUzs = Number(nftOfferTradeTurnoverRows?.[0]?.totalUzs || 0);
    const nftMarketTurnoverUzs = Number(nftMarketTradeTurnoverRows?.[0]?.totalUzs || 0);
    const nftTurnoverUzs = nftOfferTurnoverUzs + nftMarketTurnoverUzs;
    const turnoverUzs =
      ordersTurnoverUzs +
      starSellTurnoverUzs +
      balanceTopupUzs +
      nftWithdrawalUzs +
      giftsTurnoverUzs +
      nftTurnoverUzs;
    const blocked = Number(blockedUsers || 0);
    const total = Number(totalUsers || 0);

    return response.success(res, "Diagnostics", {
      serverSpeedSeconds: Number(orderCreateSeconds.toFixed(4)),
      users: {
        total,
        active: Math.max(0, total - blocked),
        blocked,
      },
      turnover: {
        totalUzs: Math.max(0, Math.round(turnoverUzs)),
        ordersUzs: Math.max(0, Math.round(ordersTurnoverUzs)),
        starSellUzs: Math.max(0, Math.round(starSellTurnoverUzs)),
        balanceTopupUzs: Math.max(0, Math.round(balanceTopupUzs)),
        nftWithdrawalUzs: Math.max(0, Math.round(nftWithdrawalUzs)),
        giftsUzs: Math.max(0, Math.round(giftsTurnoverUzs)),
        nftUzs: Math.max(0, Math.round(nftTurnoverUzs)),
      },
      measuredAt: new Date().toISOString(),
    });
  } catch (error) {
    return response.serverError(
      res,
      "Diagnostika ma'lumotlarini olishda xatolik",
      error.message,
    );
  }
};

const getSuspiciousDevices = async (req, res) => {
  try {
    const requestedPage = Number(req.query?.page || 1);
    const requestedLimit = Number(req.query?.limit || 20);
    const page =
      Number.isFinite(requestedPage) && requestedPage > 0
        ? Math.floor(requestedPage)
        : 1;
    const limit =
      Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(100, Math.floor(requestedLimit))
        : 20;

    const data = await listSuspiciousDevices({ page, limit });
    return response.success(res, "Suspicious devices", data);
  } catch (error) {
    return response.serverError(
      res,
      "Shubhali qurilmalarni olishda xatolik",
      error.message,
    );
  }
};

const getActiveUsers = async (req, res) => {
  try {
    const period = String(req.query?.period || "today").trim().toLowerCase();
    const limitRaw = Number(req.query?.limit || 20);
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.min(100, Math.floor(limitRaw))
        : 20;

    const now = new Date();
    const start = new Date(now);
    if (period === "today") {
      start.setHours(0, 0, 0, 0);
    } else if (period === "week") {
      const day = start.getDay();
      const diff = day === 0 ? 6 : day - 1;
      start.setDate(start.getDate() - diff);
      start.setHours(0, 0, 0, 0);
    } else if (period === "month") {
      start.setDate(1);
      start.setHours(0, 0, 0, 0);
    } else {
      return response.error(res, "period noto'g'ri");
    }

    const rows = await Order.find({
      product: { $in: ["star", "premium", "uc", "freefire", "mlbb"] },
      status: { $in: ["paid_auto_processed", "completed"] },
      $or: [{ paidAt: { $gte: start } }, { createdAt: { $gte: start } }],
      tgUserId: { $exists: true, $ne: "" },
    })
      .sort({ paidAt: -1, createdAt: -1 })
      .lean();

    const ids = rows.map((r) => normalizeString(r?.tgUserId)).filter(Boolean);
    const users = ids.length
      ? await User.find({ tgUserId: { $in: ids } })
          .select({ tgUserId: 1, username: 1, profileName: 1 })
          .lean()
      : [];
    const userMap = new Map(users.map((u) => [normalizeString(u?.tgUserId), u]));

    const grouped = new Map();
    rows.forEach((row) => {
      const tgUserId = normalizeString(row?.tgUserId);
      if (!tgUserId) return;
      const user = userMap.get(tgUserId) || {};
      const paidAmount = Number(row?.paidAmount || 0);
      const expectedAmount = Number(row?.expectedAmount || 0);
      const amount =
        Number.isFinite(paidAmount) && paidAmount > 0
          ? paidAmount
          : Number.isFinite(expectedAmount) && expectedAmount > 0
            ? expectedAmount
            : 0;
      const paidAtMs = row?.paidAt ? new Date(row.paidAt).getTime() : 0;
      const createdAtMs = row?.createdAt ? new Date(row.createdAt).getTime() : 0;
      const orderTime = paidAtMs || createdAtMs || 0;
      const existing = grouped.get(tgUserId);

      if (!existing) {
        const userProfileName = normalizeString(user?.profileName);
        const fallbackProfileName = userProfileName
          ? userProfileName
          : normalizeString(user?.username)
            ? `@${normalizeUsername(user?.username)}`
            : "";

        grouped.set(tgUserId, {
          orderId: Number(row?.orderId || 0),
          product: normalizeString(row?.product),
          tgUserId,
          username: normalizeString(user?.username),
          profileName: fallbackProfileName,
          displayName: normalizeDisplayName({ ...user, tgUserId }),
          totalSpent: amount,
          ordersCount: 1,
          lastOrderAt: row?.paidAt || row?.createdAt || null,
          sortTime: orderTime,
        });
        return;
      }

      existing.totalSpent += amount;
      existing.ordersCount += 1;
      if (orderTime > existing.sortTime) {
        existing.sortTime = orderTime;
        existing.lastOrderAt = row?.paidAt || row?.createdAt || null;
        existing.orderId = Number(row?.orderId || existing.orderId || 0);
        existing.product = normalizeString(row?.product) || existing.product;
      }
    });

    const items = Array.from(grouped.values())
      .sort((a, b) => {
        if (b.totalSpent !== a.totalSpent) return b.totalSpent - a.totalSpent;
        return (b.sortTime || 0) - (a.sortTime || 0);
      })
      .slice(0, limit)
      .map((item, index) => {
        const username = normalizeString(item?.username).replace(/^@+/, "");
        const telegramUrl = username
          ? `https://t.me/${username}`
          : `tg://user?id=${normalizeString(item?.tgUserId)}`;
        return {
          rank: index + 1,
          orderId: Number(item?.orderId || 0),
          product: normalizeString(item?.product),
          tgUserId: normalizeString(item?.tgUserId),
          username: normalizeString(item?.username),
          profileName: normalizeString(item?.profileName),
          displayName: normalizeString(item?.displayName),
          totalSpent: Number(item?.totalSpent || 0),
          ordersCount: Number(item?.ordersCount || 0),
          lastOrderAt: item?.lastOrderAt || null,
          telegramUrl,
        };
      });

    return response.success(res, "Active users", {
      period,
      from: start.toISOString(),
      to: now.toISOString(),
      items,
    });
  } catch (error) {
    return response.serverError(
      res,
      "Aktiv foydalanuvchilarni olishda xatolik",
      error.message,
    );
  }
};

module.exports = {
  checkAccess,
  login,
  getPlans,
  createPlan,
  updatePlan,
  deletePlan,
  syncGwPubgPlans,
  syncGwMlbbPlans,
  getSettings,
  updateSettings,
  getReferralPromoCodes,
  markReferralPromoCodeUsed,
  getPaymentCards,
  getStaticGifts,
  getHeroSlides,
  createPaymentCard,
  createStaticGift,
  createHeroSlide,
  updatePaymentCard,
  updateStaticGift,
  updateHeroSlide,
  deletePaymentCard,
  deleteStaticGift,
  deleteHeroSlide,
  resetPaymentCardLimit,
  searchUsers,
  searchAssets,
  getUserProfilePhoto,
  getUserReferrals,
  updateUserReferralExclusion,
  excludeAllUserReferrals,
  updateUserReferralSystemBlock,
  getUserAssets,
  adminRemoveUserNft,
  adminTransferUserNft,
  topupUserBalance,
  updateUserBlockStatus,
  getDiagnostics,
  getSuspiciousDevices,
  getActiveUsers,
};
