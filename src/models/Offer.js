const mongoose = require("mongoose");

const schemaOptions = {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
};

const OfferSchema = new mongoose.Schema(
  {
    /** Offer title shown on client surfaces. */
    title:       { type: String, required: true, trim: true },
    /** Offer descriptive text. */
    description: { type: String, required: true, trim: true },
    /** Short badge/tag text — e.g. "UPTO ₹3000 OFF", "FLAT 10%". */
    badgeText:   { type: String, trim: true },
    /** Offer image URL. */
    imageUrl:    { type: String, trim: true },
    /** Linked coupon code (auto-applies on click). */
    couponCode:  { type: String, trim: true, uppercase: true },
    /** Sort/display order. */
    displayOrder: { type: Number, default: 0 },
    /** Whether offer is active. */
    isActive:    { type: Boolean, default: true },
    /** Offer validity start. */
    validFrom:   { type: Date },
    /** Offer validity end. */
    validTo:     { type: Date },
    /** URL users are directed to on click. */
    targetUrl:   { type: String, trim: true },

    // ── Offer classification ──────────────────────────────────────────────────
    /** Offer category — drives display sections and validation. */
    offerType: {
      type: String,
      enum: ["featured", "bank_offer", "airline_offer", "cashback", "seasonal", "corporate", "wallet", "first_booking"],
      default: "featured"
    },
    /** Bank code for bank-specific offers — HDFC, ICICI, SBI, AXIS, KOTAK, YES, AMEX, etc. */
    bankCode:     { type: String, trim: true, uppercase: true, default: null },
    /** Name of the bank as it should appear in UI. */
    bankName:     { type: String, trim: true },
    /** Airline IATA/internal code — 6E (IndiGo), SG (SpiceJet), I5 (AirIndia Express), QP (Akasa). */
    airlineCode:  { type: String, trim: true, uppercase: true, default: null },
    /** Airline display name. */
    airlineName:  { type: String, trim: true },
    /** Payment method restriction for bank offers. */
    paymentMethod: {
      type: String,
      enum: ["any", "credit_card", "debit_card", "net_banking", "upi", "wallet"],
      default: "any"
    },
    /** Full terms and conditions text. */
    termsAndConditions: { type: String, trim: true },
    /** Creator reference (AdminUser). */
    createdBy: { type: mongoose.Schema.Types.ObjectId, refPath: "createdByModel" },
    createdByModel: { type: String, enum: ["User", "AdminUser"], default: "AdminUser" }
  },
  schemaOptions
);

OfferSchema.index({ isActive: 1, displayOrder: 1 });
OfferSchema.index({ offerType: 1 });

const Offer = mongoose.model("Offer", OfferSchema);

module.exports = Offer;
module.exports.Offer = Offer;
module.exports.OfferSchema = OfferSchema;
