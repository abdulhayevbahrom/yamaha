function normalizeString(value) {
  return String(value || "").trim();
}

function readFirstEnv(keys = []) {
  for (const key of keys) {
    const value = normalizeString(process.env[key]);
    if (value) {
      return {
        key,
        value,
      };
    }
  }

  return {
    key: "",
    value: "",
  };
}

function parseApiId(rawValue) {
  const parsed = Number(normalizeString(rawValue));
  return Number.isFinite(parsed) ? parsed : 0;
}

const TELEGRAM_SCOPE_CONFIG = {
  gift: {
    label: "gift/nft",
    apiIdKeys: ["GIFT_TG_API_ID", "TG_GIFT_API_ID", "TG_API_ID"],
    apiHashKeys: ["GIFT_TG_API_HASH", "TG_GIFT_API_HASH", "TG_API_HASH"],
    sessionKeys: ["GIFT_TG_USER_SESSION", "TG_GIFT_USER_SESSION", "TG_USER_SESSION"],
  },
  cardxabar: {
    label: "cardxabar",
    apiIdKeys: ["CARDXABAR_TG_API_ID", "TG_CARDXABAR_API_ID", "TG_API_ID"],
    apiHashKeys: ["CARDXABAR_TG_API_HASH", "TG_CARDXABAR_API_HASH", "TG_API_HASH"],
    sessionKeys: [
      "CARDXABAR_TG_USER_SESSION",
      "TG_CARDXABAR_USER_SESSION",
      "TG_USER_SESSION",
    ],
  },
  premium_check: {
    label: "premium-check",
    apiIdKeys: [
      "PREMIUM_CHECK_TG_API_ID",
      "TG_PREMIUM_CHECK_API_ID",
      "CARDXABAR_TG_API_ID",
      "TG_CARDXABAR_API_ID",
      "TG_API_ID",
    ],
    apiHashKeys: [
      "PREMIUM_CHECK_TG_API_HASH",
      "TG_PREMIUM_CHECK_API_HASH",
      "CARDXABAR_TG_API_HASH",
      "TG_CARDXABAR_API_HASH",
      "TG_API_HASH",
    ],
    sessionKeys: [
      "PREMIUM_CHECK_TG_USER_SESSION",
      "TG_PREMIUM_CHECK_USER_SESSION",
      "CARDXABAR_TG_USER_SESSION",
      "TG_CARDXABAR_USER_SESSION",
      "TG_USER_SESSION",
    ],
  },
};

function resolveScopeConfig(scope = "gift") {
  const normalizedScope = normalizeString(scope).toLowerCase();
  if (TELEGRAM_SCOPE_CONFIG[normalizedScope]) {
    return {
      scope: normalizedScope,
      ...TELEGRAM_SCOPE_CONFIG[normalizedScope],
    };
  }

  return {
    scope: "gift",
    ...TELEGRAM_SCOPE_CONFIG.gift,
  };
}

function getTelegramCredentials(scope = "gift") {
  const config = resolveScopeConfig(scope);
  const apiIdResolved = readFirstEnv(config.apiIdKeys);
  const apiHashResolved = readFirstEnv(config.apiHashKeys);
  const sessionResolved = readFirstEnv(config.sessionKeys);

  return {
    scope: config.scope,
    label: config.label,
    apiId: parseApiId(apiIdResolved.value),
    apiHash: apiHashResolved.value,
    sessionString: sessionResolved.value,
    resolvedKeys: {
      apiId: apiIdResolved.key,
      apiHash: apiHashResolved.key,
      session: sessionResolved.key,
    },
    preferredKeys: {
      apiId: config.apiIdKeys[0],
      apiHash: config.apiHashKeys[0],
      session: config.sessionKeys[0],
    },
    acceptedKeys: {
      apiId: [...config.apiIdKeys],
      apiHash: [...config.apiHashKeys],
      session: [...config.sessionKeys],
    },
  };
}

module.exports = {
  getTelegramCredentials,
};
