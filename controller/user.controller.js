const crypto = require("node:crypto");
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
const { sanitizePublicOrder } = require("../utils/public-payload");
const {
  releasePaymentCardAllocation,
  selectPaymentCardForType,
} = require("../services/payment-card.service");
const {
  activateReferralOnMiniAppOpen,
  buildReferralLink,
  ensureReferralIdentity,
} = require("../services/referral.service");
const {
  getReferralRedemptionState,
  requestReferralPromoCode,
} = require("../services/referral-promo-code.service");
const {
  recordDeviceActivity,
} = require("../services/security-device.service");
const {
  calculateBankomatNetAmount,
} = require("../services/balance-topup.service");
const {
  getBankomatTopupConfig,
  getReferralConfig,
  getNftMarketplaceConfig,
} = require("../services/settings.service");
const { lookupCardBinInfo, normalizeScheme } = require("../services/card-bin.service");
const { sendTelegramText } = require("../services/telegram-notify.service");
const {
  notifyAdminsAboutNftWithdrawalRequest,
  refundUpfrontNftWithdrawalFeeIfCharged,
} = require("../services/nft-withdrawal-payout.service");
const {
  attachReservationToOrder,
  releasePaymentReservation,
  reservePaymentAmount,
} = require("../services/payment-amount-reservation.service");

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

function splitNftTitleAndNumber(value) {
  const raw = normalizeString(value);
  if (!raw) return { title: "", nftNumber: 0 };

  const match = raw.match(/^(.*?)(?:\s*#\s*(\d[\d\s]*))$/);
  if (!match) return { title: raw, nftNumber: 0 };

  const title = normalizeString(match[1]) || raw;
  const parsedNumber = Number(String(match[2] || "").replace(/\s+/g, ""));
  const nftNumber =
    Number.isFinite(parsedNumber) && parsedNumber > 0
      ? Math.trunc(parsedNumber)
      : 0;

  return { title, nftNumber };
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
    void recordDeviceActivity({
      req,
      tgUserId: tgUser.tgUserId,
      username: tgUser.username,
      profileName: tgUser.profileName,
      route: req.path || req.originalUrl || "/me",
      method: req.method,
    }).catch((error) => {
      console.error(
        "Referral device tracking error:",
        error?.message || error,
      );
    });
    const [
      user,
      totalOrders,
      spending,
      inviteCount,
      redemptionState,
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
        getReferralRedemptionState(tgUser.tgUserId),
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
        redemption: {
          inviteThreshold: Number(redemptionState?.inviteThreshold || 0),
          cooldownDays: Number(redemptionState?.cooldownDays || 0),
          rewardLabel: String(redemptionState?.rewardLabel || ""),
          rewardCatalog: Array.isArray(redemptionState?.rewardCatalog)
            ? redemptionState.rewardCatalog
            : [],
          qualifiedInviteCount: Number(
            redemptionState?.qualifiedInviteCount || 0,
          ),
          availableRewardCount: Number(
            redemptionState?.availableRewardCount || 0,
          ),
          claimedRewardCount: Number(
            redemptionState?.claimedRewardCount || 0,
          ),
          remainingRewardCount: Number(
            redemptionState?.remainingRewardCount || 0,
          ),
          nextMilestoneInviteCount: Number(
            redemptionState?.nextMilestoneInviteCount || 0,
          ),
          canRedeem: Boolean(redemptionState?.canRedeem),
          isCoolingDown: Boolean(redemptionState?.isCoolingDown),
          nextAvailableAt: redemptionState?.nextAvailableAt || null,
          lastRedemption: redemptionState?.lastRedemption || null,
          activeRequest: redemptionState?.activeRequest || null,
        },
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
    void recordDeviceActivity({
      req,
      tgUserId: tgUser.tgUserId,
      username: tgUser.username,
      profileName: tgUser.profileName,
      route: req.path || req.originalUrl || "/my-referrals",
      method: req.method,
    }).catch((error) => {
      console.error(
        "Referral device tracking error:",
        error?.message || error,
      );
    });
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

    const [user, referralConfig, totalItems, redemptionState] = await Promise.all([
      ensureUser(tgUser),
      getReferralConfig(),
      User.countDocuments({ referredByUserId: tgUser.tgUserId }),
      getReferralRedemptionState(tgUser.tgUserId),
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
        redemption: {
          inviteThreshold: Number(redemptionState?.inviteThreshold || 0),
          cooldownDays: Number(redemptionState?.cooldownDays || 0),
          rewardLabel: String(redemptionState?.rewardLabel || ""),
          rewardCatalog: Array.isArray(redemptionState?.rewardCatalog)
            ? redemptionState.rewardCatalog
            : [],
          qualifiedInviteCount: Number(
            redemptionState?.qualifiedInviteCount || 0,
          ),
          availableRewardCount: Number(
            redemptionState?.availableRewardCount || 0,
          ),
          claimedRewardCount: Number(
            redemptionState?.claimedRewardCount || 0,
          ),
          remainingRewardCount: Number(
            redemptionState?.remainingRewardCount || 0,
          ),
          nextMilestoneInviteCount: Number(
            redemptionState?.nextMilestoneInviteCount || 0,
          ),
          canRedeem: Boolean(redemptionState?.canRedeem),
          isCoolingDown: Boolean(redemptionState?.isCoolingDown),
          nextAvailableAt: redemptionState?.nextAvailableAt || null,
          lastRedemption: redemptionState?.lastRedemption || null,
          activeRequest: redemptionState?.activeRequest || null,
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
      const username = String(referredUser.username || "").trim();

      return {
        username,
        displayName: username ? `@${username}` : "Mijoz",
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

async function requestReferralPromoCodeHandler(req, res) {
  try {
    const tgUser = getTelegramUserFromRequest(req);
    if (!tgUser.tgUserId) {
      return response.error(
        res,
        "Telegram profilingiz aniqlanmadi. Ilovani qayta ochib ko'ring.",
      );
    }

    const result = await requestReferralPromoCode({
      tgUserId: tgUser.tgUserId,
      username: tgUser.username,
      profileName: tgUser.profileName,
      rewardKey: req.body?.rewardKey || "",
    });

    if (!result?.ok) {
      const reason = String(result?.reason || "");
      if (reason === "threshold_not_reached") {
        return response.error(res, "Referral limit hali yetmagan", {
          code: reason,
          inviteThreshold: Number(result.inviteThreshold || 0),
          qualifiedInviteCount: Number(result.qualifiedInviteCount || 0),
          availableRewardCount: Number(result.availableRewardCount || 0),
          claimedRewardCount: Number(result.claimedRewardCount || 0),
          remainingRewardCount: Number(result.remainingRewardCount || 0),
          nextMilestoneInviteCount: Number(result.nextMilestoneInviteCount || 0),
        });
      }
      if (reason === "cooldown_active") {
        return response.error(res, "Promo kod olish uchun muddat hali tugamagan", {
          code: reason,
          nextAvailableAt: result.nextAvailableAt || null,
          cooldownDays: Number(result.cooldownDays || 0),
        });
      }
      if (reason === "pending_request") {
        return response.error(res, "Avvalgi promo kod hali adminga yuborilgan", {
          code: reason,
          activeRequest: result.activeRequest || null,
        });
      }

      return response.error(res, "Promo kod yaratib bo'lmadi", {
        code: reason || "promo_code_failed",
      });
    }

    return response.created(res, "Promo kod yaratildi", result);
  } catch (error) {
    return response.serverError(
      res,
      "Promo kod yaratishda xatolik",
      error.message,
    );
  }
}

async function getBalance(req, res) {
  try {
    const authUserId = normalizeString(req?.telegramAuth?.tgUserId);

    if (!authUserId) {
      return response.error(
        res,
        "Telegram profilingiz aniqlanmadi. Ilovani qayta ochib ko'ring.",
      );
    }

    let user = await User.findOne({ tgUserId: authUserId }).lean();

    // Legacy users: nftEarningsBalance field was introduced later.
    // Recover only when the field is missing, not when it is legitimately 0.
    const hasNftEarningsBalance =
      user && Object.prototype.hasOwnProperty.call(user, "nftEarningsBalance");
    if (user?.tgUserId && !hasNftEarningsBalance) {
      const legacyRows = await UserNft.aggregate([
        {
          $match: {
            lastSellerTgUserId: String(authUserId),
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
          { tgUserId: authUserId },
          { $set: { nftEarningsBalance: recovered } },
          { new: true },
        ).lean();
      }
    }

    return response.success(res, "Balance", {
      balance: Number(user?.balance || 0),
    });
  } catch (error) {
    return response.serverError(res, "Balance olishda xatolik", error.message);
  }
}

async function createNftWithdrawalRequest(req, res) {
  let createdOrder = null;
  try {
    if (
      String(process.env.NFT_WITHDRAW_ENABLED || "true").trim().toLowerCase() ===
      "false"
    ) {
      return response.error(
        res,
        "NFT yechib olish vaqtincha o'chirilgan. Administratorga murojaat qiling.",
      );
    }

    const tgUser = getTelegramUserFromRequest(req);
    if (!tgUser?.tgUserId) {
      return response.error(
        res,
        "Telegram profilingiz aniqlanmadi. Ilovani qayta ochib ko'ring.",
      );
    }

    const user = await ensureUser(tgUser);
    if (!user?.tgUserId) {
      return response.error(res, "Foydalanuvchi topilmadi");
    }
    if (user?.isBlocked) {
      return response.error(res, "Foydalanuvchi bloklangan");
    }

    const nftId = normalizeString(req.body?.nftId);
    if (!nftId) {
      return response.error(res, "nftId required");
    }

    const requestMeta = {
      ip:
        normalizeString(req?.headers?.["x-forwarded-for"]?.split(",")?.[0]) ||
        normalizeString(req?.headers?.["x-real-ip"]) ||
        normalizeString(req?.ip) ||
        normalizeString(req?.socket?.remoteAddress) ||
        "unknown",
      userAgent: normalizeString(req?.headers?.["user-agent"]),
    };

    const transferRequestId = crypto.randomUUID();
    const nft = await UserNft.findOneAndUpdate(
      {
        nftId,
        ownerTgUserId: user.tgUserId,
        isTelegramPresent: true,
        marketStatus: { $in: ["owned", "listed"] },
        $or: [{ transferStatus: "idle" }, { transferStatus: { $exists: false } }],
      },
      {
        $set: {
          isTelegramPresent: false,
          marketStatus: "owned",
          listingPriceUzs: 0,
          listedAt: null,
          listedByTgUserId: "",
          transferStatus: "processing",
          transferRequestId,
          transferStartedAt: new Date(),
          transferError: "",
        },
      },
      { new: false },
    ).lean();

    if (!nft) {
      const pendingOrder = await Order.findOne({
        product: "nft_withdrawal",
        tgUserId: user.tgUserId,
        "fragmentTx.nftWithdrawal.nftId": nftId,
        status: { $in: ["payment_submitted", "admin_action_processing"] },
      })
        .sort({ createdAt: -1 })
        .lean();

      if (pendingOrder?._id) {
        const nftTx = pendingOrder?.fragmentTx?.nftWithdrawal || {};
        const feeRefund = await refundUpfrontNftWithdrawalFeeIfCharged(
          pendingOrder,
          "pending_request_retry",
        ).catch(() => null);
        if (feeRefund?.refunded) {
          emitUserUpdate(user.tgUserId, {
            type: "nft_withdrawal_fee_refunded",
            refreshBalance: true,
            refreshOrders: true,
            orderId: pendingOrder._id,
            nftId,
          });
        }
        return response.success(res, "NFT yechib olish so'rovi oldin yuborilgan", {
          orderId: String(pendingOrder._id),
          nftId,
          title: normalizeString(nftTx.title) || "NFT Gift",
          nftNumber: Math.max(0, Math.round(toSafeNumber(nftTx.nftNumber, 0))),
          withdrawFeeUzs: Math.max(0, Math.round(toSafeNumber(nftTx.withdrawFeeUzs, 0))),
          status: pendingOrder.status,
          pending: true,
          feeRefunded: Boolean(feeRefund?.refunded),
          balance: Math.max(
            0,
            Math.round(Number(feeRefund?.user?.balance ?? user.balance ?? 0)),
          ),
        });
      }

      return response.error(res, "NFT topilmadi yoki allaqachon yechib olingan");
    }

    const wasListed = normalizeString(nft.marketStatus) === "listed";
    const restoreNftState = async () => {
      await UserNft.updateOne(
        {
          nftId,
          ownerTgUserId: user.tgUserId,
          transferStatus: "processing",
          transferRequestId,
        },
        {
          $set: {
            isTelegramPresent: true,
            marketStatus: wasListed ? "listed" : "owned",
            listingPriceUzs: wasListed ? toSafeNumber(nft.listingPriceUzs, 0) : 0,
            listedAt: wasListed ? nft.listedAt || null : null,
            listedByTgUserId: wasListed
              ? normalizeString(nft.listedByTgUserId) || user.tgUserId
              : "",
            transferStatus: "idle",
            transferRequestId: "",
            transferStartedAt: null,
            transferError: "",
          },
        },
      );
    };

    const transferLock = nft?.canTransferAt ? new Date(nft.canTransferAt) : null;
    if (transferLock && Number.isFinite(transferLock.getTime())) {
      const secondsLeft = Math.max(
        0,
        Math.ceil((transferLock.getTime() - Date.now()) / 1000),
      );
      if (secondsLeft > 0) {
        await restoreNftState();
        return response.error(
          res,
          "NFT ni hozir yechib bo'lmaydi. Keyinroq urinib ko'ring.",
          {
            code: "NFT_TRANSFER_TOO_EARLY",
            canTransferAt: transferLock.toISOString(),
            secondsLeft,
          },
        );
      }
    }

    const marketConfig = await getNftMarketplaceConfig();
    const withdrawFeeUzs = Math.max(
      0,
      Math.round(Number(marketConfig?.withdrawFeeUzs || 0)),
    );

    const { title: nftTitle, nftNumber } = splitNftTitleAndNumber(nft.title);
    const nextOrderId = await getNextOrderId();
    const order = await Order.create({
      orderId: nextOrderId,
      product: "nft_withdrawal",
      planCode: nftTitle || "NFT Gift",
      customAmount: Math.max(0, Math.round(toSafeNumber(nftNumber, 0))),
      username: normalizeString(user.username) || user.tgUserId,
      tgUserId: user.tgUserId,
      tgUsername: normalizeString(user.username) || "",
      profileName: normalizeString(user.profileName) || normalizeString(user.username) || user.tgUserId,
      paymentMethod: "balance",
      expectedAmount: withdrawFeeUzs,
      paidAmount: withdrawFeeUzs,
      paymentGrossAmount: withdrawFeeUzs,
      balanceCreditAmount: 0,
      status: "payment_submitted",
      fulfillmentStatus: "needs_review",
      completionMode: "",
      fulfillmentError: "",
      sequence: nextOrderId,
      fragmentTx: {
        nftWithdrawal: {
          nftId,
          title: nftTitle || "NFT Gift",
          nftNumber: Math.max(0, Math.round(toSafeNumber(nftNumber, 0))),
          ownerTgUserId: user.tgUserId,
          ownerUsername: normalizeString(user.username) || "",
          profileName: normalizeString(user.profileName) || normalizeString(user.username) || "",
          sourceMsgId: Math.trunc(toSafeNumber(nft.sourceMsgId, 0)),
          transferRequestId,
          marketStatus: normalizeString(nft.marketStatus) || "owned",
          listingPriceUzs: Math.max(0, Math.round(toSafeNumber(nft.listingPriceUzs, 0))),
          listedAt: nft.listedAt || null,
          listedByTgUserId: normalizeString(nft.listedByTgUserId) || "",
          canTransferAt: nft.canTransferAt || null,
          withdrawFeeUzs,
          requestedAt: new Date().toISOString(),
          recipientIdentifier: normalizeString(user.username) || user.tgUserId,
          requestMeta,
        },
      },
    });
    createdOrder = order;

    const sentNotifications = await notifyAdminsAboutNftWithdrawalRequest(order);
    if (!sentNotifications.length) {
      await Order.deleteOne({ _id: order._id }).catch(() => {});
      await restoreNftState();
      return response.serverError(
        res,
        "Adminga so'rov yuborilmadi. Keyinroq qayta urinib ko'ring.",
      );
    }

    emitUserUpdate(user.tgUserId, {
      type: "nft_withdrawal_requested",
      refreshOrders: true,
      refreshBalance: false,
      refreshNfts: true,
      nftId,
      orderId: order._id,
      status: order.status,
      product: order.product,
    });

    emitAdminUpdate({
      type: "nft_withdrawal_requested",
      refreshHistory: true,
      orderId: order._id,
      tgUserId: order.tgUserId,
    });

    return response.created(res, "NFT yechib olish so'rovi yuborildi", {
      orderId: String(order._id),
      nftId,
      title: nftTitle || "NFT Gift",
      nftNumber: Math.max(0, Math.round(toSafeNumber(nftNumber, 0))),
      withdrawFeeUzs,
      balance: Math.max(0, Math.round(Number(user.balance || 0))),
    });
  } catch (error) {
    if (createdOrder?._id) {
      await Order.deleteOne({ _id: createdOrder._id }).catch(() => {});
    }
    const tgUser = getTelegramUserFromRequest(req);
    const nftId = normalizeString(req.body?.nftId);
    const nftDoc = nftId
      ? await UserNft.findOne({
          nftId,
          ownerTgUserId: tgUser?.tgUserId || "",
        })
          .select({ nftId: 1, transferStatus: 1, transferRequestId: 1 })
          .lean()
      : null;
    if (nftDoc?.transferStatus === "processing") {
      await UserNft.updateOne(
        {
          nftId: nftDoc.nftId,
          ownerTgUserId: tgUser?.tgUserId || "",
          transferStatus: "processing",
        },
        {
          $set: {
            isTelegramPresent: true,
            transferStatus: "idle",
            transferRequestId: "",
            transferStartedAt: null,
            transferError: "",
          },
        },
      ).catch(() => {});
    }

    return response.serverError(
      res,
      "NFT ni yechib olishda xatolik",
      error.message,
    );
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
      Order.find({ tgUserId: tgUser.tgUserId })
        .sort({ createdAt: -1 })
        .limit(250)
        .select({
          orderId: 1,
          product: 1,
          planCode: 1,
          customAmount: 1,
          username: 1,
          playerId: 1,
          zoneId: 1,
          profileName: 1,
          paymentCardSnapshot: 1,
          paymentMethod: 1,
          sellCardNumber: 1,
          sellPricePerStar: 1,
          starsAmount: 1,
          paymentGrossAmount: 1,
          balanceCreditAmount: 1,
          paymentFeePercent: 1,
          expectedAmount: 1,
          paymentMatchAmount: 1,
          paymentAlternateMatchAmount: 1,
          paidAmount: 1,
          paidAt: 1,
          status: 1,
          fulfillmentStatus: 1,
          completionMode: 1,
          fulfillmentError: 1,
          fragmentTx: 1,
          fulfillmentStartedAt: 1,
          fulfilledAt: 1,
          expiresAt: 1,
          createdAt: 1,
          updatedAt: 1,
        })
        .lean(),
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
      ...(sanitizePublicOrder(item) || {}),
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
  let paymentReservationTokens = [];
  let createdOrder = null;
  let paymentCardAllocation = null;
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
    const minTopupAmount = Math.max(
      1,
      Number(process.env.MIN_BALANCE_TOPUP_UZS || 1000),
    );
    const maxTopupAmount = Math.max(
      minTopupAmount,
      Number(process.env.MAX_BALANCE_TOPUP_UZS || 100_000_000),
    );
    if (
      !Number.isSafeInteger(amount) ||
      amount < minTopupAmount ||
      amount > maxTopupAmount
    ) {
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
    let expectedAmount = amount;
    let paymentMatchAmount = amount;
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

      expectedAmount = amount;
      paymentMatchAmount = netAmount;
      paymentGrossAmount = amount;
      balanceCreditAmount = netAmount;
      paymentFeePercent = feePercent;
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
    if (!selectedCard?.paymentCardSnapshot) {
      return response.error(res, "Hozircha to'lov kartasi mavjud emas");
    }
    paymentCardAllocation = selectedCard.allocation || null;

    const expiresAt = new Date(now + PENDING_TTL_MS);
    const reservation = await reservePaymentAmount({
      baseAmount: paymentMatchAmount,
      expiresAt,
      allowOffset: false,
    });
    if (!reservation) {
      await releasePaymentCardAllocation(paymentCardAllocation);
      paymentCardAllocation = null;
      return response.error(res, "Bu summa hozir band. Boshqa summa kiriting", {
        code: "BALANCE_AMOUNT_RESERVED",
      });
    }
    paymentReservationTokens = [reservation.token];
    paymentMatchAmount = reservation.amount;
    let paymentAlternateMatchAmount = 0;
    if (paymentMethod === "card") {
      expectedAmount = reservation.amount;
      paymentGrossAmount = reservation.amount;
      balanceCreditAmount = reservation.amount;
    } else if (expectedAmount !== paymentMatchAmount) {
      const alternateReservation = await reservePaymentAmount({
        baseAmount: expectedAmount,
        expiresAt,
        allowOffset: false,
      });
      if (!alternateReservation) {
        await releasePaymentReservation(reservation.token);
        paymentReservationTokens = [];
        await releasePaymentCardAllocation(paymentCardAllocation);
        paymentCardAllocation = null;
        return response.error(res, "Bu summa hozir band. Boshqa summa kiriting", {
          code: "BALANCE_AMOUNT_RESERVED",
        });
      }
      paymentAlternateMatchAmount = alternateReservation.amount;
      paymentReservationTokens.push(alternateReservation.token);
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
      paymentMatchAmount,
      paymentAlternateMatchAmount,
      paymentReservationToken: paymentReservationTokens[0] || "",
      paymentReservationTokens,
      paidAmount: 0,
      status: "pending_payment",
      expiresAt,
      sequence: nextOrderId,
    });
    createdOrder = order;
    await Promise.all(
      paymentReservationTokens.map((token) =>
        attachReservationToOrder(token, order._id),
      ),
    ).catch((error) => {
      console.error(
        "Topup payment reservation attach error:",
        order._id,
        error.message,
      );
    });

    emitUserUpdate(tgUser.tgUserId, {
      type: "balance_topup_created",
      refreshOrders: true,
      orderId: order._id,
      status: order.status,
      product: order.product,
    });

    return response.created(
      res,
      "Topup order yaratildi",
      sanitizePublicOrder(order),
    );
  } catch (error) {
    if (!createdOrder && paymentReservationTokens.length) {
      await Promise.all(
        paymentReservationTokens.map((token) =>
          releasePaymentReservation(token),
        ),
      ).catch(() => {});
    }
    if (!createdOrder && paymentCardAllocation) {
      await releasePaymentCardAllocation(paymentCardAllocation).catch(() => {});
    }
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
  requestReferralPromoCodeHandler,
  createBalanceTopup,
};
