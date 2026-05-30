const mongoose = require("mongoose");

const schemaOptions = {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
};

const NotificationSchema = new mongoose.Schema(
  {
    /** Recipient user id (null means broadcast). */
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    /** Notification channel/type. */
    type: { type: String, enum: ["email", "push", "sms", "in_app"], required: true },
    /** Notification title. */
    title: { type: String, required: true, trim: true },
    /** Notification body content. */
    body: { type: String, required: true, trim: true },
    /** Extra data payload. */
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    /** Read/unread flag for in-app. */
    isRead: { type: Boolean, default: false },
    /** Timestamp when marked read. */
    readAt: { type: Date },
    /** Timestamp when message was sent. */
    sentAt: { type: Date },
    /** Delivery status for outbound channels. */
    deliveryStatus: {
      type: String,
      enum: ["pending", "sent", "failed"],
      default: "pending"
    },
    /** Failure reason when delivery fails. */
    failureReason: { type: String, trim: true }
  },
  schemaOptions
);

NotificationSchema.index({ userId: 1 });
NotificationSchema.index({ isRead: 1 });
NotificationSchema.index({ deliveryStatus: 1 });

const Notification = mongoose.model("Notification", NotificationSchema);

module.exports = Notification;
module.exports.Notification = Notification;
module.exports.NotificationSchema = NotificationSchema;
