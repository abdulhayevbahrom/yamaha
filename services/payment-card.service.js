const Order = require("../model/order.model");
const PaymentCard = require("../model/payment-card.model");
const { getPaymentCardConfig } = require("./settings.service");

function getPaymentCardDayRange(date = new Date()) {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const end = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
  return { start, end };
}

function getPaymentCardDayKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function resolveUsageRangeStart(card, dayStart) {
  const resetAt = card?.dailyUsageResetAt
    ? new Date(card.dailyUsageResetAt)
    : null;
  if (!resetAt || Number.isNaN(resetAt.getTime())) {
    return dayStart;
  }
  return resetAt > dayStart ? resetAt : dayStart;
}

async function getCardUsageMap(cards = []) {
  const list = Array.isArray(cards) ? cards.filter((item) => item?._id) : [];
  if (!list.length) return new Map();

  const { start: dayStart, end: dayEnd } = getPaymentCardDayRange();
  const counts = await Promise.all(
    list.map(async (card) => {
      const from = resolveUsageRangeStart(card, dayStart);
      const count = await Order.countDocuments({
        paymentCardId: card._id,
        status: { $ne: "cancelled" },
        createdAt: { $gte: from, $lt: dayEnd },
      });
      return [String(card._id), Number(count || 0)];
    }),
  );

  return new Map(counts);
}

function buildPaymentCardSnapshot(card, { isFallback = false } = {}) {
  if (!card?.cardNumber || !card?.cardHolder) return null;

  return {
    type: card.type,
    label: String(card.label || "").trim(),
    cardNumber: String(card.cardNumber || "").trim(),
    cardHolder: String(card.cardHolder || "").trim(),
    notes: String(card.notes || "").trim(),
    isFallback: Boolean(isFallback),
  };
}

function getLegacyFallbackCard(type) {
  if (
    String(process.env.ALLOW_PAYMENT_CARD_ENV_FALLBACK || "").toLowerCase() !==
    "true"
  ) {
    return null;
  }
  const prefix = type === "balance_topup" ? "TOPUP" : "PURCHASE";
  const fallback = {
    type,
    label: "Environment fallback card",
    cardNumber: String(
      process.env[`${prefix}_FALLBACK_CARD_NUMBER`] || "",
    ).trim(),
    cardHolder: String(
      process.env[`${prefix}_FALLBACK_CARD_HOLDER`] || "",
    ).trim(),
    notes: "",
  };
  if (!fallback.cardNumber || !fallback.cardHolder) return null;
  return {
    paymentCardId: null,
    paymentCardSnapshot: buildPaymentCardSnapshot(fallback, { isFallback: true }),
  };
}

async function listPaymentCardsForAdmin() {
  const [config, cards] = await Promise.all([
    getPaymentCardConfig(),
    PaymentCard.find().sort({ type: 1, sortOrder: 1, createdAt: 1 }).lean(),
  ]);

  const usageMap = await getCardUsageMap(cards);

  return {
    config,
    cards: cards.map((card) => {
      const currentDayTransactions = Math.max(
        usageMap.get(String(card._id)) || 0,
        card.usageDay === getPaymentCardDayKey()
          ? Number(card.usageCount || 0)
          : 0,
      );
      const remainingTransactions = Math.max(
        Number(config.dailyMaxTransactions || 0) - currentDayTransactions,
        0,
      );

      return {
        ...card,
        currentDayTransactions,
        // Keep old key for frontend compatibility during rollout.
        currentMonthTransactions: currentDayTransactions,
        remainingTransactions,
        isEligible: Boolean(card.isActive) && remainingTransactions > 0,
      };
    }),
  };
}

async function selectPaymentCardForType(type) {
  const config = await getPaymentCardConfig();
  const cards = await PaymentCard.find({ type, isActive: true })
    .sort({ sortOrder: 1, createdAt: 1 })
    .lean();

  if (!cards.length) {
    const fallback = getLegacyFallbackCard(type);
    return {
      ...(fallback || {
        paymentCardId: null,
        paymentCardSnapshot: null,
      }),
      config,
      reason: fallback ? "environment_fallback" : "not_configured",
    };
  }

  const dailyMaxTransactions = Number(config.dailyMaxTransactions || 0);
  const usageMap = await getCardUsageMap(cards);
  const usageDay = getPaymentCardDayKey();
  const candidates = [...cards];
  if (config.selectionMode === "random") {
    candidates.sort(() => Math.random() - 0.5);
  }

  for (const candidate of candidates) {
    const historicalUsage = usageMap.get(String(candidate._id)) || 0;
    await PaymentCard.updateOne(
      {
        _id: candidate._id,
        $or: [
          { usageDay: { $ne: usageDay } },
          { usageDay: { $exists: false } },
        ],
      },
      {
        $set: {
          usageDay,
          usageCount: historicalUsage,
        },
      },
    );

    const selected = await PaymentCard.findOneAndUpdate(
      {
        _id: candidate._id,
        isActive: true,
        usageDay,
        usageCount: { $lt: dailyMaxTransactions },
      },
      { $inc: { usageCount: 1 } },
      { new: true },
    ).lean();
    if (!selected) continue;

    return {
      paymentCardId: selected._id,
      paymentCardSnapshot: buildPaymentCardSnapshot(selected),
      allocation: {
        cardId: selected._id,
        usageDay,
      },
      config,
      reason: "selected",
    };
  }

  return {
    paymentCardId: null,
    paymentCardSnapshot: null,
    config,
    reason: "limit_reached",
  };
}

async function releasePaymentCardAllocation(allocation) {
  if (!allocation?.cardId || !allocation?.usageDay) return;
  await PaymentCard.updateOne(
    {
      _id: allocation.cardId,
      usageDay: allocation.usageDay,
      usageCount: { $gt: 0 },
    },
    { $inc: { usageCount: -1 } },
  );
}

module.exports = {
  buildPaymentCardSnapshot,
  listPaymentCardsForAdmin,
  releasePaymentCardAllocation,
  selectPaymentCardForType,
};
