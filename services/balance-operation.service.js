const User = require("../model/user.model");

function normalizeString(value) {
  return String(value || "").trim();
}

async function applyBalanceDeltaOnce({
  tgUserId,
  operationKey,
  amount,
  upsert = false,
  extraIncrement = null,
}) {
  const userId = normalizeString(tgUserId);
  const key = normalizeString(operationKey);
  const delta = Math.round(Number(amount || 0));

  if (!userId || !key || !Number.isFinite(delta) || delta === 0) {
    return { ok: false, reason: "invalid_balance_operation" };
  }

  const filter = {
    tgUserId: userId,
    balanceOperationKeys: { $ne: key },
  };
  if (delta < 0) {
    filter.balance = { $gte: Math.abs(delta) };
  }

  const increment = {
    balance: delta,
    ...(extraIncrement && typeof extraIncrement === "object"
      ? extraIncrement
      : {}),
  };

  const updated = await User.findOneAndUpdate(
    filter,
    {
      $inc: increment,
      $addToSet: { balanceOperationKeys: key },
    },
    { new: true },
  ).lean();

  if (updated) {
    return { ok: true, applied: true, user: updated };
  }

  const existing = await User.findOne({ tgUserId: userId })
    .select({ balance: 1, balanceOperationKeys: 1 })
    .lean();
  if (Array.isArray(existing?.balanceOperationKeys)) {
    if (existing.balanceOperationKeys.includes(key)) {
      return { ok: true, applied: false, duplicate: true, user: existing };
    }
  }

  if (!existing && upsert && delta > 0) {
    try {
      const created = await User.create({
        tgUserId: userId,
        balance: delta,
        balanceOperationKeys: [key],
        ...(extraIncrement && typeof extraIncrement === "object"
          ? extraIncrement
          : {}),
      });
      return { ok: true, applied: true, user: created.toObject() };
    } catch (error) {
      if (error?.code === 11000) {
        return applyBalanceDeltaOnce({
          tgUserId: userId,
          operationKey: key,
          amount: delta,
          upsert: false,
          extraIncrement,
        });
      }
      throw error;
    }
  }

  return {
    ok: false,
    reason: delta < 0 ? "insufficient_balance" : "user_not_found",
  };
}

module.exports = {
  applyBalanceDeltaOnce,
};
