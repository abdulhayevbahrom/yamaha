require("dotenv").config();

const mongoose = require("mongoose");
const connectDB = require("../config/dbConfig");
const { getTelegramCredentials } = require("../config/telegram-credentials");
const Order = require("../model/order.model");
const PaymentCard = require("../model/payment-card.model");
const PaymentLog = require("../model/payment-log.model");
const PaymentAmountReservation = require("../model/payment-amount-reservation.model");
const SecurityNonce = require("../model/security-nonce.model");
const SecurityRateLimit = require("../model/security-rate-limit.model");
const User = require("../model/user.model");
const Plan = require("../model/plan.model");

function normalize(value) {
  return String(value || "").trim();
}

function isEnabled(value) {
  return ["1", "true", "yes", "on"].includes(normalize(value).toLowerCase());
}

function hasAny(keys) {
  return keys.some((key) => normalize(process.env[key]));
}

function validateUrl(name, value, errors) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:") {
      errors.push(`${name} HTTPS manzil bo'lishi kerak`);
    }
  } catch (_) {
    errors.push(`${name} URL formati noto'g'ri`);
  }
}

async function run() {
  const errors = [];
  const warnings = [];
  const required = [
    "MONGO_URI",
    "BOT_TOKEN",
    "WEB_APP_URL",
    "JWT_SECRET_KEY",
    "ADMIN_LOGIN",
    "ADMIN_PASSWORD_HASH",
    "FRAGMENT_API_KEY",
  ];

  if (isEnabled(process.env.GW_PUBG_AUTOBUY_ENABLED)) {
    if (!normalize(process.env.GW_API_KEY)) {
      errors.push("GW_PUBG_AUTOBUY_ENABLED=true, lekin GW_API_KEY topilmadi");
    }
    const gwApiUrl =
      normalize(process.env.GW_API_URL) || "https://api.sonofutred.com";
    validateUrl("GW_API_URL", gwApiUrl, errors);
    const catalogMaxAge = Number(
      process.env.GW_PUBG_CATALOG_MAX_AGE_MS || 30 * 60_000,
    );
    const syncInterval = Number(
      process.env.GW_PUBG_CATALOG_SYNC_INTERVAL_MS || 5 * 60_000,
    );
    if (!Number.isFinite(catalogMaxAge) || catalogMaxAge < 60_000) {
      errors.push("GW_PUBG_CATALOG_MAX_AGE_MS kamida 60000 bo'lishi kerak");
    }
    if (!Number.isFinite(syncInterval) || syncInterval < 60_000) {
      errors.push("GW_PUBG_CATALOG_SYNC_INTERVAL_MS kamida 60000 bo'lishi kerak");
    }
    if (syncInterval >= catalogMaxAge) {
      errors.push(
        "GW katalog sync intervali katalog maksimal yoshidan kichik bo'lishi kerak",
      );
    }
  }

  if (isEnabled(process.env.GW_MLBB_AUTOBUY_ENABLED)) {
    if (!normalize(process.env.GW_API_KEY)) errors.push("GW_MLBB_AUTOBUY_ENABLED=true, lekin GW_API_KEY topilmadi");
    const maxAge = Number(process.env.GW_MLBB_CATALOG_MAX_AGE_MS || 30 * 60_000);
    const syncInterval = Number(process.env.GW_MLBB_CATALOG_SYNC_INTERVAL_MS || 5 * 60_000);
    if (!Number.isFinite(maxAge) || maxAge < 60_000) errors.push("GW_MLBB_CATALOG_MAX_AGE_MS kamida 60000 bo'lishi kerak");
    if (!Number.isFinite(syncInterval) || syncInterval < 60_000) errors.push("GW_MLBB_CATALOG_SYNC_INTERVAL_MS kamida 60000 bo'lishi kerak");
  }

  if (normalize(process.env.NODE_ENV).toLowerCase() !== "production") {
    errors.push("NODE_ENV=production bo'lishi kerak");
  }

  for (const key of required) {
    if (!normalize(process.env[key])) {
      errors.push(`${key} topilmadi`);
    }
  }

  if (
    !hasAny(["ADMIN_ALLOWED_TG_IDS", "ADMIN_NOTIFY_CHAT_ID"])
  ) {
    errors.push("ADMIN_ALLOWED_TG_IDS yoki ADMIN_NOTIFY_CHAT_ID topilmadi");
  }

  const jwtSecret = normalize(process.env.JWT_SECRET_KEY);
  if (jwtSecret && jwtSecret.length < 32) {
    errors.push("JWT_SECRET_KEY kamida 32 ta belgidan iborat bo'lishi kerak");
  }

  const adminPasswordHash = normalize(process.env.ADMIN_PASSWORD_HASH);
  if (adminPasswordHash && !/^\$2[aby]\$\d{2}\$/.test(adminPasswordHash)) {
    errors.push("ADMIN_PASSWORD_HASH bcrypt hash bo'lishi kerak");
  }

  const webAppUrl = normalize(process.env.WEB_APP_URL);
  if (webAppUrl) validateUrl("WEB_APP_URL", webAppUrl, errors);

  const cardxabar = getTelegramCredentials("cardxabar");
  if (!cardxabar.apiId) errors.push("CardXabar Telegram API ID topilmadi");
  if (!cardxabar.apiHash) errors.push("CardXabar Telegram API hash topilmadi");
  if (!cardxabar.sessionString) {
    errors.push("CardXabar Telegram session topilmadi");
  }

  const cardxabarChatId = normalize(process.env.CARDXABAR_CHAT_ID);
  if (!cardxabarChatId || !/^-?\d+$/.test(cardxabarChatId)) {
    errors.push("CARDXABAR_CHAT_ID aniq Telegram chat ID bo'lishi kerak");
  }

  const gift = getTelegramCredentials("gift");
  if (!gift.apiId) errors.push("Gift/NFT Telegram API ID topilmadi");
  if (!gift.apiHash) errors.push("Gift/NFT Telegram API hash topilmadi");
  if (!gift.sessionString) errors.push("Gift/NFT Telegram session topilmadi");
  if (
    cardxabar.sessionString &&
    gift.sessionString &&
    cardxabar.sessionString === gift.sessionString
  ) {
    warnings.push(
      "CardXabar va Gift/NFT bir Telegram sessiondan foydalanmoqda; alohida session tavsiya qilinadi",
    );
  }

  if (isEnabled(process.env.TURNSTILE_ENABLED)) {
    if (!normalize(process.env.TURNSTILE_SECRET_KEY)) {
      errors.push("TURNSTILE_ENABLED=true, lekin TURNSTILE_SECRET_KEY topilmadi");
    }
    if (!normalize(process.env.TURNSTILE_ALLOWED_HOSTNAMES)) {
      errors.push(
        "TURNSTILE_ENABLED=true, lekin TURNSTILE_ALLOWED_HOSTNAMES topilmadi",
      );
    }
  } else {
    warnings.push("Cloudflare Turnstile hozir o'chirilgan");
  }

  if (!normalize(process.env.TRUST_PROXY)) {
    warnings.push(
      "TRUST_PROXY=false ishlatiladi; reverse proxy IP aniqlashi kerak bo'lsa aniq sozlang",
    );
  }

  if (errors.length) {
    throw new Error(errors.join("\n"));
  }

  await connectDB();
  try {
    await Promise.all([
      Order.init(),
      PaymentCard.init(),
      PaymentLog.init(),
      PaymentAmountReservation.init(),
      SecurityNonce.init(),
      SecurityRateLimit.init(),
      User.init(),
      Plan.init(),
    ]);

    const [purchaseCards, topupCards] = await Promise.all([
      PaymentCard.countDocuments({ type: "purchase", isActive: true }),
      PaymentCard.countDocuments({ type: "balance_topup", isActive: true }),
    ]);

    const envFallbackEnabled = isEnabled(
      process.env.ALLOW_PAYMENT_CARD_ENV_FALLBACK,
    );
    const purchaseFallback =
      envFallbackEnabled &&
      normalize(process.env.PURCHASE_FALLBACK_CARD_NUMBER) &&
      normalize(process.env.PURCHASE_FALLBACK_CARD_HOLDER);
    const topupFallback =
      envFallbackEnabled &&
      normalize(process.env.TOPUP_FALLBACK_CARD_NUMBER) &&
      normalize(process.env.TOPUP_FALLBACK_CARD_HOLDER);

    if (!purchaseCards && !purchaseFallback) {
      errors.push("Aktiv purchase to'lov kartasi topilmadi");
    }
    if (!topupCards && !topupFallback) {
      errors.push("Aktiv balance_topup kartasi topilmadi");
    }
  } finally {
    await mongoose.disconnect();
  }

  if (errors.length) {
    throw new Error(errors.join("\n"));
  }

  for (const warning of warnings) {
    console.warn(`OGOHLANTIRISH: ${warning}`);
  }
  console.log("Production preflight muvaffaqiyatli yakunlandi.");
}

run().catch(async (error) => {
  console.error("Production preflight xatolari:");
  console.error(error?.message || error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
