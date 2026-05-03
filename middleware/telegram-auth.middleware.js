const crypto = require("node:crypto");
const response = require("../utils/response");

function normalizeString(value) {
  return String(value || "").trim();
}

function toSafeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sanitizeProfileName(value) {
  let name = normalizeString(value);
  if (!name) return "";

  try {
    name = name.normalize("NFKC");
  } catch (_) {
    // keep original if normalize fails
  }

  name = name
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, "")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (name.length > 64) {
    name = name.slice(0, 64).trim();
  }

  return name;
}

function resolveProfileName(user) {
  const firstName = normalizeString(user?.first_name);
  const lastName = normalizeString(user?.last_name);
  const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
  return sanitizeProfileName(fullName);
}

function buildDataCheckString(params) {
  const entries = [];
  for (const [key, value] of params.entries()) {
    if (key === "hash") continue;
    entries.push([key, value]);
  }
  entries.sort((left, right) => left[0].localeCompare(right[0]));
  return entries.map(([key, value]) => `${key}=${value}`).join("\n");
}

function parseInitData(initData) {
  const raw = normalizeString(initData);
  if (!raw) {
    return { ok: false, reason: "missing_init_data" };
  }

  const botToken = normalizeString(process.env.BOT_TOKEN);
  if (!botToken) {
    return { ok: false, reason: "missing_bot_token" };
  }

  let params;
  try {
    params = new URLSearchParams(raw);
  } catch (_) {
    return { ok: false, reason: "invalid_init_data_format" };
  }

  const providedHash = normalizeString(params.get("hash")).toLowerCase();
  if (!providedHash || !/^[a-f0-9]{64}$/.test(providedHash)) {
    return { ok: false, reason: "missing_hash" };
  }

  const dataCheckString = buildDataCheckString(params);
  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest();
  const expectedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  const providedBuffer = Buffer.from(providedHash, "hex");
  const expectedBuffer = Buffer.from(expectedHash, "hex");
  if (
    providedBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    return { ok: false, reason: "hash_mismatch" };
  }

  const authDateSec = toSafeNumber(params.get("auth_date"), 0);
  const maxAgeSec = Math.max(
    60,
    toSafeNumber(process.env.TG_INIT_DATA_MAX_AGE_SEC, 86400),
  );
  const nowSec = Math.floor(Date.now() / 1000);

  if (!authDateSec || Math.abs(nowSec - authDateSec) > maxAgeSec) {
    return { ok: false, reason: "expired" };
  }

  let parsedUser = null;
  try {
    parsedUser = JSON.parse(params.get("user") || "{}");
  } catch (_) {
    return { ok: false, reason: "invalid_user_payload" };
  }

  const tgUserId = normalizeString(parsedUser?.id);
  if (!tgUserId) {
    return { ok: false, reason: "missing_user_id" };
  }

  const username = normalizeString(parsedUser?.username);
  const firstName = normalizeString(parsedUser?.first_name);
  const lastName = normalizeString(parsedUser?.last_name);
  const profileName = resolveProfileName(parsedUser);

  return {
    ok: true,
    user: {
      tgUserId,
      username,
      firstName,
      lastName,
      profileName,
    },
    authDateSec,
  };
}

function requireTelegramAuth() {
  return (req, res, next) => {
    const initData = req.headers["x-tg-init-data"];
    const parsed = parseInitData(initData);

    if (!parsed.ok) {
      return response.unauthorized(
        res,
        "Telegram autentifikatsiyasi xato. WebAppni qayta oching.",
        { code: parsed.reason },
      );
    }

    const headerUserId = normalizeString(req.headers["x-tg-user-id"]);
    if (headerUserId && headerUserId !== parsed.user.tgUserId) {
      return response.unauthorized(res, "Telegram user mos emas", {
        code: "user_id_mismatch",
      });
    }

    req.telegramAuth = {
      verified: true,
      authDateSec: parsed.authDateSec,
      ...parsed.user,
    };
    return next();
  };
}

module.exports = {
  requireTelegramAuth,
  parseInitData,
};
