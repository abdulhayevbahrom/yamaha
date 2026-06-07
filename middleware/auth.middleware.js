const jwt = require("jsonwebtoken");
const response = require("../utils/response");

function normalizeString(value) {
  return String(value || "").trim();
}

module.exports = (req, res, next) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) return response.unauthorized(res, "Token topilmadi");

  try {
    const secret = process.env.JWT_SECRET_KEY;
    if (!secret) return response.serverError(res, "JWT_SECRET_KEY topilmadi");
    const payload = jwt.verify(token, secret, {
      issuer: "yamaha-api",
      audience: "yamaha-admin",
    });
    if (payload.role !== "admin") return response.forbidden(res, "Faqat admin");
    const tokenTgUserId = normalizeString(payload.tgUserId);
    const sessionTgUserId = normalizeString(req?.telegramAuth?.tgUserId);
    if (!tokenTgUserId || !sessionTgUserId || tokenTgUserId !== sessionTgUserId) {
      return response.unauthorized(res, "Admin Telegram sessiyasi mos emas");
    }

    const method = normalizeString(req.method).toUpperCase();
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      const authDateSec = Number(req?.telegramAuth?.authDateSec || 0);
      const maxAgeSec = Math.max(
        30,
        Number(process.env.TG_INIT_DATA_MAX_AGE_SEC_CRITICAL || 300),
      );
      const ageSec = Math.floor(Date.now() / 1000) - authDateSec;
      if (!authDateSec || ageSec < -30 || ageSec > maxAgeSec) {
        return response.unauthorized(
          res,
          "Admin amali uchun Telegram sessiyasini yangilang",
          { code: "stale_admin_telegram_session" },
        );
      }
    }
    req.admin = payload;
    next();
  } catch (error) {
    return response.unauthorized(res, "Token yaroqsiz yoki muddati tugagan");
  }
};
