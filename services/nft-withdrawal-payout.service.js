const Order = require("../model/order.model");
const UserNft = require("../model/user-nft.model");
const { emitAdminUpdate, emitUserUpdate } = require("../socket");
const { applyBalanceDeltaOnce } = require("./balance-operation.service");
const {
  sendTelegramText,
  editTelegramText,
} = require("./telegram-notify.service");
const { sendOrderArchive } = require("./order-archive.service");
const {
  getManagerUsername,
  getManagerUrl,
} = require("./star-sell-payout.service");
const { getSupportConfig } = require("./settings.service");
const { transferSavedStarGiftToRecipient } = require("./telegram-gift.service");
const { isAmbiguousExternalError } = require("./external-operation.service");
const { getGiftSendErrorMessage } = require("./gift-send-error-message.service");

const READY_STATUSES = new Set([
  "payment_submitted",
  "paid_auto_processed",
  "completed",
  "cancelled",
]);

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeRecipient(value) {
  return normalizeString(value).replace(/^@+/, "");
}

function toSafeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatUzsAmount(value) {
  return `${Math.max(0, Math.round(toSafeNumber(value, 0))).toLocaleString("uz-UZ")} UZS`;
}

function getSafeFragmentTx(order) {
  return order?.fragmentTx &&
    typeof order.fragmentTx === "object" &&
    !Array.isArray(order.fragmentTx)
    ? order.fragmentTx
    : {};
}

function getAdminNotifyIds() {
  return String(process.env.ADMIN_NOTIFY_CHAT_ID || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildNftWithdrawalRequestText(order) {
  const fragmentTx = getSafeFragmentTx(order);
  const nftTx = fragmentTx.nftWithdrawal || {};
  const title = normalizeString(nftTx.title) || "NFT Gift";
  const nftNumber = Math.trunc(toSafeNumber(nftTx.nftNumber, 0));
  const username = normalizeString(order?.tgUsername || "");
  const profileName = normalizeString(order?.profileName || "");
  const usernameLabel = username ? `@${username}` : "-";
  const profileLabel = profileName && profileName !== username ? profileName : "-";

  return [
    "💸 NFT yechib olish so'rovi",
    `🧾 Buyurtma: #${order?.orderId || "-"}`,
    `👤 Mijoz: ${usernameLabel} (${String(order?.tgUserId || "-")})`,
    `🪪 Profil: ${profileLabel}`,
    `🎁 NFT: ${title}${nftNumber > 0 ? ` #${nftNumber}` : ""}`,
    `💰 Xizmat haqi: ${formatUzsAmount(nftTx.withdrawFeeUzs || order?.expectedAmount || 0)}`,
    "✅ Tasdiqlansa NFT Telegram profilingizga o'tkaziladi.",
    "⏳ 1 marta bosiladi. Bir admin tasdiqlasa, tugmalar hamma joydan yo'qoladi.",
  ].join("\n");
}

function buildAdminText(order, statusText) {
  const fragmentTx = getSafeFragmentTx(order);
  const nftTx = fragmentTx.nftWithdrawal || {};
  const username = String(order?.tgUsername || "").trim();
  const usernameLabel = username ? `@${username}` : "-";
  const title = normalizeString(nftTx.title) || "NFT Gift";
  const nftNumber = Math.trunc(toSafeNumber(nftTx.nftNumber, 0));
  const feeAmount = Number(nftTx.withdrawFeeUzs || order?.expectedAmount || 0);
  return [
    "💸 NFT yechib olish so'rovi",
    `🧾 Buyurtma: #${order?.orderId || "-"}`,
    `👤 Mijoz: ${usernameLabel} (${String(order?.tgUserId || "-")})`,
    `🎁 NFT: ${title}${nftNumber > 0 ? ` #${nftNumber}` : ""}`,
    `💰 Xizmat haqi: ${feeAmount.toLocaleString("uz-UZ")} UZS`,
    statusText,
  ].join("\n");
}

async function notifyAdminsAboutNftWithdrawalRequest(order) {
  const adminIds = getAdminNotifyIds();
  if (!adminIds.length || !order?._id) return [];

  const text = buildNftWithdrawalRequestText(order);
  const results = await Promise.allSettled(
    adminIds.map((adminId) =>
      sendTelegramText(adminId, text, {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "Tasdiqlash",
                callback_data: `CONFIRM_NFT_WITHDRAWAL:${String(order._id)}`,
              },
              {
                text: "Bekor qilish",
                callback_data: `CANCEL_NFT_WITHDRAWAL:${String(order._id)}`,
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

  if (!sentNotifications.length) return [];

  const fragmentTx = getSafeFragmentTx(order);
  await Order.findByIdAndUpdate(order._id, {
    $set: {
      fragmentTx: {
        ...fragmentTx,
        nftWithdrawalAdminNotifications: sentNotifications,
      },
    },
  });

  return sentNotifications;
}

async function syncAdminMessages(order, statusText) {
  const fragmentTx = getSafeFragmentTx(order);
  const items = Array.isArray(fragmentTx?.nftWithdrawalAdminNotifications)
    ? fragmentTx.nftWithdrawalAdminNotifications
    : [];
  if (!items.length) return;
  const text = buildAdminText(order, statusText);
  await Promise.allSettled(
    items.map((item) =>
      editTelegramText(item?.chatId, item?.messageId, text, {
        reply_markup: { inline_keyboard: [] },
      }),
    ),
  );
}

async function restoreNftWithdrawalState(order) {
  const fragmentTx = getSafeFragmentTx(order);
  const nftTx = fragmentTx.nftWithdrawal || {};
  const nftId = normalizeString(nftTx.nftId);
  const ownerTgUserId = normalizeString(nftTx.ownerTgUserId || order?.tgUserId);
  const transferRequestId = normalizeString(
    nftTx.transferRequestId || String(order?._id || ""),
  );

  if (!nftId || !ownerTgUserId) {
    return { ok: false, reason: "nft_missing" };
  }

  const restored = await UserNft.updateOne(
    {
      nftId,
      ownerTgUserId,
      transferStatus: "processing",
      transferRequestId,
    },
    {
      $set: {
        isTelegramPresent: true,
        marketStatus:
          normalizeString(nftTx.marketStatus) === "listed" ? "listed" : "owned",
        listingPriceUzs: Math.max(0, Math.round(toSafeNumber(nftTx.listingPriceUzs, 0))),
        listedAt: nftTx.listedAt ? new Date(nftTx.listedAt) : null,
        listedByTgUserId: normalizeString(nftTx.listedByTgUserId),
        transferStatus: "idle",
        transferRequestId: "",
        transferStartedAt: null,
        transferError: "",
      },
    },
  );

  return { ok: Boolean(restored.modifiedCount), restored };
}

async function transferNftForWithdrawal(order) {
  const fragmentTx = getSafeFragmentTx(order);
  const nftTx = fragmentTx.nftWithdrawal || {};
  const nftId = normalizeString(nftTx.nftId);
  const ownerTgUserId = normalizeString(nftTx.ownerTgUserId || order?.tgUserId);
  const recipientIdentifier = normalizeRecipient(
    nftTx.recipientIdentifier || order?.tgUsername || order?.tgUserId,
  );
  const transferRequestId = normalizeString(
    nftTx.transferRequestId || String(order?._id || ""),
  );

  if (!nftId || !ownerTgUserId || !recipientIdentifier) {
    return { ok: false, reason: "nft_missing" };
  }

  const nft = await UserNft.findOne({
    nftId,
    ownerTgUserId,
    transferStatus: "processing",
    transferRequestId,
  }).lean();

  if (!nft) {
    return { ok: false, reason: "nft_not_found" };
  }

  const transferMsgId = Math.trunc(toSafeNumber(nft?.sourceMsgId, 0));
  if (!transferMsgId || transferMsgId <= 0) {
    return { ok: false, reason: "source_missing" };
  }

  try {
    await transferSavedStarGiftToRecipient({
      msgId: transferMsgId,
      recipientIdentifier,
    });
  } catch (transferError) {
    const ambiguousTransfer = isAmbiguousExternalError(transferError);
    if (ambiguousTransfer) {
      await UserNft.updateOne(
        {
          nftId,
          ownerTgUserId,
          transferStatus: "processing",
          transferRequestId,
        },
        {
          $set: {
            transferStatus: "needs_review",
            transferError:
              normalizeString(transferError?.errorMessage || transferError?.message) ||
              "telegram_transfer_result_unknown",
          },
        },
      );
      return { ok: false, reason: "needs_review", ambiguous: true };
    }

    await restoreNftWithdrawalState(order);
    return {
      ok: false,
      reason: "transfer_failed",
      errorMessage: getGiftSendErrorMessage(transferError),
    };
  }

  const now = new Date();
  const finalizedTransfer = await UserNft.updateOne(
    {
      nftId,
      ownerTgUserId,
      transferStatus: "processing",
      transferRequestId,
    },
    {
      $set: {
        isTelegramPresent: false,
        marketStatus: "owned",
        listingPriceUzs: 0,
        listedAt: null,
        listedByTgUserId: "",
        withdrawnAt: now,
        withdrawnTo: recipientIdentifier,
        canTransferAt: null,
        transferStatus: "completed",
        transferError: "",
      },
    },
  );

  if (!finalizedTransfer.modifiedCount) {
    await UserNft.updateOne(
      {
        nftId,
        ownerTgUserId,
        transferStatus: "processing",
        transferRequestId,
      },
      {
        $set: {
          transferStatus: "needs_review",
          transferError: "nft_transfer_state_finalize_failed",
        },
      },
    );
    return { ok: false, reason: "finalize_failed" };
  }

  return { ok: true, recipientIdentifier, nft };
}

async function confirmNftWithdrawalById(orderId) {
  const order = await Order.findOneAndUpdate(
    {
      _id: orderId,
      product: "nft_withdrawal",
      status: { $in: ["payment_submitted", "paid_auto_processed"] },
    },
    { $set: { status: "admin_action_processing" } },
    { new: false },
  );
  if (!order) {
    const latest = await Order.findById(orderId);
    if (!latest) return { ok: false, reason: "not_found" };
    if (String(latest.product || "").toLowerCase() !== "nft_withdrawal") {
      return { ok: false, reason: "not_nft_withdrawal" };
    }
    if (latest.status === "completed") {
      return { ok: true, alreadyCompleted: true, order: latest };
    }
    return { ok: false, reason: "not_ready" };
  }

  const transferResult = await transferNftForWithdrawal(order);
  if (!transferResult.ok) {
    if (transferResult.reason === "needs_review") {
      const now = new Date();
      const fragmentTx = getSafeFragmentTx(order);
      order.status = "failed";
      order.fulfillmentStatus = "needs_review";
      order.completionMode = "manual";
      order.fulfilledAt = now;
      order.fulfillmentError =
        transferResult.errorMessage || "telegram_transfer_result_unknown";
      order.fragmentTx = {
        ...fragmentTx,
        nftWithdrawal: {
          ...(fragmentTx.nftWithdrawal || {}),
          needsReview: true,
          needsReviewAt: now.toISOString(),
        },
      };
      await order.save();
      await syncAdminMessages(order, "⚠️ Holat: Tekshiruv kerak");
      emitAdminUpdate({
        type: "nft_withdrawal_needs_review",
        refreshHistory: true,
        orderId: order._id,
      });
      if (String(order.tgUserId || "").trim()) {
        emitUserUpdate(String(order.tgUserId), {
          type: "nft_withdrawal_needs_review",
          refreshOrders: true,
          refreshNfts: true,
          orderId: order._id,
          status: order.status,
          product: order.product,
        });
        await sendTelegramText(
          order.tgUserId,
          "⚠️ NFT yechib olish so'rovingiz noaniq natija berdi. Administrator tekshiradi.",
        );
      }
      return { ok: false, reason: "needs_review" };
    }

    await Order.updateOne(
      { _id: order._id, status: "admin_action_processing" },
      {
        $set: {
          status: "payment_submitted",
          fulfillmentStatus: "needs_review",
          fulfillmentError:
            transferResult.errorMessage || transferResult.reason || "transfer_failed",
        },
      },
    );
    return { ok: false, reason: transferResult.reason || "transfer_failed" };
  }

  const now = new Date();
  const fragmentTx = getSafeFragmentTx(order);
  order.status = "completed";
  order.fulfillmentStatus = "success";
  order.completionMode = "manual";
  order.fulfilledAt = now;
  order.fulfillmentError = "";
  order.fragmentTx = {
    ...fragmentTx,
    nftWithdrawal: {
      ...(fragmentTx.nftWithdrawal || {}),
      confirmedByAdmin: true,
      confirmedAt: now.toISOString(),
      transferredTo: transferResult.recipientIdentifier,
    },
  };
  await order.save();
  await sendOrderArchive(order, { statusLabel: "Pul o'tkazildi" });
  await syncAdminMessages(order, "✅ Holat: Tasdiqlandi");

  emitAdminUpdate({
    type: "nft_withdrawal_confirmed",
    refreshHistory: true,
    orderId: order._id,
  });
  if (String(order.tgUserId || "").trim()) {
    emitUserUpdate(String(order.tgUserId), {
      type: "nft_withdrawal_completed",
      refreshOrders: true,
      refreshBalance: true,
      orderId: order._id,
      status: order.status,
      product: order.product,
    });
    await sendTelegramText(
      order.tgUserId,
      "✅ NFT yechib olish so'rovingiz tasdiqlandi va NFT Telegram profilingizga o'tkazildi.",
    );
  }
  return { ok: true, alreadyCompleted: false, order };
}

async function cancelNftWithdrawalById(orderId) {
  const order = await Order.findOneAndUpdate(
    {
      _id: orderId,
      product: "nft_withdrawal",
      status: { $in: [...READY_STATUSES].filter((status) => status !== "completed") },
    },
    { $set: { status: "admin_action_processing" } },
    { new: false },
  );
  if (!order) {
    const latest = await Order.findById(orderId);
    if (!latest) return { ok: false, reason: "not_found" };
    if (String(latest.product || "").toLowerCase() !== "nft_withdrawal") {
      return { ok: false, reason: "not_nft_withdrawal" };
    }
    if (latest.status === "completed") {
      return { ok: false, reason: "already_completed" };
    }
    if (latest.status === "cancelled") {
      return { ok: true, alreadyCancelled: true, order: latest };
    }
    return { ok: false, reason: "not_ready" };
  }

  const amount = Math.max(0, Math.round(Number(order.expectedAmount || 0)));
  const now = new Date();
  const supportConfig = await getSupportConfig().catch(() => null);
  const managerUsername = String(supportConfig?.username || getManagerUsername()).trim();
  const managerUrl = getManagerUrl(managerUsername);
  const fragmentTx = getSafeFragmentTx(order);

  const restoreResult = await restoreNftWithdrawalState(order);
  if (!restoreResult.ok) {
    await Order.updateOne(
      { _id: order._id, status: "admin_action_processing" },
      { $set: { status: order.status } },
    );
    return { ok: false, reason: "restore_failed" };
  }

  if (amount > 0 && String(order.tgUserId || "").trim()) {
    const creditResult = await applyBalanceDeltaOnce({
      tgUserId: order.tgUserId,
      operationKey: `nft-withdrawal-cancel:${String(order._id)}`,
      amount,
      extraIncrement: { nftEarningsBalance: amount },
    });
    if (!creditResult.ok) {
      await UserNft.updateOne(
        {
          nftId: normalizeString(fragmentTx?.nftWithdrawal?.nftId),
          ownerTgUserId: String(order.tgUserId || "").trim(),
        },
        {
          $set: {
            transferStatus: "processing",
            transferRequestId: normalizeString(
              fragmentTx?.nftWithdrawal?.transferRequestId || String(order?._id || ""),
            ),
          },
        },
      ).catch(() => {});
      await Order.updateOne(
        { _id: order._id, status: "admin_action_processing" },
        { $set: { status: order.status } },
      );
      return { ok: false, reason: creditResult.reason || "refund_failed" };
    }
  }

  order.status = "cancelled";
  order.fulfillmentStatus = "failed";
  order.completionMode = "manual";
  order.fulfilledAt = now;
  order.fulfillmentError = "nft_withdrawal_cancelled_by_admin";
  order.fragmentTx = {
    ...fragmentTx,
    nftWithdrawal: {
      ...(fragmentTx.nftWithdrawal || {}),
      cancelledByAdmin: true,
      cancelledAt: now.toISOString(),
      managerUsername,
    },
  };
  await order.save();
  await syncAdminMessages(order, `❌ Holat: Bekor qilindi (support: ${managerUsername})`);

  emitAdminUpdate({
    type: "nft_withdrawal_cancelled",
    refreshHistory: true,
    orderId: order._id,
  });
  if (String(order.tgUserId || "").trim()) {
    emitUserUpdate(String(order.tgUserId), {
      type: "nft_withdrawal_cancelled",
      refreshOrders: true,
      refreshBalance: true,
      orderId: order._id,
      status: order.status,
      product: order.product,
    });
    await sendTelegramText(order.tgUserId, "❌ NFT yechib olish so'rovingiz bekor qilindi.", {
      reply_markup: { inline_keyboard: [[{ text: "Adminga yozish", url: managerUrl }]] },
    });
  }
  return { ok: true, alreadyCancelled: false, order };
}

module.exports = {
  buildNftWithdrawalRequestText,
  notifyAdminsAboutNftWithdrawalRequest,
  confirmNftWithdrawalById,
  cancelNftWithdrawalById,
  buildAdminText,
};
