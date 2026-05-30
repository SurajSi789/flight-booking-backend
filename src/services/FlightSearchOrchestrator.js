const crypto = require("crypto");
const NodeCache = require("node-cache");
const IndigoAdapter = require("../providers/IndigoAdapter");
const AirIndiaExpressAdapter = require("../providers/AirIndiaExpressAdapter");
const SpiceJetAdapter = require("../providers/SpiceJetAdapter");
const FlightRoutes24Adapter = require("../providers/FlightRoutes24Adapter");
const AkasaAirAdapter = require("../providers/AkasaAirAdapter");

class FlightSearchOrchestrator {
  constructor() {
    this.cache = new NodeCache({ stdTTL: 300, checkperiod: 60 });
    this.providers = {
      indigo: new IndigoAdapter(),
      airindia: new AirIndiaExpressAdapter(),
      spicejet: new SpiceJetAdapter(),
      flightroutes24: new FlightRoutes24Adapter(),
      akasaair: new AkasaAirAdapter()
    };
  }

  isFr24Enabled() {
    return String(process.env.FR24_ENABLED || "true").toLowerCase() !== "false";
  }

  getAdapters() {
    const adapters = [
      { name: "indigo", adapter: this.providers.indigo },
      { name: "airindia", adapter: this.providers.airindia },
      { name: "spicejet", adapter: this.providers.spicejet },
      { name: "akasaair", adapter: this.providers.akasaair }
    ];
    if (this.isFr24Enabled()) {
      adapters.push({ name: "flightroutes24", adapter: this.providers.flightroutes24 });
    }
    return adapters;
  }

  // 🔥 stable cache key
  buildCacheKey(criteria) {
    return crypto
      .createHash("sha256")
      .update(JSON.stringify(this.sortObject(criteria)))
      .digest("hex");
  }

  sortObject(obj) {
    return Object.keys(obj)
      .sort()
      .reduce((acc, key) => {
        acc[key] =
          typeof obj[key] === "object" && obj[key] !== null
            ? this.sortObject(obj[key])
            : obj[key];
        return acc;
      }, {});
  }

  // 🔥 improved dedupe
  deduplicateFlights(flights) {
    const map = new Map();

    for (const flight of flights) {
      if (!flight) continue;

      const key = `${flight.flightNo}|${flight.departureAt}|${flight.origin}|${flight.destination}`;

      if (!map.has(key)) {
        map.set(key, flight);
        continue;
      }

      const existing = map.get(key);

      const newFare = Number(flight.totalFare || Infinity);
      const oldFare = Number(existing.totalFare || Infinity);

      if (newFare < oldFare) {
        map.set(key, {
          ...flight,
          providerMeta: {
            ...(existing.providerMeta || {}),
            ...(flight.providerMeta || {}),
            sources: [
              ...(existing.providerMeta?.sources || [
                { provider: existing.provider, totalFare: existing.totalFare }
              ]),
              { provider: flight.provider, totalFare: flight.totalFare }
            ]
          }
        });
      } else {
        map.set(key, {
          ...existing,
          providerMeta: {
            ...(existing.providerMeta || {}),
            sources: [
              ...(existing.providerMeta?.sources || [
                { provider: existing.provider, totalFare: existing.totalFare }
              ]),
              { provider: flight.provider, totalFare: flight.totalFare }
            ]
          }
        });
      }
    }

    return [...map.values()];
  }

  applyFilters(flights, filters = {}) {
    return flights.filter((flight) => {
      if (!flight || !flight.totalFare) return false;

      if (
        typeof filters.maxStops !== "undefined" &&
        Number(flight.stopCount || 0) > Number(filters.maxStops)
      ) {
        return false;
      }

      if (
        typeof filters.maxPrice !== "undefined" &&
        Number(flight.totalFare) > Number(filters.maxPrice)
      ) {
        return false;
      }

      if (filters.preferredCarrier) {
        const carrier = String(filters.preferredCarrier).toUpperCase();
        const code = (flight.flightNo || "").replace(/[^A-Z]/g, "").slice(0, 2);
        if (code !== carrier) return false;
      }

      return true;
    });
  }

  getProvider(providerName) {
    return this.providers[String(providerName || "").toLowerCase()] || null;
  }

  async _runAdapterSearch({ origin, destination, date, cabin, passengers, adults, children, infants }) {
    const adapters = this.getAdapters();
    const settled = await Promise.allSettled(
      adapters.map(({ adapter }) =>
        adapter.searchFlights({ origin, destination, date, cabin, passengers, adults, children, infants })
      )
    );
    const providerResults = {};
    const merged = [];
    settled.forEach((result, idx) => {
      const providerName = adapters[idx].name;
      if (result.status === "rejected") {
        providerResults[providerName] = { status: "rejected" };
        return;
      }
      const value = result.value;
      if (value?.error) {
        providerResults[providerName] = { status: "error", error: value.error };
        return;
      }
      const rows = Array.isArray(value) ? value.filter((item) => item && item.totalFare) : [];
      providerResults[providerName] = { status: "ok", count: rows.length };
      merged.push(...rows);
    });
    return { merged, providerResults };
  }

  async search(criteria) {
    const normalizedCriteria = {
      origin: String(criteria.origin || "").toUpperCase(),
      destination: String(criteria.destination || "").toUpperCase(),
      date: criteria.date,
      returnDate: criteria.returnDate || null,
      passengers: {
        adults: Number(criteria.passengers?.adults || criteria.adults || 1),
        children: Number(criteria.passengers?.children || 0),
        infants: Number(criteria.passengers?.infants || 0)
      },
      cabin: criteria.cabin || "Y",
      filters: {
        maxStops: criteria.maxStops,
        maxPrice: criteria.maxPrice,
        preferredCarrier: criteria.preferredCarrier
      }
    };

    const cacheKey = this.buildCacheKey(normalizedCriteria);
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return { ...cached, meta: { ...cached.meta, cacheHit: true } };
    }

    const isRoundTrip = !!normalizedCriteria.returnDate;
    const adapterParams = {
      cabin: normalizedCriteria.cabin,
      passengers: normalizedCriteria.passengers.adults,
      adults: normalizedCriteria.passengers.adults,
      children: normalizedCriteria.passengers.children,
      infants: normalizedCriteria.passengers.infants
    };

    const [outbound, returnLeg] = await Promise.all([
      this._runAdapterSearch({
        ...adapterParams,
        origin: normalizedCriteria.origin,
        destination: normalizedCriteria.destination,
        date: normalizedCriteria.date
      }),
      isRoundTrip
        ? this._runAdapterSearch({
            ...adapterParams,
            origin: normalizedCriteria.destination,
            destination: normalizedCriteria.origin,
            date: normalizedCriteria.returnDate
          })
        : Promise.resolve({ merged: [], providerResults: {} })
    ]);

    const flights = this.applyFilters(
      this.deduplicateFlights(outbound.merged),
      normalizedCriteria.filters
    ).sort((a, b) => Number(a.totalFare) - Number(b.totalFare));

    const response = {
      flights,
      ...(isRoundTrip && {
        returnFlights: this.applyFilters(
          this.deduplicateFlights(returnLeg.merged),
          normalizedCriteria.filters
        ).sort((a, b) => Number(a.totalFare) - Number(b.totalFare))
      }),
      meta: {
        providerResults: outbound.providerResults,
        ...(isRoundTrip && { returnProviderResults: returnLeg.providerResults }),
        searchedAt: new Date().toISOString(),
        cacheHit: false
      }
    };

    this.cache.set(cacheKey, response, 300);
    return response;
  }

  async getSeatMap({ provider = "indigo", airSegment, hostToken, hostTokenKey, travelers = [] }) {
    const adapter = this.getProvider(provider);
    if (!adapter) {
      return { error: "Unsupported provider", code: 400 };
    }
    if (typeof adapter.getSeatMap !== "function") {
      return { available: false, reason: "Seat selection is not supported for this provider" };
    }
    return adapter.getSeatMap({ airSegment, hostToken, hostTokenKey, travelers });
  }

  async getFareRules({ provider }) {
    const adapter = this.getProvider(provider);

    if (!adapter) {
      return { provider, error: "Unsupported provider", code: 400 };
    }if (!adapter) { 
      return { 
        provider, error: "Unsupported provider", code: 400 
      }; 
    } if (provider === "flightroutes24") { 
      return adapter.getFareRules({ data, orderNo }); 
    } if (provider === "airindia") { 
      return adapter.getFareRules({ fareAvailabilityKey }); 
    } if (provider === "spicejet") { 
      return adapter.getFareRules({ origin, destination, date }); 
    } if (provider === "akasaair") {
      return {
        provider,
        error: "Fare rules not supported for AkasaAir",
        code: 400
      };
    }

    return { provider, error: "Not implemented", code: 400 };
  }
}

module.exports = new FlightSearchOrchestrator();