const { broadcastReplyMarkup } = require("./broadcast-audience.service");
const Broadcast = require("../model/broadcast.model");
const BroadcastDelivery = require("../model/broadcastDelivery.model");

const MAX_ATTEMPTS = 3;
const DELIVERY_LOCK_MS = 2 * 60 * 1000;
const CAMPAIGN_LOCK_MS = 5 * 60 * 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function errorText(error) {
  return String(
    error?.response?.body?.description || error?.message || error || "send_failed",
  ).slice(0, 500);
}

async function sendBroadcastMessage(bot, broadcast, tgUserId) {
  const markup = broadcastReplyMarkup(broadcast, tgUserId);
  const options = markup ? { reply_markup: markup } : {};
  if (broadcast.type === "text") {
    return bot.sendMessage(tgUserId, broadcast.text, {
      ...options,
      ...(broadcast.entities?.length ? { entities: broadcast.entities } : {}),
    });
  }

  const mediaOptions = {
    ...options,
    ...(broadcast.text ? { caption: broadcast.text } : {}),
    ...(broadcast.captionEntities?.length
      ? { caption_entities: broadcast.captionEntities }
      : {}),
  };
  const fileId = broadcast.fileId || broadcast.photoFileId;
  if (broadcast.type === "photo") return bot.sendPhoto(tgUserId, fileId, mediaOptions);
  if (broadcast.type === "video") return bot.sendVideo(tgUserId, fileId, mediaOptions);
  return bot.sendDocument(tgUserId, fileId, mediaOptions);
}

async function claimDelivery(broadcastId) {
  const now = new Date();
  return BroadcastDelivery.findOneAndUpdate(
    {
      broadcastId,
      attempts: { $lt: MAX_ATTEMPTS },
      $or: [
        { status: "pending" },
        { status: "failed" },
        { status: "processing", lockUntil: { $lte: now } },
      ],
    },
    {
      $set: {
        status: "processing",
        lockUntil: new Date(Date.now() + DELIVERY_LOCK_MS),
      },
      $inc: { attempts: 1 },
    },
    { new: true, sort: { attempts: 1, _id: 1 } },
  ).lean();
}

async function refreshCounts(broadcastId) {
  const [totalCount, sentCount, failedCount] = await Promise.all([
    BroadcastDelivery.countDocuments({ broadcastId }),
    BroadcastDelivery.countDocuments({
      broadcastId,
      $or: [
        { status: "sent" },
        { status: { $exists: false }, messageId: { $gt: 0 } },
      ],
    }),
    BroadcastDelivery.countDocuments({
      broadcastId,
      status: "failed",
      attempts: { $gte: MAX_ATTEMPTS },
    }),
  ]);
  await Broadcast.findByIdAndUpdate(broadcastId, {
    $set: { totalCount, sentCount, failedCount },
  });
  return { totalCount, sentCount, failedCount };
}

async function notifyFinished(bot, broadcast, counts) {
  const text = [
    "✅ Reklama yuborish yakunlandi.",
    `ID: ${broadcast._id}`,
    `Jami: ${counts.totalCount}`,
    `Yuborildi: ${counts.sentCount}`,
    `Yuborilmadi: ${counts.failedCount}`,
  ].join("\n");
  await bot.sendMessage(broadcast.adminChatId, text, {
    reply_markup: {
      inline_keyboard: [[
        { text: "📊 Holat", callback_data: `AD_STATUS:${broadcast._id}` },
        { text: "✏️ Tahrirlash", callback_data: `AD_EDIT:${broadcast._id}` },
        { text: "🗑 O'chirish", callback_data: `AD_DEL:${broadcast._id}` },
      ]],
    },
  }).catch(() => null);
}

async function processCampaign(bot, broadcast) {
  let processed = 0;
  while (true) {
    const current = await Broadcast.findById(broadcast._id).lean();
    if (!current || !["processing"].includes(current.status)) return;
    const delivery = await claimDelivery(broadcast._id);
    if (!delivery) break;
    try {
      const sent = await sendBroadcastMessage(bot, current, delivery.tgUserId);
      await BroadcastDelivery.updateOne(
        { _id: delivery._id, status: "processing" },
        { $set: { status: "sent", messageId: sent.message_id, sentAt: new Date(), lockUntil: null, lastError: "" } },
      );
    } catch (error) {
      await BroadcastDelivery.updateOne(
        { _id: delivery._id },
        { $set: { status: "failed", lockUntil: null, lastError: errorText(error) } },
      );
    }
    processed += 1;
    if (processed % 20 === 0) {
      await refreshCounts(broadcast._id);
      await sleep(350);
    } else {
      await sleep(35);
    }
  }

  const counts = await refreshCounts(broadcast._id);
  const unfinished = await BroadcastDelivery.exists({
    broadcastId: broadcast._id,
    $or: [
      { status: "pending" },
      { status: "processing" },
      { status: "failed", attempts: { $lt: MAX_ATTEMPTS } },
    ],
  });
  if (unfinished) return;
  const finished = await Broadcast.findOneAndUpdate(
    { _id: broadcast._id, status: "processing" },
    { $set: { status: "completed", completedAt: new Date(), lockUntil: null, ...counts } },
    { new: true },
  ).lean();
  if (finished) await notifyFinished(bot, finished, counts);
}

async function claimCampaign() {
  const now = new Date();
  return Broadcast.findOneAndUpdate(
    {
      scheduledAt: { $lte: now },
      $or: [
        { status: "scheduled" },
        { status: "processing", lockUntil: { $lte: now } },
      ],
    },
    {
      $set: {
        status: "processing",
        startedAt: now,
        lockUntil: new Date(Date.now() + CAMPAIGN_LOCK_MS),
      },
    },
    { new: true, sort: { scheduledAt: 1 } },
  ).lean();
}

function startBroadcastWorker(bot, { intervalMs = 5000 } = {}) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      // One campaign per tick keeps other bot updates responsive.
      const campaign = await claimCampaign();
      if (campaign) await processCampaign(bot, campaign);
    } catch (error) {
      console.error("Broadcast worker error:", errorText(error));
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  setImmediate(tick);
  return { tick, stop: () => clearInterval(timer) };
}

module.exports = {
  MAX_ATTEMPTS,
  sendBroadcastMessage,
  refreshCounts,
  startBroadcastWorker,
};
