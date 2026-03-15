const jwt = require("jsonwebtoken");
const response = require("../utils/response");

module.exports = (req, res, next) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) return response.unauthorized(res, "Token topilmadi");

  try {
    const secret = process.env.JWT_SECRET_KEY;
    if (!secret) return response.serverError(res, "JWT_SECRET_KEY topilmadi");
    const payload = jwt.verify(token, secret);
    if (payload.role !== "admin") return response.forbidden(res, "Faqat admin");
    req.admin = payload;
    next();
  } catch (error) {
    return response.unauthorized(res, "Token yaroqsiz yoki muddati tugagan");
  }
};
