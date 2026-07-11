/**
 * Travelport Trip Services — Post-Commit Ticket Issuance (reference Section 5)
 *
 * Runs AFTER a held PNR exists (booking.service.createBooking). Issues the e-ticket:
 *   1. Reopen workbench from locator → POST air/book/session/reservationworkbench/buildfromlocator?Locator={PNR}
 *   2. Add FOP Cash                  → POST air/payment/reservationworkbench/{id}/formofpayment
 *   3. Apply payment                 → POST air/paymentoffer/reservationworkbench/{id}/payments
 *   4. Commit ticket issuance        → POST air/book/reservation/reservations/{id}
 *
 * Best-effort: the caller treats a held PNR as a successful booking, so a ticketing
 * failure here must not undo it. This module throws on failure; the caller catches it.
 */

const http = require("./http.client");
const { logger } = require("../../config/db");
const {
  addFormOfPaymentCash,
  applyPayment,
  commitReservation,
} = require("./booking.service");

const BUILD_FROM_LOCATOR_PATH = "air/book/session/reservationworkbench/buildfromlocator";

// ── Reopen workbench from PNR ──────────────────────────────────────────────────

async function reopenWorkbenchFromLocator(pnr) {
  // Locator is a query param; the body is empty (per the reference collection).
  const path = `${BUILD_FROM_LOCATOR_PATH}?Locator=${encodeURIComponent(pnr)}`;
  logger.info("[Travelport] Ticketing: reopen workbench from locator", { pnr, path });

  const { data: raw, headers, status } = await http.postFull(path, {});
  http.assertNoEmbeddedError(raw, "buildfromlocator");

  // Workbench id used by the follow-up FOP/payment calls = ReservationResponse.Identifier.value.
  let workbenchId =
    raw?.ReservationResponse?.Identifier?.value ||
    raw?.Identifier?.value ||
    raw?.id;
  if (!workbenchId) {
    const loc = headers?.location || headers?.["content-location"] || "";
    const m = String(loc).match(/reservationworkbench\/([^/?#]+)/i);
    if (m) workbenchId = m[1];
  }

  const reservation = raw?.ReservationResponse?.Reservation || raw?.Reservation || {};
  const offers = reservation?.Offer || [];
  const firstOffer = Array.isArray(offers) ? offers[0] : offers;
  const offerIdentifier = firstOffer?.Identifier?.value || firstOffer?.id;

  if (!workbenchId || !offerIdentifier) {
    logger.error("[Travelport] Ticketing: could not reopen workbench from locator", {
      pnr, status, workbenchId, offerIdentifier,
      location: headers?.location || headers?.["content-location"] || null,
      bodySnippet: JSON.stringify(raw || "").slice(0, 3000),
    });
    throw new Error(`Travelport ticketing: could not reopen workbench from locator ${pnr}`);
  }

  logger.info("[Travelport] Ticketing: workbench reopened", { pnr, workbenchId, offerIdentifier });
  return { workbenchId, offerIdentifier };
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Issue e-tickets for a held booking.
 * @param {object} opts
 * @param {string} opts.pnr       - GDS locator (e.g. "DVZ11L")
 * @param {number} opts.totalFare - fare to settle against the offer
 * @param {string} [opts.currency]
 */
async function issueTickets({ pnr, totalFare, currency = "INR" }) {
  if (!pnr) throw new Error("Travelport ticketing: pnr is required");

  const { workbenchId, offerIdentifier } = await reopenWorkbenchFromLocator(pnr);
  const { fopId, fopIdentifier } = await addFormOfPaymentCash(workbenchId);
  await applyPayment(workbenchId, { totalFare, currency, fopId, fopIdentifier, offerIdentifier });

  // Commit — with payment attached, this issues the ticket. Re-uses the commit parser
  // (throws if the GDS returns an error / no locator).
  const result = await commitReservation(workbenchId);

  logger.info("[Travelport] Ticketing: ticket issuance committed", {
    pnr, ticketWorkbenchId: workbenchId, locator: result.pnr,
  });

  return {
    pnr: result.pnr || pnr,
    ticketWorkbenchId: workbenchId,
    tickets: Array.isArray(result.tickets) ? result.tickets : [],
    ...result,
  };
}

module.exports = { issueTickets, reopenWorkbenchFromLocator };
