function parseCardxabarPaymentProvider(rawText) {
  const locationLine = String(rawText || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^📍\s*/u.test(line));
  const details = String(locationLine || "").replace(/^📍\s*/u, "").trim();
  const normalized = details.toUpperCase();
  if (/\bCLICK\b/.test(normalized)) return { code: "click", name: "CLICK", details };
  if (/\bALIF\b/.test(normalized)) return { code: "alif", name: "ALIF", details };
  return { code: details ? "other" : "unknown", name: details ? "Boshqa" : "Aniqlanmadi", details };
}

function isLevelReviewPaymentProvider(providerCode) {
  return ["click", "alif"].includes(String(providerCode || "").trim().toLowerCase());
}

module.exports = { parseCardxabarPaymentProvider, isLevelReviewPaymentProvider };
