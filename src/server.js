const http = require("http");
const app = require("./app");
const { env } = require("./config/env");
const { connectDB, disconnectDB, logger } = require("./config/db");
const { connectRedis, disconnectRedis } = require("./config/redis");

require("./jobs/emailJob");
require("./jobs/notificationJob");
require("./jobs/refundJob");
require("./jobs/fareAlertJob");

const server = http.createServer(app);

let isShuttingDown = false;

const shutdown = async (signal) => {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;

  logger.info(`Received ${signal}. Starting graceful shutdown.`);
  server.close(async () => {
    try {
      await Promise.all([disconnectDB(), disconnectRedis()]);
      logger.info("Graceful shutdown completed.");
      process.exit(0);
    } catch (error) {
      logger.error("Error during shutdown", { error: error.message });
      process.exit(1);
    }
  });
};

const bootstrap = async () => {
  await connectDB();
  await connectRedis();

  server.listen(env.port, () => {
    logger.info("Server started", {
      port: env.port,
      environment: env.nodeEnv,
      mongoState: "connected",
      redisState: "connected"
    });
  });
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

bootstrap().catch((error) => {
  logger.error("Startup failed", { error: error.message, stack: error.stack });
  process.exit(1);
});
