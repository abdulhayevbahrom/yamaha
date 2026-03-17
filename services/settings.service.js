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

async function getStarPricing() {
  const doc = await Settings.findOne({ key: "star_pricing" }).lean();
  if (!doc?.value) return DEFAULT_STAR_PRICING;
  return {
    pricePerStar: Number(doc.value.pricePerStar || DEFAULT_STAR_PRICING.pricePerStar),
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

module.exports = {
  getStarPricing,
  getForceJoin,
  updateStarPricing,
  updateForceJoin,
};
