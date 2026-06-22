const Queue = require("bull");
const { getBullQueueOptions } = require("../config/redis");
const Notification = require("../models/Notification");
const { logger } = require("../config/db");

const notificationQueue = new Queue("notification-queue", getBullQueueOptions());

notificationQueue.process("dispatch", async (job) => {
  const { notificationId } = job.data;
  const notification = await Notification.findById(notificationId);
  if (!notification) {
    throw new Error("Notification not found");
  }
  notification.status = "sent";
  notification.sentAt = new Date();
  await notification.save();
});

notificationQueue.on("failed", (job, error) => {
  logger.error("Notification job failed", { jobId: job.id, error: error.message });
});

module.exports = {
  notificationQueue
};
