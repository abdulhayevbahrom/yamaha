const User = require("../model/user.model");
const response = require("../utils/response");

function normalizeString(value) {
  return String(value || "").trim();
}

const userExistsCache = new Map();
let lastCleanupAt = 0;

function cleanup(nowMs) {
  if (nowMs - lastCleanupAt < 30_000) return;
  lastCleanupAt = nowMs;

  for (const [key, expiresAt] of userExistsCache.entries()) {
    if (!expiresAt || expiresAt <= nowMs) {
      userExistsCache.delete(key);
    }
  }
}

module.exports = async (req, res, next) => {
  try {
    const tgUserId = normalizeString(req?.telegramAuth?.tgUserId);
    if (!tgUserId) {
      return response.unauthorized(res, "Telegram user topilmadi", {
        code: "missing_tg_user",
      });
    }

    const nowMs = Date.now();
    cleanup(nowMs);

    const cacheHit = userExistsCache.get(tgUserId);
    if (cacheHit && cacheHit > nowMs) {
      return next();
    }

    const exists = await User.exists({ tgUserId });
    if (!exists) {
      return response.forbidden(
        res,
        "Avval botda /start bosing, keyin WebAppdan foydalaning",
        { code: "bot_start_required" },
      );
    }

    userExistsCache.set(tgUserId, nowMs + 60_000);
    return next();
  } catch (error) {
    return response.serverError(
      res,
      "Foydalanuvchini tekshirishda xatolik",
      error?.message || "unknown_error",
    );
  }
};
