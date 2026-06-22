/**
 * Travelport Trip Services — Post-Commit Ticket Issuance
 *
 * Used only when a reservation was committed without payment (held booking).
 * Our primary booking.service.js uses the instant-pay flow so tickets are
 * issued at commit time. This service handles the fallback / retry path.
 *
 * Steps:
 *   1. Reopen workbench from locator  →  POST /air/book/session/reservationworkbench/buildfromlocator
 *   2. Add FOP Cash                   →  POST /air/payment/reservationworkbench/{id}/formofpayment
 *   3. Apply payment                  →  POST /air/paymentoffer/reservationworkbench/{id}/payments
 *   4. Commit with ticketing          →  POST /air/book/reservation/reservations/{id}
 */

const http = require("./http.client");
const {
  addFormOfPaymentCash,
  applyPayment,
  commitReservation,
} = require("./booking.service");

const BUILD_FROM_LOCATOR_PATH = "air/book/session/reservationworkbench/buildfromlocator";

// Travelport requires a different Content-Version for the buildfromlocator endpoint
const LOCATOR_HEADERS = { "Content-Version": "6_1" };

// ── Reopen workbench from PNR ──────────────────────────────────────────────────

async function reopenWorkbenchFromLocator(pnr, reservationIdentifier) {
  const body = {
    "@type": "ReservationQueryBuildFromLocator",
    ReservationLocator: {
      locator: pnr,
      ...(reservationIdentifier
        ? { ReservationIdentifier: { Identifier: { authority: "Travelport", value: reservationIdentifier } } }
        : {}),
    },
  };

  const raw = await http.post(BUILD_FROM_LOCATOR_PATH, body, LOCATOR_HEADERS);

  const workbenchId =
    raw?.ReservationWorkbench?.Identifier?.value ||
    raw?.Identifier?.value ||
    raw?.id;

  if (!workbenchId) {
    throw new Error(`Travelport ticketing: could not reopen workbench from locator ${pnr}`);
  }

  // Extract current offer and product from the reopened workbench
  const reservation  = raw?.ReservationWorkbench?.Reservation || raw?.Reservation || {};
  const offers       = reservation?.Offer || [];
  const firstOffer   = Array.isArray(offers) ? offers[0] : offers;
  const offerIdentifier  = firstOffer?.Identifier?.value || firstOffer?.id;
  const products     = firstOffer?.Product || [];
  const productIdentifier = (Array.isArray(products) ? products[0] : products)?.Identifier?.value;

  return { workbenchId, offerIdentifier, productIdentifier };
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Issue tickets for a held booking.
 * @param {object} opts
 * @param {string} opts.pnr - GDS locator code (e.g. "ABCDEF")
 * @param {string} [opts.reservationIdentifier] - Travelport UUID for the reservation
 * @param {number} opts.totalFare - Total fare to charge
 * @param {string} [opts.currency] - Currency code (default USD)
 */
async function issueTickets({ pnr, reservationIdentifier, totalFare, currency = "USD" }) {
  if (!pnr) throw new Error("Travelport ticketing: pnr is required");
  if (!totalFare) throw new Error("Travelport ticketing: totalFare is required");

  // Step 1: reopen workbench from PNR
  const { workbenchId, offerIdentifier } = await reopenWorkbenchFromLocator(pnr, reservationIdentifier);

  // Step 2: add cash FOP
  const { fopId, fopIdentifier } = await addFormOfPaymentCash(workbenchId);

  // Step 3: apply payment
  await applyPayment(workbenchId, { totalFare, currency, fopId, fopIdentifier, offerIdentifier });

  // Step 4: commit — now that payment is attached, this will ticket the reservation
  const result = await commitReservation(workbenchId);

  return {
    pnr: result.pnr || pnr,
    reservationIdentifier: result.reservationIdentifier || reservationIdentifier,
    ticketWorkbenchId: workbenchId,
    ...result,
  };
}

module.exports = { issueTickets, reopenWorkbenchFromLocator };
