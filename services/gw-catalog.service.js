const Plan = require("../model/plan.model");
const crypto = require("node:crypto");
const { getPubgProducts, getPubgRedeemProducts, getMlbbProducts, getHokProducts } = require("./gw-api.service");

let syncPromise = null;
let mlbbSyncPromise = null;
let hokSyncPromise = null;

async function syncGwPubgCatalog() {
  if (syncPromise) return syncPromise;
  syncPromise = performSync();
  try {
    return await syncPromise;
  } finally {
    syncPromise = null;
  }
}

async function performSync() {
  const [products, redeemProducts] = await Promise.all([getPubgProducts(), getPubgRedeemProducts()]);
  if (!products.length) {
    throw new Error("GW PUBG katalogi bo'sh qaytdi");
  }
  const duplicatePid = products.find(
    (item, index) =>
      products.findIndex((row) => row.providerProductId === item.providerProductId) !== index,
  );
  if (duplicatePid) {
    throw new Error(`GW katalogida takroriy PID: ${duplicatePid.providerProductId}`);
  }
  const syncedAt = new Date();
  const seenIds = products.map((item) => item.providerProductId);

  if (seenIds.length) {
    await Plan.updateMany(
      {
        category: "uc",
        provider: "gw",
        providerProductId: { $nin: seenIds },
      },
      { $set: { providerAvailable: false, providerQuantity: 0, providerSyncedAt: syncedAt } },
    );
  }

  for (const item of products) {
    let existing = await Plan.findOne({
      category: "uc",
      provider: "gw",
      providerProductId: item.providerProductId,
    });

    if (!existing) {
      // Only numeric UC products may inherit a legacy manual package by amount.
      // Subscriptions and Growth Packs can share small numeric sort values, so
      // matching those by amount could overwrite an unrelated plan.
      if (/\bUC\b/i.test(String(item.label || ""))) {
        const sameAmount = await Plan.find({
          category: "uc",
          amount: item.amount,
          $or: [{ provider: "manual" }, { provider: { $exists: false } }],
        });
        if (sameAmount.length === 1) existing = sameAmount[0];
      }
    }

    if (existing) {
      if (
        Number(existing.providerPriceUsd || 0) !== Number(item.priceUsd) ||
        Boolean(existing.providerAvailable) !== Boolean(item.available) ||
        existing.providerQuantity !== item.stockQuantity
      ) {
        existing.providerUpdatedAt = syncedAt;
      }
      existing.provider = "gw";
      existing.providerProductId = item.providerProductId;
      existing.providerPriceUsd = item.priceUsd;
      existing.providerAvailable = item.available;
      existing.providerQuantity = item.stockQuantity;
      existing.providerSyncedAt = syncedAt;
      if (!existing.label) existing.label = item.label;
      if (!existing.amount) existing.amount = item.amount;
      await existing.save();
      continue;
    }

    const safeCode = `gw_${item.providerProductId}`
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "_")
      .slice(0, 80);
    await Plan.create({
      category: "uc",
      code: safeCode,
      label: item.label || `${item.amount} UC`,
      amount: item.amount,
      basePrice: 0,
      currency: "UZS",
      isActive: false,
      provider: "gw",
      providerProductId: item.providerProductId,
      providerPriceUsd: item.priceUsd,
      providerAvailable: item.available,
      providerQuantity: item.stockQuantity,
      providerSyncedAt: syncedAt,
      providerUpdatedAt: syncedAt,
    });
  }

  const redeemSeenIds = redeemProducts.map((item) => item.providerProductId);
  await Plan.updateMany(
    { category: "redeem", provider: "gw", providerProductId: { $nin: redeemSeenIds } },
    { $set: { providerAvailable: false, providerQuantity: 0, providerSyncedAt: syncedAt } },
  );
  for (const item of redeemProducts) {
    const safeCode = `gw_redeem_${item.providerProductId}`.toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 80);
    await Plan.findOneAndUpdate(
      { category: "redeem", provider: "gw", providerProductId: item.providerProductId },
      { $set: { label: item.label, amount: item.amount, providerPriceUsd: item.priceUsd,
        providerAvailable: item.available, providerQuantity: item.stockQuantity,
        providerSyncedAt: syncedAt, providerUpdatedAt: syncedAt },
        $setOnInsert: { category: "redeem", code: safeCode, basePrice: 0, currency: "UZS", isActive: false, provider: "gw" } },
      { upsert: true },
    );
  }

  return Plan.find({ category: { $in: ["uc", "redeem"] } }).sort({ category: 1, amount: 1 }).lean();
}

async function syncGwMlbbCatalog(options = {}) {
  if (mlbbSyncPromise) return mlbbSyncPromise;
  const traceId = String(options.traceId || `mlbb-${crypto.randomUUID()}`).slice(0, 80);
  mlbbSyncPromise = performMlbbSync(traceId);
  try {
    return await mlbbSyncPromise;
  } finally {
    mlbbSyncPromise = null;
  }
}

async function performMlbbSync(traceId) {
  let fetchedProducts;
  try {
    fetchedProducts = await getMlbbProducts();
  } catch (error) {
    console.error("[GW_MLBB_SYNC]", JSON.stringify({
      traceId, stage: "products_fetch_failed", status: Number(error?.response?.status || 0) || null,
      providerCode: String(error?.response?.data?.code || error?.response?.data?.error || "").slice(0, 100),
      message: String(error?.message || error).slice(0, 500), stack: String(error?.stack || "").slice(0, 2000),
    }));
    throw error;
  }
  if (!fetchedProducts.length) throw new Error("GW MLBB katalogi bo'sh qaytdi");
  // GW ayrim region kataloglarida bir PIDni bir necha service ro'yxatida
  // qaytarishi mumkin. Bir xil provider buyurtmasini ikki marta yaratmaslik
  // uchun PID bo'yicha bitta yozuv qoldiramiz.
  const products = [...new Map(
    fetchedProducts.map((item) => [String(item.providerProductId).toUpperCase(), item]),
  ).values()];

  const syncedAt = new Date();
  const seenIds = products.map((item) => item.providerProductId);
  try {
    await Plan.updateMany(
      { category: "mlbb", provider: "gw", providerProductId: { $nin: seenIds } },
      { $set: { providerAvailable: false, providerQuantity: 0, providerSyncedAt: syncedAt } },
    );
  } catch (error) {
    console.error("[GW_MLBB_SYNC]", JSON.stringify({ traceId, stage: "stale_update_failed", message: error.message, stack: error.stack }));
    throw error;
  }

  const existingPlans = await Plan.find({ category: "mlbb" }).lean();
  const existingByPid = new Map(
    existingPlans
      .filter((plan) => plan.provider === "gw" && plan.providerProductId)
      .map((plan) => [String(plan.providerProductId).toUpperCase(), plan]),
  );
  const manualByAmount = new Map();
  existingPlans
    .filter((plan) => !plan.provider || plan.provider === "manual")
    .forEach((plan) => {
      const key = Number(plan.amount || 0);
      const rows = manualByAmount.get(key) || [];
      rows.push(plan);
      manualByAmount.set(key, rows);
    });

  const claimedManualIds = new Set();
  const operations = [];
  for (const item of products) {
    let existing = existingByPid.get(String(item.providerProductId).toUpperCase());
    if (!existing) {
      const sameAmount = (manualByAmount.get(Number(item.amount || 0)) || [])
        .filter((plan) => !claimedManualIds.has(String(plan._id)));
      if (sameAmount.length === 1) {
        existing = sameAmount[0];
        claimedManualIds.add(String(existing._id));
      }
    }
    if (existing) {
      const providerChanged =
        Number(existing.providerPriceUsd || 0) !== Number(item.priceUsd) ||
        Boolean(existing.providerAvailable) !== Boolean(item.available) ||
        existing.providerQuantity !== item.stockQuantity;
      const changes = {
        provider: "gw",
        providerProductId: item.providerProductId,
        providerRegion: item.region || "global",
        providerPriceUsd: item.priceUsd,
        providerAvailable: item.available,
        providerQuantity: item.stockQuantity,
        providerSyncedAt: syncedAt,
      };
      if (providerChanged) changes.providerUpdatedAt = syncedAt;
      if (!existing.label) changes.label = item.label;
      if (!existing.amount) changes.amount = item.amount;
      operations.push({
        updateOne: { filter: { _id: existing._id }, update: { $set: changes } },
      });
      continue;
    }
    const safeCode = `gw_${item.providerProductId}`.toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 80);
    operations.push({
      updateOne: {
        filter: { category: "mlbb", code: safeCode },
        update: {
          $set: {
            provider: "gw", providerProductId: item.providerProductId,
            providerRegion: item.region || "global", providerPriceUsd: item.priceUsd,
            providerAvailable: item.available, providerQuantity: item.stockQuantity,
            providerSyncedAt: syncedAt, providerUpdatedAt: syncedAt,
          },
          $setOnInsert: {
            category: "mlbb", code: safeCode, label: item.label || `${item.amount} Diamonds`,
            amount: item.amount, basePrice: 0, currency: "UZS", isActive: false,
          },
        },
        upsert: true,
      },
    });
  }

  try {
    await Plan.bulkWrite(operations, { ordered: true });
  } catch (error) {
    console.error("[GW_MLBB_SYNC]", JSON.stringify({
      traceId, stage: "bulk_write_failed", message: String(error?.message || error).slice(0, 1000),
      code: error?.code || null, writeErrors: (error?.writeErrors || []).slice(0, 5).map((row) => ({
        index: row.index, code: row.code, message: String(row.errmsg || row.message || "").slice(0, 500),
      })), stack: String(error?.stack || "").slice(0, 3000),
    }));
    throw new Error(`GW MLBB bulk yangilash bajarilmadi: ${error.message}`);
  }
  const plans = await Plan.find({ category: "mlbb" }).sort({ amount: 1 }).lean();
  return plans;
}

async function syncGwHokCatalog() {
  if (hokSyncPromise) return hokSyncPromise;
  hokSyncPromise = performHokSync();
  try { return await hokSyncPromise; } finally { hokSyncPromise = null; }
}

async function performHokSync() {
  const fetched = await getHokProducts();
  if (!fetched.length) throw new Error("GW Honor of Kings katalogi bo'sh qaytdi");
  const products = [...new Map(fetched.map((item) => [item.providerProductId.toUpperCase(), item])).values()];
  const syncedAt = new Date();
  const seenIds = products.map((item) => item.providerProductId);
  await Plan.updateMany(
    { category: "hok", provider: "gw", providerProductId: { $nin: seenIds } },
    { $set: { providerAvailable: false, providerQuantity: 0, providerSyncedAt: syncedAt } },
  );
  for (const item of products) {
    const safeCode = `gw_${item.providerProductId}`.toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 80);
    await Plan.findOneAndUpdate(
      { category: "hok", provider: "gw", providerProductId: item.providerProductId },
      {
        $set: {
          label: item.label, amount: item.amount || 1, providerPriceUsd: item.priceUsd,
          providerAvailable: item.available, providerQuantity: item.stockQuantity,
          providerSyncedAt: syncedAt, providerUpdatedAt: syncedAt,
        },
        $setOnInsert: {
          category: "hok", code: safeCode, basePrice: 0, currency: "UZS",
          isActive: false, provider: "gw",
        },
      },
      { upsert: true },
    );
  }
  return Plan.find({ category: "hok" }).sort({ amount: 1 }).lean();
}

module.exports = { syncGwPubgCatalog, syncGwMlbbCatalog, syncGwHokCatalog };
