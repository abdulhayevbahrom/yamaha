const response = require("../utils/response");
const { getBotStatus } = require("../services/settings.service");

module.exports = async (req, res, next) => {
  try {
    const botStatus = await getBotStatus();
    if (botStatus?.enabled) {
      return next();
    }

    return response.error(
      res,
      "Hozirda bot ish faoliyatida emas. Birozdan keyin qayta urinib ko'ring.",
      { code: "BOT_DISABLED" },
    );
  } catch (error) {
    return response.serverError(
      res,
      "Bot holatini tekshirishda xatolik",
      error?.message || "unknown_error",
    );
  }
};
