function normalizeCardBin(value) {
  return String(value || "").replace(/\D/g, "").slice(0, 8);
}

function normalizeScheme(value) {
  return String(value || "").trim().toUpperCase();
}

async function lookupCardBinInfo(value) {
  const bin = normalizeCardBin(value);
  if (bin.length < 6) {
    return {
      bin,
      found: false,
      bankName: "",
      scheme: "",
      type: "",
      country: "",
    };
  }

  const fallbackPayload = {
    bin,
    found: false,
    bankName: "",
    scheme: "",
    type: "",
    country: "",
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4500);

  try {
    const external = await fetch(
      `https://lookup.binlist.net/${encodeURIComponent(bin)}`,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          "Accept-Version": "3",
        },
        signal: controller.signal,
      },
    );

    if (!external.ok) {
      return fallbackPayload;
    }

    const data = await external.json().catch(() => null);
    const bankName = String(data?.bank?.name || "").trim();
    const scheme = normalizeScheme(data?.scheme);
    const type = String(data?.type || "").trim();
    const country = String(data?.country?.name || "").trim();

    return {
      bin,
      found: Boolean(bankName || scheme || type || country),
      bankName,
      scheme,
      type,
      country,
    };
  } catch (_) {
    return fallbackPayload;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  normalizeCardBin,
  normalizeScheme,
  lookupCardBinInfo,
};
