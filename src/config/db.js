const mongoose = require("mongoose");
const winston = require("winston");
const { env } = require("./env");

const logger = winston.createLogger({
  level: "info",
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
