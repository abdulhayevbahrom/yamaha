const response = require("../utils/response");
const User = require("../model/user.model");
const Order = require("../model/order.model");
const { getNextOrderId } = require("../services/order-id.service");

const PENDING_TTL_MS = 10 * 60 * 1000;

function getTgUser(req) {
  let tgUserId = String(req.headers["x-tg-user-id"] || "").trim();
  let username = String(req.headers["x-tg-username"] || "").trim();
  let firstName = String(req.headers["x-tg-first-name"] || "").trim();
  let lastName = String(req.headers["x-tg-last-name"] || "").trim();

  if (!tgUserId) {
    const initData = String(req.headers["x-tg-init-data"] || "");
    if (initData) {
      try {
        const params = new URLSearchParams(initData);
        const userRaw = params.get("user");
        if (userRaw) {
          const user = JSON.parse(userRaw);
          tgUserId = String(user?.id || "").trim();
          username = String(user?.username || "").trim();
          firstName = String(user?.first_name || "").trim();
          lastName = String(user?.last_name || "").trim();
        }
      } catch (_) {
        // ignore
      }
    }
  }
  return { tgUserId, username, firstName, lastName };
}

async function ensureUser({ tgUserId, username, firstName, lastName }) {
  if (!tgUserId) return null;
  return User.findOneAndUpdate(
    { tgUserId },
    {
      $set: {
        username,
        firstName,
        lastName,
      },
    },
    { upsert: true, new: true },
  ).lean();
}

async function getMe(req, res) {
  try {
    const tgUser = getTgUser(req);
    if (!tgUser.tgUserId) return response.error(res, "tg_user_id required");

    const user = await ensureUser(tgUser);
    return response.success(res, "Profile", user);
  } catch (error) {
    return response.serverError(res, "Profile olishda xatolik", error.message);
  }
}

async function getMyOrders(req, res) {
  try {
    const tgUser = getTgUser(req);
    if (!tgUser.tgUserId) return response.error(res, "tg_user_id required");

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
    return response.serverError(res, "Orderlarni olishda xatolik", error.message);
  }
}

async function createBalanceTopup(req, res) {
  try {
    const tgUser = getTgUser(req);
    if (!tgUser.tgUserId) return response.error(res, "tg_user_id required");


    const amount = Number(req.body?.amount || 0);
    if (!amount || amount <= 0) {
      return response.error(res, "amount required");
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
      profileName: [tgUser.firstName, tgUser.lastName].filter(Boolean).join(" "),
      paymentMethod: "card",
      expectedAmount,
      paidAmount: 0,
      status: "pending_payment",
      expiresAt: new Date(Date.now() + PENDING_TTL_MS),
      sequence: pendingCount + 1,
      tgUserId: tgUser.tgUserId,
      tgUsername: tgUser.username,
    });

    return response.created(res, "Topup order yaratildi", order);
  } catch (error) {
    return response.serverError(res, "Topup yaratishda xatolik", error.message);
  }
}

module.exports = {
  getMe,
  getMyOrders,
  createBalanceTopup,
};

