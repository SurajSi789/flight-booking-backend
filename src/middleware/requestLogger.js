const winston = require("winston");
const { env } = require("../config/env");

// Per-request logs: local development only (silent on stage/production).
const requestLoggerInstance = winston.createLogger({
  level: "info",
  silent: env.nodeEnv !== "development" && process.env.LOG_LEVEL !== "info",
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [new winston.transports.Console()]
});

const requestLogger = (req, res, next) => {
  const startedAt = Date.now();
  res.on("finish", () => {
    requestLoggerInstance.info("HTTP request", {
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt
    });
  });
  next();
};

module.exports = requestLogger;
