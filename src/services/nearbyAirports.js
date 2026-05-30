/**
 * Alternate airports for fare comparison (curated; extend with geo radius later).
 * Codes must exist in catalog airport search.
 */
const NEARBY_BY_CODE = {
  BOM: [
    { code: "PNQ", label: "Pune", reason: "Often cheaper when BOM fares spike" },
    { code: "GOI", label: "Goa", reason: "Western coast alternate" }
  ],
  DEL: [
    { code: "AMD", label: "Ahmedabad", reason: "Western corridor option" },
    { code: "HYD", label: "Hyderabad", reason: "Central hub alternate" }
  ],
  PNQ: [{ code: "BOM", label: "Mumbai", reason: "Larger hub, more inventory" }],
  BLR: [{ code: "MAA", label: "Chennai", reason: "South India alternate" }],
  MAA: [{ code: "BLR", label: "Bengaluru", reason: "South India alternate" }],
  CCU: [{ code: "HYD", label: "Hyderabad", reason: "Central routing option" }],
  HYD: [{ code: "BLR", label: "Bengaluru", reason: "South hub alternate" }],
  AMD: [{ code: "BOM", label: "Mumbai", reason: "West coast connectivity" }],
  GOI: [{ code: "BOM", label: "Mumbai", reason: "Metro hub alternate" }],
  COK: [{ code: "BLR", label: "Bengaluru", reason: "Domestic hub alternate" }]
};

function normalizeCode(code) {
  return String(code || "")
    .trim()
    .toUpperCase()
    .slice(0, 3);
}

function getNearbyForAirport(code) {
  const c = normalizeCode(code);
  return (NEARBY_BY_CODE[c] || []).map((row) => ({
    code: row.code,
    label: row.label,
    reason: row.reason
  }));
}

module.exports = {
  getNearbyForAirport,
  NEARBY_BY_CODE
};
