const Queue = require("bull");
const { getBullQueueOptions } = require("../config/redis");
const Booking = require("../models/Booking");
const WhatsAppService = require("../services/WhatsAppService");
const { logger } = require("../config/db");

const whatsappQueue = new Queue("whatsapp-queue", getBullQueueOptions());

whatsappQueue.process("booking-confirmation", async (job) => {
  const { bookingId, pnr } = job.data;
  const booking = await Booking.findById(bookingId);
  if (!booking) throw new Error("Booking not found for WhatsApp dispatch");
  await WhatsAppService.sendBookingConfirmation({ booking, pnr });
});

whatsappQueue.process("booking-cancellation", async (job) => {
  const { bookingId, refundAmount } = job.data;
  const booking = await Booking.findById(bookingId);
  if (!booking) throw new Error("Booking not found for WhatsApp dispatch");
  await WhatsAppService.sendCancellationConfirmation({ booking, refundAmount });
});

whatsappQueue.on("failed", (job, error) => {
  logger.error("WhatsApp job failed", { jobId: job.id, jobName: job.name, error: error.message });
});

module.exports = { whatsappQueue };
