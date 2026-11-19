const axios = require("axios");

const CBU_USD_URL = "https://cbu.uz/uz/arkhiv-kursov-valyut/json/USD/";
const RATE_CACHE_TTL_MS = 10 * 60 * 1000;
let rateCache = null;
let rateRequest = null;

async function fetchUsdUzsRate() {
  const response = await axios.get(CBU_USD_URL, {
    timeout: 10_000,
    headers: { Accept: "application/json" },
  });
  const rows = Array.isArray(response.data) ? response.data : [];
  const usdRow = rows.find((row) => String(row?.Ccy ?? "").trim().toUpperCase() === "USD");
  const rawRate = usdRow?.Rate;
  const rate = typeof rawRate === "string" || typeof rawRate === "number" ? Number(rawRate) : NaN;
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error("Markaziy bank USD/UZS kursi olinmadi");
  }
  return rate;
}

async function getUsdUzsRate({ force = false } = {}) {
  if (!force && rateCache && Date.now() - rateCache.cachedAt < RATE_CACHE_TTL_MS) {
    return rateCache.value;
  }
  if (rateRequest) return rateRequest;

  rateRequest = fetchUsdUzsRate()
    .then((value) => {
      rateCache = { value, cachedAt: Date.now() };
      return value;
    })
    .finally(() => {
      rateRequest = null;
    });
  return rateRequest;
}

module.exports = { getUsdUzsRate };
