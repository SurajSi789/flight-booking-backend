const express = require("express");
const { body, param } = require("express-validator");
const jwt = require("jsonwebtoken");
const chatController = require("../controllers/chatController");
const asyncHandler = require("../utils/asyncHandler");
const validate = require("../middleware/validate");
const { env } = require("../config/env");
const { createRedisClient } = require("../config/redis");

const router = express.Router();
const redis = createRedisClient();

const optionalAuthenticate = async (req, res, next) => {
  const authHeader = req.headers.authorization || "";
  const [scheme, token] = authHeader.split(" ");
  if (!token || scheme !== "Bearer") {
    return next();
  }
  try {
    const decoded = jwt.verify(token, env.jwtAccessSecret);
    if (decoded.jti) {
      const blacklisted = await redis.get(`blacklist:${decoded.jti}`);
      if (blacklisted) {
        return res.status(401).json({ success: false, message: "Token revoked" });
      }
    }
    req.user = {
      userId: decoded.userId,
      role: decoded.role,
      email: decoded.email,
      jti: decoded.jti
    };
    return next();
  } catch (error) {
    return res.status(401).json({ success: false, message: "Invalid access token" });
  }
};

router.post(
  "/message",
  optionalAuthenticate,
  validate([body("sessionId").optional({ nullable: true }).isString(), body("message").isString().isLength({ min: 1 })]),
  asyncHandler(chatController.sendMessage)
);
router.get(
  "/session/:sessionId",
  optionalAuthenticate,
  validate([param("sessionId").isString().notEmpty()]),
  asyncHandler(chatController.getSession)
);
router.delete(
  "/session/:sessionId",
  optionalAuthenticate,
  validate([param("sessionId").isString().notEmpty()]),
  asyncHandler(chatController.deleteSession)
);

module.exports = router;
