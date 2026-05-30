const express = require("express");
const { body, param } = require("express-validator");
const bookingController = require("../controllers/bookingController");
const asyncHandler = require("../utils/asyncHandler");
const validate = require("../middleware/validate");
const authenticate = require("../middleware/authenticate");

const router = express.Router();

router.use(authenticate);

router.post(
  "/initiate",
  validate([
    body("flightId").isString().notEmpty(),
    body("provider").isString().notEmpty(),
    body("passengers").isArray({ min: 1 }),
    body("couponCode").optional().isString(),
    body("useWallet").optional().isBoolean(),
    body("walletAmount").optional().isFloat({ min: 0 }),
    body("ancillaries").optional().isObject(),
    body("fareIntent").optional().isIn(["leisure", "group"])
  ]),
  asyncHandler(bookingController.initiateBooking)
);

router.post(
  "/:bookingId/confirm",
  validate([
    param("bookingId").isMongoId(),
    body("razorpayOrderId").isString().notEmpty(),
    body("razorpayPaymentId").isString().notEmpty(),
    body("razorpaySignature").isString().notEmpty()
  ]),
  asyncHandler(bookingController.confirmBooking)
);

router.get("/my", asyncHandler(bookingController.getMyBookings));
router.get("/:bookingRef", validate([param("bookingRef").isString().notEmpty()]), asyncHandler(bookingController.getBookingByRef));
router.post(
  "/:bookingRef/cancel",
  validate([param("bookingRef").isString().notEmpty(), body("reason").optional().isString(), body("useWallet").optional().isBoolean()]),
  asyncHandler(bookingController.cancelBooking)
);
router.get("/:bookingRef/ticket", validate([param("bookingRef").isString().notEmpty()]), asyncHandler(bookingController.getTicket));

module.exports = router;
