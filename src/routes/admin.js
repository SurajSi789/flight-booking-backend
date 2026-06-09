const express = require("express");
const { body, param, query } = require("express-validator");
const adminController = require("../controllers/adminController");
const asyncHandler = require("../utils/asyncHandler");
const { authenticate, requirePermission } = require("../middleware/adminAuth");
const validate = require("../middleware/validate");

const router = express.Router();

// All admin routes require a valid admin JWT
router.use(authenticate);

// ── Dashboard ────────────────────────────────────────────────────────────────
router.get("/stats",
  requirePermission("dashboard:read"),
  asyncHandler(adminController.getStats)
);

// ── Bookings ─────────────────────────────────────────────────────────────────
router.get("/bookings",
  requirePermission("bookings:read"),
  asyncHandler(adminController.getAdminBookings)
);
router.get(
  "/bookings/:bookingRef",
  requirePermission("bookings:read"),
  validate([param("bookingRef").isString().notEmpty()]),
  asyncHandler(adminController.getAdminBookingByRef)
);
router.patch(
  "/bookings/:bookingRef",
  requirePermission("bookings:write"),
  validate([
    param("bookingRef").isString().notEmpty(),
    body("status").optional().isIn(["initiated", "confirmed", "cancelled", "no_show"]),
    body("reason").optional().isString(),
  ]),
  asyncHandler(adminController.patchAdminBooking)
);
router.post(
  "/bookings/:bookingRef/refund",
  requirePermission("refunds:approve"),
  validate([
    param("bookingRef").isString().notEmpty(),
    body("amount").isFloat({ gt: 0 }),
    body("reason").optional().isString(),
  ]),
  asyncHandler(adminController.adminBookingRefund)
);

// ── Users ────────────────────────────────────────────────────────────────────
router.get("/users",
  requirePermission("users:read"),
  asyncHandler(adminController.getAdminUsers)
);
router.get(
  "/users/:userId",
  requirePermission("users:read"),
  validate([param("userId").isMongoId()]),
  asyncHandler(adminController.getAdminUserById)
);
router.patch(
  "/users/:userId",
  requirePermission("users:read"),   // ops_admin and above
  validate([
    param("userId").isMongoId(),
    body("isActive").optional().isBoolean(),
    body("walletBalance").optional().isFloat({ min: 0 }),
    body("role").optional().isIn(["user", "admin"]),
  ]),
  asyncHandler(adminController.patchAdminUser)
);

// ── Coupons ──────────────────────────────────────────────────────────────────
router.get("/coupons",
  requirePermission("coupons:read"),
  asyncHandler(adminController.getAdminCoupons)
);
router.post(
  "/coupons",
  requirePermission("coupons:write"),
  validate([
    body("code").isString().notEmpty(),
    body("discountType").isIn(["percent", "flat"]),
    body("discountValue").isFloat({ gt: 0 }),
    body("usageLimit").isInt({ min: 1 }),
    body("validFrom").isISO8601(),
    body("validTo").isISO8601(),
    body("offerType").optional().isIn(["general","bank_offer","airline_offer","cashback","first_booking","corporate","seasonal","wallet"]),
    body("bankCode").optional().isString(),
    body("airlineCode").optional().isString(),
    body("paymentMethod").optional().isIn(["any","credit_card","debit_card","net_banking","upi","wallet"]),
    body("tripType").optional().isIn(["any","one_way","round_trip"]),
    body("travelClass").optional().isIn(["any","economy","business","premium_economy"]),
    body("maxDiscount").optional().isFloat({ min: 0 }),
    body("minFare").optional().isFloat({ min: 0 }),
    body("firstBookingOnly").optional().isBoolean(),
    body("cashbackAmount").optional().isFloat({ min: 0 }),
    body("perUserLimit").optional().isInt({ min: 1 }),
    body("adminNotes").optional().isString(),
  ]),
  asyncHandler(adminController.createAdminCoupon)
);
router.patch(
  "/coupons/:id",
  requirePermission("coupons:write"),
  validate([param("id").isMongoId()]),
  asyncHandler(adminController.patchAdminCoupon)
);
router.delete(
  "/coupons/:id",
  requirePermission("coupons:write"),
  validate([param("id").isMongoId()]),
  asyncHandler(adminController.deleteAdminCoupon)
);

// ── Offers ───────────────────────────────────────────────────────────────────
router.get("/offers",
  requirePermission("offers:read"),
  asyncHandler(adminController.getAdminOffers)
);
router.post(
  "/offers",
  requirePermission("offers:write"),
  validate([body("title").isString().notEmpty(), body("description").isString().notEmpty()]),
  asyncHandler(adminController.createAdminOffer)
);
router.patch(
  "/offers/:id",
  requirePermission("offers:write"),
  validate([param("id").isMongoId()]),
  asyncHandler(adminController.patchAdminOffer)
);
router.delete(
  "/offers/:id",
  requirePermission("offers:write"),
  validate([param("id").isMongoId()]),
  asyncHandler(adminController.deleteAdminOffer)
);
router.post(
  "/offers/reorder",
  requirePermission("offers:write"),
  validate([body().isArray({ min: 1 }), body("*.id").isMongoId(), body("*.displayOrder").isNumeric()]),
  asyncHandler(adminController.reorderOffers)
);

// ── Notifications ─────────────────────────────────────────────────────────────
router.post(
  "/notifications/broadcast",
  requirePermission("notifications:write"),
  validate([
    body("title").isString().notEmpty(),
    body("body").isString().notEmpty(),
    body("type").isIn(["email", "push", "sms", "in_app"]),
  ]),
  asyncHandler(adminController.broadcastNotifications)
);
router.post(
  "/notifications/user/:userId",
  requirePermission("notifications:write"),
  validate([
    param("userId").isMongoId(),
    body("title").isString().notEmpty(),
    body("body").isString().notEmpty(),
    body("type").isIn(["email", "push", "sms", "in_app"]),
  ]),
  asyncHandler(adminController.sendNotificationToUser)
);
router.get("/notifications",
  requirePermission("notifications:write"),
  asyncHandler(adminController.getAdminNotifications)
);

// ── Refunds ───────────────────────────────────────────────────────────────────
router.get("/refunds/pending",
  requirePermission("refunds:read"),
  asyncHandler(adminController.getPendingRefunds)
);
router.post(
  "/refunds/:bookingRef/approve",
  requirePermission("refunds:approve"),
  validate([param("bookingRef").isString().notEmpty()]),
  asyncHandler(adminController.approveRefund)
);

// ── Reports ───────────────────────────────────────────────────────────────────
router.get(
  "/reports/bookings",
  requirePermission("reports:bookings"),
  validate([query("format").optional().isIn(["json", "csv"])]),
  asyncHandler(adminController.bookingsReport)
);
router.get(
  "/reports/revenue",
  requirePermission("reports:revenue"),
  validate([query("groupBy").optional().isIn(["day", "week", "month", "provider"])]),
  asyncHandler(adminController.revenueReport)
);

// ── Admin User Management (super_admin only) ──────────────────────────────────
router.get("/admin-users",
  requirePermission("*"),   // only super_admin has wildcard
  asyncHandler(async (req, res) => {
    const AdminUser = require("../models/AdminUser");
    const admins = await AdminUser.find().select("-__v").sort({ createdAt: -1 });
    return res.json({ success: true, data: admins });
  })
);
router.post(
  "/admin-users",
  requirePermission("*"),
  validate([
    body("name").isString().notEmpty(),
    body("email").isEmail().normalizeEmail(),
    body("password").isString().isLength({ min: 12 }),
    body("adminRole").isIn(["super_admin","ops_admin","finance","support","read_only"]),
  ]),
  asyncHandler(async (req, res) => {
    const AdminUser = require("../models/AdminUser");
    const { name, email, password, adminRole } = req.body;
    const existing = await AdminUser.findOne({ email });
    if (existing) {
      return res.status(409).json({ success: false, message: "Email already registered" });
    }
    const admin = await AdminUser.create({
      name,
      email,
      passwordHash: password,
      adminRole,
      createdBy: req.adminUser.id,
    });
    return res.status(201).json({
      success: true,
      data: { id: admin._id, name: admin.name, email: admin.email, adminRole: admin.adminRole },
    });
  })
);
router.patch(
  "/admin-users/:id",
  requirePermission("*"),
  validate([
    param("id").isMongoId(),
    body("isActive").optional().isBoolean(),
    body("adminRole").optional().isIn(["super_admin","ops_admin","finance","support","read_only"]),
  ]),
  asyncHandler(async (req, res) => {
    const AdminUser = require("../models/AdminUser");
    const admin = await AdminUser.findByIdAndUpdate(
      req.params.id,
      { $set: req.body },
      { new: true, runValidators: true }
    );
    if (!admin) return res.status(404).json({ success: false, message: "Admin not found" });
    return res.json({ success: true, data: admin });
  })
);

// ── Audit Log ─────────────────────────────────────────────────────────────────
router.get(
  "/audit-log",
  requirePermission("*"),
  validate([
    query("page").optional().isInt({ min: 1 }),
    query("limit").optional().isInt({ min: 1, max: 200 }),
    query("action").optional().isString(),
    query("actorId").optional().isMongoId(),
  ]),
  asyncHandler(async (req, res) => {
    const AuditLog = require("../models/AuditLog");
    const page  = Math.max(1, parseInt(req.query.page  || "1", 10));
    const limit = Math.min(200, parseInt(req.query.limit || "50", 10));
    const filter = {};
    if (req.query.action)  filter.action  = { $regex: req.query.action, $options: "i" };
    if (req.query.actorId) filter.actor   = req.query.actorId;

    const [logs, total] = await Promise.all([
      AuditLog.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("actor", "name email"),
      AuditLog.countDocuments(filter),
    ]);
    return res.json({ success: true, data: logs, pagination: { page, limit, total } });
  })
);

// ── Cancellations ─────────────────────────────────────────────────────────────
router.get("/cancellations",
  requirePermission("bookings:cancel"),
  asyncHandler(adminController.getCancellations)
);

// ── Support Queries ───────────────────────────────────────────────────────────
router.get("/support/queries",
  requirePermission("queries:read"),
  asyncHandler(adminController.getSupportQueries)
);
router.get(
  "/support/queries/:sessionId",
  requirePermission("queries:read"),
  validate([param("sessionId").isMongoId()]),
  asyncHandler(adminController.getSupportQueryById)
);
router.post(
  "/support/queries/:sessionId/resolve",
  requirePermission("queries:write"),
  validate([param("sessionId").isMongoId(), body("note").optional().isString()]),
  asyncHandler(adminController.resolveSupportQuery)
);

module.exports = router;
