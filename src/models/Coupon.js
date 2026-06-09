const mongoose = require("mongoose");

const schemaOptions = {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
};

const routeSchema = new mongoose.Schema(
  {
    /** Origin route code. */
    origin: { type: String, required: true, trim: true, uppercase: true },
    /** Destination route code. */
    destination: { type: String, required: true, trim: true, uppercase: true }
  },
  { _id: false }
);

const usedBySchema = new mongoose.Schema(
  {
    /** User who used this coupon. */
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    /** Usage timestamp. */
    usedAt: { type: Date, default: Date.now }
  },
  { _id: false }
);

const CouponSchema = new mongoose.Schema(
  {
    /** Coupon code in uppercase. */
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    /** Coupon description. */
    description: { type: String, trim: true },
    /** Discount type (percent/flat). */
    discountType: { type: String, enum: ["percent", "flat"], required: true },
    /** Discount numeric value. */
    discountValue: { type: Number, required: true, min: 0 },
    /** Max discount cap for percent coupons. */
    maxDiscount: { type: Number, min: 0 },
    /** Minimum fare required to apply coupon. */
    minFare: { type: Number, default: 0, min: 0 },
    /** Total usage limit for coupon. */
    usageLimit: { type: Number, required: true, min: 1 },
    /** Number of times coupon already used. */
    usedCount: { type: Number, default: 0, min: 0 },
    /** Max usage per user. */
    perUserLimit: { type: Number, default: 1, min: 1 },
    /** Per-user usage history. */
    usedBy: { type: [usedBySchema], default: [] },
    /** Coupon validity start timestamp. */
    validFrom: { type: Date, required: true },
    /** Coupon validity end timestamp. */
    validTo: { type: Date, required: true },
    /** Whether coupon is active. */
    isActive: { type: Boolean, default: true },
    /** Providers where coupon applies (empty means all). */
    applicableProviders: { type: [String], default: [] },
    /** Route restrictions (empty means all). */
    applicableRoutes: { type: [routeSchema], default: [] },

    // ── Extended offer-type fields ────────────────────────────────────────────
    /** Offer category for display grouping and validation logic. */
    offerType: {
      type: String,
      enum: ["general", "bank_offer", "airline_offer", "cashback", "first_booking", "corporate", "seasonal", "wallet"],
      default: "general"
    },
    /** Bank code restriction — only applies when paid via this bank's card/netbanking. */
    bankCode: { type: String, trim: true, uppercase: true, default: null },
    /** Airline code restriction — e.g. 6E, SG, I5, QP (empty = all airlines). */
    airlineCode: { type: String, trim: true, uppercase: true, default: null },
    /** Payment method restriction. */
    paymentMethod: {
      type: String,
      enum: ["any", "credit_card", "debit_card", "net_banking", "upi", "wallet"],
      default: "any"
    },
    /** Trip type restriction. */
    tripType: {
      type: String,
      enum: ["any", "one_way", "round_trip"],
      default: "any"
    },
    /** Travel class restriction. */
    travelClass: {
      type: String,
      enum: ["any", "economy", "business", "premium_economy"],
      default: "any"
    },
    /** Whether coupon is restricted to first booking only. */
    firstBookingOnly: { type: Boolean, default: false },
    /** Cashback amount credited to wallet (when offerType = cashback). */
    cashbackAmount: { type: Number, min: 0, default: 0 },
    /** Internal notes for ops team. */
    adminNotes: { type: String, trim: true },

    /** User/admin who created coupon. */
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" }
  },
  schemaOptions
);

CouponSchema.index({ isActive: 1 });
CouponSchema.index({ validFrom: 1 });
CouponSchema.index({ validTo: 1 });

const Coupon = mongoose.model("Coupon", CouponSchema);

module.exports = Coupon;
module.exports.Coupon = Coupon;
module.exports.CouponSchema = CouponSchema;
