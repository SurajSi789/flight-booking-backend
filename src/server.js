// Bull creates one Redis bclient per queue, each adding error listeners to ioredis's
// internal Commander emitter. 5 queues exceeds Node's default limit of 10.
require("events").EventEmitter.defaultMaxListeners = 25;

const http = require("http");
const app = require("./app");
const { env } = require("./config/env");
const { connectDB, disconnectDB, logger } = require("./config/db");
const { connectRedis, disconnectRedis } = require("./config/redis");
const User = require("./models/User");

require("./jobs/emailJob");
require("./jobs/notificationJob");
require("./jobs/refundJob");
require("./jobs/fareAlertJob");
require("./jobs/whatsappJob");

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

  // autoIndex is off, so ensure the User TTL index (auto-purge of abandoned
  // unverified signups) exists. Non-fatal — a failure here shouldn't block boot.
  try {
    await User.ensureUserIndexes();
  } catch (error) {
    logger.warn("Failed to ensure User indexes", { error: error.message });
  }

  // Bind the HTTP port first so Render/health-checks see the server immediately.
  // Redis connects in the background — ioredis retries automatically.
  await new Promise((resolve, reject) => {
    server.listen(env.port, () => {
      logger.info("Server started", { port: env.port, environment: env.nodeEnv });
      resolve();
    });
    server.once("error", reject);
  });

  connectRedis().catch((err) =>
    logger.error("Redis initial connection failed, retrying in background", { error: err.message })
  );
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ioredis throws MaxRetriesPerRequestError as an uncaught exception when a
// Bull bclient drops while commands are queued. Catch it so the process
// doesn't crash — ioredis reconnects automatically.
process.on("uncaughtException", (err) => {
  if (err.name === "MaxRetriesPerRequestError") {
    logger.warn("Redis command timed out during reconnect, will retry", { error: err.message });
    return;
  }
  logger.error("Uncaught exception", { error: err.message, stack: err.stack });
  process.exit(1);
});

bootstrap().catch((error) => {
  logger.error("Startup failed", { error: error.message, stack: error.stack });
  process.exit(1);
});
