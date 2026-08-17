const axios = require("axios");
const https = require("node:https");

const ENDPOINTS = {
  hok: "https://gate.volsever.com/proxy/api/game/honor-of-kings",
  freefire: "https://gate.volsever.com/proxy/api/game/free-fire-global",
  bloodstrike: "https://gate.volsever.com/proxy/api/game/blood-strike",
  deltaforce: "https://gate.volsever.com/proxy/api/game/delta-force",
};
const CACHE_TTL_MS = 5 * 60_000;
const cache = new Map();
const VOLSEVER_BASE_URL = "https://gate.volsever.com/proxy/api/game";
const DEFAULT_FREEFIRE_ENDPOINTS = [
  "free-fire-global",
  "free-fire-asia",
  "free-fire-eu",
  "free-fire-us",
  "free-fire-mena",
  "free-fire-ru",
  "free-fire-india",
  "free-fire-indonesia",
  "free-fire-global-ws",
  "free-fire-asia-ws",
  "free-fire-eu-ws",
  "free-fire-us-ws",
  "free-fire-mena-ws",
  "free-fire-ru-ws",
  "free-fire-india-ws",
];

function normalizePlayerId(value) {
  return String(value || "").trim();
}

function getApiKey() {
  const apiKey = String(process.env.VOLSEVER_API_KEY || "").trim();
  if (!apiKey) throw new Error("VOLSEVER_API_KEY topilmadi");
  return apiKey;
}

function pickString(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function getNestedValue(source, path) {
  return path.reduce((current, key) => {
    if (!current || typeof current !== "object") return undefined;
    return current[key];
  }, source);
}

function getPlayerNameFromPayload(payload) {
  const data = payload?.data && typeof payload.data === "object" ? payload.data : {};
  const basicInfo = payload?.basicInfo && typeof payload.basicInfo === "object" ? payload.basicInfo : {};
  const accountInfo = payload?.accountInfo && typeof payload.accountInfo === "object" ? payload.accountInfo : {};
  const profile = payload?.profile && typeof payload.profile === "object" ? payload.profile : {};
  return pickString(
    data.username,
    data.nickname,
    data.name,
    data.playerName,
    data.player_name,
    data.nickName,
    data.basicInfo?.nickname,
    data.basicinfo?.nickname,
    data.accountInfo?.nickname,
    basicInfo.nickname,
    accountInfo.nickname,
    profile.nickname,
    profile.username,
    payload?.username,
    payload?.nickname,
    payload?.name,
    payload?.playerName,
    getNestedValue(payload, ["result", "nickname"]),
    getNestedValue(payload, ["result", "username"]),
  );
}

function getPlayerIdFromPayload(payload, requestedPlayerId) {
  const data = payload?.data && typeof payload.data === "object" ? payload.data : {};
  return normalizePlayerId(pickString(
    data.user_id,
    data.userId,
    data.uid,
    data.playerId,
    data.accountId,
    data.basicInfo?.accountId,
    data.basicinfo?.accountId,
    payload?.uid,
    payload?.userId,
    payload?.playerId,
    payload?.basicInfo?.accountId,
    payload?.accountInfo?.accountId,
    getNestedValue(payload, ["result", "uid"]),
    getNestedValue(payload, ["result", "accountId"]),
    requestedPlayerId,
  ));
}

function normalizeResult(payload, requestedPlayerId) {
  const data = payload?.data && typeof payload.data === "object" ? payload.data : {};
  const playerName = getPlayerNameFromPayload(payload);
  const playerId = getPlayerIdFromPayload(payload, requestedPlayerId);
  const code = Number(payload?.code || payload?.statusCode || 200);
  const statusOk = payload?.status === undefined || payload?.status === true || payload?.success === true;
  const valid = statusOk && code >= 200 && code < 300 && Boolean(playerName);
  return { valid, playerId, playerName, game: String(data.game || "").trim(), payload };
}

function getFreeFireEndpointSlugs() {
  const configured = String(process.env.VOLSEVER_FREEFIRE_ENDPOINTS || process.env.VOLSEVER_FREEFIRE_ENDPOINT || "")
    .split(",")
    .map((item) => item.trim().replace(/^\/?api\/game\//, "").replace(/^\/+/, ""))
    .filter(Boolean);
  return Array.from(new Set([...(configured.length ? configured : []), ...DEFAULT_FREEFIRE_ENDPOINTS]));
}

function buildEndpointUrl(gameKey) {
  if (gameKey !== "freefire") return [ENDPOINTS[gameKey]].filter(Boolean);
  return getFreeFireEndpointSlugs().map((slug) => `${VOLSEVER_BASE_URL}/${slug}`);
}

function isEndpointNotAllowed(error) {
  const data = error?.response?.data || {};
  return Number(error?.response?.status || 0) === 403 && String(data?.error || "").trim() === "ENDPOINT_NOT_ALLOWED";
}

function isPlayerNotFoundError(error) {
  const status = Number(error?.response?.status || 0);
  const data = error?.response?.data || {};
  const message = String(data?.message || error?.message || "").toLowerCase();
  return [400, 404, 422].includes(status) || /not found|invalid|topilmadi/.test(message);
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
  const endpoints = buildEndpointUrl(gameKey);
  if (!endpoints.length) throw new Error(`${label} tekshiruv endpointi sozlanmagan`);
  const cacheKey = `${gameKey}:${normalized}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  let response = null;
  let lastError = null;
  let normalizedResult = null;
  for (const endpoint of endpoints) {
    try {
      response = await axios.get(endpoint, {
        params: { id: normalized },
        timeout: Math.max(3_000, Number(process.env.VOLSEVER_API_TIMEOUT_MS || 12_000)),
        httpsAgent: new https.Agent({ family: 4 }),
        headers: { "X-API-KEY": getApiKey(), Accept: "application/json" },
      });
      normalizedResult = normalizeResult(response.data, normalized);
      logVerifyResponse(gameKey, normalized, response.data, normalizedResult);
      if (gameKey === "freefire" && !normalizedResult.valid) {
        console.warn("[VOLSEVER_FREEFIRE_ENDPOINT_INVALID]", JSON.stringify({
          endpoint,
          status: response.data?.status,
          code: response.data?.code,
          message: String(response.data?.message || "").slice(0, 300),
          playerName: String(normalizedResult.playerName || "").slice(0, 120),
        }));
        lastError = new Error(String(response.data?.message || `${label} profil topilmadi`));
        lastError.code = "PLAYER_NOT_FOUND";
        response = null;
        continue;
      }
      if (gameKey === "freefire") {
        console.log("[VOLSEVER_FREEFIRE_ENDPOINT]", JSON.stringify({ endpoint }));
      }
      break;
    } catch (error) {
      lastError = error;
      if (gameKey === "freefire" && isEndpointNotAllowed(error)) {
        console.warn("[VOLSEVER_FREEFIRE_ENDPOINT_NOT_ALLOWED]", JSON.stringify({
          endpoint,
          status: Number(error?.response?.status || 0),
          message: String(error?.response?.data?.message || error?.message || "").slice(0, 300),
        }));
        continue;
      }
      if (gameKey === "freefire" && isPlayerNotFoundError(error)) {
        console.warn("[VOLSEVER_FREEFIRE_ENDPOINT_NOT_FOUND]", JSON.stringify({
          endpoint,
          status: Number(error?.response?.status || 0),
          message: String(error?.response?.data?.message || error?.message || "").slice(0, 300),
        }));
        continue;
      }
      throw error;
    }
  }
  if (!response) throw lastError || new Error(`${label} tekshiruv endpointi ishlamadi`);
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
