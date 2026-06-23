const Redis = require("ioredis");
const { env } = require("./env");
const { logger } = require("./db");

let redisClient;
let bullSubscriber; // shared subscriber connection for Bull queues

const createRedisClient = () => {
  if (redisClient) return redisClient;

  redisClient = new Redis(env.redisUrl, {
    maxRetriesPerRequest: null,
    retryStrategy(times) {
      const delay = Math.min(times * 200, 5000);
      logger.warn(`Redis reconnect attempt=${times} delay=${delay}ms`);
      return delay;
    }
  });

  redisClient.on("connect",      () => logger.info("Redis connected"));
  redisClient.on("error",   (err) => logger.error("Redis error", { error: err.message }));
  redisClient.on("reconnecting", () => logger.warn("Redis reconnecting"));
  redisClient.on("end",          () => logger.warn("Redis connection closed"));

  return redisClient;
};

const connectRedis = async () => {
  const client = createRedisClient();
  // Don't await ping — ioredis reconnects automatically in the background.
  // Blocking here prevents the HTTP server from starting if Redis is slow.
  return client;
};

const disconnectRedis = async () => {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
    logger.info("Redis disconnected");
  }
  if (bullSubscriber) {
    await bullSubscriber.quit();
    bullSubscriber = null;
  }
};

/**
 * Bull queue options that share the singleton client + one subscriber across ALL queues.
 * Each queue still gets its own bclient duplicate (required for blocking commands).
 * Without sharing, Bull creates 3 connections per queue — with 6+ queues this exhausts
 * the Upstash free-tier limit of 20 connections.
 */
// Bull requires enableReadyCheck: false and maxRetriesPerRequest: null on subscriber/bclient.
const BULL_CONN_OPTS = { enableReadyCheck: false, maxRetriesPerRequest: null };

const getBullQueueOptions = () => {
  const client = createRedisClient();

  if (!bullSubscriber) {
    bullSubscriber = client.duplicate(BULL_CONN_OPTS);
    bullSubscriber.on("error", (err) => logger.error("Bull subscriber error", { error: err.message }));
  }

  return {
    createClient(type) {
      switch (type) {
        case "client":     return client;
        case "subscriber": return bullSubscriber;
        case "bclient":    return client.duplicate(BULL_CONN_OPTS);
        default:           throw new Error(`Unknown Bull connection type: ${type}`);
      }
    }
  };
};

// Legacy alias kept for backward compat — callers that only need the URL still work
const getQueueRedisConfig = () => ({ redis: env.redisUrl });

module.exports = {
  createRedisClient,
  connectRedis,
  disconnectRedis,
  getBullQueueOptions,
  getQueueRedisConfig,
};
