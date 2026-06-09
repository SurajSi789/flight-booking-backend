const mongoose = require("mongoose");

const schemaOptions = {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
};

const AuditLogSchema = new mongoose.Schema(
  {
    // Polymorphic actor — either a customer User or an AdminUser
    actor:       { type: mongoose.Schema.Types.ObjectId, refPath: "actorModel" },
    actorModel:  { type: String, enum: ["User", "AdminUser"], default: "AdminUser" },

    // Kept for backwards compatibility with existing controller calls
    userId:  { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: "AdminUser" },

    action:       { type: String, required: true, trim: true },
    resourceType: { type: String, trim: true },
    resourceId:   { type: mongoose.Schema.Types.ObjectId },
    before:       { type: mongoose.Schema.Types.Mixed },
    after:        { type: mongoose.Schema.Types.Mixed },
    ipAddress:    { type: String, trim: true },
    userAgent:    { type: String, trim: true },
  },
  schemaOptions
);

AuditLogSchema.index({ actor: 1, createdAt: -1 });
AuditLogSchema.index({ action: 1, createdAt: -1 });
AuditLogSchema.index({ resourceType: 1, resourceId: 1 });

const AuditLog = mongoose.model("AuditLog", AuditLogSchema);

module.exports = AuditLog;
module.exports.AuditLog = AuditLog;
module.exports.AuditLogSchema = AuditLogSchema;
