const Contest = require("../model/contest.model");
const Order = require("../model/order.model");
const User = require("../model/user.model");

const CONTEST_ORDER_PRODUCTS = ["star", "premium", "uc", "freefire", "mlbb"];
const SUCCESS_STATUSES = ["paid_auto_processed", "completed"];

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeUsername(value) {
  return normalizeString(value).replace(/^@+/, "");
}

function toDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getContestPhase(contest, now = new Date()) {
  if (!contest) return "none";
  if (contest.status === "cancelled") return "cancelled";

  const startsAt = toDate(contest.startsAt);
  const endsAt = toDate(contest.endsAt);
  const nowValue = now.getTime();

  if (!startsAt || !endsAt) return contest.status || "scheduled";
  if (nowValue < startsAt.getTime()) return "scheduled";
  if (nowValue <= endsAt.getTime()) return "active";
  return "completed";
}

function getContestPublicStatus(contest, now = new Date()) {
  const phase = getContestPhase(contest, now);
  if (phase === "active") return "active";
  if (phase === "scheduled") return "scheduled";
  if (phase === "completed") return "completed";
  return "cancelled";
}

function mapContestPrize(doc = {}) {
  return {
    place: Number(doc.place || 0),
    title: normalizeString(doc.title),
    giftId: normalizeString(doc.giftId),
    giftName: normalizeString(doc.giftName),
    giftEmoji: normalizeString(doc.giftEmoji) || "🎁",
    giftImageUrl: normalizeString(doc.giftImageUrl),
  };
}

function mapContestWinner(doc = {}) {
  return {
    place: Number(doc.place || 0),
    tgUserId: normalizeString(doc.tgUserId),
    username: normalizeString(doc.username),
    profileName: normalizeString(doc.profileName),
    totalSpent: Number(doc.totalSpent || 0),
    orderCount: Number(doc.orderCount || 0),
    prizeTitle: normalizeString(doc.prizeTitle),
    giftId: normalizeString(doc.giftId),
    giftName: normalizeString(doc.giftName),
    giftEmoji: normalizeString(doc.giftEmoji) || "🎁",
    giftImageUrl: normalizeString(doc.giftImageUrl),
  };
}

function mapContest(doc, options = {}) {
  if (!doc) return null;
  const now = options.now || new Date();
  const phase = getContestPhase(doc, now);
  return {
    _id: String(doc._id || ""),
    title: normalizeString(doc.title),
    description: normalizeString(doc.description),
    startsAt: doc.startsAt || null,
    endsAt: doc.endsAt || null,
    bannerEmoji: normalizeString(doc.bannerEmoji) || "🏆",
    winnerCount: Number(doc.winnerCount || 0),
    prizes: Array.isArray(doc.prizes) ? doc.prizes.map(mapContestPrize) : [],
    status: phase,
    rawStatus: normalizeString(doc.status) || "scheduled",
    totalSales: Number(doc.totalSales || 0),
    participantCount: Number(doc.participantCount || 0),
    winnerSnapshot: Array.isArray(doc.winnerSnapshot)
      ? doc.winnerSnapshot.map(mapContestWinner)
      : [],
    completedAt: doc.completedAt || null,
    createdAt: doc.createdAt || null,
    updatedAt: doc.updatedAt || null,
  };
}

function buildContestWinnerPrizeMap(contest) {
  const prizes = Array.isArray(contest?.prizes) ? contest.prizes : [];
  return new Map(
    prizes
      .map((item, index) => ({
        ...mapContestPrize(item),
        place: Number(item?.place || index + 1),
      }))
      .filter((item) => item.place > 0)
      .map((item) => [item.place, item]),
  );
}

async function buildContestLeaderboard(contest) {
  if (!contest) {
    return {
      leaderboard: [],
      totalSales: 0,
      participantCount: 0,
    };
  }

  const startsAt = toDate(contest.startsAt);
  const endsAt = toDate(contest.endsAt);
  if (!startsAt || !endsAt) {
    return {
      leaderboard: [],
      totalSales: 0,
      participantCount: 0,
    };
  }

  const orders = await Order.find({
    product: { $in: CONTEST_ORDER_PRODUCTS },
    status: { $in: SUCCESS_STATUSES },
    createdAt: { $lte: endsAt },
  })
    .select({
      tgUserId: 1,
      tgUsername: 1,
      profileName: 1,
      expectedAmount: 1,
      paidAmount: 1,
      paidAt: 1,
      createdAt: 1,
      orderId: 1,
      product: 1,
    })
    .lean();

  const relevantOrders = orders
    .map((order) => {
      const paidAt = toDate(order?.paidAt);
      const createdAt = toDate(order?.createdAt);
      const eventTime = paidAt || createdAt;
      if (!eventTime) return null;
      if (eventTime.getTime() < startsAt.getTime()) return null;
      if (eventTime.getTime() > endsAt.getTime()) return null;
      return {
        ...order,
        eventTime,
      };
    })
    .filter(Boolean);

  const tgUserIds = Array.from(
    new Set(
      relevantOrders
        .map((order) => normalizeString(order?.tgUserId))
        .filter(Boolean),
    ),
  );
  const users = tgUserIds.length
    ? await User.find({ tgUserId: { $in: tgUserIds } })
        .select({ tgUserId: 1, username: 1, profileName: 1 })
        .lean()
    : [];
  const userMap = new Map(
    users.map((user) => [normalizeString(user?.tgUserId), user]),
  );

  const grouped = new Map();

  relevantOrders.forEach((order) => {
    const tgUserId = normalizeString(order?.tgUserId);
    const user = userMap.get(tgUserId) || null;
    const username = normalizeUsername(user?.username || order?.tgUsername);
    const profileName = normalizeString(user?.profileName || order?.profileName);
    const displayName =
      profileName || (username ? `@${username}` : tgUserId) || tgUserId;
    const amount = Number(order?.paidAmount || order?.expectedAmount || 0);
    const current = grouped.get(tgUserId || `guest:${normalizeString(order?.tgUsername)}`);

    if (!current) {
      grouped.set(tgUserId || `guest:${normalizeString(order?.tgUsername)}`, {
        tgUserId,
        username,
        profileName: displayName,
        totalSpent: amount,
        orderCount: 1,
        lastOrderAt: order.eventTime.getTime(),
      });
      return;
    }

    current.totalSpent += amount;
    current.orderCount += 1;
    if (order.eventTime.getTime() > current.lastOrderAt) {
      current.lastOrderAt = order.eventTime.getTime();
      current.username = username || current.username;
      current.profileName = displayName || current.profileName;
    }
  });

  const leaderboard = Array.from(grouped.values())
    .sort((left, right) => {
      if (right.totalSpent !== left.totalSpent) return right.totalSpent - left.totalSpent;
      if (right.lastOrderAt !== left.lastOrderAt) return right.lastOrderAt - left.lastOrderAt;
      return String(left.profileName || "").localeCompare(String(right.profileName || ""));
    })
    .map((item, index) => ({
      place: index + 1,
      tgUserId: item.tgUserId,
      username: item.username,
      profileName: item.profileName,
      totalSpent: Number(item.totalSpent || 0),
      orderCount: Number(item.orderCount || 0),
    }));

  const totalSales = leaderboard.reduce(
    (sum, item) => sum + Number(item.totalSpent || 0),
    0,
  );

  return {
    leaderboard,
    totalSales,
    participantCount: leaderboard.length,
  };
}

function buildWinnerSnapshot(contest, leaderboard) {
  const prizeMap = buildContestWinnerPrizeMap(contest);
  return leaderboard.slice(0, Number(contest?.winnerCount || 0) || 0).map((item) => {
    const prize = prizeMap.get(item.place) || {};
    return {
      place: Number(item.place || 0),
      tgUserId: normalizeString(item.tgUserId),
      username: normalizeString(item.username),
      profileName: normalizeString(item.profileName),
      totalSpent: Number(item.totalSpent || 0),
      orderCount: Number(item.orderCount || 0),
      prizeTitle: normalizeString(prize.title),
      giftId: normalizeString(prize.giftId),
      giftName: normalizeString(prize.giftName),
      giftEmoji: normalizeString(prize.giftEmoji) || "🎁",
      giftImageUrl: normalizeString(prize.giftImageUrl),
    };
  });
}

async function finalizeContestIfNeeded(contestDoc) {
  if (!contestDoc) return null;
  const phase = getContestPhase(contestDoc);
  if (phase !== "completed") {
    return contestDoc;
  }

  if (
    contestDoc.status === "completed" &&
    Array.isArray(contestDoc.winnerSnapshot) &&
    contestDoc.winnerSnapshot.length
  ) {
    return contestDoc;
  }

  const stats = await buildContestLeaderboard(contestDoc);
  const winnerSnapshot = buildWinnerSnapshot(contestDoc, stats.leaderboard);
  const updated = await Contest.findByIdAndUpdate(
    contestDoc._id,
    {
      $set: {
        status: "completed",
        totalSales: stats.totalSales,
        participantCount: stats.participantCount,
        winnerSnapshot,
        completedAt: new Date(),
      },
    },
    { new: true },
  ).lean();

  return updated || contestDoc;
}

module.exports = {
  CONTEST_ORDER_PRODUCTS,
  SUCCESS_STATUSES,
  buildContestLeaderboard,
  buildWinnerSnapshot,
  finalizeContestIfNeeded,
  getContestPhase,
  getContestPublicStatus,
  mapContest,
  mapContestPrize,
  mapContestWinner,
  normalizeString,
  toDate,
};
