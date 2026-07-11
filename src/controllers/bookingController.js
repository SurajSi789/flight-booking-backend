const Booking = require("../models/Booking");
const Transaction = require("../models/Transaction");
const User = require("../models/User");
const BookingService = require("../services/BookingService");
const PaymentService = require("../services/PaymentService");
const EmailService = require("../services/EmailService");
const WhatsAppService = require("../services/WhatsAppService");
const { generateTicketPDFBuffer } = require("../utils/ticketPdf");
const { env } = require("../config/env");
const { logger } = require("../config/db");

const buildResponse = (res, status, payload) => res.status(status).json(payload);

// Auto-refund a booking whose payment was captured but airline ticketing failed.
// Initiates a Razorpay refund for the charged amount, restores any wallet debit, and
// marks the booking cancelled (no reservation exists). Never throws — refund failures
// are logged for manual follow-up so they can't mask the original ticketing error.
async function autoRefundFailedBooking(bookingId, reason) {
  const result = { refunded: false };
  try {
    const booking = await Booking.findById(bookingId);
    if (!booking) return result;

    // The Razorpay charge equals the post-wallet totalFare persisted at initiate time.
    // Only refund a payment that is still "paid" — guards against a second call
    // (e.g. webhook retry) refunding an already-refunded payment.
    const chargedAmount = Number(booking.fareBreakdown?.totalFare || 0);
    if (booking.paymentId && chargedAmount > 0 && booking.paymentStatus === "paid") {
      await PaymentService.createRefund({ booking, amount: chargedAmount, reason });
      result.refunded = true;
      result.refundAmount = chargedAmount;
    }

    // Restore any wallet balance that was debited/held for this booking.
    const walletDebit = Number(booking.fareBreakdown?.walletDebit || 0);
    if (walletDebit > 0) {
      await User.findByIdAndUpdate(booking.userId, {
        $inc: { walletBalance: walletDebit },
        $push: { walletTransactions: { amount: walletDebit, type: "credit", reason: `Refund — booking ${booking.bookingRef} failed`, date: new Date() } },
      });
      await Booking.findByIdAndUpdate(booking._id, { $set: { "fareBreakdown.walletDebit": 0 } });
      result.walletRestored = walletDebit;
    }

    await Booking.findByIdAndUpdate(booking._id, { $set: { bookingStatus: "cancelled" } });
    logger.info("[BookingConfirm] Auto-refund completed after ticketing failure", { bookingId: String(bookingId), ...result });
  } catch (refundErr) {
    logger.error("[BookingConfirm] Auto-refund FAILED — manual refund required", {
      bookingId: String(bookingId),
      message: refundErr.message,
      stack: refundErr.stack,
    });
    result.refundError = refundErr.message;
  }
  return result;
}

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

  logger.info("[BookingConfirm] Received confirm request", {
    bookingId,
    userId: req.user?.userId,
    razorpayOrderId,
    razorpayPaymentId,
  });

  const booking = await Booking.findById(bookingId);
  if (!booking) {
    logger.warn("[BookingConfirm] Booking not found", { bookingId });
    return buildResponse(res, 404, { success: false, message: "Booking not found" });
  }
  if (
    booking.userId.toString() !== req.user.userId &&
    req.user.role !== "admin"
  ) {
    logger.warn("[BookingConfirm] Not authorized", { bookingId, userId: req.user?.userId });
    return buildResponse(res, 403, { success: false, message: "Not authorized for this booking" });
  }

  const signatureOk = PaymentService.verifyPaymentSignature({
    orderId: razorpayOrderId,
    paymentId: razorpayPaymentId,
    signature: razorpaySignature
  });

  if (!signatureOk) {
    logger.warn("[BookingConfirm] Invalid Razorpay signature — aborting", { bookingId, razorpayOrderId });
    return buildResponse(res, 400, { success: false, message: "Invalid Razorpay signature" });
  }

  // Mark payment captured (real Razorpay txn). Runs before provider ticketing so
  // the money is always recorded against the booking even if ticketing then fails.
  await PaymentService.markPaymentSuccess({
    orderId: razorpayOrderId,
    paymentId: razorpayPaymentId,
    payload: { from: "booking_confirm" }
  });

  // Post-payment: create the actual airline reservation (PNR). If the provider
  // call fails we do NOT fabricate a PNR — the payment stays recorded as paid and
  // we surface the real error so it can be investigated / refunded.
  let confirmedBooking;
  try {
    confirmedBooking = await BookingService.confirmBooking({
      bookingId: booking._id,
      skipPaymentCheck: true,
    });
  } catch (err) {
    logger.error("[BookingConfirm] Provider ticketing FAILED after payment captured", {
      bookingId: booking._id.toString(),
      provider: booking.flightDetails?.provider,
      razorpayOrderId,
      razorpayPaymentId,
      message: err.message,
      stack: err.stack,
    });

    // Payment was captured but no airline reservation exists — refund automatically.
    const refund = await autoRefundFailedBooking(booking._id, `Airline ticketing failed: ${err.message}`);

    // 502: payment succeeded but the downstream airline booking did not.
    return buildResponse(res, 502, {
      success: false,
      message: err.message || "Airline booking failed after payment.",
      data: {
        bookingRef: booking.bookingRef,
        paymentCaptured: true,
        refundInitiated: refund.refunded,
        ...(refund.refundAmount   ? { refundAmount: refund.refundAmount }     : {}),
        ...(refund.walletRestored ? { walletRestored: refund.walletRestored } : {}),
        ...(refund.refundError    ? { refundError: refund.refundError }       : {}),
      },
    });
  }

  // confirmBooking returns { bookingRef, pnr, status } — use pnr directly.
  const pnr = confirmedBooking.pnr || null;
  logger.info("[BookingConfirm] Booking confirmed with real PNR", {
    bookingId: booking._id.toString(),
    bookingRef: confirmedBooking.bookingRef,
    provider: booking.flightDetails?.provider,
    pnr,
  });

  return buildResponse(res, 200, {
    success: true,
    message: "Booking confirmed",
    data: {
      bookingRef: confirmedBooking.bookingRef,
      pnr,
      status: "confirmed",
      flightDetails: booking.flightDetails,
      ...(booking.returnFlightDetails ? { returnFlightDetails: booking.returnFlightDetails } : {})
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
