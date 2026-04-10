const util = require("node:util");
const { Api, TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { getTelegramCredentials } = require("../config/telegram-credentials");

const telegramCredentials = getTelegramCredentials("gift");
const apiId = telegramCredentials.apiId;
const apiHash = telegramCredentials.apiHash;
const sessionString = telegramCredentials.sessionString;

const CATALOG_CACHE_TTL_MS = 60 * 1000;
const NFT_PREVIEW_CACHE_TTL_MS = 10 * 60 * 1000;
const NFT_PATTERN_CACHE_TTL_MS = 20 * 60 * 1000;
const UNIQUE_GIFT_CACHE_TTL_MS = 20 * 60 * 1000;

let telegramClient = null;
let connectPromise = null;

let catalogCache = {
  fetchedAt: 0,
  gifts: [],
  giftById: new Map(),
  stickerById: new Map(),
};

let nftPreviewCache = new Map();
let nftPatternCache = new Map();
let uniqueGiftCache = new Map();

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeGiftId(value) {
  const normalized = normalizeString(value);
  if (!normalized) return "";

  try {
    if (/^\d+$/.test(normalized)) {
      return BigInt(normalized).toString();
    }
  } catch (_) {
    // ignore bigint conversion errors
  }

  return normalized;
}

function toSafeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const NFT_PREVIEW_CACHE_MAX_SIZE = Math.min(
  Math.max(Math.trunc(toSafeNumber(process.env.NFT_PREVIEW_CACHE_MAX_SIZE, 1200)), 200),
  5000,
);
const NFT_PATTERN_CACHE_MAX_SIZE = Math.min(
  Math.max(Math.trunc(toSafeNumber(process.env.NFT_PATTERN_CACHE_MAX_SIZE, 1200)), 200),
  5000,
);
const UNIQUE_GIFT_CACHE_MAX_SIZE = Math.min(
  Math.max(Math.trunc(toSafeNumber(process.env.UNIQUE_GIFT_CACHE_MAX_SIZE, 2000)), 300),
  8000,
);

function trimMapBySize(cacheMap, maxSize) {
  if (!(cacheMap instanceof Map)) return;
  const limit = Math.max(Math.trunc(toSafeNumber(maxSize, 0)), 1);
  while (cacheMap.size > limit) {
    const oldestKey = cacheMap.keys().next().value;
    if (typeof oldestKey === "undefined") break;
    cacheMap.delete(oldestKey);
  }
}

function isTruthyFlag(value) {
  const normalized = normalizeString(value).toLowerCase();
  return ["1", "true", "yes", "on", "debug"].includes(normalized);
}

function buildRawGiftAttributes(rawGift) {
  const attrs = Array.isArray(rawGift?.attributes) ? rawGift.attributes : [];

  return attrs.map((attr) => ({
    className: attr?.className,
    name: normalizeString(attr?.name),
    rarityPermille: toSafeNumber(
      attr?.rarityPermille ?? attr?.rarity_permille,
      0,
    ),
    centerColor: attr?.centerColor ?? attr?.center_color,
    edgeColor: attr?.edgeColor ?? attr?.edge_color,
    patternColor: attr?.patternColor ?? attr?.pattern_color,
    textColor: attr?.textColor ?? attr?.text_color,
    document: isTelegramDocumentLike(attr?.document)
      ? buildDocumentSummary(attr?.document)
      : null,
  }));
}

function logTelegramNftDebug(savedGift, mapped, index) {
  const rawGift = savedGift?.gift || null;
  const payload = {
    index,
    savedGift: {
      className: savedGift?.className,
      savedId: normalizeGiftId(savedGift?.savedId ?? savedGift?.saved_id),
      msgId: normalizeGiftId(savedGift?.msgId ?? savedGift?.msg_id),
      date: toSafeNumber(savedGift?.date, 0),
      transferStars: toSafeNumber(
        savedGift?.transferStars ?? savedGift?.transfer_stars,
        0,
      ),
      convertStars: toSafeNumber(
        savedGift?.convertStars ?? savedGift?.convert_stars,
        0,
      ),
      fromId: savedGift?.fromId ?? savedGift?.from_id ?? null,
    },
    telegramGiftRaw: rawGift
      ? {
          className: rawGift?.className,
          id: normalizeGiftId(rawGift?.id),
          title: normalizeString(rawGift?.title),
          slug: normalizeString(rawGift?.slug),
          num: toSafeNumber(rawGift?.num, 0),
          ownerName: normalizeString(rawGift?.ownerName ?? rawGift?.owner_name),
          ownerId: rawGift?.ownerId ?? rawGift?.owner_id ?? null,
          availabilityIssued: toSafeNumber(
            rawGift?.availabilityIssued ?? rawGift?.availability_issued,
            0,
          ),
          availabilityTotal: toSafeNumber(
            rawGift?.availabilityTotal ?? rawGift?.availability_total,
            0,
          ),
          attributes: buildRawGiftAttributes(rawGift),
        }
      : null,
    mappedGift: mapped,
  };

  // console.log(
  //   "[TG_NFT_DEBUG] Telegram NFT raw data:\n" +
  //     util.inspect(payload, {
  //       depth: 6,
  //       colors: false,
  //       maxArrayLength: 100,
  //       breakLength: 130,
  //     }),
  // );
}

function buildDocumentAttributeClassNames(document) {
  const attrs = Array.isArray(document?.attributes) ? document.attributes : [];
  return attrs
    .map((attr) => normalizeString(attr?.className))
    .filter(Boolean);
}

function isTelegramDocumentLike(value) {
  if (!value || typeof value !== "object") return false;

  const className = normalizeString(value?.className);
  if (className === "Document") return true;
  if (className === "DocumentEmpty") return false;

  const hasId = normalizeGiftId(value?.id);
  const hasAccessHash = normalizeGiftId(value?.accessHash ?? value?.access_hash);
  const hasDc = Number.isFinite(Number(value?.dcId ?? value?.dc_id));

  return Boolean(hasId && hasAccessHash && hasDc);
}

function buildDocumentSummary(document) {
  const thumbs = Array.isArray(document?.thumbs) ? document.thumbs : [];
  const mimeType = normalizeString(document?.mimeType ?? document?.mime_type);
  const attrNames = buildDocumentAttributeClassNames(document);
  const fileReference = document?.fileReference ?? document?.file_reference;
  const fileReferenceBytes =
    Buffer.isBuffer(fileReference) || fileReference instanceof Uint8Array
      ? fileReference.length
      : 0;

  return {
    className: normalizeString(document?.className),
    id: normalizeGiftId(document?.id),
    accessHash: normalizeGiftId(document?.accessHash ?? document?.access_hash),
    dcId: toSafeNumber(document?.dcId ?? document?.dc_id, 0),
    mimeType,
    size: toSafeNumber(document?.size, 0),
    thumbCount: thumbs.length,
    thumbTypes: thumbs
      .map((thumb) => normalizeString(thumb?.className || thumb?.type))
      .filter(Boolean)
      .slice(0, 10),
    attributeClassNames: attrNames.slice(0, 20),
    hasStickerAttr: attrNames.includes("DocumentAttributeSticker"),
    fileReferenceBytes,
    isWebpLike: mimeType.toLowerCase().includes("webp"),
    isSvgLike: mimeType.toLowerCase().includes("svg"),
  };
}

function summarizePatternCandidate(candidate) {
  const summary = candidate?.documentSummary || {};
  return {
    path: normalizeString(candidate?.path),
    sourceMethod: normalizeString(candidate?.sourceMethod),
    sourceLabel: normalizeString(candidate?.sourceLabel),
    score: toSafeNumber(candidate?.score, 0),
    ...summary,
  };
}

function formatPatternLogLine(event, payload) {
  const parts = [`[TG_PATTERN][${event}]`];
  if (payload?.nftId) parts.push(`nftId=${payload.nftId}`);
  if (payload?.slug) parts.push(`slug=${payload.slug}`);
  if (payload?.status) parts.push(`status=${payload.status}`);
  if (payload?.sourceMethod) parts.push(`method=${payload.sourceMethod}`);
  if (payload?.sourceLabel) parts.push(`label=${payload.sourceLabel}`);
  if (payload?.path) parts.push(`path=${payload.path}`);
  if (payload?.mimeType) parts.push(`mime=${payload.mimeType}`);
  if (payload?.thumbCount) parts.push(`thumbs=${payload.thumbCount}`);
  if (payload?.fileReferenceBytes) parts.push(`fileRef=${payload.fileReferenceBytes}`);
  if (payload?.missingReason) parts.push(`reason=${payload.missingReason}`);
  return parts.join(" | ");
}

function logPatternResolution(event, payload, extra) {
  console.log(formatPatternLogLine(event, payload));
  if (extra) {
    console.log(
      "[TG_PATTERN][DETAIL] " +
        util.inspect(extra, {
          depth: 4,
          colors: false,
          maxArrayLength: 40,
          breakLength: 140,
        }),
    );
  }
}

function buildPatternAssetPublicPayload(nftId, cacheEntry) {
  const id = normalizeString(nftId);
  const status = normalizeString(cacheEntry?.status) || "unknown";
  const imageUrl =
    status === "available" && id
      ? `/api/gifts/nft-pattern/${encodeURIComponent(id)}`
      : "";

  return {
    status,
    sourceMethod: normalizeString(cacheEntry?.sourceMethod),
    sourceLabel: normalizeString(cacheEntry?.sourceLabel),
    path: normalizeString(cacheEntry?.path),
    mimeType: normalizeString(cacheEntry?.mimeType),
    missingReason: normalizeString(cacheEntry?.missingReason),
    candidateCount: toSafeNumber(cacheEntry?.candidateCount, 0),
    imageUrl,
  };
}

function getNftPatternCacheEntry(nftId) {
  const id = normalizeString(nftId);
  if (!id) return null;

  const cached = nftPatternCache.get(id);
  if (!cached) return null;

  if (toSafeNumber(cached.expiresAt, 0) <= Date.now()) {
    nftPatternCache.delete(id);
    return null;
  }

  return cached;
}

function setNftPatternCacheEntry(nftId, patch) {
  const id = normalizeString(nftId);
  if (!id) return null;

  const incomingStatus = normalizeString(patch?.status);
  const derivedStatus =
    incomingStatus || (patch?.document || patch?.imageBuffer ? "available" : "unknown");

  const next = {
    ...(getNftPatternCacheEntry(id) || {}),
    ...patch,
    status: derivedStatus,
    expiresAt: Date.now() + NFT_PATTERN_CACHE_TTL_MS,
    updatedAt: new Date().toISOString(),
  };

  if (next.status === "available" && !next.document && !next.imageBuffer) {
    next.status = "missing";
    next.missingReason =
      normalizeString(next.missingReason) || "pattern_document_missing";
  }

  if (!normalizeString(next.mimeType) && next.document) {
    next.mimeType = normalizeString(next.document?.mimeType);
  }

  nftPatternCache.set(id, next);
  trimMapBySize(nftPatternCache, NFT_PATTERN_CACHE_MAX_SIZE);
  return next;
}

function collectDocumentCandidatesDeep(rootNode, options = {}) {
  const maxDepth = Math.min(Math.max(toSafeNumber(options.maxDepth, 8), 2), 16);
  const maxNodes = Math.min(Math.max(toSafeNumber(options.maxNodes, 1500), 300), 4000);
  const sourceMethod = normalizeString(options.sourceMethod);
  const sourceLabel = normalizeString(options.sourceLabel);
  const rootPath = normalizeString(options.rootPath) || "gift";

  const visited = new WeakSet();
  const candidates = [];
  let inspectedNodes = 0;

  function walk(node, path, depth) {
    if (node == null) return;
    if (inspectedNodes >= maxNodes) return;

    const nodeType = typeof node;
    if (nodeType !== "object") {
      inspectedNodes += 1;
      return;
    }

    if (Buffer.isBuffer(node) || node instanceof Uint8Array) {
      inspectedNodes += 1;
      return;
    }

    if (visited.has(node)) return;
    visited.add(node);

    inspectedNodes += 1;
    if (inspectedNodes >= maxNodes) return;

    if (isTelegramDocumentLike(node)) {
      const lowerPath = path.toLowerCase();
      const summary = buildDocumentSummary(node);

      let score = 0;
      if (lowerPath.includes("pattern")) score += 1500;
      if (summary.hasStickerAttr) score += 350;
      if (summary.thumbCount > 0) score += 220;
      if (summary.mimeType.toLowerCase().startsWith("image/")) score += 180;
      if (summary.isWebpLike) score += 140;
      if (summary.fileReferenceBytes > 0) score += 80;

      candidates.push({
        sourceMethod,
        sourceLabel,
        path,
        score,
        document: node,
        documentSummary: summary,
      });
    }

    if (depth >= maxDepth) return;

    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index += 1) {
        walk(node[index], `${path}[${index}]`, depth + 1);
        if (inspectedNodes >= maxNodes) break;
      }
      return;
    }

    for (const [key, value] of Object.entries(node)) {
      if (inspectedNodes >= maxNodes) break;
      if (typeof value === "function") continue;
      if (key === "originalArgs" || key === "_entities") continue;
      walk(value, `${path}.${key}`, depth + 1);
    }
  }

  walk(rootNode, rootPath, 0);

  const byDocumentKey = new Map();
  for (const candidate of candidates) {
    const summary = candidate.documentSummary || {};
    const dedupeKey =
      `${summary.id}:${summary.accessHash}:${summary.dcId}:${summary.mimeType}` ||
      `${candidate.path}:${candidate.sourceMethod}`;
    const existing = byDocumentKey.get(dedupeKey);
    if (!existing || toSafeNumber(existing.score, 0) < toSafeNumber(candidate.score, 0)) {
      byDocumentKey.set(dedupeKey, candidate);
    }
  }

  const uniqueCandidates = Array.from(byDocumentKey.values()).sort(
    (left, right) => toSafeNumber(right.score, 0) - toSafeNumber(left.score, 0),
  );

  return {
    inspectedNodes,
    candidates: uniqueCandidates,
  };
}

function inspectPatternCandidatesFromGiftRaw(rawGift, options = {}) {
  const sourceMethod = normalizeString(options.sourceMethod);
  const sourceLabel = normalizeString(options.sourceLabel);
  const rootPath = normalizeString(options.rootPath) || "gift";
  const attrs = Array.isArray(rawGift?.attributes) ? rawGift.attributes : [];

  const directCandidates = [];
  for (let index = 0; index < attrs.length; index += 1) {
    const attr = attrs[index];
    if (!attr || attr.className !== "StarGiftAttributePattern") continue;

    if (isTelegramDocumentLike(attr.document)) {
      const summary = buildDocumentSummary(attr.document);
      directCandidates.push({
        sourceMethod,
        sourceLabel,
        path: `${rootPath}.attributes[${index}].document`,
        score: 10_000,
        document: attr.document,
        documentSummary: summary,
      });
    }
  }

  const deepInspection = collectDocumentCandidatesDeep(rawGift, {
    sourceMethod,
    sourceLabel,
    rootPath,
    maxDepth: 10,
    maxNodes: 2200,
  });

  const merged = [...directCandidates, ...deepInspection.candidates];
  merged.sort((left, right) => toSafeNumber(right.score, 0) - toSafeNumber(left.score, 0));

  const best = merged[0] || null;

  return {
    sourceMethod,
    sourceLabel,
    best,
    candidateCount: merged.length,
    inspectedNodes: deepInspection.inspectedNodes,
    candidatesSummary: merged.slice(0, 8).map(summarizePatternCandidate),
  };
}

function extractEmojiFromSticker(sticker) {
  const attributes = Array.isArray(sticker?.attributes)
    ? sticker.attributes
    : [];
  const stickerAttr = attributes.find(
    (attr) => attr?.className === "DocumentAttributeSticker",
  );

  const emoji = normalizeString(stickerAttr?.alt);
  return emoji || "🎁";
}

function buildGiftTitle({ giftId, emoji }) {
  const shortId = normalizeGiftId(giftId).slice(-6) || "gift";
  const prefix = normalizeString(emoji) || "🎁";
  return `${prefix} Gift #${shortId}`;
}

function mapStarGift(rawGift) {
  const giftId = normalizeGiftId(rawGift?.id);
  const stars = toSafeNumber(rawGift?.stars, 0);
  if (!giftId || stars <= 0) return null;

  const limited = Boolean(rawGift?.limited);
  const soldOut = Boolean(rawGift?.soldOut);
  const availabilityRemains = toSafeNumber(rawGift?.availabilityRemains, 0);
  const availabilityTotal = toSafeNumber(rawGift?.availabilityTotal, 0);
  const emoji = extractEmojiFromSticker(rawGift?.sticker);
  const isAvailable = !soldOut && (!limited || availabilityRemains > 0);

  return {
    giftId,
    stars,
    convertStars: toSafeNumber(rawGift?.convertStars, 0),
    upgradeStars: toSafeNumber(rawGift?.upgradeStars, 0),
    limited,
    soldOut,
    isAvailable,
    availabilityRemains,
    availabilityTotal,
    emoji,
    title: buildGiftTitle({ giftId, emoji }),
  };
}

function isCatalogCacheFresh() {
  return (
    Date.now() - Number(catalogCache.fetchedAt || 0) < CATALOG_CACHE_TTL_MS
  );
}

function setCatalogCache(rawGifts) {
  const nextGiftById = new Map();
  const nextStickerById = new Map();

  for (const rawGift of rawGifts) {
    const mapped = mapStarGift(rawGift);
    if (!mapped) continue;

    nextGiftById.set(mapped.giftId, mapped);
    if (rawGift?.sticker) {
      nextStickerById.set(mapped.giftId, rawGift.sticker);
    }
  }

  const nextGifts = Array.from(nextGiftById.values()).sort((left, right) => {
    if (left.stars !== right.stars) return left.stars - right.stars;
    return left.giftId.localeCompare(right.giftId);
  });

  catalogCache = {
    fetchedAt: Date.now(),
    gifts: nextGifts,
    giftById: nextGiftById,
    stickerById: nextStickerById,
  };

  return catalogCache;
}

function isTelegramGiftConfigured() {
  if (!apiId || !apiHash || !sessionString) return false;
  if (sessionString.toLowerCase() === "test uchun") return false;
  return true;
}

async function getTelegramGiftClient() {
  if (!isTelegramGiftConfigured()) {
    throw new Error(
      `Gift xizmati sozlanmagan. ${telegramCredentials.acceptedKeys.apiId.join(" yoki ")}, ${telegramCredentials.acceptedKeys.apiHash.join(" yoki ")} va ${telegramCredentials.acceptedKeys.session.join(" yoki ")} kerak.`,
    );
  }

  if (!telegramClient) {
    telegramClient = new TelegramClient(
      new StringSession(sessionString),
      apiId,
      apiHash,
      { connectionRetries: 5 },
    );
  }

  if (telegramClient.connected) {
    return telegramClient;
  }

  if (!connectPromise) {
    connectPromise = telegramClient
      .connect()
      .then(async () => {
        const authorized = await telegramClient.checkAuthorization();
        if (!authorized) {
          throw new Error(
            `${telegramCredentials.resolvedKeys.session || telegramCredentials.preferredKeys.session} yaroqsiz yoki eskirgan. Yangi session kerak.`,
          );
        }
        return telegramClient;
      })
      .finally(() => {
        connectPromise = null;
      });
  }

  return connectPromise;
}

function getUniqueGiftCacheEntry(slug) {
  const normalizedSlug = normalizeString(slug);
  if (!normalizedSlug) return null;

  const cached = uniqueGiftCache.get(normalizedSlug);
  if (!cached) return null;

  if (toSafeNumber(cached.expiresAt, 0) <= Date.now()) {
    uniqueGiftCache.delete(normalizedSlug);
    return null;
  }

  return cached;
}

function setUniqueGiftCacheEntry(slug, patch) {
  const normalizedSlug = normalizeString(slug);
  if (!normalizedSlug) return null;

  const next = {
    ...(getUniqueGiftCacheEntry(normalizedSlug) || {}),
    ...patch,
    expiresAt: Date.now() + UNIQUE_GIFT_CACHE_TTL_MS,
    updatedAt: new Date().toISOString(),
  };

  uniqueGiftCache.set(normalizedSlug, next);
  trimMapBySize(uniqueGiftCache, UNIQUE_GIFT_CACHE_MAX_SIZE);
  return next;
}

async function fetchUniqueStarGiftRaw(client, slug, options = {}) {
  const normalizedSlug = normalizeString(slug);
  if (!normalizedSlug) return null;

  const force = Boolean(options.force);
  const cached = force ? null : getUniqueGiftCacheEntry(normalizedSlug);
  if (cached?.giftRaw) {
    return cached.giftRaw;
  }

  try {
    const result = await client.invoke(
      new Api.payments.GetUniqueStarGift({
        slug: normalizedSlug,
      }),
    );

    const giftRaw = result?.gift || null;
    setUniqueGiftCacheEntry(normalizedSlug, {
      responseClass: normalizeString(result?.className),
      giftRaw,
    });
    return giftRaw;
  } catch (error) {
    setUniqueGiftCacheEntry(normalizedSlug, {
      responseClass: "error",
      errorMessage: normalizeString(error?.errorMessage || error?.message),
      giftRaw: null,
    });
    return null;
  }
}

function extractPreviewDocumentFromUniqueGiftRaw(rawGift) {
  if (!rawGift || rawGift?.className !== "StarGiftUnique") return null;
  const attrs = Array.isArray(rawGift?.attributes) ? rawGift.attributes : [];
  const modelAttr = findGiftAttr(attrs, "StarGiftAttributeModel");
  const patternAttr = findGiftAttr(attrs, "StarGiftAttributePattern");
  return modelAttr?.document || patternAttr?.document || null;
}

function getNftPatternAssetMeta(nftId) {
  const cached = getNftPatternCacheEntry(nftId);
  return buildPatternAssetPublicPayload(nftId, cached);
}

function setResolvedPatternFound(nftId, slug, inspection) {
  const best = inspection?.best || null;
  if (!best?.document) return null;

  const summary = best.documentSummary || {};
  const next = setNftPatternCacheEntry(nftId, {
    status: "available",
    slug: normalizeString(slug),
    sourceMethod: normalizeString(inspection?.sourceMethod || best?.sourceMethod),
    sourceLabel: normalizeString(inspection?.sourceLabel || best?.sourceLabel),
    path: normalizeString(best?.path),
    mimeType: normalizeString(summary?.mimeType),
    missingReason: "",
    candidateCount: toSafeNumber(inspection?.candidateCount, 0),
    inspectedNodes: toSafeNumber(inspection?.inspectedNodes, 0),
    document: best.document,
    documentSummary: summary,
  });

  logPatternResolution("FOUND", {
    nftId: normalizeString(nftId),
    slug: normalizeString(slug),
    status: "available",
    sourceMethod: normalizeString(next?.sourceMethod),
    sourceLabel: normalizeString(next?.sourceLabel),
    path: normalizeString(next?.path),
    mimeType: normalizeString(summary?.mimeType),
    thumbCount: toSafeNumber(summary?.thumbCount, 0),
    fileReferenceBytes: toSafeNumber(summary?.fileReferenceBytes, 0),
  });

  if (isTruthyFlag(process.env.TG_PATTERN_DEBUG)) {
    logPatternResolution("CANDIDATES", {
      nftId: normalizeString(nftId),
      slug: normalizeString(slug),
      sourceMethod: normalizeString(inspection?.sourceMethod),
    }, inspection?.candidatesSummary || []);
  }

  return buildPatternAssetPublicPayload(nftId, next);
}

function setResolvedPatternMissing(nftId, slug, reason, details) {
  const next = setNftPatternCacheEntry(nftId, {
    status: "missing",
    slug: normalizeString(slug),
    sourceMethod: normalizeString(details?.sourceMethod),
    sourceLabel: normalizeString(details?.sourceLabel),
    path: normalizeString(details?.path),
    mimeType: normalizeString(details?.mimeType),
    missingReason: normalizeString(reason) || "pattern_document_not_found",
    candidateCount: toSafeNumber(details?.candidateCount, 0),
    inspectedNodes: toSafeNumber(details?.inspectedNodes, 0),
    document: null,
    documentSummary: null,
    imageBuffer: null,
    imageContentType: "",
  });

  logPatternResolution("MISSING", {
    nftId: normalizeString(nftId),
    slug: normalizeString(slug),
    status: "missing",
    sourceMethod: normalizeString(next?.sourceMethod),
    sourceLabel: normalizeString(next?.sourceLabel),
    missingReason: normalizeString(next?.missingReason),
  });

  return buildPatternAssetPublicPayload(nftId, next);
}

async function resolveNftPatternAssetForSavedGift({
  client,
  nftId,
  slug,
  rawGift,
}) {
  const normalizedNftId = normalizeString(nftId);
  if (!normalizedNftId) {
    return buildPatternAssetPublicPayload("", null);
  }

  const cached = getNftPatternCacheEntry(normalizedNftId);
  if (cached) {
    return buildPatternAssetPublicPayload(normalizedNftId, cached);
  }

  const savedInspection = inspectPatternCandidatesFromGiftRaw(rawGift, {
    sourceMethod: "payments.getSavedStarGifts",
    sourceLabel: "saved_gift",
    rootPath: "savedGift.gift",
  });

  if (savedInspection?.best?.document) {
    return setResolvedPatternFound(normalizedNftId, slug, savedInspection);
  }

  const normalizedSlug = normalizeString(slug);
  if (normalizedSlug) {
    const uniqueGiftRaw = await fetchUniqueStarGiftRaw(client, normalizedSlug);
    if (uniqueGiftRaw) {
      const uniqueInspection = inspectPatternCandidatesFromGiftRaw(uniqueGiftRaw, {
        sourceMethod: "payments.getUniqueStarGift",
        sourceLabel: "unique_gift_by_slug",
        rootPath: "uniqueGift.gift",
      });

      if (uniqueInspection?.best?.document) {
        return setResolvedPatternFound(normalizedNftId, normalizedSlug, uniqueInspection);
      }

      return setResolvedPatternMissing(
        normalizedNftId,
        normalizedSlug,
        "pattern_document_not_found_in_saved_and_unique",
        {
          sourceMethod: uniqueInspection?.sourceMethod,
          sourceLabel: uniqueInspection?.sourceLabel,
          candidateCount: uniqueInspection?.candidateCount,
          inspectedNodes: uniqueInspection?.inspectedNodes,
        },
      );
    }
  }

  return setResolvedPatternMissing(
    normalizedNftId,
    normalizedSlug,
    normalizedSlug
      ? "unique_gift_raw_unavailable_or_pattern_missing"
      : "pattern_document_not_found_in_saved_gift",
    {
      sourceMethod: savedInspection?.sourceMethod,
      sourceLabel: savedInspection?.sourceLabel,
      candidateCount: savedInspection?.candidateCount,
      inspectedNodes: savedInspection?.inspectedNodes,
    },
  );
}

async function fetchStarGiftCatalog({ force = false } = {}) {
  if (!force && catalogCache.gifts.length && isCatalogCacheFresh()) {
    return catalogCache;
  }

  const client = await getTelegramGiftClient();
  const result = await client.invoke(
    new Api.payments.GetStarGifts({ hash: 0 }),
  );

  if (
    result?.className === "payments.StarGiftsNotModified" &&
    catalogCache.gifts.length
  ) {
    catalogCache.fetchedAt = Date.now();
    return catalogCache;
  }

  const rawGifts = Array.isArray(result?.gifts) ? result.gifts : [];
  return setCatalogCache(rawGifts);
}

async function getStarGiftsCatalog({
  includeSoldOut = false,
  force = false,
} = {}) {
  const cached = await fetchStarGiftCatalog({ force });
  if (includeSoldOut) return cached.gifts;
  return cached.gifts.filter((gift) => gift.isAvailable);
}

async function getGiftById(giftId, options = {}) {
  const normalizedGiftId = normalizeGiftId(giftId);
  if (!normalizedGiftId) return null;

  const includeSoldOut = options.includeSoldOut !== false;
  const force = Boolean(options.force);

  const cached = await fetchStarGiftCatalog({ force });
  const gift = cached.giftById.get(normalizedGiftId) || null;
  if (!gift) return null;
  if (!includeSoldOut && !gift.isAvailable) return null;
  return gift;
}

function detectImageContentType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return "";

  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return "image/png";
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }

  const riff = buffer.slice(0, 4).toString("ascii");
  const webp = buffer.slice(8, 12).toString("ascii");
  if (riff === "RIFF" && webp === "WEBP") {
    return "image/webp";
  }

  if (buffer.slice(0, 3).toString("ascii") === "GIF") {
    return "image/gif";
  }

  return "";
}

function escapeSvgText(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildGiftPlaceholderImage(gift) {
  const emoji = escapeSvgText(gift?.emoji || "🎁");
  const label = escapeSvgText(gift?.title || "Telegram Gift");

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#1c2237" />
      <stop offset="100%" stop-color="#0f1322" />
    </linearGradient>
  </defs>
  <rect width="256" height="256" rx="32" fill="url(#g)" />
  <text x="128" y="116" text-anchor="middle" font-size="72">${emoji}</text>
  <text x="128" y="176" text-anchor="middle" font-size="16" fill="#f0c040" font-family="Arial, sans-serif">${label}</text>
</svg>`;

  return {
    buffer: Buffer.from(svg, "utf8"),
    contentType: "image/svg+xml; charset=utf-8",
  };
}

function withTimeout(promise, timeoutMs, timeoutMessage) {
  const ms = Math.min(Math.max(toSafeNumber(timeoutMs, 0), 500), 30_000);
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(timeoutMessage || `timeout after ${ms}ms`));
    }, ms);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function downloadImageFromTelegramDocument(client, document) {
  if (!client || !document) return null;

  const thumbOptions = [0, 1, 2, "m", "x", undefined];

  for (const thumb of thumbOptions) {
    try {
      const downloaded = await withTimeout(
        client.downloadMedia(document, { thumb }),
        12_000,
        "telegram media download timeout",
      );

      if (!Buffer.isBuffer(downloaded) || !downloaded.length) {
        continue;
      }

      const contentType = detectImageContentType(downloaded);
      if (!contentType) {
        continue;
      }

      return {
        buffer: downloaded,
        contentType,
      };
    } catch (_) {
      // try next thumb option
    }
  }

  return null;
}

async function getGiftImageBuffer(giftId) {
  const normalizedGiftId = normalizeGiftId(giftId);
  if (!normalizedGiftId) {
    return buildGiftPlaceholderImage({ title: "Gift" });
  }

  const gift = await getGiftById(normalizedGiftId, { includeSoldOut: true });
  const sticker = catalogCache.stickerById.get(normalizedGiftId) || null;

  if (sticker) {
    const client = await getTelegramGiftClient();
    const image = await downloadImageFromTelegramDocument(client, sticker);
    if (image) return image;
  }

  return buildGiftPlaceholderImage(gift);
}

function normalizeRecipientIdentifier(value) {
  const normalized = normalizeString(value).replace(/^@+/, "");
  return normalized;
}

function resolveRecipientEntity(value) {
  const normalized = normalizeRecipientIdentifier(value);
  if (!normalized) return "";

  if (/^\d+$/.test(normalized)) {
    const asNumber = Number(normalized);
    if (Number.isSafeInteger(asNumber)) return asNumber;
  }

  return normalized;
}

function extractPeerUserId(peer) {
  if (!peer || typeof peer !== "object") return "";

  const candidates = [peer.userId, peer.user_id, peer.id];
  for (const candidate of candidates) {
    const value = normalizeGiftId(candidate);
    if (value) return value;
  }

  return "";
}

function buildUsersMap(users) {
  const map = new Map();
  const list = Array.isArray(users) ? users : [];

  for (const user of list) {
    const id = normalizeGiftId(user?.id);
    if (!id) continue;

    const fullName = [
      normalizeString(user?.firstName),
      normalizeString(user?.lastName),
    ]
      .filter(Boolean)
      .join(" ")
      .trim();
    const username = normalizeString(user?.username);

    map.set(id, {
      id,
      displayName: fullName || (username ? `@${username}` : id),
      username,
    });
  }

  return map;
}

function formatRarityPercent(permille) {
  const value = toSafeNumber(permille, 0) / 10;
  if (!value) return "";

  const text = Number.isInteger(value)
    ? String(value)
    : value.toFixed(1).replace(/\.0$/, "");

  return `${text}%`;
}

function toHexColor(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;

  const rgb = (numeric >>> 0) & 0xffffff;
  return `#${rgb.toString(16).padStart(6, "0")}`;
}

function findGiftAttr(attributes, className) {
  const list = Array.isArray(attributes) ? attributes : [];
  return list.find((item) => item?.className === className) || null;
}

function setNftPreviewDocument(nftId, document) {
  const id = normalizeString(nftId);
  if (!id || !document) return;

  nftPreviewCache.set(id, {
    document,
    expiresAt: Date.now() + NFT_PREVIEW_CACHE_TTL_MS,
  });
  trimMapBySize(nftPreviewCache, NFT_PREVIEW_CACHE_MAX_SIZE);
}

function getNftPreviewDocument(nftId) {
  const id = normalizeString(nftId);
  if (!id) return null;

  const cached = nftPreviewCache.get(id);
  if (!cached) return null;

  if (toSafeNumber(cached.expiresAt, 0) <= Date.now()) {
    nftPreviewCache.delete(id);
    return null;
  }

  return cached.document || null;
}

function mapSavedGiftToNft(savedGift, usersMap, options = {}) {
  const gift = savedGift?.gift;
  if (!gift || gift?.className !== "StarGiftUnique") {
    return null;
  }

  const giftId = normalizeGiftId(gift?.id);
  const savedId =
    normalizeGiftId(savedGift?.savedId) ||
    normalizeGiftId(savedGift?.msgId) ||
    `${giftId}:${toSafeNumber(savedGift?.date, 0)}`;

  const modelAttr = findGiftAttr(gift?.attributes, "StarGiftAttributeModel");
  const patternAttr = findGiftAttr(
    gift?.attributes,
    "StarGiftAttributePattern",
  );
  const backdropAttr = findGiftAttr(
    gift?.attributes,
    "StarGiftAttributeBackdrop",
  );
  const previewDocument = modelAttr?.document || patternAttr?.document || null;
  const backdropColors = {
    center: toHexColor(
      backdropAttr?.centerColor ?? backdropAttr?.center_color,
      "#346d2b",
    ),
    edge: toHexColor(
      backdropAttr?.edgeColor ?? backdropAttr?.edge_color,
      "#2d5f24",
    ),
    pattern: toHexColor(
      backdropAttr?.patternColor ?? backdropAttr?.pattern_color,
      "#8ec95d",
    ),
    text: toHexColor(
      backdropAttr?.textColor ?? backdropAttr?.text_color,
      "#eaffdc",
    ),
  };

  const sourceFromUserId = extractPeerUserId(savedGift?.fromId ?? savedGift?.from_id);
  const sourceFrom = sourceFromUserId ? usersMap.get(sourceFromUserId) : null;

  const ownerNameRaw = normalizeString(gift?.ownerName);
  const ownerUserId = extractPeerUserId(gift?.ownerId);
  const ownerFromUsers = ownerUserId
    ? usersMap.get(ownerUserId)?.displayName
    : "";
  const ownerName = ownerNameRaw || ownerFromUsers || "-";

  const valueStars = Math.max(
    0,
    toSafeNumber(savedGift?.transferStars, 0) ||
      toSafeNumber(savedGift?.convertStars, 0),
  );

  const num = toSafeNumber(gift?.num, 0);
  const nftNumber = num > 0 ? Math.trunc(num) : 0;
  const acquiredAt = toSafeNumber(savedGift?.date, 0)
    ? new Date(toSafeNumber(savedGift?.date, 0) * 1000).toISOString()
    : null;
  const canTransferAtUnix = toSafeNumber(
    savedGift?.canTransferAt ?? savedGift?.can_transfer_at,
    0,
  );
  const canTransferAt =
    canTransferAtUnix > 0
      ? new Date(canTransferAtUnix * 1000).toISOString()
      : null;

  if (previewDocument && typeof options.onPreviewDocument === "function") {
    options.onPreviewDocument(savedId, previewDocument);
  }

  return {
    nftId: savedId,
    giftId,
    slug: normalizeString(gift?.slug),
    title: normalizeString(gift?.title) || "NFT Gift",
    nftNumber,
    ownerName,
    sourceFromUserId,
    sourceFromUsername: normalizeString(sourceFrom?.username),
    sourceFromName: normalizeString(sourceFrom?.displayName),
    model: normalizeString(modelAttr?.name),
    modelRarity: formatRarityPercent(modelAttr?.rarityPermille),
    symbol: normalizeString(patternAttr?.name),
    symbolRarity: formatRarityPercent(patternAttr?.rarityPermille),
    backdrop: normalizeString(backdropAttr?.name),
    backdropRarity: formatRarityPercent(backdropAttr?.rarityPermille),
    backdropColors,
    patternAsset: getNftPatternAssetMeta(savedId),
    quantityIssued: toSafeNumber(gift?.availabilityIssued, 0),
    quantityTotal: toSafeNumber(gift?.availabilityTotal, 0),
    valueStars,
    acquiredAt,
    canTransferAt,
    sourceMsgId: toSafeNumber(savedGift?.msgId ?? savedGift?.msg_id, 0),
    sourceSavedId: normalizeGiftId(savedGift?.savedId ?? savedGift?.saved_id),
    emoji: "🎁",
  };
}

async function getMyTelegramNftGifts({
  limit = 100,
  debug = false,
  debugLimit = 6,
} = {}) {
  const client = await getTelegramGiftClient();
  const selfPeer = await client.getInputEntity("me");

  const targetLimit = Math.min(Math.max(toSafeNumber(limit, 100), 1), 200);
  const debugEnabled = Boolean(debug) || isTruthyFlag(process.env.TG_NFT_DEBUG);
  const maxDebugLogs = Math.min(Math.max(toSafeNumber(debugLimit, 6), 1), 30);

  const items = [];
  let offset = "";
  let loopGuard = 0;
  let debugLogged = 0;

  while (items.length < targetLimit && loopGuard < 5) {
    loopGuard += 1;

    const result = await client.invoke(
      new Api.payments.GetSavedStarGifts({
        peer: selfPeer,
        offset,
        limit: Math.min(100, targetLimit - items.length),
        excludeUnsaved: true,
      }),
    );

    const savedGifts = Array.isArray(result?.gifts) ? result.gifts : [];
    const usersMap = buildUsersMap(result?.users);

    for (const savedGift of savedGifts) {
      const mapped = mapSavedGiftToNft(savedGift, usersMap, {
        onPreviewDocument: setNftPreviewDocument,
      });
      if (!mapped) continue;

      mapped.patternAsset = await resolveNftPatternAssetForSavedGift({
        client,
        nftId: mapped.nftId,
        slug: mapped.slug,
        rawGift: savedGift?.gift || null,
      });

      if (debugEnabled && debugLogged < maxDebugLogs) {
        debugLogged += 1;
        logTelegramNftDebug(savedGift, mapped, debugLogged);
      }

      items.push(mapped);
      if (items.length >= targetLimit) break;
    }

    const nextOffset = normalizeString(result?.nextOffset);
    if (!nextOffset || savedGifts.length === 0) {
      break;
    }
    offset = nextOffset;
  }

  items.sort((left, right) => {
    const a = new Date(left.acquiredAt || 0).getTime();
    const b = new Date(right.acquiredAt || 0).getTime();
    return b - a;
  });

  return items;
}
function normalizeNftImageParams(nftIdOrOptions, maybeSlug) {
  if (nftIdOrOptions && typeof nftIdOrOptions === "object") {
    return {
      nftId: normalizeString(nftIdOrOptions.nftId),
      slug: normalizeString(nftIdOrOptions.slug),
    };
  }
  return {
    nftId: normalizeString(nftIdOrOptions),
    slug: normalizeString(maybeSlug),
  };
}

async function getNftImageBuffer(nftIdOrOptions, maybeSlug) {
  const params = normalizeNftImageParams(nftIdOrOptions, maybeSlug);
  const normalizedNftId = params.nftId;
  const normalizedSlug = params.slug;
  if (!normalizedNftId) {
    return buildGiftPlaceholderImage({ title: "NFT Gift" });
  }

  let previewDocument = getNftPreviewDocument(normalizedNftId);
  const client = await getTelegramGiftClient();

  if (!previewDocument && normalizedSlug) {
    const uniqueRaw = await fetchUniqueStarGiftRaw(client, normalizedSlug);
    const fromUnique = extractPreviewDocumentFromUniqueGiftRaw(uniqueRaw);
    if (fromUnique) {
      setNftPreviewDocument(normalizedNftId, fromUnique);
      previewDocument = fromUnique;
    }
  }

  if (previewDocument) {
    let image = await downloadImageFromTelegramDocument(client, previewDocument);
    if (image) return image;

    if (normalizedSlug) {
      const uniqueRawForced = await fetchUniqueStarGiftRaw(client, normalizedSlug, {
        force: true,
      });
      const forcedDocument = extractPreviewDocumentFromUniqueGiftRaw(uniqueRawForced);
      if (forcedDocument) {
        setNftPreviewDocument(normalizedNftId, forcedDocument);
        image = await downloadImageFromTelegramDocument(client, forcedDocument);
        if (image) return image;
      }
    }
  }

  if (normalizedSlug) {
    const uniqueRaw = await fetchUniqueStarGiftRaw(client, normalizedSlug);
    const fallbackDoc = extractPreviewDocumentFromUniqueGiftRaw(uniqueRaw);
    if (fallbackDoc) {
      setNftPreviewDocument(normalizedNftId, fallbackDoc);
      const client = await getTelegramGiftClient();
      const image = await downloadImageFromTelegramDocument(client, fallbackDoc);
      if (image) return image;
    }
  }

  return buildGiftPlaceholderImage({ title: "NFT Gift" });
}

async function getNftPatternImageBuffer({ nftId, slug } = {}) {
  const normalizedNftId = normalizeString(nftId);
  const normalizedSlug = normalizeString(slug);

  if (!normalizedNftId) {
    return null;
  }

  let cacheEntry = getNftPatternCacheEntry(normalizedNftId);

  if (!cacheEntry && normalizedSlug) {
    const client = await getTelegramGiftClient();
    await resolveNftPatternAssetForSavedGift({
      client,
      nftId: normalizedNftId,
      slug: normalizedSlug,
      rawGift: null,
    });
    cacheEntry = getNftPatternCacheEntry(normalizedNftId);
  }

  if (!cacheEntry || cacheEntry.status !== "available") {
    return null;
  }

  if (
    Buffer.isBuffer(cacheEntry.imageBuffer) &&
    normalizeString(cacheEntry.imageContentType)
  ) {
    return {
      buffer: cacheEntry.imageBuffer,
      contentType: cacheEntry.imageContentType,
      meta: buildPatternAssetPublicPayload(normalizedNftId, cacheEntry),
    };
  }

  if (!cacheEntry.document) {
    return null;
  }

  const client = await getTelegramGiftClient();
  const image = await downloadImageFromTelegramDocument(client, cacheEntry.document);

  if (!image?.buffer || !image?.contentType) {
    setResolvedPatternMissing(
      normalizedNftId,
      normalizedSlug,
      "pattern_document_present_but_image_download_failed",
      {
        sourceMethod: cacheEntry.sourceMethod,
        sourceLabel: cacheEntry.sourceLabel,
        path: cacheEntry.path,
        mimeType: cacheEntry.mimeType,
      },
    );
    return null;
  }

  const next = setNftPatternCacheEntry(normalizedNftId, {
    status: "available",
    slug: normalizedSlug || cacheEntry.slug,
    sourceMethod: cacheEntry.sourceMethod,
    sourceLabel: cacheEntry.sourceLabel,
    path: cacheEntry.path,
    mimeType: image.contentType,
    missingReason: "",
    candidateCount: cacheEntry.candidateCount,
    inspectedNodes: cacheEntry.inspectedNodes,
    document: cacheEntry.document,
    documentSummary: cacheEntry.documentSummary,
    imageBuffer: image.buffer,
    imageContentType: image.contentType,
  });

  return {
    buffer: image.buffer,
    contentType: image.contentType,
    meta: buildPatternAssetPublicPayload(normalizedNftId, next),
  };
}

async function sendStarGiftToRecipient({
  giftId,
  recipientIdentifier,
  hideName = false,
}) {
  const normalizedGiftId = normalizeGiftId(giftId);
  if (!normalizedGiftId) {
    throw new Error("giftId required");
  }

  const normalizedRecipient = normalizeString(recipientIdentifier || "me");
  const entityLike =
    normalizedRecipient.toLowerCase() === "me"
      ? "me"
      : resolveRecipientEntity(normalizedRecipient);

  if (!entityLike) {
    throw new Error("Qabul qiluvchi topilmadi");
  }

  const client = await getTelegramGiftClient();
  const inputPeer = await client.getInputEntity(entityLike);

  const invoice = new Api.InputInvoiceStarGift({
    hideName: Boolean(hideName),
    peer: inputPeer,
    giftId: normalizedGiftId,
  });

  const paymentForm = await client.invoke(
    new Api.payments.GetPaymentForm({
      invoice,
    }),
  );

  if (!paymentForm?.formId) {
    throw new Error("Telegram payment form topilmadi");
  }

  const paymentResult = await client.invoke(
    new Api.payments.SendStarsForm({
      formId: paymentForm.formId,
      invoice,
    }),
  );

  return {
    paymentFormClass: String(paymentForm?.className || ""),
    paymentResultClass: String(paymentResult?.className || ""),
    recipient: entityLike === "me" ? "me" : String(entityLike),
  };
}

async function transferSavedStarGiftToRecipient({
  msgId,
  recipientIdentifier,
}) {
  const normalizedRecipient = normalizeString(recipientIdentifier || "");
  const entityLike = resolveRecipientEntity(normalizedRecipient);
  if (!entityLike) {
    throw new Error("Qabul qiluvchi topilmadi");
  }

  const normalizedMsgId = Math.trunc(toSafeNumber(msgId, 0));
  if (!normalizedMsgId || normalizedMsgId <= 0) {
    throw new Error("saved gift msgId required");
  }

  const client = await getTelegramGiftClient();
  const inputPeer = await client.getInputEntity(entityLike);
  const stargiftRef = new Api.InputSavedStarGiftUser({
    msgId: normalizedMsgId,
  });

  try {
    const updates = await client.invoke(
      new Api.payments.TransferStarGift({
        stargift: stargiftRef,
        toId: inputPeer,
      }),
    );

    return {
      updatesClass: String(updates?.className || ""),
      paymentFormClass: "",
      paymentResultClass: "",
      transferMode: "direct",
      recipient: String(normalizedRecipient || entityLike),
      msgId: normalizedMsgId,
    };
  } catch (error) {
    const rawError = normalizeString(error?.errorMessage || error?.message).toUpperCase();
    if (!rawError.includes("PAYMENT_REQUIRED")) {
      throw error;
    }

    // Telegram ba'zi sovg'alar transferi uchun stars to'lovi talab qiladi.
    const invoice = new Api.InputInvoiceStarGiftTransfer({
      stargift: stargiftRef,
      toId: inputPeer,
    });

    const paymentForm = await client.invoke(
      new Api.payments.GetPaymentForm({
        invoice,
      }),
    );

    if (!paymentForm?.formId) {
      throw new Error("Telegram transfer payment form topilmadi");
    }

    const paymentResult = await client.invoke(
      new Api.payments.SendStarsForm({
        formId: paymentForm.formId,
        invoice,
      }),
    );

    return {
      updatesClass: "",
      paymentFormClass: String(paymentForm?.className || ""),
      paymentResultClass: String(paymentResult?.className || ""),
      transferMode: "paid_invoice",
      recipient: String(normalizedRecipient || entityLike),
      msgId: normalizedMsgId,
    };
  }
}

module.exports = {
  isTelegramGiftConfigured,
  getStarGiftsCatalog,
  getGiftById,
  getGiftImageBuffer,
  getNftImageBuffer,
  getNftPatternImageBuffer,
  getNftPatternAssetMeta,
  getMyTelegramNftGifts,
  sendStarGiftToRecipient,
  transferSavedStarGiftToRecipient,
};



