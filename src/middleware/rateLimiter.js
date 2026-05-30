const rateLimit = require("express-rate-limit");

const buildRateLimiter = ({ windowMs = 60 * 1000, max = 60, message = "Too many requests" } = {}) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      success: false,
      message
    }
  });

module.exports = buildRateLimiter;
