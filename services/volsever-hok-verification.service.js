const axios = require("axios");
const https = require("node:https");

const ENDPOINT = "https://gate.volsever.com/proxy/api/game/honor-of-kings";
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
  return { valid, playerId, playerName, game: String(data.game || "Honor of Kings").trim(), payload };
}

async function verifyVolseverHokPlayer(playerId) {
  const normalized = normalizePlayerId(playerId);
  if (!/^\d{4,32}$/.test(normalized)) throw new Error("Honor of Kings Player ID noto'g'ri");
  const cached = cache.get(normalized);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  const response = await axios.get(ENDPOINT, {
    params: { id: normalized },
    timeout: Math.max(3_000, Number(process.env.VOLSEVER_API_TIMEOUT_MS || 12_000)),
    httpsAgent: new https.Agent({ family: 4 }),
    headers: { "X-API-KEY": getApiKey(), Accept: "application/json" },
  });
  const result = normalizeResult(response.data, normalized);
  if (!result.valid) {
    const error = new Error(String(response.data?.message || "Honor of Kings profil topilmadi"));
    error.code = "PLAYER_NOT_FOUND";
    throw error;
  }
  cache.set(normalized, { result, expiresAt: Date.now() + CACHE_TTL_MS });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return result;
}

module.exports = { verifyVolseverHokPlayer, normalizeResult };
