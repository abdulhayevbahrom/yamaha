const axios = require("axios");

const BASE_URL = "https://portal-market.com/partners";
const CBU_USD_URL = "https://cbu.uz/uz/arkhiv-kursov-valyut/json/USD/";
const RATE_CACHE_TTL_MS = 10 * 60 * 1000;
let rateCache = null;
let rateRequest = null;

function normalizeString(value) {
  return String(value || "").trim();
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getApiKey() {
  return normalizeString(process.env.PORTALS_PARTNER_API_KEY);
}

function requireApiKey() {
  const apiKey = getApiKey();
  if (!apiKey) {
    const error = new Error("Portals Partner API kaliti sozlanmagan");
    error.code = "PORTALS_API_KEY_MISSING";
    throw error;
  }
  return apiKey;
}

function getClient() {
  return axios.create({
    baseURL: BASE_URL,
    timeout: 15_000,
    headers: {
      Authorization: `partners ${requireApiKey()}`,
      Accept: "application/json",
    },
  });
}

function getAttribute(nft, type) {
  const wanted = normalizeString(type).toLowerCase();
  const attributes = Array.isArray(nft?.attributes) ? nft.attributes : [];
  return attributes.find((item) => {
    const key = normalizeString(
      item?.type || item?.trait_type || item?.name || item?.key,
    ).toLowerCase();
    return key === wanted;
  }) || null;
}

function attributeValue(attribute) {
  return normalizeString(
    attribute?.value || attribute?.value_name || attribute?.label,
  );
}

function attributeRarity(attribute) {
  const raw = attribute?.rarity ?? attribute?.rarity_percent;
  const numeric = toNumber(raw, 0);
  if (!numeric) return "";
  return `${numeric}%`;
}

function mapPortalsNft(raw) {
  const id = normalizeString(raw?.id);
  const model = getAttribute(raw, "model");
  const backdrop = getAttribute(raw, "backdrop");
  const symbol = getAttribute(raw, "symbol");

  return {
    provider: "portals",
    providerNftId: id,
    nftId: id ? `portals:${id}` : "",
    tgId: normalizeString(raw?.tg_id),
    slug: normalizeString(raw?.tg_id),
    title: normalizeString(raw?.name) || "NFT Gift",
    nftNumber: Math.max(0, Math.trunc(toNumber(raw?.external_collection_number, 0))),
    collectionId: normalizeString(raw?.collection_id),
    priceGram: normalizeString(raw?.price),
    floorPriceGram: normalizeString(raw?.floor_price),
    imageUrl: normalizeString(raw?.photo_url),
    animationUrl: normalizeString(raw?.animation_url),
    hasAnimation: Boolean(raw?.has_animation),
    model: attributeValue(model),
    modelRarity: attributeRarity(model),
    backdrop: attributeValue(backdrop),
    backdropRarity: attributeRarity(backdrop),
    symbol: attributeValue(symbol),
    symbolRarity: attributeRarity(symbol),
    status: normalizeString(raw?.status),
    isOwned: Boolean(raw?.is_owned),
    listedAt: raw?.listed_at || null,
    raw,
  };
}

async function searchPortalsNfts({ limit = 100, offset = 0, ids = [] } = {}) {
  const safeLimit = Math.min(Math.max(Math.trunc(toNumber(limit, 100)), 1), 100);
  const params = { limit: safeLimit, offset: Math.max(0, Math.trunc(toNumber(offset, 0))) };
  if (Array.isArray(ids) && ids.length) params.ids = ids;

  const result = await getClient().get("/nfts/search", {
    params,
    paramsSerializer: (values) => {
      const query = new URLSearchParams();
      Object.entries(values).forEach(([key, value]) => {
        if (Array.isArray(value)) value.forEach((item) => query.append(key, item));
        else query.append(key, value);
      });
      return query.toString();
    },
  });
  const rows = Array.isArray(result?.data?.results) ? result.data.results : [];
  return {
    totalCount: Math.max(0, Math.trunc(toNumber(result?.data?.total_count, rows.length))),
    items: rows.map(mapPortalsNft).filter((item) => item.providerNftId),
  };
}

async function getPortalsNft(providerNftId) {
  const id = normalizeString(providerNftId).replace(/^portals:/, "");
  if (!id) return null;
  const result = await searchPortalsNfts({ limit: 1, ids: [id] });
  return result.items.find((item) => item.providerNftId === id) || null;
}

async function buyPortalsNft({ providerNftId, expectedPriceGram }) {
  const id = normalizeString(providerNftId).replace(/^portals:/, "");
  const price = normalizeString(expectedPriceGram);
  if (!id || !price) throw new Error("Portals NFT ID yoki narxi topilmadi");

  const result = await getClient().post("/nfts", {
    nft_details: [{ id, price }],
  });
  const purchaseResults = Array.isArray(result?.data?.purchase_results)
    ? result.data.purchase_results
    : [];
  const itemResult = purchaseResults.find((item) => normalizeString(item?.id) === id)
    || purchaseResults[0]
    || null;
  if (!itemResult || normalizeString(itemResult.status).toLowerCase() !== "success") {
    const error = new Error(
      normalizeString(itemResult?.error_message) || "Portals NFT xaridi bajarilmadi",
    );
    error.code = normalizeString(itemResult?.reason) || "PORTALS_PURCHASE_FAILED";
    error.definitive = true;
    error.providerResponse = result?.data;
    throw error;
  }
  return { result: itemResult, response: result.data };
}

async function fetchPortalsGramRateUzs() {
  const [portalsResult, cbuResult] = await Promise.all([
    getClient().get("/market/config"),
    axios.get(CBU_USD_URL, { timeout: 10_000, headers: { Accept: "application/json" } }),
  ]);
  const gramUsd = toNumber(portalsResult?.data?.usd_course, 0);
  const cbuRows = Array.isArray(cbuResult?.data) ? cbuResult.data : [];
  const usdRow = cbuRows.find((item) => normalizeString(item?.Ccy).toUpperCase() === "USD")
    || cbuRows[0]
    || null;
  const usdUzs = toNumber(usdRow?.Rate, 0);
  if (gramUsd <= 0 || usdUzs <= 0) {
    throw new Error("GRAM/USD yoki USD/UZS kursi olinmadi");
  }
  return {
    gramUsd,
    usdUzs,
    gramUzs: gramUsd * usdUzs,
    source: "portals_usd_x_cbu_uzs",
    updatedAt: new Date().toISOString(),
  };
}

async function getPortalsGramRateUzs({ force = false } = {}) {
  if (!force && rateCache && Date.now() - rateCache.cachedAt < RATE_CACHE_TTL_MS) {
    return rateCache.value;
  }
  if (rateRequest) return rateRequest;
  rateRequest = fetchPortalsGramRateUzs()
    .then((value) => {
      rateCache = { value, cachedAt: Date.now() };
      return value;
    })
    .finally(() => {
      rateRequest = null;
    });
  return rateRequest;
}

module.exports = {
  getApiKey,
  mapPortalsNft,
  searchPortalsNfts,
  getPortalsNft,
  buyPortalsNft,
  getPortalsGramRateUzs,
};
