const User = require("../model/user.model");
const Order = require("../model/order.model");
const ReferralEarning = require("../model/referral-earning.model");
const { emitUserUpdate } = require("../socket");
const {
  getReferralConfig,
  getReferralRewardConfig,
} = require("./settings.service");
const { getForceJoin } = require("./settings.service");
const { sendTelegramText } = require("./telegram-notify.service");
const { emitAdminUpdate } = require("../socket");
const { checkForceJoinMembership } = require("./force-join.service");

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

function buildTelegramProfileUrl({ tgUserId = "", username = "" }) {
  const normalizedUsername = normalizeUsername(username);
  if (normalizedUsername) {
    return `https://t.me/${encodeURIComponent(normalizedUsername)}`;
  }

  const normalizedUserId = normalizeString(tgUserId);
  if (!normalizedUserId) return "";
  return `tg://user?id=${encodeURIComponent(normalizedUserId)}`;
}

function parseIdList(rawValue) {
  return String(rawValue || "")
    .split(",")
    .map((id) => normalizeString(id))
    .filter(Boolean);
}

function getAdminAlertRecipientIds() {
  const allowlist = parseIdList(process.env.ADMIN_ALLOWED_TG_IDS);
  const notifyList = parseIdList(process.env.ADMIN_NOTIFY_CHAT_ID);

  if (allowlist.length > 0) {
    if (notifyList.length > 0) {
      return notifyList.filter((id) => allowlist.includes(id));
    }
    return allowlist;
  }

  return notifyList;
}

function buildInlineKeyboardFromUsers(users = []) {
  const buttons = [];
  for (const user of users) {
    const text = normalizeString(user?.username)
      ? `@${normalizeUsername(user.username)}`
      : normalizeString(user?.tgUserId) || "Profile";
    const url = buildTelegramProfileUrl(user);
    if (!url) continue;
    buttons.push([{ text, url }]);
  }
  return buttons;
}

function normalizeRewardActiveFrom(value) {
  const parsed = value ? new Date(value) : null;
  return parsed && Number.isFinite(parsed.getTime()) ? parsed : null;
}

function buildRewardQualifyingFilter(referrerTgUserId, activeFrom) {
  const filter = {
    referredByUserId: referrerTgUserId,
    referralActivatedAt: { $ne: null },
    isBlocked: { $ne: true },
  };

  if (activeFrom) {
    filter.$or = [
      { referredAt: { $gte: activeFrom } },
      {
        referredAt: null,
        createdAt: { $gte: activeFrom },
      },
      {
        referredAt: { $exists: false },
        createdAt: { $gte: activeFrom },
      },
    ];
  }

  return filter;
}

async function filterForceJoinQualifiedUsers(users = []) {
  const list = Array.isArray(users) ? users.filter((item) => item?.tgUserId) : [];
  if (!list.length) return [];

  const forceJoin = await getForceJoin();
  if (!forceJoin.enabled || !String(forceJoin.channelId || "").trim()) {
    return list;
  }

  const membershipResults = await Promise.allSettled(
    list.map((user) => checkForceJoinMembership(user.tgUserId, forceJoin)),
  );

  return list.filter((user, index) => {
    const result = membershipResults[index];
    return Boolean(result?.status === "fulfilled" && result.value?.canProceed);
  });
}

async function getQualifiedReferralUsers(referrerTgUserId, activeFrom = null) {
  const users = await User.find(
    buildRewardQualifyingFilter(referrerTgUserId, activeFrom),
  )
    .sort({ referralActivatedAt: -1, createdAt: -1 })
    .select({
      tgUserId: 1,
      username: 1,
      profileName: 1,
      referredAt: 1,
      referralActivatedAt: 1,
      createdAt: 1,
    })
    .lean();

  return filterForceJoinQualifiedUsers(users);
}

async function maybeNotifyReferralMilestone(referrerOrId) {
  const referrerTgUserId =
    typeof referrerOrId === "object" && referrerOrId?.tgUserId
      ? normalizeString(referrerOrId.tgUserId)
      : normalizeString(referrerOrId);

  if (!referrerTgUserId) {
    return { ok: false, skipped: true, reason: "missing_referrer" };
  }

  const rewardConfig = await getReferralRewardConfig();
  const inviteThreshold = Math.max(
    1,
    Math.floor(Number(rewardConfig?.inviteThreshold || 50)),
  );
  const rewardLabel = String(rewardConfig?.rewardLabel || "Telegram Premium").trim();
  const campaignId = String(
    rewardConfig?.campaignId || "referral_reward_default",
  ).trim();
  const activeFrom = normalizeRewardActiveFrom(rewardConfig?.activeFrom);

  const qualifyingUsers = await getQualifiedReferralUsers(
    referrerTgUserId,
    activeFrom,
  );
  const qualifyingCount = qualifyingUsers.length;

  if (qualifyingCount < inviteThreshold) {
    return {
      ok: true,
      skipped: true,
      reason: "threshold_not_reached",
      qualifyingCount,
      inviteThreshold,
    };
  }

  const marker = inviteThreshold;
  const claimUpdated = await User.findOneAndUpdate(
    {
      tgUserId: referrerTgUserId,
      referralRewardCampaignIdsNotified: { $ne: campaignId },
    },
    {
      $addToSet: {
        referralRewardCampaignIdsNotified: campaignId,
      },
    },
    { new: true },
  ).lean();

  if (!claimUpdated?.tgUserId) {
    return {
      ok: true,
      skipped: true,
      reason: "already_notified",
      qualifyingCount,
      inviteThreshold,
    };
  }

  const referrer = await User.findOne({ tgUserId: referrerTgUserId })
    .select({
      tgUserId: 1,
      username: 1,
      profileName: 1,
    })
    .lean();

  const referredUsers = qualifyingUsers;

  referredUsers.length = Math.min(
    referredUsers.length,
    inviteThreshold,
  );

  const adminIds = getAdminAlertRecipientIds();
  const profileButtons = buildInlineKeyboardFromUsers(referredUsers);
  const firstButtons = profileButtons.slice(0, 50);
  const keyboard = [
    ...firstButtons,
  ];

  const adminMessage = [
    "🏆 Referral milestone yetdi",
    `Mijoz: ${referrer?.username ? `@${normalizeUsername(referrer.username)}` : normalizeString(referrer?.profileName) || referrerTgUserId}`,
    `TG ID: ${referrerTgUserId}`,
    `Taklif qilganlar: ${qualifyingCount}`,
    `Sovga: ${rewardLabel}`,
    "",
    "Admin sovg'ani qo'lda topshiradi.",
  ].join("\n");

  const webAppUrl = normalizeString(process.env.WEB_APP_URL);
  const userKeyboard = webAppUrl
    ? {
        inline_keyboard: [
          [{ text: "Sovg'ani olish", web_app: { url: webAppUrl } }],
        ],
      }
    : undefined;
  const userMessage = [
    "🎉 Tabriklaymiz!",
    `Siz ${inviteThreshold} ta haqiqiy do'stingizni taklif qilish limitiga yetdingiz.`,
    `Sovga: ${rewardLabel}`,
    "",
    "Mini appdagi Profil bo'limida Referral daromadini ishlatish tugmasini bosing va promo kod oling.",
  ].join("\n");

  if (adminIds.length > 0) {
    await Promise.allSettled(
      adminIds.map((adminId) =>
        sendTelegramText(adminId, adminMessage, {
          reply_markup:
            keyboard.length > 0
              ? { inline_keyboard: keyboard }
              : undefined,
        }),
      ),
    );
  }

  const userNotifyResult = await sendTelegramText(referrerTgUserId, userMessage, {
    ...(userKeyboard ? { reply_markup: userKeyboard } : {}),
  });

  emitAdminUpdate({
    type: "referral_reward_milestone_reached",
    referrerTgUserId,
    qualifyingCount,
    inviteThreshold,
    rewardLabel,
    campaignId,
  });

  return {
    ok: true,
    notified: true,
    referrerTgUserId,
    qualifyingCount,
    inviteThreshold,
    rewardLabel,
    campaignId,
    userNotified: Boolean(userNotifyResult?.ok),
  };
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
  const normalizedUserId = normalizeString(tgUserId);
  const existingUserBeforeStart = normalizedUserId
    ? await User.exists({ tgUserId: normalizedUserId })
    : null;

  const user = await ensureReferralIdentity({ tgUserId, username, profileName });
  if (!user?.tgUserId) return null;

  // Referral only for users who are entering bot for the first time.
  // If user already existed before this /start, do not bind referral.
  if (existingUserBeforeStart) return user;

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

  void maybeNotifyReferralMilestone(user.referredByUserId).catch((error) => {
    console.error(
      "Referral milestone notification error:",
      error?.message || error,
    );
  });

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
  buildTelegramProfileUrl,
  bindReferralFromStart,
  ensureReferralIdentity,
  activateReferralOnMiniAppOpen,
  awardReferralCommissionForOrder,
  getQualifiedReferralUsers,
  maybeNotifyReferralMilestone,
  generateReferralCode,
};
