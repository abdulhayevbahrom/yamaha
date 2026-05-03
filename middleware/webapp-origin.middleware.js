const response = require("../utils/response");

function normalizeString(value) {
  return String(value || "").trim();
}

function createWebAppOriginGuard(options = {}) {
  const allowlist = new Set(
    Array.isArray(options.allowedOrigins)
      ? options.allowedOrigins.map((origin) => normalizeString(origin)).filter(Boolean)
      : [],
  );
  const ignorePrefixes = Array.isArray(options.ignorePrefixes)
    ? options.ignorePrefixes
        .map((item) => normalizeString(item))
        .filter(Boolean)
    : [];

  return (req, res, next) => {
    const path = normalizeString(req.path || req.originalUrl || "");
    if (ignorePrefixes.some((prefix) => path.startsWith(prefix))) {
      return next();
    }

    const origin = normalizeString(req.headers.origin);
    if (!origin || !allowlist.has(origin)) {
      return response.forbidden(res, "Faqat ruxsat berilgan WebApp originidan so'rov qabul qilinadi", {
        code: "origin_not_allowed",
      });
    }

    return next();
  };
}

module.exports = {
  createWebAppOriginGuard,
};
