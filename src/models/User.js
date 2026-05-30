const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

const schemaOptions = {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
};

const TravellerSchema = new mongoose.Schema(
  {
    /** Traveller first name. */
    firstName: { type: String, trim: true },
    /** Traveller last name. */
    lastName: { type: String, trim: true },
    /** Traveller date of birth. */
    dob: { type: Date },
    /** Traveller gender (M/F). */
    gender: { type: String, enum: ["M", "F"] },
    /** Traveller passport number. */
    passportNo: { type: String, trim: true },
    /** Traveller nationality. */
    nationality: { type: String, trim: true },
    /** Whether this traveller is the default profile. */
    isDefault: { type: Boolean, default: false }
  }
);

const walletTransactionSchema = new mongoose.Schema(
  {
    /** Wallet transaction amount. */
    amount: { type: Number, required: true, min: 0 },
    /** Wallet transaction type (credit/debit). */
    type: { type: String, enum: ["credit", "debit"], required: true },
    /** Business reason for wallet transaction. */
    reason: { type: String, required: true, trim: true },
    /** Wallet transaction timestamp. */
    date: { type: Date, default: Date.now }
  },
  { _id: false }
);

const UserSchema = new mongoose.Schema(
  {
    /** User name object. */
    name: {
      /** First name. */
      first: { type: String, required: true, trim: true },
      /** Last name. */
      last: { type: String, required: true, trim: true }
    },
    /** User email address. */
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    /** User phone number. */
    phone: { type: String, required: true, trim: true },
    /** Bcrypt-hashed password, never returned by default. */
    passwordHash: { type: String, required: true, select: false },
    /** Application role. */
    role: { type: String, enum: ["user", "admin", "corporate"], default: "user" },
    /** Login type distinguishes regular from corporate accounts. */
    loginType: { type: String, enum: ["user", "corporate"], default: "user" },
    /** Employee ID for corporate accounts. */
    employeeId: { type: String, sparse: true, trim: true, default: null },
    /** Company name for corporate accounts. */
    company: { type: String, trim: true, default: null },
    /** Whether user account is verified. */
    isVerified: { type: Boolean, default: false },
    /** OTP hash for verification/login challenge. */
    otpHash: { type: String, select: false },
    /** OTP expiry date-time. */
    otpExpiry: { type: Date },
    /** Saved traveller profiles (max 10). */
    savedTravellers: {
      type: [TravellerSchema],
      default: [],
      validate: {
        validator: (value) => Array.isArray(value) && value.length <= 10,
        message: "savedTravellers cannot exceed 10 entries"
      }
    },
    /** Available wallet balance. */
    walletBalance: { type: Number, default: 0, min: 0 },
    /** Wallet ledger entries. */
    walletTransactions: { type: [walletTransactionSchema], default: [] },
    /** Refresh token hash for token rotation/revocation. */
    refreshTokenHash: { type: String, select: false },
    /** Version counter used to invalidate old refresh tokens. */
    tokenVersion: { type: Number, default: 0, min: 0 },
    /** Last successful login timestamp. */
    lastLoginAt: { type: Date },
    /** Soft active/inactive account flag. */
    isActive: { type: Boolean, default: true }
  },
  schemaOptions
);

UserSchema.index({ phone: 1 });

UserSchema.pre("save", async function userPreSave(next) {
  if (!this.isModified("passwordHash")) {
    return next();
  }
  if (typeof this.passwordHash === "string" && this.passwordHash.startsWith("$2")) {
    return next();
  }
  this.passwordHash = await bcrypt.hash(this.passwordHash, 12);
  return next();
});

/**
 * Fetch user by normalized email.
 * @param {string} email
 * @returns {Promise<import("mongoose").Document|null>}
 */
UserSchema.statics.findByEmail = function findByEmail(email) {
  return this.findOne({ email: String(email).trim().toLowerCase() });
};

/**
 * Compare plain password with stored bcrypt hash.
 * @param {string} plainPassword
 * @returns {Promise<boolean>}
 */
UserSchema.methods.comparePassword = function comparePassword(plainPassword) {
  return bcrypt.compare(plainPassword, this.passwordHash);
};

/**
 * Generate OTP, persist hashed OTP and expiry on the user instance.
 * @param {number} ttlMinutes
 * @returns {string} raw OTP for delivery channel
 */
UserSchema.methods.generateOTP = function generateOTP(ttlMinutes = 10) {
  const rawOtp = String(Math.floor(100000 + Math.random() * 900000));
  this.otpHash = crypto.createHash("sha256").update(rawOtp).digest("hex");
  this.otpExpiry = new Date(Date.now() + ttlMinutes * 60 * 1000); // miliseconds
  return rawOtp;
};

const User = mongoose.model("User", UserSchema);

module.exports = User;
module.exports.User = User;
module.exports.UserSchema = UserSchema;
module.exports.TravellerSchema = TravellerSchema;
