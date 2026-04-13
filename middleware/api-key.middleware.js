const crypto = require("node:crypto");
const response = require("../utils/response");

function normalizeString(value) {
  return String(value || "").trim();
}

function timingSafeEqualString(left, right) {
  const leftBuffer = Buffer.from(String(left || ""), "utf8");
  const rightBuffer = Buffer.from(String(right || ""), "utf8");

  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

module.exports = (req, res, next) => {
  const expected = normalizeString(
    process.env.INTERNAL_API_KEY || process.env.CARDXABAR_INTERNAL_API_KEY,
  );
  if (!expected) {
    return response.serverError(
      res,
      "INTERNAL_API_KEY sozlanmagan",
      "missing_internal_api_key",
    );
  }

  const authorization = normalizeString(req.headers.authorization);
  const bearerLike = authorization.match(/^(?:apikey|bearer)\s+(.+)$/i);
  const provided =
    normalizeString(req.headers["x-api-key"]) ||
    normalizeString(bearerLike?.[1]);

  if (!provided || !timingSafeEqualString(provided, expected)) {
    return response.unauthorized(res, "API key xato", { code: "invalid_api_key" });
  }

  return next();
};
