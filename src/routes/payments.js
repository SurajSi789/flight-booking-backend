const express = require("express");
const { body } = require("express-validator");
const paymentController = require("../controllers/paymentController");
const asyncHandler = require("../utils/asyncHandler");
const validate = require("../middleware/validate");
const authenticate = require("../middleware/authenticate");
const adminOnly = require("../middleware/adminOnly");

const router = express.Router();

router.post(
  "/create-order",
  authenticate,
  validate([body("bookingId").isMongoId()]),
  asyncHandler(paymentController.createOrder)
);

router.post("/webhook", asyncHandler(paymentController.webhook));
router.post(
  "/refund",
  authenticate,
  adminOnly,
  validate([
    body("bookingRef").isString().notEmpty(),
    body("amount").isFloat({ gt: 0 }),
    body("reason").optional().isString()
  ]),
  asyncHandler(paymentController.refund)
);
router.get("/wallet", authenticate, asyncHandler(paymentController.wallet));

module.exports = router;
