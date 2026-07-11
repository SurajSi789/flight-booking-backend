const Queue = require("bull");
const Booking = require("../models/Booking");
const Transaction = require("../models/Transaction");
const User = require("../models/User");
const CouponService = require("./CouponService");
const NotificationService = require("./NotificationService");
const FlightSearchOrchestrator = require("./FlightSearchOrchestrator");
const IndigoAdapter = require("../providers/IndigoAdapter");
const AirIndiaExpressAdapter = require("../providers/AirIndiaExpressAdapter");
const SpiceJetAdapter = require("../providers/SpiceJetAdapter");
const FlightRoutes24Adapter = require("../providers/FlightRoutes24Adapter");
const AkasaAirAdapter = require("../providers/AkasaAirAdapter");
const TravelportAdapter = require("../providers/TravelportAdapter");
const { createRedisClient, getBullQueueOptions } = require("../config/redis");
const { emailQueue } = require("../jobs/emailJob");
const { whatsappQueue } = require("../jobs/whatsappJob");
const PaymentService = require("./PaymentService");
const { logger } = require("../config/db");

const redis = createRedisClient();
const bookingEmailQueue = emailQueue || new Queue("email-queue", getBullQueueOptions());

const SESSION_TTL_SECONDS = 900;

const adaptersByName = {
  indigo: new IndigoAdapter(),
  airindia: new AirIndiaExpressAdapter(),
  spicejet: new SpiceJetAdapter(),
  flightroutes24: new FlightRoutes24Adapter(),
  akasaair: new AkasaAirAdapter(),
  travelport: new TravelportAdapter(),
};

class BookingService {
  async searchFlights(criteria) {
    return FlightSearchOrchestrator.search(criteria);
  }

  getAdapter(provider) {
    const key = String(provider || "").toLowerCase();
    // normalize frontend alias → backend adapter name
    const resolved = key === "akasa" ? "akasaair" : key;
    const adapter = adaptersByName[resolved];
    if (!adapter) {
      throw new Error(`Unsupported flight provider: ${provider}`);
    }
    return adapter;
  }

  getSessionKey(bookingId) {
    return `booking:session:${bookingId}`;
  }

  async setSessionState(bookingId, sessionState) {
    const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
    const payload = {
      ...sessionState,
      bookingId: String(bookingId),
      expiresAt
    };
    await redis.set(this.getSessionKey(bookingId), JSON.stringify(payload), "EX", SESSION_TTL_SECONDS);
    return payload;
  }

  async getSessionState(bookingId) {
    const data = await redis.get(this.getSessionKey(bookingId));
    return data ? JSON.parse(data) : null;
  }

  normalizeAncillaries(ancillaries = {}) {
    return [
      ...(ancillaries.meals || []).map((item) => ({ ...item, type: "meal" })),
      ...(ancillaries.baggage || []).map((item) => ({ ...item, type: "baggage" })),
      ...(ancillaries.seats || []).map((item) => ({ ...item, type: "seat" })),
      ...(ancillaries.fastForward || []).map((item) => ({ ...item, type: "fastforward" }))
    ];
  }

  enforceAncillaryRules({ provider, passengers = [], ancillaries = {}, seatPreferences = [], flightDetails = {} }) {
    const hoursToDeparture =
      (new Date(flightDetails.departureAt || Date.now() + 48 * 60 * 60 * 1000).getTime() - Date.now()) /
      (1000 * 60 * 60);
    const hasInfant = passengers.some((p) => p.type === "INF");
    const hasChild = passengers.some((p) => p.type === "CHD");

    if (provider === "indigo") {
      const mealByPax = {};
      for (const meal of ancillaries.meals || []) {
        const key = `${meal.passengerRef || meal.passengerId || "PAX"}|${meal.odRef || "OD"}`;
        mealByPax[key] = (mealByPax[key] || 0) + 1;
        if (mealByPax[key] > 1) {
          throw new Error("IndiGo: max 1 meal per passenger per OD");
        }
        if (hoursToDeparture < 24) {
          throw new Error("IndiGo: meals must be booked at least 24 hours before departure");
        }
      }

      const mealCodeCount = {};
      for (const meal of ancillaries.meals || []) {
        const code = meal.code || meal.ssrCode || "UNKNOWN";
        mealCodeCount[code] = (mealCodeCount[code] || 0) + 1;
        if (mealCodeCount[code] > 2) {
          throw new Error("IndiGo: max 2 same meals per flight");
        }
      }

      const baggageByPaxSegment = {};
      for (const baggage of ancillaries.baggage || []) {
        if (hoursToDeparture < 6) {
          throw new Error("IndiGo: baggage must be purchased at least 6 hours before departure");
        }
        if (flightDetails?.codeShare) {
          throw new Error("IndiGo: baggage ancillaries not allowed on codeshare flights");
        }
        const key = `${baggage.passengerRef || baggage.passengerId || "PAX"}|${baggage.segmentRef || "SEG"}`;
        baggageByPaxSegment[key] = (baggageByPaxSegment[key] || 0) + 1;
        if (baggageByPaxSegment[key] > 1) {
          throw new Error("IndiGo: max 1 baggage option per passenger per segment");
        }
      }

      if (hasInfant && seatPreferences.length > 0) {
        throw new Error("IndiGo: seat selection not available when INF is in PNR");
      }
      if (hasChild && seatPreferences.some((seat) => /^(14|15|16)/.test(String(seat.seatCode || seat.seatNumber || "")))) {
        throw new Error("IndiGo: CHD cannot be assigned near exit rows");
      }

      for (const ff of ancillaries.fastForward || []) {
        if (String(flightDetails.origin || "").length !== 3 || Number(flightDetails.stopCount || 0) > 0) {
          throw new Error("IndiGo: Fast Forward available only for domestic non-connecting flights");
        }
        if (!ff.airportSupported) {
          throw new Error("IndiGo: Fast Forward not supported for selected airport");
        }
      }
    }

    if (provider === "airindia") {
      const mealCodeCount = {};
      for (const meal of ancillaries.meals || []) {
        const code = meal.code || meal.ssrCode || "UNKNOWN";
        mealCodeCount[code] = (mealCodeCount[code] || 0) + 1;
        if (mealCodeCount[code] > 2) {
          throw new Error("Air India Express: max 2 same meals per flight");
        }
        if (hoursToDeparture < 24) {
          throw new Error("Air India Express: meals must be booked at least 24 hours before departure");
        }
      }
      // Baggage at journey level is a shape rule; no hard reject needed unless data violates.
      if ((ancillaries.baggage || []).some((item) => item.segmentRef)) {
        throw new Error("Air India Express: baggage SSR must be sold at journey level");
      }
    }

    // SpiceJet SSRs are validated dynamically in provider flow.
  }

  calculateAncillaryTotal(ancillaries = {}) {
    const groups = [ancillaries.meals || [], ancillaries.baggage || [], ancillaries.seats || [], ancillaries.fastForward || []];
    return groups.flat().reduce((sum, item) => sum + Number(item.price || 0), 0);
  }

  calculateFare({ passengers, ancillaries = {}, fareConfig = {} }) {
    const paxCount = passengers.length;
    const basePerPax = Number(fareConfig.basePerPassenger || 5000);
    const taxPerPax = Number(fareConfig.taxPerPassenger || 600);
    const convenienceFee = Number(fareConfig.convenienceFee || 199);
    const baseFare = paxCount * basePerPax;
    const taxes = paxCount * taxPerPax;
    const ancillaryCharges = this.calculateAncillaryTotal(ancillaries);
    const totalFare = baseFare + taxes + ancillaryCharges + convenienceFee;
    return {
      baseFare,
      taxes,
      ancillaryCharges,
      convenienceFee,
      discount: 0,
      totalFare,
      currency: "INR"
    };
  }

  async buildProviderInitiation({ bookingId, provider, flightId, passengers, ancillaries, seatPreferences, fareBreakdown, providerMeta = {} }) {
    const adapter = this.getAdapter(provider);

    if (provider === "indigo") {
      try {
        // IndiGo/ACH host sessions from browse-time search expire or stop matching by booking
        // time (uAPI 14022). Re-run LowFareSearch NOW so the host token, segment, and
        // ClassOfService all come from ONE fresh, consistent session.
        let effectiveMeta = providerMeta;
        const target = (providerMeta.bookingSegments || [])[0];
        if (target?.origin && target?.destination && target?.departureAt) {
          try {
            const fresh = await adapter.searchFlights({
              origin: target.origin,
              destination: target.destination,
              date: String(target.departureAt).slice(0, 10),
              passengers: passengers.length || 1
            });
            const freshList = Array.isArray(fresh) ? fresh : (fresh?.flights || []);
            const match = freshList.find((f) => {
              const s = (f.providerMeta?.bookingSegments || [])[0];
              return s && String(s.flightNumber) === String(target.flightNumber)
                && String(s.departureAt).slice(0, 16) === String(target.departureAt).slice(0, 16);
            });
            if (match?.providerMeta?.bookingSegments?.length) {
              effectiveMeta = match.providerMeta;
              logger.info("[BookingService] IndiGo re-search matched a fresh session", { bookingId: String(bookingId), flightNumber: target.flightNumber });
            } else {
              logger.warn("[BookingService] IndiGo re-search found no matching flight — using stale session", { bookingId: String(bookingId), flightNumber: target.flightNumber });
            }
          } catch (reErr) {
            logger.warn("[BookingService] IndiGo re-search failed — using stale session", { bookingId: String(bookingId), message: reErr.message });
          }
        }

        const hostToken = effectiveMeta.hostToken || (await adapter.getSessionToken()).token || providerMeta?.providerMeta?.hostToken;
        // Echo the real AirSegments captured at search time (origin/destination/times/class/
        // hostTokenRef). Falling back to "NA" placeholders makes the uAPI AirPrice reject the request.
        const airSegments = (Array.isArray(effectiveMeta.bookingSegments) && effectiveMeta.bookingSegments.length)
          ? effectiveMeta.bookingSegments.map((s) => ({
              key: s.key,
              flightNumber: s.flightNumber,
              flightNo: s.flightNumber,
              origin: s.origin,
              destination: s.destination,
              departureAt: s.departureAt,
              arrivalAt: s.arrivalAt,
              classOfService: s.classOfService,
              hostTokenRef: s.hostTokenRef,
              providerCode: s.providerCode || "ACH",
              group: s.group || "0",
              xml: s.xml
            }))
          : [
              {
                key: providerMeta.segmentRef || "SEG1",
                flightNo: providerMeta.flightNo || flightId,
                origin: providerMeta.origin || "NA",
                destination: providerMeta.destination || "NA",
                departureAt: providerMeta.departureAt || new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
                arrivalAt: providerMeta.arrivalAt || new Date(Date.now() + 50 * 60 * 60 * 1000).toISOString()
              }
            ];
        const optionalServices = this.normalizeAncillaries(ancillaries).map((item) => ({
          type: item.type,
          code: item.ssrCode || item.code,
          passengerRef: item.passengerRef || item.passengerId,
          segmentRef: item.segmentRef
        }));
        const priceReqXml = IndigoAdapter.buildAirPriceReqWithOptionals({
          airSegment: airSegments,
          hostToken,
          hostTokenKey: effectiveMeta.hostTokenKey,
          passengers,
          optionalServices,
          seatSelections: seatPreferences || [],
          fareBasisCode: effectiveMeta.fareBasis || "X"
        });
        const priceResponseXml = await adapter.postSoap(priceReqXml);
        const parsed = IndigoAdapter.parseAirPriceResponse(priceResponseXml);
        // parseAirPriceResponse always returns a pricingSolution object; the real signal of
        // success is the raw AirPricingSolution XML (needed to book). Log the response if absent.
        if (!parsed.pricingSolution?.xml) {
          logger.error(`[BookingService] IndiGo AirPrice returned no AirPricingSolution at initiate`, {
            bookingId: String(bookingId),
            provider: "indigo",
            requestSnippet: String(priceReqXml || "").slice(0, 4000),
            priceResponseSnippet: String(priceResponseXml || "").slice(0, 6000),
          });
        }
        return {
          hostToken: parsed.hostToken || hostToken,
          pricingSolution: parsed.pricingSolution,
          optionalServices: parsed.optionalServices,
          fareBreakdown: {
            ...fareBreakdown,
            baseFare: Number(String(parsed.pricingSolution?.base || "INR0").replace(/[A-Z]/gi, "")) || fareBreakdown.baseFare,
            taxes: Number(String(parsed.pricingSolution?.taxes || "INR0").replace(/[A-Z]/gi, "")) || fareBreakdown.taxes,
            totalFare: Number(String(parsed.pricingSolution?.total || "INR0").replace(/[A-Z]/gi, "")) || fareBreakdown.totalFare
          }
        };
      } catch (err) {
        logger.warn(`[BookingService] IndiGo pricing failed at initiate — using searched fare`, {
          bookingId: String(bookingId),
          provider: "indigo",
          message: err.message,
          responseData: err.response?.data ? String(err.response.data).slice(0, 4000) : undefined,
          status: err.response?.status,
        });
      }
    }

    if (provider === "airindia") {
      try {
        const sold = await adapter.tripSell({
          journeyKey: providerMeta.journeyKey,
          fareAvailabilityKey: providerMeta.fareAvailabilityKey,
          currency: fareBreakdown.currency || "INR"
        });
        if (sold.error) throw new Error(sold.error);
        const state = await adapter.getBookingState();
        if (state.error) throw new Error(state.error);
        return {
          token: adapter.token,
          passengerKeys: sold.passengerKeys || [],
          journeyKey: providerMeta.journeyKey,
          fareAvailabilityKey: providerMeta.fareAvailabilityKey,
          fareBreakdown: {
            ...fareBreakdown,
            totalFare: Number(state.balanceDue || fareBreakdown.totalFare)
          }
        };
      } catch (err) {
        logger.warn(`[BookingService] Air India pricing failed at initiate — using searched fare`, { bookingId: String(bookingId), provider: "airindia", message: err.message });
      }
    }

    if (provider === "spicejet") {
      try {
        const priced = await adapter.searchAndPrice({
          origin: providerMeta.origin || "DEL",
          destination: providerMeta.destination || "BOM",
          date: providerMeta.date || new Date().toISOString().slice(0, 10),
          adults: passengers.filter((p) => p.type === "ADT").length || 1,
          children: passengers.filter((p) => p.type === "CHD").length || 0,
          infants: passengers.filter((p) => p.type === "INF").length || 0,
          cabin: providerMeta.cabin || "Y"
        });
        if (priced.error) throw new Error(priced.error);
        return {
          token: adapter.sessionToken,
          flightKey: providerMeta.flightKey || priced[0]?.providerMeta?.flightKey || flightId,
          ssrAvailabilityFetched: Boolean(this.normalizeAncillaries(ancillaries).length),
          fareBreakdown: {
            ...fareBreakdown,
            totalFare: Number(priced[0]?.totalFare || fareBreakdown.totalFare)
          }
        };
      } catch (err) {
        logger.warn(`[BookingService] SpiceJet pricing failed at initiate — using searched fare`, { bookingId: String(bookingId), provider: "spicejet", message: err.message });
      }
    }

    if (provider === "travelport") {
      try {
        const contentSource = providerMeta.contentSource || "GDS";
        const adapter = this.getAdapter("travelport");
        const result = await adapter.priceAndInitiate(providerMeta, contentSource, passengers);
        return {
          priceOfferMeta: result.priceOfferMeta,
          contentSource,
          fareBreakdown: {
            ...fareBreakdown,
            baseFare:  result.fareBreakdown.baseFare  || fareBreakdown.baseFare,
            taxes:     result.fareBreakdown.taxes     || fareBreakdown.taxes,
            totalFare: result.fareBreakdown.totalFare || fareBreakdown.totalFare,
            currency:  result.fareBreakdown.currency  || fareBreakdown.currency,
          },
        };
      } catch (err) {
        logger.warn(`[BookingService] Travelport pricing failed at initiate — using searched fare`, { bookingId: String(bookingId), provider: "travelport", message: err.message });
        // Never drop the data booking needs. productCriteria (from search) is what Add Offer
        // uses, so preserve a priceOfferMeta even when pricing fails — otherwise confirm dies
        // with "priceOfferMeta missing in session" AFTER payment was captured.
        const contentSource = providerMeta.contentSource || "GDS";
        return {
          priceOfferMeta: {
            productCriteria: providerMeta.productCriteria || null,
            catalogProductOfferingsIdentifier: providerMeta.sessionId || providerMeta.transactionId,
            catalogProductOfferingIdentifier: providerMeta.offeringId,
            productIdentifier: providerMeta.productId,
            sessionId:  providerMeta.sessionId || providerMeta.transactionId,
            offeringId: providerMeta.offeringId,
            productId:  providerMeta.productId,
            contentSource,
            totalFare: fareBreakdown.totalFare,
            baseFare:  fareBreakdown.baseFare,
            taxes:     fareBreakdown.taxes,
            currency:  fareBreakdown.currency,
          },
          contentSource,
          fareBreakdown,
        };
      }
    }

    // akasaair and flightroutes24, or any provider whose live call failed above
    return { fareBreakdown };
  }

  async initiateBooking({
    userId,
    flightId,
    provider: rawProvider,
    passengers = [],
    contactEmail,
    contactPhone,
    couponCode,
    ancillaries = {},
    seatPreferences = [],
    flightDetails = {},
    returnFlightDetails = null,
    returnFlightBaseFare = 0,
    returnFlightTaxes = 0,
    providerMeta = {},
    fareConfig = {},
    fareIntent = "leisure"
  }) {
    // Normalise provider alias so 'akasa' and 'akasaair' are stored consistently
    const provider = rawProvider === "akasa" ? "akasaair" : rawProvider;

    if (!userId) {
      throw new Error("userId is required");
    }
    const user = await User.findById(userId);
    if (!user) {
      throw new Error("User not found");
    }
    if (!flightId) {
      throw new Error("flightId is required");
    }
    if (!Array.isArray(passengers) || passengers.length === 0) {
      throw new Error("At least one passenger is required");
    }
    const intent = fareIntent === "group" ? "group" : "leisure";
    if (intent === "leisure" && passengers.length > 9) {
      throw new Error("More than 9 passengers requires group / corporate booking");
    }
    if (intent === "group" && passengers.length > 60) {
      throw new Error("Please contact support for very large groups");
    }

    this.enforceAncillaryRules({ provider, passengers, ancillaries, seatPreferences, flightDetails });

    const fareBreakdown = this.calculateFare({ passengers, ancillaries, fareConfig });

    let couponInfo = null;
    if (couponCode) {
      couponInfo = await CouponService.validate(
        couponCode,
        fareBreakdown.totalFare,
        provider,
        userId,
        {
          origin: flightDetails.origin,
          destination: flightDetails.destination
        }
      );
      if (!couponInfo.valid) {
        throw new Error(couponInfo.message);
      }
      fareBreakdown.discount = couponInfo.discountAmount;
      fareBreakdown.totalFare = couponInfo.finalFare;
    }

    const normalizedAncillaries = this.normalizeAncillaries(ancillaries);

    const normalizedPassengers = passengers.map(({ dob, passportNo, passportRequired, title, ...rest }) => ({
        ...rest,
        ...(dob ? { dob: new Date(dob) } : {}),
        ...(passportNo ? { passportNoHash: passportNo } : {})
    }));

    const booking = await Booking.create({
      userId,
      fareIntent: intent,
      flightDetails: {
        provider,
        flightNo: flightDetails.flightNo || flightId,
        origin: flightDetails.origin || "NA",
        destination: flightDetails.destination || "NA",
        departureAt: flightDetails.departureAt || new Date(Date.now() + 48 * 60 * 60 * 1000),
        arrivalAt: flightDetails.arrivalAt || new Date(Date.now() + 50 * 60 * 60 * 1000),
        cabinClass: flightDetails.cabinClass || "economy",
        fareFamily: flightDetails.fareFamily || "V",
        fareBasis: flightDetails.fareBasis || "V3",
        stopCount: flightDetails.stopCount || 0,
        aircraft: flightDetails.aircraft || null
      },
      ...(returnFlightDetails ? {
        returnFlightDetails: {
          provider:    returnFlightDetails.provider || provider,
          flightNo:    returnFlightDetails.flightNo,
          origin:      returnFlightDetails.origin,
          destination: returnFlightDetails.destination,
          departureAt: returnFlightDetails.departureAt,
          arrivalAt:   returnFlightDetails.arrivalAt,
          cabinClass:  returnFlightDetails.cabinClass || "economy",
          fareFamily:  returnFlightDetails.fareFamily || "",
          fareBasis:   returnFlightDetails.fareBasis  || "",
          stopCount:   returnFlightDetails.stopCount  || 0,
        }
      } : {}),
      passengers: normalizedPassengers,
      ancillaries: normalizedAncillaries,
      fareBreakdown,
      contactEmail: contactEmail || undefined,
      contactPhone: contactPhone || undefined,
      couponCode: couponCode ? String(couponCode).toUpperCase() : undefined,
      bookingStatus: "initiated",
      paymentStatus: "pending",
      providerMeta
    });

    if (couponInfo?.valid) {
      await CouponService.apply(booking._id, couponCode, userId);
    }

    const providerInit = await this.buildProviderInitiation({
      bookingId: booking._id.toString(),
      provider,
      flightId,
      passengers,
      ancillaries,
      seatPreferences,
      fareBreakdown,
      providerMeta
    });

    booking.fareBreakdown = providerInit.fareBreakdown || booking.fareBreakdown;

    // For round-trip bookings the provider only prices the outbound leg.
    // Add the return leg's base fare and taxes that came from the search result.
    if (returnFlightDetails) {
      const retBase = Number(returnFlightBaseFare) || 0;
      const retTax  = Number(returnFlightTaxes)    || 0;
      if (retBase > 0 || retTax > 0) {
        booking.fareBreakdown.baseFare  = (booking.fareBreakdown.baseFare  || 0) + retBase;
        booking.fareBreakdown.taxes     = (booking.fareBreakdown.taxes     || 0) + retTax;
        booking.fareBreakdown.totalFare = (booking.fareBreakdown.totalFare || 0) + retBase + retTax;
      }
    }

    booking.sessionStateKey = this.getSessionKey(booking._id);
    // Persist session state on the booking itself as Redis fallback
    booking.providerMeta = {
      ...(booking.providerMeta || {}),
      sessionCache: {
        provider,
        token: providerInit.token || null,
        passengerKeys: providerInit.passengerKeys || [],
        journeyKey: providerInit.journeyKey || null,
        hostToken: providerInit.hostToken || null,
        pricingSolution: providerInit.pricingSolution || null,
        optionalServices: providerInit.optionalServices || [],
        // Travelport REST fields
        priceOfferMeta: providerInit.priceOfferMeta || null,
        contentSource: providerInit.contentSource || null,
        fareBreakdown: booking.fareBreakdown
      }
    };
    await booking.save();

    try {
      await this.setSessionState(booking._id, {
        provider,
        token: providerInit.token || null,
        passengerKeys: providerInit.passengerKeys || [],
        journeyKey: providerInit.journeyKey || null,
        hostToken: providerInit.hostToken || null,
        pricingSolution: providerInit.pricingSolution || null,
        optionalServices: providerInit.optionalServices || [],
        // Travelport REST fields
        priceOfferMeta: providerInit.priceOfferMeta || null,
        contentSource: providerInit.contentSource || null,
        fareBreakdown: booking.fareBreakdown
      });
    } catch (redisErr) {
      console.warn(`[BookingService] Redis session write failed (using booking.providerMeta fallback): ${redisErr.message}`);
    }

    return {
      bookingId: booking._id,
      fareBreakdown: booking.fareBreakdown,
      sessionTTL: SESSION_TTL_SECONDS
    };
  }

  async confirmBooking(input, maybePaymentTxnId) {
    // Distinguish a plain payload object from a Mongoose ObjectId (also typeof "object").
    // A valid payload must contain at least one of the known keys.
    const isPayload =
      typeof input === "object" &&
      input !== null &&
      ("bookingId" in input || "paymentTxnId" in input || "skipPaymentCheck" in input);
    const payload = isPayload
      ? input
      : { bookingId: input, paymentTxnId: maybePaymentTxnId, skipPaymentCheck: true };
    const { bookingId, paymentTxnId, skipPaymentCheck } = payload;

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      throw new Error("Booking not found");
    }
    if (booking.bookingStatus === "confirmed") {
      return {
        bookingRef: booking.bookingRef,
        pnr: booking.pnrMap?.[booking.flightDetails.provider],
        status: "confirmed"
      };
    }
    // Already cancelled/refunded (e.g. auto-refunded after an earlier ticketing failure)
    // — do not attempt to ticket again.
    if (booking.bookingStatus === "cancelled") {
      throw new Error("Booking was cancelled/refunded and cannot be ticketed");
    }

    if (!skipPaymentCheck) {
      const transaction = await Transaction.findOne({
        $or: [{ gatewayTxnId: paymentTxnId }, { _id: paymentTxnId }],
        bookingId: booking._id,
        status: "success"
      });
      if (!transaction) {
        throw new Error("Valid successful payment transaction not found for booking");
      }
    }

    let sessionState = await this.getSessionState(booking._id);
    if (!sessionState) {
      // Redis unavailable or session expired — fall back to the copy stored on the booking
      sessionState = booking.providerMeta?.sessionCache || {};
      console.warn(`[BookingService] Redis session missing for ${booking._id}, using booking.providerMeta.sessionCache`);
    }

    const provider = booking.flightDetails.provider;
    const adapter = this.getAdapter(provider);
    let providerResponse;

    logger.info("[BookingService] Starting provider ticketing (post-payment)", {
      bookingId: booking._id.toString(),
      bookingRef: booking.bookingRef,
      provider,
      hasSession: Boolean(sessionState && Object.keys(sessionState).length),
    });

    try {
      if (provider === "indigo") {
        const travelers = booking.passengers.map((pax, idx) => ({
          key: `BT${idx + 1}`,
          prefix: pax.gender === "F" ? "MS" : "MR",
          firstName: pax.firstName,
          lastName: pax.lastName,
          dob: pax.dob,
          phone: { countryCode: "91", number: "9999999999" },
          email: "support@flightbooking.test",
          address: { street: "Address Line 1", city: "City", state: "State", postalCode: "110001", country: "IN" }
        }));
        // A live AirPrice at initiate is required to book — its pricingSolution carries the
        // hostToken/keys IndiGo needs in AirCreateReservationReq. If it's missing, pricing
        // failed upstream (see "[BookingService] IndiGo pricing failed at initiate" warn).
        if (!sessionState.pricingSolution || Object.keys(sessionState.pricingSolution).length === 0) {
          throw new Error("IndiGo pricingSolution missing from session — AirPrice failed at initiate, cannot create reservation");
        }
        providerResponse = await adapter.confirmBooking({
          travelers,
          pricingSolution: sessionState.pricingSolution,
          optionalServices: sessionState.optionalServices || [],
          formOfPayment: { type: "AgencyPayment" }
        });
        // Adapter swallows exceptions into { error } — surface it instead of a generic "no PNR".
        if (providerResponse.error) throw new Error(providerResponse.error);
      } else if (provider === "airindia") {
        const ttl = await redis.ttl(this.getSessionKey(booking._id));
        let refreshedSession = sessionState;
        if (ttl <= 0) {
          const reinit = await adapter.tripSell({
            journeyKey: sessionState.journeyKey || booking.providerMeta?.journeyKey,
            fareAvailabilityKey: booking.providerMeta?.fareAvailabilityKey || sessionState.fareAvailabilityKey,
            currency: booking.fareBreakdown.currency || "INR"
          });
          if (reinit.error) throw new Error(reinit.error);
          refreshedSession = await this.setSessionState(booking._id, {
            ...sessionState,
            token: adapter.token,
            passengerKeys: reinit.passengerKeys || sessionState.passengerKeys
          });
        }
        await adapter.addContact({ mobile: "9999999999", email: "support@flightbooking.test", countryCode: "91" });
        const ssrAvail = await adapter.getSSRAvailability({ currency: booking.fareBreakdown.currency || "INR" });
        if (ssrAvail.error) throw new Error(ssrAvail.error);
        for (const anc of booking.ancillaries || []) {
          const ssrKey = anc.ssrCode || anc.code;
          if (!ssrKey) continue;
          for (const passengerKey of refreshedSession.passengerKeys || []) {
            const sold = await adapter.sellSSR({ ssrKey, passengerKey, currency: booking.fareBreakdown.currency || "INR" });
            if (sold.error) throw new Error(sold.error);
          }
        }
        if ((booking.ancillaries || []).some((item) => item.type === "seat")) {
          const seatMap = await adapter.getSeatMap({ journeyKey: refreshedSession.journeyKey || booking.providerMeta?.journeyKey });
          if (seatMap.error) throw new Error(seatMap.error);
          const firstSeat = seatMap.raw?.seatUnits?.[0]?.unitKey || null;
          if (firstSeat) {
            for (const passengerKey of refreshedSession.passengerKeys || []) {
              const assign = await adapter.assignSeat({ passengerKey, unitKey: firstSeat, currency: booking.fareBreakdown.currency || "INR" });
              if (assign.error) throw new Error(assign.error);
            }
          }
        }
        const payment = await adapter.addPayment({ amount: booking.fareBreakdown.totalFare, currency: booking.fareBreakdown.currency || "INR" });
        if (payment.error) throw new Error(payment.error);
        providerResponse = await adapter.commitBooking();
        if (providerResponse.error) throw new Error(providerResponse.error);
      } else if (provider === "spicejet") {
        providerResponse = await adapter.createBooking({
          flightKey: sessionState.flightKey || booking.providerMeta?.flightKey || booking.flightDetails.flightNo,
          passengers: booking.passengers,
          payment: { amount: booking.fareBreakdown.totalFare, currency: booking.fareBreakdown.currency || "INR" },
          ssrs: (booking.ancillaries || []).map((item) => ({ ssrCode: item.ssrCode || item.code, passengerKey: item.passengerId || "PAX1", segmentKey: item.segmentRef || "" })),
          seatPreferences: (booking.ancillaries || []).filter((item) => item.type === "seat").map((item) => ({ passengerKey: item.passengerId || "PAX1", seatCode: item.description || item.code || "10A", segmentKey: item.segmentRef || "" }))
        });
        if (providerResponse.error) throw new Error(providerResponse.error);
      } else if (provider === "travelport") {
        const priceOfferMeta = sessionState.priceOfferMeta || booking.providerMeta?.sessionCache?.priceOfferMeta;
        const contentSource  = sessionState.contentSource  || booking.providerMeta?.sessionCache?.contentSource || "GDS";
        if (!priceOfferMeta) {
          throw new Error("Travelport: priceOfferMeta missing in session — re-initiate booking");
        }
        providerResponse = await adapter.confirmBooking({
          passengers: booking.passengers,
          priceOfferMeta,
          contentSource,
          contact: { email: booking.contactEmail, phone: booking.contactPhone, countryCode: "91" },
        });
        // Persist the Travelport reservation identifier for later cancel/exchange/ticketing
        if (providerResponse.reservationIdentifier) {
          booking.providerMeta = {
            ...booking.providerMeta,
            reservationIdentifier: providerResponse.reservationIdentifier,
            workbenchId: providerResponse.workbenchId,
          };
        }
      } else {
        providerResponse = await adapter.createBooking({ bookingId: booking._id.toString() });
      }
    } catch (err) {
      // Post-payment provider/ticketing failure. Do NOT fabricate a PNR or mark the
      // booking confirmed — record the failure and surface the error so it can be
      // investigated and the captured payment refunded.
      logger.error(`[BookingService] ${provider} ticketing failed post-payment`, {
        bookingId: booking._id.toString(),
        provider,
        message: err.message,
        stack: err.stack,
      });
      booking.providerMeta = {
        ...booking.providerMeta,
        confirmError: { message: err.message, provider, at: new Date().toISOString() },
      };
      await booking.save();
      throw new Error(`Airline booking failed (${provider}): ${err.message}`);
    }

    // Provider call succeeded — require a real PNR from the response (no fabrication).
    const pnr =
      providerResponse?.pnr ||
      providerResponse?.providerBookingRef ||
      providerResponse?.bookingRef ||
      providerResponse?.tcrNumber ||
      null;

    if (!pnr) {
      const reason = providerResponse?.error || "no PNR returned by provider";
      logger.error(`[BookingService] ${provider} returned no PNR/booking reference`, {
        bookingId: booking._id.toString(),
        provider,
        reason,
        providerResponse,
      });
      booking.providerMeta = {
        ...booking.providerMeta,
        confirmError: { message: reason, provider, at: new Date().toISOString() },
      };
      await booking.save();
      throw new Error(`Airline booking failed (${provider}): ${reason}`);
    }

    booking.bookingStatus = "confirmed";
    booking.paymentStatus = "paid";
    booking.pnrMap = {
      ...booking.pnrMap,
      [provider]: pnr
    };
    // Persist Travelport reservation identifier for cancel / exchange / ticketing lookups
    if (provider === "travelport" && providerResponse?.reservationIdentifier) {
      booking.providerMeta = {
        ...booking.providerMeta,
        reservationIdentifier: providerResponse.reservationIdentifier,
        workbenchId: providerResponse.workbenchId,
      };
    }
    // Persist any ticket numbers returned by the provider at booking time
    if (Array.isArray(providerResponse?.tickets) && providerResponse.tickets.length) {
      booking.tickets = providerResponse.tickets;
    }
    // Persist ticketing status (Travelport: "ticketed" | "held" | "held_ticketing_failed").
    // A held booking that couldn't be ticketed is still a valid PNR — flag it for follow-up.
    if (providerResponse?.ticketingStatus) {
      booking.providerMeta = {
        ...booking.providerMeta,
        ticketingStatus: providerResponse.ticketingStatus,
      };
    }
    await booking.save();

    logger.info("[BookingService] Provider ticketing succeeded", {
      bookingId: booking._id.toString(),
      bookingRef: booking.bookingRef,
      provider,
      pnr,
    });

    // Side-effects: fire-and-forget — never let them abort the confirmation response
    Promise.all([
      bookingEmailQueue.add("booking-confirmation", { bookingId: booking._id.toString() }),
      whatsappQueue.add("booking-confirmation", { bookingId: booking._id.toString(), pnr }),
      NotificationService.queueNotification({
        userId: booking.userId,
        channel: "in_app",
        title: "Booking confirmed",
        body: `Booking ${booking.bookingRef} confirmed.`,
        metadata: { bookingId: booking._id.toString(), bookingRef: booking.bookingRef, pnr }
      })
    ]).catch((err) => {
      console.warn(`[BookingService] Post-confirmation side-effect failed (non-fatal): ${err.message}`);
    });

    return {
      bookingRef: booking.bookingRef,
      pnr,
      status: "confirmed"
    };
  }

  computeProviderCancellationPenalty({ provider, fareFamily, totalFare, hoursBeforeDeparture, spicejetRuleText }) {
    const fareCode = String(fareFamily || "").toUpperCase().charAt(0);
    const fare = Number(totalFare || 0);

    if (provider === "spicejet") {
      if (spicejetRuleText) {
        const matched = spicejetRuleText.match(/INR\s*(\d{3,6})/i);
        if (matched) {
          return Math.min(Number(matched[1]), fare);
        }
      }
      return Math.min(5000, fare);
    }

    if (fareCode === "P") {
      return fare;
    }
    if (fareCode === "V") {
      if (hoursBeforeDeparture > 96) {
        return Math.min(4500, fare);
      }
      if (hoursBeforeDeparture >= 2) {
        return Math.min(5000, fare);
      }
      return fare;
    }
    if (fareCode === "F") {
      if (hoursBeforeDeparture > 96) {
        return Math.min(4500, fare);
      }
      if (hoursBeforeDeparture >= 2) {
        return Math.min(5000, fare);
      }
      return fare;
    }
    return Math.min(5000, fare);
  }

  async cancelBooking(input) {
    const isLegacyShape = input && input.booking;
    const booking = isLegacyShape ? input.booking : await Booking.findByRef(input.bookingRef);
    if (!booking) {
      throw new Error("Booking not found");
    }
    if (!isLegacyShape) {
      if (String(booking.userId) !== String(input.userId)) {
        throw new Error("Not authorized to cancel this booking");
      }
      if (booking.bookingStatus !== "confirmed") {
        throw new Error("Only confirmed bookings can be cancelled");
      }
    }

    const refundToWallet = Boolean(input.refundToWallet);

    const provider = booking.flightDetails.provider;
    const adapter = this.getAdapter(provider);
    const departureAt = new Date(booking.flightDetails.departureAt).getTime();
    const hoursBeforeDeparture = Math.max(0, (departureAt - Date.now()) / (1000 * 60 * 60));

    let spicejetRuleText = null;
    if (provider === "spicejet" && typeof adapter.getFareRules === "function") {
      const rules = await adapter.getFareRules({
        origin: booking.flightDetails.origin,
        destination: booking.flightDetails.destination,
        date: new Date(booking.flightDetails.departureAt).toISOString().slice(0, 10)
      });
      if (!rules.error) {
        spicejetRuleText = rules.rulesText;
      }
    }

    const cancellationPenalty = this.computeProviderCancellationPenalty({
      provider,
      fareFamily: booking.flightDetails.fareFamily,
      totalFare: booking.fareBreakdown.totalFare,
      hoursBeforeDeparture,
      spicejetRuleText
    });
    const refundAmount = Math.max(0, Number(booking.fareBreakdown.totalFare || 0) - cancellationPenalty);

    const providerCancelRes = await adapter.cancelBooking({
      bookingRef: booking.bookingRef,
      pnr: booking.pnrMap?.[provider],
      lastName: booking.passengers?.[0]?.lastName || "NA"
    });
    if (providerCancelRes?.error) {
      // Travelport GDS cancellation can fail in sandbox (fake PNR) or when the
      // session has expired — still cancel the booking locally. Ops can handle
      // GDS-level cleanup manually. Direct-API providers (IndiGo, SpiceJet etc.)
      // must block here because their ticket remains active if the API call failed.
      if (provider === "travelport") {
        console.warn(`[BookingService] Travelport GDS cancel failed — proceeding with local cancellation: ${providerCancelRes.error}`);
      } else {
        throw new Error(providerCancelRes.error);
      }
    }

    await Transaction.create({
      bookingId: booking._id,
      userId: booking.userId,
      amount: refundAmount,
      currency: booking.fareBreakdown.currency || "INR",
      gateway: "razorpay",
      type: "refund",
      status: "pending",
      refundStatus: "pending",
      metadata: {
        cancellationPenalty,
        provider
      }
    });

    booking.bookingStatus = "cancelled";
    booking.cancelledAt = new Date();
    booking.refundAmount = refundAmount;
    booking.refundStatus = "pending";
    booking.paymentStatus = refundAmount > 0 ? "refund_pending" : booking.paymentStatus;
    await booking.save();

    if (refundToWallet && refundAmount > 0) {
      await User.findByIdAndUpdate(
        booking.userId,
        {
          $inc: { walletBalance: refundAmount },
          $push: {
            walletTransactions: {
              amount: refundAmount,
              type: "credit",
              reason: `Refund for ${booking.bookingRef}`,
              date: new Date()
            }
          }
        },
        { new: true }
      );
    }

    return {
      bookingRef: booking.bookingRef,
      refundAmount,
      refundStatus: "pending",
      estimatedCreditDays: "5-7"
    };

    if (isLegacyShape) {
      return {
        booking,
        penalty: cancellationPenalty,
        refundAmount
      };
    }
    return response;
  }

  async getBookingStatus({ bookingRef }) {
    const booking = await Booking.findByRef(bookingRef);
    if (!booking) {
      throw new Error("Booking not found");
    }

    const pendingForMs = Date.now() - new Date(booking.createdAt).getTime();
    if (booking.bookingStatus === "initiated" && pendingForMs > 30 * 60 * 1000) {
      const provider = booking.flightDetails.provider;
      const adapter = this.getAdapter(provider);
      let liveStatus = null;

      if (provider === "airindia" && booking.pnrMap?.airindia && typeof adapter.getBookingByPNR === "function") {
        const live = await adapter.getBookingByPNR({
          pnr: booking.pnrMap.airindia,
          lastName: booking.passengers?.[0]?.lastName || "NA"
        });
        if (!live.error) {
          liveStatus = live.booking?.status || live.booking?.bookingStatus || null;
        }
      } else if (provider === "spicejet" && booking.pnrMap?.spicejet && typeof adapter.cancelBooking === "function") {
        liveStatus = "check_required";
      } else if (provider === "indigo" && booking.pnrMap?.indigo) {
        liveStatus = "check_required";
      }

      if (liveStatus) {
        booking.providerMeta = {
          ...(booking.providerMeta || {}),
          liveStatus
        };
        await booking.save();
      }
    }

    return booking;
  }

  async initiate(params) {
    return this.initiateBooking(params);
  }
}

module.exports = new BookingService();
