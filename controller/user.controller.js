const response = require("../utils/response");
const User = require("../model/user.model");
const Order = require("../model/order.model");
const UserGift = require("../model/user-gift.model");
const UserNft = require("../model/user-nft.model");
const NftOffer = require("../model/nft-offer.model");
const ReferralEarning = require("../model/referral-earning.model");
const { getNextOrderId } = require("../services/order-id.service");
const { emitUserUpdate } = require("../socket");
const { getTelegramUserFromRequest } = require("../utils/tg-user");
const { selectPaymentCardForType } = require("../services/payment-card.service");
const {
  activateReferralOnMiniAppOpen,
  buildReferralLink,
  ensureReferralIdentity,
} = require("../services/referral.service");
const {
  calculateBankomatNetAmount,
} = require("../services/balance-topup.service");
const {
  getBankomatTopupConfig,
  getReferralConfig,
  getNftWithdrawalConfig,
} = require("../services/settings.service");
const { lookupCardBinInfo, normalizeScheme } = require("../services/card-bin.service");
const { sendTelegramText } = require("../services/telegram-notify.service");

const SUPPORTED_SCHEMES = new Set(["HUMOCARD", "HUMO", "UZCARD", "UNIONPAY", "UNIYONPAY"]);

const PENDING_TTL_MS = 10 * 60 * 1000;
const PURCHASE_ORDER_PRODUCTS = ["star", "premium", "uc", "freefire", "mlbb"];
const PAID_ORDER_STATUSES = ["paid_auto_processed", "completed"];

function normalizeString(value) {
  return String(value || "").trim();
}

function buildVirtualOrderId(prefix, rawId) {
  const suffix = normalizeString(rawId).slice(-6).toUpperCase() || "000000";
  return `${prefix}-${suffix}`;
}

function toDateMs(value) {
  const time = new Date(value || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

async function ensureUser({ tgUserId, username, profileName = "" }) {
  if (!tgUserId) return null;
  return ensureReferralIdentity({
    tgUserId,
    username,
    profileName: String(profileName || "").trim(),
  });
}

async function getMe(req, res) {
  try {
    const tgUser = getTelegramUserFromRequest(req);
    if (!tgUser.tgUserId) {
      return response.error(
        res,
        "Telegram profilingiz aniqlanmadi. Ilovani qayta ochib ko'ring.",
      );
    }

    await activateReferralOnMiniAppOpen(tgUser);
    const [
      user,
      totalOrders,
      spending,
      inviteCount,
      referralConfig,
      giftStats,
      nftTradeCount,
      nftBuySpending,
    ] =
      await Promise.all([
        ensureUser(tgUser),
        Order.countDocuments({
          tgUserId: tgUser.tgUserId,
          product: { $in: PURCHASE_ORDER_PRODUCTS },
        }),
        Order.aggregate([
          {
            $match: {
              tgUserId: tgUser.tgUserId,
              product: { $in: PURCHASE_ORDER_PRODUCTS },
              status: { $in: PAID_ORDER_STATUSES },
              paidAmount: { $gt: 0 },
            },
          },
          {
            $group: {
              _id: null,
              totalSpent: { $sum: "$paidAmount" },
            },
          },
        ]),
        User.countDocuments({ referredByUserId: tgUser.tgUserId }),
        getReferralConfig(),
        UserGift.aggregate([
          {
            $match: {
              tgUserId: tgUser.tgUserId,
            },
          },
          {
            $group: {
              _id: null,
              count: { $sum: 1 },
              totalSpent: { $sum: "$priceUzs" },
            },
          },
        ]),
        NftOffer.countDocuments({
          status: "accepted",
          $or: [
            { buyerTgUserId: tgUser.tgUserId },
            { sellerTgUserId: tgUser.tgUserId },
          ],
        }),
        NftOffer.aggregate([
          {
            $match: {
              status: "accepted",
              buyerTgUserId: tgUser.tgUserId,
            },
          },
          {
            $group: {
              _id: null,
              totalSpent: { $sum: "$offeredPriceUzs" },
            },
          },
        ]),
      ]);

    const baseOrderCount = Number(totalOrders || 0);
    const giftCount = Number(giftStats?.[0]?.count || 0);
    const totalHistoryCount = baseOrderCount + giftCount + Number(nftTradeCount || 0);

    const baseOrderSpent = Number(spending?.[0]?.totalSpent || 0);
    const giftSpent = Number(giftStats?.[0]?.totalSpent || 0);
    const nftBuySpent = Number(nftBuySpending?.[0]?.totalSpent || 0);
    const totalSpent = baseOrderSpent + giftSpent + nftBuySpent;

    return response.success(res, "Profile", {
      ...user,
      isBlocked: Boolean(user?.isBlocked),
      blockedAt: user?.blockedAt || null,
      blockedReason: String(user?.blockedReason || ""),
      stats: {
        totalOrders: totalHistoryCount,
        totalSpent,
      },
      referral: {
        code: String(user?.referralCode || ""),
        link: buildReferralLink(user?.referralCode || ""),
        inviteCount: Number(inviteCount || 0),
        earningsTotal: Number(user?.referralEarningsTotal || 0),
        signupBonusTotal: Number(user?.referralSignupBonusTotal || 0),
        commissionTotal: Number(user?.referralOrderCommissionTotal || 0),
        signupBonusAmount: Number(referralConfig?.signupBonusAmount || 0),
        orderPercent: Number(referralConfig?.orderPercent || 0),
        botUsername: String(referralConfig?.botUsername || ""),
        botLink: String(referralConfig?.botLink || ""),
      },
    });
  } catch (error) {
    return response.serverError(res, "Profile olishda xatolik", error.message);
  }
}

async function getMyReferrals(req, res) {
  try {
    const tgUser = getTelegramUserFromRequest(req);
    if (!tgUser.tgUserId) {
      return response.error(
        res,
        "Telegram profilingiz aniqlanmadi. Ilovani qayta ochib ko'ring.",
      );
    }

    await activateReferralOnMiniAppOpen(tgUser);
    const requestedPage = Number(req.query?.page || 1);
    const requestedLimit = Number(req.query?.limit || 20);
    const page =
      Number.isFinite(requestedPage) && requestedPage > 0
        ? Math.floor(requestedPage)
        : 1;
    const limit =
      Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(100, Math.floor(requestedLimit))
        : 20;

    const [user, referralConfig, totalItems] = await Promise.all([
      ensureUser(tgUser),
      getReferralConfig(),
      User.countDocuments({ referredByUserId: tgUser.tgUserId }),
    ]);

    const totalPages = Math.max(1, Math.ceil(Number(totalItems || 0) / limit));
    const safePage = Math.min(page, totalPages);

    const referredUsers = totalItems
      ? await User.find({ referredByUserId: tgUser.tgUserId })
          .sort({ referredAt: -1, createdAt: -1 })
          .skip((safePage - 1) * limit)
          .limit(limit)
          .select({
            tgUserId: 1,
            username: 1,
            referredAt: 1,
            referralActivatedAt: 1,
            createdAt: 1,
          })
          .lean()
      : [];

    const referredUserIds = referredUsers.map((item) => String(item.tgUserId));
    if (!referredUserIds.length) {
      return response.success(res, "My referrals", {
        referralCode: String(user?.referralCode || ""),
        referralLink: buildReferralLink(user?.referralCode || ""),
        summary: {
          inviteCount: 0,
          earningsTotal: Number(user?.referralEarningsTotal || 0),
          signupBonusTotal: Number(user?.referralSignupBonusTotal || 0),
          commissionTotal: Number(user?.referralOrderCommissionTotal || 0),
          signupBonusAmount: Number(referralConfig?.signupBonusAmount || 0),
          orderPercent: Number(referralConfig?.orderPercent || 0),
        },
        pagination: {
          page: safePage,
          limit,
          totalItems: Number(totalItems || 0),
          totalPages,
        },
        items: [],
      });
    }

    const [earningRows, orderRows] = await Promise.all([
      ReferralEarning.aggregate([
        {
          $match: {
            referrerTgUserId: tgUser.tgUserId,
            referredTgUserId: { $in: referredUserIds },
          },
        },
        {
          $group: {
            _id: "$referredTgUserId",
            totalEarned: { $sum: "$amount" },
            signupBonusTotal: {
              $sum: {
                $cond: [{ $eq: ["$type", "signup_bonus"] }, "$amount", 0],
              },
            },
            commissionTotal: {
              $sum: {
                $cond: [{ $eq: ["$type", "order_commission"] }, "$amount", 0],
              },
            },
          },
        },
      ]),
      Order.aggregate([
        {
          $match: {
            tgUserId: { $in: referredUserIds },
            product: { $in: ["star", "premium", "uc", "freefire", "mlbb"] },
            status: { $in: ["paid_auto_processed", "completed"] },
            paidAmount: { $gt: 0 },
          },
        },
        {
          $group: {
            _id: "$tgUserId",
            totalOrders: { $sum: 1 },
            totalSpent: { $sum: "$paidAmount" },
          },
        },
      ]),
    ]);

    const earningsMap = new Map(
      earningRows.map((item) => [String(item._id), item]),
    );
    const ordersMap = new Map(orderRows.map((item) => [String(item._id), item]));

    const items = referredUsers.map((referredUser) => {
      const earning = earningsMap.get(String(referredUser.tgUserId)) || {};
      const order = ordersMap.get(String(referredUser.tgUserId)) || {};

      return {
        tgUserId: String(referredUser.tgUserId),
        username: String(referredUser.username || ""),
        referredAt: referredUser.referredAt || referredUser.createdAt || null,
        referralActivatedAt: referredUser.referralActivatedAt || null,
        totalOrders: Number(order.totalOrders || 0),
        totalSpent: Number(order.totalSpent || 0),
        totalEarned: Number(earning.totalEarned || 0),
        signupBonusTotal: Number(earning.signupBonusTotal || 0),
        commissionTotal: Number(earning.commissionTotal || 0),
      };
    });

    return response.success(res, "My referrals", {
      referralCode: String(user?.referralCode || ""),
      referralLink: buildReferralLink(user?.referralCode || ""),
      summary: {
        inviteCount: Number(totalItems || 0),
        earningsTotal: Number(user?.referralEarningsTotal || 0),
        signupBonusTotal: Number(user?.referralSignupBonusTotal || 0),
        commissionTotal: Number(user?.referralOrderCommissionTotal || 0),
        signupBonusAmount: Number(referralConfig?.signupBonusAmount || 0),
        orderPercent: Number(referralConfig?.orderPercent || 0),
      },
      pagination: {
        page: safePage,
        limit,
        totalItems: Number(totalItems || 0),
        totalPages,
      },
      items,
    });
  } catch (error) {
    return response.serverError(
      res,
      "Referral ma'lumotlarini olishda xatolik",
      error.message,
    );
  }
}

async function getBalance(req, res) {
  try {
    const tgUserId = String(
      req.params?.tgUserId || req.query?.tgUserId || "",
    ).trim();
    const authUserId = normalizeString(req?.telegramAuth?.tgUserId);

    if (!tgUserId) {
      return response.error(
        res,
        "Telegram profilingiz aniqlanmadi. Ilovani qayta ochib ko'ring.",
      );
    }
    if (authUserId && authUserId !== tgUserId) {
      return response.forbidden(
        res,
        "Faqat o'zingizning balansingizni ko'rishingiz mumkin",
      );
    }

    let user = await User.findOne({ tgUserId }).lean();

    // Legacy users: nftEarningsBalance field was introduced later.
    // Recover only when the field is missing, not when it is legitimately 0.
    const hasNftEarningsBalance =
      user && Object.prototype.hasOwnProperty.call(user, "nftEarningsBalance");
    if (user?.tgUserId && !hasNftEarningsBalance) {
      const legacyRows = await UserNft.aggregate([
        {
          $match: {
            lastSellerTgUserId: String(tgUserId),
            lastSellerNetUzs: { $gt: 0 },
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: "$lastSellerNetUzs" },
          },
        },
      ]);
      const recovered = Math.max(0, Math.round(Number(legacyRows?.[0]?.total || 0)));
      if (recovered > 0) {
        user = await User.findOneAndUpdate(
          { tgUserId },
          { $set: { nftEarningsBalance: recovered } },
          { new: true },
        ).lean();
      }
    }

    const nftWithdrawalConfig = await getNftWithdrawalConfig();
    return response.success(res, "Balance", {
      tgUserId,
      balance: Number(user?.balance || 0),
      nftEarningsBalance: Number(user?.nftEarningsBalance || 0),
      nftWithdrawalConfig,
    });
  } catch (error) {
    return response.serverError(res, "Balance olishda xatolik", error.message);
  }
}

async function createNftWithdrawalRequest(req, res) {
  try {
    const tgUser = getTelegramUserFromRequest(req);
    if (!tgUser?.tgUserId) {
      return response.error(res, "Telegram profilingiz aniqlanmadi. Ilovani qayta ochib ko'ring.");
    }
    const config = await getNftWithdrawalConfig();
    if (!config?.enabled) {
      return response.error(res, "Yechib olish xizmati hozircha o'chirilgan");
    }

    const rawCard = String(req.body?.cardNumber || "").replace(/\D/g, "").slice(0, 16);
    const amount = Math.round(Number(req.body?.amount || 0));
    if (rawCard.length !== 16) return response.error(res, "Karta raqami 16 ta bo'lishi kerak");
    if (!Number.isFinite(amount) || amount <= 0) return response.error(res, "Summani kiriting");

    const binInfo = await lookupCardBinInfo(rawCard);
    const scheme = normalizeScheme(binInfo?.scheme);
    if (!SUPPORTED_SCHEMES.has(scheme)) {
      return response.error(res, "Faqat HUMOCARD, UZCARD yoki UNIONPAY kartalari qabul qilinadi");
    }

    const feePercent = Number(config.feePercent || 0);
    const feeAmount = Math.round((amount * feePercent) / 100);
    const netAmount = Math.max(0, amount - feeAmount);

    const updatedUser = await User.findOneAndUpdate(
      { tgUserId: tgUser.tgUserId, nftEarningsBalance: { $gte: amount }, balance: { $gte: amount } },
      { $inc: { nftEarningsBalance: -amount, balance: -amount } },
      { new: true },
    ).lean();
    if (!updatedUser) return response.error(res, "NFT sotuvdan tushgan balans yetarli emas");

    const nextOrderId = await getNextOrderId();
    const order = await Order.create({
      orderId: nextOrderId,
      product: "nft_withdrawal",
      planCode: "nft_withdrawal",
      customAmount: amount,
      username: tgUser.username ? `@${tgUser.username}` : tgUser.tgUserId,
      tgUserId: tgUser.tgUserId,
      tgUsername: tgUser.username || "",
      profileName: tgUser.username ? `@${tgUser.username}` : tgUser.tgUserId,
      paymentMethod: "card",
      sellCardNumber: rawCard,
      paymentCardSnapshot: {
        type: "purchase",
        label: "NFT Withdrawal",
        cardNumber: rawCard,
        cardHolder: "",
        notes: "",
        isFallback: false,
      },
      expectedAmount: amount,
      paidAmount: amount,
      paidAt: new Date(),
      status: "payment_submitted",
      sequence: nextOrderId,
      fragmentTx: {
        nftWithdrawal: {
          feePercent,
          feeAmountUzs: feeAmount,
          netAmountUzs: netAmount,
        },
      },
    });

    const adminIds = String(process.env.ADMIN_NOTIFY_CHAT_ID || "").split(",").map((v) => String(v).trim()).filter(Boolean);
    const text = [
      "💸 NFT sotuv balansini yechib olish so'rovi",
      `🧾 Buyurtma: #${order.orderId}`,
      `👤 Mijoz: @${String(order.tgUsername || "").replace(/^@+/, "") || "-"} (${order.tgUserId})`,
      `💳 Mijoz kartasi: ${rawCard}`,
      `💰 So'ralgan summa: ${amount.toLocaleString("uz-UZ")} UZS`,
      `📉 Komissiya: ${feePercent}%`,
      `✅ Mijozga beriladigan: ${netAmount.toLocaleString("uz-UZ")} UZS`,
      "Pul o'tkazgach, tasdiqlashni bosing.",
    ].join("\n");
    const notifications = await Promise.all(
      adminIds.map((adminId) =>
        sendTelegramText(adminId, text, {
          reply_markup: {
            inline_keyboard: [[
              { text: "Tasdiqlash", callback_data: `CONFIRM_NFT_WITHDRAWAL:${String(order._id)}` },
              { text: "Bekor qilish", callback_data: `CANCEL_NFT_WITHDRAWAL:${String(order._id)}` },
            ]],
          },
        }),
      ),
    );
    const sent = notifications
      .filter((item) => item?.ok && Number(item?.messageId || 0) > 0)
      .map((item) => ({ chatId: String(item.chatId || ""), messageId: Number(item.messageId || 0) }))
      .filter((item) => item.chatId && item.messageId > 0);
    if (sent.length) {
      await Order.findByIdAndUpdate(order._id, {
        $set: { "fragmentTx.nftWithdrawalAdminNotifications": sent },
      });
    }

    emitUserUpdate(tgUser.tgUserId, {
      type: "nft_withdrawal_requested",
      refreshOrders: true,
      refreshBalance: true,
      orderId: order._id,
      status: order.status,
      product: order.product,
    });

    return response.created(res, "NFT sotuv balansi yechib olish so'rovi yuborildi", {
      orderId: order._id,
      requestedAmountUzs: amount,
      feePercent,
      feeAmountUzs: feeAmount,
      netAmountUzs: netAmount,
      balance: Number(updatedUser?.balance || 0),
      nftEarningsBalance: Number(updatedUser?.nftEarningsBalance || 0),
    });
  } catch (error) {
    return response.serverError(res, "Yechib olish so'rovini yaratishda xatolik", error.message);
  }
}

async function getMyOrders(req, res) {
  try {
    const tgUser = getTelegramUserFromRequest(req);
    if (!tgUser.tgUserId) {
      return response.error(
        res,
        "Telegram profilingiz aniqlanmadi. Ilovani qayta ochib ko'ring.",
      );
    }

    const now = new Date();
    await Order.updateMany(
      { status: "pending_payment", expiresAt: { $lt: now } },
      { $set: { status: "cancelled" } },
    );

    const [orders, userGifts, acceptedOffers, marketSales] = await Promise.all([
      Order.find({ tgUserId: tgUser.tgUserId }).sort({ createdAt: -1 }).limit(250).lean(),
      UserGift.find({ tgUserId: tgUser.tgUserId })
        .sort({ createdAt: -1 })
        .limit(250)
        .select({
          giftId: 1,
          stars: 1,
          priceUzs: 1,
          emoji: 1,
          title: 1,
          status: 1,
          sentAt: 1,
          createdAt: 1,
          updatedAt: 1,
        })
        .lean(),
      NftOffer.find({
        status: "accepted",
        $or: [
          { buyerTgUserId: tgUser.tgUserId },
          { sellerTgUserId: tgUser.tgUserId },
        ],
      })
        .sort({ acceptedAt: -1, createdAt: -1 })
        .limit(250)
        .select({
          nftId: 1,
          buyerTgUserId: 1,
          buyerProfileName: 1,
          buyerUsername: 1,
          sellerTgUserId: 1,
          sellerProfileName: 1,
          sellerUsername: 1,
          offeredPriceUzs: 1,
          acceptedAt: 1,
          respondedAt: 1,
          createdAt: 1,
          updatedAt: 1,
        })
        .lean(),
      UserNft.find({
        lastSoldAt: { $ne: null },
        $or: [
          { lastBuyerTgUserId: tgUser.tgUserId },
          { lastSellerTgUserId: tgUser.tgUserId },
        ],
      })
        .sort({ lastSoldAt: -1, updatedAt: -1 })
        .limit(250)
        .select({
          nftId: 1,
          title: 1,
          lastSoldAt: 1,
          lastSoldPriceUzs: 1,
          lastBuyerTgUserId: 1,
          lastSellerTgUserId: 1,
        })
        .lean(),
    ]);

    const nftIds = Array.from(
      new Set(acceptedOffers.map((item) => normalizeString(item?.nftId)).filter(Boolean)),
    );
    const nftDocs = nftIds.length
      ? await UserNft.find({ nftId: { $in: nftIds } })
          .select({ nftId: 1, title: 1 })
          .lean()
      : [];
    const nftTitleMap = new Map(
      nftDocs.map((item) => [normalizeString(item?.nftId), normalizeString(item?.title)]),
    );

    const orderItems = orders.map((item) => ({
      ...item,
      sourceType: "order",
    }));

    const giftItems = userGifts.map((gift) => ({
      _id: `gift_${gift._id}`,
      orderId: buildVirtualOrderId("GIFT", gift._id),
      status: "completed",
      product: "gift",
      planCode: normalizeString(gift?.title) || "Gift",
      customAmount: Number(gift?.stars || 0),
      expectedAmount: Number(gift?.priceUzs || 0),
      paidAmount: Number(gift?.priceUzs || 0),
      paymentGrossAmount: Number(gift?.priceUzs || 0),
      paymentMethod: "balance",
      createdAt: gift?.createdAt || gift?.updatedAt || null,
      updatedAt: gift?.updatedAt || gift?.createdAt || null,
      sourceType: "gift_purchase",
      emoji: normalizeString(gift?.emoji) || "🎁",
      giftId: normalizeString(gift?.giftId),
    }));

    const nftItems = acceptedOffers.map((offer) => {
      const isBuyer = normalizeString(offer?.buyerTgUserId) === normalizeString(tgUser.tgUserId);
      const title = nftTitleMap.get(normalizeString(offer?.nftId)) || "NFT Gift";
      const sourceType = isBuyer ? "nft_buy" : "nft_sell";
      return {
        _id: `nft_${offer._id}_${sourceType}`,
        orderId: buildVirtualOrderId(isBuyer ? "NFT-BUY" : "NFT-SELL", offer._id),
        status: "completed",
        product: "nft",
        planCode: title,
        expectedAmount: Number(offer?.offeredPriceUzs || 0),
        paidAmount: Number(offer?.offeredPriceUzs || 0),
        paymentGrossAmount: Number(offer?.offeredPriceUzs || 0),
        paymentMethod: "balance",
        createdAt:
          offer?.acceptedAt || offer?.respondedAt || offer?.updatedAt || offer?.createdAt || null,
        updatedAt:
          offer?.updatedAt || offer?.acceptedAt || offer?.respondedAt || offer?.createdAt || null,
        sourceType,
        nftId: normalizeString(offer?.nftId),
        counterpartyName: isBuyer
          ? normalizeString(offer?.sellerProfileName || offer?.sellerUsername || offer?.sellerTgUserId)
          : normalizeString(offer?.buyerProfileName || offer?.buyerUsername || offer?.buyerTgUserId),
      };
    });

    const nftMarketItems = marketSales.map((trade) => {
      const isBuyer = normalizeString(trade?.lastBuyerTgUserId) === normalizeString(tgUser.tgUserId);
      const sourceType = isBuyer ? "nft_buy_market" : "nft_sell_market";
      return {
        _id: `nft_market_${normalizeString(trade?.nftId)}_${toDateMs(trade?.lastSoldAt)}`,
        orderId: buildVirtualOrderId(isBuyer ? "NFT-BUY" : "NFT-SELL", `${trade?.nftId || ""}_${toDateMs(trade?.lastSoldAt)}`),
        status: "completed",
        product: "nft",
        planCode: normalizeString(trade?.title) || "NFT Gift",
        expectedAmount: Number(trade?.lastSoldPriceUzs || 0),
        paidAmount: Number(trade?.lastSoldPriceUzs || 0),
        paymentGrossAmount: Number(trade?.lastSoldPriceUzs || 0),
        paymentMethod: "balance",
        createdAt: trade?.lastSoldAt || trade?.updatedAt || null,
        updatedAt: trade?.lastSoldAt || trade?.updatedAt || null,
        sourceType,
        nftId: normalizeString(trade?.nftId),
      };
    });

    const allItems = [...orderItems, ...giftItems, ...nftItems, ...nftMarketItems]
      .sort((a, b) => toDateMs(b?.createdAt || b?.updatedAt) - toDateMs(a?.createdAt || a?.updatedAt))
      .slice(0, 300);

    return response.success(res, "My orders", allItems);
  } catch (error) {
    return response.serverError(
      res,
      "Orderlarni olishda xatolik",
      error.message,
    );
  }
}

async function createBalanceTopup(req, res) {
  try {
    const tgUser = getTelegramUserFromRequest(req);
    if (!tgUser.tgUserId) {
      return response.error(
        res,
        "Telegram profilingiz aniqlanmadi. Ilovani qayta ochib ko'ring.",
      );
    }

    const amount = Number(req.body?.amount || 0);
    const paymentMethod = String(req.body?.paymentMethod || "card").trim();
    if (!amount || amount <= 0) {
      return response.error(res, "Summani kiriting");
    }
    if (!["card", "bankomat"].includes(paymentMethod)) {
      return response.error(res, "To'lov usuli noto'g'ri");
    }

    const currentUser = await ensureUser(tgUser);
    if (currentUser?.isBlocked) {
      return response.error(res, "Foydalanuvchi bloklangan");
    }

    const now = Date.now();
    const aliveFrom = new Date(now - PENDING_TTL_MS);
    const activePendingFilter = {
      status: "pending_payment",
      createdAt: { $gte: aliveFrom },
      expiresAt: { $gt: new Date(now) },
    };

    let expectedAmount = amount;
    let paymentGrossAmount = amount;
    let balanceCreditAmount = amount;
    let paymentFeePercent = 0;

    if (paymentMethod === "bankomat") {
      const bankomatConfig = await getBankomatTopupConfig();
      const feePercent = Number(bankomatConfig?.feePercent || 0);
      const netAmount = calculateBankomatNetAmount(amount, feePercent);

      if (netAmount <= 0) {
        return response.error(res, "Bu summa juda kichik. Kattaroq summa kiriting");
      }

      const duplicatePending = await Order.findOne({
        ...activePendingFilter,
        product: "balance",
        paymentMethod: "bankomat",
        expectedAmount: amount,
      }).lean();

      if (duplicatePending) {
        return response.error(res, "Bu summa hozir band. Boshqa summa kiriting");
      }

      expectedAmount = amount;
      paymentGrossAmount = amount;
      balanceCreditAmount = netAmount;
      paymentFeePercent = feePercent;
    } else {
      const pendingCount = await Order.countDocuments(activePendingFilter);
      expectedAmount = amount + Number(pendingCount || 0);
      paymentGrossAmount = expectedAmount;
      balanceCreditAmount = expectedAmount;
      paymentFeePercent = 0;
    }

    let selectedCard;
    try {
      selectedCard = await selectPaymentCardForType("balance_topup");
    } catch (selectionError) {
      if (
        selectionError?.message === "Hozircha to'lov kartasi mavjud emas"
      ) {
        return response.error(res, selectionError.message);
      }
      throw selectionError;
    }

    const nextOrderId = await getNextOrderId();
    const order = await Order.create({
      orderId: nextOrderId,
      product: "balance",
      planCode: paymentMethod === "bankomat" ? "bankomat" : "card_topup",
      customAmount: amount,
      username: tgUser.username ? `@${tgUser.username}` : tgUser.tgUserId,
      tgUserId: tgUser.tgUserId,
      tgUsername: tgUser.username || "",
      profileName: tgUser.username ? `@${tgUser.username}` : tgUser.tgUserId,
      paymentCardId: selectedCard.paymentCardId,
      paymentCardSnapshot: selectedCard.paymentCardSnapshot,
      paymentMethod,
      paymentGrossAmount,
      balanceCreditAmount,
      paymentFeePercent,
      expectedAmount,
      paidAmount: 0,
      status: "pending_payment",
      expiresAt: new Date(now + PENDING_TTL_MS),
      sequence: nextOrderId,
    });

    emitUserUpdate(tgUser.tgUserId, {
      type: "balance_topup_created",
      refreshOrders: true,
      orderId: order._id,
      status: order.status,
      product: order.product,
    });

    return response.created(res, "Topup order yaratildi", order);
  } catch (error) {
    return response.serverError(
      res,
      "Topup yaratishda xatolik",
      error.message,
    );
  }
}

module.exports = {
  getMe,
  getMyReferrals,
  getBalance,
  createNftWithdrawalRequest,
  getMyOrders,
  createBalanceTopup,
};
