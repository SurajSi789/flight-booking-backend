const mongoose = require("mongoose");
const winston = require("winston");
const { env } = require("./env");

// Verbose logs only in local development; on stage/production log errors only.
// Override with LOG_LEVEL (e.g. LOG_LEVEL=silent to mute entirely).
const logLevel = process.env.LOG_LEVEL || (env.nodeEnv === "development" ? "info" : "error");
const logger = winston.createLogger({
  level: logLevel === "silent" ? "error" : logLevel,
  silent: logLevel === "silent",
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [new winston.transports.Console()]
});

const connectDB = async () => {
  await mongoose.connect(env.mongoUri, {
    autoIndex: false,
    serverSelectionTimeoutMS: 10000
  });
  logger.info("MongoDB connected");
  return mongoose.connection;
};

const disconnectDB = async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.close(false);
    logger.info("MongoDB disconnected");
  }
};

module.exports = {
  connectDB,
  disconnectDB,
  logger
};
