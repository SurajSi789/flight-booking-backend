const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const cookieParser = require("cookie-parser");
const morgan = require("morgan");
const winston = require("winston");
const { env } = require("./config/env");
const mongoose = require("mongoose");
const errorHandler = require("./middleware/errorHandler");
const requestLogger = require("./middleware/requestLogger");
const { createRedisClient } = require("./config/redis");

const authRoutes = require("./routes/auth");
const flightRoutes = require("./routes/flights");
const bookingRoutes = require("./routes/bookings");
const paymentRoutes = require("./routes/payments");
const couponRoutes = require("./routes/coupons");
const catalogRoutes = require("./routes/catalog");
const userRoutes = require("./routes/users");
const adminAuthRoutes = require("./routes/adminAuth");
const adminRoutes = require("./routes/admin");
const chatRoutes = require("./routes/chat");
const notificationRoutes = require("./routes/notifications");
const fareAlertRoutes = require("./routes/fareAlerts");

const app = express();

// Trust Render's reverse proxy so express-rate-limit can read the real client IP
// from X-Forwarded-For instead of seeing the internal proxy address.
app.set("trust proxy", 1);

const morganLogger = winston.createLogger({
  level: "info",
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [new winston.transports.Console()]
});

app.use(helmet());
const allowedOrigins = new Set([
  ...env.corsWhitelist,
  ...(env.adminCorsOrigin ? [env.adminCorsOrigin] : []),
]);

app.use(
  cors({
    origin(origin, callback) {
      // No Origin header → non-browser client (curl, mobile, server-to-server). Allow.
      if (!origin) {
        return callback(null, true);
      }
      if (allowedOrigins.has(origin)) {
        return callback(null, true);
      }
      // Fail CLOSED: an unconfigured whitelist must not reflect arbitrary origins
      // with credentials. Only relax this for local development convenience.
      if (env.nodeEnv !== "production" && allowedOrigins.size === 0) {
        return callback(null, true);
      }
      return callback(new Error("CORS not allowed"));
    },
    credentials: true,
  })
);
app.use(compression());
app.use(
  express.json({
    limit: "10mb",
    verify: (req, res, buf) => {
      if (req.originalUrl === "/api/v1/payments/webhook") {
        req.rawBody = buf.toString();
      }
    }
  })
);
app.use(cookieParser());
app.use(
  morgan("combined", {
    stream: {
      write: (message) => morganLogger.info(message.trim())
    }
  })
);
app.use(requestLogger);

app.get("/health", async (req, res) => {
  const checks = { mongo: false, redis: false };
  try {
    checks.mongo = mongoose.connection.readyState === 1;
    await createRedisClient().ping();
    checks.redis = true;
  } catch {
    // check flags remain false
  }
  const healthy = checks.mongo && checks.redis;
  return res.status(healthy ? 200 : 503).json({
    success: healthy,
    message: healthy ? "Healthy" : "Degraded",
    checks
  });
});

app.use("/api/v1/auth", authRoutes);
app.use("/api/v1/flights", flightRoutes);
app.use("/api/v1/bookings", bookingRoutes);
app.use("/api/v1/payments", paymentRoutes);
app.use("/api/v1/coupons", couponRoutes);
app.use("/api/v1/catalog", catalogRoutes);
app.use("/api/v1/users", userRoutes);
// Admin auth (login/logout/MFA) mounted first — these routes are public (no token required for /login)
app.use("/api/v1/admin/auth", adminAuthRoutes);
// All other admin routes require a valid admin JWT (enforced inside adminRoutes)
app.use("/api/v1/admin", adminRoutes);
app.use("/api/v1/chat", chatRoutes);
app.use("/api/v1/notifications", notificationRoutes);
app.use("/api/v1/fare-alerts", fareAlertRoutes);

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.originalUrl}`
  });
});

app.use(errorHandler);

module.exports = app;
