const axios = require("axios");
const https = require("node:https");

const ENDPOINTS = {
  hok: "https://gate.volsever.com/proxy/api/game/honor-of-kings",
  freefire: "https://gate.volsever.com/proxy/api/game/free-fire",
  bloodstrike: "https://gate.volsever.com/proxy/api/game/blood-strike",
  deltaforce: "https://gate.volsever.com/proxy/api/game/delta-force",
};
const CACHE_TTL_MS = 5 * 60_000;
const cache = new Map();

function normalizePlayerId(value) {
  return String(value || "").trim();
}

function getApiKey() {
  const apiKey = String(process.env.VOLSEVER_API_KEY || "").trim();
  if (!apiKey) throw new Error("VOLSEVER_API_KEY topilmadi");
  return apiKey;
}

function normalizeResult(payload, requestedPlayerId) {
  const data = payload?.data && typeof payload.data === "object" ? payload.data : {};
  const playerName = String(data.username || data.nickname || data.name || payload?.username || "").trim();
  const playerId = normalizePlayerId(data.user_id || data.userId || requestedPlayerId);
  const valid = payload?.status === true && Number(payload?.code || 200) === 200 && Boolean(playerName);
  return { valid, playerId, playerName, game: String(data.game || "").trim(), payload };
}

function logVerifyResponse(gameKey, requestedPlayerId, payload, normalizedResult) {
  if (gameKey !== "freefire") return;
  const data = payload?.data && typeof payload.data === "object" ? payload.data : {};
  console.log("[VOLSEVER_VERIFY]", JSON.stringify({
    gameKey,
    requestedPlayerId,
    status: payload?.status,
    code: payload?.code,
    message: String(payload?.message || "").slice(0, 300),
    rootUsername: String(payload?.username || "").slice(0, 120),
    dataUsername: String(data.username || "").slice(0, 120),
    dataNickname: String(data.nickname || "").slice(0, 120),
    dataName: String(data.name || "").slice(0, 120),
    dataUserId: String(data.user_id || data.userId || "").slice(0, 80),
    normalizedPlayerName: String(normalizedResult?.playerName || "").slice(0, 120),
    valid: Boolean(normalizedResult?.valid),
  }));
}

async function verifyVolseverGamePlayer({ gameKey, playerId, label, idPattern }) {
  const normalized = normalizePlayerId(playerId);
  if (!idPattern.test(normalized)) throw new Error(`${label} Player ID noto'g'ri`);
  const endpoint = ENDPOINTS[gameKey];
  if (!endpoint) throw new Error(`${label} tekshiruv endpointi sozlanmagan`);
  const cacheKey = `${gameKey}:${normalized}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  const response = await axios.get(endpoint, {
    params: { id: normalized },
    timeout: Math.max(3_000, Number(process.env.VOLSEVER_API_TIMEOUT_MS || 12_000)),
    httpsAgent: new https.Agent({ family: 4 }),
    headers: { "X-API-KEY": getApiKey(), Accept: "application/json" },
  });
  const normalizedResult = normalizeResult(response.data, normalized);
  logVerifyResponse(gameKey, normalized, response.data, normalizedResult);
  const result = { ...normalizedResult, game: normalizedResult.game || label };
  if (!result.valid) {
    const error = new Error(String(response.data?.message || `${label} profil topilmadi`));
    error.code = "PLAYER_NOT_FOUND";
    throw error;
  }
  cache.set(cacheKey, { result, expiresAt: Date.now() + CACHE_TTL_MS });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return result;
}

async function verifyVolseverHokPlayer(playerId) {
  return verifyVolseverGamePlayer({
    gameKey: "hok",
    playerId,
    label: "Honor of Kings",
    idPattern: /^\d{4,32}$/,
  });
}

async function verifyVolseverFreeFirePlayer(playerId) {
  return verifyVolseverGamePlayer({
    gameKey: "freefire",
    playerId,
    label: "Free Fire",
    idPattern: /^\d{5,15}$/,
  });
}

async function verifyVolseverBloodStrikePlayer(playerId) {
  return verifyVolseverGamePlayer({
    gameKey: "bloodstrike",
    playerId,
    label: "Blood Strike",
    idPattern: /^\d{4,32}$/,
  });
}

async function verifyVolseverDeltaForcePlayer(playerId) {
  return verifyVolseverGamePlayer({
    gameKey: "deltaforce",
    playerId,
    label: "Delta Force",
    idPattern: /^\d{4,32}$/,
  });
}

module.exports = {
  verifyVolseverHokPlayer,
  verifyVolseverFreeFirePlayer,
  verifyVolseverBloodStrikePlayer,
  verifyVolseverDeltaForcePlayer,
  normalizeResult,
};
