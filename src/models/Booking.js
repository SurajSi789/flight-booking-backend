const mongoose = require("mongoose");

const schemaOptions = {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
};

const passengerSchema = new mongoose.Schema(
  {
    /** Passenger first name. */
    firstName: { type: String, required: true, trim: true },
    /** Passenger last name. */
    lastName: { type: String, required: true, trim: true },
    /** Passenger date of birth. */
    dob: { type: Date },
    /** Passenger gender. */
    gender: { type: String, required: true, trim: true },
    /** Passenger type (adult/child/infant). */
    type: { type: String, enum: ["ADT", "CHD", "INF"], required: true },
    /** Passenger passport number. */
    passportNo: { type: String, trim: true },
    /** Passenger nationality. */
    nationality: { type: String, trim: true },
    /** Passenger passport expiry date. */
    passportExpiry: { type: Date },
    /** Seat number assigned to passenger. */
    seatNo: { type: String, trim: true },
    /** Meal preference selected by passenger. */
    mealPreference: { type: String, trim: true },
    /** Extra baggage units purchased by passenger. */
    extraBaggage: { type: Number, min: 0 }
  },
  { _id: false }
);

const ancillarySchema = new mongoose.Schema(
  {
    /** Ancillary type. */
    type: { type: String, enum: ["meal", "baggage", "seat", "fastforward", "lounge"], required: true },
    /** Human readable ancillary description. */
    description: { type: String, trim: true },
    /** Provider passenger id linked for the ancillary. */
    passengerId: { type: String, trim: true },
    /** Ancillary price. */
    price: { type: Number, default: 0, min: 0 },
    /** Ancillary SSR code. */
    ssrCode: { type: String, trim: true },
    /** Ancillary current status. */
    status: { type: String, trim: true }
  },
  { _id: false }
);

const BookingSchema = new mongoose.Schema(
  {
    /** Booking reference identifier. */
    bookingRef: { type: String, required: true, unique: true, trim: true },
    /** User who owns this booking. */
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    /** Flight details from provider. */
    flightDetails: {
      /** Flight provider source. */
      provider: {
        type: String,
        enum: ["indigo", "airindia", "spicejet", "akasaair", "akasa", "flightroutes24"],
        required: true
      },
      /** Flight number. */
      flightNo: { type: String, trim: true },
      /** Origin IATA code. */
      origin: { type: String, trim: true },
      /** Destination IATA code. */
      destination: { type: String, trim: true },
      /** Departure timestamp. */
      departureAt: { type: Date },
      /** Arrival timestamp. */
      arrivalAt: { type: Date },
      /** Cabin class label. */
      cabinClass: { type: String, trim: true },
      /** Fare family label. */
      fareFamily: { type: String, trim: true },
      /** Fare basis code. */
      fareBasis: { type: String, trim: true },
      /** Aircraft model. */
      aircraft: { type: String, trim: true },
      /** Number of stops. */
      stopCount: { type: Number, min: 0, default: 0 },
      /** Individual flight legs for connecting itineraries. */
      segments: {
        type: [
          {
            flightNo: { type: String, trim: true },
            origin: { type: String, trim: true },
            destination: { type: String, trim: true },
            departureAt: { type: Date },
            arrivalAt: { type: Date },
            durationMins: { type: Number }
          }
        ],
        default: []
      }
    },
    /** Passenger list for this booking. */
    passengers: { type: [passengerSchema], default: [] },
    /** Ancillary purchases in booking. */
    ancillaries: { type: [ancillarySchema], default: [] },
    /** Fare composition details. */
    fareBreakdown: {
      /** Base fare amount. */
      baseFare: { type: Number, default: 0, min: 0 },
      /** Tax amount. */
      taxes: { type: Number, default: 0, min: 0 },
      /** Ancillary charge amount. */
      ancillaryCharges: { type: Number, default: 0, min: 0 },
      /** Discount amount applied. */
      discount: { type: Number, default: 0, min: 0 },
      /** Convenience fee amount. */
      convenienceFee: { type: Number, default: 0, min: 0 },
      /** Final total fare amount. */
      totalFare: { type: Number, default: 0, min: 0 },
      /** Booking currency code. */
      currency: { type: String, default: "INR", trim: true }
    },
    /** Applied coupon code. */
    couponCode: { type: String, trim: true },
    /** Current payment status. */
    paymentStatus: {
      type: String,
      enum: ["pending", "paid", "failed", "refund_pending", "refunded"],
      default: "pending"
    },
    /** Razorpay order id associated with booking payment. */
    paymentOrderId: { type: String, trim: true },
    /** Razorpay payment id captured for booking. */
    paymentId: { type: String, trim: true },
    /** Current booking lifecycle status. */
    bookingStatus: {
      type: String,
      enum: ["initiated", "confirmed", "cancelled", "no_show"],
      default: "initiated"
    },
    /** PNR per provider for cross-system mapping. */
    pnrMap: {
      indigo:        { type: String, trim: true },
      airindia:      { type: String, trim: true },
      spicejet:      { type: String, trim: true },
      akasaair:      { type: String, trim: true },
      akasa:         { type: String, trim: true },
      flightroutes24:{ type: String, trim: true }
    },
    /** Timestamp at which booking was cancelled. */
    cancelledAt: { type: Date },
    /** Cancellation reason string. */
    cancellationReason: { type: String, trim: true },
    /** Refund amount for cancellation. */
    refundAmount: { type: Number, min: 0 },
    /** Refund processing status. */
    refundStatus: {
      type: String,
      enum: ["na", "pending", "processed", "failed"],
      default: "na"
    },
    /** Refund processed timestamp. */
    refundProcessedAt: { type: Date },
    /** Redis session key for provider state. */
    sessionStateKey: { type: String, trim: true },
    /** Raw provider metadata payload. */
    providerMeta: { type: mongoose.Schema.Types.Mixed, default: {} },
    /** Whether booking is part of round trip. */
    isRoundTrip: { type: Boolean, default: false },
    /** Linked return booking reference. */
    returnBookingRef: { type: String, trim: true },
    /** leisure = standard B2C; group = 10+ / corporate flow (may split PNR per airline). */
    fareIntent: { type: String, enum: ["leisure", "group"], default: "leisure" }
  },
  schemaOptions
);

BookingSchema.index({ userId: 1 });
BookingSchema.index({ bookingStatus: 1 });
BookingSchema.index({ paymentStatus: 1 });
BookingSchema.index({ "flightDetails.departureAt": 1 });

BookingSchema.pre("validate", function bookingRefGenerator(next) {
  if (this.bookingRef) {
    return next();
  }
  const randomPart = Math.random().toString(36).slice(2, 6).toUpperCase();
  this.bookingRef = `BK${Date.now()}${randomPart}`;
  return next();
});

/**
 * Find a booking by booking reference.
 * @param {string} bookingRef
 * @returns {Promise<import("mongoose").Document|null>}
 */
BookingSchema.statics.findByRef = function findByRef(bookingRef) {
  return this.findOne({ bookingRef: String(bookingRef).trim().toUpperCase() });
};

const Booking = mongoose.model("Booking", BookingSchema);

module.exports = Booking;
module.exports.Booking = Booking;
module.exports.BookingSchema = BookingSchema;
