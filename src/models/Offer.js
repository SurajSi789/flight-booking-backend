const mongoose = require("mongoose");

const schemaOptions = {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
};

const OfferSchema = new mongoose.Schema(
  {
    /** Offer title shown on client surfaces. */
    title: { type: String, required: true, trim: true },
    /** Offer descriptive text. */
    description: { type: String, required: true, trim: true },
    /** Offer image URL. */
    imageUrl: { type: String, trim: true },
    /** Linked coupon code. */
    couponCode: { type: String, trim: true, uppercase: true },
    /** Sort/display order. */
    displayOrder: { type: Number, default: 0 },
    /** Whether offer is active. */
    isActive: { type: Boolean, default: true },
    /** Offer validity start. */
    validFrom: { type: Date },
    /** Offer validity end. */
    validTo: { type: Date },
    /** URL users are directed to on click. */
    targetUrl: { type: String, trim: true },
    /** Creator reference. */
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" }
  },
  schemaOptions
);

const Offer = mongoose.model("Offer", OfferSchema);

module.exports = Offer;
module.exports.Offer = Offer;
module.exports.OfferSchema = OfferSchema;
