const Settings = require("../model/settings.model");

const DEFAULT_STAR_PRICING = {
  pricePerStar: 220,
  min: 50,
  max: 10000,
};

const DEFAULT_FORCE_JOIN = {
  enabled: false,
  channelId: "",
  joinUrl: "",
};

const DEFAULT_BOT_STATUS = {
  enabled: true,
};

const DEFAULT_PAYMENT_CARD_CONFIG = {
  selectionMode: "sequential",
  monthlyMaxTransactions: 50,
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

async function getPaymentCardConfig() {
  const doc = await Settings.findOne({ key: "payment_card_config" }).lean();
  if (!doc?.value) return DEFAULT_PAYMENT_CARD_CONFIG;

  const selectionMode =
    doc.value.selectionMode === "random"
      ? "random"
      : DEFAULT_PAYMENT_CARD_CONFIG.selectionMode;
  const monthlyMaxTransactions = Number(
    doc.value.monthlyMaxTransactions ||
      DEFAULT_PAYMENT_CARD_CONFIG.monthlyMaxTransactions,
  );

  return {
    selectionMode,
    monthlyMaxTransactions:
      Number.isFinite(monthlyMaxTransactions) && monthlyMaxTransactions > 0
        ? monthlyMaxTransactions
        : DEFAULT_PAYMENT_CARD_CONFIG.monthlyMaxTransactions,
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

async function updatePaymentCardConfig(payload) {
  const selectionMode =
    payload.selectionMode === "random" ? "random" : "sequential";
  const monthlyMaxTransactions = Number(payload.monthlyMaxTransactions);

  if (!Number.isFinite(monthlyMaxTransactions) || monthlyMaxTransactions <= 0) {
    throw new Error("monthlyMaxTransactions noto'g'ri");
  }

  const doc = await Settings.findOneAndUpdate(
    { key: "payment_card_config" },
    { value: { selectionMode, monthlyMaxTransactions } },
    { new: true, upsert: true },
  ).lean();

  return {
    selectionMode:
      doc?.value?.selectionMode === "random" ? "random" : "sequential",
    monthlyMaxTransactions: Number(doc?.value?.monthlyMaxTransactions || 0),
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

module.exports = {
  getStarPricing,
  getForceJoin,
  getBotStatus,
  getPaymentCardConfig,
  getBankomatTopupConfig,
  getReferralConfig,
  getNftMarketplaceConfig,
  updateStarPricing,
  updateForceJoin,
  updateBotStatus,
  updatePaymentCardConfig,
  updateBankomatTopupConfig,
  updateReferralConfig,
  updateNftMarketplaceConfig,
};
