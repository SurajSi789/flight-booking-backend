const mongoose = require("mongoose");

const schemaOptions = {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
};

const AuditLogSchema = new mongoose.Schema(
  {
    /** End-user id involved in action. */
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    /** Admin id executing privileged action. */
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    /** Action name (e.g. BOOKING_CANCELLED). */
    action: { type: String, required: true, trim: true },
    /** Resource type impacted by action. */
    resourceType: { type: String, trim: true },
    /** Resource id impacted by action. */
    resourceId: { type: mongoose.Schema.Types.ObjectId },
    /** Entity state before mutation. */
    before: { type: mongoose.Schema.Types.Mixed },
    /** Entity state after mutation. */
    after: { type: mongoose.Schema.Types.Mixed },
    /** Request IP address. */
    ipAddress: { type: String, trim: true },
    /** Request user-agent string. */
    userAgent: { type: String, trim: true }
  },
  schemaOptions
);

const AuditLog = mongoose.model("AuditLog", AuditLogSchema);

module.exports = AuditLog;
module.exports.AuditLog = AuditLog;
module.exports.AuditLogSchema = AuditLogSchema;
