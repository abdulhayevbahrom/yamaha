const { Logger } = require("telegram/extensions/Logger");

function normalizeString(value) {
  return String(value || "").trim();
}

function isEnabled(value, fallback = true) {
  const normalized = normalizeString(value).toLowerCase();
  if (!normalized) return fallback;
  return !["0", "false", "no", "off"].includes(normalized);
}

function toPositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.trunc(parsed);
}

function resolveTelegramLogLevel() {
  const requested = normalizeString(process.env.TELEGRAM_CLIENT_LOG_LEVEL).toLowerCase();
  const allowed = new Set(["none", "error", "warn", "info", "debug"]);
  if (allowed.has(requested)) {
    return requested;
  }
  return "error";
}

function buildTelegramClientOptions({ connectionRetries = 5 } = {}) {
  return {
    connectionRetries: toPositiveInt(
      process.env.TELEGRAM_CONNECTION_RETRIES,
      toPositiveInt(connectionRetries, 5),
    ),
    useWSS: isEnabled(process.env.TELEGRAM_USE_WSS, true),
    autoReconnect: isEnabled(process.env.TELEGRAM_AUTO_RECONNECT, true),
    baseLogger: new Logger(resolveTelegramLogLevel()),
  };
}

module.exports = {
  buildTelegramClientOptions,
};
