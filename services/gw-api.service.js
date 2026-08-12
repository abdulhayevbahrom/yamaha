const axios = require("axios");
const https = require("node:https");

const DEFAULT_BASE_URL = "https://api.sonofutred.com";

function normalize(value) {
  return String(value || "").trim();
}

function getConfig() {
  const apiKey = normalize(process.env.GW_API_KEY);
  if (!apiKey) throw new Error("GW_API_KEY topilmadi");

  const baseURL = normalize(process.env.GW_API_URL) || DEFAULT_BASE_URL;
  const parsed = new URL(baseURL);
  if (parsed.protocol !== "https:") {
    throw new Error("GW_API_URL HTTPS bo'lishi kerak");
  }

  return {
    apiKey,
    baseURL: parsed.origin,
    timeout: Math.max(3_000, Number(process.env.GW_API_TIMEOUT_MS || 20_000)),
  };
}

function createClient() {
  const config = getConfig();
  return axios.create({
    baseURL: config.baseURL,
    timeout: config.timeout,
    // GW access control currently accepts allowlisted IPv4 addresses. Some
    // production hosts prefer IPv6 for Cloudflare DNS, which would otherwise
    // produce IP_NOT_ALLOWED even when the server IPv4 is correctly listed.
    httpsAgent: new https.Agent({ family: 4 }),
    headers: {
      "X-API-Key": config.apiKey,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  });
}

function unwrapProducts(payload) {
  const rows = payload?.products || payload?.data?.products || payload?.innerData?.products;
  return Array.isArray(rows) ? rows : [];
}

function isPubgTopup(item) {
  const text = [item?.slug, item?.gameName, item?.serviceName, item?.category]
    .map((value) => normalize(value).toLowerCase())
    .join(" ");
  return (
    text.includes("pubg") &&
    !text.includes("gamekey") &&
    !text.includes("giftcard") &&
    !text.includes("code")
  );
}

function extractUcAmount(item) {
  const candidates = [item?.serviceName, item?.name, item?.label, item?.amount];
  for (const value of candidates) {
    const match = normalize(value).match(/\d[\d,]*/);
    if (match) return Number(match[0].replace(/,/g, ""));
  }
  return 0;
}

function normalizeProduct(item) {
  const providerProductId = normalize(item?.id || item?.pid || item?.PID);
  const amount = extractUcAmount(item);
  const priceUsd = Number(item?.price || item?.priceUsd || 0);
  return {
    providerProductId,
    amount,
    code: amount > 0 ? String(amount) : providerProductId,
    label: normalize(item?.serviceName || item?.name || `${amount} UC`),
    priceUsd: Number.isFinite(priceUsd) ? priceUsd : 0,
    available:
      Number.isFinite(priceUsd) &&
      priceUsd > 0 &&
      normalize(item?.status).toLowerCase() !== "inactive" &&
      item?.inStock !== false,
    raw: item,
  };
}

async function getPubgProducts() {
  const response = await createClient().get("/products");
  return unwrapProducts(response.data)
    .filter(isPubgTopup)
    .map(normalizeProduct)
    .filter((item) => item.providerProductId && item.amount > 0 && item.priceUsd > 0);
}

async function createOrder(body) {
  const response = await createClient().post("/orders", body);
  return response.data;
}

async function getOrder(orderId) {
  const response = await createClient().get(`/orders/${encodeURIComponent(orderId)}`);
  return response.data;
}

module.exports = {
  getPubgProducts,
  createOrder,
  getOrder,
  isPubgTopup,
  extractUcAmount,
  normalizeProduct,
};
