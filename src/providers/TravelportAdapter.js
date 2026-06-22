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

  async priceAndInitiate(providerMeta, contentSource = "GDS") {
    const priced = await pricingSvc.priceOffer(providerMeta, contentSource);
    return {
      priceOfferMeta: {
        // Preserve session identifiers from search (needed for booking workbench)
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

  async confirmBooking({ passengers, priceOfferMeta, contentSource = "GDS" }) {
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
    });

    return {
      pnr: result.pnr,
      reservationIdentifier: result.reservationIdentifier,
      workbenchId: result.workbenchId,
      travelerIds: result.travelerIds,
      committedOfferId: result.committedOfferId,
      committedProductId: result.committedProductId,
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
