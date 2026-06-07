const crypto = require("node:crypto");
const axios = require("axios");
const response = require("../utils/response");

const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

function normalizeString(value) {
  return String(value || "").trim();
}

function isEnabled(value) {
  return ["1", "true", "yes", "on"].includes(
    normalizeString(value).toLowerCase(),
  );
}

function createTurnstileGuard(options = {}) {
  const protectedPrefixes = Array.isArray(options.protectedPrefixes)
    ? options.protectedPrefixes
        .map((item) => normalizeString(item))
        .filter(Boolean)
    : [];

  return async (req, res, next) => {
    if (!isEnabled(process.env.TURNSTILE_ENABLED)) return next();

    const method = normalizeString(req.method).toUpperCase();
    const path = normalizeString(req.path || req.originalUrl || "");
    if (
      !["POST", "PUT", "PATCH", "DELETE"].includes(method) ||
      !protectedPrefixes.some((prefix) => path.startsWith(prefix))
    ) {
      return next();
    }

    const secret = normalizeString(process.env.TURNSTILE_SECRET_KEY);
    if (!secret) {
      return response.serverError(
        res,
        "Turnstile server sozlamasi topilmadi",
        "turnstile_secret_missing",
      );
    }

    const token = normalizeString(
      req.headers["x-turnstile-token"] ||
        req.body?.turnstileToken ||
        req.body?.["cf-turnstile-response"],
    );
    if (!token || token.length > 2048) {
      return response.unauthorized(res, "Turnstile tekshiruvi talab qilinadi", {
        code: "turnstile_token_missing",
      });
    }

    const requestId = normalizeString(req.headers["x-request-id"]);
    const idempotencyKey = /^[a-f0-9-]{36}$/i.test(requestId)
      ? requestId
      : crypto.randomUUID();
    const body = new URLSearchParams({
      secret,
      response: token,
      remoteip: normalizeString(req.ip),
      idempotency_key: idempotencyKey,
    });

    let verification;
    try {
      const verifyResponse = await axios.post(SITEVERIFY_URL, body, {
        headers: { "content-type": "application/x-www-form-urlencoded" },
        timeout: 8_000,
      });
      verification = verifyResponse.data;
    } catch (error) {
      return response.serverError(
        res,
        "Turnstile tekshiruv xizmati vaqtincha ishlamayapti",
        error?.code === "ECONNABORTED"
          ? "turnstile_timeout"
          : "turnstile_unavailable",
      );
    }

    const expectedAction = normalizeString(
      process.env.TURNSTILE_EXPECTED_ACTION || "api_write",
    );
    const allowedHostnames = normalizeString(
      process.env.TURNSTILE_ALLOWED_HOSTNAMES,
    )
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
    const hostname = normalizeString(verification?.hostname).toLowerCase();

    if (
      !verification?.success ||
      (expectedAction && verification?.action !== expectedAction) ||
      (allowedHostnames.length && !allowedHostnames.includes(hostname))
    ) {
      return response.unauthorized(res, "Turnstile tekshiruvi muvaffaqiyatsiz", {
        code: "turnstile_invalid",
      });
    }

    return next();
  };
}

module.exports = {
  createTurnstileGuard,
};
