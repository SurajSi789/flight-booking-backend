/**
 * TravelportAdapter
 *
 * Implements the BaseFlightProvider contract using the Travelport Trip Services
 * V11 REST APIs. Replaces IndigoAdapter for the Travelport GDS/NDC content source.
 *
 * Method-to-service mapping:
 *   searchFlights()        → search.service.js
 *   priceAndInitiate()     → pricing.service.js   (called by BookingService.buildProviderInitiation)
 *   confirmBooking()       → booking.service.js   (full workbench flow)
 *   cancelBooking()        → reservation.service.js
 *   getSeatMap()           → ancillary.service.js
 *   getAncillaries()       → ancillary.service.js
 *   getReservation()       → reservation.service.js
 *   issueTickets()         → ticketing.service.js (held-booking fallback only)
 *   exchangeBooking()      → exchange.service.js
 */

const BaseFlightProvider         = require("./BaseFlightProvider");
const searchSvc                  = require("../services/travelport/search.service");
const pricingSvc                 = require("../services/travelport/pricing.service");
const bookingSvc                 = require("../services/travelport/booking.service");
const ticketingSvc               = require("../services/travelport/ticketing.service");
const { getReservation, cancelReservation } = require("../services/travelport/reservation.service");
const { getSeatMap, getAncillaries }        = require("../services/travelport/ancillary.service");
const { exchangeBooking }                   = require("../services/travelport/exchange.service");
const { logger }                            = require("../config/db");

class TravelportAdapter extends BaseFlightProvider {
  constructor() {
    super("travelport");
  }

  // ── Search ──────────────────────────────────────────────────────────────────

  async searchFlights({ origin, destination, date, departureDate, returnDate, adults = 1, children = 0, infants = 0, cabin = "Y", contentSource }) {
    try {
      // The orchestrator passes `date`; internal service uses `departureDate` — accept both
      const deptDate = departureDate || date;
      const contentSourceList = contentSource ? [String(contentSource).toUpperCase()] : ["GDS"];
      const { flights } = await searchSvc.searchFlights({
        origin, destination,
        departureDate: deptDate,
        returnDate,
        adults, children, infants,
        cabin, contentSourceList,
      });

      return flights.map((f) => this.buildFlightResult(f));
    } catch (err) {
      return this.wrapError(err);
    }
  }

  // ── Pricing / provider initiation ─────────────────────────────────────────
  //
  // Called by BookingService.buildProviderInitiation for provider === "travelport".
  // Runs the pricing call against the chosen search offering, returning the data
  // that will be stored in Redis + booking.providerMeta.sessionCache.

  async priceAndInitiate(providerMeta, contentSource = "GDS", passengers) {
    const priced = await pricingSvc.priceOffer(providerMeta, contentSource, passengers);

    // The GDS booking (BuildFromProducts) rebuilds the offer in the workbench from the
    // ORIGINAL search identifiers, which the booking layer reads under these exact keys:
    //   catalogProductOfferingsIdentifier ← search session UUID (sessionId)
    //   catalogProductOfferingIdentifier  ← specific offering (offeringId)
    //   productIdentifier                 ← product (productId)
    const catalogProductOfferingsIdentifier =
      providerMeta.sessionId || providerMeta.transactionId || providerMeta.catalogProductOfferingsIdentifier;
    const catalogProductOfferingIdentifier =
      providerMeta.offeringId || providerMeta.catalogProductOfferingIdentifier;
    const productIdentifier =
      priced.productId || priced.productIdentifier || providerMeta.productId || providerMeta.productIdentifier;

    if (!catalogProductOfferingsIdentifier || !catalogProductOfferingIdentifier || !productIdentifier) {
      logger.warn("[TravelportAdapter] priceAndInitiate: missing booking identifier(s)", {
        catalogProductOfferingsIdentifier,
        catalogProductOfferingIdentifier,
        productIdentifier,
      });
    }

    logger.info("[TravelportAdapter] priceAndInitiate → booking meta", {
      productCriteriaCount: providerMeta.productCriteria?.length || 0,
      isSandboxFallback: priced.isSandboxFallback || false,
      catalogProductOfferingsIdentifier,
    });

    return {
      priceOfferMeta: {
        // GDS booking Add Offer uses productCriteria (self-contained BuildFromProducts).
        productCriteria: providerMeta.productCriteria || null,
        // Kept for NDC booking + seat-map/ancillary calls.
        catalogProductOfferingsIdentifier,
        catalogProductOfferingIdentifier,
        productIdentifier,
        sessionId:  providerMeta.sessionId  || providerMeta.transactionId,
        offeringId: providerMeta.offeringId,
        productId:  priced.productId || priced.productIdentifier || providerMeta.productId,
        offerId:    priced.offerId,
        offerIdentifier: priced.offerIdentifier,
        isSandboxFallback: priced.isSandboxFallback || false,
        totalFare: priced.pricedFare.totalFare,
        baseFare:  priced.pricedFare.baseFare,
        taxes:     priced.pricedFare.taxes,
        currency:  priced.pricedFare.currency,
      },
      contentSource,
      fareBreakdown: {
        baseFare:  priced.pricedFare.baseFare,
        taxes:     priced.pricedFare.taxes,
        totalFare: priced.pricedFare.totalFare,
        currency:  priced.pricedFare.currency,
      },
    };
  }

  // ── Booking (confirm) ──────────────────────────────────────────────────────
  //
  // Called by BookingService.confirmBooking for provider === "travelport".
  // Expects session state that was stored by buildProviderInitiation:
  //   { priceOfferMeta: { catalogProductOfferingsIdentifier, catalogProductOfferingIdentifier,
  //                        productIdentifier, offerId, offerIdentifier, totalFare, currency },
  //     contentSource }

  async confirmBooking({ passengers, priceOfferMeta, contentSource = "GDS", contact = {} }) {
    if (!priceOfferMeta) {
      throw new Error("TravelportAdapter.confirmBooking: priceOfferMeta is required (run priceAndInitiate first)");
    }
    if (!passengers || !passengers.length) {
      throw new Error("TravelportAdapter.confirmBooking: at least one passenger is required");
    }

    const result = await bookingSvc.createBooking({
      passengers,
      pricedOffer: priceOfferMeta,
      contentSource: contentSource || "GDS",
      contact,
    });

    // Best-effort e-ticket issuance (reference Section 5). The held PNR above is already a
    // valid booking with payment captured, so a ticketing failure must NOT undo it — we keep
    // the PNR and flag ticketingStatus for retry/manual follow-up.
    let tickets = [];
    let ticketingStatus = "held";
    try {
      const tk = await ticketingSvc.issueTickets({
        pnr: result.pnr,
        totalFare: priceOfferMeta.totalFare,
        currency: priceOfferMeta.currency || "INR",
      });
      tickets = tk.tickets || [];
      ticketingStatus = "ticketed";
      logger.info("[TravelportAdapter] E-tickets issued", { pnr: result.pnr, ticketWorkbenchId: tk.ticketWorkbenchId, ticketCount: tickets.length });
    } catch (tErr) {
      ticketingStatus = "held_ticketing_failed";
      logger.error("[TravelportAdapter] Ticket issuance failed — booking stays HELD (payment captured, retry later)", {
        pnr: result.pnr,
        message: tErr.message,
        stack: tErr.stack,
      });
    }

    return {
      pnr: result.pnr,
      reservationIdentifier: result.reservationIdentifier,
      workbenchId: result.workbenchId,
      travelerIds: result.travelerIds,
      committedOfferId: result.committedOfferId,
      committedProductId: result.committedProductId,
      tickets,
      ticketingStatus,
      status: "confirmed",
    };
  }

  // ── Cancel ─────────────────────────────────────────────────────────────────

  async cancelBooking({ pnr, reservationIdentifier }) {
    if (!pnr) {
      return this.wrapError(new Error("TravelportAdapter.cancelBooking: pnr is required"));
    }
    try {
      return await cancelReservation(pnr, reservationIdentifier);
    } catch (err) {
      return this.wrapError(err);
    }
  }

  // ── Retrieve reservation ───────────────────────────────────────────────────

  async getReservation(pnr) {
    return getReservation(pnr);
  }

  // ── Seat map ───────────────────────────────────────────────────────────────

  async getSeatMap({ catalogProductOfferingsIdentifier, catalogProductOfferingIdentifier, productIdentifier, passengers }) {
    try {
      return await getSeatMap({ catalogProductOfferingsIdentifier, catalogProductOfferingIdentifier, productIdentifier, passengers });
    } catch (err) {
      return this.wrapError(err);
    }
  }

  // ── Ancillary shopping ─────────────────────────────────────────────────────

  async getAncillaries({ catalogProductOfferingsIdentifier, catalogProductOfferingIdentifier, productIdentifier, ancillaryTypes }) {
    try {
      return await getAncillaries({ catalogProductOfferingsIdentifier, catalogProductOfferingIdentifier, productIdentifier, ancillaryTypes });
    } catch (err) {
      return this.wrapError(err);
    }
  }

  // ── Issue tickets (held-booking fallback) ──────────────────────────────────

  async issueTickets({ pnr, reservationIdentifier, totalFare, currency }) {
    return ticketingSvc.issueTickets({ pnr, reservationIdentifier, totalFare, currency });
  }

  // ── Exchange ───────────────────────────────────────────────────────────────

  async exchangeBooking(params) {
    return exchangeBooking(params);
  }
}

module.exports = TravelportAdapter;
