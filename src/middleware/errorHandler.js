const { logger } = require("../config/db");

const errorHandler = (error, req, res, next) => {
  logger.error("Unhandled error", {
    message: error.message,
    stack: error.stack,
    path: req.originalUrl
  });

  if (res.headersSent) {
    return next(error);
  }

  return res.status(error.statusCode || 500).json({
    success: false,
    message: error.message || "Internal Server Error"
  });
};

module.exports = errorHandler;
