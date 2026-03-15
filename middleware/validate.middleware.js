const response = require("../utils/response");

module.exports = (validator) => (req, res, next) => {
  try {
    req.validated = validator(req);
    next();
  } catch (error) {
    return response.error(res, error.message || "Validation error");
  }
};
