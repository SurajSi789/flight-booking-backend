const express = require("express");
const { body } = require("express-validator");
const couponController = require("../controllers/couponController");
const authenticate = require("../middleware/authenticate");
const validate = require("../middleware/validate");
const asyncHandler = require("../utils/asyncHandler");

const router = express.Router();

router.post(
  "/validate",
  authenticate,
  validate([
    body("code").isString().notEmpty(),
    body("totalFare").isFloat({ gt: 0 }),
    body("provider").isString().notEmpty(),
    body("route.origin").isString().isLength({ min: 3, max: 3 }),
    body("route.destination").isString().isLength({ min: 3, max: 3 })
  ]),
  asyncHandler(couponController.validateCoupon)
);

module.exports = router;
