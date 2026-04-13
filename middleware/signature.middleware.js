const crypto = require("node:crypto");
const response = require("../utils/response");

function normalizeString(value) {
  return String(value || "").trim();
}

function toSafeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }

  if (value && typeof value === "object" && value.constructor === Object) {
    return Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .reduce((accumulator, key) => {
        accumulator[key] = canonicalize(value[key]);
        return accumulator;
      }, {});
  }

  return value;
}

function stableBodyString(body) {
  if (!body || typeof body !== "object") return "";
  try {
    return JSON.stringify(canonicalize(body));
  } catch (_) {
    return "";
  }
}

function normalizeSignature(value) {
  return normalizeString(value).replace(/^sha256=/i, "").toLowerCase();
}

function timingSafeEqualHex(leftHex, rightHex) {
  if (!/^[a-f0-9]{64}$/.test(leftHex) || !/^[a-f0-9]{64}$/.test(rightHex)) {
    return false;
  }

  const left = Buffer.from(leftHex, "hex");
  const right = Buffer.from(rightHex, "hex");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

const replayCache = new Map();
let lastReplayCleanupAt = 0;

function cleanupReplayCache(nowMs) {
  if (nowMs - lastReplayCleanupAt < 30_000) return;
  lastReplayCleanupAt = nowMs;

  for (const [key, expiresAt] of replayCache.entries()) {
    if (!expiresAt || expiresAt <= nowMs) {
      replayCache.delete(key);
    }
  }
}

module.exports = (req, res, next) => {
  const secret = normalizeString(process.env.INTERNAL_SIGNING_SECRET);
  if (!secret) {
    return response.serverError(
      res,
      "INTERNAL_SIGNING_SECRET sozlanmagan",
      "missing_internal_signing_secret",
    );
  }

  const timestampRaw = normalizeString(
    req.headers["x-signature-timestamp"] || req.headers["x-timestamp"],
  );
  const signatureRaw = normalizeSignature(req.headers["x-signature"]);
  const requestId = normalizeString(req.headers["x-request-id"]);

  const timestampSec = toSafeNumber(timestampRaw, 0);
  if (!timestampSec || !signatureRaw) {
    return response.unauthorized(res, "Signature headerlari topilmadi", {
      code: "missing_signature_headers",
    });
  }

  const maxSkewSec = Math.max(
    30,
    toSafeNumber(process.env.SIGNATURE_MAX_SKEW_SEC, 300),
  );
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - timestampSec) > maxSkewSec) {
    return response.unauthorized(res, "Signature vaqti eskirgan", {
      code: "signature_expired",
    });
  }

  const body = stableBodyString(req.body);
  const path = String(req.originalUrl || req.url || "").split("?")[0];
  const payload = `${timestampSec}.${req.method.toUpperCase()}.${path}.${body}`;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");

  if (!timingSafeEqualHex(signatureRaw, expected)) {
    return response.unauthorized(res, "Signature noto'g'ri", {
      code: "invalid_signature",
    });
  }

  if (requestId) {
    const nowMs = Date.now();
    cleanupReplayCache(nowMs);

    const replayKey = `${timestampSec}:${requestId}`;
    if (replayCache.has(replayKey)) {
      return response.unauthorized(res, "Takroriy so'rov aniqlandi", {
        code: "replay_detected",
      });
    }

    replayCache.set(replayKey, nowMs + maxSkewSec * 1000);
  }

  return next();
};
