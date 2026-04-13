const response = require("../utils/response");

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeIp(raw) {
  const candidate = normalizeString(raw).split(",")[0].trim();
  if (!candidate) return "";
  if (candidate.startsWith("::ffff:")) return candidate.slice(7);
  return candidate;
}

function getClientIp(req) {
  return (
    normalizeIp(req.headers["x-forwarded-for"]) ||
    normalizeIp(req.headers["x-real-ip"]) ||
    normalizeIp(req.ip) ||
    normalizeIp(req.socket?.remoteAddress)
  );
}

function parseAllowlist() {
  const raw = normalizeString(process.env.INTEGRATION_IP_ALLOWLIST);
  if (!raw) return [];

  return raw
    .split(",")
    .map((item) => normalizeString(item))
    .filter(Boolean);
}

function matchesRule(ip, rule) {
  if (!ip || !rule) return false;
  if (rule.endsWith("*")) {
    const prefix = rule.slice(0, -1);
    return prefix ? ip.startsWith(prefix) : false;
  }
  return ip === rule;
}

module.exports = (req, res, next) => {
  const allowlist = parseAllowlist();
  if (!allowlist.length) {
    return next();
  }

  const clientIp = getClientIp(req);
  const allowed = allowlist.some((rule) => matchesRule(clientIp, rule));

  if (!allowed) {
    return response.forbidden(res, "IP ruxsat etilmagan", {
      code: "ip_not_allowed",
    });
  }

  return next();
};
