const Contest = require("../model/contest.model");
const NftOffer = require("../model/nft-offer.model");
const Order = require("../model/order.model");
const UserGift = require("../model/user-gift.model");
const UserNft = require("../model/user-nft.model");
const User = require("../model/user.model");

const CONTEST_ORDER_PRODUCTS = ["star", "premium", "uc", "freefire", "mlbb", "hok", "genshin"];
const CONTEST_EXTRA_PRODUCTS = ["gift", "nft"];
const CONTEST_ELIGIBLE_PRODUCTS = [...CONTEST_ORDER_PRODUCTS, ...CONTEST_EXTRA_PRODUCTS];
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
    prizeType:
      normalizeString(doc.prizeType).toLowerCase() === "nft" || normalizeString(doc.nftId)
        ? "nft"
        : "gift",
    giftId: normalizeString(doc.giftId),
    nftId: normalizeString(doc.nftId),
    nftSlug: normalizeString(doc.nftSlug || doc.slug),
    title: normalizeString(doc.title),
    giftImageUrl: normalizeString(doc.giftImageUrl),
    patternImageUrl: normalizeString(doc.patternImageUrl),
    backdropColors: {
      center: normalizeString(doc?.backdropColors?.center) || "",
      edge: normalizeString(doc?.backdropColors?.edge) || "",
      pattern: normalizeString(doc?.backdropColors?.pattern) || "",
      text: normalizeString(doc?.backdropColors?.text) || "",
    },
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
    prizeType:
      normalizeString(doc.prizeType).toLowerCase() === "nft" || normalizeString(doc.nftId)
        ? "nft"
        : "gift",
    giftId: normalizeString(doc.giftId),
    nftId: normalizeString(doc.nftId),
    nftSlug: normalizeString(doc.nftSlug || doc.slug),
    prizeTitle: normalizeString(doc.prizeTitle || doc.title),
    giftImageUrl: normalizeString(doc.giftImageUrl),
    patternImageUrl: normalizeString(doc.patternImageUrl),
  };
}

function mapContest(doc, options = {}) {
  if (!doc) return null;
  const now = options.now || new Date();
  const phase = getContestPhase(doc, now);
  const winnerCount = Number(doc.winnerCount || 0);
  return {
    _id: String(doc._id || ""),
    title: normalizeString(doc.title),
    startsAt: doc.startsAt || null,
    endsAt: doc.endsAt || null,
    winnerCount,
    leaderboardLimit: Number(doc.leaderboardLimit || winnerCount || 10),
    eligibleProducts: getContestEligibleProducts(doc),
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

function getContestLeaderboardLimit(contest) {
  const raw = Number(contest?.leaderboardLimit || 0);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  const winnerCount = Number(contest?.winnerCount || 0);
  if (Number.isFinite(winnerCount) && winnerCount > 0) return Math.floor(winnerCount);
  return 10;
}

function findContestUserRank(leaderboard, tgUserId) {
  const target = normalizeString(tgUserId);
  if (!target || !Array.isArray(leaderboard)) return null;
  return leaderboard.find((item) => normalizeString(item?.tgUserId) === target) || null;
}

function getContestEligibleProducts(contest) {
  const selected = Array.isArray(contest?.eligibleProducts)
    ? contest.eligibleProducts
    : [];
  const normalized = Array.from(
    new Set(
      selected
        .map((item) => normalizeString(item).toLowerCase())
        .filter((item) => CONTEST_ELIGIBLE_PRODUCTS.includes(item)),
    ),
  );
  return normalized.length ? normalized : [...CONTEST_ORDER_PRODUCTS];
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

  const eligibleProducts = getContestEligibleProducts(contest);
  const selectedOrderProducts = eligibleProducts.filter((item) =>
    CONTEST_ORDER_PRODUCTS.includes(item),
  );
  const includeGifts = eligibleProducts.includes("gift");
  const includeNfts = eligibleProducts.includes("nft");

  const [orders, giftPurchases, acceptedOffers, nftSales] = await Promise.all([
    selectedOrderProducts.length
      ? Order.find({
          product: { $in: selectedOrderProducts },
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
            product: 1,
          })
          .lean()
      : Promise.resolve([]),
    includeGifts
      ? UserGift.find({
          priceUzs: { $gt: 0 },
          createdAt: { $gte: startsAt, $lte: endsAt },
        })
          .select({
            tgUserId: 1,
            tgUsername: 1,
            title: 1,
            priceUzs: 1,
            createdAt: 1,
          })
          .lean()
      : Promise.resolve([]),
    includeNfts
      ? NftOffer.find({
          status: "accepted",
          offeredPriceUzs: { $gt: 0 },
          acceptedAt: { $gte: startsAt, $lte: endsAt },
        })
          .select({
            nftId: 1,
            buyerTgUserId: 1,
            buyerUsername: 1,
            buyerProfileName: 1,
            offeredPriceUzs: 1,
            acceptedAt: 1,
          })
          .lean()
      : Promise.resolve([]),
    includeNfts
      ? UserNft.find({
          lastSoldPriceUzs: { $gt: 0 },
          lastSoldAt: { $gte: startsAt, $lte: endsAt },
        })
          .select({
            nftId: 1,
            ownerTgUserId: 1,
            ownerUsername: 1,
            ownerName: 1,
            lastBuyerTgUserId: 1,
            lastSoldPriceUzs: 1,
            lastSoldAt: 1,
          })
          .lean()
      : Promise.resolve([]),
  ]);

  const acceptedOfferKeyMap = new Map();
  acceptedOffers.forEach((offer) => {
    const key = [
      normalizeString(offer?.nftId),
      normalizeString(offer?.buyerTgUserId),
      Number(offer?.offeredPriceUzs || 0),
    ].join(":");
    const existing = acceptedOfferKeyMap.get(key) || [];
    existing.push(toDate(offer?.acceptedAt)?.getTime() || 0);
    acceptedOfferKeyMap.set(key, existing);
  });

  const events = [
    ...orders
      .map((order) => {
        const paidAt = toDate(order?.paidAt);
        const createdAt = toDate(order?.createdAt);
        const eventTime = paidAt || createdAt;
        if (!eventTime) return null;
        if (eventTime.getTime() < startsAt.getTime()) return null;
        if (eventTime.getTime() > endsAt.getTime()) return null;
        return {
          tgUserId: normalizeString(order?.tgUserId),
          username: normalizeUsername(order?.tgUsername),
          profileName: normalizeString(order?.profileName),
          amount: Number(order?.paidAmount || order?.expectedAmount || 0),
          eventTime,
        };
      })
      .filter(Boolean),
    ...giftPurchases
      .map((gift) => {
        const eventTime = toDate(gift?.createdAt);
        if (!eventTime) return null;
        return {
          tgUserId: normalizeString(gift?.tgUserId),
          username: normalizeUsername(gift?.tgUsername),
          profileName: "",
          amount: Number(gift?.priceUzs || 0),
          eventTime,
        };
      })
      .filter((item) => item && item.amount > 0),
    ...acceptedOffers
      .map((offer) => {
        const eventTime = toDate(offer?.acceptedAt);
        if (!eventTime) return null;
        return {
          tgUserId: normalizeString(offer?.buyerTgUserId),
          username: normalizeUsername(offer?.buyerUsername),
          profileName: normalizeString(offer?.buyerProfileName),
          amount: Number(offer?.offeredPriceUzs || 0),
          eventTime,
        };
      })
      .filter((item) => item && item.amount > 0),
    ...nftSales
      .map((sale) => {
        const eventTime = toDate(sale?.lastSoldAt);
        if (!eventTime) return null;
        const tgUserId =
          normalizeString(sale?.lastBuyerTgUserId) || normalizeString(sale?.ownerTgUserId);
        const dedupeKey = [
          normalizeString(sale?.nftId),
          tgUserId,
          Number(sale?.lastSoldPriceUzs || 0),
        ].join(":");
        const acceptedTimes = acceptedOfferKeyMap.get(dedupeKey) || [];
        if (acceptedTimes.some((time) => Math.abs(time - eventTime.getTime()) <= 10000)) {
          return null;
        }
        return {
          tgUserId,
          username: normalizeUsername(sale?.ownerUsername),
          profileName: normalizeString(sale?.ownerName),
          amount: Number(sale?.lastSoldPriceUzs || 0),
          eventTime,
        };
      })
      .filter((item) => item && item.amount > 0),
  ];

  const tgUserIds = Array.from(new Set(events.map((item) => item.tgUserId).filter(Boolean)));
  const users = tgUserIds.length
    ? await User.find({ tgUserId: { $in: tgUserIds } })
        .select({ tgUserId: 1, username: 1, profileName: 1 })
        .lean()
    : [];
  const userMap = new Map(
    users.map((user) => [normalizeString(user?.tgUserId), user]),
  );

  const grouped = new Map();

  events.forEach((event) => {
    const tgUserId = normalizeString(event?.tgUserId);
    const user = userMap.get(tgUserId) || null;
    const username = normalizeUsername(user?.username || event?.username);
    const profileName = normalizeString(user?.profileName || event?.profileName);
    const displayName =
      profileName || (username ? `@${username}` : tgUserId) || tgUserId;
    const amount = Number(event?.amount || 0);
    if (amount <= 0) return;
    const current = grouped.get(tgUserId || `guest:${normalizeString(event?.username)}`);

    if (!current) {
      grouped.set(tgUserId || `guest:${normalizeString(event?.username)}`, {
        tgUserId,
        username,
        profileName: displayName,
        totalSpent: amount,
        orderCount: 1,
        lastOrderAt: event.eventTime.getTime(),
      });
      return;
    }

    current.totalSpent += amount;
    current.orderCount += 1;
    if (event.eventTime.getTime() > current.lastOrderAt) {
      current.lastOrderAt = event.eventTime.getTime();
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
      prizeType:
        normalizeString(prize.prizeType).toLowerCase() === "nft" || normalizeString(prize.nftId)
          ? "nft"
          : "gift",
      giftId: normalizeString(prize.giftId),
      nftId: normalizeString(prize.nftId),
      nftSlug: normalizeString(prize.nftSlug || prize.slug),
      prizeTitle: normalizeString(prize.title),
      giftImageUrl: normalizeString(prize.giftImageUrl),
      patternImageUrl: normalizeString(prize.patternImageUrl),
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
  CONTEST_ELIGIBLE_PRODUCTS,
  CONTEST_ORDER_PRODUCTS,
  getContestEligibleProducts,
  SUCCESS_STATUSES,
  buildContestLeaderboard,
  buildWinnerSnapshot,
  findContestUserRank,
  finalizeContestIfNeeded,
  getContestLeaderboardLimit,
  getContestPhase,
  getContestPublicStatus,
  mapContest,
  mapContestPrize,
  mapContestWinner,
  normalizeString,
  toDate,
};
