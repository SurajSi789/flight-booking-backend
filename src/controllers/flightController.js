const { success } = require("../utils/apiResponse");
const FlightSearchOrchestrator = require("../services/FlightSearchOrchestrator");

const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
};

const safeJsonParse = (value, field) => {
  try {
    return JSON.parse(value);
  } catch (error) {
    const parseError = new Error(`Invalid JSON in ${field}`);
    parseError.statusCode = 400;
    throw parseError;
  }
};

const searchFlights = async (req, res) => {
  const { origin, destination, date, returnDate, cabin = "Y", maxStops, maxPrice, preferredCarrier } = req.query;
  const passengers = {
    adults: Number(req.query["passengers.adults"] || req.query.adults || 1),
    children: Number(req.query["passengers.children"] || req.query.children || 0),
    infants: Number(req.query["passengers.infants"] || req.query.infants || 0)
  };

  const result = await FlightSearchOrchestrator.search({
    origin,
    destination,
    date,
    returnDate,
    passengers,
    cabin,
    maxStops,
    maxPrice,
    preferredCarrier
  });

  return res.json(success(result, "Flights fetched"));
};

const verifyFlight = async (req, res) => {
  const { provider, routeData, flightData } = req.query;
  const result = await FlightSearchOrchestrator.verifyFlight({
    provider,
    routeData: safeJsonParse(routeData, "routeData"),
    flightData: flightData ? safeJsonParse(flightData, "flightData") : null,
    adults: Number(req.query["passengers.adults"] || 1),
    children: Number(req.query["passengers.children"] || 0),
    infants: Number(req.query["passengers.infants"] || 0)
  });

  if (result?.error) {
    return res.status(result.code || 400).json({ success: false, message: result.error });
  }
  return res.json(success(result, "Flight verified"));
};

const getFareCalendar = async (req, res) => {
  const origin = String(req.query.origin || "").toUpperCase();
  const destination = String(req.query.destination || "").toUpperCase();
  const month = String(req.query.month || "");
  if (!/^[A-Z]{3}$/.test(origin) || !/^[A-Z]{3}$/.test(destination) || origin === destination) {
    return res.status(400).json({ success: false, message: "Invalid origin or destination" });
  }
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ success: false, message: "month must be YYYY-MM" });
  }
  const [y, m] = month.split("-").map(Number);
  if (m < 1 || m > 12) {
    return res.status(400).json({ success: false, message: "Invalid month" });
  }

  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const monthStartUtc = Date.UTC(y, m - 1, 1);
  const nextMonth = new Date(Date.UTC(y, m, 1));
  const monthEndDay = new Date(nextMonth.getTime() - 86400000).getUTCDate();

  const dates = [];
  for (let d = 1; d <= monthEndDay; d += 1) {
    const dtUtc = Date.UTC(y, m - 1, d);
    if (dtUtc < todayUtc) {
      continue;
    }
    dates.push(`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
  }

  const passengers = {
    adults: Number(req.query.adults || req.query["passengers.adults"] || 1),
    children: Number(req.query.children || req.query["passengers.children"] || 0),
    infants: Number(req.query.infants || req.query["passengers.infants"] || 0)
  };

  const daysOut = [];
  for (const batch of chunk(dates, 4)) {
    /* eslint-disable no-await-in-loop */
    const batchRows = await Promise.all(
      batch.map(async (dateStr) => {
        try {
          const result = await FlightSearchOrchestrator.search({
            origin,
            destination,
            date: dateStr,
            passengers,
            cabin: req.query.cabin || "Y"
          });
          const flights = Array.isArray(result?.flights) ? result.flights : [];
          const fares = flights.map((f) => Number(f.totalFare || 0)).filter((n) => Number.isFinite(n) && n > 0);
          const minFare = fares.length ? Math.min(...fares) : null;
          return { date: dateStr, minFare, flightCount: flights.length };
        } catch {
          return { date: dateStr, minFare: null, flightCount: 0 };
        }
      })
    );
    /* eslint-enable no-await-in-loop */
    daysOut.push(...batchRows);
  }

  const faresPresent = daysOut.map((d) => d.minFare).filter((v) => v != null);
  const globalMin = faresPresent.length ? Math.min(...faresPresent) : null;
  const globalMax = faresPresent.length ? Math.max(...faresPresent) : null;

  return res.json(
    success(
      {
        origin,
        destination,
        month,
        days: daysOut,
        summary: { minFare: globalMin, maxFare: globalMax }
      },
      "Fare calendar ready"
    )
  );
};

const getFareRules = async (req, res) => {
  const { provider, data, orderNo, fareAvailabilityKey, origin, destination, date } = req.query;
  const result = await FlightSearchOrchestrator.getFareRules({
    provider,
    data: data ? safeJsonParse(data, "data") : null,
    orderNo,
    fareAvailabilityKey,
    origin,
    destination,
    date
  });

  if (result?.error) {
    return res.status(result.code || 400).json({ success: false, message: result.error });
  }
  return res.json(success(result, "Fare rules fetched"));
};

module.exports = {
  searchFlights,
  verifyFlight,
  getFareCalendar,
  getFareRules
};
