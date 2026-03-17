const { getForceJoin } = require("./settings.service");

const MEMBER_STATUSES = ["creator", "administrator", "member"];

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

  try {
    const response = await fetch(url);
    const data = await response.json();

    if (!data?.ok) {
      return {
        ok: false,
        reason: "telegram_api_error",
        description: String(data?.description || "Telegram API error"),
      };
    }

    const status = String(data?.result?.status || "");
    return {
      ok: true,
      status,
      isMember: MEMBER_STATUSES.includes(status),
    };
  } catch (error) {
    return {
      ok: false,
      reason: "request_failed",
      description: error.message,
    };
  }
}

async function checkForceJoinMembership(userId) {
  const forceJoin = await getForceJoin();
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

  const memberResult = await fetchChatMember(channelId, normalizedUserId);
  if (!memberResult.ok) {
    return {
      enabled: true,
      channelId,
      joinUrl,
      isMember: false,
      canProceed: false,
      reason: memberResult.reason,
      description: memberResult.description || "",
    };
  }

  return {
    enabled: true,
    channelId,
    joinUrl,
    isMember: Boolean(memberResult.isMember),
    canProceed: Boolean(memberResult.isMember),
    status: memberResult.status,
  };
}

module.exports = {
  buildJoinUrl,
  checkForceJoinMembership,
};
