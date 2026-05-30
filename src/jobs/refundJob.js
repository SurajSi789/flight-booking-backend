const Queue = require("bull");
const { getQueueRedisConfig } = require("../config/redis");
const Booking = require("../models/Booking");
const Transaction = require("../models/Transaction");
const { logger } = require("../config/db");

const refundQueue = new Queue("refund-queue", getQueueRedisConfig());

refundQueue.process("process-refund", async (job) => {
  const { bookingId } = job.data;
  const booking = await Booking.findById(bookingId);
  if (!booking) {
    throw new Error("Booking not found for refund");
  }

  const transaction = await Transaction.findOne({ bookingId: booking._id });
  if (!transaction) {
    throw new Error("Transaction not found for refund");
  }

  transaction.status = "refunded";
  booking.bookingStatus = "cancelled";
  booking.paymentStatus = "refunded";
  booking.refundStatus = "processed";
  booking.refundProcessedAt = new Date();
  booking.cancelledAt = new Date();
  booking.refundAmount = transaction.amount;
  await Promise.all([transaction.save(), booking.save()]);
});

refundQueue.on("failed", (job, error) => {
  logger.error("Refund job failed", { jobId: job.id, error: error.message });
});

module.exports = {
  refundQueue
};
