const { success } = require("../utils/apiResponse");

const AIRPORTS = [
  { code: "DEL", city: "New Delhi", name: "Indira Gandhi International" },
  { code: "BOM", city: "Mumbai", name: "Chhatrapati Shivaji Maharaj International" },
  { code: "BLR", city: "Bengaluru", name: "Kempegowda International" },
  { code: "MAA", city: "Chennai", name: "Chennai International" },
  { code: "CCU", city: "Kolkata", name: "Netaji Subhas Chandra Bose" },
  { code: "HYD", city: "Hyderabad", name: "Rajiv Gandhi International" },
  { code: "GOI", city: "Goa", name: "Dabolim / Mopa" },
  { code: "COK", city: "Kochi", name: "Cochin International" },
  { code: "PNQ", city: "Pune", name: "Pune International" },
  { code: "AMD", city: "Ahmedabad", name: "Sardar Vallabhbhai Patel International" }
];

const searchAirports = async (req, res) => {
  const q = String(req.query.q || "")
    .trim()
    .toLowerCase();
  const rows = q
    ? AIRPORTS.filter(
        (a) =>
          a.code.toLowerCase().includes(q) ||
          a.city.toLowerCase().includes(q) ||
          a.name.toLowerCase().includes(q)
      )
    : AIRPORTS;
  return res.json(success(rows, "Airports fetched"));
};

const { getNearbyForAirport } = require("../services/nearbyAirports");

const getNearby = async (req, res) => {
  const code = String(req.params.code || "")
    .trim()
    .toUpperCase()
    .slice(0, 3);
  if (!/^[A-Z]{3}$/.test(code)) {
    return res.status(400).json({ success: false, message: "Invalid airport code" });
  }
  const rows = getNearbyForAirport(code);
  return res.json(success(rows, "Nearby airports"));
};

module.exports = {
  searchAirports,
  getNearby
};
