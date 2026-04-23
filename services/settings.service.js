const Settings = require("../model/settings.model");

const DEFAULT_STAR_PRICING = {
  pricePerStar: 220,
  min: 50,
  max: 10000,
};

const DEFAULT_GAME_STARS_PAYMENT_CONFIG = {
  pricePerStar: 220,
};

const DEFAULT_STAR_SELL_PRICING = {
  pricePerStar: 220,
  min: 1,
  max: 10000,
};
const MIN_STAR_SELL_PAYOUT_UZS = 1000;

const DEFAULT_FORCE_JOIN = {
  enabled: false,
  channelId: "",
  joinUrl: "",
};

const DEFAULT_BOT_STATUS = {
  enabled: true,
};

const DEFAULT_BOT_BROADCAST_CONFIG = {
  sendOnResume: true,
  resumeText: "Bot faoliyatini boshladi. Qayta /start bosib davom etishingiz mumkin.",
  sendOnPause: true,
  pauseText: "Bot vaqtincha to'xtatildi. Xizmatlar qisqa muddatga ishlamaydi.",
};

const DEFAULT_PAYMENT_CARD_CONFIG = {
  selectionMode: "sequential",
  dailyMaxTransactions: 50,
};

const DEFAULT_BANKOMAT_TOPUP_CONFIG = {
  feePercent: 3,
};

const DEFAULT_REFERRAL_CONFIG = {
  signupBonusAmount: 0,
  orderPercent: 0,
};

const DEFAULT_NFT_MARKETPLACE_CONFIG = {
  feePercent: 5,
  withdrawFeeUzs: 0,
};

async function getStarPricing() {
  const doc = await Settings.findOne({ key: "star_pricing" }).lean();
  if (!doc?.value) return DEFAULT_STAR_PRICING;
  return {
    pricePerStar: Number(
      doc.value.pricePerStar || DEFAULT_STAR_PRICING.pricePerStar,
    ),
    min: Number(doc.value.min || DEFAULT_STAR_PRICING.min),
    max: Number(doc.value.max || DEFAULT_STAR_PRICING.max),
  };
}

async function getForceJoin() {
  const doc = await Settings.findOne({ key: "force_join" }).lean();
  if (!doc?.value) return DEFAULT_FORCE_JOIN;
  return {
    enabled: Boolean(doc.value.enabled),
    channelId: String(doc.value.channelId || "").trim(),
    joinUrl: String(doc.value.joinUrl || "").trim(),
  };
}

async function getGameStarsPaymentConfig() {
  const doc = await Settings.findOne({ key: "game_stars_payment_config" }).lean();
  const configured = Number(doc?.value?.pricePerStar);
  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_GAME_STARS_PAYMENT_CONFIG;
  }
  return {
    pricePerStar: configured,
  };
}

async function getStarSellPricing() {
  const doc = await Settings.findOne({ key: "star_sell_pricing" }).lean();
  return normalizeStarSellPricing(doc?.value);
}

async function getBotStatus() {
  const doc = await Settings.findOne({ key: "bot_status" }).lean();
  if (!doc?.value) return DEFAULT_BOT_STATUS;
  return {
    enabled:
      typeof doc.value.enabled === "boolean"
        ? doc.value.enabled
        : DEFAULT_BOT_STATUS.enabled,
  };
}

function normalizeBotBroadcastText(value, fallback) {
  const text = String(value || "").trim();
  return text || fallback;
}

async function getBotBroadcastConfig() {
  const doc = await Settings.findOne({ key: "bot_broadcast_config" }).lean();
  if (!doc?.value) return DEFAULT_BOT_BROADCAST_CONFIG;

  return {
    sendOnResume:
      typeof doc.value.sendOnResume === "boolean"
        ? doc.value.sendOnResume
        : DEFAULT_BOT_BROADCAST_CONFIG.sendOnResume,
    resumeText: normalizeBotBroadcastText(
      doc.value.resumeText,
      DEFAULT_BOT_BROADCAST_CONFIG.resumeText,
    ),
    sendOnPause:
      typeof doc.value.sendOnPause === "boolean"
        ? doc.value.sendOnPause
        : DEFAULT_BOT_BROADCAST_CONFIG.sendOnPause,
    pauseText: normalizeBotBroadcastText(
      doc.value.pauseText,
      DEFAULT_BOT_BROADCAST_CONFIG.pauseText,
    ),
  };
}

async function getPaymentCardConfig() {
  const doc = await Settings.findOne({ key: "payment_card_config" }).lean();
  if (!doc?.value) return DEFAULT_PAYMENT_CARD_CONFIG;

  const selectionMode =
    doc.value.selectionMode === "random"
      ? "random"
      : DEFAULT_PAYMENT_CARD_CONFIG.selectionMode;
  // Backward compatibility: old configs may still store monthlyMaxTransactions.
  const dailyMaxTransactions = Number(
    doc.value.dailyMaxTransactions ||
      doc.value.monthlyMaxTransactions ||
      DEFAULT_PAYMENT_CARD_CONFIG.dailyMaxTransactions,
  );

  return {
    selectionMode,
    dailyMaxTransactions:
      Number.isFinite(dailyMaxTransactions) && dailyMaxTransactions > 0
        ? dailyMaxTransactions
        : DEFAULT_PAYMENT_CARD_CONFIG.dailyMaxTransactions,
  };
}

async function getBankomatTopupConfig() {
  const doc = await Settings.findOne({ key: "bankomat_topup_config" }).lean();
  if (!doc?.value) return DEFAULT_BANKOMAT_TOPUP_CONFIG;

  const feePercent = Number(doc.value.feePercent);
  return {
    feePercent:
      Number.isFinite(feePercent) && feePercent >= 0 && feePercent < 100
        ? feePercent
        : DEFAULT_BANKOMAT_TOPUP_CONFIG.feePercent,
  };
}

async function getReferralConfig() {
  const doc = await Settings.findOne({ key: "referral_config" }).lean();
  const signupBonusAmount = Number(doc?.value?.signupBonusAmount);
  const orderPercent = Number(doc?.value?.orderPercent);

  return {
    signupBonusAmount:
      Number.isFinite(signupBonusAmount) && signupBonusAmount >= 0
        ? signupBonusAmount
        : DEFAULT_REFERRAL_CONFIG.signupBonusAmount,
    orderPercent:
      Number.isFinite(orderPercent) && orderPercent >= 0 && orderPercent < 100
        ? orderPercent
        : DEFAULT_REFERRAL_CONFIG.orderPercent,
    botUsername: String(process.env.BOT_USERNAME || "")
      .trim()
      .replace(/^@+/, ""),
    botLink: String(process.env.BOT_LINK || "").trim(),
  };
}

async function getNftMarketplaceConfig() {
  const doc = await Settings.findOne({ key: "nft_marketplace_config" }).lean();
  if (!doc?.value) return DEFAULT_NFT_MARKETPLACE_CONFIG;

  const feePercent = Number(doc.value.feePercent);
  const withdrawFeeUzs = Number(doc.value.withdrawFeeUzs);
  return {
    feePercent:
      Number.isFinite(feePercent) && feePercent >= 0 && feePercent < 100
        ? feePercent
        : DEFAULT_NFT_MARKETPLACE_CONFIG.feePercent,
    withdrawFeeUzs:
      Number.isFinite(withdrawFeeUzs) && withdrawFeeUzs >= 0
        ? Math.round(withdrawFeeUzs)
        : DEFAULT_NFT_MARKETPLACE_CONFIG.withdrawFeeUzs,
  };
}

async function updateStarPricing(payload) {
  const pricePerStar = Number(payload.pricePerStar);
  const min = Number(payload.min);
  const max = Number(payload.max);

  if (!Number.isFinite(pricePerStar) || pricePerStar <= 0) {
    throw new Error("pricePerStar noto'g'ri");
  }
  if (!Number.isFinite(min) || min <= 0) {
    throw new Error("min noto'g'ri");
  }
  if (!Number.isFinite(max) || max <= min) {
    throw new Error("max noto'g'ri");
  }

  const doc = await Settings.findOneAndUpdate(
    { key: "star_pricing" },
    { value: { pricePerStar, min, max } },
    { new: true, upsert: true },
  ).lean();

  return doc.value;
}

async function updateForceJoin(payload) {
  const enabled = Boolean(payload.enabled);
  const channelId = String(payload.channelId || "").trim();
  const joinUrl = String(payload.joinUrl || "").trim();

  const doc = await Settings.findOneAndUpdate(
    { key: "force_join" },
    { value: { enabled, channelId, joinUrl } },
    { new: true, upsert: true },
  ).lean();

  return {
    enabled: Boolean(doc?.value?.enabled),
    channelId: String(doc?.value?.channelId || "").trim(),
    joinUrl: String(doc?.value?.joinUrl || "").trim(),
  };
}

async function updateGameStarsPaymentConfig(payload) {
  const pricePerStar = Number(payload?.pricePerStar);
  if (!Number.isFinite(pricePerStar) || pricePerStar <= 0) {
    throw new Error("gameStars pricePerStar noto'g'ri");
  }

  const doc = await Settings.findOneAndUpdate(
    { key: "game_stars_payment_config" },
    { value: { pricePerStar } },
    { new: true, upsert: true },
  ).lean();

  return {
    pricePerStar: Number(
      doc?.value?.pricePerStar ?? DEFAULT_GAME_STARS_PAYMENT_CONFIG.pricePerStar,
    ),
  };
}

async function updateBotStatus(payload) {
  const enabled = Boolean(payload.enabled);

  const doc = await Settings.findOneAndUpdate(
    { key: "bot_status" },
    { value: { enabled } },
    { new: true, upsert: true },
  ).lean();

  return {
    enabled:
      typeof doc?.value?.enabled === "boolean"
        ? doc.value.enabled
        : DEFAULT_BOT_STATUS.enabled,
  };
}

async function updateBotBroadcastConfig(payload) {
  const current = await getBotBroadcastConfig();
  const next = {
    sendOnResume:
      typeof payload?.sendOnResume === "boolean"
        ? payload.sendOnResume
        : current.sendOnResume,
    resumeText: normalizeBotBroadcastText(
      payload?.resumeText,
      current.resumeText,
    ),
    sendOnPause:
      typeof payload?.sendOnPause === "boolean"
        ? payload.sendOnPause
        : current.sendOnPause,
    pauseText: normalizeBotBroadcastText(payload?.pauseText, current.pauseText),
  };

  const doc = await Settings.findOneAndUpdate(
    { key: "bot_broadcast_config" },
    { value: next },
    { new: true, upsert: true },
  ).lean();

  return {
    sendOnResume:
      typeof doc?.value?.sendOnResume === "boolean"
        ? doc.value.sendOnResume
        : DEFAULT_BOT_BROADCAST_CONFIG.sendOnResume,
    resumeText: normalizeBotBroadcastText(
      doc?.value?.resumeText,
      DEFAULT_BOT_BROADCAST_CONFIG.resumeText,
    ),
    sendOnPause:
      typeof doc?.value?.sendOnPause === "boolean"
        ? doc.value.sendOnPause
        : DEFAULT_BOT_BROADCAST_CONFIG.sendOnPause,
    pauseText: normalizeBotBroadcastText(
      doc?.value?.pauseText,
      DEFAULT_BOT_BROADCAST_CONFIG.pauseText,
    ),
  };
}

async function updatePaymentCardConfig(payload) {
  const selectionMode =
    payload.selectionMode === "random" ? "random" : "sequential";
  // Accept both new and legacy field names from client.
  const dailyMaxTransactions = Number(
    payload?.dailyMaxTransactions ?? payload?.monthlyMaxTransactions,
  );

  if (!Number.isFinite(dailyMaxTransactions) || dailyMaxTransactions <= 0) {
    throw new Error("dailyMaxTransactions noto'g'ri");
  }

  const doc = await Settings.findOneAndUpdate(
    { key: "payment_card_config" },
    { value: { selectionMode, dailyMaxTransactions } },
    { new: true, upsert: true },
  ).lean();

  return {
    selectionMode:
      doc?.value?.selectionMode === "random" ? "random" : "sequential",
    dailyMaxTransactions: Number(
      doc?.value?.dailyMaxTransactions || doc?.value?.monthlyMaxTransactions || 0,
    ),
  };
}

async function updateBankomatTopupConfig(payload) {
  const feePercent = Number(payload.feePercent);

  if (!Number.isFinite(feePercent) || feePercent < 0 || feePercent >= 100) {
    throw new Error("feePercent noto'g'ri");
  }

  const doc = await Settings.findOneAndUpdate(
    { key: "bankomat_topup_config" },
    { value: { feePercent } },
    { new: true, upsert: true },
  ).lean();

  return {
    feePercent: Number(
      doc?.value?.feePercent ?? DEFAULT_BANKOMAT_TOPUP_CONFIG.feePercent,
    ),
  };
}

async function updateReferralConfig(payload) {
  const signupBonusAmount = Number(payload.signupBonusAmount);
  const orderPercent = Number(payload.orderPercent);

  if (!Number.isFinite(signupBonusAmount) || signupBonusAmount < 0) {
    throw new Error("signupBonusAmount noto'g'ri");
  }
  if (
    !Number.isFinite(orderPercent) ||
    orderPercent < 0 ||
    orderPercent >= 100
  ) {
    throw new Error("orderPercent noto'g'ri");
  }

  const doc = await Settings.findOneAndUpdate(
    { key: "referral_config" },
    { value: { signupBonusAmount, orderPercent } },
    { new: true, upsert: true },
  ).lean();

  return {
    signupBonusAmount: Number(
      doc?.value?.signupBonusAmount ??
        DEFAULT_REFERRAL_CONFIG.signupBonusAmount,
    ),
    orderPercent: Number(
      doc?.value?.orderPercent ?? DEFAULT_REFERRAL_CONFIG.orderPercent,
    ),
    botUsername: String(process.env.BOT_USERNAME || "")
      .trim()
      .replace(/^@+/, ""),
    botLink: String(process.env.BOT_LINK || "").trim(),
  };
}

async function updateNftMarketplaceConfig(payload) {
  const current = await getNftMarketplaceConfig();

  const feePercent =
    payload?.feePercent === undefined
      ? Number(current.feePercent)
      : Number(payload.feePercent);
  const withdrawFeeUzs =
    payload?.withdrawFeeUzs === undefined
      ? Number(current.withdrawFeeUzs)
      : Number(payload.withdrawFeeUzs);

  if (!Number.isFinite(feePercent) || feePercent < 0 || feePercent >= 100) {
    throw new Error("feePercent noto'g'ri");
  }
  if (!Number.isFinite(withdrawFeeUzs) || withdrawFeeUzs < 0) {
    throw new Error("withdrawFeeUzs noto'g'ri");
  }

  const doc = await Settings.findOneAndUpdate(
    { key: "nft_marketplace_config" },
    { value: { feePercent, withdrawFeeUzs: Math.round(withdrawFeeUzs) } },
    { new: true, upsert: true },
  ).lean();

  return {
    feePercent: Number(
      doc?.value?.feePercent ?? DEFAULT_NFT_MARKETPLACE_CONFIG.feePercent,
    ),
    withdrawFeeUzs: Number(
      doc?.value?.withdrawFeeUzs ??
        DEFAULT_NFT_MARKETPLACE_CONFIG.withdrawFeeUzs,
    ),
  };
}

async function updateStarSellPricing(payload) {
  const pricePerStar = Number(payload.pricePerStar);
  const max = Number(payload.max);

  if (!Number.isFinite(pricePerStar) || pricePerStar <= 0) {
    throw new Error("starSell pricePerStar noto'g'ri");
  }
  const min = resolveStarSellMinByPrice(pricePerStar);
  if (!Number.isFinite(max) || max < min) {
    throw new Error("starSell max noto'g'ri");
  }

  const doc = await Settings.findOneAndUpdate(
    { key: "star_sell_pricing" },
    { value: { pricePerStar, min, max } },
    { new: true, upsert: true },
  ).lean();

  return normalizeStarSellPricing(doc?.value);
}

function resolveStarSellMinByPrice(pricePerStar) {
  const numericPrice = Number(pricePerStar);
  const safePrice =
    Number.isFinite(numericPrice) && numericPrice > 0
      ? numericPrice
      : DEFAULT_STAR_SELL_PRICING.pricePerStar;
  return Math.max(1, Math.ceil(MIN_STAR_SELL_PAYOUT_UZS / safePrice));
}

function normalizeStarSellPricing(value) {
  const source = value && typeof value === "object" ? value : {};
  const rawPrice = Number(source.pricePerStar);
  const pricePerStar =
    Number.isFinite(rawPrice) && rawPrice > 0
      ? rawPrice
      : DEFAULT_STAR_SELL_PRICING.pricePerStar;
  const min = resolveStarSellMinByPrice(pricePerStar);
  const rawMax = Number(source.max);
  const defaultMax = Number(DEFAULT_STAR_SELL_PRICING.max);
  const maxCandidate =
    Number.isFinite(rawMax) && rawMax > 0 ? Math.floor(rawMax) : defaultMax;
  const max = Math.max(min, maxCandidate);

  return {
    pricePerStar,
    min,
    max,
  };
}

module.exports = {
  getStarPricing,
  getGameStarsPaymentConfig,
  getStarSellPricing,
  getForceJoin,
  getBotStatus,
  getBotBroadcastConfig,
  getPaymentCardConfig,
  getBankomatTopupConfig,
  getReferralConfig,
  getNftMarketplaceConfig,
  updateStarPricing,
  updateGameStarsPaymentConfig,
  updateStarSellPricing,
  updateForceJoin,
  updateBotStatus,
  updateBotBroadcastConfig,
  updatePaymentCardConfig,
  updateBankomatTopupConfig,
  updateReferralConfig,
  updateNftMarketplaceConfig,
};
