const Redis = require("ioredis");
const { env } = require("./env");
const { logger } = require("./db");

let redisClient;

const createRedisClient = () => {
  if (redisClient) {
    return redisClient;
  }

  redisClient = new Redis(env.redisUrl, {
    maxRetriesPerRequest: null,
    retryStrategy(times) {
      const delay = Math.min(times * 200, 5000);
      logger.warn(`Redis reconnect attempt=${times} delay=${delay}ms`);
      return delay;
    }
  });

  redisClient.on("connect", () => logger.info("Redis connected"));
  redisClient.on("error", (error) => logger.error("Redis error", { error: error.message }));
  redisClient.on("reconnecting", () => logger.warn("Redis reconnecting"));
  redisClient.on("end", () => logger.warn("Redis connection closed"));

  return redisClient;
};

const connectRedis = async () => {
  const client = createRedisClient();
  if (client.status !== "ready") {
    await client.ping();
  }
  return client;
};

const disconnectRedis = async () => {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
    logger.info("Redis disconnected");
  }
};

const getQueueRedisConfig = () => ({
  redis: env.redisUrl
});

module.exports = {
  createRedisClient,
  connectRedis,
  disconnectRedis,
  getQueueRedisConfig
};
