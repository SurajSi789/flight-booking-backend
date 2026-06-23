const Booking = require("../models/Booking");
const Transaction = require("../models/Transaction");
const User = require("../models/User");
const BookingService = require("../services/BookingService");
const PaymentService = require("../services/PaymentService");
const EmailService = require("../services/EmailService");
const WhatsAppService = require("../services/WhatsAppService");
const { generateTicketPDFBuffer } = require("../utils/ticketPdf");
const { env } = require("../config/env");

const buildResponse = (res, status, payload) => res.status(status).json(payload);

const initiateBooking = async (req, res) => {
  try {
    const { useWallet, walletAmount, ...bookingBody } = req.body;

    const initiation = await BookingService.initiate({
      userId: req.user.userId,
      ...bookingBody,
    });

    let fareBreakdown = { ...initiation.fareBreakdown };

    // Apply wallet deduction before creating the payment order
    if (useWallet && walletAmount > 0) {
      const user = await User.findById(req.user.userId).select("walletBalance");
      if (user && user.walletBalance > 0) {
        const walletDebit = Math.min(Number(walletAmount), user.walletBalance, fareBreakdown.totalFare);
        if (walletDebit > 0) {
          await User.findByIdAndUpdate(req.user.userId, {
            $inc: { walletBalance: -walletDebit },
            $push: { walletTransactions: { amount: walletDebit, type: "debit", reason: `Hold for booking ${initiation.bookingId}`, date: new Date() } },
          });
          await Booking.findByIdAndUpdate(initiation.bookingId, {
            $set: { "fareBreakdown.walletDebit": walletDebit, "fareBreakdown.totalFare": fareBreakdown.totalFare - walletDebit },
          });
          fareBreakdown.walletDebit = walletDebit;
          fareBreakdown.totalFare -= walletDebit;
        }
      }
    }

    let razorpayOrderId = null;
    let razorpayKey = env.razorpay.keyId;
    if (fareBreakdown.totalFare > 0) {
      const order = await PaymentService.createOrder({
        bookingId: initiation.bookingId,
        userId: req.user.userId,
        amount: fareBreakdown.totalFare,
      });
      razorpayOrderId = order.id;
    }

    return buildResponse(res, 201, {
      success: true,
      message: "Booking initiated",
      data: {
        bookingId: initiation.bookingId,
        fareBreakdown,
        razorpayOrderId,
        razorpayKey,
        sessionTTL: initiation.sessionTTL,
      },
    });
  } catch (error) {
    console.error("[initiateBooking] FAILED", {
      message: error.message,
      name: error.name,
      stack: error.stack,
      body: JSON.stringify(req.body).slice(0, 500),
    });
    return buildResponse(res, 400, { success: false, message: error.message || String(error) });
  }
};

const confirmBooking = async (req, res) => {
  const { bookingId } = req.params;
  const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;
  const booking = await Booking.findById(bookingId);
  if (!booking) {
    return buildResponse(res, 404, { success: false, message: "Booking not found" });
  }
  if (
    booking.userId.toString() !== req.user.userId &&
    req.user.role !== "admin"
  ) {
    return buildResponse(res, 403, { success: false, message: "Not authorized for this booking" });
  }

  const signatureOk = PaymentService.verifyPaymentSignature({
    orderId: razorpayOrderId,
    paymentId: razorpayPaymentId,
    signature: razorpaySignature
  });

  if (!signatureOk) {
    return buildResponse(res, 400, { success: false, message: "Invalid Razorpay signature" });
  }

  const isMockPayment = String(razorpayPaymentId || "").startsWith("pay_MOCK");

  if (isMockPayment) {
    // Mock gateway: no Transaction row to look up — update fields directly
    await Booking.findByIdAndUpdate(booking._id, {
      $set: { paymentStatus: "paid", paymentId: razorpayPaymentId }
    });
  } else {
    await PaymentService.markPaymentSuccess({
      orderId: razorpayOrderId,
      paymentId: razorpayPaymentId,
      payload: { from: "booking_confirm" }
    });
  }

  const confirmedBooking = await BookingService.confirmBooking({
    bookingId: booking._id,
    skipPaymentCheck: true,
  });
  const pnr = confirmedBooking.pnrMap?.[confirmedBooking.flightDetails.provider] || null;

  return buildResponse(res, 200, {
    success: true,
    message: "Booking confirmed",
    data: {
      bookingRef: confirmedBooking.bookingRef,
      pnr,
      status: "confirmed",
      flightDetails: confirmedBooking.flightDetails,
      ...(confirmedBooking.returnFlightDetails ? { returnFlightDetails: confirmedBooking.returnFlightDetails } : {})
    }
  });
};

const getMyBookings = async (req, res) => {
  const page = Math.max(Number(req.query.page || 1), 1);
  const limit = Math.min(Math.max(Number(req.query.limit || 10), 1), 100);
  const skip = (page - 1) * limit;
  const filter = { userId: req.user.userId };

  if (req.query.status) {
    filter.bookingStatus = req.query.status;
  }
  if (String(req.query.upcoming) === "true") {
    filter.bookingStatus = "confirmed";
    filter["flightDetails.departureAt"] = { $gt: new Date() };
  }

  const [rows, total] = await Promise.all([
    Booking.find(filter)
      .select("bookingRef bookingStatus paymentStatus fareBreakdown flightDetails returnFlightDetails createdAt")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Booking.countDocuments(filter)
  ]);

  return buildResponse(res, 200, {
    success: true,
    message: "Bookings fetched",
    data: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      results: rows
    }
  });
};

const getBookingByRef = async (req, res) => {
  const booking = await Booking.findOne({ bookingRef: req.params.bookingRef.toUpperCase() });
  if (!booking) {
    return buildResponse(res, 404, { success: false, message: "Booking not found" });
  }
  if (booking.userId.toString() !== req.user.userId && req.user.role !== "admin") {
    return buildResponse(res, 403, { success: false, message: "Access denied" });
  }

  const payments = await Transaction.find({ bookingId: booking._id }).sort({ createdAt: -1 });
  return buildResponse(res, 200, {
    success: true,
    message: "Booking fetched",
    data: {
      booking,
      payments
    }
  });
};

const cancelBooking = async (req, res) => {
  const booking = await Booking.findOne({ bookingRef: req.params.bookingRef.toUpperCase() });
  if (!booking) {
    return buildResponse(res, 404, { success: false, message: "Booking not found" });
  }
  if (booking.userId.toString() !== req.user.userId && req.user.role !== "admin") {
    return buildResponse(res, 403, { success: false, message: "Access denied" });
  }
  if (booking.bookingStatus !== "confirmed") {
    return buildResponse(res, 400, { success: false, message: "Only confirmed bookings can be cancelled" });
  }

  const { reason, useWallet } = req.body;

  // Capture paymentStatus before the service mutates it to "refund_pending"
  const wasAlreadyPaid = booking.paymentStatus === "paid";

  const { refundAmount } = await BookingService.cancelBooking({ booking, reason });

  let refundMethod = "none";
  let estimatedDays = 0;
  if (refundAmount > 0 && wasAlreadyPaid) {
    if (useWallet) {
      const user = await User.findById(booking.userId);
      user.walletBalance += refundAmount;
      user.walletTransactions.unshift({
        amount: refundAmount,
        type: "credit",
        reason: `Refund for ${booking.bookingRef}`,
        date: new Date()
      });
      await user.save();
      booking.refundStatus = "processed";
      booking.paymentStatus = "refunded";
      booking.refundProcessedAt = new Date();
      await booking.save();
      refundMethod = "wallet";
      estimatedDays = 0;
    } else {
      await PaymentService.createRefund({ booking, amount: refundAmount, reason });
      refundMethod = "card";
      estimatedDays = 7;
    }
  }

  // Always notify the customer after cancellation, regardless of refund eligibility
  const user = await User.findById(booking.userId);
  if (user) {
    Promise.allSettled([
      EmailService.sendCancellationConfirmation({ to: user.email, booking, refundAmount }),
      WhatsAppService.sendCancellationConfirmation({ booking, refundAmount }),
    ]).catch(() => {});
  }

  return buildResponse(res, 200, {
    success: true,
    message: "Booking cancelled successfully",
    data: {
      bookingRef: booking.bookingRef,
      refundAmount,
      refundMethod,
      estimatedDays
    }
  });
};

const getTicket = async (req, res) => {
  const booking = await Booking.findOne({ bookingRef: req.params.bookingRef.toUpperCase() });
  if (!booking) {
    return buildResponse(res, 404, { success: false, message: "Booking not found" });
  }
  if (booking.userId.toString() !== req.user.userId && req.user.role !== "admin") {
    return buildResponse(res, 403, { success: false, message: "Access denied" });
  }
  if (booking.bookingStatus !== "confirmed") {
    return buildResponse(res, 400, { success: false, message: "Ticket is available only for confirmed bookings" });
  }

  const pdfBuffer = await generateTicketPDFBuffer(booking);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="eticket-${booking.bookingRef}.pdf"`);
  res.setHeader("Content-Length", pdfBuffer.length);
  res.end(pdfBuffer);
};

module.exports = {
  initiateBooking,
  confirmBooking,
  getMyBookings,
  getBookingByRef,
  cancelBooking,
  getTicket
};
