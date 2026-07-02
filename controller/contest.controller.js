const response = require("../utils/response");
const Contest = require("../model/contest.model");
const {
  buildContestLeaderboard,
  findContestUserRank,
  finalizeContestIfNeeded,
  getContestEligibleProducts,
  getContestLeaderboardLimit,
  getContestPhase,
  mapContest,
  normalizeString,
  toDate,
} = require("../services/contest.service");

function sortPrizes(prizes = []) {
  return [...prizes]
    .map((item, index) => ({
      place: Number(item?.place || index + 1),
      giftId: normalizeString(item?.giftId),
      giftImageUrl: normalizeString(item?.giftImageUrl),
    }))
    .filter((item) => item.place > 0)
    .sort((left, right) => left.place - right.place);
}

function sortEligibleProducts(products = []) {
  return getContestEligibleProducts({ eligibleProducts: products });
}

function validateContestWindow(startAt, endAt) {
  const startsAt = toDate(startAt);
  const endsAt = toDate(endAt);
  if (!startsAt) {
    throw new Error("startAt noto'g'ri");
  }
  if (!endsAt) {
    throw new Error("endAt noto'g'ri");
  }
  if (endsAt.getTime() <= startsAt.getTime()) {
    throw new Error("endAt startAt dan keyin bo'lishi kerak");
  }
  return { startsAt, endsAt };
}

async function listContests(req, res, options = {}) {
  try {
    const contests = await Contest.find({})
      .sort({ startsAt: -1, createdAt: -1 })
      .lean();

    const items = await Promise.all(
      contests.map(async (contest) => {
        const finalized = await finalizeContestIfNeeded(contest);
        const source = finalized || contest;
        const stats =
          source && getContestPhase(source) === "active"
            ? await buildContestLeaderboard(source)
            : null;
        const limit = getContestLeaderboardLimit(source);
        return {
          ...mapContest(source),
          leaderboard: stats?.leaderboard?.slice(0, limit) || [],
        };
      }),
    );

    return response.success(res, options.message || "Contests", items);
  } catch (error) {
    return response.serverError(
      res,
      options.errorMessage || "Contestlarni olishda xatolik",
      error.message,
    );
  }
}

const getCurrentContest = async (req, res) => {
  try {
    const contest = await Contest.find({
      status: { $ne: "cancelled" },
    })
      .sort({ startsAt: -1, createdAt: -1 })
      .lean();

    let activeContest = null;
    for (const item of contest) {
      const phase = getContestPhase(item);
      if (phase === "active") {
        activeContest = await finalizeContestIfNeeded(item);
        break;
      }
    }

    if (!activeContest) {
      return response.success(res, "Contest", {
        contest: null,
        leaderboard: [],
      });
    }

    const stats = await buildContestLeaderboard(activeContest);
    const limit = getContestLeaderboardLimit(activeContest);
    const myRank = findContestUserRank(
      stats.leaderboard,
      req?.telegramAuth?.tgUserId || req.headers["x-tg-user-id"],
    );

    return response.success(res, "Contest", {
      contest: {
        ...mapContest(activeContest),
        leaderboard: stats.leaderboard.slice(0, limit),
      },
      leaderboard: stats.leaderboard.slice(0, limit),
      myRank,
    });
  } catch (error) {
    return response.serverError(
      res,
      "Konkursni olishda xatolik",
      error.message,
    );
  }
};

const getAdminContests = async (req, res) => {
  return listContests(req, res, {
    message: "Contests",
    errorMessage: "Konkurs tarixini olishda xatolik",
  });
};

const createContest = async (req, res) => {
  try {
    const payload = { ...req.validated };
    const startMode = String(payload.startMode || "").toLowerCase();
    const now = new Date();
    const { startsAt, endsAt } =
      startMode === "now"
        ? validateContestWindow(now, payload.endsAt)
        : validateContestWindow(payload.startsAt, payload.endsAt);

    const prizes = sortPrizes(payload.prizes || []);
    if (!prizes.length) {
      return response.error(res, "Kamida bitta prize kiriting");
    }

    const created = await Contest.create({
      title: normalizeString(payload.title),
      startsAt,
      endsAt,
      winnerCount: Number(payload.winnerCount || prizes.length || 1),
      leaderboardLimit: Number(payload.leaderboardLimit || 10),
      eligibleProducts: sortEligibleProducts(payload.eligibleProducts),
      prizes,
      status: startMode === "now" ? "active" : "scheduled",
      createdBy: normalizeString(payload.createdBy),
      updatedBy: normalizeString(payload.updatedBy),
    });

    return response.created(res, "Konkurs yaratildi", mapContest(created));
  } catch (error) {
    return response.serverError(
      res,
      "Konkurs yaratishda xatolik",
      error.message,
    );
  }
};

const updateContest = async (req, res) => {
  try {
    const { id } = req.params;
    const payload = { ...req.validated };
    const contest = await Contest.findById(id).lean();
    if (!contest) return response.notFound(res, "Konkurs topilmadi");
    if (contest.status === "completed") {
      return response.error(res, "Yakunlangan konkursni o'zgartirib bo'lmaydi");
    }

    if (typeof payload.title !== "undefined") {
      payload.title = normalizeString(payload.title);
    }
    if (typeof payload.startsAt !== "undefined" || typeof payload.endsAt !== "undefined") {
      const startsAt = payload.startsAt ? toDate(payload.startsAt) : contest.startsAt;
      const endsAt = payload.endsAt ? toDate(payload.endsAt) : contest.endsAt;
      const window = validateContestWindow(startsAt, endsAt);
      payload.startsAt = window.startsAt;
      payload.endsAt = window.endsAt;
    }
    if (typeof payload.prizes !== "undefined") {
      payload.prizes = sortPrizes(payload.prizes);
    }
    if (typeof payload.winnerCount !== "undefined") {
      payload.winnerCount = Number(payload.winnerCount || 0);
    }
    if (typeof payload.leaderboardLimit !== "undefined") {
      payload.leaderboardLimit = Number(payload.leaderboardLimit || 0);
    }
    if (typeof payload.eligibleProducts !== "undefined") {
      payload.eligibleProducts = sortEligibleProducts(payload.eligibleProducts);
    }
    if (typeof payload.status !== "undefined") {
      payload.status = normalizeString(payload.status) || contest.status;
    }

    const updated = await Contest.findByIdAndUpdate(id, payload, {
      new: true,
      runValidators: true,
    }).lean();

    return response.success(res, "Konkurs yangilandi", mapContest(updated));
  } catch (error) {
    return response.serverError(
      res,
      "Konkurs yangilashda xatolik",
      error.message,
    );
  }
};

const deleteContest = async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await Contest.findByIdAndDelete(id).lean();
    if (!deleted) return response.notFound(res, "Konkurs topilmadi");
    return response.success(res, "Konkurs o'chirildi", mapContest(deleted));
  } catch (error) {
    return response.serverError(
      res,
      "Konkurs o'chirishda xatolik",
      error.message,
    );
  }
};

module.exports = {
  getCurrentContest,
  getAdminContests,
  createContest,
  updateContest,
  deleteContest,
};
