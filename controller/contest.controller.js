const response = require("../utils/response");
const Contest = require("../model/contest.model");
const UserNft = require("../model/user-nft.model");
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

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseNftSlugAndNumber(value) {
  const normalized = normalizeString(value);
  if (!normalized) {
    return {
      slug: "",
      nftNumber: 0,
      nftNumberText: "",
    };
  }

  const match = normalized.match(/^(.*)-(\d{1,18})$/);
  if (!match) {
    return {
      slug: "",
      nftNumber: 0,
      nftNumberText: "",
    };
  }

  const slug = normalizeString(match[1]).replace(/[-_]+$/, "");
  const nftNumberText = normalizeString(match[2]);
  const nftNumber = Number(nftNumberText);

  if (!slug || !Number.isFinite(nftNumber) || nftNumber <= 0) {
    return {
      slug: "",
      nftNumber: 0,
      nftNumberText: "",
    };
  }

  return {
    slug,
    nftNumber,
    nftNumberText,
  };
}

function extractTelegramNftCandidate(value) {
  const raw = normalizeString(value);
  if (!raw) return "";

  let candidate = raw;
  const directMatch = raw.match(
    /(?:https?:\/\/)?(?:t(?:elegram)?\.me)\/nft\/([^\s/?#]+)/i,
  );

  if (directMatch?.[1]) {
    candidate = directMatch[1];
  } else {
    try {
      const candidateUrl = raw.includes("://") ? raw : "https://" + raw;
      const url = new URL(candidateUrl);
      const parts = String(url.pathname || "")
        .split("/")
        .filter(Boolean);
      const nftIndex = parts.findIndex((part) => /^nft$/i.test(part));
      if (nftIndex >= 0 && parts[nftIndex + 1]) {
        candidate = parts[nftIndex + 1];
      }
    } catch (_) {
      // Oddiy NFT ID bo'lsa URL parser kerak emas.
    }
  }

  const candidateRaw = String(candidate || "").split(/[?#]/)[0].replace(/\/+$/, "");
  try {
    return normalizeString(decodeURIComponent(candidateRaw));
  } catch (_) {
    return normalizeString(candidateRaw);
  }
}

function buildContestNftPrizePayload(doc = {}) {
  const normalizedNftId = normalizeString(doc?.nftId || doc?.giftId);
  const normalizedSlug = normalizeString(doc?.slug || doc?.nftSlug);
  return {
    prizeType: "nft",
    giftId: normalizeString(doc?.giftId),
    nftId: normalizedNftId,
    nftSlug: normalizedSlug,
    title: normalizeString(doc?.title) || "NFT Gift",
    giftImageUrl: normalizedNftId
      ? `/api/gifts/nft-image/${encodeURIComponent(normalizedNftId)}`
      : normalizeString(doc?.giftImageUrl),
    patternImageUrl:
      normalizeString(doc?.patternAssetStatus) === "available" && normalizedNftId
        ? `/api/gifts/nft-pattern/${encodeURIComponent(normalizedNftId)}`
        : "",
    backdropColors: {
      center: normalizeString(doc?.backdropColors?.center) || "#346d2b",
      edge: normalizeString(doc?.backdropColors?.edge) || "#2d5f24",
      pattern: normalizeString(doc?.backdropColors?.pattern) || "#8ec95d",
      text: normalizeString(doc?.backdropColors?.text) || "#eaffdc",
    },
  };
}

async function enrichContestPrize(item = {}) {
  const prizeType =
    normalizeString(item?.prizeType).toLowerCase() === "nft" || normalizeString(item?.nftId)
      ? "nft"
      : "gift";

  if (prizeType !== "nft") {
    return {
      place: Number(item?.place || 0),
      prizeType: "gift",
      giftId: normalizeString(item?.giftId),
      nftId: "",
      nftSlug: "",
      title: normalizeString(item?.title),
      giftImageUrl: normalizeString(item?.giftImageUrl),
      patternImageUrl: "",
      backdropColors: {
        center: "",
        edge: "",
        pattern: "",
        text: "",
      },
    };
  }

  const nftCandidate = extractTelegramNftCandidate(item?.nftId || item?.giftId || item?.nftSlug);
  if (!nftCandidate) {
    return {
      place: Number(item?.place || 0),
      prizeType: "nft",
      giftId: "",
      nftId: "",
      nftSlug: "",
      title: normalizeString(item?.title) || "NFT Gift",
      giftImageUrl: normalizeString(item?.giftImageUrl),
      patternImageUrl: "",
      backdropColors: {
        center: "#346d2b",
        edge: "#2d5f24",
        pattern: "#8ec95d",
        text: "#eaffdc",
      },
    };
  }

  const candidateRegex = new RegExp("^" + escapeRegex(nftCandidate) + "$", "i");
  const parsed = parseNftSlugAndNumber(nftCandidate);
  const nftOr = [
    { nftId: nftCandidate },
    { slug: nftCandidate },
    { nftId: candidateRegex },
    { slug: candidateRegex },
  ];

  if (parsed.slug) {
    const slugRegex = new RegExp("^" + escapeRegex(parsed.slug) + "$", "i");
    const titleFromSlug = normalizeString(
      parsed.slug
        .replace(/[-_]+/g, " ")
        .replace(/([a-z])([A-Z])/g, "$1 $2"),
    );
    const titleFromSlugRegex = new RegExp(
      "^" + escapeRegex(titleFromSlug).replace(/\s+/g, "\\s*") + "$",
      "i",
    );
    nftOr.push({ slug: parsed.slug });
    nftOr.push({ slug: slugRegex });
    if (parsed.nftNumber > 0) {
      nftOr.push({ $and: [{ title: titleFromSlugRegex }, { nftNumber: parsed.nftNumber }] });
      nftOr.push({ $and: [{ slug: slugRegex }, { nftNumber: parsed.nftNumber }] });
    }
  }

  if (parsed.nftNumber > 0) {
    nftOr.push({ nftId: parsed.nftNumberText });
  }

  if (parsed.slug && parsed.nftNumberText) {
    const composite = parsed.slug + "-" + parsed.nftNumberText;
    const compositeRegex = new RegExp("^" + escapeRegex(composite) + "$", "i");
    nftOr.push({ nftId: composite });
    nftOr.push({ slug: composite });
    nftOr.push({ nftId: compositeRegex });
    nftOr.push({ slug: compositeRegex });
  }

  const nftDoc = await UserNft.findOne({
    $or: nftOr,
  })
    .select({
      nftId: 1,
      giftId: 1,
      slug: 1,
      title: 1,
      patternAssetStatus: 1,
      backdropColors: 1,
    })
    .lean();

  const normalized = nftDoc
    ? buildContestNftPrizePayload(nftDoc)
    : buildContestNftPrizePayload({ ...item, nftId: nftCandidate, nftSlug: nftCandidate });
  return {
    place: Number(item?.place || 0),
    ...normalized,
  };
}

async function sortPrizes(prizes = []) {
  const normalized = await Promise.all(
    [...prizes].map(async (item, index) => {
      const enriched = await enrichContestPrize(item);
      return {
        ...enriched,
        place: Number(item?.place || enriched.place || index + 1),
      };
    }),
  );

  return normalized
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
        const enrichedSource = {
          ...source,
          prizes: await sortPrizes(source?.prizes || []),
        };
        const stats =
          enrichedSource && getContestPhase(enrichedSource) === "active"
            ? await buildContestLeaderboard(enrichedSource)
            : null;
        const limit = getContestLeaderboardLimit(enrichedSource);
        return {
          ...mapContest(enrichedSource),
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

    const enrichedContest = {
      ...activeContest,
      prizes: await sortPrizes(activeContest?.prizes || []),
    };
    const stats = await buildContestLeaderboard(enrichedContest);
    const limit = getContestLeaderboardLimit(enrichedContest);
    const myRank = findContestUserRank(
      stats.leaderboard,
      req?.telegramAuth?.tgUserId || req.headers["x-tg-user-id"],
    );

    return response.success(res, "Contest", {
      contest: {
        ...mapContest(enrichedContest),
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

    const prizes = await sortPrizes(payload.prizes || []);
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
      payload.prizes = await sortPrizes(payload.prizes);
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
