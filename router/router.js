const router = require("express").Router();
const publicController = require("../controller/public.controller");
const orderController = require("../controller/order.controller");
const adminController = require("../controller/admin.controller");
const userController = require("../controller/user.controller");
const authMiddleware = require("../middleware/auth.middleware");
const validate = require("../middleware/validate.middleware");
const {
  loginValidation,
  createPlanValidation,
  updatePlanValidation
} = require("../validations/admin.validation");

router.get("/health", publicController.health);
router.get("/catalog", publicController.getCatalog);
router.get("/settings", publicController.getSettings);
router.get("/lookup-profile", publicController.lookupProfile);
router.post("/calculate-price", orderController.calculatePrice);
router.post("/orders", orderController.createOrder);
router.get("/reports", orderController.getReports);
router.get("/history", orderController.getHistory);
router.get("/me", userController.getMe);
router.get("/my-orders", userController.getMyOrders);
router.post("/balance/topup", userController.createBalanceTopup);

router.post("/admin/login", validate(loginValidation), adminController.login);
router.get("/admin/plans", authMiddleware, adminController.getPlans);
router.post(
  "/admin/plans",
  authMiddleware,
  validate(createPlanValidation),
  adminController.createPlan
);
router.patch(
  "/admin/plans/:id",
  authMiddleware,
  validate(updatePlanValidation),
  adminController.updatePlan
);
router.delete("/admin/plans/:id", authMiddleware, adminController.deletePlan);
router.get("/admin/settings", authMiddleware, adminController.getSettings);
router.put("/admin/settings", authMiddleware, adminController.updateSettings);
router.post("/admin/orders/process-payment", authMiddleware, orderController.processCardPayment);
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

module.exports = router;
