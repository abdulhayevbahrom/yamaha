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
    normalizeIp(req.headers["x-forwarded-for"]) ||
    normalizeIp(req.headers["x-real-ip"]) ||
    normalizeIp(req.ip) ||
    normalizeIp(req.socket?.remoteAddress) ||
    "unknown"
  );
}

function createRateLimit(options = {}) {
  const windowMs = Math.max(1000, toSafeNumber(options.windowMs, 60_000));
  const max = Math.max(1, toSafeNumber(options.max, 60));
  const keyPrefix = normalizeString(options.keyPrefix || "global");
  const store = new Map();

  let lastCleanupAt = 0;

  const cleanup = (now) => {
    if (now - lastCleanupAt < 30_000) return;
    lastCleanupAt = now;

    for (const [key, bucket] of store.entries()) {
      if (!bucket || bucket.resetAt <= now) {
        store.delete(key);
      }
    }
  };

  return (req, res, next) => {
    const now = Date.now();
    cleanup(now);

    const customKey =
      typeof options.keyGenerator === "function"
        ? normalizeString(options.keyGenerator(req))
        : "";
    const identity = customKey || getRequestIp(req);
    const key = `${keyPrefix}:${identity}`;

    const current = store.get(key);
    if (!current || current.resetAt <= now) {
      store.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    current.count += 1;
    if (current.count <= max) {
      return next();
    }

    const retryAfterSec = Math.max(
      1,
      Math.ceil((current.resetAt - now) / 1000),
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
