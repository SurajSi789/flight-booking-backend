const express = require("express");
const { body } = require("express-validator");
const authController = require("../controllers/authController");
const asyncHandler = require("../utils/asyncHandler");
const validate = require("../middleware/validate");

const router = express.Router();

router.post(
  "/register",
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
  ]),
  asyncHandler(authController.register)
);

router.post(
  "/verify-otp",
  validate([body("userId").isMongoId(), body("otp").isString().matches(/^\d{6}$/)]),
  asyncHandler(authController.verifyOtp)
);

router.post(
  "/login",
  validate([
    body("loginType").optional().isIn(["user", "corporate"]),
    body("email").if(body("loginType").not().equals("corporate")).isEmail(),
    body("employeeId").if(body("loginType").equals("corporate")).isString().notEmpty(),
    body("password").isString().notEmpty(),
  ]),
  asyncHandler(authController.login)
);

router.post("/refresh", asyncHandler(authController.refresh));
router.post("/logout", asyncHandler(authController.logout));
router.post(
  "/resend-otp",
  validate([body("userId").isMongoId()]),
  asyncHandler(authController.resendOtp)
);
router.post("/forgot-password", validate([body("email").isEmail()]), asyncHandler(authController.forgotPassword));
router.post(
  "/reset-password",
  validate([
    body("token").isString().isLength({ min: 20 }),
    body("newPassword")
      .isString()
      .isLength({ min: 8 })
      .matches(/^(?=.*[A-Z])(?=.*\d).+$/)
      .withMessage("Password must contain at least one uppercase letter and one number")
  ]),
  asyncHandler(authController.resetPassword)
);

module.exports = router;
