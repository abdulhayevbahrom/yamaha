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

const validCategories = ["star", "premium", "uc", "freefire", "mlbb"];
const validPaymentCardTypes = ["purchase", "balance_topup"];

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

module.exports = {
  loginValidation,
  createPlanValidation,
  updatePlanValidation,
  createPaymentCardValidation,
  updatePaymentCardValidation,
};
