const response = require("../utils/response");
const Plan = require("../model/plan.model");
// const { ensureDefaultPlans } = require("../services/plan.service");

const categoryNames = {
  star: "Telegram Star",
  premium: "Telegram Premium",
  uc: "PUBG UC",
};

function mapCatalog(plans) {
  const grouped = {
    star: { name: categoryNames.star, plans: [] },
    premium: { name: categoryNames.premium, plans: [] },
    uc: { name: categoryNames.uc, plans: [] },
  };

  plans.forEach((plan) => {
    grouped[plan.category].plans.push({
      code: plan.code,
      label: plan.label,
      amount: plan.amount,
      basePrice: plan.basePrice,
      currency: plan.currency,
      isActive: plan.isActive,
    });
  });

  return grouped;
}

const health = async (_, res) => response.success(res, "API ishlayapti");

const getCatalog = async (_, res) => {
  try {
    // await ensureDefaultPlans();
    const plans = await Plan.find({ isActive: true }).lean();
    return response.success(res, "Catalog", mapCatalog(plans));
  } catch (error) {
    return response.serverError(res, "Catalog olishda xatolik", error.message);
  }
};

const lookupProfile = async (req, res) => {
  const { username } = req.query;
  if (!username) return response.error(res, "username required");

  const cleaned = String(username).replace("@", "").trim();

  try {
    const url = `${process.env.API_BASE}/star/recipient/search?username=${encodeURIComponent(
      cleaned,
    )}&quantity=50`;
    const headers = { "API-Key": process.env.API_KEY };
    const external = await fetch(url, { headers });
    const data = await external.json();
    const profileName = data?.name;

    if (!profileName) return response.error(res, "Profil topilmadi");
    return response.success(res, "Profile topildi", {
      username: cleaned,
      profileName,
    });
  } catch (error) {
    return response.serverError(
      res,
      "Profil qidirishda xatolik",
      error.message,
    );
  }
};

module.exports = {
  health,
  getCatalog,
  lookupProfile,
};
