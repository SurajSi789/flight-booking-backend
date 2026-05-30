const axios = require("axios");
const BaseFlightProvider = require("./BaseFlightProvider");

class AkasaAirAdapter extends BaseFlightProvider {
  constructor() {
    super("akasa");

    const isProd = String(process.env.NODE_ENV || "staging") === "production";

    this.baseRoot =
      (isProd ? process.env.AKASA_PROD_URL : process.env.AKASA_TEST_URL) ||
      "https://{BASE_URL}/api";

    this.baseUrl = `${this.baseRoot}/nsk`;

    this.token = null;
    this.lastTokenActivityAt = 0;

    this.config = {
      username: process.env.AKASA_USERNAME,
      password: process.env.AKASA_PASSWORD,
      domain: "EXT",
      currency: "INR"
    };
  }

  authHeaders() {
    return {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json"
    };
  }

  isTokenActive() {
    return this.token && Date.now() - this.lastTokenActivityAt < 15 * 60 * 1000;
  }

  async getSessionToken(forceRefresh = false) {
    if (!forceRefresh && this.isTokenActive()) {
      return { token: this.token };
    }

    try {
      const res = await axios.post(`${this.baseUrl}/v2/token`, {
        credentials: {
          username: this.config.username,
          password: this.config.password,
          domain: this.config.domain
        }
      });

      this.token = res.data?.data?.token;
      this.lastTokenActivityAt = Date.now();

      return { token: this.token };
    } catch (err) {
      return this.wrapError(err, 401);
    }
  }

  async callApi({ method, path, data }) {
    const tokenRes = await this.getSessionToken();
    if (tokenRes.error) return tokenRes;

    try {
      const res = await axios({
        method,
        url: `${this.baseUrl}${path}`,
        data,
        headers: this.authHeaders()
      });

      return { ok: true, data: res.data };
    } catch (err) {
      return this.wrapError(err, err?.response?.status || 500);
    }
  }

  normalizePassengerTypes({ adults = 1, children = 0, infants = 0 }) {
    const types = [];

    if (adults) types.push({ type: "ADT", count: adults });
    if (children) types.push({ type: "CHD", count: children });
    if (infants) types.push({ type: "INFT", count: infants }); // 👈 important

    return types;
  }

  async searchFlights({ origin, destination, date, adults = 1, children = 0, infants = 0 }) {
    const faresAvailable = response.data?.data?.faresAvailable || {};
    const trips = response.data?.data?.trips || [];

    const journeys =
    trips[0]?.journeysAvailableByMarket?.[`${origin}|${destination}`] || [];

    return journeys.map((journey) => {
    const segment = journey.segments[0];

    const totalFare = this.extractFare(journey, faresAvailable);

    return this.buildFlightResult({
        flightId: journey.journeyKey,
        provider: "akasa",
        flightNo: `${segment.identifier.carrierCode}-${segment.identifier.identifier}`,
        origin,
        destination,
        departureAt: segment.designator.departure,
        arrivalAt: segment.designator.arrival,
        durationMins:
        (new Date(segment.designator.arrival) -
            new Date(segment.designator.departure)) /
        60000,
        totalFare,
        currency: "INR",
        providerMeta: {
        journeyKey: journey.journeyKey,
        fareAvailabilityKey: journey.fares?.[0]?.fareAvailabilityKey
        }
    });
    });
  }

  async extractFare(journey, faresAvailable) {
    try {
        const fareKey = journey?.fares?.[0]?.fareAvailabilityKey;
        if (!fareKey) return null;

        const fareObj = faresAvailable?.[fareKey];
        return fareObj?.totals?.fareTotal || null;
    } catch (e) {
        return null;
    }
  }

  async tripSell({ journeyKey, fareAvailabilityKey, passengers }) {
    return this.callApi({
      method: "POST",
      path: "/v4/trip/sell",
      data: {
        keys: [{ journeyKey, fareAvailabilityKey }],
        passengers: {
          types: passengers
        },
        currencyCode: "INR"
      }
    });
  }
}

module.exports = AkasaAirAdapter;