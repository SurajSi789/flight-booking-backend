const winston = require("winston");

const requestLoggerInstance = winston.createLogger({
  level: "info",
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
