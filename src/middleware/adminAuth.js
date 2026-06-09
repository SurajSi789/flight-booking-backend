const jwt = require("jsonwebtoken");
const { createRedisClient } = require("../config/redis");
const { env } = require("../config/env");
const { ROLE_PERMISSIONS } = require("../models/AdminUser");

const redis = createRedisClient();

const authenticate = async (req, res, next) => {
  const [scheme, token] = (req.headers.authorization || "").split(" ");
  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({ success: false, message: "Admin token required" });
  }

  try {
    const decoded = jwt.verify(token, env.adminJwtSecret);

    // Type guard — customer tokens (issued with jwtAccessSecret) cannot pass here
    // even if someone tried to replay them, because the secret is different
    if (decoded.tokenType !== "admin_access") {
      return res.status(401).json({ success: false, message: "Invalid token type" });
    }

    // Check blacklist (logout/forced invalidation)
    const blacklisted = await redis.get(`admin_blacklist:${decoded.jti}`);
    if (blacklisted) {
      return res.status(401).json({ success: false, message: "Session has been revoked" });
    }

    req.adminUser = {
      id:        decoded.adminId,
      email:     decoded.email,
      adminRole: decoded.adminRole,
      jti:       decoded.jti,
    };
    return next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ success: false, message: "Admin session expired" });
    }
    return res.status(401).json({ success: false, message: "Invalid admin token" });
  }
};

// Factory middleware: requirePermission("refunds:approve")
const requirePermission = (permission) => (req, res, next) => {
  const { adminRole } = req.adminUser;
  const perms = ROLE_PERMISSIONS[adminRole] || [];
  if (!perms.includes("*") && !perms.includes(permission)) {
    return res.status(403).json({
      success: false,
      message: `Forbidden: '${permission}' permission required`,
    });
  }
  return next();
};

module.exports = { authenticate, requirePermission };
