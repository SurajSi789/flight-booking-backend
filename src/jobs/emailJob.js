const Queue = require("bull");
const { getBullQueueOptions } = require("../config/redis");
const Booking = require("../models/Booking");
const User = require("../models/User");
const EmailService = require("../services/EmailService");
const { generateTicketPDFBuffer } = require("../utils/ticketPdf");
const { logger } = require("../config/db");

const emailQueue = new Queue("email-queue", getBullQueueOptions());

emailQueue.process("booking-confirmation", async (job) => {
  const { bookingId } = job.data;
  const booking = await Booking.findById(bookingId);
  if (!booking) throw new Error("Booking not found for email dispatch");

  const user = await User.findById(booking.userId);
  if (!user) throw new Error("User not found for email dispatch");

  const pnr = booking.pnrMap?.[booking.flightDetails.provider] || null;
  const userName = user.name || user.firstName || user.email;
  const pdfBuffer = await generateTicketPDFBuffer(booking);

  // Always send to the registered account email
  await EmailService.sendBookingConfirmation({
    to: user.email,
    booking,
    pnr,
    userName,
    pdfBuffer,
  });

  // Also send to the contact email provided at booking time, if it differs from the account email
  const contactEmail = booking.contactEmail;
  if (contactEmail && contactEmail.toLowerCase() !== user.email.toLowerCase()) {
    await EmailService.sendBookingConfirmation({
      to: contactEmail,
      booking,
      pnr,
      userName,
      pdfBuffer,
    });
  }
});

emailQueue.on("failed", (job, error) => {
  logger.error("Email job failed", { jobId: job.id, error: error.message });
});

module.exports = { emailQueue };
