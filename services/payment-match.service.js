const crypto = require("crypto");
const Order = require("../model/order.model");
const PaymentLog = require("../model/payment-log.model");
const { autoFulfillOrder } = require("./avtoBuy.service");
const { emitAdminUpdate, emitUserUpdate } = require("../socket");
const { notifyGamePaid } = require("./notify.service");
const { sendOrderArchive } = require("./order-archive.service");
const { isManualGameProduct } = require("./uc-fulfillment.service");
const { sendTelegramText } = require("./telegram-notify.service");
const { applyBalanceDeltaOnce } = require("./balance-operation.service");
const {
  releaseReservationForOrder,
} = require("./payment-amount-reservation.service");

const PAYMENT_PROCESSING_STALE_MS = 30_000;

function buildPaymentEventKey(source, externalMessageId) {
  if (!externalMessageId) return "";
  return crypto
    .createHash("sha256")
    .update(`${source}\n${externalMessageId}`)
    .digest("hex");
}

function getAdminNotifyIds() {
  return String(process.env.ADMIN_NOTIFY_CHAT_ID || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function getGameProductLabel(product) {
  const key = String(product || "").trim().toLowerCase();
  if (key === "mlbb") return "MLBB";
  if (key === "freefire") return "Free Fire";
  if (key === "uc") return "PUBG UC";
  return "O'yin";
}

function splitMlbbAccount(value) {
  const raw = String(value || "").trim();
  if (!raw) return { playerId: "", zoneId: "" };
  const separatorIndex = raw.indexOf(":");
  if (separatorIndex < 0) return { playerId: raw, zoneId: "" };
  return {
    playerId: raw.slice(0, separatorIndex).trim(),
    zoneId: raw.slice(separatorIndex + 1).trim(),
  };
}

function buildGameAccountLines(order) {
  const key = String(order?.product || "").trim().toLowerCase();
  if (key !== "mlbb") {
    return [`🆔 ID: ${String(order?.username || "").trim() || "-"}`];
  }
  const parsed = splitMlbbAccount(order?.username);
  const playerId = String(order?.playerId || "").trim() || parsed.playerId;
  const zoneId = String(order?.zoneId || "").trim() || parsed.zoneId;
  const lines = [`🆔 ID: ${playerId || "-"}`];
  if (zoneId) lines.push(`🗺 Zone ID: ${zoneId}`);
  return lines;
}

async function notifyAdminsAboutManualGame(order) {
  if (!order || !isManualGameProduct(order.product)) return;
  const adminIds = getAdminNotifyIds();
  if (!adminIds.length) return;

  const productLabel = getGameProductLabel(order.product);
  const text = [
    `💬 ${productLabel} to'lov tushdi`,
    `🧾 Buyurtma: #${String(order?.orderId || "-")}`,
    ...buildGameAccountLines(order),
    `🎮 Miqdor: ${String(order?.planCode || "-")}`,
    `💵 Summa: ${Number(order?.expectedAmount || 0).toLocaleString("uz-UZ")} UZS`,
  ].join("\n");

  const results = await Promise.allSettled(
    adminIds.map((adminId) =>
      sendTelegramText(adminId, text, {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "Tasdiqlash",
                callback_data: `CONFIRM_GAME:${String(order?._id || "")}`,
              },
              {
                text: "Bekor qilish",
                callback_data: `CANCEL_GAME:${String(order?._id || "")}`,
              },
            ],
          ],
        },
      }),
    ),
  );

  const sentNotifications = results
    .filter((item) => item.status === "fulfilled" && item.value?.ok)
    .map((item) => item.value)
    .filter((item) => Number(item?.messageId || 0) > 0)
    .map((item) => ({
      chatId: String(item.chatId || ""),
      messageId: Number(item.messageId || 0),
    }))
    .filter((item) => item.chatId && item.messageId > 0);

  if (!sentNotifications.length || !order?._id) return;

  const fragmentTx =
    order?.fragmentTx && typeof order.fragmentTx === "object" && !Array.isArray(order.fragmentTx)
      ? order.fragmentTx
      : {};

  await Order.findByIdAndUpdate(order._id, {
    $set: {
      fragmentTx: {
        ...fragmentTx,
        gameAdminNotifications: sentNotifications,
      },
    },
  });
}

async function notifyAdminsAboutStarSell(order) {
  if (!order) return;
  const adminIds = getAdminNotifyIds();
  if (!adminIds.length) return;

  const username = String(order?.tgUsername || "").trim();
  const usernameLabel = username ? `@${username}` : "-";
  const text = [
    "⭐ Star sotish to'lovi qabul qilindi",
    `🧾 Buyurtma: #${order?.orderId || "-"}`,
    `👤 Mijoz: ${usernameLabel} (${String(order?.tgUserId || "-")})`,
    `✨ Star: ${Number(order?.customAmount || 0).toLocaleString("uz-UZ")}`,
    `💵 To'lov summasi: ${Number(order?.expectedAmount || 0).toLocaleString("uz-UZ")} UZS`,
    `💳 Mijoz kartasi: ${String(order?.sellCardNumber || "-")}`,
    "Pul o'tkazgach, tasdiqlashni bosing.",
  ].join("\n");

  const results = await Promise.all(
    adminIds.map((adminId) =>
      sendTelegramText(adminId, text, {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "Tasdiqlash",
                callback_data: `CONFIRM_STAR_SELL:${String(order?._id || "")}`,
              },
              {
                text: "Bekor qilish",
                callback_data: `CANCEL_STAR_SELL:${String(order?._id || "")}`,
              },
            ],
          ],
        },
      }),
    ),
  );

  const sentNotifications = results
    .filter((item) => item?.ok && Number(item?.messageId || 0) > 0)
    .map((item) => ({
      chatId: String(item.chatId || ""),
      messageId: Number(item.messageId || 0),
    }))
    .filter((item) => item.chatId && item.messageId > 0);

  if (!sentNotifications.length || !order?._id) return;

  const fragmentTx =
    order?.fragmentTx && typeof order.fragmentTx === "object" && !Array.isArray(order.fragmentTx)
      ? order.fragmentTx
      : {};

  await Order.findByIdAndUpdate(order._id, {
    $set: {
      fragmentTx: {
        ...fragmentTx,
        starSellAdminNotifications: sentNotifications,
      },
    },
  });
}

function parseAmountFromText(text) {
  const raw = String(text || "");
  const lines = raw.split(/\r?\n/).map((line) => line.trim());
  const plusLine = lines.find((line) => /^(\+|➕)/.test(line));
  if (plusLine) {
    const match = plusLine.match(/(\+|➕)\s*([\d\s.,]+)\s*UZS/i);
    if (match && match[2]) {
      const rawAmount = match[2].trim();
      const normalized = rawAmount.replace(/\s+/g, "");
      const value = Number(normalized.replace(/[^\d]/g, ""));
      if (Number.isFinite(value) && value > 0) return Math.round(value);
    }
  }

  return null;
}

async function expirePendingOrders() {
  const now = new Date();
  await Order.updateMany(
    { status: "pending_payment", expiresAt: { $lt: now } },
    { $set: { status: "cancelled" } },
  );
}

async function handlePostPaymentEffects(order, paidAmount, { userEventType = "payment_matched" } = {}) {
  if (!order) return { order: null, fulfillment: null };

  if (order.product === "balance" && order.tgUserId) {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - PAYMENT_PROCESSING_STALE_MS);
    const claimedOrder = await Order.findOneAndUpdate(
      {
        _id: order._id,
        status: { $in: ["payment_processing", "paid_auto_processed"] },
        $or: [
          { fulfillmentStatus: "pending" },
          { fulfillmentStatus: { $exists: false } },
          {
            fulfillmentStatus: "processing",
            fulfillmentStartedAt: { $in: [null] },
          },
          {
            fulfillmentStatus: "processing",
            fulfillmentStartedAt: { $lt: staleBefore },
          },
        ],
      },
      {
        $set: {
          fulfillmentStatus: "processing",
          fulfillmentStartedAt: now,
          fulfillmentError: "",
        },
      },
      { new: true },
    ).lean();

    if (!claimedOrder) {
      const latest = await Order.findById(order._id).lean();
      return {
        order: latest || order,
        fulfillment:
          latest?.status === "completed"
            ? { ok: true, duplicate: true }
            : { skipped: true, reason: "balance_credit_already_processing" },
      };
    }
    order = claimedOrder;

    const balanceIncrease = Number(order.balanceCreditAmount || paidAmount || 0);
    const creditResult = await applyBalanceDeltaOnce({
      tgUserId: order.tgUserId,
      operationKey: `balance-topup:${String(order._id)}`,
      amount: balanceIncrease,
      upsert: true,
    });
    if (!creditResult.ok) {
      await Order.findOneAndUpdate(
        { _id: order._id, fulfillmentStatus: "processing" },
        {
          $set: {
            fulfillmentStatus: "needs_review",
            fulfillmentError: creditResult.reason || "balance_credit_failed",
          },
        },
      );
      return {
        order,
        fulfillment: {
          ok: false,
          error: creditResult.reason || "balance_credit_failed",
        },
      };
    }
    const completedOrder = await Order.findOneAndUpdate(
      {
        _id: order._id,
        status: { $in: ["payment_processing", "paid_auto_processed"] },
        fulfillmentStatus: "processing",
      },
      {
        $set: {
          status: "completed",
          fulfillmentStatus: "success",
          completionMode: "auto",
          fulfilledAt: new Date(),
          fulfillmentError: "",
        },
      },
      { new: true },
    ).lean();
    if (!completedOrder) {
      await Order.findOneAndUpdate(
        { _id: order._id, fulfillmentStatus: "processing" },
        {
          $set: {
            fulfillmentStatus: "needs_review",
            fulfillmentError: "balance_order_finalize_failed",
          },
        },
      );
      return {
        order,
        fulfillment: {
          ok: false,
          needsReview: true,
          error: "balance_order_finalize_failed",
        },
      };
    }
    order = completedOrder;
    await sendOrderArchive(
      order,
      { statusLabel: "Balans to'ldirildi" },
    );
  }

  if (isManualGameProduct(order.product)) {
    emitAdminUpdate({
      type: "game_paid",
      refreshHistory: true,
      orderId: order._id,
      orderCode: order.orderId,
      product: order.product,
      username: order.username,
      planCode: order.planCode,
      expectedAmount: order.expectedAmount,
      paidAmount: order.paidAmount,
      paidAt: order.paidAt,
    });
    notifyGamePaid({
      orderId: order._id,
      orderCode: order.orderId,
      product: order.product,
      username: order.username,
      playerId: order.playerId,
      zoneId: order.zoneId,
      planCode: order.planCode,
      expectedAmount: order.expectedAmount,
      paymentMethod: order.paymentMethod,
    });
    await notifyAdminsAboutManualGame(order);
  }

  if (order.tgUserId) {
    emitUserUpdate(order.tgUserId, {
      type: order.product === "balance" ? "balance_topup_completed" : userEventType,
      refreshBalance: order.product === "balance",
      refreshOrders: true,
      orderId: order._id,
      status: order.product === "balance" ? "completed" : "paid_auto_processed",
      product: order.product,
    });
  }

  let fulfillment = null;
  try {
    fulfillment = await autoFulfillOrder(order);
  } catch (error) {
    fulfillment = { ok: false, error: error.message || "auto_fulfill_failed" };
  }

  return { order, fulfillment };
}

async function resumeExistingPayment(order, paidAmount) {
  if (!order) return { recovered: false, order: null, fulfillment: null };

  if (order.product === "balance" && order.status !== "completed") {
    const result = await handlePostPaymentEffects(order, paidAmount);
    return { recovered: true, ...result };
  }

  if (order.status === "payment_processing") {
    const paidOrder = await Order.findOneAndUpdate(
      { _id: order._id, status: "payment_processing" },
      { $set: { status: "paid_auto_processed" } },
      { new: true },
    ).lean();
    if (!paidOrder) {
      return { recovered: false, order, fulfillment: null };
    }
    const result = await handlePostPaymentEffects(paidOrder, paidAmount, {
      userEventType: "payment_matched",
    });
    return { recovered: true, ...result };
  }

  if (
    order.status === "paid_auto_processed" &&
    ["star", "premium"].includes(String(order.product || "").toLowerCase())
  ) {
    const fulfillment = await autoFulfillOrder(order);
    return { recovered: true, order, fulfillment };
  }

  return { recovered: false, order, fulfillment: null };
}

async function processIncomingPayment({
  rawText = "",
  amount = null,
  externalMessageId = null,
  source = "cardxabar",
}) {
  await expirePendingOrders();

  const parsedAmount = Math.round(
    Number(amount || parseAmountFromText(rawText) || 0),
  );
  const normalizedSource = String(source || "cardxabar").trim().slice(0, 80);
  const normalizedExternalMessageId =
    externalMessageId == null
      ? null
      : String(externalMessageId).trim().slice(0, 200);
  const paymentEventKey = buildPaymentEventKey(
    normalizedSource,
    normalizedExternalMessageId,
  );

  if (!Number.isSafeInteger(parsedAmount) || parsedAmount <= 0) {
    await PaymentLog.create({
      source: normalizedSource,
      externalMessageId: normalizedExternalMessageId || undefined,
      amount: 0,
      rawText,
      status: "invalid",
    });
    return { matched: false, reason: "amount_not_found", amount: 0 };
  }

  let paymentLog = null;
  if (normalizedExternalMessageId) {
    try {
      paymentLog = await PaymentLog.create({
        source: normalizedSource,
        externalMessageId: normalizedExternalMessageId,
        amount: parsedAmount,
        rawText,
        status: "processing",
      });
    } catch (error) {
      if (error?.code !== 11000) throw error;
      const existingLog = await PaymentLog.findOne({
        source: normalizedSource,
        externalMessageId: normalizedExternalMessageId,
      }).lean();
      const staleProcessing =
        existingLog?.status === "processing" &&
        Date.now() - new Date(existingLog.createdAt || 0).getTime() >
          PAYMENT_PROCESSING_STALE_MS;
      if (!staleProcessing) {
        if (existingLog?.matchedOrderId) {
          const existingOrder = await Order.findById(
            existingLog.matchedOrderId,
          ).lean();
          await resumeExistingPayment(existingOrder, parsedAmount);
        }
        return {
          matched: false,
          duplicate: true,
          reason: "duplicate_message",
          amount: parsedAmount,
        };
      }
      paymentLog = existingLog;
    }
  }

  const now = new Date();
  if (paymentEventKey) {
    const claimedByEvent = await Order.findOne({
      paymentEventKey,
      status: {
        $in: ["payment_processing", "paid_auto_processed", "completed"],
      },
    }).lean();
    if (claimedByEvent) {
      if (paymentLog?._id) {
        await PaymentLog.updateOne(
          { _id: paymentLog._id },
          {
            $set: {
              status: "matched",
              matchedOrderId: claimedByEvent._id,
            },
          },
        );
      }
      const resumed = await resumeExistingPayment(
        claimedByEvent,
        parsedAmount,
      );
      return {
        matched: true,
        recovered: true,
        amount: parsedAmount,
        order: resumed.order || claimedByEvent,
        fulfillment: resumed.fulfillment,
      };
    }
  }

  const matchFilter = {
    status: "pending_payment",
    expiresAt: { $gt: now },
    $or: [
      { paymentMatchAmount: parsedAmount },
      { paymentAlternateMatchAmount: parsedAmount },
      {
        paymentMatchAmount: { $in: [0, null] },
        expectedAmount: parsedAmount,
      },
      {
        paymentMatchAmount: { $exists: false },
        expectedAmount: parsedAmount,
      },
      {
        paymentMatchAmount: { $in: [0, null] },
        product: "balance",
        paymentMethod: "bankomat",
        balanceCreditAmount: parsedAmount,
      },
      {
        paymentMatchAmount: { $exists: false },
        product: "balance",
        paymentMethod: "bankomat",
        balanceCreditAmount: parsedAmount,
      },
    ],
  };
  const candidates = await Order.find(matchFilter)
    .sort({ createdAt: 1 })
    .limit(2)
    .lean();

  if (candidates.length > 1) {
    if (paymentLog?._id) {
      await PaymentLog.updateOne(
        { _id: paymentLog._id },
        { $set: { status: "unmatched" } },
      );
    } else {
      await PaymentLog.create({
        source: normalizedSource,
        externalMessageId: undefined,
        amount: parsedAmount,
        rawText,
        status: "unmatched",
      });
    }
    return {
      matched: false,
      reason: "ambiguous_pending_orders",
      amount: parsedAmount,
    };
  }

  const candidate = candidates[0];
  let pending = candidate
    ? await Order.findOneAndUpdate(
        {
          _id: candidate._id,
          status: "pending_payment",
          expiresAt: { $gt: now },
        },
        {
          $set: {
            status: "payment_processing",
            paidAmount: parsedAmount,
            paidAt: now,
            paymentEventKey,
          },
        },
        { new: true },
      ).lean()
    : null;

  if (!pending) {
    if (paymentLog?._id) {
      await PaymentLog.updateOne(
        { _id: paymentLog._id },
        { $set: { status: "unmatched" } },
      );
    } else {
      await PaymentLog.create({
        source: normalizedSource,
        externalMessageId: undefined,
        amount: parsedAmount,
        rawText,
        status: "unmatched",
      });
    }
    return {
      matched: false,
      reason: "pending_not_found",
      amount: parsedAmount,
    };
  }

  await releaseReservationForOrder(pending).catch(() => {});

  if (paymentLog?._id) {
    await PaymentLog.updateOne(
      { _id: paymentLog._id },
      {
        $set: {
          status: "matched",
          matchedOrderId: pending._id,
        },
      },
    );
  } else {
    await PaymentLog.create({
      source: normalizedSource,
      externalMessageId: undefined,
      amount: parsedAmount,
      rawText,
      status: "matched",
      matchedOrderId: pending._id,
    });
  }

  if (pending.product !== "balance") {
    const paidOrder = await Order.findOneAndUpdate(
      { _id: pending._id, status: "payment_processing" },
      { $set: { status: "paid_auto_processed" } },
      { new: true },
    ).lean();
    if (!paidOrder) {
      const latest = await Order.findById(pending._id).lean();
      return {
        matched: true,
        duplicate: true,
        amount: parsedAmount,
        order: latest || pending,
        fulfillment: null,
      };
    }
    pending = paidOrder;
  }

  const { fulfillment } = await handlePostPaymentEffects(pending, parsedAmount, {
    userEventType: "payment_matched",
  });

  return {
    matched: true,
    amount: parsedAmount,
    order: pending,
    fulfillment,
  };
}

async function processTelegramStarsPayment({
  invoicePayload = "",
  telegramPaymentChargeId = "",
  providerPaymentChargeId = "",
  totalAmount = 0,
  tgUserId = "",
  currency = "XTR",
}) {
  await expirePendingOrders();

  const payload = String(invoicePayload || "").trim();
  if (!payload) {
    return { matched: false, reason: "payload_required" };
  }

  const orderId = extractOrderIdFromPayload(payload);
  if (!orderId) {
    return { matched: false, reason: "order_id_missing" };
  }

  const order = await Order.findById(orderId).lean();
  if (!order) {
    return { matched: false, reason: "order_not_found" };
  }
  if (String(order.paymentMethod || "") !== "stars") {
    return { matched: false, reason: "not_stars_order", order };
  }
  if (String(order.status || "") !== "pending_payment") {
    return { matched: false, reason: "already_processed", order, duplicate: true };
  }
  if (String(currency || "").toUpperCase() !== "XTR") {
    return { matched: false, reason: "currency_invalid", order };
  }

  const paidStars = Math.max(0, Math.floor(Number(totalAmount || 0)));
  const expectedStars = Math.max(0, Math.floor(Number(order.starsAmount || 0)));
  if (expectedStars > 0 && paidStars !== expectedStars) {
    return {
      matched: false,
      reason: "stars_amount_mismatch",
      paidStars,
      expectedStars,
      order,
    };
  }

  const normalizedOrderUserId = String(order.tgUserId || "").trim();
  const normalizedUpdateUserId = String(tgUserId || "").trim();
  if (
    normalizedOrderUserId &&
    normalizedUpdateUserId &&
    normalizedOrderUserId !== normalizedUpdateUserId
  ) {
    return { matched: false, reason: "user_mismatch", order };
  }

  const now = new Date();
  const paidAmountUzs = Number(order.expectedAmount || 0);
  const fragmentTx =
    order.fragmentTx && typeof order.fragmentTx === "object" && !Array.isArray(order.fragmentTx)
      ? order.fragmentTx
      : {};

  const nextStatus =
    String(order.product || "").toLowerCase() === "star_sell"
      ? "payment_submitted"
      : "paid_auto_processed";

  const updated = await Order.findOneAndUpdate(
    { _id: order._id, status: "pending_payment" },
    {
      $set: {
        status: nextStatus,
        paidAmount: paidAmountUzs,
        paidAt: now,
        starsTelegramChargeId: String(telegramPaymentChargeId || "").trim(),
        fragmentTx: {
          ...fragmentTx,
          starsPayment: {
            payload,
            totalAmount: paidStars,
            currency: "XTR",
            telegramPaymentChargeId: String(telegramPaymentChargeId || "").trim(),
            providerPaymentChargeId: String(providerPaymentChargeId || "").trim(),
            paidAt: now.toISOString(),
          },
        },
      },
    },
    { new: true },
  ).lean();

  if (!updated) {
    return { matched: false, reason: "race_condition", order, duplicate: true };
  }

  if (String(updated.product || "").toLowerCase() === "star_sell") {
    emitAdminUpdate({
      type: "star_sell_paid",
      refreshHistory: true,
      orderId: updated._id,
      orderCode: updated.orderId,
      product: updated.product,
      tgUserId: updated.tgUserId,
    });
    if (String(updated.tgUserId || "").trim()) {
      emitUserUpdate(updated.tgUserId, {
        type: "star_sell_payment_received",
        refreshOrders: true,
        refreshBalance: false,
        orderId: updated._id,
        status: updated.status,
        product: updated.product,
      });
    }
    await notifyAdminsAboutStarSell(updated);
    return {
      matched: true,
      order: updated,
      fulfillment: null,
      paidStars,
      paidAmountUzs,
    };
  }

  const { fulfillment } = await handlePostPaymentEffects(updated, paidAmountUzs, {
    userEventType: "payment_matched",
  });

  return {
    matched: true,
    order: updated,
    fulfillment,
    paidStars,
    paidAmountUzs,
  };
}

function extractOrderIdFromPayload(payload) {
  const normalized = String(payload || "").trim();
  if (!normalized) return "";

  const knownPrefixes = [
    "stars_order:",
    "stars_sell_order:",
    "star_sell_order:",
    "order:",
  ];
  for (const prefix of knownPrefixes) {
    if (normalized.startsWith(prefix)) {
      const candidate = normalized.slice(prefix.length).split(":")[0]?.trim();
      if (candidate) return candidate;
    }
  }

  const objectIdMatch = normalized.match(/\b[a-f0-9]{24}\b/i);
  return String(objectIdMatch?.[0] || "").trim();
}

module.exports = {
  parseAmountFromText,
  processIncomingPayment,
  processTelegramStarsPayment,
};
