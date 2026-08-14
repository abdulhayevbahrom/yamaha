const crypto = require("node:crypto");
const { verifyMlbbPlayer } = require("./gw-api.service");

const CACHE_TTL_MS = Math.max(60_000, Number(process.env.GW_MLBB_VERIFY_CACHE_TTL_MS || 10 * 60_000));
const CACHE_LIMIT = 1_000;
const cache = new Map();
const inFlight = new Map();

function normalize(value) {
  return String(value || "").trim();
}

function getMlbbBonusTier(plan) {
  const text = normalize(plan?.label || plan?.serviceName || plan?.name);
  const match = text.match(/(\d+)\s*\+\s*(\d+)/);
  return match ? `${Number(match[1])}+${Number(match[2])}` : "";
}

function isMlbbBonusPlan(plan) {
  const label = normalize(plan?.label || plan?.serviceName || plan?.name);
  return Boolean(getMlbbBonusTier(plan)) && /first\s*bonus|bonus/i.test(label);
}

function normalizeVerification(payload, playerId, zoneId) {
  const firstTimeBonus = Array.isArray(payload?.firstTimeBonus)
    ? payload.firstTimeBonus.map((item) => ({
      tier: normalize(item?.tier),
      status: normalize(item?.status).toLowerCase(),
    })).filter((item) => item.tier)
    : [];
  return {
    playerId,
    zoneId,
    profileName: normalize(payload?.playerName || payload?.name),
    region: normalize(payload?.region),
    firstTimeBonus,
    verifiedAt: new Date().toISOString(),
    payload,
  };
}

async function verifyMlbbAccount(playerIdValue, zoneIdValue) {
  const playerId = normalize(playerIdValue);
  const zoneId = normalize(zoneIdValue);
  if (!/^\d+$/.test(playerId) || !/^\d+$/.test(zoneId)) throw new Error("Player ID yoki Zone ID noto'g'ri");
  const key = `${playerId}:${zoneId}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.savedAt <= CACHE_TTL_MS) return cached.value;
  if (inFlight.has(key)) return inFlight.get(key);

  const pending = (async () => {
    const trxid = `CHK-ML-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`.slice(0, 80);
    const payload = await verifyMlbbPlayer(playerId, zoneId, trxid);
    if (payload?.success !== true) throw new Error(normalize(payload?.error) || "MLBB profil topilmadi");
    const value = normalizeVerification(payload, playerId, zoneId);
    if (!value.profileName) throw new Error("MLBB profil topilmadi");
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
    cache.set(key, { savedAt: Date.now(), value });
    return value;
  })();
  inFlight.set(key, pending);
  try {
    return await pending;
  } finally {
    inFlight.delete(key);
  }
}

function isBonusTierAvailable(verification, tier) {
  const normalizedTier = normalize(tier).replace(/\s/g, "");
  return verification?.firstTimeBonus?.some(
    (item) => normalize(item.tier).replace(/\s/g, "") === normalizedTier && item.status === "available",
  ) || false;
}

module.exports = { verifyMlbbAccount, getMlbbBonusTier, isMlbbBonusPlan, isBonusTierAvailable };
