const express = require("express");
const { body, param, query } = require("express-validator");
const adminController = require("../controllers/adminController");
const asyncHandler = require("../utils/asyncHandler");
const authenticate = require("../middleware/authenticate");
const adminOnly = require("../middleware/adminOnly");
const validate = require("../middleware/validate");

const router = express.Router();

router.use(authenticate, adminOnly);

router.get("/stats", asyncHandler(adminController.getStats));

router.get("/bookings", asyncHandler(adminController.getAdminBookings));
router.get(
  "/bookings/:bookingRef",
  validate([param("bookingRef").isString().notEmpty()]),
  asyncHandler(adminController.getAdminBookingByRef)
);
router.patch(
  "/bookings/:bookingRef",
  validate([
    param("bookingRef").isString().notEmpty(),
    body("status").optional().isIn(["initiated", "confirmed", "cancelled", "no_show"]),
    body("reason").optional().isString()
  ]),
  asyncHandler(adminController.patchAdminBooking)
);
router.post(
  "/bookings/:bookingRef/refund",
  validate([
    param("bookingRef").isString().notEmpty(),
    body("amount").isFloat({ gt: 0 }),
    body("reason").optional().isString()
  ]),
  asyncHandler(adminController.adminBookingRefund)
);

router.get("/users", asyncHandler(adminController.getAdminUsers));
router.get(
  "/users/:userId",
  validate([param("userId").isMongoId()]),
  asyncHandler(adminController.getAdminUserById)
);
router.patch(
  "/users/:userId",
  validate([
    param("userId").isMongoId(),
    body("isActive").optional().isBoolean(),
    body("walletBalance").optional().isFloat({ min: 0 }),
    body("role").optional().isIn(["user", "admin"])
  ]),
  asyncHandler(adminController.patchAdminUser)
);

router.get("/coupons", asyncHandler(adminController.getAdminCoupons));
router.post(
  "/coupons",
  validate([
    body("code").isString().notEmpty(),
    body("discountType").isIn(["percent", "flat"]),
    body("discountValue").isFloat({ gt: 0 }),
    body("usageLimit").isInt({ min: 1 }),
    body("validFrom").isISO8601(),
    body("validTo").isISO8601()
  ]),
  asyncHandler(adminController.createAdminCoupon)
);
router.patch(
  "/coupons/:id",
  validate([param("id").isMongoId()]),
  asyncHandler(adminController.patchAdminCoupon)
);
router.delete(
  "/coupons/:id",
  validate([param("id").isMongoId()]),
  asyncHandler(adminController.deleteAdminCoupon)
);

router.get("/offers", asyncHandler(adminController.getAdminOffers));
router.post(
  "/offers",
  validate([body("title").isString().notEmpty(), body("description").isString().notEmpty()]),
  asyncHandler(adminController.createAdminOffer)
);
router.patch("/offers/:id", validate([param("id").isMongoId()]), asyncHandler(adminController.patchAdminOffer));
router.delete("/offers/:id", validate([param("id").isMongoId()]), asyncHandler(adminController.deleteAdminOffer));
router.post(
  "/offers/reorder",
  validate([body().isArray({ min: 1 }), body("*.id").isMongoId(), body("*.displayOrder").isNumeric()]),
  asyncHandler(adminController.reorderOffers)
);

router.post(
  "/notifications/broadcast",
  validate([
    body("title").isString().notEmpty(),
    body("body").isString().notEmpty(),
    body("type").isIn(["email", "push", "sms", "in_app"])
  ]),
  asyncHandler(adminController.broadcastNotifications)
);
router.post(
  "/notifications/user/:userId",
  validate([
    param("userId").isMongoId(),
    body("title").isString().notEmpty(),
    body("body").isString().notEmpty(),
    body("type").isIn(["email", "push", "sms", "in_app"])
  ]),
  asyncHandler(adminController.sendNotificationToUser)
);
router.get("/notifications", asyncHandler(adminController.getAdminNotifications));

router.get("/refunds/pending", asyncHandler(adminController.getPendingRefunds));
router.post(
  "/refunds/:bookingRef/approve",
  validate([param("bookingRef").isString().notEmpty()]),
  asyncHandler(adminController.approveRefund)
);

router.get(
  "/reports/bookings",
  validate([query("format").optional().isIn(["json", "csv"])]),
  asyncHandler(adminController.bookingsReport)
);
router.get(
  "/reports/revenue",
  validate([query("groupBy").optional().isIn(["day", "week", "month", "provider"])]),
  asyncHandler(adminController.revenueReport)
);

module.exports = router;
