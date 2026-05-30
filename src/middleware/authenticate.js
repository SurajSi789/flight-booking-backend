const jwt = require("jsonwebtoken");
const { createRedisClient } = require("../config/redis");
const { env } = require("../config/env");

const redis = createRedisClient();

const authenticate = async (req, res, next) => {
  const authHeader = req.headers.authorization || "";
  const [scheme, token] = authHeader.split(" ");
  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({ success: false, message: "Missing Bearer token" });
  }

  try {
    const decoded = jwt.verify(token, env.jwtAccessSecret);
    if (!decoded.jti) {
      return res.status(401).json({ success: false, message: "Invalid access token" });
    }

    const blacklisted = await redis.get(`blacklist:${decoded.jti}`);
    if (blacklisted) {
      return res.status(401).json({ success: false, message: "Token has been revoked" });
    }

    req.user = {
      id: decoded.userId,
      userId: decoded.userId,
      role: decoded.role,
      email: decoded.email,
      jti: decoded.jti
    };
    return next();
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({ success: false, message: "Access token expired" });
    }
    return res.status(401).json({ success: false, message: "Invalid access token" });
  }
};

module.exports = authenticate;
