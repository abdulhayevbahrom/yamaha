const crypto = require("node:crypto");
const SecurityDeviceActivity = require("../model/security-device-activity.model");
const User = require("../model/user.model");
const { sendTelegramText } = require("./telegram-notify.service");
const { emitAdminUpdate } = require("../socket");

const ALERT_MILESTONES = [10, 20, 30, 40, 50, 75, 100, 150, 200];
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const ALERT_COOLDOWN_MS = 60 * 60 * 1000;
const MAX_RECENT_EVENTS = 100;

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeIp(value) {
  const raw = normalizeString(value);
  if (!raw) return "";

  const first = raw.split(",")[0].trim();
  if (first.startsWith("::ffff:")) {
    return first.slice(7);
  }
  return first;
}

function hashShort(value) {
  const raw = normalizeString(value);
  if (!raw) return "";
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function getClientIp(req) {
  return (
    normalizeIp(req?.headers?.["x-forwarded-for"]) ||
    normalizeIp(req?.ip) ||
    normalizeIp(req?.socket?.remoteAddress) ||
    ""
  );
}

function buildDeviceKey({ deviceFingerprint, deviceId, userAgent, ip }) {
  const fingerprintHash = hashShort(deviceFingerprint);
  if (fingerprintHash) return `fp:${fingerprintHash}`;

  const deviceIdHash = hashShort(deviceId);
  if (deviceIdHash) return `did:${deviceIdHash}`;

  const fallbackHash = hashShort([userAgent, ip].filter(Boolean).join("|"));
  if (fallbackHash) return `ua:${fallbackHash}`;

  return "";
}

function getAlertThreshold(uniqueUserCount, recentRequestCount) {
  const uniqueThreshold = ALERT_MILESTONES.find(
    (milestone) => uniqueUserCount >= milestone,
  );
  if (uniqueThreshold) {
    return { reason: "unique_users", milestone: uniqueThreshold };
  }

  if (uniqueUserCount >= 5 && recentRequestCount >= 20) {
    return { reason: "rapid_requests", milestone: 20 };
  }

  return null;
}

function formatUserLabel(user = {}) {
  const username = normalizeString(user.username);
  const profileName = normalizeString(user.profileName);
  if (username && profileName) return `@${username} (${profileName})`;
  if (username) return `@${username}`;
  if (profileName) return profileName;
  return normalizeString(user.tgUserId) || "-";
}

function formatReferralAlertUser(user = {}) {
  const username = normalizeString(user.username);
  const profileName = normalizeString(user.profileName);
  const tgUserId = normalizeString(user.tgUserId) || "-";
  return `@username: ${username ? `@${username}` : "-"} | Profil: ${profileName || "-"} | tgUserId: ${tgUserId}`;
}

function collectReferralSourceIds(users = []) {
  return Array.from(
    new Set(
      users
        .map((item) => normalizeString(item?.referredByUserId))
        .filter(Boolean),
    ),
  );
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

async function recordDeviceActivity({
  req,
  tgUserId = "",
  username = "",
  profileName = "",
  route = "",
  method = "",
}) {
  const userId = normalizeString(tgUserId);
  if (!userId) return { ok: false, skipped: true, reason: "missing_user" };

  const deviceFingerprint = normalizeString(req?.headers?.["x-device-fingerprint"]);
  const deviceId = normalizeString(req?.headers?.["x-device-id"]);
  const userAgent = normalizeString(req?.headers?.["user-agent"]);
  const ip = getClientIp(req);
  const deviceKey = buildDeviceKey({ deviceFingerprint, deviceId, userAgent, ip });

  if (!deviceKey) {
    return { ok: false, skipped: true, reason: "missing_device_key" };
  }

  const now = new Date();
  const existing = await SecurityDeviceActivity.findOne({ deviceKey })
    .select("+uniqueUserIds +recentEvents")
    .lean();
  const existingUserIds = Array.isArray(existing?.uniqueUserIds)
    ? existing.uniqueUserIds.map((item) => normalizeString(item)).filter(Boolean)
    : [];
  const isNewUser = !existingUserIds.includes(userId);
  const recentEvent = {
    tgUserId: userId,
    username: normalizeString(username),
    profileName: normalizeString(profileName),
    ip,
    userAgent,
    route: normalizeString(route),
    method: normalizeString(method).toUpperCase(),
    seenAt: now,
  };

  const update = {
    $setOnInsert: {
      firstSeenAt: now,
      alertCount: 0,
      lastAlertMilestone: 0,
    },
    $set: {
      tgUserId: userId,
      username: normalizeString(username),
      profileName: normalizeString(profileName),
      deviceFingerprint,
      deviceId,
      ip,
      userAgent,
      lastSeenAt: now,
      latestRoute: normalizeString(route),
      latestMethod: normalizeString(method).toUpperCase(),
    },
    $inc: {
      requestCount: 1,
    },
    $addToSet: {
      uniqueUserIds: userId,
    },
    $push: {
      recentEvents: {
        $each: [recentEvent],
        $position: 0,
        $slice: MAX_RECENT_EVENTS,
      },
    },
  };

  if (isNewUser) {
    update.$inc.uniqueUserCount = 1;
  }

  const updated = await SecurityDeviceActivity.findOneAndUpdate(
    { deviceKey },
    update,
    { new: true, upsert: true },
  )
    .select("+uniqueUserIds +recentEvents")
    .lean();

  const recentEvents = Array.isArray(updated?.recentEvents)
    ? updated.recentEvents
    : [];
  const recentCutoff = now.getTime() - RECENT_WINDOW_MS;
  const recentUserIds = new Set();
  let recentRequestCount = 0;

  for (const event of recentEvents) {
    const seenAt = new Date(event?.seenAt || 0).getTime();
    if (!Number.isFinite(seenAt) || seenAt < recentCutoff) continue;
    recentRequestCount += 1;
    const eventUserId = normalizeString(event?.tgUserId);
    if (eventUserId) recentUserIds.add(eventUserId);
  }

  const recentUniqueUserCount = recentUserIds.size;
  const totalUniqueUserCount = Number(updated?.uniqueUserCount || 0);
  const alertThreshold = getAlertThreshold(
    Math.max(recentUniqueUserCount, totalUniqueUserCount),
    recentRequestCount,
  );

  if (!alertThreshold) {
    return {
      ok: true,
      deviceKey,
      updated,
      suspicious: Boolean(updated?.suspiciousAt),
    };
  }

  const lastAlertAt = new Date(updated?.lastAlertAt || 0).getTime();
  const lastAlertMilestone = Number(updated?.lastAlertMilestone || 0);
  if (
    lastAlertMilestone >= alertThreshold.milestone ||
    (lastAlertAt && now.getTime() - lastAlertAt < ALERT_COOLDOWN_MS)
  ) {
    return {
      ok: true,
      deviceKey,
      updated,
      suspicious: Boolean(updated?.suspiciousAt),
      throttled: true,
    };
  }

  const suspiciousReason =
    alertThreshold.reason === "rapid_requests"
      ? `24 soatda kamida ${alertThreshold.milestone} ta start/open va 5+ ta user`
      : `Bir qurilmadan ${alertThreshold.milestone}+ ta turli user`;

  const marked = await SecurityDeviceActivity.findOneAndUpdate(
    { deviceKey },
    {
      $set: {
        suspiciousAt: updated?.suspiciousAt || now,
        suspiciousReason,
        lastAlertAt: now,
        lastAlertMilestone: alertThreshold.milestone,
      },
      $inc: {
        alertCount: 1,
      },
    },
    { new: true },
  ).lean();

  // Alert 10+ umumiy device user soniga ko'ra yuboriladi. Shu bois referral
  // havolasi egalarini faqat oxirgi 24 soatdagi eventlardan emas, qurilmaning
  // to'liq user tarixidan izlaymiz.
  const trackedDeviceUserIds = Array.from(
    new Set(
      [
        ...recentUserIds,
        ...(Array.isArray(updated?.uniqueUserIds) ? updated.uniqueUserIds : []),
      ]
        .map((item) => normalizeString(item))
        .filter(Boolean),
    ),
  );
  const users = await User.find({
    tgUserId: { $in: trackedDeviceUserIds },
  })
    .select({
      tgUserId: 1,
      username: 1,
      profileName: 1,
      isBlocked: 1,
      blockedReason: 1,
      referredByUserId: 1,
      referredAt: 1,
      referralActivatedAt: 1,
      createdAt: 1,
    })
    .lean();

  const userMap = new Map(users.map((item) => [normalizeString(item.tgUserId), item]));
  const recentUserList = Array.from(recentUserIds)
    .map((item) => userMap.get(item) || { tgUserId: item })
    .map((item) => ({
      tgUserId: normalizeString(item.tgUserId),
      username: normalizeString(item.username),
      profileName: normalizeString(item.profileName),
      isBlocked: Boolean(item.isBlocked),
      blockedReason: normalizeString(item.blockedReason),
      referredByUserId: normalizeString(item.referredByUserId),
      referredAt: item.referredAt || null,
      referralActivatedAt: item.referralActivatedAt || null,
      createdAt: item.createdAt || null,
      label: formatUserLabel(item),
    }));

  const referralSourceIds = collectReferralSourceIds(users);
  const referralSources = referralSourceIds.length
    ? await User.find({ tgUserId: { $in: referralSourceIds } })
        .select({ tgUserId: 1, username: 1, profileName: 1 })
        .lean()
    : [];
  const referralSourceMap = new Map(
    referralSources.map((item) => [normalizeString(item.tgUserId), item]),
  );

  const alertMessage = [
    "⚠️ Referral anti-fraud ogohlantirishi",
    `Qurilma: ${deviceKey.slice(0, 18)}...`,
    `IP: ${ip || "-"}`,
    `User-Agent: ${userAgent ? userAgent.slice(0, 120) : "-"}`,
    `24 soatdagi noyob userlar: ${recentUniqueUserCount}`,
    `24 soatdagi open/start signal: ${recentRequestCount}`,
    `Sabab: ${suspiciousReason}`,
    "",
    "Referral havolasi egalari:",
    ...(referralSourceIds.length
      ? referralSourceIds.slice(0, 10).map((referrerId, index) => {
          const referrer = referralSourceMap.get(referrerId);
          return `${index + 1}. ${referrer ? formatReferralAlertUser(referrer) : `Topilmadi | tgUserId: ${referrerId}`}`;
        })
      : ["Yo'q"]),
    ...(referralSourceIds.length > 10
      ? [`… Yana ${referralSourceIds.length - 10} ta referral havolasi egasi admin panelda ko'rinadi.`]
      : []),
  ].join("\n");

  const adminIds = getAdminAlertRecipientIds();

  if (!adminIds.length) {
    console.warn(
      "Referral anti-fraud alert skipped: admin recipient ids are not configured",
    );
  }

  await Promise.allSettled(
    adminIds.map((adminId) => sendTelegramText(adminId, alertMessage)),
  );

  emitAdminUpdate({
    type: "suspicious_device_detected",
    refreshSecurity: true,
    deviceKey,
    suspiciousReason,
    recentUniqueUserCount,
    recentRequestCount,
  });

  return {
    ok: true,
    deviceKey,
    updated: marked || updated,
    suspicious: true,
    alert: true,
    suspiciousReason,
    recentUniqueUserCount,
    recentRequestCount,
    recentUserList,
  };
}

async function listSuspiciousDevices({ page = 1, limit = 20 } = {}) {
  const safeLimit = Math.min(100, Math.max(1, Math.floor(Number(limit) || 20)));
  const safePage = Math.max(1, Math.floor(Number(page) || 1));
  const query = {
    $or: [
      { suspiciousAt: { $ne: null } },
      { uniqueUserCount: { $gte: 5 } },
      // Faqat bitta user bo'lsa, ko'p request'lar o'zi yetarli signal emas.
      // Bu holat oddiy aktiv ishlatish yoki bitta accountning ko'p ochilishi bo'lishi mumkin.
      { $and: [{ requestCount: { $gte: 20 } }, { uniqueUserCount: { $gte: 2 } }] },
    ],
  };

  const totalItems = await SecurityDeviceActivity.countDocuments(query);
  const totalPages = Math.max(1, Math.ceil(totalItems / safeLimit));
  const docs = totalItems
    ? await SecurityDeviceActivity.find(query)
        .select("+uniqueUserIds +recentEvents")
        .sort({ suspiciousAt: -1, lastSeenAt: -1, uniqueUserCount: -1 })
        .skip((Math.min(safePage, totalPages) - 1) * safeLimit)
        .limit(safeLimit)
        .lean()
    : [];

  const userIds = Array.from(
    new Set(
      docs.flatMap((doc) =>
        Array.isArray(doc?.recentEvents)
          ? doc.recentEvents.map((item) => normalizeString(item?.tgUserId)).filter(Boolean)
          : [],
      ),
    ),
  );

  const users = userIds.length
    ? await User.find({ tgUserId: { $in: userIds } })
        .select({
          tgUserId: 1,
          username: 1,
          profileName: 1,
          isBlocked: 1,
          blockedReason: 1,
          referredByUserId: 1,
          referredAt: 1,
          referralActivatedAt: 1,
          createdAt: 1,
        })
        .lean()
    : [];
  const userMap = new Map(users.map((item) => [normalizeString(item.tgUserId), item]));

  const items = docs.map((doc) => {
    const recentEvents = Array.isArray(doc?.recentEvents) ? doc.recentEvents : [];
    const recentIds = [];
    const seenIds = new Set();
    let recentRequestCount = 0;
    const recentCutoff = Date.now() - RECENT_WINDOW_MS;

    for (const event of recentEvents) {
      const seenAt = new Date(event?.seenAt || 0).getTime();
      if (!Number.isFinite(seenAt) || seenAt < recentCutoff) continue;
      recentRequestCount += 1;
      const tgUserId = normalizeString(event?.tgUserId);
      if (tgUserId && !seenIds.has(tgUserId)) {
        seenIds.add(tgUserId);
        recentIds.push(tgUserId);
      }
    }

    const recentUsers = recentIds.map((tgUserId) => {
      const user = userMap.get(tgUserId) || {};
      return {
        tgUserId,
        username: normalizeString(user.username),
        profileName: normalizeString(user.profileName),
        isBlocked: Boolean(user.isBlocked),
        blockedReason: normalizeString(user.blockedReason),
        referredByUserId: normalizeString(user.referredByUserId),
        referredAt: user.referredAt || null,
        referralActivatedAt: user.referralActivatedAt || null,
        createdAt: user.createdAt || null,
        label: formatUserLabel(
          user.tgUserId
            ? user
            : {
                tgUserId,
              },
        ),
      };
    });

    return {
      deviceKey: String(doc?.deviceKey || ""),
      deviceFingerprint: String(doc?.deviceFingerprint || ""),
      deviceId: String(doc?.deviceId || ""),
      ip: String(doc?.ip || ""),
      userAgent: String(doc?.userAgent || ""),
      firstSeenAt: doc?.firstSeenAt || null,
      lastSeenAt: doc?.lastSeenAt || null,
      requestCount: Number(doc?.requestCount || 0),
      uniqueUserCount: Number(doc?.uniqueUserCount || 0),
      suspiciousAt: doc?.suspiciousAt || null,
      suspiciousReason: String(doc?.suspiciousReason || ""),
      alertCount: Number(doc?.alertCount || 0),
      lastAlertAt: doc?.lastAlertAt || null,
      lastAlertMilestone: Number(doc?.lastAlertMilestone || 0),
      latestRoute: String(doc?.latestRoute || ""),
      latestMethod: String(doc?.latestMethod || ""),
      recentUniqueUserCount: recentIds.length,
      recentRequestCount,
      recentUsers,
    };
  });

  return {
    page: Math.min(safePage, totalPages),
    limit: safeLimit,
    totalItems,
    totalPages,
    items,
  };
}

module.exports = {
  recordDeviceActivity,
  listSuspiciousDevices,
  formatReferralAlertUser,
  collectReferralSourceIds,
};
