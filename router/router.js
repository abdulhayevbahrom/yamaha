const router = require("express").Router();
const publicController = require("../controller/public.controller");
const orderController = require("../controller/order.controller");
const adminController = require("../controller/admin.controller");
const userController = require("../controller/user.controller");
const giftController = require("../controller/gift.controller");
const authMiddleware = require("../middleware/auth.middleware");
const botActiveMiddleware = require("../middleware/bot-active.middleware");
const apiKeyMiddleware = require("../middleware/api-key.middleware");
const signatureMiddleware = require("../middleware/signature.middleware");
const ipAllowlistMiddleware = require("../middleware/ip-allowlist.middleware");
const { requireTelegramAuth } = require("../middleware/telegram-auth.middleware");
const { createRateLimit } = require("../middleware/rate-limit.middleware");
const validate = require("../middleware/validate.middleware");
const {
  loginValidation,
  createPlanValidation,
  updatePlanValidation,
  createPaymentCardValidation,
  updatePaymentCardValidation,
} = require("../validations/admin.validation");

const telegramAuthMiddleware = requireTelegramAuth();
const userWriteRateLimit = createRateLimit({
  keyPrefix: "user-write",
  windowMs: Number(process.env.RATE_LIMIT_USER_WRITE_WINDOW_MS || 60_000),
  max: Number(process.env.RATE_LIMIT_USER_WRITE_MAX || 40),
  keyGenerator: (req) =>
    String(
      req?.telegramAuth?.tgUserId ||
        req.headers["x-tg-user-id"] ||
        req.ip ||
        "",
    ).trim(),
});
const adminLoginRateLimit = createRateLimit({
  keyPrefix: "admin-login",
  windowMs: Number(process.env.RATE_LIMIT_ADMIN_LOGIN_WINDOW_MS || 60_000),
  max: Number(process.env.RATE_LIMIT_ADMIN_LOGIN_MAX || 12),
});
const integrationRateLimit = createRateLimit({
  keyPrefix: "integration",
  windowMs: Number(process.env.RATE_LIMIT_INTEGRATION_WINDOW_MS || 60_000),
  max: Number(process.env.RATE_LIMIT_INTEGRATION_MAX || 120),
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
router.post("/calculate-price", orderController.calculatePrice);
router.post(
  "/orders",
  telegramAuthMiddleware,
  userWriteRateLimit,
  botActiveMiddleware,
  orderController.createOrder,
);
router.post(
  "/orders/:id/stars-invoice",
  telegramAuthMiddleware,
  userWriteRateLimit,
  botActiveMiddleware,
  orderController.createStarsInvoice,
);
router.get("/reports", authMiddleware, orderController.getReports);
router.get("/history", authMiddleware, orderController.getHistory);
router.get("/me", telegramAuthMiddleware, userController.getMe);
router.get("/balance/:tgUserId", telegramAuthMiddleware, userController.getBalance);
router.get("/my-orders", telegramAuthMiddleware, userController.getMyOrders);
router.get("/my-referrals", telegramAuthMiddleware, userController.getMyReferrals);
router.post(
  "/balance/topup",
  telegramAuthMiddleware,
  userWriteRateLimit,
  botActiveMiddleware,
  userController.createBalanceTopup,
);

router.get("/gifts/catalog", giftController.getGiftCatalog);
router.get("/gifts/image/:giftId", giftController.getGiftImage);
router.get("/gifts/nft-image/:nftId", giftController.getNftImage);
router.get("/gifts/nft-pattern/:nftId", giftController.getNftPattern);
router.get("/my-gifts", telegramAuthMiddleware, giftController.getMyGifts);
router.get("/gifts/nft", telegramAuthMiddleware, giftController.getMyNftGifts);
router.get("/gifts/nft/market", giftController.getNftMarketplace);
router.get(
  "/gifts/nft/offers/incoming",
  telegramAuthMiddleware,
  giftController.getIncomingNftOffers,
);
router.get(
  "/gifts/nft/offers/sent",
  telegramAuthMiddleware,
  giftController.getMySentNftOffers,
);
router.post(
  "/gifts/nft/offers",
  telegramAuthMiddleware,
  userWriteRateLimit,
  botActiveMiddleware,
  giftController.createNftOffer,
);
router.post(
  "/gifts/nft/offers/accept",
  telegramAuthMiddleware,
  userWriteRateLimit,
  botActiveMiddleware,
  giftController.acceptNftOffer,
);
router.post(
  "/gifts/nft/offers/reject",
  telegramAuthMiddleware,
  userWriteRateLimit,
  botActiveMiddleware,
  giftController.rejectNftOffer,
);
router.post(
  "/gifts/nft/offers/cancel",
  telegramAuthMiddleware,
  userWriteRateLimit,
  botActiveMiddleware,
  giftController.cancelMyNftOffer,
);
router.post(
  "/gifts/nft/list",
  telegramAuthMiddleware,
  userWriteRateLimit,
  botActiveMiddleware,
  giftController.listMyNftForSale,
);
router.post(
  "/gifts/nft/unlist",
  telegramAuthMiddleware,
  userWriteRateLimit,
  botActiveMiddleware,
  giftController.unlistMyNft,
);
router.post(
  "/gifts/nft/buy",
  telegramAuthMiddleware,
  userWriteRateLimit,
  botActiveMiddleware,
  giftController.buyNftFromMarketplace,
);
router.post(
  "/gifts/nft/withdraw",
  telegramAuthMiddleware,
  userWriteRateLimit,
  botActiveMiddleware,
  giftController.withdrawMyNft,
);
router.post(
  "/gifts/purchase",
  telegramAuthMiddleware,
  userWriteRateLimit,
  botActiveMiddleware,
  giftController.purchaseGift,
);
router.post(
  "/gifts/send",
  telegramAuthMiddleware,
  userWriteRateLimit,
  botActiveMiddleware,
  giftController.sendGift,
);

router.get("/admin/access", adminController.checkAccess);
router.post(
  "/admin/login",
  adminLoginRateLimit,
  validate(loginValidation),
  adminController.login,
);
router.get("/admin/plans", authMiddleware, adminController.getPlans);
router.get(
  "/admin/payment-cards",
  authMiddleware,
  adminController.getPaymentCards,
);
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
router.delete("/admin/plans/:id", authMiddleware, adminController.deletePlan);
router.delete(
  "/admin/payment-cards/:id",
  authMiddleware,
  adminController.deletePaymentCard,
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
router.put("/admin/settings", authMiddleware, adminController.updateSettings);
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
  "/admin/orders/process-payment",
  authMiddleware,
  orderController.processCardPayment,
);
router.post(
  "/integrations/orders/process-payment",
  integrationRateLimit,
  ipAllowlistMiddleware,
  apiKeyMiddleware,
  signatureMiddleware,
  orderController.processCardPayment,
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


