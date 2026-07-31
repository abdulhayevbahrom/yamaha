const { getForceJoin } = require("./settings.service");

const MEMBER_STATUSES = ["creator", "administrator", "member"];
const membershipCache = new Map();

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function getCacheTtlMs() {
  return parsePositiveInteger(
    process.env.FORCE_JOIN_MEMBERSHIP_CACHE_TTL_MS,
    5 * 60 * 1000,
  );
}

function getRetryCount() {
  return Math.min(
    5,
    parsePositiveInteger(process.env.FORCE_JOIN_TELEGRAM_RETRY_COUNT, 2),
  );
}

function getRetryDelayMs() {
  return parsePositiveInteger(
    process.env.FORCE_JOIN_TELEGRAM_RETRY_DELAY_MS,
    250,
  );
}

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function getCacheKey(channelId, userId) {
  return `${String(channelId || "").trim()}:${String(userId || "").trim()}`;
}

function getCachedMembership(channelId, userId) {
  const cacheKey = getCacheKey(channelId, userId);
  const cached = membershipCache.get(cacheKey);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    membershipCache.delete(cacheKey);
    return null;
  }
  return cached.value;
}

function cacheMembership(channelId, userId, value) {
  const ttlMs = getCacheTtlMs();
  if (ttlMs <= 0) return;
  membershipCache.set(getCacheKey(channelId, userId), {
    value,
    expiresAt: Date.now() + ttlMs,
  });
}

function clearForceJoinMembershipCache() {
  membershipCache.clear();
}

function buildJoinUrl(channelId, joinUrl) {
  const normalizedJoinUrl = String(joinUrl || "").trim();
  if (normalizedJoinUrl) return normalizedJoinUrl;

  const normalizedChannelId = String(channelId || "").trim();
  if (normalizedChannelId.startsWith("@")) {
    return `https://t.me/${normalizedChannelId.slice(1)}`;
  }

  return "";
}

async function fetchChatMember(channelId, userId) {
  const token = String(process.env.BOT_TOKEN || "").trim();
  if (!token) {
    return { ok: false, reason: "bot_token_missing", description: "BOT_TOKEN topilmadi" };
  }

  const url = `https://api.telegram.org/bot${token}/getChatMember?chat_id=${encodeURIComponent(
    channelId,
  )}&user_id=${encodeURIComponent(userId)}`;

  const retryCount = getRetryCount();
  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    try {
      const response = await fetch(url);
      const data = await response.json();

      if (data?.ok) {
        const status = String(data?.result?.status || "");
        return {
          ok: true,
          status,
          isMember: MEMBER_STATUSES.includes(status),
        };
      }

      const retryable =
        response?.status === 429 ||
        Number(response?.status || 0) >= 500 ||
        Number(data?.error_code || 0) === 429 ||
        Number(data?.error_code || 0) >= 500;
      if (!retryable || attempt >= retryCount) {
        return {
          ok: false,
          reason: "telegram_api_error",
          description: String(data?.description || "Telegram API error"),
        };
      }
    } catch (error) {
      if (attempt >= retryCount) {
        return {
          ok: false,
          reason: "request_failed",
          description: error.message,
        };
      }
    }

    await wait(getRetryDelayMs() * 2 ** attempt);
  }

  return {
    ok: false,
    reason: "request_failed",
    description: "Telegram API tekshiruvi yakunlanmadi",
  };
}

async function checkForceJoinMembership(userId, forceJoinConfig = null) {
  const forceJoin = forceJoinConfig || (await getForceJoin());
  const channelId = String(forceJoin.channelId || "").trim();
  const joinUrl = buildJoinUrl(channelId, forceJoin.joinUrl);

  if (!forceJoin.enabled || !channelId) {
    return {
      enabled: false,
      channelId,
      joinUrl,
      isMember: true,
      canProceed: true,
    };
  }

  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId) {
    return {
      enabled: true,
      channelId,
      joinUrl,
      isMember: false,
      canProceed: false,
      reason: "user_id_missing",
      description: "tg_user_id required",
    };
  }

  const cached = getCachedMembership(channelId, normalizedUserId);
  if (cached) {
    return { ...cached, cached: true };
  }

  const memberResult = await fetchChatMember(channelId, normalizedUserId);
  if (!memberResult.ok) {
    return {
      enabled: true,
      channelId,
      joinUrl,
      isMember: false,
      canProceed: false,
      verificationFailed: true,
      reason: memberResult.reason,
      description: memberResult.description || "",
    };
  }

  const result = {
    enabled: true,
    channelId,
    joinUrl,
    isMember: Boolean(memberResult.isMember),
    canProceed: Boolean(memberResult.isMember),
    status: memberResult.status,
  };
  // A user can join immediately after receiving a `left` response. Caching a
  // negative result would keep rejecting the "A'zo bo'ldim" callback until
  // the cache expires, so only cache confirmed memberships.
  if (result.canProceed) {
    cacheMembership(channelId, normalizedUserId, result);
  }
  return result;
}

async function isForceJoinQualified(userId, forceJoinConfig = null) {
  const membership = await checkForceJoinMembership(userId, forceJoinConfig);
  return Boolean(membership?.canProceed);
}

module.exports = {
  buildJoinUrl,
  checkForceJoinMembership,
  clearForceJoinMembershipCache,
  isForceJoinQualified,
};
