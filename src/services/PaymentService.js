const crypto = require("crypto");
const Transaction = require("../models/Transaction");
const Booking = require("../models/Booking");
const { env } = require("../config/env");
const { logger } = require("../config/db");

// Minimal Razorpay mock — no external API calls needed
class MockRazorpay {
  async createOrder({ amount, currency, receipt }) {
    return { id: `order_MOCK${Date.now()}`, amount, currency: currency || "INR", receipt, status: "created" };
  }
  async refundPayment(paymentId, { amount, notes }) {
    return { id: `rfnd_MOCK${Date.now()}`, payment_id: paymentId, amount, notes, status: "processed" };
  }
}

// Mask a key_id for logs: keep the prefix + last 4, hide the middle.
const maskKey = (k) => {
  const s = String(k || "");
  return s.length <= 12 ? s : `${s.slice(0, 12)}…${s.slice(-4)} (len ${s.length})`;
};

class PaymentService {
  constructor() {
    if (env.isPaymentMock) {
      this._mock = new MockRazorpay();
    } else {
      const Razorpay = require("razorpay");
      this._rzp = new Razorpay({ key_id: env.razorpay.keyId, key_secret: env.razorpay.keySecret });
    }
    logger.info("[Payment] PaymentService initialised", {
      isPaymentMock: env.isPaymentMock,
      keyId: maskKey(env.razorpay.keyId),
    });
  }

  _hmac(content, secret) {
    return crypto.createHmac("sha256", secret).update(content).digest("hex");
  }

  verifyPaymentSignature({ orderId, paymentId, signature }) {
    if (env.isPaymentMock) return true;
    const ok = this._hmac(`${orderId}|${paymentId}`, env.razorpay.keySecret) === signature;
    if (!ok) {
      logger.warn("[Payment] Razorpay signature verification FAILED", {
        orderId,
        paymentId,
        signaturePresent: Boolean(signature),
      });
    }
    return ok;
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

    // The frontend mock payment modal was removed — the checkout is always real Razorpay.
    // A mock order + placeholder key would be rejected by the real checkout as
    // "The api key provided is invalid", so fail fast with an actionable message instead.
    if (env.isPaymentMock) {
      logger.error("[Payment] RAZORPAY_KEY_ID is not configured — cannot create a real order", {
        keyId: maskKey(env.razorpay.keyId),
      });
      throw new Error("Payment gateway not configured: set a real RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET and restart the server");
    }

    const order = await this._rzp.orders.create({ amount: amountInPaise, currency: "INR", receipt: bookingId.toString() });
    logger.info("[Payment] Razorpay order created", {
      bookingId: bookingId.toString(),
      orderId: order.id,
      amountInPaise,
      isPaymentMock: env.isPaymentMock,
      keyId: maskKey(env.razorpay.keyId),
    });

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
    if (!transaction) {
      logger.error("[Payment] markPaymentSuccess: no Transaction found for order", { orderId, paymentId });
      throw new Error("Transaction not found for order");
    }
    await Booking.findByIdAndUpdate(transaction.bookingId, { $set: { paymentStatus: "paid", paymentId } });
    logger.info("[Payment] Payment captured — booking marked paid", {
      bookingId: transaction.bookingId.toString(),
      orderId,
      paymentId,
    });
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
