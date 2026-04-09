const Order = require("../model/order.model");
const PaymentCard = require("../model/payment-card.model");
const { getPaymentCardConfig } = require("./settings.service");

const LEGACY_PAYMENT_CARDS = {
  purchase: {
    type: "purchase",
    label: "Legacy purchase card",
    cardNumber: "6262 5707 3865 6539",
    cardHolder: "Bo'stonqulov Akmaljon",
    notes: "",
    isFallback: true,
  },
  balance_topup: {
    type: "balance_topup",
    label: "Legacy topup card",
    cardNumber: "5614 6838 1717 7439",
    cardHolder: "Po'latov Mirzaxmat",
    notes: "",
    isFallback: true,
  },
};

function getPaymentCardMonthRange(date = new Date()) {
  const start = new Date(date.getFullYear(), date.getMonth(), 1);
  const end = new Date(date.getFullYear(), date.getMonth() + 1, 1);
  return { start, end };
}

function mapCardUsageRows(rows = []) {
  const usageMap = new Map();
  rows.forEach((row) => {
    if (!row?._id) return;
    usageMap.set(String(row._id), Number(row.count || 0));
  });
  return usageMap;
}

async function getCardUsageMap(cardIds = []) {
  if (!cardIds.length) return new Map();

  const { start, end } = getPaymentCardMonthRange();
  const rows = await Order.aggregate([
    {
      $match: {
        createdAt: { $gte: start, $lt: end },
        status: { $ne: "cancelled" },
        paymentCardId: { $in: cardIds },
      },
    },
    {
      $group: {
        _id: "$paymentCardId",
        count: { $sum: 1 },
      },
    },
  ]);

  return mapCardUsageRows(rows);
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
  const fallback = LEGACY_PAYMENT_CARDS[type];
  if (!fallback) return null;
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

  const usageMap = await getCardUsageMap(cards.map((card) => card._id));

  return {
    config,
    cards: cards.map((card) => {
      const currentMonthTransactions = usageMap.get(String(card._id)) || 0;
      const remainingTransactions = Math.max(
        Number(config.monthlyMaxTransactions || 0) - currentMonthTransactions,
        0,
      );

      return {
        ...card,
        currentMonthTransactions,
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
    return {
      ...getLegacyFallbackCard(type),
      config,
      reason: "legacy_fallback",
    };
  }

  const usageMap = await getCardUsageMap(cards.map((card) => card._id));
  const monthlyMaxTransactions = Number(config.monthlyMaxTransactions || 0);
  const eligibleCards = cards.filter((card) => {
    const used = usageMap.get(String(card._id)) || 0;
    return used < monthlyMaxTransactions;
  });

  if (!eligibleCards.length) {
    return {
      paymentCardId: null,
      paymentCardSnapshot: null,
      config,
      reason: "limit_reached",
    };
  }

  let selected = eligibleCards[0];
  if (config.selectionMode === "random" && eligibleCards.length > 1) {
    const randomIndex = Math.floor(Math.random() * eligibleCards.length);
    selected = eligibleCards[randomIndex];
  }

  return {
    paymentCardId: selected._id,
    paymentCardSnapshot: buildPaymentCardSnapshot(selected),
    config,
    reason: "selected",
  };
}

module.exports = {
  buildPaymentCardSnapshot,
  listPaymentCardsForAdmin,
  selectPaymentCardForType,
};
