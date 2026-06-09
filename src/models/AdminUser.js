const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const ADMIN_ROLES = {
  SUPER_ADMIN: "super_admin",
  OPS_ADMIN:   "ops_admin",
  FINANCE:     "finance",
  SUPPORT:     "support",
  READ_ONLY:   "read_only",
};

const ROLE_PERMISSIONS = {
  super_admin: ["*"],
  ops_admin: [
    "dashboard:read",
    "bookings:read", "bookings:write", "bookings:cancel",
    "users:read",
    "fare_sync:write",
    "alerts:write",
    "notifications:write",
    "coupons:read", "coupons:write",
    "offers:read", "offers:write",
    "reports:bookings",
  ],
  finance: [
    "dashboard:read",
    "bookings:read",
    "refunds:read", "refunds:approve",
    "reports:revenue", "reports:bookings", "reports:refunds",
  ],
  support: [
    "dashboard:read",
    "bookings:read",
    "users:read",
    "queries:read", "queries:write",
    "notifications:write",
  ],
  read_only: [
    "dashboard:read",
    "bookings:read",
    "users:read",
    "reports:bookings",
  ],
};

const AdminUserSchema = new mongoose.Schema(
  {
    name:          { type: String, required: true, trim: true },
    email:         { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash:  { type: String, required: true, select: false },
    adminRole:     { type: String, enum: Object.values(ADMIN_ROLES), required: true },
    isActive:      { type: Boolean, default: true },
    mfaSecret:     { type: String, select: false },
    mfaEnabled:    { type: Boolean, default: false },
    lastLoginAt:   { type: Date },
    lastLoginIp:   { type: String },
    loginAttempts: { type: Number, default: 0 },
    lockedUntil:   { type: Date },
    createdBy:     { type: mongoose.Schema.Types.ObjectId, ref: "AdminUser", default: null },
  },
  { timestamps: true }
);

AdminUserSchema.pre("save", async function (next) {
  if (!this.isModified("passwordHash")) return next();
  if (this.passwordHash.startsWith("$2")) return next();
  this.passwordHash = await bcrypt.hash(this.passwordHash, 14);
  next();
});

AdminUserSchema.methods.comparePassword = function (plain) {
  return bcrypt.compare(plain, this.passwordHash);
};

AdminUserSchema.methods.hasPermission = function (permission) {
  const perms = ROLE_PERMISSIONS[this.adminRole] || [];
  return perms.includes("*") || perms.includes(permission);
};

const AdminUser = mongoose.model("AdminUser", AdminUserSchema);

module.exports = AdminUser;
module.exports.AdminUser = AdminUser;
module.exports.ADMIN_ROLES = ADMIN_ROLES;
module.exports.ROLE_PERMISSIONS = ROLE_PERMISSIONS;
