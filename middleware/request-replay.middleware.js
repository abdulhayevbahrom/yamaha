const response = require("../utils/response");

function normalizeString(value) {
  return String(value || "").trim();
}

function toSafeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const replayStore = new Map();
let lastCleanupAt = 0;

function cleanup(nowMs) {
  if (nowMs - lastCleanupAt < 30_000) return;
  lastCleanupAt = nowMs;

  for (const [key, expiresAt] of replayStore.entries()) {
    if (!expiresAt || expiresAt <= nowMs) {
      replayStore.delete(key);
    }
  }
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

  return (req, res, next) => {
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

    const now = Date.now();
    cleanup(now);

    if (replayStore.has(replayKey)) {
      return response.unauthorized(res, "Takroriy so'rov aniqlandi", {
        code: "duplicate_request",
      });
    }

    replayStore.set(replayKey, now + windowMs);
    return next();
  };
}

module.exports = {
  createRequestReplayGuard,
};
