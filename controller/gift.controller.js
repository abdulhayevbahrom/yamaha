const response = require("../utils/response");
const User = require("../model/user.model");
const UserGift = require("../model/user-gift.model");
const UserNft = require("../model/user-nft.model");
const NftOffer = require("../model/nft-offer.model");
const { emitUserUpdate } = require("../socket");
const { getTelegramUserFromRequest } = require("../utils/tg-user");
const { getTelegramCredentials } = require("../config/telegram-credentials");
const { ensureReferralIdentity } = require("../services/referral.service");
const { sendTelegramText } = require("../services/telegram-notify.service");
const {
  getStarPricing,
  getNftMarketplaceConfig,
} = require("../services/settings.service");
const {
  getStarGiftsCatalog,
  getGiftById,
  getGiftImageBuffer,
  getNftImageBuffer,
  getNftPatternImageBuffer,
  getMyTelegramNftGifts,
  sendStarGiftToRecipient,
  transferSavedStarGiftToRecipient,
} = require("../services/telegram-gift.service");

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeGiftId(value) {
  const normalized = normalizeString(value);
  if (!normalized) return "";

  try {
    if (/^\d+$/.test(normalized)) {
      return BigInt(normalized).toString();
    }
  } catch (_) {
    // ignore
  }

  return normalized;
}

function splitNftTitleAndNumber(value) {
  const raw = normalizeString(value);
  if (!raw) return { title: "", nftNumber: 0 };

  const match = raw.match(/^(.*?)(?:\s*#\s*(\d[\d\s]*))$/);
  if (!match) return { title: raw, nftNumber: 0 };

  const title = normalizeString(match[1]) || raw;
  const parsedNumber = Number(String(match[2] || "").replace(/\s+/g, ""));
  const nftNumber =
    Number.isFinite(parsedNumber) && parsedNumber > 0
      ? Math.trunc(parsedNumber)
      : 0;

  return { title, nftNumber };
}

function normalizeRecipient(value) {
  return normalizeString(value).replace(/^@+/, "");
}

function toSafeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toDateOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatUzsAmount(value) {
  return `${Math.max(0, Math.round(toSafeNumber(value, 0))).toLocaleString("uz-UZ")} UZS`;
}

function formatRemainingSeconds(seconds) {
  const total = Math.max(0, Math.trunc(toSafeNumber(seconds, 0)));
  if (!total) return "0 soniya";

  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  const parts = [];
  if (days) parts.push(`${days} kun`);
  if (hours) parts.push(`${hours} soat`);
  if (minutes) parts.push(`${minutes} daqiqa`);
  if (!parts.length || secs) parts.push(`${secs} soniya`);

  return parts.join(" ");
}

function getNftTransferLockPayload(canTransferAtValue) {
  const canTransferAtDate = toDateOrNull(canTransferAtValue);
  if (!canTransferAtDate) return null;

  const secondsLeft = Math.max(
    0,
    Math.ceil((canTransferAtDate.getTime() - Date.now()) / 1000),
  );
  if (secondsLeft <= 0) return null;

  return {
    code: "NFT_TRANSFER_TOO_EARLY",
    canTransferAt: canTransferAtDate.toISOString(),
    secondsLeft,
    remainingLabel: formatRemainingSeconds(secondsLeft),
  };
}

function getTransferTooEarlySeconds(error) {
  const raw = normalizeString(error?.errorMessage || error?.message);
  if (!raw) return 0;

  const match = raw.match(/(?:STARGIFT_)?TRANSFER_TOO_EARLY[_:\s-]*(\d+)/i);
  if (!match) return 0;

  const seconds = Math.max(0, Math.trunc(toSafeNumber(match[1], 0)));
  return seconds;
}

function buildTransferTooEarlyMessage(lockPayload) {
  if (!lockPayload?.secondsLeft) {
    return "NFT ni hozir yechib bo'lmaydi. Keyinroq urinib ko'ring.";
  }

  return `NFT ni hozir yechib bo'lmaydi. Qolgan vaqt: ${lockPayload.remainingLabel}.`;
}

function pickFirstNonEmpty(...values) {
  for (const value of values) {
    const normalized = normalizeString(value);
    if (normalized) return normalized;
  }
  return "";
}

async function runInBatches(items, batchSize, worker) {
  const list = Array.isArray(items) ? items : [];
  const size = Math.min(Math.max(Math.trunc(toSafeNumber(batchSize, 20)), 1), 200);
  if (!list.length || typeof worker !== "function") return [];

  const results = [];
  for (let index = 0; index < list.length; index += size) {
    const chunk = list.slice(index, index + size);
    const settled = await Promise.allSettled(chunk.map((item) => worker(item)));
    results.push(...settled);
  }
  return results;
}

async function getUserProfileNameMapByIds(tgUserIds) {
  const ids = Array.from(
    new Set((Array.isArray(tgUserIds) ? tgUserIds : []).map(normalizeString).filter(Boolean)),
  );
  if (!ids.length) return new Map();

  const rows = await User.find({ tgUserId: { $in: ids } })
    .select({ tgUserId: 1, profileName: 1, username: 1 })
    .lean();

  const map = new Map();
  for (const row of rows) {
    const tgUserId = normalizeString(row?.tgUserId);
    if (!tgUserId) continue;
    const profileName = pickFirstNonEmpty(row?.profileName, row?.username);
    if (profileName) map.set(tgUserId, profileName);
  }
  return map;
}

function resolveGiftPrice(gift, pricePerStar) {
  const stars = toSafeNumber(gift?.stars, 0);
  const price = Math.round(stars * toSafeNumber(pricePerStar, 0));
  return {
    stars,
    priceUzs: price > 0 ? price : 0,
  };
}

function buildCatalogGift(gift, pricePerStar) {
  const pricing = resolveGiftPrice(gift, pricePerStar);

  return {
    giftId: normalizeGiftId(gift?.giftId),
    title: normalizeString(gift?.title) || "Gift",
    emoji: normalizeString(gift?.emoji) || "🎁",
    stars: pricing.stars,
    priceUzs: pricing.priceUzs,
    limited: Boolean(gift?.limited),
    soldOut: Boolean(gift?.soldOut),
    isAvailable: Boolean(gift?.isAvailable),
    availabilityRemains: toSafeNumber(gift?.availabilityRemains, 0),
    availabilityTotal: toSafeNumber(gift?.availabilityTotal, 0),
    imageUrl: `/api/gifts/image/${encodeURIComponent(normalizeGiftId(gift?.giftId))}`,
  };
}

function buildImageFallbackSvg() {
  return Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <rect width="256" height="256" rx="28" fill="#12182a" />
  <text x="128" y="118" text-anchor="middle" font-size="64">🎁</text>
  <text x="128" y="170" text-anchor="middle" font-size="16" fill="#f0c040" font-family="Arial, sans-serif">Gift</text>
</svg>`,
    "utf8",
  );
}

function mapSendGiftError(error) {
  const raw = normalizeString(error?.errorMessage || error?.message || "");
  if (!raw) return "Gift yuborishda xatolik yuz berdi";

  if (raw.includes("BALANCE_TOO_LOW")) {
    return "Giftni yechib olish uchun xizmat hisobida stars yetarli emas. Administratorga murojaat qiling";
  }
  if (raw.includes("USERNAME_INVALID")) {
    return "Username noto'g'ri";
  }
  if (raw.includes("PEER_ID_INVALID") || raw.includes("USER_ID_INVALID")) {
    return "Foydalanuvchi topilmadi";
  }
  if (raw.includes("FLOOD_WAIT")) {
    return "Telegram cheklovi sabab birozdan keyin qayta urinib ko'ring";
  }
  if (raw.includes("TG_USER_SESSION")) {
    return "Telegram session eskirgan. Administratorga murojaat qiling";
  }
  if (raw.includes("PAYMENT_REQUIRED")) {
    return "Telegram transfer uchun stars to'lovi talab qilindi. Iltimos qayta urinib ko'ring yoki administratorga murojaat qiling";
  }
  if (raw.includes("STARS") && raw.includes("LOW")) {
    return "Telegram hisobida stars yetarli emas";
  }

  return raw;
}

function parseAdminNotifyIds() {
  return String(process.env.ADMIN_NOTIFY_CHAT_ID || "")
    .split(",")
    .map((id) => String(id).trim())
    .filter(Boolean);
}

function isGiftServiceLowStarsError(error) {
  const raw = normalizeString(error?.errorMessage || error?.message).toUpperCase();
  if (!raw) return false;

  return (
    raw.includes("BALANCE_TOO_LOW") ||
    raw.includes("PAYMENT_REQUIRED") ||
    (raw.includes("STARS") && raw.includes("LOW"))
  );
}

function getGiftServiceAccountLabel() {
  const explicitLabel = normalizeString(
    process.env.GIFT_TG_ACCOUNT_LABEL ||
      process.env.GIFT_TG_USERNAME ||
      process.env.TG_GIFT_USERNAME,
  );
  if (explicitLabel) {
    return explicitLabel.startsWith("@") ? explicitLabel : `@${explicitLabel}`;
  }

  const credentials = getTelegramCredentials("gift");
  const sessionKey =
    normalizeString(credentials?.resolvedKeys?.session) ||
    normalizeString(credentials?.preferredKeys?.session) ||
    "GIFT_TG_USER_SESSION";

  return `gift/nft service account (${sessionKey})`;
}

async function notifyAdminsAboutGiftServiceLowStars({
  action,
  user,
  recipientIdentifier,
  nft,
  gift,
  error,
}) {
  const adminIds = parseAdminNotifyIds();
  if (!adminIds.length) return false;

  const accountLabel = getGiftServiceAccountLabel();
  const userLabel =
    normalizeString(user?.username)
      ? `@${normalizeString(user.username).replace(/^@+/, "")}`
      : normalizeString(user?.tgUserId) || "-";
  const recipientLabel = normalizeString(recipientIdentifier) || userLabel;
  const actionLabel = action === "nft_withdraw" ? "NFT yechib olish" : "Gift yuborish";
  const assetTitle =
    normalizeString(nft?.title) || normalizeString(gift?.title) || "Gift/NFT";
  const assetId =
    normalizeString(nft?.nftId) ||
    normalizeString(gift?.giftId) ||
    normalizeString(gift?._id) ||
    "-";
  const reason = normalizeString(error?.errorMessage || error?.message) || "BALANCE_TOO_LOW";

  const message = [
    "Gift/NFT xizmat accountida stars yetarli emas.",
    "Shu accountga stars solish kerak.",
    `Account: ${accountLabel}`,
    `Amal: ${actionLabel}`,
    `Foydalanuvchi: ${userLabel}`,
    `Recipient: ${recipientLabel}`,
    `Asset: ${assetTitle}`,
    `Asset ID: ${assetId}`,
    `Xabar: ${reason}`,
  ].join("\n");

  const results = await Promise.allSettled(
    adminIds.map((adminId) => sendTelegramText(adminId, message)),
  );

  return results.some((result) => result.status === "fulfilled" && result.value?.ok);
}

async function ensureCurrentUser(tgUser) {
  const tgUserId = normalizeString(tgUser?.tgUserId);
  if (!tgUserId) return null;

  const user = await ensureReferralIdentity({
    tgUserId,
    username: normalizeString(tgUser?.username),
    profileName: normalizeString(tgUser?.profileName),
  });

  return user;
}

function mapNftDocToClient(doc, pricePerStar) {
  const nftId = normalizeString(doc?.nftId);
  const parsedTitle = splitNftTitleAndNumber(doc?.title);
  const nftNumberFromDoc = Math.trunc(toSafeNumber(doc?.nftNumber, 0));
  const nftNumber = nftNumberFromDoc > 0 ? nftNumberFromDoc : parsedTitle.nftNumber;
  const title = parsedTitle.title || "NFT Gift";
  const patternAssetStatus = normalizeString(doc?.patternAssetStatus) || "unknown";
  const patternImageUrl =
    patternAssetStatus === "available"
      ? `/api/gifts/nft-pattern/${encodeURIComponent(nftId)}`
      : "";
  const transferLock = getNftTransferLockPayload(doc?.canTransferAt);

  return {
    nftId,
    giftId: normalizeGiftId(doc?.giftId),
    slug: normalizeString(doc?.slug),
    title,
    nftNumber,
    ownerName: normalizeString(doc?.ownerName) || "-",
    model: normalizeString(doc?.model),
    modelRarity: normalizeString(doc?.modelRarity),
    symbol: normalizeString(doc?.symbol),
    symbolRarity: normalizeString(doc?.symbolRarity),
    backdrop: normalizeString(doc?.backdrop),
    backdropRarity: normalizeString(doc?.backdropRarity),
    backdropColors: doc?.backdropColors || undefined,
    quantityIssued: toSafeNumber(doc?.quantityIssued, 0),
    quantityTotal: toSafeNumber(doc?.quantityTotal, 0),
    valueStars: toSafeNumber(doc?.valueStars, 0),
    approxValueUzs: Math.round(toSafeNumber(doc?.valueStars, 0) * toSafeNumber(pricePerStar, 0)),
    acquiredAt: doc?.acquiredAt || doc?.createdAt || null,
    canTransferAt: transferLock?.canTransferAt || (toDateOrNull(doc?.canTransferAt)?.toISOString() || null),
    transferLocked: Boolean(transferLock?.secondsLeft),
    transferLockedSeconds: Math.max(0, Math.trunc(toSafeNumber(transferLock?.secondsLeft, 0))),
    transferLockLabel: normalizeString(transferLock?.remainingLabel),
    emoji: normalizeString(doc?.emoji) || "🎁",
    imageUrl: `/api/gifts/nft-image/${encodeURIComponent(nftId)}`,
    patternImageUrl,
    patternAsset: {
      status: patternAssetStatus,
      sourceMethod: normalizeString(doc?.patternAssetSourceMethod),
      sourceLabel: normalizeString(doc?.patternAssetSourceLabel),
      path: normalizeString(doc?.patternAssetPath),
      mimeType: normalizeString(doc?.patternAssetMimeType),
      missingReason: normalizeString(doc?.patternAssetMissingReason),
      imageUrl: patternImageUrl,
    },
    isListed: normalizeString(doc?.marketStatus) === "listed",
    marketStatus: normalizeString(doc?.marketStatus) || "owned",
    listingPriceUzs: toSafeNumber(doc?.listingPriceUzs, 0),
    listedAt: doc?.listedAt || null,
  };
}

function mapOfferDocToClient(doc, nftDoc = null, profileNames = {}) {
  const nftTitle = normalizeString(nftDoc?.title || doc?.nftTitle) || "NFT Gift";
  const buyerProfileName = pickFirstNonEmpty(
    profileNames?.buyerProfileName,
    doc?.buyerProfileName,
    doc?.buyerUsername,
    doc?.buyerTgUserId,
  );
  const sellerProfileName = pickFirstNonEmpty(
    profileNames?.sellerProfileName,
    doc?.sellerProfileName,
    nftDoc?.ownerName,
    doc?.sellerUsername,
    doc?.sellerTgUserId,
  );
  return {
    offerId: String(doc?._id || ""),
    nftId: normalizeString(doc?.nftId),
    offeredPriceUzs: toSafeNumber(doc?.offeredPriceUzs, 0),
    listingPriceUzs: toSafeNumber(doc?.listingPriceUzs, 0),
    offerDurationDays: Math.max(1, Math.trunc(toSafeNumber(doc?.offerDurationDays, 1))),
    expiresAt: doc?.expiresAt || null,
    status: normalizeString(doc?.status) || "pending",
    buyerTgUserId: normalizeString(doc?.buyerTgUserId),
    buyerUsername: normalizeString(doc?.buyerUsername),
    buyerProfileName,
    sellerTgUserId: normalizeString(doc?.sellerTgUserId),
    sellerUsername: normalizeString(doc?.sellerUsername),
    sellerProfileName,
    createdAt: doc?.createdAt || null,
    respondedAt: doc?.respondedAt || null,
    nft: nftDoc
      ? {
          title: nftTitle,
          slug: normalizeString(nftDoc?.slug),
          giftId: normalizeGiftId(nftDoc?.giftId),
          imageUrl: `/api/gifts/nft-image/${encodeURIComponent(normalizeString(doc?.nftId))}`,
        }
      : undefined,
  };
}

async function sendNftOfferBotNotify({
  sellerTgUserId,
  buyerTgUserId,
  buyerProfileName,
  buyerUsername,
  sellerProfileName,
  sellerUsername,
  nftTitle,
  listedPriceUzs,
  offeredPriceUzs,
  status,
}) {
  const formatUserLabel = ({ profileName, username, tgUserId }) => {
    const profile = normalizeString(profileName)
      .replace(/[\u0000-\u001F\u007F-\u009F]/g, "")
      .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 64);
    if (profile) return profile;

    const user = normalizeString(username);
    if (user) return `@${user}`;

    return normalizeString(tgUserId);
  };

  const title = normalizeString(nftTitle) || "NFT Gift";
  const listed = toSafeNumber(listedPriceUzs, 0).toLocaleString("uz-UZ");
  const offered = toSafeNumber(offeredPriceUzs, 0).toLocaleString("uz-UZ");
  const buyerLabel = formatUserLabel({
    profileName: buyerProfileName,
    username: buyerUsername,
    tgUserId: buyerTgUserId,
  });
  const sellerLabel = formatUserLabel({
    profileName: sellerProfileName,
    username: sellerUsername,
    tgUserId: sellerTgUserId,
  });

  if (status === "new_offer") {
    await sendTelegramText(
      sellerTgUserId,
      `📩 Yangi NFT taklif\n\nNFT: ${title}\nSotuv narxi: ${listed} UZS\nTaklif: ${offered} UZS\nXaridor: ${buyerLabel}\n\nWebApp ichida qabul yoki bekor qilishingiz mumkin.`,
    );
    return;
  }

  if (status === "accepted") {
    await Promise.allSettled([
      sendTelegramText(
        buyerTgUserId,
        `✅ Taklif qabul qilindi\n\nNFT: ${title}\nNarx: ${offered} UZS\nSotuvchi: ${sellerLabel}`,
      ),
      sendTelegramText(
        sellerTgUserId,
        `✅ Taklif qabul qilindi\n\nNFT: ${title}\nNarx: ${offered} UZS\nXaridor: ${buyerLabel}`,
      ),
    ]);
    return;
  }

  if (status === "rejected") {
    await sendTelegramText(
      buyerTgUserId,
      `❌ Taklif rad etildi\n\nNFT: ${title}\nTaklif: ${offered} UZS`,
    );
    return;
  }

  if (status === "expired") {
    await sendTelegramText(
      buyerTgUserId,
      `⌛ Taklif muddati tugadi\n\nNFT: ${title}\nTaklif: ${offered} UZS`,
    );
  }
}

async function sendPurchaseResultBotNotify({
  tgUserId,
  kind = "gift",
  status = "success",
  title = "",
  amountUzs = 0,
  reason = "",
}) {
  const target = normalizeString(tgUserId);
  if (!target) return;

  const safeKind = normalizeString(kind).toLowerCase() === "nft" ? "nft" : "gift";
  const safeTitle = normalizeString(title) || (safeKind === "nft" ? "NFT Gift" : "Gift");
  const safeReason = normalizeString(reason) || "Noma'lum xatolik";
  const hasAmount = Math.round(toSafeNumber(amountUzs, 0)) > 0;

  let text = "";
  if (status === "success") {
    text =
      safeKind === "nft"
        ? `✅ NFT sotib olindi\n\nNFT: ${safeTitle}`
        : `✅ Gift sotib olindi\n\nGift: ${safeTitle}`;
    if (hasAmount) text += `\nNarx: ${formatUzsAmount(amountUzs)}`;
  } else {
    text =
      safeKind === "nft"
        ? `❌ NFT sotib olish bekor qilindi\n\nNFT: ${safeTitle}`
        : `❌ Gift sotib olish bekor qilindi\n\nGift: ${safeTitle}`;
    if (hasAmount) text += `\nNarx: ${formatUzsAmount(amountUzs)}`;
    text += `\nSabab: ${safeReason}`;
  }

  await sendTelegramText(target, text);
}

async function expirePendingOffers() {
  const now = new Date();
  const expired = await NftOffer.find({
    status: "pending",
    expiresAt: { $lte: now },
  })
    .select({
      _id: 1,
      nftId: 1,
      buyerTgUserId: 1,
      buyerUsername: 1,
      buyerProfileName: 1,
      sellerTgUserId: 1,
      sellerUsername: 1,
      sellerProfileName: 1,
      listingPriceUzs: 1,
      offeredPriceUzs: 1,
    })
    .lean();

  if (!expired.length) return 0;

  await NftOffer.updateMany(
    {
      _id: { $in: expired.map((item) => item._id) },
      status: "pending",
    },
    {
      $set: {
        status: "expired",
        expiredAt: now,
        respondedAt: now,
        cancelReason: "offer_expired",
      },
    },
  );

  for (const offer of expired) {
    emitUserUpdate(normalizeString(offer.buyerTgUserId), {
      type: "nft_offer_expired",
      refreshNfts: true,
      refreshNftOffers: true,
      nftId: normalizeString(offer.nftId),
      offerId: String(offer._id),
    });
    emitUserUpdate(normalizeString(offer.sellerTgUserId), {
      type: "nft_offer_expired",
      refreshNftOffers: true,
      nftId: normalizeString(offer.nftId),
      offerId: String(offer._id),
    });
  }

  await runInBatches(expired, 12, (offer) =>
    sendNftOfferBotNotify({
      sellerTgUserId: normalizeString(offer.sellerTgUserId),
      buyerTgUserId: normalizeString(offer.buyerTgUserId),
      buyerProfileName: normalizeString(offer.buyerProfileName),
      buyerUsername: normalizeString(offer.buyerUsername),
      sellerProfileName: normalizeString(offer.sellerProfileName),
      sellerUsername: normalizeString(offer.sellerUsername),
      nftTitle: "",
      listedPriceUzs: toSafeNumber(offer.listingPriceUzs, 0),
      offeredPriceUzs: toSafeNumber(offer.offeredPriceUzs, 0),
      status: "expired",
    }),
  );

  return expired.length;
}

const OFFER_EXPIRE_MIN_INTERVAL_MS = Math.min(
  Math.max(Math.trunc(toSafeNumber(process.env.OFFER_EXPIRE_MIN_INTERVAL_MS, 15_000)), 2_000),
  60_000,
);
const NFT_SYNC_MIN_INTERVAL_MS = Math.min(
  Math.max(Math.trunc(toSafeNumber(process.env.NFT_SYNC_MIN_INTERVAL_MS, 20_000)), 3_000),
  120_000,
);

const offerExpireRuntime = {
  lastRunAt: 0,
  lastExpiredCount: 0,
  inFlight: null,
};

const nftSyncRuntime = {
  lastRunAt: 0,
  lastResult: null,
  inFlight: null,
};

async function ensurePendingOffersFresh({ force = false } = {}) {
  const now = Date.now();
  if (
    !force &&
    offerExpireRuntime.lastRunAt &&
    now - offerExpireRuntime.lastRunAt < OFFER_EXPIRE_MIN_INTERVAL_MS
  ) {
    return {
      expiredCount: offerExpireRuntime.lastExpiredCount,
      skipped: true,
      checkedAt: new Date(offerExpireRuntime.lastRunAt).toISOString(),
    };
  }

  if (offerExpireRuntime.inFlight) {
    return offerExpireRuntime.inFlight;
  }

  offerExpireRuntime.inFlight = (async () => {
    const expiredCount = await expirePendingOffers();
    offerExpireRuntime.lastRunAt = Date.now();
    offerExpireRuntime.lastExpiredCount = Math.max(0, Math.trunc(toSafeNumber(expiredCount, 0)));
    return {
      expiredCount: offerExpireRuntime.lastExpiredCount,
      skipped: false,
      checkedAt: new Date(offerExpireRuntime.lastRunAt).toISOString(),
    };
  })().finally(() => {
    offerExpireRuntime.inFlight = null;
  });

  return offerExpireRuntime.inFlight;
}

if (!global.__nftOfferExpiryIntervalStarted) {
  global.__nftOfferExpiryIntervalStarted = true;
  setInterval(() => {
    expirePendingOffers().catch(() => {});
  }, 60 * 1000);
}

async function cancelPendingOffersForNft(nftId, reason, excludeOfferId = "") {
  const normalizedNftId = normalizeString(nftId);
  if (!normalizedNftId) return;

  const pending = await NftOffer.find({
    nftId: normalizedNftId,
    status: "pending",
    ...(excludeOfferId ? { _id: { $ne: excludeOfferId } } : {}),
  })
    .select({ _id: 1, buyerTgUserId: 1, sellerTgUserId: 1, offeredPriceUzs: 1 })
    .lean();

  if (!pending.length) return;

  const now = new Date();
  await NftOffer.updateMany(
    {
      _id: { $in: pending.map((item) => item._id) },
      status: "pending",
    },
    {
      $set: {
        status: "cancelled",
        cancelledAt: now,
        respondedAt: now,
        cancelReason: normalizeString(reason) || "listing_unavailable",
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
  }
}

async function syncOwnedNftsFromTelegram() {
  const telegramItems = await getMyTelegramNftGifts({
    limit: 500,
    debug: false,
    debugLimit: 0,
  });

  const nftIds = Array.from(
    new Set(
      telegramItems
        .map((item) => normalizeString(item?.nftId))
        .filter(Boolean),
    ),
  );

  const uniqueSourceIds = Array.from(
    new Set(
      telegramItems
        .map((item) => normalizeString(item?.sourceFromUserId))
        .filter(Boolean),
    ),
  );

  const users = uniqueSourceIds.length
    ? await User.find({ tgUserId: { $in: uniqueSourceIds } })
        .select({ tgUserId: 1, username: 1 })
        .lean()
    : [];

  const userMap = new Map(
    users.map((item) => [normalizeString(item.tgUserId), item]),
  );

  const existingDocs = nftIds.length
    ? await UserNft.find({ nftId: { $in: nftIds } })
        .select({ nftId: 1, ownerTgUserId: 1, ownerUsername: 1 })
        .lean()
    : [];
  const existingMap = new Map(
    existingDocs.map((doc) => [normalizeString(doc.nftId), doc]),
  );

  const syncAt = new Date();

  const writeOps = [];

  for (const item of telegramItems) {
    const nftId = normalizeString(item?.nftId);
    if (!nftId) continue;

    const sourceFromTgUserId = normalizeString(item?.sourceFromUserId);
    const sourceUser = sourceFromTgUserId
      ? userMap.get(sourceFromTgUserId) || null
      : null;

    const metadata = {
      giftId: normalizeGiftId(item?.giftId),
      slug: normalizeString(item?.slug),
      title: normalizeString(item?.title) || "NFT Gift",
      nftNumber: Math.trunc(toSafeNumber(item?.nftNumber, 0)),
      emoji: normalizeString(item?.emoji) || "🎁",
      ownerName: normalizeString(item?.ownerName) || "-",
      model: normalizeString(item?.model),
      modelRarity: normalizeString(item?.modelRarity),
      symbol: normalizeString(item?.symbol),
      symbolRarity: normalizeString(item?.symbolRarity),
      backdrop: normalizeString(item?.backdrop),
      backdropRarity: normalizeString(item?.backdropRarity),
      backdropColors: item?.backdropColors || undefined,
      patternAssetStatus: normalizeString(item?.patternAsset?.status) || "unknown",
      patternAssetSourceMethod: normalizeString(item?.patternAsset?.sourceMethod),
      patternAssetSourceLabel: normalizeString(item?.patternAsset?.sourceLabel),
      patternAssetPath: normalizeString(item?.patternAsset?.path),
      patternAssetMimeType: normalizeString(item?.patternAsset?.mimeType),
      patternAssetMissingReason: normalizeString(item?.patternAsset?.missingReason),
      quantityIssued: toSafeNumber(item?.quantityIssued, 0),
      quantityTotal: toSafeNumber(item?.quantityTotal, 0),
      valueStars: toSafeNumber(item?.valueStars, 0),
      acquiredAt: toDateOrNull(item?.acquiredAt),
      canTransferAt: toDateOrNull(item?.canTransferAt),
      sourceFromTgUserId,
      sourceFromUsername: normalizeString(
        sourceUser?.username || item?.sourceFromUsername,
      ),
      sourceFromName: normalizeString(item?.sourceFromName),
      sourceMsgId: Math.trunc(toSafeNumber(item?.sourceMsgId, 0)),
      sourceSavedId: normalizeString(item?.sourceSavedId),
      isTelegramPresent: true,
      telegramSyncedAt: syncAt,
    };

    const existing = existingMap.get(nftId) || null;
    if (existing) {
      const keepOwnerTgUserId = normalizeString(existing.ownerTgUserId);
      const keepOwnerUsername = normalizeString(existing.ownerUsername);
      const nextOwnerTgUserId =
        keepOwnerTgUserId || normalizeString(sourceUser?.tgUserId);
      const nextOwnerUsername =
        keepOwnerUsername || normalizeString(sourceUser?.username);

      const updatePayload = {
        ...metadata,
      };
      if (nextOwnerTgUserId) {
        updatePayload.ownerTgUserId = nextOwnerTgUserId;
        updatePayload.ownerUsername = nextOwnerUsername;
      }

      writeOps.push({
        updateOne: {
          filter: { nftId },
          update: {
            $set: updatePayload,
          },
        },
      });
      continue;
    }

    if (sourceUser?.tgUserId) {
      writeOps.push({
        updateOne: {
          filter: { nftId },
          update: {
            $set: {
              ...metadata,
              ownerTgUserId: normalizeString(sourceUser.tgUserId),
              ownerUsername: normalizeString(sourceUser.username),
            },
            $setOnInsert: {
              marketStatus: "owned",
              listingPriceUzs: 0,
              listedAt: null,
              listedByTgUserId: "",
            },
          },
          upsert: true,
        },
      });
      continue;
    }

    writeOps.push({
      updateOne: {
        filter: { nftId },
        update: { $set: metadata },
      },
    });
  }

  for (let index = 0; index < writeOps.length; index += 200) {
    const chunk = writeOps.slice(index, index + 200);
    await UserNft.bulkWrite(chunk, { ordered: false });
  }

  return {
    fetchedCount: telegramItems.length,
    syncedAt: syncAt.toISOString(),
    upsertedOrUpdated: writeOps.length,
    skipped: false,
  };
}

async function maybeSyncOwnedNftsFromTelegram({ force = false } = {}) {
  const now = Date.now();
  if (
    !force &&
    nftSyncRuntime.lastResult &&
    nftSyncRuntime.lastRunAt &&
    now - nftSyncRuntime.lastRunAt < NFT_SYNC_MIN_INTERVAL_MS
  ) {
    return {
      ...nftSyncRuntime.lastResult,
      skipped: true,
      fromCache: true,
    };
  }

  if (nftSyncRuntime.inFlight) {
    return nftSyncRuntime.inFlight;
  }

  nftSyncRuntime.inFlight = (async () => {
    const result = await syncOwnedNftsFromTelegram();
    nftSyncRuntime.lastRunAt = Date.now();
    nftSyncRuntime.lastResult = {
      ...result,
      skipped: false,
      fromCache: false,
    };
    return nftSyncRuntime.lastResult;
  })().finally(() => {
    nftSyncRuntime.inFlight = null;
  });

  return nftSyncRuntime.inFlight;
}

async function getGiftCatalog(req, res) {
  try {
    const [pricing, gifts] = await Promise.all([
      getStarPricing(),
      getStarGiftsCatalog({ includeSoldOut: false }),
    ]);

    const pricePerStar = toSafeNumber(pricing?.pricePerStar, 0);
    const payload = gifts.map((gift) => buildCatalogGift(gift, pricePerStar));

    return response.success(res, "Gift catalog", {
      pricePerStar,
      gifts: payload,
    });
  } catch (error) {
    return response.serverError(
      res,
      "Gift katalogini olishda xatolik",
      error.message,
    );
  }
}

async function getGiftImage(req, res) {
  const giftId = normalizeGiftId(req.params?.giftId);
  if (!giftId) {
    return response.notFound(res, "Gift topilmadi");
  }

  try {
    const image = await getGiftImageBuffer(giftId);

    res.setHeader("Cache-Control", "public, max-age=300");
    res.setHeader("Content-Type", image.contentType || "image/svg+xml; charset=utf-8");
    return res.status(200).send(image.buffer);
  } catch (_) {
    res.setHeader("Cache-Control", "public, max-age=120");
    res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
    return res.status(200).send(buildImageFallbackSvg());
  }
}

async function getNftImage(req, res) {
  const nftId = normalizeString(req.params?.nftId);
  if (!nftId) {
    return response.notFound(res, "NFT topilmadi");
  }

  try {
    const nftDoc = await UserNft.findOne({ nftId })
      .select({ slug: 1 })
      .lean();
    const image = await getNftImageBuffer({
      nftId,
      slug: normalizeString(nftDoc?.slug),
    });

    res.setHeader("Cache-Control", "public, max-age=180");
    res.setHeader("Content-Type", image.contentType || "image/svg+xml; charset=utf-8");
    return res.status(200).send(image.buffer);
  } catch (_) {
    res.setHeader("Cache-Control", "public, max-age=120");
    res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
    return res.status(200).send(buildImageFallbackSvg());
  }
}

async function getNftPattern(req, res) {
  const nftId = normalizeString(req.params?.nftId);
  if (!nftId) {
    return response.notFound(res, "NFT topilmadi");
  }

  try {
    const nftDoc = await UserNft.findOne({ nftId })
      .select({ slug: 1 })
      .lean();

    const image = await getNftPatternImageBuffer({
      nftId,
      slug: normalizeString(nftDoc?.slug),
    });

    if (!image?.buffer) {
      res.setHeader("Cache-Control", "public, max-age=120");
      return res.status(204).end();
    }

    res.setHeader("Cache-Control", "public, max-age=600");
    res.setHeader("Content-Type", image.contentType || "image/webp");
    return res.status(200).send(image.buffer);
  } catch (error) {
    console.log(
      "[TG_PATTERN][HTTP_ERROR] " +
        normalizeString(error?.errorMessage || error?.message || "unknown"),
    );
    res.setHeader("Cache-Control", "public, max-age=60");
    return res.status(204).end();
  }
}

async function getMyGifts(req, res) {
  try {
    const tgUser = getTelegramUserFromRequest(req);
    if (!tgUser?.tgUserId) {
      return response.error(
        res,
        "Telegram profilingiz aniqlanmadi. Ilovani qayta ochib ko'ring.",
      );
    }

    const user = await ensureCurrentUser(tgUser);
    if (!user?.tgUserId) {
      return response.error(res, "Foydalanuvchi topilmadi");
    }

    const [pricing, catalog, ownedGifts] = await Promise.all([
      getStarPricing(),
      getStarGiftsCatalog({ includeSoldOut: true }),
      UserGift.find({ tgUserId: user.tgUserId, status: "owned" })
        .sort({ createdAt: -1 })
        .limit(500)
        .lean(),
    ]);

    const pricePerStar = toSafeNumber(pricing?.pricePerStar, 0);
    const catalogById = new Map(catalog.map((gift) => [normalizeGiftId(gift.giftId), gift]));

    const items = ownedGifts.map((gift) => {
      const giftId = normalizeGiftId(gift.giftId);
      const catalogGift = catalogById.get(giftId) || null;

      const stars = toSafeNumber(catalogGift?.stars, toSafeNumber(gift.stars, 0));
      const fallbackPrice = Math.round(stars * pricePerStar);

      return {
        userGiftId: String(gift._id),
        giftId,
        title: normalizeString(catalogGift?.title || gift.title) || "Gift",
        emoji: normalizeString(catalogGift?.emoji || gift.emoji) || "🎁",
        stars,
        priceUzs: toSafeNumber(gift.priceUzs, fallbackPrice),
        purchasedAt: gift.createdAt || null,
        imageUrl: `/api/gifts/image/${encodeURIComponent(giftId)}`,
      };
    });

    return response.success(res, "My gifts", {
      count: items.length,
      items,
    });
  } catch (error) {
    return response.serverError(
      res,
      "Giftlarni olishda xatolik",
      error.message,
    );
  }
}

async function getMyNftGifts(req, res) {
  try {
    await ensurePendingOffersFresh();

    const tgUser = getTelegramUserFromRequest(req);
    if (!tgUser?.tgUserId) {
      return response.error(
        res,
        "Telegram profilingiz aniqlanmadi. Ilovani qayta ochib ko'ring.",
      );
    }

    const user = await ensureCurrentUser(tgUser);
    if (!user?.tgUserId) {
      return response.error(res, "Foydalanuvchi topilmadi");
    }

    const [pricing, marketConfig] = await Promise.all([
      getStarPricing(),
      getNftMarketplaceConfig(),
    ]);

    let syncInfo = {
      fetchedCount: 0,
      syncedAt: null,
      skipped: true,
      syncError: "",
    };
    try {
      syncInfo = await maybeSyncOwnedNftsFromTelegram();
    } catch (syncError) {
      syncInfo = {
        ...syncInfo,
        syncError: normalizeString(syncError?.message),
      };
    }

    const docs = await UserNft.find({
      ownerTgUserId: user.tgUserId,
      isTelegramPresent: true,
      marketStatus: { $in: ["owned", "listed"] },
    })
      .sort({ updatedAt: -1, createdAt: -1 })
      .limit(300)
      .lean();

    const pricePerStar = toSafeNumber(pricing?.pricePerStar, 0);
    const items = docs.map((doc) => mapNftDocToClient(doc, pricePerStar));

    return response.success(res, "My NFT gifts", {
      source: "telegram_profile_mapped",
      count: items.length,
      pricePerStar,
      marketplaceFeePercent: toSafeNumber(marketConfig?.feePercent, 0),
      withdrawFeeUzs: Math.max(0, Math.round(toSafeNumber(marketConfig?.withdrawFeeUzs, 0))),
      syncInfo,
      items,
    });
  } catch (error) {
    return response.serverError(
      res,
      "NFT giftlarni olishda xatolik",
      error.message,
    );
  }
}

async function getNftMarketplace(req, res) {
  try {
    await ensurePendingOffersFresh();

    const tgUser = getTelegramUserFromRequest(req);
    if (!tgUser?.tgUserId) {
      return response.error(
        res,
        "Telegram profilingiz aniqlanmadi. Ilovani qayta ochib ko'ring.",
      );
    }

    const user = await ensureCurrentUser(tgUser);
    if (!user?.tgUserId) {
      return response.error(res, "Foydalanuvchi topilmadi");
    }

    const [pricing, marketConfig] = await Promise.all([
      getStarPricing(),
      getNftMarketplaceConfig(),
    ]);

    let syncInfo = {
      fetchedCount: 0,
      syncedAt: null,
      skipped: true,
      syncError: "",
    };
    try {
      syncInfo = await maybeSyncOwnedNftsFromTelegram();
    } catch (syncError) {
      syncInfo = {
        ...syncInfo,
        syncError: normalizeString(syncError?.message),
      };
    }

    const docs = await UserNft.find({
      marketStatus: "listed",
      isTelegramPresent: true,
      ownerTgUserId: { $ne: user.tgUserId },
    })
      .sort({ listedAt: -1, updatedAt: -1 })
      .limit(300)
      .lean();

    const pricePerStar = toSafeNumber(pricing?.pricePerStar, 0);

    const items = docs.map((doc) => ({
      ...mapNftDocToClient(doc, pricePerStar),
      sellerTgUserId: normalizeString(doc.ownerTgUserId),
      sellerUsername: normalizeString(doc.ownerUsername),
      priceUzs: toSafeNumber(doc.listingPriceUzs, 0),
    }));

    return response.success(res, "NFT marketplace", {
      count: items.length,
      pricePerStar,
      feePercent: toSafeNumber(marketConfig?.feePercent, 0),
      withdrawFeeUzs: Math.max(0, Math.round(toSafeNumber(marketConfig?.withdrawFeeUzs, 0))),
      syncInfo,
      items,
    });
  } catch (error) {
    return response.serverError(
      res,
      "NFT marketplace ro'yxatini olishda xatolik",
      error.message,
    );
  }
}

async function createNftOffer(req, res) {
  try {
    await ensurePendingOffersFresh();

    const tgUser = getTelegramUserFromRequest(req);
    if (!tgUser?.tgUserId) {
      return response.error(
        res,
        "Telegram profilingiz aniqlanmadi. Ilovani qayta ochib ko'ring.",
      );
    }

    const buyer = await ensureCurrentUser(tgUser);
    if (!buyer?.tgUserId) {
      return response.error(res, "Foydalanuvchi topilmadi");
    }
    if (buyer?.isBlocked) {
      return response.error(res, "Foydalanuvchi bloklangan");
    }

    const nftId = normalizeString(req.body?.nftId);
    const offeredPriceUzs = Math.round(toSafeNumber(req.body?.offeredPriceUzs, 0));
    const offerDurationDays = Math.trunc(toSafeNumber(req.body?.offerDurationDays, 0));
    const buyerBalanceUzs = Math.max(0, Math.round(toSafeNumber(buyer?.balance, 0)));

    if (!nftId) return response.error(res, "nftId required");
    if (!offeredPriceUzs || offeredPriceUzs <= 0) {
      return response.error(res, "Taklif summasi noto'g'ri");
    }
    if (!offerDurationDays || offerDurationDays < 1 || offerDurationDays > 30) {
      return response.error(res, "Taklif muddati 1-30 kun oralig'ida bo'lishi kerak");
    }
    if (buyerBalanceUzs <= 0) {
      return response.error(res, "Balansda mablag' yetarli emas");
    }
    if (buyerBalanceUzs < offeredPriceUzs) {
      return response.error(
        res,
        "Balans yetarli emas. Balansingiz: " +
          buyerBalanceUzs.toLocaleString("uz-UZ") +
          " UZS, taklif: " +
          offeredPriceUzs.toLocaleString("uz-UZ") +
          " UZS",
      );
    }

    const latestOffer = await NftOffer.findOne({
      buyerTgUserId: buyer.tgUserId,
    })
      .sort({ createdAt: -1 })
      .lean();

    if (latestOffer?.createdAt) {
      const cooldownMs = 60 * 1000;
      const passedMs = Date.now() - new Date(latestOffer.createdAt).getTime();
      if (passedMs < cooldownMs) {
        const waitSeconds = Math.ceil((cooldownMs - passedMs) / 1000);
        return response.error(
          res,
          `Yangi taklif yuborish uchun ${waitSeconds} soniya kuting`,
        );
      }
    }

    const listing = await UserNft.findOne({
      nftId,
      marketStatus: "listed",
      isTelegramPresent: true,
    }).lean();

    if (!listing) {
      return response.error(res, "NFT marketplace'da topilmadi");
    }

    const sellerTgUserId = normalizeString(listing.ownerTgUserId);
    if (!sellerTgUserId) {
      return response.error(res, "Sotuvchi aniqlanmadi");
    }
    if (sellerTgUserId === buyer.tgUserId) {
      return response.error(res, "O'zingizning NFT'ingizga taklif yubora olmaysiz");
    }

    const offerLimitWindowMs = 60 * 60 * 1000;
    const offerLimitPerNft = 3;
    const limitWindowStart = new Date(Date.now() - offerLimitWindowMs);

    const recentOfferCountForNft = await NftOffer.countDocuments({
      buyerTgUserId: buyer.tgUserId,
      nftId,
      createdAt: { $gte: limitWindowStart },
    });

    if (recentOfferCountForNft >= offerLimitPerNft) {
      const oldestRecentOffer = await NftOffer.findOne({
        buyerTgUserId: buyer.tgUserId,
        nftId,
        createdAt: { $gte: limitWindowStart },
      })
        .sort({ createdAt: 1 })
        .lean();

      const unlockAtMs =
        new Date(oldestRecentOffer?.createdAt || Date.now()).getTime() +
        offerLimitWindowMs;
      const waitSeconds = Math.max(1, Math.ceil((unlockAtMs - Date.now()) / 1000));
      const waitLabel = formatRemainingSeconds(waitSeconds);

      return response.error(
        res,
        `Bu NFT uchun soatlik limit tugagan (max 3 ta taklif). Qolgan vaqt: ${waitLabel}`,
      );
    }

    const existingPending = await NftOffer.findOne({
      nftId,
      buyerTgUserId: buyer.tgUserId,
      status: "pending",
    }).lean();
    if (existingPending) {
      return response.error(
        res,
        "Bu NFT uchun avvalgi taklifingiz hali ko'rib chiqilmagan",
      );
    }

    const created = await NftOffer.create({
      nftId,
      sellerTgUserId,
      sellerUsername: normalizeString(listing.ownerUsername),
      sellerProfileName: pickFirstNonEmpty(
        listing.ownerName,
        listing.ownerUsername,
        sellerTgUserId,
      ),
      buyerTgUserId: buyer.tgUserId,
      buyerUsername: normalizeString(buyer.username),
      buyerProfileName: pickFirstNonEmpty(
        buyer.profileName,
        buyer.username,
        buyer.tgUserId,
      ),
      listingPriceUzs: Math.max(0, Math.round(toSafeNumber(listing.listingPriceUzs, 0))),
      offeredPriceUzs,
      offerDurationDays,
      expiresAt: new Date(Date.now() + offerDurationDays * 24 * 60 * 60 * 1000),
      status: "pending",
    });

    emitUserUpdate(sellerTgUserId, {
      type: "nft_offer_received",
      refreshNfts: true,
      refreshNftOffers: true,
      nftId,
      offerId: String(created._id),
      offeredPriceUzs,
    });
    emitUserUpdate(buyer.tgUserId, {
      type: "nft_offer_sent",
      refreshNfts: true,
      refreshNftOffers: true,
      nftId,
      offerId: String(created._id),
      offeredPriceUzs,
    });

    await sendNftOfferBotNotify({
      sellerTgUserId,
      buyerTgUserId: buyer.tgUserId,
      buyerProfileName: pickFirstNonEmpty(
        buyer.profileName,
        buyer.username,
        buyer.tgUserId,
      ),
      buyerUsername: normalizeString(buyer.username),
      sellerProfileName: pickFirstNonEmpty(
        listing.ownerName,
        listing.ownerUsername,
        sellerTgUserId,
      ),
      sellerUsername: normalizeString(listing.ownerUsername),
      nftTitle: normalizeString(listing.title),
      listedPriceUzs: toSafeNumber(listing.listingPriceUzs, 0),
      offeredPriceUzs,
      status: "new_offer",
    });

    return response.created(res, "Taklif yuborildi", {
      offerId: String(created._id),
      nftId,
      offeredPriceUzs,
      listingPriceUzs: toSafeNumber(listing.listingPriceUzs, 0),
      offerDurationDays,
      expiresAt: created.expiresAt,
      status: "pending",
    });
  } catch (error) {
    return response.serverError(
      res,
      "NFT taklif yuborishda xatolik",
      error.message,
    );
  }
}

async function getIncomingNftOffers(req, res) {
  try {
    await ensurePendingOffersFresh();

    const tgUser = getTelegramUserFromRequest(req);
    if (!tgUser?.tgUserId) {
      return response.error(
        res,
        "Telegram profilingiz aniqlanmadi. Ilovani qayta ochib ko'ring.",
      );
    }

    const user = await ensureCurrentUser(tgUser);
    if (!user?.tgUserId) {
      return response.error(res, "Foydalanuvchi topilmadi");
    }

    const docs = await NftOffer.find({
      sellerTgUserId: user.tgUserId,
      status: "pending",
    })
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();

    const nftIds = Array.from(
      new Set(docs.map((item) => normalizeString(item?.nftId)).filter(Boolean)),
    );
    const nfts = nftIds.length
      ? await UserNft.find({ nftId: { $in: nftIds } })
          .select({
            nftId: 1,
            title: 1,
            slug: 1,
            giftId: 1,
            marketStatus: 1,
            ownerTgUserId: 1,
            ownerName: 1,
          })
          .lean()
      : [];
    const nftMap = new Map(nfts.map((item) => [normalizeString(item.nftId), item]));
    const userProfileMap = await getUserProfileNameMapByIds(
      docs.flatMap((item) => [item?.buyerTgUserId, item?.sellerTgUserId]),
    );

    const items = docs.map((doc) => {
      const nftDoc = nftMap.get(normalizeString(doc.nftId)) || null;
      const canSellerRespond =
        normalizeString(nftDoc?.marketStatus) === "listed" &&
        normalizeString(nftDoc?.ownerTgUserId) === user.tgUserId;
      const buyerProfileName = pickFirstNonEmpty(
        doc?.buyerProfileName,
        userProfileMap.get(normalizeString(doc?.buyerTgUserId)),
        doc?.buyerUsername,
        doc?.buyerTgUserId,
      );
      const sellerProfileName = pickFirstNonEmpty(
        doc?.sellerProfileName,
        userProfileMap.get(normalizeString(doc?.sellerTgUserId)),
        nftDoc?.ownerName,
        doc?.sellerUsername,
        doc?.sellerTgUserId,
      );
      return {
        ...mapOfferDocToClient(doc, nftDoc, {
          buyerProfileName,
          sellerProfileName,
        }),
        canSellerRespond,
      };
    });

    return response.success(res, "Incoming NFT offers", {
      count: items.length,
      items,
    });
  } catch (error) {
    return response.serverError(
      res,
      "NFT takliflarni olishda xatolik",
      error.message,
    );
  }
}

async function getMySentNftOffers(req, res) {
  try {
    await ensurePendingOffersFresh();

    const tgUser = getTelegramUserFromRequest(req);
    if (!tgUser?.tgUserId) {
      return response.error(
        res,
        "Telegram profilingiz aniqlanmadi. Ilovani qayta ochib ko'ring.",
      );
    }

    const user = await ensureCurrentUser(tgUser);
    if (!user?.tgUserId) {
      return response.error(res, "Foydalanuvchi topilmadi");
    }

    const docs = await NftOffer.find({
      buyerTgUserId: user.tgUserId,
    })
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();

    const nftIds = Array.from(
      new Set(docs.map((item) => normalizeString(item?.nftId)).filter(Boolean)),
    );
    const nfts = nftIds.length
      ? await UserNft.find({ nftId: { $in: nftIds } })
          .select({
            nftId: 1,
            title: 1,
            slug: 1,
            giftId: 1,
            marketStatus: 1,
            ownerTgUserId: 1,
            ownerName: 1,
          })
          .lean()
      : [];
    const nftMap = new Map(nfts.map((item) => [normalizeString(item.nftId), item]));
    const userProfileMap = await getUserProfileNameMapByIds(
      docs.flatMap((item) => [item?.buyerTgUserId, item?.sellerTgUserId]),
    );

    const items = docs.map((doc) => {
      const nftDoc = nftMap.get(normalizeString(doc.nftId)) || null;
      const canDelete =
        normalizeString(doc.status) === "pending" &&
        (!doc.expiresAt || new Date(doc.expiresAt).getTime() > Date.now());
      const buyerProfileName = pickFirstNonEmpty(
        doc?.buyerProfileName,
        userProfileMap.get(normalizeString(doc?.buyerTgUserId)),
        doc?.buyerUsername,
        doc?.buyerTgUserId,
      );
      const sellerProfileName = pickFirstNonEmpty(
        doc?.sellerProfileName,
        userProfileMap.get(normalizeString(doc?.sellerTgUserId)),
        nftDoc?.ownerName,
        doc?.sellerUsername,
        doc?.sellerTgUserId,
      );
      return {
        ...mapOfferDocToClient(doc, nftDoc, {
          buyerProfileName,
          sellerProfileName,
        }),
        canDelete,
      };
    });

    return response.success(res, "My sent NFT offers", {
      count: items.length,
      items,
    });
  } catch (error) {
    return response.serverError(
      res,
      "Yuborilgan NFT takliflarni olishda xatolik",
      error.message,
    );
  }
}

async function cancelMyNftOffer(req, res) {
  try {
    await ensurePendingOffersFresh();

    const tgUser = getTelegramUserFromRequest(req);
    if (!tgUser?.tgUserId) {
      return response.error(
        res,
        "Telegram profilingiz aniqlanmadi. Ilovani qayta ochib ko'ring.",
      );
    }

    const user = await ensureCurrentUser(tgUser);
    if (!user?.tgUserId) {
      return response.error(res, "Foydalanuvchi topilmadi");
    }
    if (user?.isBlocked) {
      return response.error(res, "Foydalanuvchi bloklangan");
    }

    const offerId = normalizeString(req.body?.offerId);
    if (!offerId) return response.error(res, "offerId required");

    const updated = await NftOffer.findOneAndUpdate(
      {
        _id: offerId,
        buyerTgUserId: user.tgUserId,
        status: "pending",
      },
      {
        $set: {
          status: "cancelled",
          cancelledAt: new Date(),
          respondedAt: new Date(),
          cancelReason: "cancelled_by_buyer",
        },
      },
      { new: true },
    ).lean();

    if (!updated) {
      return response.error(res, "Taklif topilmadi yoki allaqachon yakunlangan");
    }

    emitUserUpdate(normalizeString(updated.sellerTgUserId), {
      type: "nft_offer_cancelled",
      refreshNfts: true,
      refreshNftOffers: true,
      nftId: normalizeString(updated.nftId),
      offerId: String(updated._id),
    });
    emitUserUpdate(normalizeString(updated.buyerTgUserId), {
      type: "nft_offer_cancelled",
      refreshNftOffers: true,
      nftId: normalizeString(updated.nftId),
      offerId: String(updated._id),
    });

    return response.success(res, "Taklif bekor qilindi", {
      offerId: String(updated._id),
      nftId: normalizeString(updated.nftId),
      status: normalizeString(updated.status),
    });
  } catch (error) {
    return response.serverError(
      res,
      "Taklifni bekor qilishda xatolik",
      error.message,
    );
  }
}

async function acceptNftOffer(req, res) {
  try {
    await ensurePendingOffersFresh();

    const tgUser = getTelegramUserFromRequest(req);
    if (!tgUser?.tgUserId) {
      return response.error(
        res,
        "Telegram profilingiz aniqlanmadi. Ilovani qayta ochib ko'ring.",
      );
    }

    const sellerUser = await ensureCurrentUser(tgUser);
    if (!sellerUser?.tgUserId) return response.error(res, "Foydalanuvchi topilmadi");
    if (sellerUser?.isBlocked) return response.error(res, "Foydalanuvchi bloklangan");

    const offerId = normalizeString(req.body?.offerId);
    if (!offerId) return response.error(res, "offerId required");

    const offer = await NftOffer.findOne({
      _id: offerId,
      sellerTgUserId: sellerUser.tgUserId,
      status: "pending",
    }).lean();

    if (!offer) {
      return response.error(res, "Taklif topilmadi yoki allaqachon yakunlangan");
    }

    const listing = await UserNft.findOne({
      nftId: normalizeString(offer.nftId),
      marketStatus: "listed",
      isTelegramPresent: true,
      ownerTgUserId: sellerUser.tgUserId,
    }).lean();

    if (!listing) {
      await NftOffer.updateOne(
        { _id: offer._id, status: "pending" },
        {
          $set: {
            status: "cancelled",
            cancelledAt: new Date(),
            respondedAt: new Date(),
            cancelReason: "listing_unavailable",
          },
        },
      );
      return response.error(res, "NFT sotuvda emas");
    }

    const buyer = await User.findOne({
      tgUserId: normalizeString(offer.buyerTgUserId),
    }).lean();
    if (!buyer?.tgUserId) {
      return response.error(res, "Xaridor topilmadi");
    }
    if (buyer?.isBlocked) {
      return response.error(res, "Xaridor bloklangan");
    }

    const priceUzs = Math.round(toSafeNumber(offer.offeredPriceUzs, 0));
    if (!priceUzs || priceUzs <= 0) {
      return response.error(res, "Taklif narxi noto'g'ri");
    }

    const marketConfig = await getNftMarketplaceConfig();
    const feePercent = toSafeNumber(marketConfig?.feePercent, 0);
    const feeAmountUzs = Math.round((priceUzs * feePercent) / 100);
    const sellerNetUzs = Math.max(0, priceUzs - feeAmountUzs);

    const buyerAfter = await User.findOneAndUpdate(
      {
        tgUserId: buyer.tgUserId,
        balance: { $gte: priceUzs },
      },
      {
        $inc: { balance: -priceUzs },
      },
      { new: true },
    ).lean();
    if (!buyerAfter) {
      return response.error(res, "Xaridor balansida mablag' yetarli emas");
    }

    const soldAt = new Date();
    const transferred = await UserNft.findOneAndUpdate(
      {
        nftId: normalizeString(offer.nftId),
        marketStatus: "listed",
        ownerTgUserId: sellerUser.tgUserId,
        isTelegramPresent: true,
      },
      {
        $set: {
          ownerTgUserId: normalizeString(buyer.tgUserId),
          ownerUsername: normalizeString(buyer.username),
          isTelegramPresent: true,
          marketStatus: "owned",
          listingPriceUzs: 0,
          listedAt: null,
          listedByTgUserId: "",
          lastSoldAt: soldAt,
          lastSoldPriceUzs: priceUzs,
          lastSaleFeePercent: feePercent,
          lastSaleFeeAmountUzs: feeAmountUzs,
          lastSellerNetUzs: sellerNetUzs,
          lastSellerTgUserId: normalizeString(sellerUser.tgUserId),
          lastBuyerTgUserId: normalizeString(buyer.tgUserId),
        },
      },
      { new: true },
    ).lean();

    if (!transferred) {
      await User.updateOne(
        { tgUserId: buyer.tgUserId },
        { $inc: { balance: priceUzs } },
      );
      return response.error(
        res,
        "NFT sotuv holatini yangilab bo'lmadi. Qayta urinib ko'ring.",
      );
    }

    const sellerAfter = await User.findOneAndUpdate(
      { tgUserId: sellerUser.tgUserId },
      {
        $inc: { balance: sellerNetUzs },
      },
      { new: true },
    ).lean();

    if (!sellerAfter) {
      await User.updateOne(
        { tgUserId: buyer.tgUserId },
        { $inc: { balance: priceUzs } },
      );
      await UserNft.updateOne(
        {
          nftId: normalizeString(offer.nftId),
          ownerTgUserId: normalizeString(buyer.tgUserId),
          lastSoldAt: soldAt,
        },
        {
          $set: {
            ownerTgUserId: normalizeString(sellerUser.tgUserId),
            ownerUsername: normalizeString(listing.ownerUsername),
            marketStatus: "listed",
            listingPriceUzs: toSafeNumber(listing.listingPriceUzs, 0),
            listedAt: listing.listedAt || soldAt,
            listedByTgUserId:
              normalizeString(listing.listedByTgUserId) ||
              normalizeString(sellerUser.tgUserId),
          },
        },
      );
      return response.serverError(res, "Sotuvchini balansini yangilab bo'lmadi");
    }

    const now = new Date();
    await NftOffer.updateOne(
      { _id: offer._id, status: "pending" },
      {
        $set: {
          status: "accepted",
          acceptedAt: now,
          respondedAt: now,
          cancelReason: "",
        },
      },
    );

    await cancelPendingOffersForNft(
      normalizeString(offer.nftId),
      "sold_after_offer_accepted",
      String(offer._id),
    );

    emitUserUpdate(normalizeString(buyer.tgUserId), {
      type: "nft_offer_accepted",
      refreshBalance: true,
      refreshNfts: true,
      refreshNftOffers: true,
      nftId: normalizeString(offer.nftId),
      offerId: String(offer._id),
      priceUzs,
    });
    emitUserUpdate(normalizeString(sellerUser.tgUserId), {
      type: "nft_offer_accepted",
      refreshBalance: true,
      refreshNfts: true,
      refreshNftOffers: true,
      nftId: normalizeString(offer.nftId),
      offerId: String(offer._id),
      priceUzs,
    });

    await sendNftOfferBotNotify({
      sellerTgUserId: normalizeString(sellerUser.tgUserId),
      buyerTgUserId: normalizeString(buyer.tgUserId),
      buyerProfileName: pickFirstNonEmpty(
        buyer.profileName,
        buyer.username,
        buyer.tgUserId,
      ),
      buyerUsername: normalizeString(buyer.username),
      sellerProfileName: pickFirstNonEmpty(
        sellerUser.profileName,
        sellerUser.username,
        sellerUser.tgUserId,
      ),
      sellerUsername: normalizeString(sellerUser.username),
      nftTitle: normalizeString(listing.title),
      listedPriceUzs: toSafeNumber(listing.listingPriceUzs, 0),
      offeredPriceUzs: priceUzs,
      status: "accepted",
    });

    const transferredTitle = splitNftTitleAndNumber(transferred.title);
    return response.success(res, "Taklif qabul qilindi", {
      offerId: String(offer._id),
      nftId: normalizeString(offer.nftId),
      title: transferredTitle.title || "NFT Gift",
      priceUzs,
      feePercent,
      feeAmountUzs,
      sellerNetUzs,
      buyerBalance: toSafeNumber(buyerAfter.balance, 0),
      sellerBalance: toSafeNumber(sellerAfter.balance, 0),
      transferPending: true,
    });
  } catch (error) {
    return response.serverError(
      res,
      "NFT taklifini qabul qilishda xatolik",
      error.message,
    );
  }
}

async function rejectNftOffer(req, res) {
  try {
    await ensurePendingOffersFresh();

    const tgUser = getTelegramUserFromRequest(req);
    if (!tgUser?.tgUserId) {
      return response.error(
        res,
        "Telegram profilingiz aniqlanmadi. Ilovani qayta ochib ko'ring.",
      );
    }

    const seller = await ensureCurrentUser(tgUser);
    if (!seller?.tgUserId) return response.error(res, "Foydalanuvchi topilmadi");
    if (seller?.isBlocked) return response.error(res, "Foydalanuvchi bloklangan");

    const offerId = normalizeString(req.body?.offerId);
    if (!offerId) return response.error(res, "offerId required");
    const responseNote = normalizeString(req.body?.note).slice(0, 280);

    const offered = await NftOffer.findOneAndUpdate(
      {
        _id: offerId,
        sellerTgUserId: seller.tgUserId,
        status: "pending",
      },
      {
        $set: {
          status: "rejected",
          rejectedAt: new Date(),
          respondedAt: new Date(),
          responseNote,
        },
      },
      { new: true },
    ).lean();

    if (!offered) {
      return response.error(res, "Taklif topilmadi yoki allaqachon ko'rib chiqilgan");
    }

    emitUserUpdate(normalizeString(offered.buyerTgUserId), {
      type: "nft_offer_rejected",
      refreshNfts: true,
      refreshNftOffers: true,
      nftId: normalizeString(offered.nftId),
      offerId: String(offered._id),
    });
    emitUserUpdate(normalizeString(seller.tgUserId), {
      type: "nft_offer_rejected",
      refreshNftOffers: true,
      nftId: normalizeString(offered.nftId),
      offerId: String(offered._id),
    });

    const nftDoc = await UserNft.findOne({ nftId: normalizeString(offered.nftId) })
      .select({ title: 1, listingPriceUzs: 1 })
      .lean();

    await sendNftOfferBotNotify({
      sellerTgUserId: normalizeString(offered.sellerTgUserId),
      buyerTgUserId: normalizeString(offered.buyerTgUserId),
      buyerProfileName: normalizeString(offered.buyerProfileName),
      buyerUsername: normalizeString(offered.buyerUsername),
      sellerProfileName: normalizeString(offered.sellerProfileName),
      sellerUsername: normalizeString(offered.sellerUsername),
      nftTitle: normalizeString(nftDoc?.title),
      listedPriceUzs: toSafeNumber(offered.listingPriceUzs, 0),
      offeredPriceUzs: toSafeNumber(offered.offeredPriceUzs, 0),
      status: "rejected",
    });

    return response.success(res, "Taklif rad etildi", {
      offerId: String(offered._id),
      nftId: normalizeString(offered.nftId),
      status: normalizeString(offered.status),
    });
  } catch (error) {
    return response.serverError(
      res,
      "NFT taklifini rad etishda xatolik",
      error.message,
    );
  }
}

async function listMyNftForSale(req, res) {
  try {
    const tgUser = getTelegramUserFromRequest(req);
    if (!tgUser?.tgUserId) {
      return response.error(
        res,
        "Telegram profilingiz aniqlanmadi. Ilovani qayta ochib ko'ring.",
      );
    }

    const user = await ensureCurrentUser(tgUser);
    if (!user?.tgUserId) {
      return response.error(res, "Foydalanuvchi topilmadi");
    }
    if (user?.isBlocked) {
      return response.error(res, "Foydalanuvchi bloklangan");
    }

    const nftId = normalizeString(req.body?.nftId);
    const listingPriceUzs = Math.round(toSafeNumber(req.body?.priceUzs, 0));

    if (!nftId) {
      return response.error(res, "nftId required");
    }
    if (!listingPriceUzs || listingPriceUzs <= 0) {
      return response.error(res, "priceUzs noto'g'ri");
    }

    await maybeSyncOwnedNftsFromTelegram({ force: true });

    const listedAt = new Date();
    const updated = await UserNft.findOneAndUpdate(
      {
        nftId,
        ownerTgUserId: user.tgUserId,
        marketStatus: "owned",
        isTelegramPresent: true,
      },
      {
        $set: {
          marketStatus: "listed",
          listingPriceUzs,
          listedAt,
          listedByTgUserId: user.tgUserId,
          ownerUsername: normalizeString(user.username),
        },
      },
      { new: true },
    ).lean();

    if (!updated) {
      const existing = await UserNft.findOne({ nftId }).lean();
      if (!existing) {
        return response.error(res, "NFT topilmadi");
      }
      if (normalizeString(existing.ownerTgUserId) !== user.tgUserId) {
        return response.error(res, "Bu NFT sizga tegishli emas");
      }
      if (normalizeString(existing.marketStatus) === "listed") {
        return response.error(res, "Bu NFT allaqachon marketplace'da sotuvda");
      }
      if (!existing.isTelegramPresent) {
        return response.error(res, "Bu NFT Telegram hisobida topilmadi");
      }
      return response.error(res, "NFT ni sotuvga qo'yib bo'lmadi");
    }

    emitUserUpdate(user.tgUserId, {
      type: "nft_listed",
      refreshNfts: true,
      nftId,
      priceUzs: listingPriceUzs,
    });

    return response.success(res, "NFT sotuvga qo'yildi", {
      nftId,
      priceUzs: listingPriceUzs,
      listedAt: updated.listedAt,
    });
  } catch (error) {
    return response.serverError(
      res,
      "NFT ni sotuvga qo'yishda xatolik",
      error.message,
    );
  }
}

async function unlistMyNft(req, res) {
  try {
    const tgUser = getTelegramUserFromRequest(req);
    if (!tgUser?.tgUserId) {
      return response.error(
        res,
        "Telegram profilingiz aniqlanmadi. Ilovani qayta ochib ko'ring.",
      );
    }

    const user = await ensureCurrentUser(tgUser);
    if (!user?.tgUserId) {
      return response.error(res, "Foydalanuvchi topilmadi");
    }
    if (user?.isBlocked) {
      return response.error(res, "Foydalanuvchi bloklangan");
    }

    const nftId = normalizeString(req.body?.nftId);
    if (!nftId) {
      return response.error(res, "nftId required");
    }

    const updated = await UserNft.findOneAndUpdate(
      {
        nftId,
        ownerTgUserId: user.tgUserId,
        marketStatus: "listed",
      },
      {
        $set: {
          marketStatus: "owned",
          listingPriceUzs: 0,
          listedAt: null,
          listedByTgUserId: "",
        },
      },
      { new: true },
    ).lean();

    if (!updated) {
      return response.error(res, "Sotuvdagi NFT topilmadi");
    }

    await cancelPendingOffersForNft(nftId, "listing_unlisted_by_seller");

    emitUserUpdate(user.tgUserId, {
      type: "nft_unlisted",
      refreshNfts: true,
      refreshNftOffers: true,
      nftId,
    });

    return response.success(res, "NFT sotuvdan olindi", {
      nftId,
    });
  } catch (error) {
    return response.serverError(
      res,
      "NFT ni sotuvdan olishda xatolik",
      error.message,
    );
  }
}

async function buyNftFromMarketplace(req, res) {
  let notifyTgUserId = "";
  let notifyNftTitle = "";
  let notifyPriceUzs = 0;
  try {
    const tgUser = getTelegramUserFromRequest(req);
    if (!tgUser?.tgUserId) {
      return response.error(
        res,
        "Telegram profilingiz aniqlanmadi. Ilovani qayta ochib ko'ring.",
      );
    }
    notifyTgUserId = normalizeString(tgUser.tgUserId);

    const failPurchase = async (message) => {
      await sendPurchaseResultBotNotify({
        tgUserId: notifyTgUserId,
        kind: "nft",
        status: "cancelled",
        title: notifyNftTitle,
        amountUzs: notifyPriceUzs,
        reason: message,
      });
      return response.error(res, message);
    };

    const buyer = await ensureCurrentUser(tgUser);
    if (!buyer?.tgUserId) {
      return failPurchase("Foydalanuvchi topilmadi");
    }
    if (buyer?.isBlocked) {
      return failPurchase("Foydalanuvchi bloklangan");
    }

    const nftId = normalizeString(req.body?.nftId);
    if (!nftId) {
      return failPurchase("nftId required");
    }

    const listing = await UserNft.findOne({
      nftId,
      marketStatus: "listed",
      isTelegramPresent: true,
    }).lean();

    if (!listing) {
      return failPurchase("NFT marketplace'da topilmadi");
    }

    notifyNftTitle = normalizeString(listing.title) || "NFT Gift";

    const sellerTgUserId = normalizeString(listing.ownerTgUserId);
    if (!sellerTgUserId) {
      return failPurchase("Sotuvchi aniqlanmadi");
    }

    if (sellerTgUserId === buyer.tgUserId) {
      return failPurchase("O'zingizning NFT'ingizni sotib olib bo'lmaydi");
    }

    const priceUzs = Math.round(toSafeNumber(listing.listingPriceUzs, 0));
    notifyPriceUzs = priceUzs;
    if (!priceUzs || priceUzs <= 0) {
      return failPurchase("Listing narxi noto'g'ri");
    }

    const [seller, marketConfig] = await Promise.all([
      User.findOne({ tgUserId: sellerTgUserId }).lean(),
      getNftMarketplaceConfig(),
    ]);

    if (!seller?.tgUserId) {
      return failPurchase("Sotuvchi topilmadi");
    }

    const feePercent = toSafeNumber(marketConfig?.feePercent, 0);
    const feeAmountUzs = Math.round((priceUzs * feePercent) / 100);
    const sellerNetUzs = Math.max(0, priceUzs - feeAmountUzs);

    const buyerAfter = await User.findOneAndUpdate(
      {
        tgUserId: buyer.tgUserId,
        balance: { $gte: priceUzs },
      },
      {
        $inc: { balance: -priceUzs },
      },
      { new: true },
    ).lean();

    if (!buyerAfter) {
      return failPurchase("Balans yetarli emas");
    }

    const soldAt = new Date();
    const transferred = await UserNft.findOneAndUpdate(
      {
        nftId,
        marketStatus: "listed",
        ownerTgUserId: sellerTgUserId,
        listingPriceUzs: priceUzs,
      },
      {
        $set: {
          ownerTgUserId: buyer.tgUserId,
          ownerUsername: normalizeString(buyer.username),
          isTelegramPresent: true,
          marketStatus: "owned",
          listingPriceUzs: 0,
          listedAt: null,
          listedByTgUserId: "",
          lastSoldAt: soldAt,
          lastSoldPriceUzs: priceUzs,
          lastSaleFeePercent: feePercent,
          lastSaleFeeAmountUzs: feeAmountUzs,
          lastSellerNetUzs: sellerNetUzs,
          lastSellerTgUserId: sellerTgUserId,
          lastBuyerTgUserId: buyer.tgUserId,
        },
      },
      { new: true },
    ).lean();

    if (!transferred) {
      await User.updateOne(
        { tgUserId: buyer.tgUserId },
        { $inc: { balance: priceUzs } },
      );
      return failPurchase(
        "NFT transfer qilindi, lekin listing holatini yakunlashda xatolik. Administratorga murojaat qiling.",
      );
    }

    const sellerAfter = await User.findOneAndUpdate(
      { tgUserId: sellerTgUserId },
      {
        $inc: { balance: sellerNetUzs },
      },
      { new: true },
    ).lean();

    if (!sellerAfter) {
      await User.updateOne({ tgUserId: buyer.tgUserId }, { $inc: { balance: priceUzs } });
      await UserNft.updateOne(
        { nftId, ownerTgUserId: buyer.tgUserId, lastSoldAt: soldAt },
        {
          $set: {
            ownerTgUserId: sellerTgUserId,
            ownerUsername: normalizeString(listing.ownerUsername),
            marketStatus: "listed",
            listingPriceUzs: priceUzs,
            listedAt: listing.listedAt || soldAt,
            listedByTgUserId: sellerTgUserId,
          },
        },
      );
      await sendPurchaseResultBotNotify({
        tgUserId: notifyTgUserId,
        kind: "nft",
        status: "cancelled",
        title: notifyNftTitle,
        amountUzs: notifyPriceUzs,
        reason: "Sotuvchini balansini yangilab bo'lmadi",
      });
      return response.serverError(res, "Sotuvchini balansini yangilab bo'lmadi");
    }

    await cancelPendingOffersForNft(nftId, "listing_sold");

    emitUserUpdate(buyer.tgUserId, {
      type: "nft_bought",
      refreshBalance: true,
      refreshNfts: true,
      refreshNftOffers: true,
      nftId,
      priceUzs,
    });

    emitUserUpdate(sellerTgUserId, {
      type: "nft_sold",
      refreshBalance: true,
      refreshNfts: true,
      refreshNftOffers: true,
      nftId,
      priceUzs,
      sellerNetUzs,
    });

    await sendPurchaseResultBotNotify({
      tgUserId: notifyTgUserId,
      kind: "nft",
      status: "success",
      title: notifyNftTitle,
      amountUzs: notifyPriceUzs,
    });

    const transferredTitle = splitNftTitleAndNumber(transferred.title);
    return response.success(res, "NFT sotib olindi", {
      nftId,
      title: transferredTitle.title || "NFT Gift",
      nftNumber: Math.trunc(
        toSafeNumber(
          transferred.nftNumber,
          transferredTitle.nftNumber,
        ),
      ),
      priceUzs,
      feePercent,
      feeAmountUzs,
      sellerNetUzs,
      buyerBalance: toSafeNumber(buyerAfter.balance, 0),
      telegramTransferred: false,
      transferPending: true,
    });
  } catch (error) {
    await sendPurchaseResultBotNotify({
      tgUserId: notifyTgUserId,
      kind: "nft",
      status: "cancelled",
      title: notifyNftTitle,
      amountUzs: notifyPriceUzs,
      reason: normalizeString(error?.message) || "Server xatoligi",
    });
    return response.serverError(
        res,
      "NFT sotib olishda xatolik",
      error.message,
    );
  }
}

async function withdrawMyNft(req, res) {
  try {
    const tgUser = getTelegramUserFromRequest(req);
    if (!tgUser?.tgUserId) {
      return response.error(
        res,
        "Telegram profilingiz aniqlanmadi. Ilovani qayta ochib ko'ring.",
      );
    }

    const user = await ensureCurrentUser(tgUser);
    if (!user?.tgUserId) {
      return response.error(res, "Foydalanuvchi topilmadi");
    }
    if (user?.isBlocked) {
      return response.error(res, "Foydalanuvchi bloklangan");
    }

    const nftId = normalizeString(req.body?.nftId);
    if (!nftId) {
      return response.error(res, "nftId required");
    }

    // Avval NFT ni atomik ravishda "owned" holatiga qaytaramiz,
    // shunda listed bo'lsa marketplace'dan darhol chiqadi va race bo'lmaydi.
    const nft = await UserNft.findOneAndUpdate(
      {
        nftId,
        ownerTgUserId: user.tgUserId,
        isTelegramPresent: true,
        marketStatus: { $in: ["owned", "listed"] },
      },
      {
        $set: {
          marketStatus: "owned",
          listingPriceUzs: 0,
          listedAt: null,
          listedByTgUserId: "",
        },
      },
      { new: false },
    ).lean();

    if (!nft) {
      return response.error(res, "NFT topilmadi yoki allaqachon yechib olingan");
    }
    const wasListed = normalizeString(nft.marketStatus) === "listed";
    const restoreListedState = async () => {
      if (!wasListed) return;
      await UserNft.updateOne(
        {
          nftId,
          ownerTgUserId: user.tgUserId,
          isTelegramPresent: true,
        },
        {
          $set: {
            marketStatus: "listed",
            listingPriceUzs: toSafeNumber(nft.listingPriceUzs, 0),
            listedAt: nft.listedAt || null,
            listedByTgUserId:
              normalizeString(nft.listedByTgUserId) || user.tgUserId,
          },
        },
      );
    };

    const initialTransferLock = getNftTransferLockPayload(nft?.canTransferAt);
    if (initialTransferLock?.secondsLeft) {
      await restoreListedState();
      return response.error(
        res,
        buildTransferTooEarlyMessage(initialTransferLock),
        initialTransferLock,
      );
    }

    const marketConfig = await getNftMarketplaceConfig();
    const withdrawFeeUzs = Math.max(
      0,
      Math.round(toSafeNumber(marketConfig?.withdrawFeeUzs, 0)),
    );

    let updatedUser = null;
    if (withdrawFeeUzs > 0) {
      updatedUser = await User.findOneAndUpdate(
        {
          tgUserId: user.tgUserId,
          balance: { $gte: withdrawFeeUzs },
        },
        {
          $inc: { balance: -withdrawFeeUzs },
        },
        { new: true },
      ).lean();

      if (!updatedUser) {
        await restoreListedState();
        return response.error(
          res,
          "Balans yetarli emas. NFT yechib olish uchun " +
            withdrawFeeUzs.toLocaleString("uz-UZ") +
            " UZS kerak",
        );
      }
    }

    const transferMsgId = Math.trunc(toSafeNumber(nft?.sourceMsgId, 0));
    if (!transferMsgId || transferMsgId <= 0) {
      if (withdrawFeeUzs > 0) {
        await User.updateOne(
          { tgUserId: user.tgUserId },
          { $inc: { balance: withdrawFeeUzs } },
        );
      }
      await restoreListedState();
      return response.error(res, "NFT transfer manbasi topilmadi");
    }

    const recipientIdentifier =
      normalizeString(user?.username) || normalizeString(user?.tgUserId);

    try {
      await transferSavedStarGiftToRecipient({
        msgId: transferMsgId,
        recipientIdentifier,
      });
    } catch (transferError) {
      if (isGiftServiceLowStarsError(transferError)) {
        await notifyAdminsAboutGiftServiceLowStars({
          action: "nft_withdraw",
          user,
          recipientIdentifier,
          nft,
          error: transferError,
        });
      }

      if (withdrawFeeUzs > 0) {
        await User.updateOne(
          { tgUserId: user.tgUserId },
          { $inc: { balance: withdrawFeeUzs } },
        );
      }
      await restoreListedState();

      const tooEarlySeconds = getTransferTooEarlySeconds(transferError);
      if (tooEarlySeconds > 0) {
        const canTransferAtDate = new Date(Date.now() + tooEarlySeconds * 1000);
        await UserNft.updateOne(
          { nftId, ownerTgUserId: user.tgUserId },
          { $set: { canTransferAt: canTransferAtDate } },
        );

        const lockPayload =
          getNftTransferLockPayload(canTransferAtDate) || {
            code: "NFT_TRANSFER_TOO_EARLY",
            canTransferAt: canTransferAtDate.toISOString(),
            secondsLeft: tooEarlySeconds,
            remainingLabel: formatRemainingSeconds(tooEarlySeconds),
          };

        return response.error(
          res,
          buildTransferTooEarlyMessage(lockPayload),
          lockPayload,
        );
      }

      return response.error(res, mapSendGiftError(transferError));
    }

    const now = new Date();
    await UserNft.updateOne(
      {
        nftId,
        ownerTgUserId: user.tgUserId,
      },
      {
        $set: {
          isTelegramPresent: false,
          marketStatus: "owned",
          listingPriceUzs: 0,
          listedAt: null,
          listedByTgUserId: "",
          withdrawnAt: now,
          withdrawnTo: recipientIdentifier,
          canTransferAt: null,
        },
      },
    );

    await cancelPendingOffersForNft(nftId, "listing_withdrawn");

    emitUserUpdate(user.tgUserId, {
      type: "nft_withdrawn",
      refreshBalance: true,
      refreshNfts: true,
      refreshNftOffers: true,
      nftId,
      recipient: recipientIdentifier,
    });

    const withdrawnTitle = splitNftTitleAndNumber(nft.title);

    return response.success(res, "NFT Telegram profilingizga yuborildi", {
      nftId,
      title: withdrawnTitle.title || "NFT Gift",
      nftNumber: Math.trunc(
        toSafeNumber(nft.nftNumber, withdrawnTitle.nftNumber),
      ),
      recipientIdentifier,
      withdrawnAt: now.toISOString(),
      telegramTransferred: true,
      withdrawFeeUzs,
      balance: toSafeNumber(updatedUser?.balance, toSafeNumber(user?.balance, 0)),
    });
  } catch (error) {
    return response.serverError(
      res,
      "NFT ni yechib olishda xatolik",
      error.message,
    );
  }
}

async function purchaseGift(req, res) {
  let notifyTgUserId = "";
  let notifyGiftTitle = "";
  let notifyPriceUzs = 0;
  try {
    const tgUser = getTelegramUserFromRequest(req);
    if (!tgUser?.tgUserId) {
      return response.error(
        res,
        "Telegram profilingiz aniqlanmadi. Ilovani qayta ochib ko'ring.",
      );
    }
    notifyTgUserId = normalizeString(tgUser.tgUserId);

    const failPurchase = async (message) => {
      await sendPurchaseResultBotNotify({
        tgUserId: notifyTgUserId,
        kind: "gift",
        status: "cancelled",
        title: notifyGiftTitle,
        amountUzs: notifyPriceUzs,
        reason: message,
      });
      return response.error(res, message);
    };

    const giftId = normalizeGiftId(req.body?.giftId);
    if (!giftId) {
      return failPurchase("giftId required");
    }

    const user = await ensureCurrentUser(tgUser);
    if (!user?.tgUserId) {
      return failPurchase("Foydalanuvchi topilmadi");
    }
    if (user?.isBlocked) {
      return failPurchase("Foydalanuvchi bloklangan");
    }

    const [pricing, gift] = await Promise.all([
      getStarPricing(),
      getGiftById(giftId, { includeSoldOut: false }),
    ]);

    if (!gift) {
      return failPurchase("Gift topilmadi yoki hozircha available emas");
    }
    notifyGiftTitle = normalizeString(gift.title) || "Gift";

    const { stars, priceUzs } = resolveGiftPrice(gift, pricing?.pricePerStar);
    notifyPriceUzs = priceUzs;
    if (!priceUzs || priceUzs <= 0) {
      return failPurchase("Gift narxini aniqlab bo'lmadi");
    }

    const updatedUser = await User.findOneAndUpdate(
      {
        tgUserId: user.tgUserId,
        balance: { $gte: priceUzs },
      },
      {
        $inc: { balance: -priceUzs },
      },
      { new: true },
    ).lean();

    if (!updatedUser) {
      return failPurchase("Balans yetarli emas");
    }

    let createdGift;
    try {
      createdGift = await UserGift.create({
        tgUserId: user.tgUserId,
        tgUsername: normalizeString(tgUser.username),
        giftId,
        stars,
        priceUzs,
        emoji: normalizeString(gift.emoji) || "🎁",
        title: normalizeString(gift.title) || "Gift",
      });
    } catch (error) {
      await User.updateOne({ tgUserId: user.tgUserId }, { $inc: { balance: priceUzs } });
      throw error;
    }

    emitUserUpdate(user.tgUserId, {
      type: "gift_purchased",
      refreshBalance: true,
      refreshGifts: true,
      giftId,
      stars,
      priceUzs,
    });

    await sendPurchaseResultBotNotify({
      tgUserId: notifyTgUserId,
      kind: "gift",
      status: "success",
      title: notifyGiftTitle,
      amountUzs: notifyPriceUzs,
    });

    return response.created(res, "Gift sotib olindi", {
      userGiftId: String(createdGift._id),
      giftId,
      title: normalizeString(gift.title) || "Gift",
      emoji: normalizeString(gift.emoji) || "🎁",
      stars,
      priceUzs,
      balance: toSafeNumber(updatedUser.balance, 0),
    });
  } catch (error) {
    await sendPurchaseResultBotNotify({
      tgUserId: notifyTgUserId,
      kind: "gift",
      status: "cancelled",
      title: notifyGiftTitle,
      amountUzs: notifyPriceUzs,
      reason: normalizeString(error?.message) || "Server xatoligi",
    });
    return response.serverError(
      res,
      "Gift sotib olishda xatolik",
      error.message,
    );
  }
}

async function sendGift(req, res) {
  try {
    const tgUser = getTelegramUserFromRequest(req);
    if (!tgUser?.tgUserId) {
      return response.error(
        res,
        "Telegram profilingiz aniqlanmadi. Ilovani qayta ochib ko'ring.",
      );
    }

    const user = await ensureCurrentUser(tgUser);
    if (!user?.tgUserId) {
      return response.error(res, "Foydalanuvchi topilmadi");
    }
    if (user?.isBlocked) {
      return response.error(res, "Foydalanuvchi bloklangan");
    }

    const userGiftId = normalizeString(req.body?.userGiftId);
    if (!userGiftId) {
      return response.error(res, "userGiftId required");
    }

    const target = normalizeString(req.body?.target).toLowerCase() === "friend" ? "friend" : "self";
    const recipientRaw = normalizeString(req.body?.recipient);
    const selfRecipient = normalizeRecipient(
      normalizeString(user?.username) || normalizeString(user?.tgUserId),
    );
    const recipient = target === "friend" ? normalizeRecipient(recipientRaw) : selfRecipient;

    if (!recipient) {
      return response.error(res, "Qabul qiluvchi username yoki tgUserId kiriting");
    }

    const ownedGift = await UserGift.findOne({
      _id: userGiftId,
      tgUserId: user.tgUserId,
      status: "owned",
    }).lean();

    if (!ownedGift) {
      return response.error(res, "Gift topilmadi");
    }

    try {
      await sendStarGiftToRecipient({
        giftId: ownedGift.giftId,
        recipientIdentifier: recipient,
        hideName: true,
      });
    } catch (sendError) {
      if (isGiftServiceLowStarsError(sendError)) {
        await notifyAdminsAboutGiftServiceLowStars({
          action: "gift_send",
          user,
          recipientIdentifier: recipient,
          gift: ownedGift,
          error: sendError,
        });
      }

      return response.error(res, mapSendGiftError(sendError));
    }

    await UserGift.updateOne(
      { _id: ownedGift._id, status: "owned" },
      {
        $set: {
          status: "sent",
          sentToType: target,
          sentToValue: recipient,
          sentToResolved: recipient,
          sentAt: new Date(),
        },
      },
    );

    emitUserUpdate(user.tgUserId, {
      type: "gift_sent",
      refreshGifts: true,
      giftId: ownedGift.giftId,
      target,
      recipient,
    });

    return response.success(res, "Gift yuborildi", {
      userGiftId,
      giftId: normalizeGiftId(ownedGift.giftId),
      target,
      recipient,
    });
  } catch (error) {
    return response.serverError(
      res,
      "Gift yuborishda xatolik",
      error.message,
    );
  }
}

module.exports = {
  getGiftCatalog,
  getGiftImage,
  getNftImage,
  getNftPattern,
  getMyGifts,
  getMyNftGifts,
  getNftMarketplace,
  getIncomingNftOffers,
  getMySentNftOffers,
  createNftOffer,
  acceptNftOffer,
  rejectNftOffer,
  cancelMyNftOffer,
  listMyNftForSale,
  unlistMyNft,
  buyNftFromMarketplace,
  withdrawMyNft,
  purchaseGift,
  sendGift,
};

