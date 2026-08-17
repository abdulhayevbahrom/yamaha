const router = require("express").Router();
const publicController = require("../controller/public.controller");
const orderController = require("../controller/order.controller");
const adminController = require("../controller/admin.controller");
const contestController = require("../controller/contest.controller");
const userController = require("../controller/user.controller");
const giftController = require("../controller/gift.controller");
const authMiddleware = require("../middleware/auth.middleware");
const botActiveMiddleware = require("../middleware/bot-active.middleware");
const { requireTelegramAuth } = require("../middleware/telegram-auth.middleware");
const {
  createFreshTelegramAuthMiddleware,
} = require("../middleware/fresh-telegram-auth.middleware");
const requireRegisteredUser = require("../middleware/registered-user.middleware");
const { createRateLimit } = require("../middleware/rate-limit.middleware");
const validate = require("../middleware/validate.middleware");
const {
  loginValidation,
  createPlanValidation,
  updatePlanValidation,
  createPaymentCardValidation,
  updatePaymentCardValidation,
  createStaticGiftValidation,
  updateStaticGiftValidation,
  createHeroSlideValidation,
  updateHeroSlideValidation,
  createContestValidation,
  updateContestValidation,
} = require("../validations/admin.validation");

const telegramAuthMiddleware = requireTelegramAuth();
const freshTelegramWriteAuth = createFreshTelegramAuthMiddleware({
  maxAgeSec: Number(process.env.TG_INIT_DATA_MAX_AGE_SEC_CRITICAL || 600),
});
const userWriteRateLimit = createRateLimit({
  keyPrefix: "user-write",
  windowMs: Number(process.env.RATE_LIMIT_USER_WRITE_WINDOW_MS || 60_000),
  max: Number(process.env.RATE_LIMIT_USER_WRITE_MAX || 5),
  keyGenerator: (req) => String(req?.telegramAuth?.tgUserId || req.ip || "").trim(),
});
const adminLoginRateLimit = createRateLimit({
  keyPrefix: "admin-login",
  windowMs: Number(process.env.RATE_LIMIT_ADMIN_LOGIN_WINDOW_MS || 60_000),
  max: Number(process.env.RATE_LIMIT_ADMIN_LOGIN_MAX || 12),
});
router.get("/health", publicController.health);
router.get("/catalog", publicController.getCatalog);
router.get("/settings", publicController.getSettings);
router.get("/card-bin/:bin", publicController.getCardBinInfo);
router.get("/top-sales", publicController.getTopSales);
router.get("/force-join/check", publicController.checkForceJoin);
router.get("/lookup-profile", publicController.lookupProfile);
router.get("/premium-status", publicController.checkPremiumStatus);
router.get("/mlbb/check-role", publicController.checkMlbbRole);
router.post(
  "/pubg/check-player",
  telegramAuthMiddleware,
  freshTelegramWriteAuth,
  requireRegisteredUser,
  userWriteRateLimit,
  publicController.checkPubgPlayer,
);
router.post(
  "/hok/check-player",
  telegramAuthMiddleware,
  freshTelegramWriteAuth,
  requireRegisteredUser,
  userWriteRateLimit,
  publicController.checkHokPlayer,
);
router.post(
  "/genshin/check-player",
  telegramAuthMiddleware,
  freshTelegramWriteAuth,
  requireRegisteredUser,
  userWriteRateLimit,
  publicController.checkGenshinPlayer,
);
router.post(
  "/bloodstrike/check-player",
  telegramAuthMiddleware,
  freshTelegramWriteAuth,
  requireRegisteredUser,
  userWriteRateLimit,
  publicController.checkBloodStrikePlayer,
);
router.post(
  "/deltaforce/check-player",
  telegramAuthMiddleware,
  freshTelegramWriteAuth,
  requireRegisteredUser,
  userWriteRateLimit,
  publicController.checkDeltaForcePlayer,
);
router.post("/calculate-price", orderController.calculatePrice);
router.post(
  "/orders",
  telegramAuthMiddleware,
  freshTelegramWriteAuth,
  requireRegisteredUser,
  userWriteRateLimit,
  botActiveMiddleware,
  orderController.createOrder,
);
router.post(
  "/orders/:id/stars-invoice",
  telegramAuthMiddleware,
  freshTelegramWriteAuth,
  requireRegisteredUser,
  userWriteRateLimit,
  botActiveMiddleware,
  orderController.createStarsInvoice,
);
router.get("/reports", authMiddleware, orderController.getReports);
router.get("/history", authMiddleware, orderController.getHistory);
router.get("/me", telegramAuthMiddleware, requireRegisteredUser, userController.getMe);
router.get("/balance", telegramAuthMiddleware, requireRegisteredUser, userController.getBalance);
router.get(
  "/balance/:tgUserId",
  telegramAuthMiddleware,
  requireRegisteredUser,
  userController.getBalance,
);
router.get("/my-orders", telegramAuthMiddleware, requireRegisteredUser, userController.getMyOrders);
router.get(
  "/my-referrals",
  telegramAuthMiddleware,
  requireRegisteredUser,
  userController.getMyReferrals,
);
router.post(
  "/referrals/redeem",
  telegramAuthMiddleware,
  freshTelegramWriteAuth,
  requireRegisteredUser,
  userWriteRateLimit,
  botActiveMiddleware,
  userController.requestReferralPromoCodeHandler,
);
router.post(
  "/balance/topup",
  telegramAuthMiddleware,
  freshTelegramWriteAuth,
  requireRegisteredUser,
  userWriteRateLimit,
  botActiveMiddleware,
  userController.createBalanceTopup,
);
router.post(
  "/balance/nft-withdraw",
  telegramAuthMiddleware,
  requireRegisteredUser,
  userWriteRateLimit,
  botActiveMiddleware,
  userController.createNftWithdrawalRequest,
);

router.get("/gifts/catalog", giftController.getGiftCatalog);
router.get("/gifts/image/:giftId", giftController.getGiftImage);
router.get("/gifts/nft-image/:nftId", giftController.getNftImage);
router.get("/gifts/nft-pattern/:nftId", giftController.getNftPattern);
router.get("/hero-slides", publicController.getHeroSlides);
router.get("/contest/current", contestController.getCurrentContest);
router.get("/my-gifts", telegramAuthMiddleware, requireRegisteredUser, giftController.getMyGifts);
router.get("/gifts/nft", telegramAuthMiddleware, requireRegisteredUser, giftController.getMyNftGifts);
router.get("/gifts/nft/market", giftController.getNftMarketplace);
router.get(
  "/gifts/nft/offers/incoming",
  telegramAuthMiddleware,
  requireRegisteredUser,
  giftController.getIncomingNftOffers,
);
router.get(
  "/gifts/nft/offers/sent",
  telegramAuthMiddleware,
  requireRegisteredUser,
  giftController.getMySentNftOffers,
);
router.post(
  "/gifts/nft/offers",
  telegramAuthMiddleware,
  freshTelegramWriteAuth,
  requireRegisteredUser,
  userWriteRateLimit,
  botActiveMiddleware,
  giftController.createNftOffer,
);
router.post(
  "/gifts/nft/offers/accept",
  telegramAuthMiddleware,
  freshTelegramWriteAuth,
  requireRegisteredUser,
  userWriteRateLimit,
  botActiveMiddleware,
  giftController.acceptNftOffer,
);
router.post(
  "/gifts/nft/offers/reject",
  telegramAuthMiddleware,
  freshTelegramWriteAuth,
  requireRegisteredUser,
  userWriteRateLimit,
  botActiveMiddleware,
  giftController.rejectNftOffer,
);
router.post(
  "/gifts/nft/offers/cancel",
  telegramAuthMiddleware,
  freshTelegramWriteAuth,
  requireRegisteredUser,
  userWriteRateLimit,
  botActiveMiddleware,
  giftController.cancelMyNftOffer,
);
router.post(
  "/gifts/nft/list",
  telegramAuthMiddleware,
  freshTelegramWriteAuth,
  requireRegisteredUser,
  userWriteRateLimit,
  botActiveMiddleware,
  giftController.listMyNftForSale,
);
router.post(
  "/gifts/nft/unlist",
  telegramAuthMiddleware,
  freshTelegramWriteAuth,
  requireRegisteredUser,
  userWriteRateLimit,
  botActiveMiddleware,
  giftController.unlistMyNft,
);
router.post(
  "/gifts/nft/buy",
  telegramAuthMiddleware,
  freshTelegramWriteAuth,
  requireRegisteredUser,
  userWriteRateLimit,
  botActiveMiddleware,
  giftController.buyNftFromMarketplace,
);
router.post(
  "/gifts/nft/withdraw",
  telegramAuthMiddleware,
  freshTelegramWriteAuth,
  requireRegisteredUser,
  userWriteRateLimit,
  botActiveMiddleware,
  giftController.withdrawMyNft,
);
router.post(
  "/gifts/purchase",
  telegramAuthMiddleware,
  freshTelegramWriteAuth,
  requireRegisteredUser,
  userWriteRateLimit,
  botActiveMiddleware,
  giftController.purchaseGift,
);
router.post(
  "/gifts/send",
  telegramAuthMiddleware,
  freshTelegramWriteAuth,
  requireRegisteredUser,
  userWriteRateLimit,
  botActiveMiddleware,
  giftController.sendGift,
);

router.get("/admin/access", telegramAuthMiddleware, adminController.checkAccess);
router.post(
  "/admin/login",
  telegramAuthMiddleware,
  freshTelegramWriteAuth,
  adminLoginRateLimit,
  validate(loginValidation),
  adminController.login,
);
router.get("/admin/plans", authMiddleware, adminController.getPlans);
router.post(
  "/admin/providers/gw/pubg/sync",
  authMiddleware,
  adminController.syncGwPubgPlans,
);
router.post(
  "/admin/providers/gw/mlbb/sync",
  authMiddleware,
  adminController.syncGwMlbbPlans,
);
router.post(
  "/admin/providers/gw/hok/sync",
  authMiddleware,
  adminController.syncGwHokPlans,
);
router.post(
  "/admin/providers/gw/genshin/sync",
  authMiddleware,
  adminController.syncGwGenshinPlans,
);
router.post(
  "/admin/providers/gw/roblox/sync",
  authMiddleware,
  adminController.syncGwRobloxPlans,
);
router.post(
  "/admin/providers/gw/bloodstrike/sync",
  authMiddleware,
  adminController.syncGwBloodStrikePlans,
);
router.post(
  "/admin/providers/gw/deltaforce/sync",
  authMiddleware,
  adminController.syncGwDeltaForcePlans,
);
router.get(
  "/admin/payment-cards",
  authMiddleware,
  adminController.getPaymentCards,
);
router.get("/admin/static-gifts", authMiddleware, adminController.getStaticGifts);
router.get("/admin/hero-slides", authMiddleware, adminController.getHeroSlides);
router.get("/admin/contests", authMiddleware, contestController.getAdminContests);
router.post(
  "/admin/plans",
  authMiddleware,
  validate(createPlanValidation),
  adminController.createPlan,
);
router.post(
  "/admin/payment-cards",
  authMiddleware,
  validate(createPaymentCardValidation),
  adminController.createPaymentCard,
);
router.post(
  "/admin/static-gifts",
  authMiddleware,
  validate(createStaticGiftValidation),
  adminController.createStaticGift,
);
router.post(
  "/admin/hero-slides",
  authMiddleware,
  validate(createHeroSlideValidation),
  adminController.createHeroSlide,
);
router.post(
  "/admin/contests",
  authMiddleware,
  validate(createContestValidation),
  contestController.createContest,
);
router.patch(
  "/admin/plans/:id",
  authMiddleware,
  validate(updatePlanValidation),
  adminController.updatePlan,
);
router.patch(
  "/admin/payment-cards/:id",
  authMiddleware,
  validate(updatePaymentCardValidation),
  adminController.updatePaymentCard,
);
router.patch(
  "/admin/static-gifts/:id",
  authMiddleware,
  validate(updateStaticGiftValidation),
  adminController.updateStaticGift,
);
router.patch(
  "/admin/hero-slides/:id",
  authMiddleware,
  validate(updateHeroSlideValidation),
  adminController.updateHeroSlide,
);
router.patch(
  "/admin/contests/:id",
  authMiddleware,
  validate(updateContestValidation),
  contestController.updateContest,
);
router.delete("/admin/plans/:id", authMiddleware, adminController.deletePlan);
router.delete(
  "/admin/payment-cards/:id",
  authMiddleware,
  adminController.deletePaymentCard,
);
router.delete(
  "/admin/static-gifts/:id",
  authMiddleware,
  adminController.deleteStaticGift,
);
router.delete(
  "/admin/hero-slides/:id",
  authMiddleware,
  adminController.deleteHeroSlide,
);
router.delete(
  "/admin/contests/:id",
  authMiddleware,
  contestController.deleteContest,
);
router.post(
  "/admin/payment-cards/:id/reset-limit",
  authMiddleware,
  adminController.resetPaymentCardLimit,
);
router.get("/admin/settings", authMiddleware, adminController.getSettings);
router.get(
  "/admin/diagnostics",
  authMiddleware,
  adminController.getDiagnostics,
);
router.get(
  "/admin/security/devices",
  authMiddleware,
  adminController.getSuspiciousDevices,
);
router.get(
  "/admin/active-users",
  authMiddleware,
  adminController.getActiveUsers,
);
router.put("/admin/settings", authMiddleware, adminController.updateSettings);
router.get(
  "/admin/referral-promo-codes",
  authMiddleware,
  adminController.getReferralPromoCodes,
);
router.post(
  "/admin/referral-promo-codes/use",
  authMiddleware,
  adminController.markReferralPromoCodeUsed,
);
router.get("/admin/users/search", authMiddleware, adminController.searchUsers);
router.get("/admin/assets/search", authMiddleware, adminController.searchAssets);
router.get(
  "/admin/users/:tgUserId/photo",
  authMiddleware,
  adminController.getUserProfilePhoto,
);
router.get(
  "/admin/users/:tgUserId/referrals",
  authMiddleware,
  adminController.getUserReferrals,
);
router.patch(
  "/admin/users/:tgUserId/referrals/:referredTgUserId",
  authMiddleware,
  adminController.updateUserReferralExclusion,
);
router.post(
  "/admin/users/:tgUserId/referrals/exclude-all",
  authMiddleware,
  adminController.excludeAllUserReferrals,
);
router.patch(
  "/admin/users/:tgUserId/referral-system-block",
  authMiddleware,
  adminController.updateUserReferralSystemBlock,
);
router.get(
  "/admin/users/:tgUserId/assets",
  authMiddleware,
  adminController.getUserAssets,
);
router.post(
  "/admin/users/:tgUserId/nfts/:nftId/remove",
  authMiddleware,
  adminController.adminRemoveUserNft,
);
router.post(
  "/admin/users/:tgUserId/nfts/:nftId/transfer",
  authMiddleware,
  adminController.adminTransferUserNft,
);
router.post(
  "/admin/users/:tgUserId/balance",
  authMiddleware,
  adminController.topupUserBalance,
);
router.post(
  "/admin/users/:tgUserId/block",
  authMiddleware,
  adminController.updateUserBlockStatus,
);
router.post(
  "/admin/orders/:id/retry-fulfill",
  authMiddleware,
  orderController.retryFulfillment,
);
router.post(
  "/admin/orders/:id/mark-completed",
  authMiddleware,
  orderController.markAutobuyOrderCompleted,
);
router.post(
  "/admin/orders/:id/confirm-star-sell",
  authMiddleware,
  orderController.confirmStarSellPayout,
);
router.post(
  "/admin/orders/:id/cancel-star-sell",
  authMiddleware,
  orderController.cancelStarSellPayout,
);
router.post(
  "/admin/orders/:id/confirm-nft-withdrawal",
  authMiddleware,
  orderController.confirmNftWithdrawalPayout,
);
router.post(
  "/admin/orders/:id/cancel-nft-withdrawal",
  authMiddleware,
  orderController.cancelNftWithdrawalPayout,
);
router.post(
  "/admin/orders/:id/confirm-uc",
  authMiddleware,
  orderController.confirmUcOrder,
);
router.post(
  "/admin/orders/:id/cancel-uc",
  authMiddleware,
  orderController.cancelUcOrder,
);
router.post(
  "/admin/orders/:id/cancel",
  authMiddleware,
  orderController.cancelOrder,
);

module.exports = router;
