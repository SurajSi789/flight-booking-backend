const mongoose = require("mongoose");

const schemaOptions = {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
};

const TransactionSchema = new mongoose.Schema(
  {
    /** Associated booking id. */
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", required: true },
    /** User associated with transaction. */
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    /** Transaction amount. */
    amount: { type: Number, required: true, min: 0 },
    /** Currency code for amount. */
    currency: { type: String, default: "INR", trim: true },
    /** Payment gateway. */
    gateway: { type: String, enum: ["razorpay", "stripe", "wallet"] },
    /** Gateway order identifier. */
    gatewayOrderId: { type: String, trim: true },
    /** Gateway transaction identifier. */
    gatewayTxnId: { type: String, unique: true, sparse: true, trim: true },
    /** Transaction type. */
    type: { type: String, enum: ["charge", "refund", "wallet_debit", "wallet_credit"] },
    /** Current transaction status. */
    status: { type: String, enum: ["pending", "success", "failed", "refund_initiated"] },
    /** Raw gateway response object. */
    gatewayResponse: { type: mongoose.Schema.Types.Mixed, default: {} },
    /** Failure reason from gateway or business logic. */
    failureReason: { type: String, trim: true },
    /** Refund lifecycle state when transaction is refund. */
    refundStatus: { type: String, enum: ["pending", "processed", "failed"], default: "pending" },
    /** Additional metadata. */
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
  },
  schemaOptions
);

TransactionSchema.index({ bookingId: 1 });
TransactionSchema.index({ userId: 1 });
TransactionSchema.index({ status: 1 });

const Transaction = mongoose.model("Transaction", TransactionSchema);

module.exports = Transaction;
module.exports.Transaction = Transaction;
module.exports.TransactionSchema = TransactionSchema;
