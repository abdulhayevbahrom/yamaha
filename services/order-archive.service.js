const Order = require("../model/order.model");
const Plan = require("../model/plan.model");
const { sendTelegramText } = require("./telegram-notify.service");
const { checkGwBalanceAfterSale } = require("./gw-balance-alert.service");

const ARCHIVE_CHANNEL_ID = String(
  process.env.ORDER_ARCHIVE_CHAT_ID || "@BuyStarsArxiv",
).trim();

const productLabels = {
  star: "Telegram Star",
  premium: "Telegram Premium",
  uc: "PUBG UC",
  freefire: "Free Fire Diamond",
  mlbb: "MLBB Diamond",
  hok: "Honor of Kings Tokens",
  roblox: "Roblox",
  bloodstrike: "Blood Strike",
  deltaforce: "Delta Force",
  balance: "Balans to'ldirish",
  star_sell: "Star Sotish",
  nft_withdrawal: "NFT Yechib Olish",
};

function getArchiveCustomerLabel(order) {
  const profileName = String(order?.profileName || "").trim();
  if (!profileName) return "-";
  const customerLabel = profileName
    .replace(/^Player ID:\s*/i, "")
    .replace(/\s*\|\s*Zone ID:\s*/i, " / Zone ID: ")
    .trim();

  const normalize = (value) =>
    String(value || "")
      .trim()
      .replace(/^@+/, "")
      .toLowerCase();

  const normalizedProfile = normalize(profileName);
  const normalizedUsername = normalize(order?.username);
  const normalizedTgUsername = normalize(order?.tgUsername);
  const normalizedTgUserId = normalize(order?.tgUserId);

  if (
    !normalizedProfile ||
    normalizedProfile === normalizedUsername ||
    normalizedProfile === normalizedTgUsername ||
    normalizedProfile === normalizedTgUserId
  ) {
    return "-";
  }

  if (profileName.startsWith("@")) {
    return "-";
  }

  return customerLabel || "-";
}

function formatGwPlanCode(product, planCode) {
  const match = String(planCode || "").match(/^gw_.*?(\d+)$/i);
  if (!match) return "";
  const amount = Number(match[1] || 0);
  if (!amount) return "";
  if (product === "freefire" || product === "mlbb") return `${amount} Diamond`;
  if (product === "uc") return `${amount} UC`;
  if (product === "hok") return `${amount} Tokens`;
  if (product === "deltaforce") return `${amount} Delta Force`;
  if (product === "bloodstrike") return `${amount} Blood Strike`;
  if (product === "roblox") return `${amount} Robux`;
  return "";
}

async function getArchiveAmountLabel(order) {
  const product = String(order?.product || "").trim().toLowerCase();
  const planCode = String(order?.planCode || "").trim();
  const customAmount = Number(order?.customAmount || 0);

  if ((product === "star" || product === "star_sell") && customAmount > 0) {
    return customAmount;
  }

  const plan = planCode
    ? await Plan.findOne({ category: product, code: planCode })
        .select({ label: 1, amount: 1 })
        .lean()
    : null;

  if (plan?.label) return String(plan.label);
  if (Number(plan?.amount || 0) > 0) return `${plan.amount}`;

  return formatGwPlanCode(product, planCode) || planCode || "-";
}

async function sendOrderArchive(orderOrId, options = {}) {
  try {
    const { statusLabel = "Muvaffaqiyatli" } = options;
    const order =
      typeof orderOrId === "object" && orderOrId?._id
        ? orderOrId
        : await Order.findById(orderOrId).lean();

    if (!order || !ARCHIVE_CHANNEL_ID) {
      return { ok: false, reason: "order_or_channel_missing" };
    }

    if (String(order?.fragmentTx?.provider || "").toLowerCase() === "gw") {
      const claimed = await Order.findOneAndUpdate(
        { _id: order._id, gwBalanceAlertCheckedAt: null },
        { $set: { gwBalanceAlertCheckedAt: new Date() } },
        { new: true },
      ).lean();
      if (claimed) checkGwBalanceAfterSale(order._id);
    }

    if (order.archiveSentAt) {
      return { ok: true, skipped: true, reason: "already_archived" };
    }

    const amountValue = await getArchiveAmountLabel(order);
    const customerLabel = getArchiveCustomerLabel(order);

    const message = [
      "✅ Muvaffaqiyatli buyurtma",
      `🧾 Buyurtma: <code>${order.orderId}</code>`,
      `📦 Mahsulot: <b>${productLabels[order.product] || order.product}</b>`,
      `👤 Mijoz: <code>${customerLabel}</code>`,
      `🎮 Miqdor: <code>${amountValue}</code>`,
      `💵 Summa: <b>${Number(order.paidAmount || order.expectedAmount || 0)} UZS</b>`,
      `💳 To'lov: <b>${order.paymentMethod || "-"}</b>`,
      `📌 Holat: <b>${statusLabel}</b>`,
    ].join("\n");

    const sent = await sendTelegramText(ARCHIVE_CHANNEL_ID, message, {
      parse_mode: "HTML",
    });

    if (!sent.ok) return sent;

    await Order.findByIdAndUpdate(order._id, { archiveSentAt: new Date() });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error.message || "archive_failed" };
  }
}

module.exports = {
  sendOrderArchive,
};
