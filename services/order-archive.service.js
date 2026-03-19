const Order = require("../model/order.model");
const { sendTelegramText } = require("./telegram-notify.service");

const ARCHIVE_CHANNEL_ID = String(
  process.env.ORDER_ARCHIVE_CHAT_ID || "@BuyStarsArxiv",
).trim();

const productLabels = {
  star: "Telegram Star",
  premium: "Telegram Premium",
  uc: "PUBG UC",
  balance: "Balans to'ldirish",
};

async function sendOrderArchive(orderOrId, options = {}) {
  const { statusLabel = "Muvaffaqiyatli" } = options;
  const order =
    typeof orderOrId === "object" && orderOrId?._id
      ? orderOrId
      : await Order.findById(orderOrId).lean();

  if (!order || !ARCHIVE_CHANNEL_ID) {
    return { ok: false, reason: "order_or_channel_missing" };
  }

  if (order.archiveSentAt) {
    return { ok: true, skipped: true, reason: "already_archived" };
  }

  const amountValue =
    order.product === "star" && Number(order.customAmount || 0) > 0
      ? order.customAmount
      : order.planCode;

  const message = [
    "✅ Muvaffaqiyatli buyurtma",
    `🧾 Buyurtma: <code>${order.orderId}</code>`,
    `📦 Mahsulot: <b>${productLabels[order.product] || order.product}</b>`,
    `👤 Mijoz: <code>${order.profileName || "-"}</code>`,
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
}

module.exports = {
  sendOrderArchive,
};
