const router = require("express").Router();
const publicController = require("../controller/public.controller");
const orderController = require("../controller/order.controller");
const adminController = require("../controller/admin.controller");
const userController = require("../controller/user.controller");
const giftController = require("../controller/gift.controller");
const authMiddleware = require("../middleware/auth.middleware");
const validate = require("../middleware/validate.middleware");
const {
  loginValidation,
  createPlanValidation,
  updatePlanValidation,
  createPaymentCardValidation,
  updatePaymentCardValidation,
} = require("../validations/admin.validation");

router.get("/health", publicController.health);
router.get("/catalog", publicController.getCatalog);
router.get("/settings", publicController.getSettings);
router.get("/top-sales", publicController.getTopSales);
router.get("/force-join/check", publicController.checkForceJoin);
router.get("/lookup-profile", publicController.lookupProfile);
router.get("/premium-status", publicController.checkPremiumStatus);
router.get("/mlbb/check-role", publicController.checkMlbbRole);
router.post("/calculate-price", orderController.calculatePrice);
router.post("/orders", orderController.createOrder);
router.get("/reports", orderController.getReports);
router.get("/history", orderController.getHistory);
router.get("/me", userController.getMe);
router.get("/balance/:tgUserId", userController.getBalance);
router.get("/my-orders", userController.getMyOrders);
router.get("/my-referrals", userController.getMyReferrals);
router.post("/balance/topup", userController.createBalanceTopup);

router.get("/gifts/catalog", giftController.getGiftCatalog);
router.get("/gifts/image/:giftId", giftController.getGiftImage);
router.get("/gifts/nft-image/:nftId", giftController.getNftImage);
router.get("/gifts/nft-pattern/:nftId", giftController.getNftPattern);
router.get("/my-gifts", giftController.getMyGifts);
router.get("/gifts/nft", giftController.getMyNftGifts);
router.get("/gifts/nft/market", giftController.getNftMarketplace);
router.get("/gifts/nft/offers/incoming", giftController.getIncomingNftOffers);
router.get("/gifts/nft/offers/sent", giftController.getMySentNftOffers);
router.post("/gifts/nft/offers", giftController.createNftOffer);
router.post("/gifts/nft/offers/accept", giftController.acceptNftOffer);
router.post("/gifts/nft/offers/reject", giftController.rejectNftOffer);
router.post("/gifts/nft/offers/cancel", giftController.cancelMyNftOffer);
router.post("/gifts/nft/list", giftController.listMyNftForSale);
router.post("/gifts/nft/unlist", giftController.unlistMyNft);
router.post("/gifts/nft/buy", giftController.buyNftFromMarketplace);
router.post("/gifts/nft/withdraw", giftController.withdrawMyNft);
router.post("/gifts/purchase", giftController.purchaseGift);
router.post("/gifts/send", giftController.sendGift);

router.get("/admin/access", adminController.checkAccess);
router.post("/admin/login", validate(loginValidation), adminController.login);
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
  "/admin/orders/:id/retry-fulfill",
  authMiddleware,
  orderController.retryFulfillment,
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


