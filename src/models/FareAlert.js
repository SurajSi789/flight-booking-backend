const mongoose = require("mongoose");

const schemaOptions = {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
};

const FareAlertSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    origin: { type: String, required: true, uppercase: true, trim: true },
    destination: { type: String, required: true, uppercase: true, trim: true },
    travelDate: { type: Date, required: true },
    maxFare: { type: Number, required: true, min: 1 },
    adults: { type: Number, default: 1, min: 1, max: 30 },
    children: { type: Number, default: 0, min: 0, max: 8 },
    infants: { type: Number, default: 0, min: 0, max: 4 },
    isActive: { type: Boolean, default: true },
    lastNotifiedAt: { type: Date },
    lastNotifiedFare: { type: Number }
  },
  schemaOptions
);

FareAlertSchema.index({ userId: 1, isActive: 1 });

const FareAlert = mongoose.model("FareAlert", FareAlertSchema);

module.exports = FareAlert;
