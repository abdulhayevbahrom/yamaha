function normalizeCardBin(value) {
  return String(value || "").replace(/\D/g, "").slice(0, 8);
}

function normalizeScheme(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeBool(value) {
  if (typeof value === "boolean") return value;
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!normalized) return false;
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

const BIN_LOOKUP_CACHE_TTL_MS = 30 * 60 * 1000;
const BIN_LOOKUP_CACHE_LIMIT = 1000;
const binLookupCache = new Map();
const binLookupInFlight = new Map();

function readBinLookupCache(bin) {
  const cached = binLookupCache.get(bin);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    binLookupCache.delete(bin);
    return null;
  }
  return cached.value || null;
}

function writeBinLookupCache(bin, value) {
  if (!bin || !value) return;
  if (binLookupCache.size >= BIN_LOOKUP_CACHE_LIMIT) {
    const oldestKey = binLookupCache.keys().next().value;
    if (oldestKey) binLookupCache.delete(oldestKey);
  }
  binLookupCache.set(bin, {
    value,
    expiresAt: Date.now() + BIN_LOOKUP_CACHE_TTL_MS,
  });
}

function detectLocalSchemeFallback(bin) {
  const normalized = normalizeCardBin(bin);
  if (normalized.startsWith("9860")) return "HUMOCARD";
  if (normalized.startsWith("8600")) return "UZCARD";
  return "";
}

function buildUnifiedPayload(bin, source = null) {
  return {
    bin,
    found: false,
    bankName: "",
    scheme: "",
    type: "",
    country: "",
    source,
  };
}

function normalizeBincheckPayload(bin, data) {
  const base = buildUnifiedPayload(bin, "bincheck");
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return base;
  }

  const binNode =
    data?.BIN && typeof data.BIN === "object" && !Array.isArray(data.BIN)
      ? data.BIN
      : data;

  const issuer =
    binNode?.issuer && typeof binNode.issuer === "object" && !Array.isArray(binNode.issuer)
      ? binNode.issuer
      : {};
  const countryNode =
    binNode?.country && typeof binNode.country === "object" && !Array.isArray(binNode.country)
      ? binNode.country
      : {};

  const bankName = String(
    issuer?.name || binNode?.bank || binNode?.bank_name || "",
  ).trim();
  const scheme = normalizeScheme(
    binNode?.scheme || binNode?.brand || binNode?.network || "",
  );
  const type = String(binNode?.type || "").trim();
  const country = String(countryNode?.name || binNode?.country || "").trim();
  const valid = normalizeBool(binNode?.valid);

  return {
    ...base,
    found: Boolean(valid || bankName || scheme || type || country),
    bankName,
    scheme,
    type,
    country,
  };
}

async function lookupWithBincheck(bin) {
  const apiKey = String(process.env.BINCHECK_RAPIDAPI_KEY || "").trim();
  if (!apiKey) return null;

  const host = String(process.env.BINCHECK_RAPIDAPI_HOST || "bincheck.io").trim();
  const baseUrl = String(
    process.env.BINCHECK_API_URL || "https://bincheck.io/api/v2/bin",
  )
    .trim()
    .replace(/\/+$/, "");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4500);
  try {
    const external = await fetch(`${baseUrl}/${encodeURIComponent(bin)}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-RapidAPI-Key": apiKey,
        "X-RapidAPI-Host": host,
      },
      signal: controller.signal,
    });
    if (!external.ok) return null;
    const data = await external.json().catch(() => null);
    return normalizeBincheckPayload(bin, data);
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function lookupWithBinlist(bin) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4500);
  try {
    const external = await fetch(`https://lookup.binlist.net/${encodeURIComponent(bin)}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Accept-Version": "3",
      },
      signal: controller.signal,
    });
    if (!external.ok) return null;

    const data = await external.json().catch(() => null);
    const bankName = String(data?.bank?.name || "").trim();
    const scheme = normalizeScheme(data?.scheme);
    const type = String(data?.type || "").trim();
    const country = String(data?.country?.name || "").trim();

    return {
      ...buildUnifiedPayload(bin, "binlist"),
      found: Boolean(bankName || scheme || type || country),
      bankName,
      scheme,
      type,
      country,
    };
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function lookupCardBinInfo(value) {
  const bin = normalizeCardBin(value);
  if (bin.length < 6) {
    return buildUnifiedPayload(bin);
  }

  const cached = readBinLookupCache(bin);
  if (cached) return cached;

  const fallbackPayload = {
    ...buildUnifiedPayload(bin, "local"),
    scheme: detectLocalSchemeFallback(bin),
  };

  const pending = binLookupInFlight.get(bin);
  if (pending) return pending;

  const task = (async () => {
    try {
      const fromBincheck = await lookupWithBincheck(bin);
      if (fromBincheck) {
        const normalizedPayload = {
          ...fromBincheck,
          scheme: normalizeScheme(fromBincheck.scheme) || detectLocalSchemeFallback(bin),
        };
        writeBinLookupCache(bin, normalizedPayload);
        return normalizedPayload;
      }

      const fromBinlist = await lookupWithBinlist(bin);
      if (fromBinlist) {
        const normalizedPayload = {
          ...fromBinlist,
          scheme: normalizeScheme(fromBinlist.scheme) || detectLocalSchemeFallback(bin),
        };
        writeBinLookupCache(bin, normalizedPayload);
        return normalizedPayload;
      }

      writeBinLookupCache(bin, fallbackPayload);
      return fallbackPayload;
    } catch (_) {
      writeBinLookupCache(bin, fallbackPayload);
      return fallbackPayload;
    } finally {
      binLookupInFlight.delete(bin);
    }
  })();

  binLookupInFlight.set(bin, task);
  return task;
}

module.exports = {
  normalizeCardBin,
  normalizeScheme,
  lookupCardBinInfo,
};
