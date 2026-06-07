const response = require("../utils/response");
const SecurityNonce = require("../model/security-nonce.model");

function normalizeString(value) {
  return String(value || "").trim();
}

function toSafeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function createRequestReplayGuard(options = {}) {
  const windowMs = Math.max(
    10_000,
    toSafeNumber(options.windowMs, 120_000),
  );
  const ignorePrefixes = Array.isArray(options.ignorePrefixes)
    ? options.ignorePrefixes.map((item) => normalizeString(item)).filter(Boolean)
    : [];
  const protectedMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

  return async (req, res, next) => {
    const method = normalizeString(req.method).toUpperCase();
    if (!protectedMethods.has(method)) return next();

    const path = normalizeString(req.path || req.originalUrl || "");
    if (ignorePrefixes.some((prefix) => path.startsWith(prefix))) {
      return next();
    }

    const requestId = normalizeString(req.headers["x-request-id"]);
    if (!requestId || requestId.length < 12 || requestId.length > 128) {
      return response.unauthorized(res, "So'rov identifikatori talab qilinadi", {
        code: "missing_request_id",
      });
    }

    const actorId =
      normalizeString(req?.telegramAuth?.tgUserId) ||
      normalizeString(req.ip) ||
      "unknown";
    const replayKey = `${actorId}:${method}:${path}:${requestId}`;

    try {
      await SecurityNonce.create({
        key: `webapp:${replayKey}`,
        expiresAt: new Date(Date.now() + windowMs),
      });
    } catch (error) {
      if (error?.code === 11000) {
        return response.unauthorized(res, "Takroriy so'rov aniqlandi", {
          code: "duplicate_request",
        });
      }
      return response.serverError(
        res,
        "So'rov himoyasini tekshirib bo'lmadi",
        "replay_store_unavailable",
      );
    }
    return next();
  };
}

module.exports = {
  createRequestReplayGuard,
};
