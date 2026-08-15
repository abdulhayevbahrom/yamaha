function requireText(value, field) {
  if (!value || String(value).trim().length === 0) {
    throw new Error(`${field} required`);
  }
  return String(value).trim();
}

function requireNumber(value, field) {
  const num = Number(value);
  if (!Number.isFinite(num)) throw new Error(`${field} number bo'lishi kerak`);
  return num;
}

function normalizeCardNumber(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length !== 16) {
    throw new Error("cardNumber 16 ta raqam bo'lishi kerak");
  }
  return digits;
}

const validCategories = ["star", "premium", "uc", "redeem", "freefire", "mlbb", "hok", "genshin"];
const validPaymentCardTypes = ["purchase", "balance_topup"];
const validContestModes = ["now", "scheduled"];
const validContestProducts = ["star", "premium", "uc", "freefire", "mlbb", "hok", "genshin", "gift", "nft"];
const validHeroSlideTargets = [
  "",
  "stars",
  "premium",
  "pubg",
  "freefire",
  "mlbb",
  "star_sell",
  "gifts",
  "orders",
  "profile",
  "referral",
];

function normalizeHeroSlideTarget(value) {
  const target = String(value || "").trim().toLowerCase();
  if (!validHeroSlideTargets.includes(target)) {
    throw new Error("targetTab noto'g'ri");
  }
  return target;
}

function normalizeContestPrizes(value) {
  if (!Array.isArray(value)) {
    throw new Error("prizes array bo'lishi kerak");
  }

  const prizes = value
    .map((item, index) => {
      const place = requireNumber(item?.place ?? index + 1, "prize place");
      const prizeType =
        String(item?.prizeType || (String(item?.nftId || "").trim() ? "nft" : "gift"))
          .trim()
          .toLowerCase() === "nft"
          ? "nft"
          : "gift";
      return {
        place,
        prizeType,
        giftId:
          prizeType === "gift"
            ? typeof item?.giftId === "undefined"
              ? ""
              : String(item.giftId).trim()
            : typeof item?.giftId === "undefined"
              ? ""
              : String(item.giftId).trim(),
        nftId:
          prizeType === "nft"
            ? typeof item?.nftId === "undefined"
              ? ""
              : String(item.nftId).trim()
            : "",
        nftSlug:
          prizeType === "nft"
            ? typeof item?.nftSlug === "undefined"
              ? ""
              : String(item.nftSlug).trim()
            : "",
        giftImageUrl:
          typeof item?.giftImageUrl === "undefined"
            ? ""
            : String(item.giftImageUrl).trim(),
      };
    })
    .filter((item) => Number.isFinite(item.place) && item.place > 0)
    .sort((left, right) => left.place - right.place);

  if (!prizes.length) {
    throw new Error("Kamida bitta prize kerak");
  }

  const invalid = prizes.find(
    (item) =>
      (item.prizeType === "gift" && !item.giftId) ||
      (item.prizeType === "nft" && !item.nftId),
  );
  if (invalid) {
    throw new Error(
      invalid.prizeType === "nft"
        ? "NFT prize uchun nftId kiriting"
        : "Gift prize uchun giftId kiriting",
    );
  }

  return prizes;
}

function normalizeContestProducts(value) {
  if (!Array.isArray(value)) {
    throw new Error("eligibleProducts array bo'lishi kerak");
  }

  const products = Array.from(
    new Set(
      value
        .map((item) => String(item || "").trim().toLowerCase())
        .filter(Boolean),
    ),
  );

  if (!products.length) {
    throw new Error("Kamida bitta mahsulot tanlang");
  }

  const invalid = products.find((item) => !validContestProducts.includes(item));
  if (invalid) {
    throw new Error(`eligibleProducts noto'g'ri: ${invalid}`);
  }

  return products;
}

const loginValidation = (req) => {
  const { username, password, tgUserId } = req.body || {};
  return {
    username: requireText(username, "username"),
    password: requireText(password, "password"),
    tgUserId: requireText(tgUserId, "tgUserId"),
  };
};

const createPlanValidation = (req) => {
  const { category, code, label, amount, basePrice, isActive } = req.body || {};
  if (!validCategories.includes(category)) throw new Error("category noto'g'ri");

  return {
    category,
    code: requireText(code, "code"),
    label: requireText(label, "label"),
    amount: requireNumber(amount, "amount"),
    basePrice: requireNumber(basePrice, "basePrice"),
    isActive: typeof isActive === "boolean" ? isActive : true
  };
};

const updatePlanValidation = (req) => {
  const { label, amount, basePrice, isActive } = req.body || {};
  const payload = {};

  if (typeof label !== "undefined") payload.label = requireText(label, "label");
  if (typeof amount !== "undefined") payload.amount = requireNumber(amount, "amount");
  if (typeof basePrice !== "undefined") payload.basePrice = requireNumber(basePrice, "basePrice");
  if (typeof isActive !== "undefined") payload.isActive = Boolean(isActive);

  if (Object.keys(payload).length === 0) {
    throw new Error("Yangilash uchun kamida bitta field yuboring");
  }

  return payload;
};

const createPaymentCardValidation = (req) => {
  const {
    type,
    label,
    cardNumber,
    cardHolder,
    notes,
    sortOrder,
    isActive,
  } = req.body || {};

  if (!validPaymentCardTypes.includes(type)) {
    throw new Error("type noto'g'ri");
  }

  return {
    type,
    label: requireText(label, "label"),
    cardNumber: normalizeCardNumber(cardNumber),
    cardHolder: requireText(cardHolder, "cardHolder"),
    notes: typeof notes === "undefined" ? "" : String(notes).trim(),
    sortOrder:
      typeof sortOrder === "undefined" ? 0 : requireNumber(sortOrder, "sortOrder"),
    isActive: typeof isActive === "boolean" ? isActive : true,
  };
};

const updatePaymentCardValidation = (req) => {
  const {
    type,
    label,
    cardNumber,
    cardHolder,
    notes,
    sortOrder,
    isActive,
  } = req.body || {};
  const payload = {};

  if (typeof type !== "undefined") {
    if (!validPaymentCardTypes.includes(type)) {
      throw new Error("type noto'g'ri");
    }
    payload.type = type;
  }
  if (typeof label !== "undefined") payload.label = requireText(label, "label");
  if (typeof cardNumber !== "undefined") {
    payload.cardNumber = normalizeCardNumber(cardNumber);
  }
  if (typeof cardHolder !== "undefined") {
    payload.cardHolder = requireText(cardHolder, "cardHolder");
  }
  if (typeof notes !== "undefined") payload.notes = String(notes).trim();
  if (typeof sortOrder !== "undefined") {
    payload.sortOrder = requireNumber(sortOrder, "sortOrder");
  }
  if (typeof isActive !== "undefined") payload.isActive = Boolean(isActive);

  if (Object.keys(payload).length === 0) {
    throw new Error("Yangilash uchun kamida bitta field yuboring");
  }

  return payload;
};

const createStaticGiftValidation = (req) => {
  const { giftId, title, emoji, stars, imageUrl, isActive, sortOrder } = req.body || {};

  return {
    giftId: requireText(giftId, "giftId"),
    title: requireText(title, "title"),
    emoji: typeof emoji === "undefined" ? "🎁" : requireText(emoji, "emoji"),
    stars: requireNumber(stars, "stars"),
    imageUrl: typeof imageUrl === "undefined" ? "" : String(imageUrl).trim(),
    isActive: typeof isActive === "boolean" ? isActive : true,
    sortOrder:
      typeof sortOrder === "undefined" ? 0 : requireNumber(sortOrder, "sortOrder"),
  };
};

const updateStaticGiftValidation = (req) => {
  const { giftId, title, emoji, stars, imageUrl, isActive, sortOrder } = req.body || {};
  const payload = {};

  if (typeof giftId !== "undefined") payload.giftId = requireText(giftId, "giftId");
  if (typeof title !== "undefined") payload.title = requireText(title, "title");
  if (typeof emoji !== "undefined") payload.emoji = requireText(emoji, "emoji");
  if (typeof stars !== "undefined") payload.stars = requireNumber(stars, "stars");
  if (typeof imageUrl !== "undefined") payload.imageUrl = String(imageUrl).trim();
  if (typeof isActive !== "undefined") payload.isActive = Boolean(isActive);
  if (typeof sortOrder !== "undefined") {
    payload.sortOrder = requireNumber(sortOrder, "sortOrder");
  }

  if (Object.keys(payload).length === 0) {
    throw new Error("Yangilash uchun kamida bitta field yuboring");
  }

  return payload;
};

const createHeroSlideValidation = (req) => {
  const { title, imageUrl, targetTab, sortOrder, isActive } = req.body || {};

  return {
    title: typeof title === "undefined" ? "" : String(title).trim(),
    imageUrl: requireText(imageUrl, "imageUrl"),
    targetTab:
      typeof targetTab === "undefined" ? "" : normalizeHeroSlideTarget(targetTab),
    sortOrder:
      typeof sortOrder === "undefined" ? 0 : requireNumber(sortOrder, "sortOrder"),
    isActive: typeof isActive === "boolean" ? isActive : true,
  };
};

const updateHeroSlideValidation = (req) => {
  const { title, imageUrl, targetTab, sortOrder, isActive } = req.body || {};
  const payload = {};

  if (typeof title !== "undefined") payload.title = String(title).trim();
  if (typeof imageUrl !== "undefined") payload.imageUrl = requireText(imageUrl, "imageUrl");
  if (typeof targetTab !== "undefined") payload.targetTab = normalizeHeroSlideTarget(targetTab);
  if (typeof sortOrder !== "undefined") {
    payload.sortOrder = requireNumber(sortOrder, "sortOrder");
  }
  if (typeof isActive !== "undefined") payload.isActive = Boolean(isActive);

  if (Object.keys(payload).length === 0) {
    throw new Error("Yangilash uchun kamida bitta field yuboring");
  }

  return payload;
};

const createContestValidation = (req) => {
  const {
    title,
    startMode,
    startsAt,
    endsAt,
    winnerCount,
    leaderboardLimit,
    eligibleProducts,
    prizes,
    createdBy,
    updatedBy,
  } = req.body || {};

  const normalizedMode = String(startMode || "scheduled").toLowerCase();
  if (!validContestModes.includes(normalizedMode)) {
    throw new Error("startMode noto'g'ri");
  }

  const payload = {
    title: requireText(title, "title"),
    startMode: normalizedMode,
    endsAt: requireText(endsAt, "endsAt"),
    winnerCount:
      typeof winnerCount === "undefined"
        ? 3
        : requireNumber(winnerCount, "winnerCount"),
    leaderboardLimit:
      typeof leaderboardLimit === "undefined"
        ? 10
        : requireNumber(leaderboardLimit, "leaderboardLimit"),
    eligibleProducts: normalizeContestProducts(eligibleProducts),
    prizes: normalizeContestPrizes(prizes),
    createdBy: typeof createdBy === "undefined" ? "" : String(createdBy).trim(),
    updatedBy: typeof updatedBy === "undefined" ? "" : String(updatedBy).trim(),
  };

  if (normalizedMode === "scheduled") {
    payload.startsAt = requireText(startsAt, "startsAt");
  }

  if (!Number.isFinite(payload.winnerCount) || payload.winnerCount <= 0) {
    throw new Error("winnerCount 1 dan katta bo'lishi kerak");
  }
  if (!Number.isFinite(payload.leaderboardLimit) || payload.leaderboardLimit <= 0) {
    throw new Error("leaderboardLimit 1 dan katta bo'lishi kerak");
  }

  return payload;
};

const updateContestValidation = (req) => {
  const {
    title,
    startsAt,
    endsAt,
    winnerCount,
    leaderboardLimit,
    eligibleProducts,
    prizes,
    status,
  } = req.body || {};
  const payload = {};

  if (typeof title !== "undefined") payload.title = requireText(title, "title");
  if (typeof startsAt !== "undefined") payload.startsAt = requireText(startsAt, "startsAt");
  if (typeof endsAt !== "undefined") payload.endsAt = requireText(endsAt, "endsAt");
  if (typeof winnerCount !== "undefined") {
    payload.winnerCount = requireNumber(winnerCount, "winnerCount");
  }
  if (typeof leaderboardLimit !== "undefined") {
    payload.leaderboardLimit = requireNumber(leaderboardLimit, "leaderboardLimit");
    if (!Number.isFinite(payload.leaderboardLimit) || payload.leaderboardLimit <= 0) {
      throw new Error("leaderboardLimit 1 dan katta bo'lishi kerak");
    }
  }
  if (typeof eligibleProducts !== "undefined") {
    payload.eligibleProducts = normalizeContestProducts(eligibleProducts);
  }
  if (typeof prizes !== "undefined") payload.prizes = normalizeContestPrizes(prizes);
  if (typeof status !== "undefined") {
    const normalizedStatus = String(status || "").trim();
    if (!["scheduled", "active", "completed", "cancelled"].includes(normalizedStatus)) {
      throw new Error("status noto'g'ri");
    }
    payload.status = normalizedStatus;
  }

  if (Object.keys(payload).length === 0) {
    throw new Error("Yangilash uchun kamida bitta field yuboring");
  }

  return payload;
};

module.exports = {
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
};
