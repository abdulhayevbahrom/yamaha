const response = require("../utils/response");
const { parseInitData } = require("./telegram-auth.middleware");

function normalizeString(value) {
  return String(value || "").trim();
}

function createWebAppSessionGuard(options = {}) {
  const ignorePrefixes = Array.isArray(options.ignorePrefixes)
    ? options.ignorePrefixes.map((item) => normalizeString(item)).filter(Boolean)
    : [];

  return (req, res, next) => {
    const path = normalizeString(req.path || req.originalUrl || "");
    if (ignorePrefixes.some((prefix) => path.startsWith(prefix))) {
      return next();
    }

    const parsed = parseInitData(req.headers["x-tg-init-data"]);
    if (!parsed.ok) {
      return response.unauthorized(
        res,
        "Faqat Telegram WebApp orqali so'rov yuborish mumkin",
        { code: parsed.reason || "invalid_webapp_session" },
      );
    }

    req.telegramAuth = {
      verified: true,
      authDateSec: parsed.authDateSec,
      ...parsed.user,
    };
    return next();
  };
}

module.exports = {
  createWebAppSessionGuard,
};
