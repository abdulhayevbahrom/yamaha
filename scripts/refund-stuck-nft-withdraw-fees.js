const mongoose = require("mongoose");
const path = require("path");

require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const connectDB = require("../config/dbConfig");
const Order = require("../model/order.model");
const User = require("../model/user.model");
const { applyBalanceDeltaOnce } = require("../services/balance-operation.service");
const { getNftMarketplaceConfig } = require("../services/settings.service");

const FEE_PREFIX = "nft-withdraw-fee:";

function parseArgs(argv) {
  const args = {
    apply: false,
    includeOrphans: true,
    tgUserId: "",
    nftId: "",
    amount: null,
  };

  for (const raw of argv) {
    const arg = String(raw || "").trim();
    if (arg === "--apply") {
      args.apply = true;
      continue;
    }
    if (arg === "--no-orphans") {
      args.includeOrphans = false;
      continue;
    }
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (!match) continue;
    const key = match[1];
    const value = match[2];
    if (key === "tgUserId") args.tgUserId = value.trim();
    if (key === "nftId") args.nftId = value.trim();
    if (key === "amount") args.amount = Math.round(Number(value));
  }

  return args;
}

function isRefundKeyPresent(operationKeys, feeKey) {
  return operationKeys.includes(`nft-withdraw-fee-refund:${feeKey}`);
}

function normalizeString(value) {
  return String(value || "").trim();
}

async function findOrderForFeeKey(feeKey) {
  const transferRequestId = feeKey.slice(FEE_PREFIX.length);
  if (!transferRequestId) return null;

  return Order.findOne({
    product: "nft_withdrawal",
    "fragmentTx.nftWithdrawal.transferRequestId": transferRequestId,
  })
    .select(
      "orderId status fulfillmentStatus expectedAmount tgUserId fragmentTx createdAt updatedAt",
    )
    .lean();
}

async function buildRefundCandidates({ user, nftId, includeOrphans }) {
  const operationKeys = Array.isArray(user?.balanceOperationKeys)
    ? user.balanceOperationKeys.map(normalizeString).filter(Boolean)
    : [];

  const feeKeys = operationKeys.filter((key) => key.startsWith(FEE_PREFIX));
  const candidates = [];
  const skipped = [];

  for (const feeKey of feeKeys) {
    if (isRefundKeyPresent(operationKeys, feeKey)) {
      skipped.push({ feeKey, reason: "already_refunded" });
      continue;
    }

    const order = await findOrderForFeeKey(feeKey);
    const orderNftId = normalizeString(order?.fragmentTx?.nftWithdrawal?.nftId);

    if (order?.status === "completed") {
      skipped.push({
        feeKey,
        reason: "completed_order_fee",
        orderId: order.orderId,
      });
      continue;
    }

    if (nftId && order && orderNftId !== nftId) {
      skipped.push({
        feeKey,
        reason: "different_nft",
        orderId: order.orderId,
        nftId: orderNftId,
      });
      continue;
    }

    if (!order && !includeOrphans) {
      skipped.push({ feeKey, reason: "orphan_fee_ignored" });
      continue;
    }

    candidates.push({
      feeKey,
      refundKey: `nft-withdraw-fee-refund:${feeKey}`,
      orderId: order?.orderId || null,
      orderStatus: order?.status || "missing_order",
      fulfillmentStatus: order?.fulfillmentStatus || "",
      nftId: orderNftId || (order ? "" : "unknown_orphan"),
      expectedAmount: Math.round(Number(order?.expectedAmount || 0)),
    });
  }

  return { candidates, skipped };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.tgUserId) {
    throw new Error(
      "tgUserId kerak. Misol: node backend/scripts/refund-stuck-nft-withdraw-fees.js --tgUserId=996493305 --nftId=72506",
    );
  }

  await connectDB();

  const user = await User.findOne({ tgUserId: args.tgUserId })
    .select("tgUserId username balance nftEarningsBalance +balanceOperationKeys")
    .lean();

  if (!user) {
    throw new Error(`User topilmadi: ${args.tgUserId}`);
  }

  const config = await getNftMarketplaceConfig();
  const fallbackAmount = Math.round(Number(config?.withdrawFeeUzs || 0));
  const manualAmount = Number.isFinite(args.amount) && args.amount > 0
    ? args.amount
    : null;

  const { candidates, skipped } = await buildRefundCandidates({
    user,
    nftId: args.nftId,
    includeOrphans: args.includeOrphans,
  });

  const planned = candidates.map((candidate) => {
    const amount =
      candidate.expectedAmount > 0
        ? candidate.expectedAmount
        : manualAmount || fallbackAmount;
    return { ...candidate, amount };
  });

  console.log(
    JSON.stringify(
      {
        mode: args.apply ? "apply" : "dry-run",
        tgUserId: user.tgUserId,
        username: user.username || "",
        balanceBefore: user.balance || 0,
        nftEarningsBalanceBefore: user.nftEarningsBalance || 0,
        nftIdFilter: args.nftId || "",
        includeOrphans: args.includeOrphans,
        plannedRefundTotal: planned.reduce((sum, item) => sum + item.amount, 0),
        candidates: planned,
        skipped,
      },
      null,
      2,
    ),
  );

  if (!args.apply) {
    console.log("\nDry-run tugadi. Real qaytarish uchun shu commandga --apply qo'shing.");
    return;
  }

  const applied = [];
  for (const item of planned) {
    if (!item.amount || item.amount <= 0) {
      applied.push({ ...item, applied: false, reason: "invalid_amount" });
      continue;
    }

    const result = await applyBalanceDeltaOnce({
      tgUserId: user.tgUserId,
      operationKey: item.refundKey,
      amount: item.amount,
      extraIncrement: { nftEarningsBalance: item.amount },
    });

    applied.push({
      ...item,
      applied: Boolean(result.ok && result.applied),
      duplicate: Boolean(result.duplicate),
      reason: result.reason || "",
      balanceAfter: result.user?.balance,
      nftEarningsBalanceAfter: result.user?.nftEarningsBalance,
    });
  }

  const refreshed = await User.findOne({ tgUserId: user.tgUserId })
    .select("tgUserId username balance nftEarningsBalance")
    .lean();

  console.log(
    JSON.stringify(
      {
        appliedRefundTotal: applied
          .filter((item) => item.applied)
          .reduce((sum, item) => sum + item.amount, 0),
        applied,
        balanceAfter: refreshed?.balance,
        nftEarningsBalanceAfter: refreshed?.nftEarningsBalance,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error("[refund-stuck-nft-withdraw-fees] failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
