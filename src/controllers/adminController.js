const Queue = require("bull");
const Papa = require("papaparse");
const mongoose = require("mongoose");
const User = require("../models/User");
const Booking = require("../models/Booking");
const Coupon = require("../models/Coupon");
const Offer = require("../models/Offer");
const Notification = require("../models/Notification");
const AuditLog = require("../models/AuditLog");
const Transaction = require("../models/Transaction");
const PaymentService = require("../services/PaymentService");
const EmailService = require("../services/EmailService");
const { getQueueRedisConfig } = require("../config/redis");

const notificationQueue = new Queue("notification-queue", getQueueRedisConfig());

const dayStart = (date = new Date()) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const monthStart = (date = new Date()) => new Date(date.getFullYear(), date.getMonth(), 1);

const createAuditLog = async (req, { action, resourceType, resourceId, userId, before, after }) =>
  AuditLog.create({
    actor:      req.adminUser.id,
    actorModel: "AdminUser",
    userId:     userId || null,
    adminId:    req.adminUser.id,
    action,
    resourceType,
    resourceId,
    before,
    after,
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"]
  });

const parseDateRange = (from, to) => {
  const match = {};
  if (from || to) {
    match.createdAt = {};
    if (from) {
      match.createdAt.$gte = new Date(from);
    }
    if (to) {
      match.createdAt.$lte = new Date(to);
    }
  }
  return match;
};

notificationQueue.process("broadcast-batch", async (job) => {
  const { users, payload } = job.data;
  const docs = users.map((userId) => ({
    userId,
    title: payload.title,
    body: payload.body,
    type: payload.type,
    deliveryStatus: payload.type === "in_app" ? "sent" : "pending",
    sentAt: payload.type === "in_app" ? new Date() : undefined
  }));
  await Notification.insertMany(docs);
});

const getStats = async (req, res) => {
  const now = new Date();
  const today = dayStart(now);
  const month = monthStart(now);
  const last7Days = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const dateFilter = parseDateRange(req.query.from, req.query.to);

  const [
    bookingsToday,
    revenueTodayAgg,
    bookingsThisMonth,
    revenueMonthAgg,
    pendingRefunds,
    cancelledToday,
    providerAgg,
    perDayAgg,
    topRoutesAgg,
    activeUsersAgg
  ] = await Promise.all([
    Booking.countDocuments({ createdAt: { $gte: today } }),
    Booking.aggregate([
      { $match: { paymentStatus: "paid", createdAt: { $gte: today } } },
      { $group: { _id: null, total: { $sum: "$fareBreakdown.totalFare" } } }
    ]),
    Booking.countDocuments({ createdAt: { $gte: month } }),
    Booking.aggregate([
      { $match: { paymentStatus: "paid", createdAt: { $gte: month } } },
      { $group: { _id: null, total: { $sum: "$fareBreakdown.totalFare" } } }
    ]),
    Booking.countDocuments({ refundStatus: "pending" }),
    Booking.countDocuments({ bookingStatus: "cancelled", cancelledAt: { $gte: today } }),
    Booking.aggregate([
      { $match: dateFilter },
      {
        $group: {
          _id: "$flightDetails.provider",
          count: { $sum: 1 },
          revenue: {
            $sum: {
              $cond: [{ $eq: ["$paymentStatus", "paid"] }, "$fareBreakdown.totalFare", 0]
            }
          }
        }
      }
    ]),
    Booking.aggregate([
      { $match: { createdAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } } },
      {
        $group: {
          _id: {
            y: { $year: "$createdAt" },
            m: { $month: "$createdAt" },
            d: { $dayOfMonth: "$createdAt" }
          },
          count: { $sum: 1 },
          revenue: {
            $sum: {
              $cond: [{ $eq: ["$paymentStatus", "paid"] }, "$fareBreakdown.totalFare", 0]
            }
          }
        }
      },
      { $sort: { "_id.y": 1, "_id.m": 1, "_id.d": 1 } }
    ]),
    Booking.aggregate([
      { $match: dateFilter },
      {
        $group: {
          _id: {
            origin: "$flightDetails.origin",
            destination: "$flightDetails.destination"
          },
          count: { $sum: 1 }
        }
      },
      { $sort: { count: -1 } },
      { $limit: 5 }
    ]),
    Booking.aggregate([
      { $match: { createdAt: { $gte: last7Days } } },
      { $group: { _id: "$userId" } },
      { $count: "total" }
    ])
  ]);

  const providerBreakdown = providerAgg.reduce((acc, item) => {
    acc[item._id || "unknown"] = { count: item.count, revenue: item.revenue };
    return acc;
  }, {});

  return res.json({
    success: true,
    message: "Admin stats fetched",
    data: {
      bookingsToday,
      revenueToday: revenueTodayAgg[0]?.total || 0,
      bookingsThisMonth,
      revenueThisMonth: revenueMonthAgg[0]?.total || 0,
      pendingRefunds,
      cancelledToday,
      providerBreakdown,
      bookingsPerDay: perDayAgg.map((item) => ({
        date: `${item._id.y}-${String(item._id.m).padStart(2, "0")}-${String(item._id.d).padStart(2, "0")}`,
        count: item.count,
        revenue: item.revenue
      })),
      topRoutes: topRoutesAgg.map((item) => ({
        route: `${item._id.origin}-${item._id.destination}`,
        count: item.count
      })),
      activeUsersLast7Days: activeUsersAgg[0]?.total || 0
    }
  });
};

const getAdminBookings = async (req, res) => {
  const page = Math.max(Number(req.query.page || 1), 1);
  const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 100);
  const skip = (page - 1) * limit;
  const filter = parseDateRange(req.query.from, req.query.to);

  if (req.query.status) {
    filter.bookingStatus = req.query.status;
  }
  if (req.query.provider) {
    filter["flightDetails.provider"] = req.query.provider;
  }
  if (req.query.search) {
    const search = String(req.query.search).trim();
    const regex = new RegExp(search, "i");
    const userIds = await User.find({ email: regex }).select("_id");
    filter.$or = [
      { bookingRef: regex },
      { "pnrMap.indigo": regex },
      { "pnrMap.airindia": regex },
      { "pnrMap.spicejet": regex },
      { "pnrMap.flightroutes24": regex },
      { userId: { $in: userIds.map((u) => u._id) } }
    ];
  }

  const [bookings, total] = await Promise.all([
    Booking.find(filter)
      .populate("userId", "name email")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Booking.countDocuments(filter)
  ]);

  return res.json({
    success: true,
    message: "Admin bookings fetched",
    data: { bookings, total, page, pages: Math.ceil(total / limit) }
  });
};

const getAdminBookingByRef = async (req, res) => {
  const booking = await Booking.findOne({ bookingRef: req.params.bookingRef.toUpperCase() }).populate(
    "userId",
    "name email phone role"
  );
  if (!booking) {
    return res.status(404).json({ success: false, message: "Booking not found" });
  }
  const transactions = await Transaction.find({ bookingId: booking._id }).sort({ createdAt: -1 });
  return res.json({
    success: true,
    message: "Admin booking details fetched",
    data: { booking, transactions }
  });
};

const patchAdminBooking = async (req, res) => {
  const booking = await Booking.findOne({ bookingRef: req.params.bookingRef.toUpperCase() });
  if (!booking) {
    return res.status(404).json({ success: false, message: "Booking not found" });
  }
  const before = booking.toObject();
  if (req.body.status) {
    booking.bookingStatus = req.body.status;
  }
  if (req.body.reason) {
    booking.cancellationReason = req.body.reason;
  }
  await booking.save();
  const after = booking.toObject();

  await Notification.create({
    userId: booking.userId,
    type: "in_app",
    title: "Booking status updated",
    body: `Your booking ${booking.bookingRef} status changed to ${booking.bookingStatus}`,
    deliveryStatus: "sent",
    sentAt: new Date()
  });

  await createAuditLog(req, {
    action: "ADMIN_BOOKING_PATCHED",
    resourceType: "Booking",
    resourceId: booking._id,
    userId: booking.userId,
    before,
    after
  });

  return res.json({ success: true, message: "Booking updated", data: booking });
};

const adminBookingRefund = async (req, res) => {
  const booking = await Booking.findOne({ bookingRef: req.params.bookingRef.toUpperCase() });
  if (!booking) {
    return res.status(404).json({ success: false, message: "Booking not found" });
  }
  const before = booking.toObject();
  const refund = await PaymentService.createRefund({
    booking,
    amount: Number(req.body.amount),
    reason: req.body.reason
  });
  const after = booking.toObject();

  await createAuditLog(req, {
    action: "ADMIN_BOOKING_REFUND_INITIATED",
    resourceType: "Booking",
    resourceId: booking._id,
    userId: booking.userId,
    before,
    after
  });

  return res.status(201).json({ success: true, message: "Manual refund initiated", data: refund });
};

const getAdminUsers = async (req, res) => {
  const page = Math.max(Number(req.query.page || 1), 1);
  const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 100);
  const skip = (page - 1) * limit;
  const filter = {};

  if (typeof req.query.isActive !== "undefined") {
    filter.isActive = String(req.query.isActive) === "true";
  }
  if (req.query.search) {
    const regex = new RegExp(String(req.query.search).trim(), "i");
    filter.$or = [{ email: regex }, { phone: regex }, { "name.first": regex }, { "name.last": regex }];
  }

  const [users, total] = await Promise.all([
    User.find(filter)
      .select("-passwordHash -refreshTokenHash -otpHash")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    User.countDocuments(filter)
  ]);

  const userIds = users.map((user) => user._id);
  const spendAgg = await Booking.aggregate([
    { $match: { userId: { $in: userIds }, paymentStatus: "paid" } },
    {
      $group: {
        _id: "$userId",
        bookingCount: { $sum: 1 },
        totalSpend: { $sum: "$fareBreakdown.totalFare" }
      }
    }
  ]);

  const spendMap = spendAgg.reduce((acc, item) => {
    acc[item._id.toString()] = item;
    return acc;
  }, {});

  const rows = users.map((user) => ({
    ...user.toObject(),
    bookingCount: spendMap[user._id.toString()]?.bookingCount || 0,
    totalSpend: spendMap[user._id.toString()]?.totalSpend || 0
  }));

  return res.json({
    success: true,
    message: "Users fetched",
    data: { users: rows, total, page, pages: Math.ceil(total / limit) }
  });
};

const getAdminUserById = async (req, res) => {
  const user = await User.findById(req.params.userId).select("-passwordHash -refreshTokenHash -otpHash");
  if (!user) {
    return res.status(404).json({ success: false, message: "User not found" });
  }

  const bookings = await Booking.find({ userId: user._id }).sort({ createdAt: -1 }).limit(10);
  return res.json({
    success: true,
    message: "User profile fetched",
    data: { user, bookings, walletTransactions: user.walletTransactions }
  });
};

const patchAdminUser = async (req, res) => {
  const user = await User.findById(req.params.userId);
  if (!user) {
    return res.status(404).json({ success: false, message: "User not found" });
  }
  const before = user.toObject();

  if (typeof req.body.isActive !== "undefined") {
    user.isActive = req.body.isActive;
  }
  if (typeof req.body.walletBalance !== "undefined") {
    user.walletBalance = Number(req.body.walletBalance);
  }
  if (req.body.role) {
    user.role = req.body.role;
  }
  await user.save();
  const after = user.toObject();

  await createAuditLog(req, {
    action: "ADMIN_USER_PATCHED",
    resourceType: "User",
    resourceId: user._id,
    userId: user._id,
    before,
    after
  });

  return res.json({
    success: true,
    message: "User updated",
    data: user
  });
};

const getAdminCoupons = async (req, res) => {
  const page = Math.max(Number(req.query.page || 1), 1);
  const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 100);
  const skip = (page - 1) * limit;
  const filter = {};

  if (typeof req.query.isActive !== "undefined") {
    filter.isActive = String(req.query.isActive) === "true";
  }
  if (req.query.search) {
    const regex = new RegExp(String(req.query.search).trim(), "i");
    filter.$or = [{ code: regex }, { description: regex }];
  }

  const [coupons, total] = await Promise.all([
    Coupon.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Coupon.countDocuments(filter)
  ]);

  return res.json({
    success: true,
    message: "Coupons fetched",
    data: { coupons, total, page, pages: Math.ceil(total / limit) }
  });
};

const createAdminCoupon = async (req, res) => {
  const payload = { ...req.body, code: String(req.body.code).toUpperCase().trim(), createdBy: req.adminUser.id };
  if (/\s/.test(payload.code)) {
    return res.status(400).json({ success: false, message: "Coupon code must not contain spaces" });
  }
  if (new Date(payload.validTo) <= new Date(payload.validFrom)) {
    return res.status(400).json({ success: false, message: "validTo must be after validFrom" });
  }
  if (Number(payload.discountValue) <= 0 || Number(payload.usageLimit) < 1) {
    return res.status(400).json({ success: false, message: "Invalid discountValue or usageLimit" });
  }

  const exists = await Coupon.findOne({ code: payload.code });
  if (exists) {
    return res.status(409).json({ success: false, message: "Coupon code already exists" });
  }

  const coupon = await Coupon.create(payload);
  await createAuditLog(req, {
    action: "ADMIN_COUPON_CREATED",
    resourceType: "Coupon",
    resourceId: coupon._id,
    after: coupon.toObject()
  });

  return res.status(201).json({ success: true, message: "Coupon created", data: coupon });
};

const patchAdminCoupon = async (req, res) => {
  const coupon = await Coupon.findById(req.params.id);
  if (!coupon) {
    return res.status(404).json({ success: false, message: "Coupon not found" });
  }
  const before = coupon.toObject();

  if (req.body.code && req.body.code !== coupon.code) {
    return res.status(400).json({ success: false, message: "Coupon code cannot be changed" });
  }
  if (typeof req.body.usageLimit !== "undefined" && Number(req.body.usageLimit) < coupon.usedCount) {
    return res.status(400).json({ success: false, message: "usageLimit cannot be below usedCount" });
  }

  Object.assign(coupon, req.body);
  await coupon.save();
  await createAuditLog(req, {
    action: "ADMIN_COUPON_PATCHED",
    resourceType: "Coupon",
    resourceId: coupon._id,
    before,
    after: coupon.toObject()
  });

  return res.json({ success: true, message: "Coupon updated", data: coupon });
};

const deleteAdminCoupon = async (req, res) => {
  const coupon = await Coupon.findById(req.params.id);
  if (!coupon) {
    return res.status(404).json({ success: false, message: "Coupon not found" });
  }
  const before = coupon.toObject();
  coupon.isActive = false;
  await coupon.save();

  await createAuditLog(req, {
    action: "ADMIN_COUPON_SOFT_DELETED",
    resourceType: "Coupon",
    resourceId: coupon._id,
    before,
    after: coupon.toObject()
  });

  return res.json({ success: true, message: "Coupon deactivated" });
};

const getAdminOffers = async (req, res) => {
  const offers = await Offer.find().sort({ displayOrder: 1, createdAt: -1 });
  return res.json({ success: true, message: "Offers fetched", data: offers });
};

const createAdminOffer = async (req, res) => {
  const offer = await Offer.create({ ...req.body, createdBy: req.adminUser.id });
  await createAuditLog(req, {
    action: "ADMIN_OFFER_CREATED",
    resourceType: "Offer",
    resourceId: offer._id,
    after: offer.toObject()
  });
  return res.status(201).json({ success: true, message: "Offer created", data: offer });
};

const patchAdminOffer = async (req, res) => {
  const offer = await Offer.findById(req.params.id);
  if (!offer) {
    return res.status(404).json({ success: false, message: "Offer not found" });
  }
  const before = offer.toObject();
  Object.assign(offer, req.body);
  await offer.save();
  await createAuditLog(req, {
    action: "ADMIN_OFFER_PATCHED",
    resourceType: "Offer",
    resourceId: offer._id,
    before,
    after: offer.toObject()
  });
  return res.json({ success: true, message: "Offer updated", data: offer });
};

const deleteAdminOffer = async (req, res) => {
  const offer = await Offer.findById(req.params.id);
  if (!offer) {
    return res.status(404).json({ success: false, message: "Offer not found" });
  }
  const before = offer.toObject();
  offer.isActive = false;
  await offer.save();
  await createAuditLog(req, {
    action: "ADMIN_OFFER_SOFT_DELETED",
    resourceType: "Offer",
    resourceId: offer._id,
    before,
    after: offer.toObject()
  });
  return res.json({ success: true, message: "Offer deactivated" });
};

const reorderOffers = async (req, res) => {
  const ops = req.body.map((item) => ({
    updateOne: {
      filter: { _id: new mongoose.Types.ObjectId(item.id) },
      update: { $set: { displayOrder: Number(item.displayOrder) } }
    }
  }));
  await Offer.bulkWrite(ops);
  await createAuditLog(req, {
    action: "ADMIN_OFFER_REORDERED",
    resourceType: "Offer",
    after: { items: req.body }
  });
  return res.json({ success: true, message: "Offer display order updated" });
};

const sendNotificationByType = async ({ user, title, body, type }) => {
  if (type === "email") {
    await EmailService.send({ to: user.email, subject: title, html: `<p>${body}</p>` });
    return "sent";
  }
  if (type === "push") {
    return "sent";
  }
  return "sent";
};

const broadcastNotifications = async (req, res) => {
  const { title, body, type, filter } = req.body;
  const userFilter = {};
  if (filter?.role) {
    userFilter.role = filter.role;
  }

  let userIds = (await User.find(userFilter).select("_id")).map((u) => u._id);

  if (filter?.lastBookingWithinDays) {
    const after = new Date(Date.now() - Number(filter.lastBookingWithinDays) * 24 * 60 * 60 * 1000);
    const active = await Booking.aggregate([
      { $match: { userId: { $in: userIds }, createdAt: { $gte: after } } },
      { $group: { _id: "$userId" } }
    ]);
    const activeSet = new Set(active.map((item) => item._id.toString()));
    userIds = userIds.filter((id) => activeSet.has(id.toString()));
  }

  if (filter?.minTotalSpend) {
    const spend = await Booking.aggregate([
      { $match: { userId: { $in: userIds }, paymentStatus: "paid" } },
      { $group: { _id: "$userId", total: { $sum: "$fareBreakdown.totalFare" } } },
      { $match: { total: { $gte: Number(filter.minTotalSpend) } } }
    ]);
    const spendSet = new Set(spend.map((item) => item._id.toString()));
    userIds = userIds.filter((id) => spendSet.has(id.toString()));
  }

  if (userIds.length > 1000) {
    for (let index = 0; index < userIds.length; index += 100) {
      await notificationQueue.add("broadcast-batch", {
        users: userIds.slice(index, index + 100),
        payload: { title, body, type }
      });
    }
  } else {
    const docs = [];
    for (const userId of userIds) {
      const user = await User.findById(userId).select("email");
      const status = await sendNotificationByType({ user, title, body, type });
      docs.push({
        userId,
        title,
        body,
        type,
        deliveryStatus: status,
        sentAt: new Date()
      });
    }
    if (docs.length > 0) {
      await Notification.insertMany(docs);
    }
  }

  await createAuditLog(req, {
    action: "ADMIN_NOTIFICATION_BROADCAST",
    resourceType: "Notification",
    after: { title, type, recipientCount: userIds.length }
  });

  return res.status(201).json({
    success: true,
    message: "Broadcast queued",
    data: { recipientCount: userIds.length }
  });
};

const sendNotificationToUser = async (req, res) => {
  const user = await User.findById(req.params.userId);
  if (!user) {
    return res.status(404).json({ success: false, message: "User not found" });
  }
  const { title, body, type } = req.body;
  const status = await sendNotificationByType({ user, title, body, type });
  const notification = await Notification.create({
    userId: user._id,
    title,
    body,
    type,
    deliveryStatus: status,
    sentAt: new Date()
  });

  await createAuditLog(req, {
    action: "ADMIN_NOTIFICATION_USER_SENT",
    resourceType: "Notification",
    resourceId: notification._id,
    userId: user._id,
    after: notification.toObject()
  });

  return res.status(201).json({ success: true, message: "Notification sent", data: notification });
};

const getAdminNotifications = async (req, res) => {
  const page = Math.max(Number(req.query.page || 1), 1);
  const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 100);
  const skip = (page - 1) * limit;
  const filter = {};
  if (req.query.type) {
    filter.type = req.query.type;
  }
  if (req.query.deliveryStatus) {
    filter.deliveryStatus = req.query.deliveryStatus;
  }

  const [notifications, total] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Notification.countDocuments(filter)
  ]);
  return res.json({
    success: true,
    message: "Notifications fetched",
    data: { notifications, total, page, pages: Math.ceil(total / limit) }
  });
};

const getPendingRefunds = async (req, res) => {
  const bookings = await Booking.find({ refundStatus: "pending" })
    .populate("userId", "name email phone")
    .sort({ updatedAt: -1 });
  return res.json({ success: true, message: "Pending refunds fetched", data: bookings });
};

const approveRefund = async (req, res) => {
  const booking = await Booking.findOne({ bookingRef: req.params.bookingRef.toUpperCase() });
  if (!booking) {
    return res.status(404).json({ success: false, message: "Booking not found" });
  }
  if (booking.refundStatus !== "pending") {
    return res.status(400).json({ success: false, message: "Refund is not pending" });
  }

  const before = booking.toObject();
  const refundAmount = booking.refundAmount || booking.fareBreakdown.totalFare || 0;
  const refund = await PaymentService.createRefund({
    booking,
    amount: refundAmount,
    reason: "Admin approved refund"
  });
  await PaymentService.markRefundProcessed(refund);

  const updatedBooking = await Booking.findById(booking._id);
  const user = await User.findById(booking.userId);
  if (user) {
    await EmailService.sendCancellationConfirmation({
      to: user.email,
      booking: updatedBooking,
      refundAmount
    });
  }

  await createAuditLog(req, {
    action: "ADMIN_REFUND_APPROVED",
    resourceType: "Booking",
    resourceId: booking._id,
    userId: booking.userId,
    before,
    after: updatedBooking.toObject()
  });

  return res.json({ success: true, message: "Refund approved and processed", data: updatedBooking });
};

const bookingsReport = async (req, res) => {
  const filter = parseDateRange(req.query.from, req.query.to);
  const bookings = await Booking.find(filter).populate("userId", "email").sort({ createdAt: -1 });

  const rows = bookings.map((item) => ({
    bookingRef: item.bookingRef,
    userEmail: item.userId?.email || "",
    route: `${item.flightDetails.origin}-${item.flightDetails.destination}`,
    airline: item.flightDetails.provider,
    date: item.createdAt.toISOString(),
    fare: item.fareBreakdown.totalFare,
    status: item.bookingStatus,
    paymentStatus: item.paymentStatus
  }));

  if (req.query.format === "csv") {
    const csv = Papa.unparse(rows);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=bookings-report.csv");
    return res.send(csv);
  }

  return res.json({ success: true, message: "Bookings report fetched", data: rows });
};

const revenueReport = async (req, res) => {
  const groupBy = req.query.groupBy || "day";
  const filter = parseDateRange(req.query.from, req.query.to);
  filter.paymentStatus = "paid";

  let groupExpr;
  if (groupBy === "provider") {
    groupExpr = "$flightDetails.provider";
  } else if (groupBy === "month") {
    groupExpr = {
      y: { $year: "$createdAt" },
      m: { $month: "$createdAt" }
    };
  } else if (groupBy === "week") {
    groupExpr = {
      y: { $year: "$createdAt" },
      w: { $week: "$createdAt" }
    };
  } else {
    groupExpr = {
      y: { $year: "$createdAt" },
      m: { $month: "$createdAt" },
      d: { $dayOfMonth: "$createdAt" }
    };
  }

  const rows = await Booking.aggregate([
    { $match: filter },
    { $group: { _id: groupExpr, revenue: { $sum: "$fareBreakdown.totalFare" }, count: { $sum: 1 } } },
    { $sort: { _id: 1 } }
  ]);

  return res.json({ success: true, message: "Revenue report fetched", data: rows });
};

// ── Cancellations ─────────────────────────────────────────────────────────────
const getCancellations = async (req, res) => {
  const page  = Math.max(Number(req.query.page  || 1), 1);
  const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 100);
  const skip  = (page - 1) * limit;

  const filter = { bookingStatus: "cancelled" };
  if (req.query.from || req.query.to) {
    const dateFilter = parseDateRange(req.query.from, req.query.to);
    filter.cancelledAt = dateFilter.createdAt;
  }
  if (req.query.provider) filter["flightDetails.provider"] = req.query.provider;
  if (req.query.refundStatus) filter.refundStatus = req.query.refundStatus;

  const [bookings, total] = await Promise.all([
    Booking.find(filter)
      .populate("userId", "name email phone")
      .sort({ cancelledAt: -1, updatedAt: -1 })
      .skip(skip)
      .limit(limit),
    Booking.countDocuments(filter)
  ]);

  return res.json({
    success: true,
    data: { bookings, total, page, pages: Math.ceil(total / limit) }
  });
};

// ── Support Queries ───────────────────────────────────────────────────────────
const ChatSession = require("../models/ChatSession");

const getSupportQueries = async (req, res) => {
  const page  = Math.max(Number(req.query.page  || 1), 1);
  const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 100);
  const skip  = (page - 1) * limit;

  const filter = { isEscalated: true };
  if (req.query.resolved === "true")  filter.resolvedAt = { $exists: true };
  if (req.query.resolved === "false") filter.resolvedAt = { $exists: false };

  const [sessions, total] = await Promise.all([
    ChatSession.find(filter)
      .populate("userId", "name email phone")
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(limit)
      .select("-archivedMessages"),
    ChatSession.countDocuments(filter)
  ]);

  return res.json({
    success: true,
    data: { sessions, total, page, pages: Math.ceil(total / limit) }
  });
};

const getSupportQueryById = async (req, res) => {
  const session = await ChatSession.findById(req.params.sessionId)
    .populate("userId", "name email phone walletBalance");
  if (!session) return res.status(404).json({ success: false, message: "Session not found" });

  // Merge live + archived messages sorted by timestamp
  const allMessages = [
    ...(session.archivedMessages || []),
    ...(session.messages || [])
  ].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  return res.json({ success: true, data: { session, messages: allMessages } });
};

const resolveSupportQuery = async (req, res) => {
  const session = await ChatSession.findById(req.params.sessionId);
  if (!session) return res.status(404).json({ success: false, message: "Session not found" });

  session.resolvedAt  = new Date();
  session.resolvedBy  = req.adminUser.id;
  session.isEscalated = false;
  if (req.body.note) {
    session.messages.push({
      role:      "assistant",
      content:   `[Admin note by ${req.adminUser.email}]: ${req.body.note}`,
      timestamp: new Date()
    });
  }
  await session.save();

  await createAuditLog(req, {
    action:       "SUPPORT_QUERY_RESOLVED",
    resourceType: "ChatSession",
    resourceId:   session._id,
    userId:       session.userId,
  });

  return res.json({ success: true, message: "Query resolved" });
};

// ── Enhanced Offers ───────────────────────────────────────────────────────────
// (getAdminOffers, createAdminOffer already exist above — patchAdminOffer now handles new fields)

module.exports = {
  getStats,
  getAdminBookings,
  getAdminBookingByRef,
  patchAdminBooking,
  adminBookingRefund,
  getAdminUsers,
  getAdminUserById,
  patchAdminUser,
  getAdminCoupons,
  createAdminCoupon,
  patchAdminCoupon,
  deleteAdminCoupon,
  getAdminOffers,
  createAdminOffer,
  patchAdminOffer,
  deleteAdminOffer,
  reorderOffers,
  broadcastNotifications,
  sendNotificationToUser,
  getAdminNotifications,
  getPendingRefunds,
  approveRefund,
  bookingsReport,
  revenueReport,
  getCancellations,
  getSupportQueries,
  getSupportQueryById,
  resolveSupportQuery,
};
