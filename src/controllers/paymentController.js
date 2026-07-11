const Queue = require("bull");
const Booking = require("../models/Booking");
const User = require("../models/User");
const Transaction = require("../models/Transaction");
const BookingService = require("../services/BookingService");
const PaymentService = require("../services/PaymentService");
const EmailService = require("../services/EmailService");
const { getBullQueueOptions } = require("../config/redis");
const { env } = require("../config/env");
const { logger } = require("../config/db");

const webhookQueue = new Queue("payment-webhook-queue", getBullQueueOptions());

webhookQueue.process("process-event", async (job) => {
  const event = job.data.event;
  const payload = job.data.payload;

  if (event === "payment.captured") {
    const paymentEntity = payload?.payment?.entity || {};
    const transaction = await PaymentService.markPaymentSuccess({
      orderId: paymentEntity.order_id,
      paymentId: paymentEntity.id,
      payload
    });
    // Ticketing can fail post-payment; the failure is already recorded on the booking
    // (confirmError) and logged. Swallow here so a permanent provider failure does not
    // cause the webhook job to retry endlessly. A no-op if the sync /confirm already ran.
    try {
      await BookingService.confirmBooking(transaction.bookingId);
    } catch (err) {
      logger.error("[PaymentWebhook] confirmBooking failed after payment.captured", {
        bookingId: String(transaction.bookingId),
        orderId: paymentEntity.order_id,
        paymentId: paymentEntity.id,
        message: err.message,
      });
    }
    return;
  }

  if (event === "payment.failed") {
    const paymentEntity = payload?.payment?.entity || {};
    const transaction = await PaymentService.markPaymentFailed({ orderId: paymentEntity.order_id, payload: paymentEntity });
    if (transaction) {
      await releaseBookingWalletHold(transaction.bookingId, "Payment failed via gateway");
    }
    return;
  }

  if (event === "refund.processed") {
    const refundEntity = payload?.refund?.entity || {};
    await PaymentService.markRefundProcessed(refundEntity);
  }
});

// Restores wallet hold on a booking that was never paid.
// Safe to call multiple times — idempotent when walletDebit is already 0.
async function releaseBookingWalletHold(bookingId, reason) {
  const booking = await Booking.findById(bookingId);
  const walletDebit = booking?.fareBreakdown?.walletDebit;
  if (!walletDebit || walletDebit <= 0) return;

  await User.findByIdAndUpdate(booking.userId, {
    $inc: { walletBalance: walletDebit },
    $push: {
      walletTransactions: {
        amount: walletDebit,
        type: "credit",
        reason: reason || `Wallet hold released for booking ${booking.bookingRef || booking._id}`,
        date: new Date(),
      },
    },
  });
  await Booking.findByIdAndUpdate(booking._id, {
    $set: { "fareBreakdown.walletDebit": 0 },
  });
}

const releaseWalletHold = async (req, res) => {
  const { bookingId } = req.body;
  if (!bookingId) {
    return res.status(400).json({ success: false, message: "bookingId is required" });
  }

  const booking = await Booking.findOne({ _id: bookingId, userId: req.user.userId });
  if (!booking) {
    return res.status(404).json({ success: false, message: "Booking not found" });
  }
  if (booking.paymentStatus === "paid") {
    return res.status(400).json({ success: false, message: "Booking is already paid" });
  }

  await releaseBookingWalletHold(booking._id, `Wallet hold released - payment abandoned for ${booking.bookingRef}`);
  await Booking.findByIdAndUpdate(booking._id, { $set: { paymentStatus: "failed" } });

  return res.json({ success: true, message: "Wallet hold released" });
};

const createOrder = async (req, res) => {
  const booking = await Booking.findOne({ _id: req.body.bookingId, userId: req.user.userId });
  if (!booking) {
    return res.status(404).json({ success: false, message: "Booking not found" });
  }

  const amount = booking.fareBreakdown?.totalFare || 0;
  if (amount <= 0) {
    return res.status(400).json({ success: false, message: "Booking does not require online payment" });
  }

  const order = await PaymentService.createOrder({
    bookingId: booking._id,
    userId: req.user.userId,
    amount
  });

  return res.status(201).json({
    success: true,
    message: "Order created",
    data: {
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      key: env.razorpay.keyId
    }
  });
};

const webhook = async (req, res) => {
  const signature = req.headers["x-razorpay-signature"];
  const rawBody = req.rawBody || JSON.stringify(req.body || {});
  if (!signature || !PaymentService.verifyWebhookSignature(rawBody, signature)) {
    return res.status(400).json({ success: false, message: "Invalid webhook signature" });
  }

  const payload = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  await webhookQueue.add("process-event", payload);

  return res.status(200).json({ success: true, message: "Webhook received" });
};

const refund = async (req, res) => {
  const { bookingRef, amount, reason } = req.body;
  const booking = await Booking.findOne({ bookingRef: String(bookingRef).toUpperCase() });
  if (!booking) {
    return res.status(404).json({ success: false, message: "Booking not found" });
  }
  if (booking.paymentStatus !== "paid" && booking.paymentStatus !== "refund_pending") {
    return res.status(400).json({ success: false, message: "Booking is not eligible for refund" });
  }

  const refundResult = await PaymentService.createRefund({ booking, amount, reason });
  const user = await User.findById(booking.userId);
  if (user) {
    await EmailService.sendCancellationConfirmation({
      to: user.email,
      booking,
      refundAmount: amount
    });
  }

  return res.status(201).json({
    success: true,
    message: "Refund initiated",
    data: refundResult
  });
};

const wallet = async (req, res) => {
  const user = await User.findById(req.user.userId).select("walletBalance walletTransactions");
  if (!user) {
    return res.status(404).json({ success: false, message: "User not found" });
  }

  return res.json({
    success: true,
    message: "Wallet fetched",
    data: {
      balance: user.walletBalance,
      transactions: user.walletTransactions.slice(0, 10)
    }
  });
};

module.exports = {
  createOrder,
  webhook,
  refund,
  wallet,
  releaseWalletHold,
};
