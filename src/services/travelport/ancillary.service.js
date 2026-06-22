/**
 * Travelport Trip Services — Ancillary Shopping
 *
 * Seat map:  POST /11/air/search/seat/catalogofferingsancillaries/seatavailabilities
 * Ancillary: POST /11/air/search/catalogofferingsancillaries  (meals, baggage, etc.)
 */

const http = require("./http.client");

const SEAT_MAP_PATH  = "air/search/seat/catalogofferingsancillaries/seatavailabilities";
const ANCILLARY_PATH = "air/search/catalogofferingsancillaries";

// ── Seat map ──────────────────────────────────────────────────────────────────

function buildSeatMapBody({ catalogProductOfferingsIdentifier, catalogProductOfferingIdentifier, productIdentifier, passengers }) {
  const passengerRefs = (passengers || []).map((p, i) => ({ id: `traveler_${i + 1}` }));

  return {
    "@type": "SeatAvailabilityQueryRequest",
    SeatAvailabilityRequest: {
      "@type": "SeatAvailabilityRequestAir",
      CatalogProductOfferingsIdentifier: {
        Identifier: { authority: "Travelport", value: catalogProductOfferingsIdentifier },
      },
      CatalogProductOfferingSelection: {
        CatalogProductOfferingIdentifier: {
          Identifier: { authority: "Travelport", value: catalogProductOfferingIdentifier },
        },
        ProductIdentifier: [
          { Identifier: { authority: "Travelport", value: productIdentifier } },
        ],
      },
      ...(passengerRefs.length ? { PassengerRefs: passengerRefs } : {}),
    },
  };
}

const SEAT_CHAR_MAP = {
  W: "window",
  A: "aisle",
  M: "middle",
  window: "window",
  aisle: "aisle",
  middle: "middle",
};

const COLUMN_LETTERS = ["A", "B", "C", "D", "E", "F"];

function normalizeSeatMap(raw) {
  const seatAvail = raw?.SeatAvailabilityResponse?.SeatAvailability
    || raw?.SeatAvailability
    || raw?.seatAvailability;

  if (!seatAvail) return { available: false, reason: "No seat map data returned from Travelport" };

  // Travelport returns cabins; we flatten into the first economy cabin's rows
  const rawCabins = Array.isArray(seatAvail.CabinAir) ? seatAvail.CabinAir : [];
  if (rawCabins.length === 0) return { available: false, reason: "No cabin data in seat map response" };

  // Use first cabin (economy); merge if multiple
  const allRows = rawCabins.flatMap((cabin) => Array.isArray(cabin.Row) ? cabin.Row : []);
  if (allRows.length === 0) return { available: false, reason: "No rows in seat map response" };

  const rows = [];
  for (const row of allRows) {
    const rowNumber = Number(row.number || row.rowNumber || 0);
    const rawSeats  = Array.isArray(row.Seat) ? row.Seat : [];
    const seats = [];

    for (const seat of rawSeats) {
      const characteristics = Array.isArray(seat.SeatCharacteristic) ? seat.SeatCharacteristic : [];
      const charValues = characteristics.map((c) => c.value || c);

      // Extract column letter from seat number ("12A" → "A") or from column field
      const seatNumber = String(seat.number || seat.seatNumber || "");
      const column = seat.column || seatNumber.replace(/^\d+/, "") || "";

      const occupied = seat.status === "Occupied" || seat.status === "BlockedSeat"
        || seat.available === false || charValues.includes("NoSeat");
      const paid = charValues.some((c) => ["PreferredSeat", "PaidSeat", "ExtraLegroom", "Premium"].includes(c))
        || Number(seat.price?.value ?? seat.Price?.value ?? 0) > 0;
      const price = paid ? Number(seat.price?.value ?? seat.Price?.value ?? 0) : null;

      seats.push({
        code:     seatNumber || `${rowNumber}${column}`,
        column:   column || COLUMN_LETTERS[seats.length] || "",
        available: !occupied,
        occupied,
        paid,
        price,
        characteristics: charValues,
      });
    }

    if (seats.length > 0) rows.push({ rowNumber, seats });
  }

  return { available: true, rows };
}

async function getSeatMap({ catalogProductOfferingsIdentifier, catalogProductOfferingIdentifier, productIdentifier, passengers }) {
  if (!catalogProductOfferingsIdentifier || !catalogProductOfferingIdentifier || !productIdentifier) {
    return { available: false, reason: "Missing session identifiers — seat map requires a priced session" };
  }

  try {
    const body = buildSeatMapBody({ catalogProductOfferingsIdentifier, catalogProductOfferingIdentifier, productIdentifier, passengers });
    const raw  = await http.post(SEAT_MAP_PATH, body);
    return normalizeSeatMap(raw);
  } catch (err) {
    // Travelport seat map requires a stateful GDS session UUID (only available in production).
    // In the sandbox environment the session identifier is a transactionId hex string which
    // the seat availability endpoint rejects. Either way, this is non-critical for booking.
    return {
      available: false,
      reason: 'Seat selection is not available for this flight. You can choose your preferred seat during web check-in on the airline\'s website.',
    };
  }
}

// ── Ancillary shopping (meals, extra baggage, etc.) ───────────────────────────

function buildAncillaryBody({ catalogProductOfferingsIdentifier, catalogProductOfferingIdentifier, productIdentifier, ancillaryTypes }) {
  const types = ancillaryTypes || ["meal", "baggage"];
  return {
    "@type": "CatalogOfferingsQueryAncillaries",
    CatalogOfferingsAncillariesRequest: {
      "@type": "CatalogOfferingsAncillariesRequestAir",
      AncillaryType: types.map((t) => ({ "@type": "AncillaryType", type: String(t).toUpperCase() })),
      CatalogProductOfferingsIdentifier: {
        Identifier: { authority: "Travelport", value: catalogProductOfferingsIdentifier },
      },
      CatalogProductOfferingSelection: {
        CatalogProductOfferingIdentifier: {
          Identifier: { authority: "Travelport", value: catalogProductOfferingIdentifier },
        },
        ProductIdentifier: [
          { Identifier: { authority: "Travelport", value: productIdentifier } },
        ],
      },
    },
  };
}

function normalizeAncillaries(raw) {
  const ancillaries = [];
  const catalog = raw?.CatalogOfferingsAncillaries || raw;
  const offerings = Array.isArray(catalog?.CatalogOfferingAncillary) ? catalog.CatalogOfferingAncillary : [];

  for (const offering of offerings) {
    const price = offering.Price || {};
    ancillaries.push({
      id:          offering.id,
      type:        offering.type || offering.ancillaryType || "",
      description: offering.Description?.value || offering.description || "",
      ssrCode:     offering.ssrCode || "",
      price:       Number(price.TotalPrice?.value ?? price.value ?? 0),
      currency:    price.TotalPrice?.code || price.code || "USD",
    });
  }
  return ancillaries;
}

async function getAncillaries({ catalogProductOfferingsIdentifier, catalogProductOfferingIdentifier, productIdentifier, ancillaryTypes }) {
  if (!catalogProductOfferingsIdentifier || !catalogProductOfferingIdentifier || !productIdentifier) {
    throw new Error("Travelport ancillary: missing identifiers for ancillary request");
  }

  const body = buildAncillaryBody({ catalogProductOfferingsIdentifier, catalogProductOfferingIdentifier, productIdentifier, ancillaryTypes });
  const raw  = await http.post(ANCILLARY_PATH, body);
  return normalizeAncillaries(raw);
}

module.exports = { getSeatMap, getAncillaries };
