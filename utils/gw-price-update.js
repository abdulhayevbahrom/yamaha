function normalize(value) {
  return String(value || "").trim();
}

function normalizeKey(value) {
  return normalize(value)
    .toLowerCase()
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function normalizeCompact(value) {
  return normalizeKey(value).replace(/\s+/g, "");
}

function parseUsd(value) {
  const numeric = Number(normalize(value).replace(/[^0-9.]/g, ""));
  return Number.isFinite(numeric) ? numeric : 0;
}

function detectDirection(text) {
  const raw = normalize(text).toLowerCase();
  if (raw.includes("price increased")) return "increased";
  if (raw.includes("price decreased")) return "decreased";
  return "";
}

function detectCategory(gameLine) {
  const raw = normalizeCompact(gameLine);
  if (raw.includes("pubg")) return "uc";
  if (raw.includes("freefire")) return "freefire";
  if (raw.includes("mobilelegend") || raw.includes("mobilelegends") || raw.includes("mlbb")) {
    return "mlbb";
  }
  if (raw.includes("honorofkings") || raw.includes("hourofkings") || raw.includes("honourofkings")) {
    return "hok";
  }
  if (raw.includes("roblox") || raw.includes("robux")) return "roblox";
  if (raw.includes("bloodstrike")) return "bloodstrike";
  if (raw.includes("deltaforce")) return "deltaforce";
  if (raw.includes("magicchess")) return "magicchess";
  return "";
}

function detectRegion(gameLine) {
  const raw = normalizeKey(gameLine);
  if (/(^|\s)(malaysia|my)(\s|$)/.test(raw)) return "my";
  if (/(^|\s)(singapore|sg)(\s|$)/.test(raw)) return "sg";
  if (/(^|\s)(indonesia|id)(\s|$)/.test(raw)) return "id";
  if (/(^|\s)(philippines|philippine|ph)(\s|$)/.test(raw)) return "ph";
  if (/(^|\s)(turkey|turkiye|turkish|tr)(\s|$)/.test(raw)) return "tr";
  if (/(^|\s)(russia|russian|ru|cis)(\s|$)/.test(raw)) return "ru";
  if (/(^|\s)(global)(\s|$)/.test(raw)) return "global";
  return "";
}

function extractCode(productLine) {
  const raw = normalize(productLine);
  const lastToken = raw.split(/\s+/).pop() || "";
  if (/^[A-Z0-9]{5,}$/i.test(lastToken) && /[A-Z]/i.test(lastToken) && /\d/.test(lastToken)) {
    return lastToken.toUpperCase();
  }
  return "";
}

function extractAmount(productLine) {
  const match = normalize(productLine).match(/(\d[\d,]*)/);
  if (!match) return 0;
  const amount = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(amount) ? amount : 0;
}

function splitProductLine(line) {
  const raw = normalize(line);
  if (!raw) return { gameTitle: "", productLabel: "" };

  const parts = raw.split("·");
  if (parts.length >= 2) {
    return {
      gameTitle: normalize(parts[0]),
      productLabel: normalize(parts.slice(1).join("·")),
    };
  }

  return {
    gameTitle: raw,
    productLabel: raw,
  };
}

function parseGwPriceUpdateMessage(text) {
  const raw = normalize(text);
  if (!raw || !raw.includes("PRICE UPDATE ALERT")) return [];

  const direction = detectDirection(raw);
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^💰\s*PRICE UPDATE ALERT/i.test(line))
    .filter((line) => !/^(📉|📈)\s*Price\s+(decreased|increased)/i.test(line))
    .filter((line) => !/^[━\-_=]{5,}$/u.test(line));

  const items = [];
  for (let index = 0; index < lines.length; index += 1) {
    const productLine = lines[index];
    const priceLine = lines[index + 1];
    if (!productLine || !priceLine) continue;

    const priceMatch = priceLine.match(/\$?\s*([0-9]+(?:\.[0-9]+)?)\s*→\s*\$?\s*([0-9]+(?:\.[0-9]+)?)/);
    if (!priceMatch) continue;

    const { gameTitle, productLabel } = splitProductLine(productLine);
    items.push({
      direction,
      gameTitle,
      productLabel,
      category: detectCategory(gameTitle),
      region: detectRegion(gameTitle),
      providerProductId: extractCode(productLabel),
      amount: extractAmount(productLabel),
      previousUsd: parseUsd(priceMatch[1]),
      nextUsd: parseUsd(priceMatch[2]),
      rawProductLine: productLine,
      rawPriceLine: priceLine,
    });
    index += 1;
  }

  return items;
}

function isGwPriceAlertText(text) {
  const raw = normalize(text).toUpperCase();
  return raw.includes("PRICE UPDATE ALERT");
}

function buildPlanSearchKeys(plan) {
  const label = normalize(plan?.label);
  const amount = Number(plan?.amount || 0);
  const productId = normalize(plan?.providerProductId).toUpperCase();
  const compactLabel = normalizeCompact(label);
  const labelWithNoSpace = compactLabel;
  const keys = new Set();

  if (productId) keys.add(productId);
  if (label) keys.add(labelWithNoSpace);
  if (amount > 0) keys.add(String(amount));
  if (amount > 0 && compactLabel) keys.add(`${String(amount)}:${compactLabel}`);

  return keys;
}

function pickMatchingPlan(update, plans) {
  const category = normalize(update?.category);
  if (!category) return null;

  const filtered = plans.filter((plan) => normalize(plan?.category) === category);
  if (!filtered.length) return null;

  const providerProductId = normalize(update?.providerProductId).toUpperCase();
  if (providerProductId) {
    const pidMatch = filtered.find(
      (plan) => normalize(plan?.providerProductId).toUpperCase() === providerProductId,
    );
    if (pidMatch) return pidMatch;
  }

  const region = normalize(update?.region).toLowerCase();
  const amount = Number(update?.amount || 0);
  const compactProduct = normalizeCompact(update?.productLabel);
  const compactFull = normalizeCompact(update?.rawProductLine);

  const regionMatches = filtered.filter((plan) => {
    if (!region) return true;
    return normalize(plan?.providerRegion).toLowerCase() === region;
  });
  const regionPool = regionMatches.length ? regionMatches : filtered;

  const exactLabel = regionPool.find((plan) => {
    const keys = buildPlanSearchKeys(plan);
    return keys.has(compactProduct) || keys.has(compactFull);
  });
  if (exactLabel) return exactLabel;

  if (amount > 0) {
    const amountMatches = regionPool.filter((plan) => Number(plan?.amount || 0) === amount);
    if (amountMatches.length === 1) return amountMatches[0];
    if (amountMatches.length > 1) {
      const narrowed = amountMatches.find((plan) => {
        const planLabel = normalizeCompact(plan?.label);
        return compactProduct.includes(planLabel) || planLabel.includes(compactProduct);
      });
      if (narrowed) return narrowed;
    }
  }

  const fuzzy = regionPool.find((plan) => {
    const planLabel = normalizeCompact(plan?.label);
    return (
      planLabel &&
      (compactProduct.includes(planLabel) ||
        planLabel.includes(compactProduct) ||
        compactFull.includes(planLabel))
    );
  });
  return fuzzy || null;
}

function formatGwAlertMessage({ update, plan }) {
  const directionLabel = update?.direction === "increased" ? "oshdi" : "tushdi";
  const localPrice = Number(plan?.basePrice || 0);
  const localPriceLabel = localPrice > 0
    ? `${localPrice.toLocaleString("uz-UZ")} so'm`
    : "qo'yilmagan";

  return [
    "💰 Narx yangilandi",
    `O'yin: ${update?.gameTitle || "-"}`,
    `Mahsulot: ${update?.productLabel || "-"}`,
    `Holat: narx ${directionLabel}`,
    `Oldingi API narx: $${Number(update?.previousUsd || 0).toFixed(2)}`,
    `Yangi API narx: $${Number(update?.nextUsd || 0).toFixed(2)}`,
    `Bizdagi oldingi narx: ${localPriceLabel}`,
  ].join("\n");
}

module.exports = {
  parseGwPriceUpdateMessage,
  isGwPriceAlertText,
  pickMatchingPlan,
  formatGwAlertMessage,
};
