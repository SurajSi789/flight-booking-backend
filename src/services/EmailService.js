const nodemailer = require("nodemailer");
const { env } = require("../config/env");

class EmailService {
  constructor() {
    this.transport = nodemailer.createTransport({
      host: env.smtp.host,
      auth: {
        user: env.smtp.user,
        pass: env.smtp.pass
      }
    });
  }

  async send({ to, subject, html }) {
    return this.transport.sendMail({
      from: env.smtp.from,
      to,
      subject,
      html
    });
  }

  buildBaseTemplate({ title, subtitle, contentHtml }) {
    return `
      <div style="font-family:Arial,Helvetica,sans-serif;background:#f6f8fb;padding:24px;color:#1f2937;">
        <div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:12px;padding:24px;border:1px solid #e5e7eb;">
          <h2 style="margin:0 0 8px;font-size:24px;color:#111827;">${title}</h2>
          <p style="margin:0 0 20px;font-size:14px;color:#4b5563;">${subtitle}</p>
          <div style="font-size:14px;line-height:1.6;color:#111827;">${contentHtml}</div>
          <p style="margin-top:24px;font-size:12px;color:#6b7280;">
            Flight Booking Platform Team
          </p>
        </div>
      </div>
    `;
  }

  async sendOTPEmail({ to, otp, name }) {
    const html = this.buildBaseTemplate({
      title: "Verify your email",
      subtitle: "Complete your account verification",
      contentHtml: `
        <p>Hi ${name || "there"},</p>
        <p>Use the OTP below to verify your account. It expires in 10 minutes.</p>
        <div style="display:inline-block;padding:12px 20px;background:#111827;color:#ffffff;border-radius:8px;font-size:20px;letter-spacing:3px;font-weight:700;">
          ${otp}
        </div>
        <p style="margin-top:16px;">If you did not request this, you can ignore this email.</p>
      `
    });
    return this.send({
      to,
      subject: "Your OTP for account verification",
      html
    });
  }

  async sendBookingConfirmation({ to, booking, pnr }) {
    const html = this.buildBaseTemplate({
      title: "Booking Confirmed",
      subtitle: "Your flight booking is now confirmed",
      contentHtml: `
        <p>Your booking has been confirmed successfully.</p>
        <p><strong>Booking Ref:</strong> ${booking?.bookingRef || "N/A"}</p>
        <p><strong>PNR:</strong> ${pnr || "N/A"}</p>
        <p><strong>Total Fare:</strong> ${booking?.fareBreakdown?.totalFare || "N/A"} ${booking?.fareBreakdown?.currency || "INR"}</p>
      `
    });
    return this.send({
      to,
      subject: "Flight booking confirmation",
      html
    });
  }

  async sendCancellationConfirmation({ to, booking, refundAmount }) {
    const html = this.buildBaseTemplate({
      title: "Booking Cancelled",
      subtitle: "Your cancellation request is processed",
      contentHtml: `
        <p>Your booking has been cancelled.</p>
        <p><strong>Booking Ref:</strong> ${booking?.bookingRef || "N/A"}</p>
        <p><strong>Refund Amount:</strong> ${refundAmount || 0} ${booking?.fareBreakdown?.currency || "INR"}</p>
      `
    });
    return this.send({
      to,
      subject: "Flight cancellation confirmation",
      html
    });
  }

  async sendPasswordResetEmail({ to, resetLink }) {
    const html = this.buildBaseTemplate({
      title: "Reset your password",
      subtitle: "You requested a password reset",
      contentHtml: `
        <p>Click the button below to reset your password. This link expires in 30 minutes.</p>
        <a href="${resetLink}" style="display:inline-block;padding:10px 16px;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;">
          Reset Password
        </a>
        <p style="margin-top:16px;word-break:break-all;">If the button does not work, use this link: ${resetLink}</p>
      `
    });
    return this.send({
      to,
      subject: "Reset your password",
      html
    });
  }
}

module.exports = new EmailService();
