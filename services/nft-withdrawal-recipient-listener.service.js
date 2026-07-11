const { NewMessage } = require("telegram/events");
const Order = require("../model/order.model");
const { getTelegramGiftClient } = require("./telegram-gift.service");
const { confirmNftWithdrawalById } = require("./nft-withdrawal-payout.service");

let listenerStarted = false;

function normalizeString(value) {
  return String(value || "").trim();
}

function toTelegramId(value) {
  if (value && typeof value.toString === "function") return value.toString();
  return normalizeString(value);
}

async function continueWithdrawalAfterRecipientContact(message) {
  if (!message || message.out) return;

  const sender = message.sender || (typeof message.getSender === "function"
    ? await message.getSender()
    : null);
  const tgUserId = toTelegramId(sender?.id || message.senderId?.userId);
  if (!tgUserId) return;

  console.log("[NFT_WITHDRAW_RECIPIENT_CONTACT] kiruvchi xabar olindi", {
    tgUserId,
    messageId: Number(message.id || 0),
  });

  const now = new Date();
  const order = await Order.findOneAndUpdate(
    {
      product: "nft_withdrawal",
      status: { $in: ["payment_submitted", "admin_action_processing"] },
      tgUserId,
      "fragmentTx.nftWithdrawal.awaitingRecipientContact": true,
      fulfillmentError: "recipient_contact_required",
    },
    {
      $set: {
        status: "payment_submitted",
        "fragmentTx.nftWithdrawal.awaitingRecipientContact": false,
        "fragmentTx.nftWithdrawal.recipientContactConfirmedAt": now.toISOString(),
        "fragmentTx.nftWithdrawal.recipientContactMessageId": Number(message.id || 0),
      },
    },
    { new: true },
  );
  if (!order) {
    console.log("[NFT_WITHDRAW_RECIPIENT_CONTACT] mos order topilmadi", {
      tgUserId,
      messageId: Number(message.id || 0),
    });
    return;
  }

  console.log("[NFT_WITHDRAW_RECIPIENT_CONTACT] order davom ettirilmoqda", {
    orderId: String(order._id),
    orderCode: Number(order.orderId || 0),
    tgUserId,
  });

  const result = await confirmNftWithdrawalById(order._id);
  if (!result.ok) {
    console.warn("[NFT_WITHDRAW_RECIPIENT_CONTACT] davom ettirib bo'lmadi", {
      orderId: String(order._id),
      tgUserId,
      reason: result.reason,
    });
  }
}

async function startNftWithdrawalRecipientListener() {
  if (listenerStarted) return { ok: true, alreadyStarted: true };

  const client = await getTelegramGiftClient();
  const self = await client.getMe();
  client.addEventHandler(
    (event) => continueWithdrawalAfterRecipientContact(event?.message).catch((error) => {
      console.error("[NFT_WITHDRAW_RECIPIENT_CONTACT] xabarni qayta ishlashda xato:", error?.message || error);
    }),
    new NewMessage({ incoming: true }),
  );
  listenerStarted = true;
  console.log("NFT yechib olish qabul qiluvchi xabarlari kuzatuvi ishga tushdi.", {
    selfId: toTelegramId(self?.id),
    selfUsername: normalizeString(self?.username),
  });
  return { ok: true };
}

module.exports = {
  startNftWithdrawalRecipientListener,
  continueWithdrawalAfterRecipientContact,
};
