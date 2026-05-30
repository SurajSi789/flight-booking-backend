const axios = require("axios");
const crypto = require("crypto");
const BaseFlightProvider = require("./BaseFlightProvider");
const { env } = require("../config/env");

class FlightRoutes24Adapter extends BaseFlightProvider {
  constructor() {
    super("flightroutes24");
    const isProd = String(process.env.NODE_ENV || "development") === "production";
    this.baseUrl = isProd
      ? process.env.FR24_PROD_URL || "http://flight.flightroutes24.com/api"
      : process.env.FR24_TEST_URL || "http://flight-test.flightroutes24.com/api";
    this.cid = process.env.FR24_CID || env.providers.flightRoutes24.cid;
  }

  formatDateForFr24(date) {
    const d = new Date(date);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    return `${yyyy}/${mm}/${dd}`;
  }

  parseFr24DateTime(value) {
    const raw = String(value || "");
    if (!/^\d{12}$/.test(raw)) {
      return null;
    }
    const yyyy = Number(raw.slice(0, 4));
    const mm = Number(raw.slice(4, 6));
    const dd = Number(raw.slice(6, 8));
    const hh = Number(raw.slice(8, 10));
    const ii = Number(raw.slice(10, 12));
    return new Date(Date.UTC(yyyy, mm - 1, dd, hh, ii)).toISOString();
  }

  mapSegmentToFlight(segment, routeData) {
    const departureAt = this.parseFr24DateTime(segment.depTime) || new Date().toISOString();
    const arrivalAt = this.parseFr24DateTime(segment.arrTime) || new Date().toISOString();
    const flightNumber = String(segment.flightNumber || "").trim();
    const flightIdSource = `${this.cid}:${flightNumber}:${segment.depTime}`;

    return this.buildFlightResult({
      flightId: crypto.createHash("sha256").update(flightIdSource).digest("hex").slice(0, 16),
      provider: "flightroutes24",
      flightNo: flightNumber,
      origin: segment.depAirport,
      destination: segment.arrAirport,
      departureAt,
      arrivalAt,
      durationMins: Number(segment.duration || 0),
      cabinClass: segment.cabinGrade || "Y",
      availableSeats: Number(segment.availSeatNum || 0),
      baseFare: Number(segment.baseFare || segment.price || 0),
      taxes: Number(segment.tax || 0),
      totalFare: Number(segment.totalFare || segment.price || 0),
      currency: segment.currency || "INR",
      fareFamily: segment.cabin || "",
      fareBasis: segment.fareBasis || "",
      isRefundable: false,
      stopCount: Number(segment.stops || 0),
      baggage: { cabin: "7kg", checkin: "15kg" },
      ancillaries: [],
      segments: [
        {
          flightNo: flightNumber,
          origin: segment.depAirport,
          destination: segment.arrAirport,
          departureAt,
          arrivalAt,
          durationMins: Number(segment.duration || 0)
        }
      ],
      providerMeta: {
        data: routeData?.data || null,
        routeData,
        segmentData: segment
      }
    });
  }

  async requestJson({ method, path, data }) {
    try {
      const response = await axios({
        method,
        url: `${this.baseUrl}${path}`,
        headers: {
          "Content-Type": "application/json"
        },
        data,
        timeout: 20000
      });
      return { ok: true, data: response.data };
    } catch (error) {
      return this.wrapError(error, error?.response?.status || 500);
    }
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
      const requestBody = {
        cid: this.cid,
        fromCity: String(origin).toUpperCase(),
        toCity: String(destination).toUpperCase(),
        fromDate: this.formatDateForFr24(date),
        retDate: returnDate ? this.formatDateForFr24(returnDate) : "",
        flightType: returnDate ? 2 : 1,
        adultNum: Number(adults || passengers?.adults || passengers || 1),
        childrenNum: Number(children || passengers?.children || 0),
        infantNum: Number(infants || passengers?.infants || 0),
        language: "EN",
        travelPreference: {
          cabinGrade: cabin || "Y"
        }
      };

      const response = await this.requestJson({
        method: "GET",
        path: "/overseas/search.do",
        data: requestBody
      });
      if (response.error) {
        return response;
      }

      const routes = response.data?.routes || response.data?.data?.routes || [];
      const flights = [];

      for (const route of routes) {
        for (const segment of route.fromSegments || []) {
          flights.push(this.mapSegmentToFlight(segment, route));
        }
        for (const segment of route.retSegment || []) {
          flights.push(this.mapSegmentToFlight(segment, route));
        }
      }

      return flights;
    } catch (error) {
      return this.wrapError(error, 500);
    }
  }

  async verifyFlight({ routeData, flightData, adults = 1, children = 0, infants = 0 }) {
    try {
      const requestBody = {
        flightType: routeData?.flightType || (routeData?.retSegment?.length ? 2 : 1),
        cid: this.cid,
        adultNum: Number(adults || routeData?.adultNum || 1),
        childrenNum: Number(children || routeData?.childrenNum || 0),
        infantNum: Number(infants || routeData?.infantNum || 0),
        route: {
          data: routeData?.data,
          fromSegments: routeData?.fromSegments || [],
          retSegment: routeData?.retSegment || []
        }
      };

      const response = await this.requestJson({
        method: "GET",
        path: "/overseas/verify.do",
        data: requestBody
      });
      if (response.error) {
        return response;
      }

      return {
        provider: "flightroutes24",
        valid: true,
        verifiedData: response.data?.data || response.data,
        routeData,
        flightData
      };
    } catch (error) {
      return this.wrapError(error, 500);
    }
  }

  async getFareRules({ data, orderNo = "" }) {
    try {
      const response = await this.requestJson({
        method: "POST",
        path: "/fareRule/query.do",
        data: {
          cid: this.cid,
          data,
          orderNo
        }
      });
      if (response.error) {
        return response;
      }
      return {
        provider: "flightroutes24",
        fareRules: response.data?.data || response.data
      };
    } catch (error) {
      return this.wrapError(error, 500);
    }
  }

  async createBooking({ bookingId }) {
    return {
      provider: this.providerName,
      providerBookingRef: `FR24-${bookingId}`
    };
  }
}

module.exports = FlightRoutes24Adapter;
