const jwt = require("jsonwebtoken");
const response = require("../utils/response");
const Plan = require("../model/plan.model");
// const { ensureDefaultPlans } = require("./public.controller");

const login = async (req, res) => {
  const { username, password } = req.validated;
  const adminLogin = process.env.ADMIN_LOGIN || "admin";
  const adminPassword = process.env.ADMIN_PASSWORD || "admin12345";

  if (username !== adminLogin || password !== adminPassword) {
    return response.unauthorized(res, "Login yoki parol noto'g'ri");
  }

  const secret = process.env.JWT_SECRET_KEY;
  if (!secret) {
    return response.serverError(res, "JWT_SECRET_KEY topilmadi");
  }

  const token = jwt.sign({ role: "admin", username }, secret, {
    expiresIn: "12h",
  });
  return response.success(res, "Admin login muvaffaqiyatli", {
    token,
    username,
  });
};

const getPlans = async (_, res) => {
  try {
    // await ensureDefaultPlans();
    const plans = await Plan.find().sort({ category: 1, amount: 1 }).lean();
    return response.success(res, "Plans", plans);
  } catch (error) {
    return response.serverError(
      res,
      "Planlarni olishda xatolik",
      error.message,
    );
  }
};

const createPlan = async (req, res) => {
  try {
    const payload = req.validated;
    const exists = await Plan.findOne({
      category: payload.category,
      code: payload.code,
    }).lean();
    if (exists)
      return response.error(res, "Bu category+code allaqachon mavjud");

    const plan = await Plan.create(payload);
    return response.created(res, "Yangi plan qo'shildi", plan);
  } catch (error) {
    return response.serverError(res, "Plan qo'shishda xatolik", error.message);
  }
};

const updatePlan = async (req, res) => {
  try {
    const { id } = req.params;
    const payload = req.validated;

    const updated = await Plan.findByIdAndUpdate(id, payload, {
      new: true,
      runValidators: true,
    }).lean();

    if (!updated) return response.notFound(res, "Plan topilmadi");
    return response.success(res, "Plan yangilandi", updated);
  } catch (error) {
    return response.serverError(res, "Plan yangilashda xatolik", error.message);
  }
};

const deletePlan = async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await Plan.findByIdAndDelete(id).lean();
    if (!deleted) return response.notFound(res, "Plan topilmadi");
    return response.success(res, "Plan o'chirildi", deleted);
  } catch (error) {
    return response.serverError(res, "Plan o'chirishda xatolik", error.message);
  }
};

module.exports = {
  login,
  getPlans,
  createPlan,
  updatePlan,
  deletePlan,
};
