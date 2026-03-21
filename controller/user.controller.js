const response = require("../utils/response");
const User = require("../model/user.model");
const Order = require("../model/order.model");
const { getNextOrderId } = require("../services/order-id.service");
const { emitUserUpdate } = require("../socket");
const { getTelegramUserFromRequest } = require("../utils/tg-user");

const PENDING_TTL_MS = 10 * 60 * 1000;

async function ensureUser({ tgUserId, username }) {
  if (!tgUserId) return null;
  return User.findOneAndUpdate(
    { tgUserId },
    {
      $set: {
        username,
      },
      $unset: {
        firstName: "",
        lastName: "",
        photoUrl: "",
        photo_url: "",
      },
    },
    { upsert: true, new: true },
  )
    .select({ tgUserId: 1, username: 1, balance: 1 })
    .lean();
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

    const user = await ensureUser(tgUser);
    return response.success(res, "Profile", user);
  } catch (error) {
    return response.serverError(res, "Profile olishda xatolik", error.message);
  }
}

async function getBalance(req, res) {
  try {
    const tgUserId = String(
      req.params?.tgUserId || req.query?.tgUserId || "",
    ).trim();

    if (!tgUserId) {
      return response.error(
        res,
        "Telegram profilingiz aniqlanmadi. Ilovani qayta ochib ko'ring.",
      );
    }

    const user = await User.findOne({ tgUserId }).lean();

    return response.success(res, "Balance", {
      tgUserId,
      balance: Number(user?.balance || 0),
    });
  } catch (error) {
    return response.serverError(res, "Balance olishda xatolik", error.message);
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

    const orders = await Order.find({ tgUserId: tgUser.tgUserId })
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();

    return response.success(res, "My orders", orders);
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
    if (!amount || amount <= 0) {
      return response.error(res, "Summani kiriting");
    }

    await ensureUser(tgUser);

    const now = Date.now();
    const aliveFrom = new Date(now - PENDING_TTL_MS);
    const pendingCount = await Order.countDocuments({
      status: "pending_payment",
      createdAt: { $gte: aliveFrom },
      expiresAt: { $gt: new Date(now) },
    });
    const expectedAmount = Number(amount) + Number(pendingCount);

    const nextOrderId = await getNextOrderId();
    const order = await Order.create({
      orderId: nextOrderId,
      product: "balance",
      planCode: String(amount),
      username: tgUser.username || tgUser.tgUserId,
      profileName: tgUser.username || tgUser.tgUserId,
      paymentMethod: "card",
      expectedAmount,
      paidAmount: 0,
      status: "pending_payment",
      expiresAt: new Date(Date.now() + PENDING_TTL_MS),
      sequence: pendingCount + 1,
      tgUserId: tgUser.tgUserId,
      tgUsername: tgUser.username,
    });

    emitUserUpdate(tgUser.tgUserId, {
      type: "balance_topup_created",
      refreshBalance: true,
      refreshOrders: true,
      orderId: order._id,
      status: order.status,
      product: order.product,
    });

    return response.created(res, "Balans to'ldirish buyurtmasi yaratildi", order);
  } catch (error) {
    return response.serverError(res, "Topup yaratishda xatolik", error.message);
  }
}

module.exports = {
  getMe,
  getBalance,
  getMyOrders,
  createBalanceTopup,
};
