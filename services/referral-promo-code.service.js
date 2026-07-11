const crypto = require("node:crypto");
const User = require("../model/user.model");
const ReferralPromoCode = require("../model/referral-promo-code.model");
const { sendTelegramText } = require("./telegram-notify.service");
const { getReferralRewardConfig } = require("./settings.service");
const { emitUserUpdate } = require("../socket");
const { emitAdminUpdate } = require("../socket");
const { getQualifiedReferralUsers } = require("./referral.service");

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeUsername(value) {
  return normalizeString(value).replace(/^@+/, "");
}

function normalizeProfileName(value) {
  return normalizeString(value).replace(/\s+/g, " ").trim();
}

function buildRewardCatalog(rawCatalog, fallbackInviteThreshold = 0) {
  if (!Array.isArray(rawCatalog)) return [];

  return rawCatalog
    .map((item, index) => {
      const key = normalizeString(item?.key || item?.rewardKey || `reward_${index + 1}`)
        .toLowerCase()
        .replace(/[^a-z0-9_:-]/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "");
      const label = normalizeString(item?.label || item?.rewardLabel || "");
      const hasExplicitThreshold =
        item?.inviteThreshold !== undefined || item?.threshold !== undefined;
      const inviteThresholdValue = Number(
        hasExplicitThreshold
          ? item?.inviteThreshold ?? item?.threshold
          : Number(fallbackInviteThreshold || 1) * (index + 1),
      );
      if (!key || !label) return null;
      return {
        key,
        label,
        inviteThreshold:
          Number.isFinite(inviteThresholdValue) && inviteThresholdValue > 0
            ? Math.floor(inviteThresholdValue)
            : 0,
        serviceType: normalizeString(item?.serviceType || item?.type || "custom"),
        serviceValue: Number(item?.serviceValue ?? item?.value ?? 0) || 0,
        active:
          typeof item?.active === "boolean" ? item.active : Boolean(item?.active ?? true),
        description: normalizeString(item?.description || ""),
      };
    })
    .filter(Boolean)
    .sort((left, right) => {
      const leftThreshold = Number(left.inviteThreshold || 0);
      const rightThreshold = Number(right.inviteThreshold || 0);
      if (leftThreshold !== rightThreshold) return leftThreshold - rightThreshold;
      return String(left.key || "").localeCompare(String(right.key || ""));
    });
}

function getActiveRewardCatalog(config) {
  const catalog = buildRewardCatalog(
    config?.rewardCatalog || [],
    Number(config?.inviteThreshold || 0),
  );
  return catalog.filter((item) => item.active);
}

function makePromoCode() {
  const token = crypto.randomBytes(4).toString("hex").toUpperCase();
  return `PROMO-${token}`;
}

function parseCooldownMs(cooldownDays) {
  const days = Math.max(0, Math.floor(Number(cooldownDays || 0)));
  return days * 24 * 60 * 60 * 1000;
}

function normalizeActiveFrom(value) {
  const parsed = value ? new Date(value) : null;
  return parsed && Number.isFinite(parsed.getTime()) ? parsed : null;
}

async function getReferralQualifiedInviteCount({ tgUserId, activeFrom = null }) {
  const qualifiedUsers = await getQualifiedReferralUsers(tgUserId, activeFrom);
  return qualifiedUsers.length;
}

function getRewardThreshold(reward = {}, fallbackThreshold = 0) {
  const threshold = Number(reward?.inviteThreshold || fallbackThreshold || 0);
  return Number.isFinite(threshold) && threshold > 0
    ? Math.floor(threshold)
    : Math.max(1, Math.floor(Number(fallbackThreshold || 1)));
}

function buildRewardProgressState(rewardCatalog = [], qualifiedInviteCount = 0) {
  const activeRewards = Array.isArray(rewardCatalog)
    ? rewardCatalog.filter((item) => item?.active !== false)
    : [];
  const sortedRewards = [...activeRewards].sort((left, right) => {
    const leftThreshold = getRewardThreshold(left);
    const rightThreshold = getRewardThreshold(right);
    if (leftThreshold !== rightThreshold) return leftThreshold - rightThreshold;
    return String(left.key || "").localeCompare(String(right.key || ""));
  });

  const qualifiedCount = Math.max(0, Math.floor(Number(qualifiedInviteCount || 0)));
  const eligibleRewards = sortedRewards.filter(
    (reward) => getRewardThreshold(reward) <= qualifiedCount,
  );

  return {
    sortedRewards,
    eligibleRewards,
    availableRewardCount: eligibleRewards.length,
    nextMilestoneInviteCount:
      sortedRewards.find((reward) => getRewardThreshold(reward) > qualifiedCount)
        ?.inviteThreshold || 0,
  };
}

async function getReferralRedemptionState(tgUserId) {
  const ownerTgUserId = normalizeString(tgUserId);
  if (!ownerTgUserId) return null;

  const config = await getReferralRewardConfig();
  const activeFrom = normalizeActiveFrom(config?.activeFrom);

  const [owner, qualifiedInviteCount, latestRedemption, claimedRewardKeys] = await Promise.all([
    User.findOne({ tgUserId: ownerTgUserId })
      .select({
        tgUserId: 1,
        username: 1,
        profileName: 1,
        referralCode: 1,
        referredByUserId: 1,
        isBlocked: 1,
        referralBlockedAt: 1,
      })
      .lean(),
    getReferralQualifiedInviteCount({ tgUserId: ownerTgUserId, activeFrom }),
    ReferralPromoCode.findOne({ ownerTgUserId }).sort({ createdAt: -1 }).lean(),
    ReferralPromoCode.distinct("rewardKey", {
      ownerTgUserId,
      status: { $ne: "cancelled" },
    }),
  ]);

  const inviteThreshold = Math.max(1, Math.floor(Number(config?.inviteThreshold || 50)));
  const cooldownDays = Math.max(0, Math.floor(Number(config?.cooldownDays || 0)));
  const activeRewards = getActiveRewardCatalog(config);
  const requestedAtMs = latestRedemption?.requestedAt
    ? new Date(latestRedemption.requestedAt).getTime()
    : latestRedemption?.createdAt
      ? new Date(latestRedemption.createdAt).getTime()
      : 0;
  const cooldownMs = parseCooldownMs(cooldownDays);
  const nextAvailableAt = requestedAtMs && cooldownMs
    ? new Date(requestedAtMs + cooldownMs)
    : null;
  const nowMs = Date.now();
  const progress = buildRewardProgressState(activeRewards, qualifiedInviteCount);
  const claimedRewardCount = Array.isArray(claimedRewardKeys)
    ? claimedRewardKeys.filter(Boolean).length
    : 0;
  const remainingRewardCount = Math.max(
    0,
    progress.availableRewardCount - Number(claimedRewardCount || 0),
  );
  const hasThreshold = remainingRewardCount > 0;
  const isCoolingDown = Boolean(nextAvailableAt && nextAvailableAt.getTime() > nowMs);
  const hasPendingRequest = latestRedemption?.status === "pending";

  return {
    owner,
    inviteThreshold,
    cooldownDays,
    rewardLabel: String(config?.rewardLabel || "Telegram Premium").trim(),
    rewardCatalog: progress.sortedRewards,
    qualifiedInviteCount: Number(qualifiedInviteCount || 0),
    availableRewardCount: progress.availableRewardCount,
    claimedRewardCount: Number(claimedRewardCount || 0),
    remainingRewardCount,
    nextMilestoneInviteCount: progress.nextMilestoneInviteCount,
    claimedRewardKeys: Array.isArray(claimedRewardKeys)
      ? claimedRewardKeys.filter(Boolean)
      : [],
    canRedeem: Boolean(
      owner && !owner.isBlocked && !owner.referralBlockedAt && hasThreshold && !isCoolingDown && !hasPendingRequest,
    ),
    isCoolingDown,
    nextAvailableAt: nextAvailableAt ? nextAvailableAt.toISOString() : null,
    lastRedemption: latestRedemption
      ? {
          code: String(latestRedemption.code || ""),
          status: String(latestRedemption.status || "pending"),
          rewardKey: String(latestRedemption.rewardKey || ""),
          rewardLabel: String(latestRedemption.rewardLabel || ""),
          milestoneIndex: Number(latestRedemption.milestoneIndex || 1),
          qualifiedInviteCountAtRequest: Number(
            latestRedemption.qualifiedInviteCountAtRequest || 0,
          ),
          requestedAt: latestRedemption.requestedAt || latestRedemption.createdAt || null,
          usedAt: latestRedemption.usedAt || null,
          usedPurpose: String(latestRedemption.usedPurpose || ""),
        }
      : null,
    activeRequest: latestRedemption && latestRedemption.status === "pending"
      ? {
          code: String(latestRedemption.code || ""),
          rewardKey: String(latestRedemption.rewardKey || ""),
          rewardLabel: String(latestRedemption.rewardLabel || ""),
          milestoneIndex: Number(latestRedemption.milestoneIndex || 1),
          requestedAt: latestRedemption.requestedAt || latestRedemption.createdAt || null,
        }
      : null,
  };
}

async function requestReferralPromoCode({
  tgUserId,
  username = "",
  profileName = "",
  rewardKey = "",
}) {
  const ownerTgUserId = normalizeString(tgUserId);
  if (!ownerTgUserId) {
    return { ok: false, reason: "missing_user" };
  }

  const state = await getReferralRedemptionState(ownerTgUserId);
  if (!state?.owner?.tgUserId) {
    return { ok: false, reason: "user_not_found" };
  }
  if (state.owner.referralBlockedAt) {
    return { ok: false, reason: "referral_blocked" };
  }

  const rewardCatalog = Array.isArray(state.rewardCatalog) ? state.rewardCatalog : [];
  const alreadyClaimedKeys = new Set(
    Array.isArray(state.claimedRewardKeys) ? state.claimedRewardKeys : [],
  );
  const selectedRewardKey = normalizeString(rewardKey).toLowerCase();
  const selectedReward =
    rewardCatalog.find((item) => item.key === selectedRewardKey) ||
    rewardCatalog.find(
      (item) =>
        Number(item.inviteThreshold || 0) <= Number(state.qualifiedInviteCount || 0) &&
        !alreadyClaimedKeys.has(item.key),
    ) ||
    null;

  if (!selectedReward) {
    return { ok: false, reason: "no_reward_configured" };
  }

  const selectedThreshold = Number(selectedReward.inviteThreshold || 0);
  if (
    !Number.isFinite(selectedThreshold) ||
    selectedThreshold <= 0 ||
    selectedThreshold > Number(state.qualifiedInviteCount || 0)
  ) {
    return {
      ok: false,
      reason: "threshold_not_reached",
      inviteThreshold: state.inviteThreshold,
      qualifiedInviteCount: state.qualifiedInviteCount,
      availableRewardCount: state.availableRewardCount,
      claimedRewardCount: state.claimedRewardCount,
      remainingRewardCount: state.remainingRewardCount,
      nextMilestoneInviteCount: state.nextMilestoneInviteCount,
    };
  }

  if (alreadyClaimedKeys.has(selectedReward.key)) {
    return {
      ok: false,
      reason: "duplicate_reward",
      rewardKey: selectedReward.key,
      rewardLabel: selectedReward.label,
      inviteThreshold: selectedThreshold,
    };
  }

  if (state.remainingRewardCount <= 0) {
    return {
      ok: false,
      reason: "threshold_not_reached",
      inviteThreshold: state.inviteThreshold,
      qualifiedInviteCount: state.qualifiedInviteCount,
      availableRewardCount: state.availableRewardCount,
      claimedRewardCount: state.claimedRewardCount,
      remainingRewardCount: state.remainingRewardCount,
      nextMilestoneInviteCount: state.nextMilestoneInviteCount,
    };
  }

  if (state.isCoolingDown) {
    return {
      ok: false,
      reason: "cooldown_active",
      nextAvailableAt: state.nextAvailableAt,
      cooldownDays: state.cooldownDays,
    };
  }

  if (state.activeRequest?.code) {
    return {
      ok: false,
      reason: "pending_request",
      activeRequest: state.activeRequest,
    };
  }

  const now = new Date();
  const code = makePromoCode();
  const eligibleRewards = rewardCatalog.filter(
    (item) => Number(item.inviteThreshold || 0) <= Number(state.qualifiedInviteCount || 0),
  );
  const milestoneIndex =
    rewardCatalog.findIndex((item) => item.key === selectedReward.key) + 1 ||
    eligibleRewards.findIndex((item) => item.key === selectedReward.key) + 1 ||
    1;

  const promoDoc = await ReferralPromoCode.create({
    code,
    ownerTgUserId,
    ownerUsername: normalizeUsername(username) || state.owner.username || "",
    ownerProfileName: normalizeProfileName(profileName) || state.owner.profileName || "",
    rewardKey: selectedReward.key,
    rewardLabel: selectedReward.label,
    rewardType: selectedReward.serviceType,
    rewardValue: Number(selectedReward.serviceValue || 0),
    inviteThreshold: selectedThreshold,
    milestoneIndex,
    qualifiedInviteCountAtRequest: state.qualifiedInviteCount,
    cooldownDays: state.cooldownDays,
    status: "pending",
    requestedAt: now,
  });

  const adminMessage = [
    "🎁 Referral promo code tayyor",
    `Kod: ${promoDoc.code}`,
    `Mijoz: ${promoDoc.ownerUsername ? `@${promoDoc.ownerUsername}` : promoDoc.ownerProfileName || ownerTgUserId}`,
    `TG ID: ${ownerTgUserId}`,
    `Takliflar: ${state.qualifiedInviteCount}/${state.inviteThreshold}`,
    `Bosqich: ${milestoneIndex}/${state.availableRewardCount}`,
    `Sovga: ${selectedReward.label}`,
    `Cooldown: ${state.cooldownDays || 0} kun`,
    "",
    "Kod tekshirilib, sovga berilgandan keyin admin panelda used holatiga o'tkazing.",
  ].join("\n");

  const adminIds = String(process.env.ADMIN_NOTIFY_CHAT_ID || "")
    .split(",")
    .map((item) => normalizeString(item))
    .filter(Boolean);

  if (adminIds.length > 0) {
    await Promise.allSettled(
      adminIds.map((adminId) => sendTelegramText(adminId, adminMessage)),
    );
  }

  emitAdminUpdate({
    type: "referral_promo_code_created",
    code: promoDoc.code,
    ownerTgUserId,
    rewardKey: selectedReward.key,
    rewardLabel: selectedReward.label,
    milestoneIndex,
  });

  emitUserUpdate(ownerTgUserId, {
    type: "referral_promo_code_created",
    refreshReferral: true,
    code: promoDoc.code,
    rewardKey: selectedReward.key,
    milestoneIndex,
  });

  return {
    ok: true,
    code: promoDoc.code,
    rewardKey: selectedReward.key,
    rewardLabel: selectedReward.label,
    rewardType: selectedReward.serviceType,
    rewardValue: Number(selectedReward.serviceValue || 0),
    inviteThreshold: selectedThreshold,
    qualifiedInviteCount: state.qualifiedInviteCount,
    availableRewardCount: state.availableRewardCount,
    claimedRewardCount: Number(state.claimedRewardCount || 0) + 1,
    remainingRewardCount: Math.max(
      0,
      state.availableRewardCount - (Number(state.claimedRewardCount || 0) + 1),
    ),
    milestoneIndex,
    cooldownDays: state.cooldownDays,
    requestedAt: promoDoc.requestedAt,
  };
}

async function listReferralPromoCodes({ query = "", page = 1, limit = 20 } = {}) {
  const safePage = Math.max(1, Math.floor(Number(page || 1)));
  const safeLimit = Math.min(100, Math.max(1, Math.floor(Number(limit || 20))));
  const normalizedQuery = normalizeString(query);
  const filter = normalizedQuery
    ? {
        $or: [
          { code: new RegExp(normalizedQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") },
          { ownerTgUserId: normalizedQuery },
          { ownerUsername: new RegExp(normalizedQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") },
        ],
      }
    : {};

  const [totalItems, items] = await Promise.all([
    ReferralPromoCode.countDocuments(filter),
    ReferralPromoCode.find(filter)
      .sort({ createdAt: -1 })
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit)
      .lean(),
  ]);

  return {
    items: items.map((item) => ({
      code: String(item.code || ""),
      ownerTgUserId: String(item.ownerTgUserId || ""),
      ownerUsername: String(item.ownerUsername || ""),
      ownerProfileName: String(item.ownerProfileName || ""),
      rewardKey: String(item.rewardKey || ""),
      rewardLabel: String(item.rewardLabel || ""),
      rewardType: String(item.rewardType || ""),
      rewardValue: Number(item.rewardValue || 0),
      inviteThreshold: Number(item.inviteThreshold || 0),
      milestoneIndex: Number(item.milestoneIndex || 1),
      qualifiedInviteCountAtRequest: Number(
        item.qualifiedInviteCountAtRequest || 0,
      ),
      cooldownDays: Number(item.cooldownDays || 0),
      status: String(item.status || "pending"),
      requestedAt: item.requestedAt || item.createdAt || null,
      usedAt: item.usedAt || null,
      usedPurpose: String(item.usedPurpose || ""),
      usedByAdminId: String(item.usedByAdminId || ""),
      usedByAdminUsername: String(item.usedByAdminUsername || ""),
      adminNote: String(item.adminNote || ""),
      createdAt: item.createdAt || null,
      updatedAt: item.updatedAt || null,
    })),
    pagination: {
      page: safePage,
      limit: safeLimit,
      totalItems,
      totalPages: Math.max(1, Math.ceil(totalItems / safeLimit)),
    },
  };
}

async function markReferralPromoCodeUsed({
  code,
  usedPurpose = "",
  adminId = "",
  adminUsername = "",
  adminNote = "",
}) {
  const normalizedCode = normalizeString(code);
  if (!normalizedCode) {
    return { ok: false, reason: "missing_code" };
  }

  const promoCode = await ReferralPromoCode.findOne({ code: normalizedCode }).lean();
  if (!promoCode?.code) {
    return { ok: false, reason: "not_found" };
  }
  if (promoCode.status === "used") {
    return {
      ok: true,
      alreadyUsed: true,
      promoCode: {
        code: promoCode.code,
        usedAt: promoCode.usedAt || null,
        usedPurpose: promoCode.usedPurpose || "",
        ownerTgUserId: promoCode.ownerTgUserId || "",
        rewardLabel: promoCode.rewardLabel || "",
      },
    };
  }

  const usedAt = new Date();
  await ReferralPromoCode.updateOne(
    { code: normalizedCode },
    {
      $set: {
        status: "used",
        usedAt,
        usedByAdminId: normalizeString(adminId),
        usedByAdminUsername: normalizeUsername(adminUsername),
        usedPurpose: normalizeString(usedPurpose),
        adminNote: normalizeString(adminNote),
      },
    },
  );

  emitAdminUpdate({
    type: "referral_promo_code_used",
    code: normalizedCode,
    ownerTgUserId: promoCode.ownerTgUserId,
    rewardLabel: promoCode.rewardLabel,
    usedPurpose: normalizeString(usedPurpose),
  });

  return {
    ok: true,
    promoCode: {
      code: normalizedCode,
      usedAt: usedAt.toISOString(),
      usedPurpose: normalizeString(usedPurpose),
      ownerTgUserId: promoCode.ownerTgUserId,
      rewardLabel: promoCode.rewardLabel,
    },
  };
}

module.exports = {
  buildRewardCatalog,
  getReferralRedemptionState,
  getActiveRewardCatalog,
  requestReferralPromoCode,
  listReferralPromoCodes,
  markReferralPromoCodeUsed,
};
