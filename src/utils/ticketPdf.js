const PDFDocument = require("pdfkit");
const QRCode = require("qrcode");

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

function hRule(doc, y, color = "#e2e8f0") {
  doc.moveTo(40, y).lineTo(555, y).lineWidth(0.5).stroke(color).lineWidth(1);
}

function sectionLabel(doc, text, y) {
  doc.fontSize(8).fillColor("#64748b").font("Helvetica-Bold").text(text, 40, y, { characterSpacing: 0.6 });
  doc.font("Helvetica");
}

async function generateTicketPDFBuffer(booking) {
  const pnr = booking.pnrMap?.[booking.flightDetails.provider] || booking.bookingRef;
  const isRoundTrip = !!booking.returnFlightDetails?.origin;
  const fare = booking.fareBreakdown || {};
  const currency = fare.currency || "INR";
  const sym = currency === "INR" ? "₹" : currency;
  const fmtMoney = (n) => `${sym}${(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;

  const qrDataUrl = await QRCode.toDataURL(`PNR:${pnr}|REF:${booking.bookingRef}`, { margin: 1, width: 120 });
  const qrBuffer = Buffer.from(qrDataUrl.replace(/^data:image\/png;base64,/, ""), "base64");

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 0, info: { Title: `E-Ticket ${booking.bookingRef}` } });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // ── Header band ──────────────────────────────────────────────────────────
    doc.rect(0, 0, 595, 56).fill("#0f172a");
    doc.fontSize(18).fillColor("#ffffff").font("Helvetica-Bold").text("SkyBook", 40, 15);
    doc.fontSize(9).fillColor("#94a3b8").font("Helvetica").text("Flight Booking Platform", 40, 36);
    doc.fontSize(10).fillColor("#94a3b8").font("Helvetica-Bold").text("E-Ticket", 480, 23);
    doc.font("Helvetica");

    // ── Sub-header strip ─────────────────────────────────────────────────────
    doc.rect(0, 56, 595, 30).fill("#f8fafc");
    doc.fontSize(8).fillColor("#475569")
      .text(`Booking Ref: `, 40, 67, { continued: true }).fillColor("#0f172a").font("Helvetica-Bold").text(booking.bookingRef, { continued: true })
      .fillColor("#475569").font("Helvetica").text(`    PNR: `, { continued: true }).fillColor("#0f172a").font("Helvetica-Bold").text(pnr || "—", { continued: true })
      .fillColor("#475569").font("Helvetica").text(`    Status: `, { continued: true }).fillColor("#16a34a").font("Helvetica-Bold").text("CONFIRMED");
    doc.font("Helvetica");

    let y = 102;

    // ── Flight leg renderer ──────────────────────────────────────────────────
    const renderLeg = (fd, label) => {
      const segments = fd.segments?.length ? fd.segments : null;
      const dep = fd.departureAt;
      const arr = fd.arrivalAt;
      const dur = segments
        ? durationStr(segments[0].departureAt, segments[segments.length - 1].arrivalAt)
        : durationStr(dep, arr);

      hRule(doc, y);
      sectionLabel(doc, label, y + 8);
      y += 26;

      // Three-column route: origin | centre | destination
      const originX = 40;
      const centreX = 220;
      const destX = 390;

      // Origin
      doc.fontSize(28).fillColor("#0f172a").font("Helvetica-Bold").text(fd.origin || "—", originX, y, { width: 170 });
      doc.fontSize(13).fillColor("#1e293b").font("Helvetica-Bold").text(fmtTime(dep), originX, y + 32, { width: 170 });
      doc.fontSize(9).fillColor("#64748b").font("Helvetica").text(fmtDate(dep), originX, y + 48, { width: 170 });

      // Centre: duration + arrow
      doc.fontSize(9).fillColor("#64748b").text(dur, centreX, y + 8, { width: 160, align: "center" });
      doc.moveTo(centreX + 10, y + 24).lineTo(centreX + 150, y + 24).lineWidth(1).stroke("#94a3b8").lineWidth(1);
      // arrowhead
      doc.moveTo(centreX + 145, y + 20).lineTo(centreX + 155, y + 24).lineTo(centreX + 145, y + 28).fill("#94a3b8");
      doc.fontSize(8).fillColor("#94a3b8").text(fd.stopCount ? `${fd.stopCount} stop${fd.stopCount > 1 ? "s" : ""}` : "Non-stop", centreX, y + 34, { width: 160, align: "center" });

      // Destination
      doc.fontSize(28).fillColor("#0f172a").font("Helvetica-Bold").text(fd.destination || "—", destX, y, { width: 165 });
      doc.fontSize(13).fillColor("#1e293b").font("Helvetica-Bold").text(fmtTime(arr), destX, y + 32, { width: 165 });
      doc.fontSize(9).fillColor("#64748b").font("Helvetica").text(fmtDate(arr), destX, y + 48, { width: 165 });

      y += 68;

      // Flight details row
      doc.fontSize(9).fillColor("#374151").font("Helvetica")
        .text(`Flight:`, 40, y, { continued: true }).font("Helvetica-Bold").text(` ${fd.flightNo || "N/A"}`, { continued: true })
        .font("Helvetica").text(`    Cabin:`, { continued: true }).font("Helvetica-Bold").text(` ${fd.cabinClass || "Economy"}`, { continued: true })
        .font("Helvetica").text(fd.fareFamily ? `    Fare: ` : "", { continued: !!fd.fareFamily })
        .font("Helvetica-Bold").text(fd.fareFamily ? fd.fareFamily : "");
      doc.font("Helvetica");
      y += 16;

      // Connecting segments
      if (segments && segments.length > 1) {
        segments.forEach((seg, i) => {
          doc.fontSize(8).fillColor("#6b7280")
            .text(`  Seg ${i + 1}:  ${seg.flightNo}  ·  ${seg.origin} → ${seg.destination}  ·  ${fmtTime(seg.departureAt)} – ${fmtTime(seg.arrivalAt)}`, 48, y, { width: 500 });
          y += 13;
        });
      }
      y += 8;
    };

    renderLeg(booking.flightDetails, isRoundTrip ? "OUTBOUND FLIGHT" : "FLIGHT DETAILS");
    if (isRoundTrip && booking.returnFlightDetails?.origin) {
      renderLeg(booking.returnFlightDetails, "RETURN FLIGHT");
    }

    // ── Passengers (QR in rightmost column) ─────────────────────────────────
    hRule(doc, y);
    sectionLabel(doc, "PASSENGERS", y + 8);
    y += 26;

    // Table header
    const C = { name: 40, type: 185, seat: 265, status: 340, barcode: 420 };
    doc.fontSize(8).fillColor("#64748b").font("Helvetica-Bold")
      .text("Name", C.name, y)
      .text("Type", C.type, y)
      .text("Seat", C.seat, y)
      .text("Status", C.status, y)
      .text("Barcode", C.barcode, y);
    doc.font("Helvetica");
    y += 13;
    hRule(doc, y, "#f1f5f9");
    y += 6;

    const qrRowY = y;
    booking.passengers.forEach((pax, idx) => {
      doc.fontSize(10).fillColor("#111827").font("Helvetica")
        .text(`${pax.firstName} ${pax.lastName}`, C.name, y, { width: 138 })
        .text(paxTypeLabel(pax.type), C.type, y, { width: 73 })
        .text(pax.seatNo || "—", C.seat, y, { width: 68 })
        .fillColor("#16a34a").font("Helvetica-Bold").text("Confirmed", C.status, y, { width: 72 });
      doc.font("Helvetica").fillColor("#111827");
      y += 20;
    });

    // QR spans all passenger rows on the right
    const qrSize = Math.min(85, y - qrRowY + 4);
    doc.image(qrBuffer, C.barcode, qrRowY, { width: qrSize, height: qrSize });
    doc.fontSize(7).fillColor("#9ca3af").text("Scan at check-in", C.barcode, qrRowY + qrSize + 2, { width: qrSize, align: "center" });

    y += 12;

    // ── Baggage allowance ────────────────────────────────────────────────────
    hRule(doc, y);
    sectionLabel(doc, "BAGGAGE ALLOWANCE", y + 8);
    y += 26;

    doc.fontSize(8).fillColor("#64748b").font("Helvetica-Bold")
      .text("Passenger", 40, y).text("Cabin", 220, y).text("Check-in", 320, y);
    doc.font("Helvetica");
    y += 13;
    hRule(doc, y, "#f1f5f9");
    y += 6;

    booking.passengers.forEach((pax) => {
      const checkIn = pax.type === "INF" ? "10 Kg" : pax.extraBaggage ? `${15 + pax.extraBaggage * 5} Kg` : "15 Kg (1 piece only)";
      doc.fontSize(10).fillColor("#374151").font("Helvetica")
        .text(`${pax.firstName} ${pax.lastName}`, 40, y, { width: 175 })
        .text(pax.type === "INF" ? "0 Kg" : "7 Kg", 220, y, { width: 95 })
        .text(checkIn, 320, y, { width: 180 });
      y += 18;
    });

    y += 10;

    // ── Payment summary ──────────────────────────────────────────────────────
    hRule(doc, y);
    sectionLabel(doc, "PAYMENT SUMMARY", y + 8);
    y += 26;

    const fareRows = [
      ["Base Fare", fmtMoney(fare.baseFare)],
      ["Taxes & Fees", fmtMoney(fare.taxes)],
      ["Convenience Fee", fmtMoney(fare.convenienceFee)],
      ...(fare.ancillaryCharges > 0 ? [["Ancillary Charges", fmtMoney(fare.ancillaryCharges)]] : []),
      ...(fare.discount > 0 ? [["Discount Applied", `-${fmtMoney(fare.discount)}`]] : []),
      ...(fare.walletDebit > 0 ? [["Wallet Debit", `-${fmtMoney(fare.walletDebit)}`]] : []),
    ];

    fareRows.forEach(([label, value]) => {
      doc.fontSize(10).fillColor("#374151").font("Helvetica")
        .text(label, 40, y)
        .text(value, 0, y, { align: "right", width: 555 });
      y += 15;
    });

    hRule(doc, y, "#94a3b8");
    y += 8;
    doc.fontSize(11).fillColor("#0f172a").font("Helvetica-Bold")
      .text("Order Total", 40, y)
      .text(fmtMoney(fare.totalFare), 0, y, { align: "right", width: 555 });
    doc.font("Helvetica");
    y += 22;

    // ── Important information ────────────────────────────────────────────────
    hRule(doc, y);
    sectionLabel(doc, "IMPORTANT INFORMATION", y + 8);
    y += 24;

    const notes = [
      "Check-in counters open 2 hours before departure. Arrive at the airport at least 2 hours prior.",
      "You must carry a valid government-issued photo ID at the time of check-in.",
      "Please show this e-ticket (printed or digital) at check-in.",
      "For infant travellers, carrying a date of birth certificate is mandatory.",
      "If you miss check-in without prior cancellation, you will be treated as a No Show.",
    ];
    notes.forEach((note) => {
      const textH = doc.heightOfString(`• ${note}`, { width: 507 });
      doc.fontSize(9).fillColor("#4b5563").font("Helvetica")
        .text(`• ${note}`, 48, y, { width: 507 });
      y += textH + 4;
    });

    y += 12;

    // ── Cancellation notice ──────────────────────────────────────────────────
    hRule(doc, y);
    y += 12;
    doc.fontSize(8).fillColor("#6b7280")
      .text("For cancellations or date changes, contact support before check-in. No-show forfeit the full fare.", 40, y, { width: 515 });
    y += 20;

    // ── Footer band ──────────────────────────────────────────────────────────
    const footerY = Math.max(y + 10, 768);
    doc.rect(0, footerY, 595, 74).fill("#0f172a");
    doc.fontSize(10).fillColor("#e2e8f0").font("Helvetica-Bold")
      .text("Happy journey!", 0, footerY + 14, { align: "center", width: 595 });
    doc.fontSize(8).fillColor("#64748b").font("Helvetica")
      .text("Booking powered by SkyBook  ·  support@skybook.in  ·  1800-XXX-XXXX", 0, footerY + 32, { align: "center", width: 595 });

    doc.end();
  });
}

module.exports = { generateTicketPDFBuffer };
