const express = require("express");
const { body } = require("express-validator");
const authController = require("../controllers/authController");
const asyncHandler = require("../utils/asyncHandler");
const validate = require("../middleware/validate");
const buildRateLimiter = require("../middleware/rateLimiter");

const router = express.Router();

// Credential / code-guessing endpoints — strict cap to blunt brute-force.
const credentialLimiter = buildRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "Too many attempts. Please try again in a few minutes."
});

// Endpoints that trigger an outbound email — throttle to prevent inbox bombing
// and email-quota abuse. (resend-otp additionally has a per-user Redis cap.)
const emailLimiter = buildRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: "Too many requests. Please try again later."
});

// Token refresh — moderate cap; legitimate clients refresh at most every ~15 min.
const refreshLimiter = buildRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 60,
  message: "Too many refresh attempts. Please try again later."
});

// Small blocklist of the most abused passwords that still satisfy the length +
// uppercase + digit rules (e.g. "Password1"). Cheap defense against the weakest
// choices; a full breach-corpus check (e.g. HIBP k-anonymity) is a later step.
const COMMON_PASSWORDS = new Set([
  "password1", "password123", "password1!", "qwerty123", "welcome1", "welcome123",
  "admin123", "iloveyou1", "abc12345", "letmein1", "monkey123", "football1"
]);
const notCommonPassword = (value) => {
  if (COMMON_PASSWORDS.has(String(value).toLowerCase())) {
    throw new Error("This password is too common. Please choose a stronger one.");
  }
  return true;
};

router.post(
  "/register",
  emailLimiter,
  validate([
    body("name.first").isString().trim().isLength({ min: 1 }),
    body("name.last").isString().trim().isLength({ min: 1 }),
    body("email").isEmail(),
    body("phone").isString().trim().isLength({ min: 6, max: 20 }),
    body("password")
      .isString()
      .isLength({ min: 8 })
      .matches(/^(?=.*[A-Z])(?=.*\d).+$/)
      .withMessage("Password must contain at least one uppercase letter and one number")
      .custom(notCommonPassword)
  ]),
  asyncHandler(authController.register)
);

router.post(
  "/verify-otp",
  credentialLimiter,
  validate([body("userId").isMongoId(), body("otp").isString().matches(/^\d{6}$/)]),
  asyncHandler(authController.verifyOtp)
);

router.post(
  "/verify-email",
  credentialLimiter,
  validate([body("token").isString().isLength({ min: 20 })]),
  asyncHandler(authController.verifyEmail)
);

router.post(
  "/login",
  credentialLimiter,
  validate([
    body("loginType").optional().isIn(["user", "corporate"]),
    body("email").if(body("loginType").not().equals("corporate")).isEmail(),
    body("employeeId").if(body("loginType").equals("corporate")).isString().notEmpty(),
    body("password").isString().notEmpty(),
  ]),
  asyncHandler(authController.login)
);

router.post("/refresh", refreshLimiter, asyncHandler(authController.refresh));
router.post("/logout", asyncHandler(authController.logout));
router.post(
  "/resend-otp",
  emailLimiter,
  validate([body("userId").isMongoId()]),
  asyncHandler(authController.resendOtp)
);
router.post("/forgot-password", emailLimiter, validate([body("email").isEmail()]), asyncHandler(authController.forgotPassword));
router.post(
  "/reset-password",
  credentialLimiter,
  validate([
    body("token").isString().isLength({ min: 20 }),
    body("newPassword")
      .isString()
      .isLength({ min: 8 })
      .matches(/^(?=.*[A-Z])(?=.*\d).+$/)
      .withMessage("Password must contain at least one uppercase letter and one number")
      .custom(notCommonPassword)
  ]),
  asyncHandler(authController.resetPassword)
);

module.exports = router;
