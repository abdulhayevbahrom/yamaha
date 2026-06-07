const SecurityRateLimit = require("../model/security-rate-limit.model");

function normalizeString(value) {
  return String(value || "").trim();
}

function toSafeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
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

function getRequestIp(req) {
  return (
    normalizeIp(req.ip) ||
    normalizeIp(req.socket?.remoteAddress) ||
    "unknown"
  );
}

function createRateLimit(options = {}) {
  const windowMs = Math.max(1000, toSafeNumber(options.windowMs, 60_000));
  const max = Math.max(1, toSafeNumber(options.max, 60));
  const keyPrefix = normalizeString(options.keyPrefix || "global");
  return async (req, res, next) => {
    const now = Date.now();

    const customKey =
      typeof options.keyGenerator === "function"
        ? normalizeString(options.keyGenerator(req))
        : "";
    const identity = customKey || getRequestIp(req);
    const windowId = Math.floor(now / windowMs);
    const key = `${keyPrefix}:${identity}:${windowId}`;
    const expiresAt = new Date((windowId + 1) * windowMs + windowMs);

    let current;
    try {
      current = await SecurityRateLimit.findOneAndUpdate(
        { key },
        {
          $inc: { count: 1 },
          $setOnInsert: { expiresAt },
        },
        { new: true, upsert: true },
      ).lean();
    } catch (error) {
      if (error?.code === 11000) {
        current = await SecurityRateLimit.findOneAndUpdate(
          { key },
          { $inc: { count: 1 } },
          { new: true },
        ).lean();
      }
      if (current) {
        // Continue with the bucket created by the competing request.
      } else {
        return res.status(503).json({
          state: false,
          message: "So'rov limitini tekshirib bo'lmadi. Qayta urinib ko'ring.",
          innerData: { code: "RATE_LIMIT_STORE_UNAVAILABLE" },
        });
      }
    }

    if (Number(current?.count || 0) <= max) {
      return next();
    }

    const retryAfterSec = Math.max(
      1,
      Math.ceil(((windowId + 1) * windowMs - now) / 1000),
    );
    res.setHeader("Retry-After", String(retryAfterSec));

    return res.status(429).json({
      state: false,
      message: "Juda ko'p so'rov yuborildi. Birozdan keyin urinib ko'ring.",
      innerData: {
        code: "RATE_LIMITED",
        retryAfterSec,
      },
    });
  };
}

module.exports = {
  createRateLimit,
};
