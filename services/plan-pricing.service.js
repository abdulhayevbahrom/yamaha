const { getUsdUzsRate } = require("./usd-exchange-rate.service");

function hasGwMarkup(plan) {
  return plan?.provider === "gw" && plan.markupPercent != null;
}

async function getPlanPricingRate(plans) {
  if (!plans.some(hasGwMarkup)) return null;

  try {
    return await getUsdUzsRate();
  } catch (_) {
    return null;
  }
}

function getPlanPrice(plan, usdUzsRate) {
  if (!hasGwMarkup(plan)) return plan?.basePrice;

  const { providerPriceUsd, markupPercent } = plan;
  if (
    !Number.isFinite(providerPriceUsd) || providerPriceUsd <= 0 ||
    !Number.isFinite(usdUzsRate) || usdUzsRate <= 0 ||
    !Number.isFinite(markupPercent) || markupPercent < 0
  ) {
    return null;
  }

  const hundreds = (providerPriceUsd * usdUzsRate * (100 + markupPercent)) / 10_000;
  const nearest = Math.round(hundreds);
  // Keep an exact multiple of 100 from rounding up due to floating-point error.
  const tolerance = Math.abs(hundreds) * Number.EPSILON * 2;
  const rounded = nearest > 0 && Math.abs(hundreds - nearest) <= tolerance
    ? nearest
    : Math.ceil(hundreds);
  const price = rounded * 100;
  return Number.isSafeInteger(price) && price > 0 ? price : null;
}

module.exports = { hasGwMarkup, getPlanPricingRate, getPlanPrice };
