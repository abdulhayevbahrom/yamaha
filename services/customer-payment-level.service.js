const Order = require("../model/order.model");
const { getCustomerPaymentLevels } = require("./settings.service");

const QUALIFYING_PRODUCTS = [
  "star", "premium", "uc", "redeem", "freefire", "mlbb", "hok",
  "roblox", "bloodstrike", "deltaforce",
];

function qualifiesForLevel(level, stats) {
  if (!level?.isActive) return false;
  if (Number(level.level) === 1) return true;
  const required = Number(level.qualificationValue || 0);
  if (level.qualificationType === "order_amount") {
    return Number(stats.completedOrderAmount || 0) >= required;
  }
  return Number(stats.completedOrderCount || 0) >= required;
}

function selectCustomerPaymentLevel(levels, stats) {
  const active = (Array.isArray(levels) ? levels : [])
    .filter((item) => item?.isActive)
    .sort((a, b) => Number(b.level) - Number(a.level));
  return active.find((item) => qualifiesForLevel(item, stats)) || null;
}

function requiresManualTopupReview(amount, maxAutoTopupAmount) {
  const numericAmount = Number(amount || 0);
  const numericLimit = Number(maxAutoTopupAmount || 0);
  return numericLimit >= 0 && numericAmount >= numericLimit;
}

async function getCustomerOrderStats(tgUserId) {
  const normalized = String(tgUserId || "").trim();
  if (!normalized) return { completedOrderCount: 0, completedOrderAmount: 0 };
  const [row] = await Order.aggregate([
    {
      $match: {
        tgUserId: normalized,
        product: { $in: QUALIFYING_PRODUCTS },
        status: "completed",
      },
    },
    {
      $group: {
        _id: null,
        completedOrderCount: { $sum: 1 },
        completedOrderAmount: {
          $sum: {
            $cond: [
              { $gt: [{ $ifNull: ["$paidAmount", 0] }, 0] },
              "$paidAmount",
              { $ifNull: ["$expectedAmount", 0] },
            ],
          },
        },
      },
    },
  ]);
  return {
    completedOrderCount: Number(row?.completedOrderCount || 0),
    completedOrderAmount: Number(row?.completedOrderAmount || 0),
  };
}

async function resolveCustomerPaymentLevel(tgUserId) {
  const [levels, stats] = await Promise.all([
    getCustomerPaymentLevels(),
    getCustomerOrderStats(tgUserId),
  ]);
  const selected = selectCustomerPaymentLevel(levels, stats) || levels[0];
  const nextLevel = levels
    .filter((item) => item.isActive && Number(item.level) > Number(selected?.level || 1))
    .sort((a, b) => Number(a.level) - Number(b.level))[0] || null;
  const badges = { 1: "🥉", 2: "🥈", 3: "🥇", 4: "💎", 5: "👑" };
  const currentMetric = selected?.qualificationType === "order_count"
    ? Number(stats.completedOrderCount || 0)
    : Number(stats.completedOrderAmount || 0);
  const nextMetric = nextLevel?.qualificationType === "order_count"
    ? Number(stats.completedOrderCount || 0)
    : Number(stats.completedOrderAmount || 0);
  return {
    level: Number(selected?.level || 1),
    name: String(selected?.name || "Bronze"),
    badge: badges[Number(selected?.level || 1)] || "🥉",
    maxAutoTopupAmount: Number(selected?.maxAutoTopupAmount || 0),
    qualificationType: String(selected?.qualificationType || "order_count"),
    qualificationValue: Number(selected?.qualificationValue || 0),
    currentMetric,
    nextLevel: nextLevel ? {
      level: Number(nextLevel.level),
      name: String(nextLevel.name || ""),
      badge: badges[Number(nextLevel.level)] || "",
      qualificationType: String(nextLevel.qualificationType || "order_amount"),
      requiredValue: Number(nextLevel.qualificationValue || 0),
      currentValue: nextMetric,
      remainingValue: Math.max(0, Number(nextLevel.qualificationValue || 0) - nextMetric),
    } : null,
    ...stats,
  };
}

module.exports = {
  QUALIFYING_PRODUCTS,
  qualifiesForLevel,
  selectCustomerPaymentLevel,
  requiresManualTopupReview,
  getCustomerOrderStats,
  resolveCustomerPaymentLevel,
};
