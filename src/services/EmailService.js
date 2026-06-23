const nodemailer = require("nodemailer");
const { env } = require("../config/env");

const IST = "Asia/Kolkata";

function fmtTime(d) {
  if (!d) return "N/A";
  return new Date(d).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: IST });
}

function fmtDate(d) {
  if (!d) return "N/A";
  return new Date(d).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: IST });
}

function durationStr(dep, arr) {
  if (!dep || !arr) return "";
  const mins = Math.round((new Date(arr) - new Date(dep)) / 60000);
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function paxTypeLabel(t) {
  return t === "ADT" ? "Adult" : t === "CHD" ? "Child" : "Infant";
}

class EmailService {
  constructor() {
    if (!env.smtp.host) {
      this.transport = null;
      return;
    }
    this.transport = nodemailer.createTransport({
      host: env.smtp.host,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === "true",
      auth: { user: env.smtp.user, pass: env.smtp.pass }
    });
  }

  async send({ to, subject, html, attachments = [] }) {
    if (!this.transport) {
      console.warn(`[EmailService] SMTP not configured — skipping email to ${to}: ${subject}`);
      return null;
    }
    return this.transport.sendMail({ from: env.smtp.from, to, subject, html, attachments });
  }

  // ── Base layout wrapper ──────────────────────────────────────────────────
  _wrap(bodyHtml) {
    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SkyBook</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f1f5f9;padding:24px 0;">
  <tr><td align="center">
    <table width="620" cellpadding="0" cellspacing="0" border="0" style="max-width:620px;width:100%;">

      <!-- Header -->
      <tr><td style="background:#0f172a;border-radius:12px 12px 0 0;padding:24px 32px;">
        <table width="100%" cellpadding="0" cellspacing="0"><tr>
          <td><span style="font-size:22px;font-weight:700;color:#ffffff;letter-spacing:-0.5px;">✈ SkyBook</span><br>
              <span style="font-size:11px;color:#94a3b8;">Flight Booking Platform</span></td>
          <td align="right"><span style="font-size:11px;color:#64748b;">E-Ticket &amp; Booking Confirmation</span></td>
        </tr></table>
      </td></tr>

      <!-- Body -->
      <tr><td style="background:#ffffff;padding:32px;border-left:1px solid #e2e8f0;border-right:1px solid #e2e8f0;">
        ${bodyHtml}
      </td></tr>

      <!-- Footer -->
      <tr><td style="background:#0f172a;border-radius:0 0 12px 12px;padding:20px 32px;text-align:center;">
        <p style="margin:0 0 4px;font-size:12px;color:#94a3b8;">Happy journey! ✈</p>
        <p style="margin:0;font-size:11px;color:#475569;">
          SkyBook · <a href="mailto:support@skybook.in" style="color:#64748b;">support@skybook.in</a> · 1800-XXX-XXXX
        </p>
      </td></tr>

    </table>
  </td></tr>
</table>
</body></html>`;
  }

  // ── Booking confirmation email ────────────────────────────────────────────
  _buildBookingConfirmationHtml({ booking, pnr, userName }) {
    const fd = booking.flightDetails || {};
    const fare = booking.fareBreakdown || {};
    const currency = fare.currency || "INR";
    const sym = currency === "INR" ? "₹" : currency;
    const fmtMoney = (n) => `${sym}${(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;
    const isRoundTrip = !!booking.returnFlightDetails?.origin;

    const renderFlightBlock = (f, label) => {
      const dur = durationStr(f.departureAt, f.arrivalAt);
      return `
      <!-- ${label} -->
      <p style="margin:0 0 6px;font-size:10px;font-weight:700;color:#64748b;letter-spacing:0.8px;text-transform:uppercase;">${label}</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:0;margin-bottom:16px;">
        <tr>
          <td style="padding:16px 20px;" width="34%">
            <div style="font-size:28px;font-weight:700;color:#0f172a;line-height:1;">${f.origin || "—"}</div>
            <div style="font-size:16px;font-weight:600;color:#1e293b;margin-top:2px;">${fmtTime(f.departureAt)}</div>
            <div style="font-size:11px;color:#64748b;margin-top:2px;">${fmtDate(f.departureAt)}</div>
          </td>
          <td style="padding:16px 0;text-align:center;" width="32%">
            <div style="font-size:11px;color:#64748b;">${dur}</div>
            <div style="font-size:18px;color:#94a3b8;margin:2px 0;">──────►</div>
            <div style="font-size:10px;color:#94a3b8;">${f.stopCount ? `${f.stopCount} stop${f.stopCount > 1 ? "s" : ""}` : "Non-stop"}</div>
          </td>
          <td style="padding:16px 20px;text-align:right;" width="34%">
            <div style="font-size:28px;font-weight:700;color:#0f172a;line-height:1;">${f.destination || "—"}</div>
            <div style="font-size:16px;font-weight:600;color:#1e293b;margin-top:2px;">${fmtTime(f.arrivalAt)}</div>
            <div style="font-size:11px;color:#64748b;margin-top:2px;">${fmtDate(f.arrivalAt)}</div>
          </td>
        </tr>
        <tr><td colspan="3" style="border-top:1px solid #e2e8f0;padding:10px 20px;">
          <table width="100%" cellpadding="0" cellspacing="0"><tr>
            <td style="font-size:11px;color:#475569;">
              <strong>${f.flightNo || "N/A"}</strong> &nbsp;·&nbsp; ${f.cabinClass || "Economy"} ${f.fareFamily ? `· ${f.fareFamily}` : ""}
            </td>
            <td align="right" style="font-size:11px;color:#475569;">PNR: <strong style="color:#0f172a;">${pnr || "—"}</strong></td>
          </tr></table>
        </td></tr>
      </table>`;
    };

    const passengerRows = booking.passengers.map((p, i) => `
      <tr style="background:${i % 2 === 0 ? "#ffffff" : "#f8fafc"};">
        <td style="padding:10px 12px;font-size:13px;color:#111827;">${p.firstName} ${p.lastName}</td>
        <td style="padding:10px 12px;font-size:12px;color:#374151;">${paxTypeLabel(p.type)}</td>
        <td style="padding:10px 12px;font-size:12px;color:#374151;">${p.seatNo || "—"}</td>
        <td style="padding:10px 12px;font-size:12px;font-weight:600;color:#16a34a;">Confirmed</td>
      </tr>`).join("");

    const fareRows = [
      ["Base Fare", fmtMoney(fare.baseFare)],
      ["Taxes & Fees", fmtMoney(fare.taxes)],
      ["Convenience Fee", fmtMoney(fare.convenienceFee)],
      ...(fare.ancillaryCharges > 0 ? [["Ancillary Charges", fmtMoney(fare.ancillaryCharges)]] : []),
      ...(fare.discount > 0 ? [["Discount Applied", `<span style="color:#16a34a;">-${fmtMoney(fare.discount)}</span>`]] : []),
      ...(fare.walletDebit > 0 ? [["Wallet Debit", `<span style="color:#16a34a;">-${fmtMoney(fare.walletDebit)}</span>`]] : []),
    ];

    const fareRowsHtml = fareRows.map(([label, val]) => `
      <tr>
        <td style="padding:8px 12px;font-size:13px;color:#374151;border-bottom:1px solid #f1f5f9;">${label}</td>
        <td style="padding:8px 12px;font-size:13px;color:#374151;border-bottom:1px solid #f1f5f9;text-align:right;">${val}</td>
      </tr>`).join("");

    return `
      <!-- Hero -->
      <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px 20px;margin-bottom:24px;">
        <table width="100%" cellpadding="0" cellspacing="0"><tr>
          <td>
            <div style="font-size:20px;font-weight:700;color:#15803d;">✓ Booking Confirmed</div>
            <div style="font-size:13px;color:#166534;margin-top:4px;">Hi ${userName.first+" "+userName.last || "there"}, your flight booking is confirmed.</div>
          </td>
          <td align="right" style="vertical-align:top;">
            <div style="font-size:11px;color:#64748b;">Booking Ref</div>
            <div style="font-size:16px;font-weight:700;color:#0f172a;">${booking.bookingRef}</div>
          </td>
        </tr></table>
      </div>

      <!-- Flight(s) -->
      ${renderFlightBlock(fd, isRoundTrip ? "Outbound Flight" : "Flight Details")}
      ${isRoundTrip && booking.returnFlightDetails?.origin ? renderFlightBlock(booking.returnFlightDetails, "Return Flight") : ""}

      <!-- Passengers -->
      <p style="margin:20px 0 8px;font-size:10px;font-weight:700;color:#64748b;letter-spacing:0.8px;text-transform:uppercase;">Passengers</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;border-collapse:separate;border-spacing:0;">
        <thead>
          <tr style="background:#f8fafc;">
            <th style="padding:9px 12px;font-size:11px;font-weight:600;color:#64748b;text-align:left;border-bottom:1px solid #e2e8f0;">Name</th>
            <th style="padding:9px 12px;font-size:11px;font-weight:600;color:#64748b;text-align:left;border-bottom:1px solid #e2e8f0;">Type</th>
            <th style="padding:9px 12px;font-size:11px;font-weight:600;color:#64748b;text-align:left;border-bottom:1px solid #e2e8f0;">Seat</th>
            <th style="padding:9px 12px;font-size:11px;font-weight:600;color:#64748b;text-align:left;border-bottom:1px solid #e2e8f0;">Status</th>
          </tr>
        </thead>
        <tbody>${passengerRows}</tbody>
      </table>

      <!-- Baggage -->
      <p style="margin:20px 0 8px;font-size:10px;font-weight:700;color:#64748b;letter-spacing:0.8px;text-transform:uppercase;">Baggage Allowance</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;border-collapse:separate;border-spacing:0;">
        <thead>
          <tr style="background:#f8fafc;">
            <th style="padding:9px 12px;font-size:11px;font-weight:600;color:#64748b;text-align:left;border-bottom:1px solid #e2e8f0;">Passenger</th>
            <th style="padding:9px 12px;font-size:11px;font-weight:600;color:#64748b;text-align:left;border-bottom:1px solid #e2e8f0;">Cabin</th>
            <th style="padding:9px 12px;font-size:11px;font-weight:600;color:#64748b;text-align:left;border-bottom:1px solid #e2e8f0;">Check-in</th>
          </tr>
        </thead>
        <tbody>
          ${booking.passengers.map((p, i) => `
          <tr style="background:${i % 2 === 0 ? "#ffffff" : "#f8fafc"};">
            <td style="padding:9px 12px;font-size:12px;color:#374151;">${p.firstName} ${p.lastName}</td>
            <td style="padding:9px 12px;font-size:12px;color:#374151;">${p.type === "INF" ? "0 Kg" : "7 Kg"}</td>
            <td style="padding:9px 12px;font-size:12px;color:#374151;">${p.type === "INF" ? "10 Kg" : p.extraBaggage ? `${15 + p.extraBaggage * 5} Kg` : "15 Kg (1 piece only)"}</td>
          </tr>`).join("")}
        </tbody>
      </table>

      <!-- Payment summary -->
      <p style="margin:20px 0 8px;font-size:10px;font-weight:700;color:#64748b;letter-spacing:0.8px;text-transform:uppercase;">Payment Summary</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;border-collapse:separate;border-spacing:0;">
        <tbody>
          ${fareRowsHtml}
          <tr style="background:#0f172a;">
            <td style="padding:12px;font-size:14px;font-weight:700;color:#ffffff;">Order Total</td>
            <td style="padding:12px;font-size:14px;font-weight:700;color:#ffffff;text-align:right;">${fmtMoney(fare.totalFare)}</td>
          </tr>
        </tbody>
      </table>

      <!-- Important info -->
      <div style="margin-top:24px;background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:16px 20px;">
        <p style="margin:0 0 10px;font-size:11px;font-weight:700;color:#92400e;letter-spacing:0.6px;text-transform:uppercase;">Important Information</p>
        <ul style="margin:0;padding-left:16px;">
          <li style="font-size:12px;color:#78350f;margin-bottom:6px;">Check-in counters open 2 hours before departure. Arrive at least 2 hours prior.</li>
          <li style="font-size:12px;color:#78350f;margin-bottom:6px;">Carry a valid government-issued photo ID for all passengers.</li>
          <li style="font-size:12px;color:#78350f;margin-bottom:6px;">Show this e-ticket (printed or digital) at check-in.</li>
          <li style="font-size:12px;color:#78350f;margin-bottom:6px;">For infant travellers, a date of birth certificate is mandatory.</li>
          <li style="font-size:12px;color:#78350f;">Failure to check in without prior cancellation will be treated as a No Show.</li>
        </ul>
      </div>

      <!-- PDF notice -->
      <p style="margin-top:20px;font-size:12px;color:#64748b;text-align:center;">
        Your e-ticket is attached to this email as a PDF. Please save it for check-in.
      </p>
    `;
  }

  // ── Public email methods ─────────────────────────────────────────────────

  async sendOTPEmail({ to, otp, name }) {
    const body = `
      <p style="margin:0 0 12px;font-size:15px;color:#1e293b;">Hi <strong>${name || "there"}</strong>,</p>
      <p style="margin:0 0 20px;font-size:14px;color:#374151;">Use the OTP below to verify your account. It expires in <strong>10 minutes</strong>.</p>
      <div style="display:inline-block;padding:16px 28px;background:#0f172a;color:#ffffff;border-radius:8px;font-size:28px;letter-spacing:6px;font-weight:700;margin-bottom:20px;">${otp}</div>
      <p style="font-size:12px;color:#94a3b8;">If you did not request this, you can safely ignore this email.</p>
    `;
    return this.send({ to, subject: "Your OTP – SkyBook Account Verification", html: this._wrap(body) });
  }

  async sendBookingConfirmation({ to, booking, pnr, userName, pdfBuffer }) {
    const html = this._wrap(this._buildBookingConfirmationHtml({ booking, pnr, userName }));
    const attachments = pdfBuffer ? [{
      filename: `eticket-${booking.bookingRef}.pdf`,
      content: pdfBuffer,
      contentType: "application/pdf"
    }] : [];
    return this.send({
      to,
      subject: `Booking Confirmed – ${pnr || booking.bookingRef} | SkyBook`,
      html,
      attachments
    });
  }

  async sendCancellationConfirmation({ to, booking, refundAmount }) {
    const currency = booking?.fareBreakdown?.currency || "INR";
    const sym = currency === "INR" ? "₹" : currency;
    const fmtMoney = (n) => `${sym}${(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;

    const body = `
      <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:16px 20px;margin-bottom:24px;">
        <div style="font-size:20px;font-weight:700;color:#b91c1c;">✕ Booking Cancelled</div>
        <div style="font-size:13px;color:#991b1b;margin-top:4px;">Your booking has been successfully cancelled.</div>
      </div>
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;border-collapse:separate;border-spacing:0;margin-bottom:20px;">
        <tr><td style="padding:12px 16px;font-size:13px;color:#374151;border-bottom:1px solid #f1f5f9;">Booking Ref</td>
            <td style="padding:12px 16px;font-size:13px;font-weight:600;color:#0f172a;text-align:right;border-bottom:1px solid #f1f5f9;">${booking?.bookingRef || "N/A"}</td></tr>
        <tr><td style="padding:12px 16px;font-size:13px;color:#374151;border-bottom:1px solid #f1f5f9;">Route</td>
            <td style="padding:12px 16px;font-size:13px;color:#0f172a;text-align:right;border-bottom:1px solid #f1f5f9;">${booking?.flightDetails?.origin || "—"} → ${booking?.flightDetails?.destination || "—"}</td></tr>
        <tr style="background:#f0fdf4;"><td style="padding:12px 16px;font-size:13px;font-weight:600;color:#374151;">Refund Amount</td>
            <td style="padding:12px 16px;font-size:15px;font-weight:700;color:#15803d;text-align:right;">${fmtMoney(refundAmount)}</td></tr>
      </table>
      <p style="font-size:12px;color:#64748b;">Refunds to card take 5–7 business days. Wallet refunds are instant. For help, contact support.</p>
    `;
    return this.send({
      to,
      subject: `Booking Cancelled – ${booking?.bookingRef} | SkyBook`,
      html: this._wrap(body)
    });
  }

  async sendPasswordResetEmail({ to, resetLink }) {
    const body = `
      <p style="margin:0 0 12px;font-size:15px;color:#1e293b;">We received a request to reset your SkyBook password.</p>
      <p style="margin:0 0 24px;font-size:14px;color:#374151;">Click the button below to reset it. This link expires in <strong>30 minutes</strong>.</p>
      <a href="${resetLink}" style="display:inline-block;padding:12px 28px;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;">Reset Password</a>
      <p style="margin-top:24px;font-size:12px;color:#94a3b8;">If you didn't request this, you can ignore this email. Your password will not change.</p>
      <p style="margin-top:8px;font-size:11px;color:#cbd5e1;word-break:break-all;">Or copy this link: ${resetLink}</p>
    `;
    return this.send({ to, subject: "Reset your SkyBook password", html: this._wrap(body) });
  }
}

module.exports = new EmailService();
