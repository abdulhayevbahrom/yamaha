const User = require("../model/user.model");
const Order = require("../model/order.model");
const ReferralEarning = require("../model/referral-earning.model");
const { emitUserUpdate } = require("../socket");
const { getReferralConfig } = require("./settings.service");

const ELIGIBLE_REFERRAL_PRODUCTS = new Set([
  "star",
  "premium",
  "uc",
  "freefire",
  "mlbb",
]);

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeUsername(value) {
  return normalizeString(value).replace(/^@+/, "");
}

function normalizeProfileName(value) {
  let name = normalizeString(value);
  if (!name) return "";

  try {
    name = name.normalize("NFKC");
  } catch (_) {
    // ignore normalization failure
  }

  name = name
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, "")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (name.length > 64) {
    name = name.slice(0, 64).trim();
  }

  return name;
}

function generateReferralCode(tgUserId) {
  const raw = normalizeString(tgUserId);
  if (!raw) return "";

  if (/^\d+$/.test(raw)) {
    return `u${BigInt(raw).toString(36)}`;
  }

  const compact = raw.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  return compact ? `u${compact.slice(0, 20)}` : "";
}

function parseReferralPayload(startPayload) {
  const payload = normalizeString(startPayload);
  if (!payload) return "";

  const match = payload.match(/^ref[_:=-]?(.+)$/i);
  return normalizeString(match?.[1] || "");
}

function buildReferralLink(referralCode) {
  const code = normalizeString(referralCode);
  if (!code) return "";

  const payload = `ref_${code}`;
  const botUsername = normalizeUsername(process.env.BOT_USERNAME);
  if (botUsername) {
    return `https://t.me/${botUsername}?start=${payload}`;
  }

  const botLink = normalizeString(process.env.BOT_LINK);
  if (!botLink) return "";

  if (botLink.includes("{payload}")) {
    return botLink.replaceAll("{payload}", payload);
  }
  if (botLink.includes("{code}")) {
    return botLink.replaceAll("{code}", code);
  }
  if (/start=/.test(botLink)) {
    return botLink;
  }

  const separator = botLink.includes("?") ? "&" : "?";
  return `${botLink}${separator}start=${payload}`;
}

async function ensureReferralIdentity({ tgUserId, username = "", profileName = "" }) {
  const normalizedUserId = normalizeString(tgUserId);
  if (!normalizedUserId) return null;

  const normalizedUsername = normalizeUsername(username);
  const normalizedProfileName = normalizeProfileName(profileName);
  const generatedCode = generateReferralCode(normalizedUserId);
  const setPayload = {
    username: normalizedUsername,
  };
  if (normalizedProfileName) {
    setPayload.profileName = normalizedProfileName;
  }

  let user = await User.findOneAndUpdate(
    { tgUserId: normalizedUserId },
    {
      $set: setPayload,
      $setOnInsert: {
        referralCode: generatedCode,
      },
    },
    { upsert: true, new: true },
  ).lean();

  if (!user?.referralCode && generatedCode) {
    user = await User.findOneAndUpdate(
      { tgUserId: normalizedUserId },
      { $set: { referralCode: generatedCode } },
      { new: true },
    ).lean();
  }

  return user;
}

async function bindReferralFromStart({
  tgUserId,
  username = "",
  profileName = "",
  startPayload = "",
}) {
  const user = await ensureReferralIdentity({ tgUserId, username, profileName });
  if (!user?.tgUserId) return null;

  const referralCode = parseReferralPayload(startPayload);
  if (!referralCode) return user;
  if (normalizeString(user.referredByUserId)) return user;
  if (normalizeString(user.referralCode).toLowerCase() === referralCode.toLowerCase()) {
    return user;
  }

  const referrer = await User.findOne({
    referralCode,
    tgUserId: { $ne: user.tgUserId },
  }).lean();

  if (!referrer?.tgUserId) return user;

  return User.findOneAndUpdate(
    {
      tgUserId: user.tgUserId,
      $or: [
        { referredByUserId: { $exists: false } },
        { referredByUserId: null },
        { referredByUserId: "" },
      ],
    },
    {
      $set: {
        referredByUserId: referrer.tgUserId,
        referredByCode: referrer.referralCode || referralCode,
        referredAt: new Date(),
        username: normalizeUsername(username) || user.username || "",
        ...(normalizeProfileName(profileName)
          ? { profileName: normalizeProfileName(profileName) }
          : {}),
      },
    },
    { new: true },
  ).lean();
}

async function activateReferralOnMiniAppOpen({
  tgUserId,
  username = "",
  profileName = "",
}) {
  const user = await ensureReferralIdentity({
    tgUserId,
    username,
    profileName,
  });
  if (!user?.tgUserId) return null;
  if (!normalizeString(user.referredByUserId)) return user;
  if (user.referralActivatedAt) return user;

  const config = await getReferralConfig();
  const activationTime = new Date();
  const signupBonusAmount = Math.max(0, Math.round(Number(config.signupBonusAmount || 0)));

  const activatedUser = await User.findOneAndUpdate(
    {
      tgUserId: user.tgUserId,
      $or: [
        { referralActivatedAt: { $exists: false } },
        { referralActivatedAt: null },
      ],
    },
    {
      $set: {
        referralActivatedAt: activationTime,
        ...(signupBonusAmount > 0
          ? { referralSignupBonusGrantedAt: activationTime }
          : {}),
      },
    },
    { new: true },
  );

  if (!activatedUser?.tgUserId) {
    return User.findOne({ tgUserId: user.tgUserId }).lean();
  }

  if (signupBonusAmount <= 0) {
    return activatedUser;
  }

  const referrer = await User.findOne({
    tgUserId: user.referredByUserId,
  }).lean();
  if (!referrer?.tgUserId || referrer.tgUserId === user.tgUserId) {
    return User.findOne({ tgUserId: user.tgUserId }).lean();
  }

  try {
    await ReferralEarning.create({
      uniqueKey: `signup:${user.tgUserId}`,
      type: "signup_bonus",
      referrerTgUserId: referrer.tgUserId,
      referrerUsername: referrer.username || "",
      referredTgUserId: user.tgUserId,
      referredUsername: user.username || normalizeUsername(username) || "",
      amount: signupBonusAmount,
      note: "Mini app first open bonus",
    });
  } catch (error) {
    if (error?.code !== 11000) {
      throw error;
    }
    return activatedUser;
  }

  await User.updateOne(
    { tgUserId: referrer.tgUserId },
    {
      $inc: {
        balance: signupBonusAmount,
        referralEarningsTotal: signupBonusAmount,
        referralSignupBonusTotal: signupBonusAmount,
      },
    },
  );

  emitUserUpdate(referrer.tgUserId, {
    type: "referral_signup_bonus",
    refreshBalance: true,
    refreshReferral: true,
    amount: signupBonusAmount,
    referredUserId: user.tgUserId,
    referredUsername: user.username || "",
  });

  return activatedUser;
}

async function awardReferralCommissionForOrder(orderOrId) {
  const order =
    typeof orderOrId === "object" && orderOrId?._id
      ? orderOrId
      : await Order.findById(orderOrId).lean();

  if (!order?._id || !ELIGIBLE_REFERRAL_PRODUCTS.has(order.product)) {
    return { ok: false, skipped: true, reason: "unsupported_order" };
  }

  const referredUser = await User.findOne({ tgUserId: order.tgUserId }).lean();
  if (!referredUser?.referredByUserId) {
    return { ok: false, skipped: true, reason: "no_referrer" };
  }

  const referrer = await User.findOne({
    tgUserId: referredUser.referredByUserId,
  }).lean();
  if (!referrer?.tgUserId || referrer.tgUserId === referredUser.tgUserId) {
    return { ok: false, skipped: true, reason: "invalid_referrer" };
  }

  const config = await getReferralConfig();
  const percent = Number(config.orderPercent || 0);
  if (!Number.isFinite(percent) || percent <= 0) {
    return { ok: false, skipped: true, reason: "zero_percent" };
  }

  const sourceAmount = Number(order.paidAmount || order.expectedAmount || 0);
  const commissionAmount = Math.max(
    0,
    Math.round((sourceAmount * percent) / 100),
  );
  if (commissionAmount <= 0) {
    return { ok: false, skipped: true, reason: "zero_amount" };
  }

  try {
    await ReferralEarning.create({
      uniqueKey: `order:${order._id}`,
      type: "order_commission",
      referrerTgUserId: referrer.tgUserId,
      referrerUsername: referrer.username || "",
      referredTgUserId: referredUser.tgUserId,
      referredUsername: referredUser.username || order.tgUsername || "",
      orderId: order._id,
      sourceProduct: order.product,
      sourceAmount,
      percent,
      amount: commissionAmount,
    });
  } catch (error) {
    if (error?.code === 11000) {
      return { ok: true, duplicate: true };
    }
    throw error;
  }

  await Promise.all([
    User.updateOne(
      { tgUserId: referrer.tgUserId },
      {
        $inc: {
          balance: commissionAmount,
          referralEarningsTotal: commissionAmount,
          referralOrderCommissionTotal: commissionAmount,
        },
      },
    ),
    Order.findByIdAndUpdate(order._id, {
      referralCommissionAmount: commissionAmount,
      referralCommissionPercent: percent,
      referralCommissionAwardedAt: new Date(),
      referralReferrerUserId: referrer.tgUserId,
    }),
  ]);

  emitUserUpdate(referrer.tgUserId, {
    type: "referral_commission_received",
    refreshBalance: true,
    refreshReferral: true,
    amount: commissionAmount,
    referredUserId: referredUser.tgUserId,
    referredUsername: referredUser.username || "",
    product: order.product,
    orderId: order._id,
  });

  return {
    ok: true,
    amount: commissionAmount,
    percent,
    referrerTgUserId: referrer.tgUserId,
  };
}

module.exports = {
  buildReferralLink,
  bindReferralFromStart,
  ensureReferralIdentity,
  activateReferralOnMiniAppOpen,
  awardReferralCommissionForOrder,
  generateReferralCode,
};
