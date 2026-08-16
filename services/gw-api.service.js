const axios = require("axios");
const https = require("node:https");

const DEFAULT_BASE_URL = "https://api.sonofutred.com";
const PUBG_GROWTH_PACK_AMOUNTS = new Map([
  ["GWPSFP", 1],
  ["GWPSMP", 2],
  ["GWPSMYTH", 3],
  ["GWWEMBLM", 4],
]);

function normalize(value) {
  return String(value || "").trim();
}

function readPath(object, path) {
  return path.split(".").reduce((current, key) => (
    current && typeof current === "object" ? current[key] : undefined
  ), object);
}

function compactTextFields(item, paths) {
  return paths
    .map((path) => normalize(readPath(item, path)).toLowerCase())
    .filter(Boolean)
    .join(" ");
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
    baseURL: parsed.href.replace(/\/+$/, ""),
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
  const rows =
    payload?.products ||
    payload?.data?.products ||
    payload?.innerData?.products ||
    (Array.isArray(payload?.data) ? payload.data : null) ||
    (Array.isArray(payload?.innerData) ? payload.innerData : null);
  return Array.isArray(rows) ? rows : [];
}

function unwrapServices(payload) {
  const rows =
    payload?.services ||
    payload?.data?.services ||
    payload?.innerData?.services ||
    (Array.isArray(payload?.data) ? payload.data : null) ||
    (Array.isArray(payload?.innerData) ? payload.innerData : null);
  return Array.isArray(rows) ? rows : [];
}

function compactGwRow(row) {
  if (!row || typeof row !== "object") return row;
  return {
    id: normalize(row.id || row.pid || row.PID),
    slug: normalize(row.slug),
    gameName: normalize(row.gameName || row.game?.name || row.product?.gameName),
    serviceName: normalize(row.serviceName || row.name || row.label || row.service?.name || row.product?.name),
    category: normalize(row.category || row.categoryName || row.service?.category),
    type: normalize(row.type),
    price: row.price ?? row.priceUsd ?? null,
    status: normalize(row.status),
  };
}

function logGwSnapshot({ source, endpoint, payload, rows }) {
  const safeRows = (Array.isArray(rows) ? rows : [])
    .slice(0, 20)
    .map(compactGwRow);
  const keys =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? Object.keys(payload).slice(0, 20)
      : [];
  console.log("[GW_Genshin_Debug]", JSON.stringify({
    source,
    endpoint,
    topLevelKeys: keys,
    count: Array.isArray(rows) ? rows.length : 0,
    sample: safeRows,
  }));
}

function createClientForBaseUrl(baseURL) {
  const apiKey = normalize(process.env.GW_API_KEY);
  if (!apiKey) throw new Error("GW_API_KEY topilmadi");
  return axios.create({
    baseURL,
    timeout: Math.max(3_000, Number(process.env.GW_API_TIMEOUT_MS || 20_000)),
    httpsAgent: new https.Agent({ family: 4 }),
    headers: {
      "X-API-Key": apiKey,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  });
}

async function fetchProductsFromClient(client) {
  const response = await client.get("/products");
  return unwrapProducts(response.data);
}

async function fetchGwEndpointSnapshot(baseUrl, endpoint) {
  const client = createClientForBaseUrl(baseUrl);
  const response = await client.get(endpoint);
  const payload = response.data;
  const rows = endpoint === "/services" ? unwrapServices(payload) : unwrapProducts(payload);
  return { payload, rows };
}

async function logGwGenshinDebugSnapshots() {
  const config = getConfig();
  for (const endpoint of ["/services", "/products"]) {
    try {
      const { payload, rows } = await fetchGwEndpointSnapshot(config.baseURL, endpoint);
      logGwSnapshot({ source: config.baseURL, endpoint, payload, rows });
    } catch (error) {
      const status = Number(error?.response?.status || 0);
      console.error("[GW_Genshin_Debug]", JSON.stringify({
        source: config.baseURL,
        endpoint,
        error: status || error?.code || error?.message || "failed",
        message: String(error?.response?.data?.message || error?.response?.data?.error || error?.message || "").slice(0, 500),
      }));
    }
  }
}

async function fetchProductsWithFallback() {
  const config = getConfig();
  const rows = await fetchProductsFromClient(createClientForBaseUrl(config.baseURL));
  if (rows.length) return { rows, baseUrl: config.baseURL };
  const error = new Error(`GW products katalogi bo'sh qaytdi (source=${config.baseURL})`);
  error.code = "GW_PRODUCTS_EMPTY";
  throw error;
}

function isPubgTopup(item) {
  const providerProductId = normalize(item?.id || item?.pid || item?.PID).toUpperCase();
  if (PUBG_GROWTH_PACK_AMOUNTS.has(providerProductId)) return true;
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

function isPubgRedeem(item) {
  const text = [item?.slug, item?.gameName, item?.serviceName, item?.category, item?.type]
    .map((value) => normalize(value).toLowerCase())
    .join(" ");
  return text.includes("pubg") && (
    text.includes("gamekey") || text.includes("game key") ||
    text.includes("giftcard") || text.includes("redeem") || text.includes("code")
  );
}

function isMlbbTopup(item) {
  const providerProductId = normalize(item?.id || item?.pid || item?.PID).toUpperCase();
  const text = [item?.slug, item?.gameName, item?.serviceName, item?.category]
    .map((value) => normalize(value).toLowerCase())
    .join(" ");
  return (
    (providerProductId.startsWith("GWML") || text.includes("mobile legends") || text.includes("mlbb")) &&
    !text.includes("gamekey") &&
    !text.includes("giftcard") &&
    !text.includes("code")
  );
}

function isHokTopup(item) {
  const providerProductId = normalize(item?.id || item?.pid || item?.PID).toUpperCase();
  const text = [item?.slug, item?.gameName, item?.serviceName, item?.name, item?.category]
    .map((value) => normalize(value).toLowerCase())
    .join(" ");
  return (
    providerProductId.startsWith("GWHK") ||
    text.includes("honor of kings") ||
    text.includes("honour of kings")
  ) && !text.includes("giftcard") && !text.includes("gamekey");
}

function isGenshinTopup(item) {
  const providerProductId = normalize(item?.id || item?.pid || item?.PID).toUpperCase();
  const text = compactTextFields(item, [
    "slug",
    "gameName",
    "game.name",
    "game.title",
    "product.gameName",
    "product.name",
    "product.title",
    "serviceName",
    "service.name",
    "service.title",
    "name",
    "label",
    "title",
    "category",
    "categoryName",
    "type",
  ]);
  const isExcluded = (
    text.includes("giftcard") ||
    text.includes("gift card") ||
    text.includes("gamekey") ||
    text.includes("game key") ||
    text.includes("redeem") ||
    text.includes("code")
  );
  return (
    /^GWG\d/.test(providerProductId) ||
    providerProductId.startsWith("GWGI") ||
    providerProductId.startsWith("GWGEN") ||
    providerProductId.startsWith("GIGC") ||
    providerProductId.startsWith("GI") ||
    text.includes("genshin") ||
    text.includes("hoyoverse") ||
    text.includes("mihoyo") ||
    text.includes("genesis crystal") ||
    text.includes("welkin") ||
    text.includes("chronal nexus")
  ) && !isExcluded;
}

function isRobloxTopup(item) {
  const providerProductId = normalize(item?.id || item?.pid || item?.PID).toUpperCase();
  const text = compactTextFields(item, [
    "slug",
    "gameName",
    "game.name",
    "game.title",
    "product.gameName",
    "product.name",
    "product.title",
    "serviceName",
    "service.name",
    "service.title",
    "name",
    "label",
    "title",
    "category",
    "categoryName",
    "type",
  ]);
  const isExcluded = (
    text.includes("giftcard") ||
    text.includes("gift card") ||
    text.includes("gamekey") ||
    text.includes("game key") ||
    text.includes("redeem") ||
    text.includes("code")
  );
  return (
    providerProductId.startsWith("GWRB") ||
    providerProductId.startsWith("GWRLX") ||
    providerProductId.startsWith("GWROBLOX") ||
    text.includes("roblox") ||
    text.includes("robux")
  ) && !isExcluded;
}

function extractMlbbRegion(item) {
  const explicit = normalize(item?.region || item?.country || item?.server).toLowerCase();
  const pid = normalize(item?.id || item?.pid || item?.PID).toUpperCase();
  if (/^GWMLMY/.test(pid)) return "my";
  if (/^GWML(?:TU|TR)/.test(pid)) return "tr";
  if (/^GWMLRU/.test(pid)) return "ru";
  if (/^GWML?S/.test(pid)) return "sg";
  if (/^GWMI/.test(pid)) return "id";
  if (/^GWMP/.test(pid)) return "ph";
  const slug = normalize(item?.slug).toLowerCase().replace(/[^a-z]/g, "");
  const slugRegion = ["ph", "ru", "tr", "id", "sg", "my"].find(
    (key) => slug.endsWith(key) || slug.includes(`mlbb${key}`) || slug.includes(`mobilelegends${key}`),
  );
  if (slugRegion) return slugRegion;
  const text = [item?.slug, item?.gameName, item?.serviceName, item?.category, explicit]
    .map((value) => normalize(value).toLowerCase())
    .join(" ");
  const checks = [
    ["ph", /(^|[^a-z])(ph|philippines|philippine)([^a-z]|$)/],
    ["ru", /(^|[^a-z])(ru|russia|russian|cis)([^a-z]|$)/],
    ["tr", /(^|[^a-z])(tr|turkey|turkish|turkiye)([^a-z]|$)/],
    ["id", /(^|[^a-z])(id|indonesia|indonesian)([^a-z]|$)/],
    ["sg", /(^|[^a-z])(sg|singapore)([^a-z]|$)/],
    ["my", /(^|[^a-z])(my|malaysia|malaysian)([^a-z]|$)/],
  ];
  return checks.find(([, pattern]) => pattern.test(text))?.[0] || "global";
}

function extractHokRegion(item) {
  const explicit = normalize(item?.region || item?.country || item?.server).toLowerCase();
  const text = [item?.slug, item?.gameName, item?.serviceName, item?.name, item?.category, explicit]
    .map((value) => normalize(value).toLowerCase())
    .join(" ");
  if (/tw\/?hk\/?mo|hong\s*kong|macau|macao|taiwan/.test(text)) return "tw_hk_mo";
  if (/(^|[^a-z])america(s)?([^a-z]|$)|\bna\b|north\s*america|latin\s*america/.test(text)) return "america";
  if (/(^|[^a-z])europe([^a-z]|$)|\beu\b/.test(text)) return "europe";
  if (/(^|[^a-z])asia([^a-z]|$)|sea|global/.test(text)) return "asia";
  return "global";
}

function extractUcAmount(item) {
  const candidates = [
    item?.serviceName,
    item?.service?.name,
    item?.product?.name,
    item?.name,
    item?.label,
    item?.title,
    item?.amount,
  ];
  for (const value of candidates) {
    const match = normalize(value).match(/\d[\d,]*/);
    if (match) return Number(match[0].replace(/,/g, ""));
  }
  return 0;
}

function normalizeProduct(item) {
  const providerProductId = normalize(item?.id || item?.pid || item?.PID);
  const amount =
    extractUcAmount(item) ||
    PUBG_GROWTH_PACK_AMOUNTS.get(providerProductId.toUpperCase()) ||
    0;
  const priceUsd = Number(item?.price || item?.priceUsd || item?.usdPrice || item?.cost || 0);
  const rawQuantity = item?.quantity ?? item?.stock ?? item?.availableQuantity;
  const parsedQuantity = rawQuantity === undefined || rawQuantity === null || rawQuantity === ""
    ? null
    : Number(rawQuantity);
  const stockQuantity = Number.isFinite(parsedQuantity) && parsedQuantity >= 0
    ? Math.floor(parsedQuantity)
    : null;
  return {
    providerProductId,
    amount,
    code: amount > 0 ? String(amount) : providerProductId,
    label: normalize(item?.serviceName || item?.service?.name || item?.product?.name || item?.name || item?.label || item?.title || `${amount} UC`),
    priceUsd: Number.isFinite(priceUsd) ? priceUsd : 0,
    stockQuantity,
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

async function getPubgRedeemProducts() {
  const response = await createClient().get("/products");
  return unwrapProducts(response.data)
    .filter(isPubgRedeem)
    .map(normalizeProduct)
    .filter((item) => item.providerProductId && item.amount > 0 && item.priceUsd > 0);
}

async function getMlbbProducts() {
  const response = await createClient().get("/products");
  return unwrapProducts(response.data)
    .filter(isMlbbTopup)
    .map((item) => ({ ...normalizeProduct(item), region: extractMlbbRegion(item) }))
    .filter((item) => item.providerProductId && item.amount > 0 && item.priceUsd > 0);
}

async function getHokProducts() {
  const response = await createClient().get("/products");
  return unwrapProducts(response.data)
    .filter(isHokTopup)
    .map((item) => ({ ...normalizeProduct(item), region: extractHokRegion(item) }))
    .filter((item) => item.providerProductId && item.priceUsd > 0);
}

async function getGenshinProducts() {
  await logGwGenshinDebugSnapshots();
  const { rows, baseUrl } = await fetchProductsWithFallback();
  const products = rows
    .filter(isGenshinTopup)
    .map(normalizeProduct)
    .filter((item) => item.providerProductId && item.priceUsd > 0);
  if (products.length) return products;

  const sample = rows
    .slice(0, 30)
    .map((item) => normalize(item?.id || item?.pid || item?.PID || item?.serviceName || item?.name))
    .filter(Boolean)
    .slice(0, 12)
    .join(", ");
  const error = new Error(
    `GW Genshin Impact katalogi topilmadi (source=${baseUrl}, total=${rows.length}, sample=${sample || "-"})`,
  );
  error.code = "GW_GENSHIN_PRODUCTS_EMPTY";
  throw error;
}

async function getRobloxProducts() {
  const { rows, baseUrl } = await fetchProductsWithFallback();
  const products = rows
    .filter(isRobloxTopup)
    .map(normalizeProduct)
    .filter((item) => item.providerProductId && item.priceUsd > 0);
  if (products.length) return products;

  const sample = rows
    .slice(0, 30)
    .map((item) => normalize(item?.id || item?.pid || item?.PID || item?.serviceName || item?.name))
    .filter(Boolean)
    .slice(0, 12)
    .join(", ");
  const error = new Error(
    `GW Roblox katalogi topilmadi (source=${baseUrl}, total=${rows.length}, sample=${sample || "-"})`,
  );
  error.code = "GW_ROBLOX_PRODUCTS_EMPTY";
  throw error;
}

async function createOrder(body) {
  const response = await createClient().post("/orders", body);
  return response.data;
}

async function createGameKeyOrder(body) {
  const response = await createClient().post("/orders/gamekey", body);
  return response.data;
}

async function createRedeemOrder(body) {
  const client = createClient();
  try {
    const response = await client.post("/orders/pid", body);
    return response.data;
  } catch (error) {
    // Keep compatibility with the legacy GW deployment already used by this app.
    if (Number(error?.response?.status || 0) !== 404) throw error;
    const response = await client.post("/orders", body);
    return response.data;
  }
}

async function createPidOrder(body) {
  const client = createClient();
  try {
    const response = await client.post("/orders/pid", body);
    return response.data;
  } catch (error) {
    // Keep compatibility with the legacy GW deployment already used by this app.
    if (Number(error?.response?.status || 0) !== 404) throw error;
    const response = await client.post("/orders", body);
    return response.data;
  }
}

async function getOrder(orderId) {
  const response = await createClient().get(`/orders/${encodeURIComponent(orderId)}`);
  return response.data;
}

async function verifyPubgPlayer(playerId, trxid) {
  const response = await createClient().post("/pubgvvfy", { playerId, trxid });
  return response.data;
}

async function verifyMlbbPlayer(userId, zoneId, trxid) {
  const response = await createClient().post("/mlvfy", { userId, zoneId, trxid });
  return response.data;
}

module.exports = {
  getPubgProducts,
  getPubgRedeemProducts,
  getMlbbProducts,
  getHokProducts,
  getGenshinProducts,
  getRobloxProducts,
  createOrder,
  createGameKeyOrder,
  createRedeemOrder,
  createPidOrder,
  getOrder,
  verifyPubgPlayer,
  verifyMlbbPlayer,
  isPubgTopup,
  isPubgRedeem,
  isMlbbTopup,
  isHokTopup,
  isGenshinTopup,
  isRobloxTopup,
  extractMlbbRegion,
  extractHokRegion,
  extractUcAmount,
  normalizeProduct,
  fetchProductsWithFallback,
};
