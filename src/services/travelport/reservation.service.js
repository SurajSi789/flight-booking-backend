/**
 * Travelport Trip Services — Reservation Retrieval & Cancellation
 *
 * Retrieve:  GET  /11/air/book/reservation/reservations/{locator}
 * Cancel:    Reopen workbench → cancelitems → commit
 *   1. POST /air/book/session/reservationworkbench/buildfromlocator
 *   2. POST /book/reservationworkbench/{id}/reservations/cancelitems
 *   3. POST /air/book/reservation/reservations/{id}
 */

const http = require("./http.client");
const { reopenWorkbenchFromLocator } = require("./ticketing.service");
const { commitReservation } = require("./booking.service");

const RETRIEVE_PATH_PREFIX  = "air/book/reservation/reservations";
const CANCEL_ITEMS_SUFFIX   = "reservations/cancelitems";

// ── Retrieve ──────────────────────────────────────────────────────────────────

async function getReservation(pnr) {
  if (!pnr) throw new Error("Travelport reservation: pnr is required");
  const raw = await http.get(`${RETRIEVE_PATH_PREFIX}/${pnr}`);

  const reservation = raw?.Reservation || raw;
  const locator     = reservation?.locator || pnr;

  // Extract ticket numbers from the committed reservation
  const tickets = [];
  const offers  = Array.isArray(reservation?.Offer) ? reservation.Offer : [];
  for (const offer of offers) {
    const products = Array.isArray(offer?.Product) ? offer.Product : [];
    for (const product of products) {
      const productAir = product?.ProductAir || {};
      const tktList    = Array.isArray(productAir?.Ticket) ? productAir.Ticket : [];
      for (const t of tktList) {
        tickets.push({
          number: t?.number || t?.ticketNumber,
          passengerRef: t?.PassengerRef || t?.passengerRef,
          status: t?.status,
        });
      }
    }
  }

  return { pnr: locator, tickets, rawReservation: reservation };
}

// ── Cancel ────────────────────────────────────────────────────────────────────

async function cancelReservation(pnr, reservationIdentifier) {
  if (!pnr) throw new Error("Travelport reservation: pnr is required for cancellation");

  // Step 1: reopen workbench
  const { workbenchId } = await reopenWorkbenchFromLocator(pnr, reservationIdentifier);

  // Step 2: cancel all items in the workbench
  // Note: the cancel path uses a different prefix ("book/reservationworkbench", not "air/book/...")
  const cancelPath = `book/reservationworkbench/${workbenchId}/${CANCEL_ITEMS_SUFFIX}`;
  await http.post(cancelPath, { "@type": "CancelRequest", cancelAllInd: true });

  // Step 3: commit the cancellation
  let commitResult;
  try {
    commitResult = await commitReservation(workbenchId);
  } catch (err) {
    // Some implementations return 200 with no locator on cancel commit — treat as success
    if (err.message?.includes("no PNR locator")) {
      commitResult = { pnr, workbenchId, cancelled: true };
    } else {
      throw err;
    }
  }

  return {
    pnr: commitResult.pnr || pnr,
    cancelled: true,
    cancelledAt: new Date().toISOString(),
    workbenchId,
  };
}

module.exports = { getReservation, cancelReservation };
