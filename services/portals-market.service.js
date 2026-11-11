const axios = require("axios");

const BASE_URL = "https://portal-market.com/partners";
const CBU_USD_URL = "https://cbu.uz/uz/arkhiv-kursov-valyut/json/USD/";
const RATE_CACHE_TTL_MS = 10 * 60 * 1000;
const NFT_MEDIA_CACHE_TTL_MS = 60 * 60 * 1000;
const NFT_MEDIA_CACHE_MAX = 2000;
const PORTALS_SEARCH_RETRY_DELAYS_MS = [350, 900];
let rateCache = null;
let rateRequest = null;
const nftMediaCache = new Map();
let lastCatalogSearch = null;

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

  const imageUrl = normalizeString(raw?.photo_url);
  if (id && imageUrl) {
    if (nftMediaCache.size >= NFT_MEDIA_CACHE_MAX) {
      nftMediaCache.delete(nftMediaCache.keys().next().value);
    }
    nftMediaCache.set(id, {
      imageUrl,
      animationUrl: normalizeString(raw?.animation_url),
      tgId: normalizeString(raw?.tg_id),
      cachedAt: Date.now(),
    });
  }

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
    imageUrl,
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

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientPortalsError(error) {
  const status = Number(error?.response?.status || 0);
  return !status || status === 408 || status >= 500;
}

async function requestPortalsSearchPage(params) {
  let lastError;
  for (
    let attempt = 0;
    attempt <= PORTALS_SEARCH_RETRY_DELAYS_MS.length;
    attempt += 1
  ) {
    try {
      return await getClient().get("/nfts/search", {
        params,
        paramsSerializer: (values) => {
          const query = new URLSearchParams();
          Object.entries(values).forEach(([key, value]) => {
            if (Array.isArray(value)) {
              value.forEach((item) => query.append(key, item));
            } else if (value !== "" && value !== undefined && value !== null) {
              query.append(key, value);
            }
          });
          return query.toString();
        },
      });
    } catch (error) {
      lastError = error;
      if (
        attempt >= PORTALS_SEARCH_RETRY_DELAYS_MS.length ||
        !isTransientPortalsError(error)
      ) {
        throw error;
      }
      await wait(PORTALS_SEARCH_RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastError;
}

async function searchPortalsNfts({
  limit = 100,
  offset = 0,
  ids = [],
  status = "",
} = {}) {
  const safeLimit = Math.min(
    Math.max(Math.trunc(toNumber(limit, 100)), 1),
    500,
  );
  const safeOffset = Math.max(0, Math.trunc(toNumber(offset, 0)));
  const normalizedIds = Array.isArray(ids) ? ids.filter(Boolean) : [];
  const isCatalogRequest = normalizedIds.length === 0 && safeOffset === 0;
  const uniqueItems = new Map();
  const pageSize = Math.min(50, safeLimit);
  const maxPages = normalizedIds.length
    ? 1
    : Math.max(1, Math.ceil(safeLimit / pageSize) * 3);
  let providerOffset = safeOffset;
  let reportedTotal = 0;

  try {
    for (let page = 0; page < maxPages; page += 1) {
      if (page > 0) await wait(1050);
      const params = {
        limit: pageSize,
        offset: providerOffset,
        sort_by: "listed_at desc",
      };
      if (normalizedIds.length) params.ids = normalizedIds;
      if (status) params.status = status;

      const result = await requestPortalsSearchPage(params);
      const rows = Array.isArray(result?.data?.results)
        ? result.data.results
        : [];
      reportedTotal = Math.max(
        reportedTotal,
        Math.trunc(toNumber(result?.data?.total_count, 0)),
      );
      rows
        .map(mapPortalsNft)
        .filter((item) => item.providerNftId)
        .forEach((item) => uniqueItems.set(item.providerNftId, item));

      if (
        normalizedIds.length ||
        rows.length < pageSize ||
        uniqueItems.size >= safeLimit
      ) {
        break;
      }
      providerOffset += pageSize;
    }

    const items = Array.from(uniqueItems.values()).slice(0, safeLimit);
    const catalog = {
      totalCount: Math.max(reportedTotal, items.length),
      items,
      stale: false,
    };
    if (isCatalogRequest) {
      lastCatalogSearch = { ...catalog, cachedAt: Date.now() };
    }
    return catalog;
  } catch (error) {
    if (isCatalogRequest && lastCatalogSearch?.items?.length) {
      return {
        totalCount: lastCatalogSearch.totalCount,
        items: lastCatalogSearch.items.slice(0, safeLimit),
        stale: true,
        cachedAt: lastCatalogSearch.cachedAt,
      };
    }
    throw error;
  }
}

async function getPortalsNft(providerNftId) {
  const id = normalizeString(providerNftId).replace(/^portals:/, "");
  if (!id) return null;
  const result = await searchPortalsNfts({ limit: 1, ids: [id] });
  return result.items.find((item) => item.providerNftId === id) || null;
}

function getCachedPortalsNft(providerNftId) {
  const id = normalizeString(providerNftId).replace(/^portals:/, "");
  if (!id || !Array.isArray(lastCatalogSearch?.items)) return null;
  return (
    lastCatalogSearch.items.find((item) => item.providerNftId === id) || null
  );
}

async function getPortalsNftImageUrl(providerNftId) {
  const media = await getPortalsNftMedia(providerNftId);
  return media.imageUrl;
}

async function getPortalsNftMedia(providerNftId) {
  const id = normalizeString(providerNftId).replace(/^portals:/, "");
  if (!id) return { imageUrl: "", tgId: "" };
  const cached = nftMediaCache.get(id);
  if (cached && Date.now() - cached.cachedAt < NFT_MEDIA_CACHE_TTL_MS) {
    return {
      imageUrl: cached.imageUrl,
      animationUrl: cached.animationUrl || "",
      tgId: cached.tgId,
    };
  }
  const nft = await getPortalsNft(id);
  return {
    imageUrl: normalizeString(nft?.imageUrl),
    animationUrl: normalizeString(nft?.animationUrl),
    tgId: normalizeString(nft?.tgId),
  };
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

async function withdrawPortalsNfts({ providerNftIds, recipientTgUserId }) {
  const giftIds = (Array.isArray(providerNftIds) ? providerNftIds : [providerNftIds])
    .map((id) => normalizeString(id).replace(/^portals:/, ""))
    .filter(Boolean);
  const recipientId = Number(recipientTgUserId);
  if (!giftIds.length || !Number.isSafeInteger(recipientId) || recipientId <= 0) {
    throw new Error("Portals NFT yoki Telegram foydalanuvchi IDsi noto'g'ri");
  }

  const result = await getClient().post("/nfts/withdraw", {
    gift_ids: giftIds,
    recipient_id: recipientId,
    // Xaridor Portals foydalanuvchisi bo'lishi shart emas: NFT uning Telegram
    // profiliga yuboriladi.
    unsafe_transfer: true,
  });
  const withdrawalIds = Array.isArray(result?.data?.withdrawals_ids)
    ? result.data.withdrawals_ids
    : [];
  if (withdrawalIds.length !== giftIds.length || withdrawalIds.some((id) => !Number.isFinite(Number(id)))) {
    const error = new Error("Portals NFT yechib olish ID sini qaytarmadi");
    error.definitive = true;
    error.providerResponse = result?.data;
    throw error;
  }
  return { withdrawalIds: withdrawalIds.map((id) => Number(id)), response: result.data };
}

async function getPortalsNftWithdrawalStatuses(withdrawalIds) {
  const ids = (Array.isArray(withdrawalIds) ? withdrawalIds : [withdrawalIds])
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id) && id > 0);
  if (!ids.length) return [];

  const result = await getClient().get("/nfts/withdrawals/statuses", {
    params: { ids },
    paramsSerializer: (values) => {
      const query = new URLSearchParams();
      values.ids.forEach((id) => query.append("ids", id));
      return query.toString();
    },
  });
  return Array.isArray(result?.data?.statuses) ? result.data.statuses : [];
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
  getCachedPortalsNft,
  getPortalsNftImageUrl,
  getPortalsNftMedia,
  buyPortalsNft,
  withdrawPortalsNfts,
  getPortalsNftWithdrawalStatuses,
  getPortalsGramRateUzs,
};
