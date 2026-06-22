const Queue = require("bull");
const { getBullQueueOptions } = require("../config/redis");
const Booking = require("../models/Booking");
const User = require("../models/User");
const EmailService = require("../services/EmailService");
const { logger } = require("../config/db");

const emailQueue = new Queue("email-queue", getBullQueueOptions());

emailQueue.process("booking-confirmation", async (job) => {
  const { bookingId } = job.data;
  const booking = await Booking.findById(bookingId);
  if (!booking) {
    throw new Error("Booking not found for email dispatch");
  }
  const user = await User.findById(booking.userId);
  if (!user) {
    throw new Error("User not found for email dispatch");
  }

  await EmailService.sendBookingConfirmation({
    to: user.email,
    booking,
    pnr: booking.pnrMap?.[booking.flightDetails.provider]
  });
});

emailQueue.on("failed", (job, error) => {
  logger.error("Email job failed", { jobId: job.id, error: error.message });
});

module.exports = {
  emailQueue
};
