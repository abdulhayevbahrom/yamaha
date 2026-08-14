const Plan = require("../model/plan.model");
const { getPubgProducts, getMlbbProducts } = require("./gw-api.service");

let syncPromise = null;
let mlbbSyncPromise = null;

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
  const products = await getPubgProducts();
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

  return Plan.find({ category: "uc" }).sort({ amount: 1 }).lean();
}

async function syncGwMlbbCatalog() {
  if (mlbbSyncPromise) return mlbbSyncPromise;
  mlbbSyncPromise = performMlbbSync();
  try {
    return await mlbbSyncPromise;
  } finally {
    mlbbSyncPromise = null;
  }
}

async function performMlbbSync() {
  const fetchedProducts = await getMlbbProducts();
  if (!fetchedProducts.length) throw new Error("GW MLBB katalogi bo'sh qaytdi");
  // GW ayrim region kataloglarida bir PIDni bir necha service ro'yxatida
  // qaytarishi mumkin. Bir xil provider buyurtmasini ikki marta yaratmaslik
  // uchun PID bo'yicha bitta yozuv qoldiramiz.
  const products = [...new Map(
    fetchedProducts.map((item) => [String(item.providerProductId).toUpperCase(), item]),
  ).values()];

  const syncedAt = new Date();
  const seenIds = products.map((item) => item.providerProductId);
  await Plan.updateMany(
    { category: "mlbb", provider: "gw", providerProductId: { $nin: seenIds } },
    { $set: { providerAvailable: false, providerQuantity: 0, providerSyncedAt: syncedAt } },
  );

  for (const item of products) {
    let existing = await Plan.findOne({
      category: "mlbb", provider: "gw", providerProductId: item.providerProductId,
    });
    if (!existing) {
      const sameAmount = await Plan.find({
        category: "mlbb", amount: item.amount,
        $or: [{ provider: "manual" }, { provider: { $exists: false } }],
      });
      if (sameAmount.length === 1) existing = sameAmount[0];
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
      try {
        await Plan.updateOne({ _id: existing._id }, { $set: changes });
      } catch (error) {
        throw new Error(`GW MLBB PID ${item.providerProductId} yangilanmadi: ${error.message}`);
      }
      continue;
    }
    const safeCode = `gw_${item.providerProductId}`.toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 80);
    try {
      await Plan.updateOne(
        { category: "mlbb", code: safeCode },
        {
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
        { upsert: true },
      );
    } catch (error) {
      throw new Error(`GW MLBB PID ${item.providerProductId} yaratilmadi: ${error.message}`);
    }
  }
  return Plan.find({ category: "mlbb" }).sort({ amount: 1 }).lean();
}

module.exports = { syncGwPubgCatalog, syncGwMlbbCatalog };
