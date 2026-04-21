const axios = require("axios");

const FRAGMENT_API_URL = String(
  process.env.FRAGMENT_API_URL || "https://fragment-api.uz/api/v1",
)
  .trim()
  .replace(/\/+$/, "");
const FRAGMENT_API_KEY = String(process.env.FRAGMENT_API_KEY || "").trim();
const FRAGMENT_API_TIMEOUT_MS = Math.max(
  Number(process.env.FRAGMENT_API_TIMEOUT_MS || 30_000) || 30_000,
  5_000,
);

const api = axios.create({
  baseURL: FRAGMENT_API_URL,
  timeout: FRAGMENT_API_TIMEOUT_MS,
  headers: {
    "Content-Type": "application/json",
  },
});

function ensureApiKey() {
  if (!FRAGMENT_API_KEY) {
    throw new Error("FRAGMENT_API_KEY .env da topilmadi");
  }
}

function normalizeUsername(value) {
  return String(value || "")
    .trim()
    .replace(/^@+/, "");
}

function buildApiError(message, payload, statusCode) {
  const error = new Error(String(message || "Fragment API xatolik"));
  error.fragmentPayload = payload || null;
  error.statusCode = Number(statusCode || 0);
  return error;
}

async function post(path, body = {}) {
  ensureApiKey();

  try {
    const response = await api.post(path, body, {
      headers: {
        "X-API-Key": FRAGMENT_API_KEY,
      },
    });
    const payload = response?.data;

    if (
      payload &&
      typeof payload === "object" &&
      !Array.isArray(payload) &&
      payload.ok === false
    ) {
      throw buildApiError(payload.message, payload, response.status);
    }

    return payload;
  } catch (error) {
    if (
      error?.response?.data &&
      typeof error.response.data === "object" &&
      !Array.isArray(error.response.data)
    ) {
      error.fragmentPayload = error.response.data;
    }

    throw error;
  }
}

async function buyStars(username, amount) {
  const cleaned = normalizeUsername(username);
  const normalizedAmount = Number(amount || 0);

  if (!cleaned) {
    throw new Error("Username kiriting");
  }
  if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) {
    throw new Error("Stars miqdori noto'g'ri");
  }

  const payload = await post("/stars/buy", {
    username: cleaned,
    amount: normalizedAmount,
  });

  return {
    raw: payload,
    result: payload?.result || null,
  };
}

async function buyPremium(username, duration) {
  const cleaned = normalizeUsername(username);
  const normalizedDuration = Number(duration || 0);

  if (!cleaned) {
    throw new Error("Username kiriting");
  }
  if (!Number.isFinite(normalizedDuration) || normalizedDuration <= 0) {
    throw new Error("Premium muddati noto'g'ri");
  }

  const payload = await post("/premium/buy", {
    username: cleaned,
    duration: normalizedDuration,
  });

  return {
    raw: payload,
    result: payload?.result || null,
  };
}

module.exports = {
  buyStars,
  buyPremium,
};
