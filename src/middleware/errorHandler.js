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

  const statusCode = error.statusCode || 500;
  // Don't leak internal error detail (stack traces, driver/Mongo messages) to
  // clients on server errors. 4xx messages are intentional and safe to surface.
  const message = statusCode >= 500 ? "Internal Server Error" : error.message || "Request failed";

  return res.status(statusCode).json({
    success: false,
    message
  });
};

module.exports = errorHandler;
