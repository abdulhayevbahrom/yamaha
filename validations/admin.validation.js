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

const validCategories = ["star", "premium", "uc"];

const loginValidation = (req) => {
  const { username, password } = req.body || {};
  return {
    username: requireText(username, "username"),
    password: requireText(password, "password")
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

module.exports = {
  loginValidation,
  createPlanValidation,
  updatePlanValidation
};
