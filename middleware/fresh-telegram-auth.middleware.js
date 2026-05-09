const response = require("../utils/response");

function normalizeString(value) {
  return String(value || "").trim();
}

function toSafeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function createFreshTelegramAuthMiddleware(options = {}) {
  const ttlSec = Math.max(
    30,
    toSafeNumber(
      options?.maxAgeSec,
      toSafeNumber(process.env.TG_INIT_DATA_MAX_AGE_SEC_CRITICAL, 300),
    ),
  );
  const allowFutureSkewSec = Math.max(
    0,
    toSafeNumber(options?.allowFutureSkewSec, 30),
  );

  return (req, res, next) => {
    const authDateSec = toSafeNumber(req?.telegramAuth?.authDateSec, 0);
    const tgUserId = normalizeString(req?.telegramAuth?.tgUserId);

    if (!tgUserId || !authDateSec) {
      return response.unauthorized(
        res,
        "Telegram sessiyasi aniqlanmadi. Ilovani qayta oching.",
        { code: "missing_telegram_session" },
      );
    }

    const nowSec = Math.floor(Date.now() / 1000);
    if (authDateSec > nowSec + allowFutureSkewSec) {
      return response.unauthorized(
        res,
        "Telegram sessiyasi noto'g'ri. Ilovani qayta oching.",
        { code: "invalid_auth_date" },
      );
    }

    const ageSec = nowSec - authDateSec;
    if (ageSec > ttlSec) {
      return response.unauthorized(
        res,
        "Xavfsizlik sababli sessiya eskirdi. Ilovani qayta ochib, qayta urinib ko'ring.",
        {
          code: "stale_telegram_session",
          maxAgeSec: ttlSec,
          ageSec,
        },
      );
    }

    return next();
  };
}

module.exports = {
  createFreshTelegramAuthMiddleware,
};

