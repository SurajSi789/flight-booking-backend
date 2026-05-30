const crypto = require("crypto");
const Transaction = require("../models/Transaction");
const Booking = require("../models/Booking");
const { env } = require("../config/env");

// Minimal Razorpay mock — no external API calls needed
class MockRazorpay {
  async createOrder({ amount, currency, receipt }) {
    return { id: `order_MOCK${Date.now()}`, amount, currency: currency || "INR", receipt, status: "created" };
  }
  async refundPayment(paymentId, { amount, notes }) {
    return { id: `rfnd_MOCK${Date.now()}`, payment_id: paymentId, amount, notes, status: "processed" };
  }
}

class PaymentService {
  constructor() {
    if (env.isPaymentMock) {
      this._mock = new MockRazorpay();
    } else {
      const Razorpay = require("razorpay");
      this._rzp = new Razorpay({ key_id: env.razorpay.keyId, key_secret: env.razorpay.keySecret });
    }
  }

  _hmac(content, secret) {
    return crypto.createHmac("sha256", secret).update(content).digest("hex");
  }

  verifyPaymentSignature({ orderId, paymentId, signature }) {
    if (env.isPaymentMock) return true; // always pass in mock mode
    return this._hmac(`${orderId}|${paymentId}`, env.razorpay.keySecret) === signature;
  }

  verifyWebhookSignature(rawBody, signatureHeader) {
    if (env.isPaymentMock) return true;
    return this._hmac(rawBody, env.razorpay.webhookSecret) === signatureHeader;
  }

  async createOrder({ bookingId, userId, amount }) {
    const booking = await Booking.findById(bookingId);
    if (!booking) throw new Error("Booking not found");

    const amountInPaise = Math.round(Number(amount) * 100);
    if (amountInPaise < 100) throw new Error("Amount must be at least INR 1");

    let order;
    if (env.isPaymentMock) {
      order = await this._mock.createOrder({ amount: amountInPaise, currency: "INR", receipt: bookingId.toString() });
    } else {
      order = await this._rzp.orders.create({ amount: amountInPaise, currency: "INR", receipt: bookingId.toString() });
    }

    booking.paymentOrderId = order.id;
    booking.paymentStatus = "pending";
    await booking.save();

    await Transaction.create({
      bookingId: booking._id,
      userId: userId || booking.userId,
      amount,
      currency: "INR",
      gateway: "razorpay",
      gatewayOrderId: order.id,
      type: "charge",
      status: "pending",
      gatewayResponse: order,
    });

    return order;
  }

  async markPaymentSuccess({ orderId, paymentId, payload }) {
    const transaction = await Transaction.findOneAndUpdate(
      { gatewayOrderId: orderId },
      { $set: { gatewayTxnId: paymentId, status: "success", gatewayResponse: payload } },
      { new: true }
    );
    if (!transaction) throw new Error("Transaction not found for order");
    await Booking.findByIdAndUpdate(transaction.bookingId, { $set: { paymentStatus: "paid", paymentId } });
    return transaction;
  }

  async markPaymentFailed({ orderId, payload }) {
    const transaction = await Transaction.findOneAndUpdate(
      { gatewayOrderId: orderId },
      { $set: { status: "failed", failureReason: payload?.error_description || "Payment failed", gatewayResponse: payload } },
      { new: true }
    );
    if (transaction) {
      await Booking.findByIdAndUpdate(transaction.bookingId, { $set: { paymentStatus: "failed" } });
    }
    return transaction;
  }

  async createRefund({ booking, amount, reason }) {
    const amountInPaise = Math.round(Number(amount) * 100);
    let refund;

    if (env.isPaymentMock || !booking.paymentId) {
      refund = { id: `rfnd_MOCK${Date.now()}`, payment_id: booking.paymentId || "pay_MOCK", amount: amountInPaise, notes: { reason } };
    } else {
      refund = await this._rzp.payments.refund(booking.paymentId, { amount: amountInPaise, notes: { reason: reason || "Booking refund" } });
    }

    await Transaction.create({
      bookingId: booking._id,
      userId: booking.userId,
      amount,
      currency: "INR",
      gateway: "razorpay",
      gatewayTxnId: refund.id,
      type: "refund",
      status: "refund_initiated",
      refundStatus: "pending",
      gatewayResponse: refund,
      metadata: { paymentId: booking.paymentId },
    });

    booking.refundStatus = "pending";
    booking.paymentStatus = "refund_pending";
    await booking.save();
    return refund;
  }

  async markRefundProcessed(refundPayload) {
    const refundId = refundPayload?.id;
    if (!refundId) return null;
    const txn = await Transaction.findOneAndUpdate(
      { gatewayTxnId: refundId, type: "refund" },
      { $set: { refundStatus: "processed", status: "success", gatewayResponse: refundPayload } },
      { new: true }
    );
    if (txn) {
      await Booking.findByIdAndUpdate(txn.bookingId, {
        $set: { refundStatus: "processed", refundProcessedAt: new Date(), paymentStatus: "refunded" },
      });
    }
    return txn;
  }
}

module.exports = new PaymentService();
