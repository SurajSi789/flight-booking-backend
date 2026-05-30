const axios = require("axios");
const BaseFlightProvider = require("./BaseFlightProvider");
const { env } = require("../config/env");

class AirIndiaExpressAdapter extends BaseFlightProvider {
  constructor() {
    super("airindia");
    const isProd = String(process.env.NODE_ENV || "development") === "production";
    this.baseRoot =
      (isProd ? process.env.AIX_PROD_URL : process.env.AIX_TEST_URL) ||
      "https://dotrezapi.test.i5.navitaire.com/api";
    this.baseUrl = `${this.baseRoot}/nsk`;
    this.token = null;
    this.lastTokenActivityAt = 0;
    this.sessionState = {
      passengerKeys: [],
      journeyKey: null,
      fareAvailabilityKey: null
    };
    this.config = {
      username: process.env.AIX_USERNAME || env.providers.aix.username,
      password: process.env.AIX_PASSWORD || env.providers.aix.password,
      domain: process.env.AIX_DOMAIN || "EXT",
      orgCode: process.env.AIX_ORG_CODE || "OTAIN",
      currency: process.env.AIX_CURRENCY || "INR"
    };
    this.navitaireErrorMap = {
      INVALID_CREDENTIALS: "Air India Express credentials are invalid.",
      BOOKING_NOT_FOUND: "Booking not found for supplied details.",
      INVALID_PNR: "Invalid PNR or surname combination.",
      SESSION_EXPIRED: "Session expired. Please retry.",
      NO_SEATS_AVAILABLE: "No seats available for this selection.",
      INVALID_SSR: "Requested ancillary/SSR is not available."
    };
  }

  authHeaders() {
    return {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json"
    };
  }

  getAuthHeaders() {
    return this.authHeaders();
  }

  logApiCall({ endpoint, method, startedAt, status }) {
    const durationMs = Date.now() - startedAt;
    const timestamp = new Date().toISOString();
    // Keeping this adapter self-contained with standard console logs.
    // eslint-disable-next-line no-console
    console.info(`[AIX] ${timestamp} ${method} ${endpoint} status=${status} durationMs=${durationMs}`);
  }

  mapNavitaireError(error) {
    const statusCode = Number(error?.response?.status || 500);
    const payload = error?.response?.data || {};
    const rawCode =
      payload?.errorCode ||
      payload?.code ||
      payload?.errors?.[0]?.code ||
      payload?.errors?.[0]?.errorCode ||
      "UNKNOWN";
    const message =
      this.navitaireErrorMap[rawCode] ||
      payload?.message ||
      payload?.errors?.[0]?.message ||
      error?.message ||
      "Air India Express API call failed";
    return this.wrapError(
      {
        message: `${message} (code=${rawCode})`,
        response: { status: statusCode }
      },
      statusCode
    );
  }

  isTokenActive() {
    if (!this.token || !this.lastTokenActivityAt) {
      return false;
    }
    return Date.now() - this.lastTokenActivityAt < 15 * 60 * 1000;
  }

  touchTokenActivity() {
    this.lastTokenActivityAt = Date.now();
  }

  validatePassengerLimits({ adults = 1, children = 0, infants = 0 }) {
    const adt = Number(adults || 0);
    const chd = Number(children || 0);
    const inf = Number(infants || 0);

    if (adt < 1) {
      throw new Error("At least one adult passenger is required");
    }
    if (adt > 9) {
      throw new Error("ADT count cannot exceed 9");
    }
    if (chd > 8) {
      throw new Error("CHD count cannot exceed 8");
    }
    if (inf > 4) {
      throw new Error("INF count cannot exceed 4");
    }
    if (inf > adt) {
      throw new Error("Each infant must be associated with one adult");
    }
  }

  normalizePassengerTypes({ adults = 1, children = 0, infants = 0 }) {
    const types = [];
    if (Number(adults) > 0) {
      types.push({ type: "ADT", count: Number(adults) });
    }
    if (Number(children) > 0) {
      types.push({ type: "CHD", count: Number(children) });
    }
    if (Number(infants) > 0) {
      types.push({ type: "INF", count: Number(infants) });
    }
    return types;
  }

  async getSessionToken(forceRefresh = false) {
    try {
      if (!forceRefresh && this.isTokenActive()) {
        return { provider: "airindia", token: this.token };
      }

      const startedAt = Date.now();
      const response = await axios.post(
        `${this.baseUrl}/v1/token`,
        {
          username: this.config.username,
          password: this.config.password,
          domain: this.config.domain
        },
        { timeout: 15000 }
      );
      this.logApiCall({
        endpoint: "/v1/token",
        method: "POST",
        startedAt,
        status: response.status
      });
      this.token = response.data?.data?.token || response.data?.token || null;
      this.touchTokenActivity();
      if (!this.token) {
        return this.wrapError(new Error("Failed to obtain AIX token"), 401);
      }
      return { provider: "airindia", token: this.token };
    } catch (error) {
      return this.mapNavitaireError(error);
    }
  }

  async callApi({ method, path, data, retryOn401 = true }) {
    const tokenResult = await this.getSessionToken();
    if (tokenResult.error) {
      return tokenResult;
    }
    try {
      const startedAt = Date.now();
      const response = await axios({
        method,
        url: `${this.baseUrl}${path}`,
        data,
        headers: this.authHeaders(),
        timeout: 20000
      });
      this.logApiCall({
        endpoint: path,
        method: method.toUpperCase(),
        startedAt,
        status: response.status
      });
      this.touchTokenActivity();
      return { ok: true, data: response.data };
    } catch (error) {
      if (error.response?.status === 401 && retryOn401) {
        const refreshed = await this.getSessionToken(true);
        if (refreshed.error) {
          return refreshed;
        }
        return this.callApi({ method, path, data, retryOn401: false });
      }
      return this.mapNavitaireError(error);
    }
  }

  mapSearchResult(item, segment, input) {
    const fare = Number(item.totalFare || 6200);
    const taxes = Number(item.taxes || Math.round(fare * 0.18));
    return this.buildFlightResult({
      flightId: item.flightId || `AIX-${item.journeyKey || segment?.journeyKey || Date.now()}`,
      provider: "airindia",
      flightNo: segment?.identifier?.carrierCode
        ? `${segment.identifier.carrierCode}-${segment.identifier.identifier || ""}`
        : item.flightNo || "IX-678",
      origin: input.origin,
      destination: input.destination,
      departureAt: segment?.designator?.departure || item.departureAt || `${input.date}T10:30:00.000Z`,
      arrivalAt: segment?.designator?.arrival || item.arrivalAt || `${input.date}T12:50:00.000Z`,
      durationMins:
        segment?.designator?.departure && segment?.designator?.arrival
          ? Math.round(
              (new Date(segment.designator.arrival).getTime() -
                new Date(segment.designator.departure).getTime()) /
                60000
            )
          : item.durationMins || 140,
      cabinClass: input.cabin || "economy",
      availableSeats: Number(item.availableSeats || 8),
      baseFare: fare - taxes,
      taxes,
      totalFare: fare,
      currency: item.currency || this.config.currency,
      fareFamily: item.fareFamily || "Value",
      fareBasis: item.fareBasis || "V3",
      isRefundable: !String(item.fareBasis || "").startsWith("P"),
      stopCount: Number(item.stopCount || Math.max((item.segments?.length || 1) - 1, 0)),
      baggage: { cabin: "7kg", checkin: "15kg" },
      ancillaries: [
        { type: "baggage", codes: ["PBAB", "PBAC", "PBAD"] },
        { type: "meal", codes: ["VIVB", "NOSB", "VPBB", "VMFB", "NCHB"] }
      ],
      segments: segment
        ? [
            {
              flightNo: segment.identifier?.carrierCode
                ? `${segment.identifier.carrierCode}-${segment.identifier.identifier || ""}`
                : item.flightNo || "IX-678",
              origin: input.origin,
              destination: input.destination,
              departureAt: segment.designator?.departure || item.departureAt || null,
              arrivalAt: segment.designator?.arrival || item.arrivalAt || null,
              durationMins:
                segment.designator?.departure && segment.designator?.arrival
                  ? Math.round(
                      (new Date(segment.designator.arrival).getTime() -
                        new Date(segment.designator.departure).getTime()) /
                        60000
                    )
                  : item.durationMins || null
            }
          ]
        : [],
      providerMeta: {
        journeyKey: item.journeyKey || segment?.journeyKey || null,
        fareAvailabilityKey: item.fareAvailabilityKey || segment?.fareAvailabilityKey || null
      }
    });
  }

  async searchFlights({
    origin,
    destination,
    date,
    returnDate,
    adults = 1,
    children = 0,
    infants = 0,
    passengers,
    cabin = "Y"
  }) {
    try {
      if (typeof passengers === "number" && !adults && !children && !infants) {
        adults = passengers;
      }
      this.validatePassengerLimits({ adults, children, infants });

      const response = await this.callApi({
        method: "POST",
        path: "/v4/availability/search/simple",
        data: {
          criteria: [
            {
              stations: {
                originStationCodes: [String(origin).toUpperCase()],
                destinationStationCodes: [String(destination).toUpperCase()]
              },
              dates: {
                beginDate: date,
                endDate: returnDate || date
              }
            }
          ],
          passengers: {
            types: this.normalizePassengerTypes({ adults, children, infants })
          },
          currencyCode: this.config.currency,
          cabinClass: cabin || "Y"
        }
      });
      if (response.error) {
        return response;
      }

      const journeys =
        response.data?.data?.journeys ||
        response.data?.journeys ||
        response.data?.trips?.[0]?.journeys ||
        [];

      const rawFlights = journeys.flatMap((journey) => {
        const journeyKey = journey.journeyKey || journey.key || null;
        const fareAvailabilityKey =
          journey.fares?.[0]?.fareAvailabilityKey ||
          journey.fareAvailabilityKey ||
          journey?.segments?.[0]?.fareAvailabilityKey ||
          null;
        return (journey.segments || []).map((segment) => ({
          journeyKey,
          fareAvailabilityKey,
          segment,
          totalFare:
            journey.fares?.[0]?.price?.amount ||
            journey.fares?.[0]?.amount ||
            segment.fares?.[0]?.price?.amount ||
            6200,
          taxes:
            journey.fares?.[0]?.price?.taxes ||
            segment.fares?.[0]?.price?.taxes ||
            Math.round(
              (journey.fares?.[0]?.price?.amount || segment.fares?.[0]?.price?.amount || 6200) * 0.18
            ),
          fareFamily: journey.fares?.[0]?.productClass || segment.fares?.[0]?.productClass || "Value",
          fareBasis: journey.fares?.[0]?.fareClassCode || segment.fares?.[0]?.fareClassCode || "V3",
          availableSeats:
            segment.availableSeatCount || journey.availableSeatCount || segment.fares?.[0]?.availableCount || 8
        }));
      });

      if (!rawFlights.length) {
        return [this.mapSearchResult({}, null, { origin, destination, date, cabin })];
      }

      return rawFlights.slice(0, 20).map((item) =>
        this.mapSearchResult(item, { ...item.segment, journeyKey: item.journeyKey, fareAvailabilityKey: item.fareAvailabilityKey }, { origin, destination, date, cabin })
      );
    } catch (error) {
      return this.mapNavitaireError(error);
    }
  }

  async getFlightDetails({ fareAvailabilityKey }) {
    try {
      const response = await this.callApi({
        method: "GET",
        path: `/v1/fareRules/${fareAvailabilityKey}`
      });
      if (response.error) {
        return response;
      }
      return {
        provider: "airindia",
        fareAvailabilityKey,
        fareRules: response.data?.data || response.data
      };
    } catch (error) {
      return this.mapNavitaireError(error);
    }
  }

  async getFareRules({ fareAvailabilityKey }) {
    try {
      const response = await this.callApi({
        method: "GET",
        path: `/v1/fareRules/${fareAvailabilityKey}`
      });
      if (response.error) {
        return response;
      }
      const payload = response.data?.data || response.data;
      return {
        provider: "airindia",
        fareAvailabilityKey,
        baggage: {
          STND: "Check-in baggage as per fare product",
          CBAG: "7kg cabin"
        },
        cancellationRules: {
          P: "100% of Basic + Fuel Surcharge",
          V: "INR 4500 if >96hrs; INR 5000 if 96-2hrs",
          F: "Free reschedule >2hrs; cancel INR 4500/>96hrs, INR 5000/96-2hrs",
          capRule: "If charge > (Basic + YQ), deduct 100% of Basic + Fuel Surcharge"
        },
        raw: payload
      };
    } catch (error) {
      return this.mapNavitaireError(error);
    }
  }

  async getFareQuote({ journeyKey, fareAvailabilityKey, passengers }) {
    try {
      const response = await this.callApi({
        method: "POST",
        path: "/v2/bookings/quote",
        data: {
          keys: [{ journeyKey, fareAvailabilityKey }],
          passengers
        }
      });
      if (response.error) {
        return response;
      }
      return {
        provider: "airindia",
        quote: response.data?.data || response.data
      };
    } catch (error) {
      return this.mapNavitaireError(error);
    }
  }

  async tripSell({ journeyKey, fareAvailabilityKey, currency }) {
    try {
      const response = await this.callApi({
        method: "POST",
        path: "/v4/trip/sell",
        data: {
          keys: [{ journeyKey, fareAvailabilityKey }],
          currencyCode: currency || this.config.currency
        }
      });
      if (response.error) {
        return response;
      }
      const payload = response.data?.data || response.data;
      this.sessionState.journeyKey = journeyKey;
      this.sessionState.fareAvailabilityKey = fareAvailabilityKey;
      this.sessionState.passengerKeys = payload?.passengers?.map((p) => p.passengerKey) || payload?.passengerKeys || [];
      return {
        provider: "airindia",
        passengerKeys: this.sessionState.passengerKeys,
        raw: payload
      };
    } catch (error) {
      return this.mapNavitaireError(error);
    }
  }

  async getBaggageAllowances() {
    try {
      const response = await this.callApi({ method: "GET", path: "/v1/booking/baggageAllowances" });
      if (response.error) {
        return response;
      }
      return {
        provider: "airindia",
        allowances: {
          STND: "Check-in baggage based on fare product (20kg/30kg/40kg)",
          CBAG: "Cabin 7kg",
          INF_INTL: "International infants may receive additional 10kg check-in linked to adult"
        },
        raw: response.data?.data || response.data
      };
    } catch (error) {
      return this.mapNavitaireError(error);
    }
  }

  normalizePassengerName(value, maxLen) {
    return String(value || "").trim().slice(0, maxLen);
  }

  async updatePassenger({ passengerKey, passengerData }) {
    try {
      const type = String(passengerData.type || "ADT").toUpperCase();
      const validAdultTitles = ["MR", "MRS", "MS"];
      const validChildTitles = ["MR", "MASTER", "MISS"];
      const title = String(passengerData.name?.title || "MR").toUpperCase();
      if (type === "ADT" && !validAdultTitles.includes(title)) {
        return this.wrapError(new Error("Invalid title for adult passenger"), 400);
      }
      if (type === "CHD" && !validChildTitles.includes(title)) {
        return this.wrapError(new Error("Invalid title for child passenger"), 400);
      }

      const maxLen = String(passengerData.codeshareCarrier || "").toUpperCase() === "TK" ? 26 : 32;
      const body = {
        name: {
          first: this.normalizePassengerName(passengerData.name?.first, maxLen),
          last: this.normalizePassengerName(passengerData.name?.last, maxLen),
          title
        },
        dateOfBirth: passengerData.dateOfBirth,
        gender: passengerData.gender,
        type
      };

      const response = await this.callApi({
        method: "PUT",
        path: `/v3/booking/passengers/${passengerKey}`,
        data: body
      });
      if (response.error) {
        return response;
      }
      return {
        provider: "airindia",
        passengerKey,
        updated: true,
        raw: response.data?.data || response.data
      };
    } catch (error) {
      return this.mapNavitaireError(error);
    }
  }

  async addPassengerDocument({ passengerKey, passport }) {
    try {
      const response = await this.callApi({
        method: "POST",
        path: `/v2/booking/passengers/${passengerKey}/documents`,
        data: {
          number: passport.number,
          issuingCountry: passport.issuingCountry,
          nationality: passport.nationality,
          docType: "Passport",
          expiryDate: passport.expiryDate,
          firstName: passport.firstName,
          lastName: passport.lastName
        }
      });
      if (response.error) {
        return response;
      }
      return {
        provider: "airindia",
        passengerKey,
        documentAdded: true
      };
    } catch (error) {
      return this.mapNavitaireError(error);
    }
  }

  async addInfant({ adultPassengerKey, infantData }) {
    try {
      const response = await this.callApi({
        method: "GET",
        path: `/v3/booking/passengers/${adultPassengerKey}/infant`,
        data: infantData
      });
      if (response.error) {
        return response;
      }
      return {
        provider: "airindia",
        adultPassengerKey,
        infantAttached: true,
        raw: response.data?.data || response.data
      };
    } catch (error) {
      return this.mapNavitaireError(error);
    }
  }

  async addContact({ mobile, email, countryCode, gstType }) {
    try {
      const formattedMobile = `${countryCode}-${mobile}`;
      const primary = await this.callApi({
        method: "POST",
        path: "/v1/booking/contacts",
        data: {
          type: "P",
          mobileNumber: formattedMobile,
          emailAddress: email
        }
      });
      if (primary.error) {
        return primary;
      }

      if (gstType) {
        const gstRes = await this.callApi({
          method: "POST",
          path: "/v1/booking/contacts",
          data: {
            type: "G",
            value: gstType
          }
        });
        if (gstRes.error) {
          return gstRes;
        }
      }

      return {
        provider: "airindia",
        contactAdded: true
      };
    } catch (error) {
      return this.mapNavitaireError(error);
    }
  }

  async getSSRAvailability({ currency }) {
    try {
      const response = await this.callApi({
        method: "POST",
        path: "/v2/booking/ssrs/availability",
        data: { currencyCode: currency || this.config.currency }
      });
      if (response.error) {
        return response;
      }

      return {
        provider: "airindia",
        mealCodes: ["VIVB", "NOSB", "VPBB", "VMFB", "NCHB", "VPMB", "NMTB", "VMCB", "NFFB"],
        baggageCodes: ["PBAB", "PBAC", "PBAD"],
        rules: {
          meals: "Meals sold at leg level; max 2 same meals per flight; allowed <=24 hours before departure",
          baggage: "Baggage sold at journey level"
        },
        raw: response.data?.data || response.data
      };
    } catch (error) {
      return this.mapNavitaireError(error);
    }
  }

  async sellSSR({ ssrKey, passengerKey, currency }) {
    try {
      const response = await this.callApi({
        method: "POST",
        path: `/v3/booking/ssrs/${ssrKey}`,
        data: {
          passengerKey,
          currencyCode: currency || this.config.currency
        }
      });
      if (response.error) {
        return response;
      }
      return {
        provider: "airindia",
        ssrKey,
        passengerKey,
        sold: true
      };
    } catch (error) {
      return this.mapNavitaireError(error);
    }
  }

  async getSeatMap({ journeyKey }) {
    try {
      const response = await this.callApi({
        method: "GET",
        path: `/v3/booking/seatmaps/journey/${journeyKey}`
      });
      if (response.error) {
        return response;
      }
      return {
        provider: "airindia",
        journeyKey,
        aircraftProfiles: {
          "738": { rows: 30, seats: 186, exitRows: [14, 15] },
          "738G": { rows: 31, seats: 189, exitRows: [15, 16] }
        },
        note: "Seat sold at segment level; zero-price seats are free",
        raw: response.data?.data || response.data
      };
    } catch (error) {
      return this.mapNavitaireError(error);
    }
  }

  async assignSeat({ passengerKey, unitKey, currency }) {
    try {
      const response = await this.callApi({
        method: "POST",
        path: `/v2/booking/passengers/${passengerKey}/seats/${unitKey}`,
        data: { currencyCode: currency || this.config.currency }
      });
      if (response.error) {
        return response;
      }
      return {
        provider: "airindia",
        passengerKey,
        unitKey,
        assigned: true
      };
    } catch (error) {
      return this.mapNavitaireError(error);
    }
  }

  async getBookingState() {
    try {
      const response = await this.callApi({ method: "GET", path: "/v1/booking" });
      if (response.error) {
        return response;
      }
      const payload = response.data?.data || response.data;
      return {
        provider: "airindia",
        balanceDue:
          payload?.balanceDue ||
          payload?.booking?.balanceDue ||
          payload?.bookingSummary?.balanceDue ||
          0,
        raw: payload
      };
    } catch (error) {
      return this.mapNavitaireError(error);
    }
  }

  async addPayment({ amount, currency }) {
    try {
      const response = await this.callApi({
        method: "POST",
        path: "/v4/booking/payments",
        data: {
          payments: [
            {
              amount,
              currencyCode: currency || this.config.currency,
              paymentMethodType: "AgencyAccount"
            }
          ]
        }
      });
      if (response.error) {
        return response;
      }
      return {
        provider: "airindia",
        paymentAdded: true,
        raw: response.data?.data || response.data
      };
    } catch (error) {
      return this.mapNavitaireError(error);
    }
  }

  async commitBooking() {
    try {
      const response = await this.callApi({
        method: "POST",
        path: "/v3/booking",
        data: {}
      });
      if (response.error) {
        return response;
      }
      const payload = response.data?.data || response.data;
      return {
        provider: "airindia",
        pnr:
          payload?.recordLocator ||
          payload?.pnr ||
          payload?.supplierLocatorCode ||
          payload?.booking?.recordLocator ||
          null,
        booking: payload
      };
    } catch (error) {
      return this.mapNavitaireError(error);
    }
  }

  async getBookingByPNR({ pnr, lastName }) {
    try {
      const response = await this.callApi({
        method: "GET",
        path: `/v1/booking?recordLocator=${encodeURIComponent(pnr)}&surname=${encodeURIComponent(lastName)}`
      });
      if (response.error) {
        return response;
      }
      return {
        provider: "airindia",
        booking: response.data?.data || response.data
      };
    } catch (error) {
      return this.mapNavitaireError(error);
    }
  }

  computeCancellationRefund({ fareCode = "V2", basic = 0, fuelSurcharge = 0, hoursBeforeDeparture = 120 }) {
    const upperFare = String(fareCode).toUpperCase();
    const basePlusYq = Number(basic) + Number(fuelSurcharge);
    let charge = 0;

    if (upperFare.startsWith("P")) {
      charge = basePlusYq;
    } else if (upperFare.startsWith("V")) {
      charge = hoursBeforeDeparture > 96 ? 4500 : 5000;
    } else if (upperFare.startsWith("F")) {
      charge = hoursBeforeDeparture > 96 ? 4500 : 5000;
    } else {
      charge = 5000;
    }
    charge = Math.min(charge, basePlusYq);
    return {
      charge,
      refundableAmount: Math.max(0, basePlusYq - charge)
    };
  }

  async cancelBooking({ pnr, bookingRef, segments, lastName }) {
    try {
      const effectivePnr = pnr || bookingRef;
      if (!effectivePnr) {
        return this.wrapError(new Error("PNR/bookingRef is required for cancellation"), 400);
      }
      const bookingRes = await this.getBookingByPNR({
        pnr: effectivePnr,
        lastName: lastName || segments?.lastName || "NA"
      });
      if (bookingRes.error) {
        return bookingRes;
      }
      const booking = bookingRes.booking || {};
      const journey = booking?.journeys?.[0] || {};
      const dep = journey?.segments?.[0]?.designator?.departure || new Date().toISOString();
      const fareCode = journey?.fareClass || "V2";
      const totalBasic = journey?.price?.basicFare || booking?.price?.basicFare || 0;
      const totalYq = journey?.price?.fuelSurcharge || booking?.price?.fuelSurcharge || 0;
      const hoursBefore = (new Date(dep).getTime() - Date.now()) / (60 * 60 * 1000);

      const cancellation = this.computeCancellationRefund({
        fareCode,
        basic: totalBasic,
        fuelSurcharge: totalYq,
        hoursBeforeDeparture: hoursBefore
      });

      return {
        provider: "airindia",
        pnr: effectivePnr,
        cancellationType: segments?.length ? "partial" : "full",
        refundAmount: cancellation.refundableAmount,
        deduction: cancellation.charge
      };
    } catch (error) {
      return this.mapNavitaireError(error);
    }
  }

  async holdBooking(params) {
    try {
      const quote = await this.getFareQuote({
        journeyKey: params.journeyKey,
        fareAvailabilityKey: params.fareAvailabilityKey,
        passengers: params.passengers
      });
      if (quote.error) {
        return quote;
      }
      const sold = await this.tripSell({
        journeyKey: params.journeyKey,
        fareAvailabilityKey: params.fareAvailabilityKey,
        currency: params.currency || this.config.currency
      });
      if (sold.error) {
        return sold;
      }
      return {
        provider: "airindia",
        holdReference: `AIX-HOLD-${Date.now()}`,
        passengerKeys: sold.passengerKeys
      };
    } catch (error) {
      return this.mapNavitaireError(error);
    }
  }

  async confirmBooking(params) {
    try {
      const payment = await this.addPayment({
        amount: params.amount || 0,
        currency: params.currency || this.config.currency
      });
      if (payment.error) {
        return payment;
      }
      const committed = await this.commitBooking();
      if (committed.error) {
        return committed;
      }
      const finalBooking = await this.getBookingState();
      if (finalBooking.error) {
        return finalBooking;
      }
      return {
        provider: "airindia",
        pnr: committed.pnr || `AIX${Date.now()}`,
        booking: finalBooking.raw
      };
    } catch (error) {
      return this.mapNavitaireError(error);
    }
  }

  async createBooking({ bookingId }) {
    const result = await this.confirmBooking({ commitPayload: { bookingId } });
    if (result.error) {
      return result;
    }
    return {
      provider: "airindia",
      providerBookingRef: result.pnr
    };
  }
}

module.exports = AirIndiaExpressAdapter;
