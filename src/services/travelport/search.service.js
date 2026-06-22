/**
 * Travelport Trip Services V11 — Flight Search
 *
 * Actual response shape (from live API, NOT the Postman mock):
 *
 *  CatalogProductOfferingsResponse
 *    transactionId                           ← session ID for pricing step
 *    CatalogProductOfferings
 *      CatalogProductOffering[]              ← one per fare/brand combination
 *        id: "o1"
 *        Departure / Arrival                 ← route OD (may be via city, not final airport)
 *        ProductBrandOptions[]
 *          flightRefs: ["s3","s4"]           ← which flights this option uses
 *          ProductBrandOffering[]
 *            Product[0].productRef: "p0"     ← points to ReferenceListProduct
 *            BestCombinablePrice             ← price object
 *            ContentSource: "GDS"
 *    ReferenceList[]
 *      ReferenceListFlight                   ← Flight keyed by .id ("s1", "s2" …)
 *      ReferenceListProduct                  ← Product keyed by .id ("p0", "p1" …)
 *                                               contains FlightSegment[].Flight.FlightRef
 *                                               and PassengerFlight[].FlightProduct[] (cabin, fareBasis)
 *      ReferenceListBrand                    ← Brand keyed by .id ("b0" …) [may exist]
 *      ReferenceListTermsAndConditions       ← T&Cs keyed by .id ("T0" …) [may exist]
 */

const http = require("./http.client");

const SEARCH_PATH = "air/catalog/search/catalogproductofferings";

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseDurationMins(iso) {
  if (!iso) return 0;
  const m = String(iso).match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  return m ? Number(m[1] || 0) * 60 + Number(m[2] || 0) : 0;
}

function toDateTime(date, time) {
  if (!date) return null;
  return new Date(`${date}T${time || "00:00:00"}`);
}

const CABIN_MAP = {
  Y: "Economy", economy: "Economy",
  W: "PremiumEconomy", premiumeconomy: "PremiumEconomy",
  C: "Business", business: "Business",
  F: "First", first: "First",
};

// ── Request builders ──────────────────────────────────────────────────────────

function buildPassengerCriteria({ adults = 1, children = 0, infants = 0 }) {
  const list = [];
  if (adults > 0)   list.push({ "@type": "PassengerCriteria", number: adults,   passengerTypeCode: "ADT" });
  if (children > 0) list.push({ "@type": "PassengerCriteria", number: children, passengerTypeCode: "CHD" });
  if (infants > 0)  list.push({ "@type": "PassengerCriteria", number: infants,  passengerTypeCode: "INF" });
  return list;
}

function buildSearchLegs({ origin, destination, departureDate, returnDate }) {
  const legs = [
    { "@type": "SearchCriteriaFlight", departureDate, From: { value: origin }, To: { value: destination } },
  ];
  if (returnDate) {
    legs.push({
      "@type": "SearchCriteriaFlight",
      departureDate: returnDate,
      From: { value: destination },
      To: { value: origin },
    });
  }
  return legs;
}

function buildSearchBody({ origin, destination, departureDate, returnDate, adults, children, infants, cabin, contentSourceList }) {
  const cabinValue = CABIN_MAP[cabin] || CABIN_MAP[String(cabin || "").toLowerCase()] || "Economy";
  return {
    "@type": "CatalogProductOfferingsQueryRequest",
    CatalogProductOfferingsRequest: {
      "@type": "CatalogProductOfferingsRequestAir",
      contentSourceList: contentSourceList || ["GDS"],
      PassengerCriteria: buildPassengerCriteria({ adults, children, infants }),
      SearchCriteriaFlight: buildSearchLegs({ origin, destination, departureDate, returnDate }),
      SearchModifiersAir: {
        "@type": "SearchModifiersAir",
        CabinPreference: [{ "@type": "CabinPreference", preferenceType: "Preferred", cabins: [cabinValue] }],
      },
    },
  };
}

// ── Reference index builders ──────────────────────────────────────────────────

function buildIndexes(referenceList) {
  const flightIndex   = {};
  const productIndex  = {};
  const brandIndex    = {};
  const termsIndex    = {};

  for (const refList of (referenceList || [])) {
    switch (refList["@type"]) {
      case "ReferenceListFlight":
        for (const f of (refList.Flight || [])) {
          if (f.id) flightIndex[f.id] = f;
        }
        break;
      case "ReferenceListProduct":
        for (const p of (refList.Product || [])) {
          if (p.id) productIndex[p.id] = p;
        }
        break;
      case "ReferenceListBrand":
        for (const b of (refList.Brand || [])) {
          if (b.id) brandIndex[b.id] = b;
        }
        break;
      case "ReferenceListTermsAndConditions":
        for (const t of (refList.TermsAndConditions || [])) {
          if (t.id) termsIndex[t.id] = t;
        }
        break;
    }
  }
  return { flightIndex, productIndex, brandIndex, termsIndex };
}

// ── Per-offering normalizer ───────────────────────────────────────────────────

function extractBaggageFromTerms(termsData) {
  if (!termsData) return { cabin: null, checkin: null };
  const allowances = termsData.BaggageAllowance || [];
  let checkin = null;
  let cabin   = null;
  for (const ba of allowances) {
    const item = (ba.BaggageItem || [])[0];
    if (!item) continue;
    if (ba.baggageType === "FirstCheckedBag") {
      const kg = item.Measurement?.[0]?.value;
      checkin = kg != null ? `${kg}kg` : (item.includedInOfferPrice === "Yes" ? "included" : "chargeable");
    } else if (ba.baggageType === "CarryOn") {
      const kg = item.Measurement?.[0]?.value;
      const pc = item.quantity;
      if (kg != null) cabin = `${kg}kg`;
      else if (pc) cabin = `${pc}pc`;
    }
  }
  return { cabin: cabin || "7kg", checkin: checkin || "15kg" };
}

function normalizeOffering(offering, { flightIndex, productIndex, brandIndex, termsIndex, brandAttribIndex }, sessionId) {
  // An offering can have multiple ProductBrandOptions (different flight timing combinations).
  // We emit one result per ProductBrandOptions × ProductBrandOffering combination.
  const results = [];

  for (const pbo of (offering.ProductBrandOptions || [])) {
    for (const brandOffering of (pbo.ProductBrandOffering || [])) {
      const productRef = (brandOffering.Product || [])[0]?.productRef;
      const product    = productIndex[productRef];
      if (!product) continue;

      // Resolve flight segments from the product
      const segments = [];
      for (const seg of (product.FlightSegment || [])) {
        const flightRef = seg.Flight?.FlightRef;
        const flight    = flightIndex[flightRef];
        if (!flight) continue;

        const depDT = toDateTime(flight.Departure?.date, flight.Departure?.time);
        const arrDT = toDateTime(flight.Arrival?.date,   flight.Arrival?.time);

        segments.push({
          flightNo:    `${flight.carrier}-${flight.number}`,
          origin:      flight.Departure?.location || "",
          destination: flight.Arrival?.location   || "",
          departureAt: depDT,
          arrivalAt:   arrDT,
          durationMins: parseDurationMins(flight.duration),
          equipment:   flight.equipment || null,
          operatingCarrier: flight.operatingCarrier || flight.carrier || null,
          terminal: {
            departure: flight.Departure?.terminal || null,
            arrival:   flight.Arrival?.terminal   || null,
          },
        });
      }

      if (segments.length === 0) continue;

      const first = segments[0];
      const last  = segments[segments.length - 1];

      // Total duration: sum of segment durations, or wall-clock if segment data missing
      const durationMins = parseDurationMins(product.totalDuration) ||
        segments.reduce((s, seg) => s + (seg.durationMins || 0), 0);

      // Price from BestCombinablePrice
      const price    = brandOffering.BestCombinablePrice || {};
      const currency = price.CurrencyCode?.value || "INR";
      const baseFare = Number(price.Base       ?? 0);
      const taxes    = Number(price.TotalTaxes ?? 0);
      const totalFare = Number(price.TotalPrice ?? baseFare + taxes);

      // Cabin & fare details from PassengerFlight
      const paxFlight  = (product.PassengerFlight || [])[0] || {};
      const flightProd = (paxFlight.FlightProduct || [])[0] || {};
      const cabinClass = (flightProd.cabin || "Economy").toLowerCase().replace(/\s/g, "");
      const fareBasis  = flightProd.fareBasisCode || "";
      const fareType   = flightProd.fareType      || "";

      // Brand name from BrandRef → brandIndex (has real brand names from ReferenceListBrand)
      const brandRef  = brandOffering.Brand?.BrandRef;
      const brandData = (brandAttribIndex || {})[brandRef] || brandIndex[brandRef] || {};
      const fareFamily = brandData.name || brandData.Name || brandRef || "";

      // Terms & conditions (baggage, refundability, penalties)
      const termsRef  = brandOffering.TermsAndConditions?.termsAndConditionsRef;
      const termsData = termsIndex[termsRef] || {};
      const baggage   = extractBaggageFromTerms(termsData);

      // Refundability: check brand attributes first (most reliable), then fare type
      const brandAttribs = brandData.BrandAttribute || [];
      const refundAttrib = brandAttribs.find((a) => a.classification === "Refund");
      const isRefundable = refundAttrib
        ? refundAttrib.inclusion === "Included"
        : Boolean(termsData.refundable ?? (String(fareType).toLowerCase().includes("refund")));

      // Available seats from product.Quantity
      const availableSeats = Number(product.Quantity ?? 9);

      // Extract the IATA carrier code from the first segment's flightNo ("EY-219" → "EY")
      const carrierCode = first.flightNo.split("-")[0] || "";

      results.push({
        flightId: `TP-${offering.id}-${productRef || "x"}`,
        provider: "travelport",
        carrierCode,
        flightNo: first.flightNo,
        origin:      first.origin,
        destination: last.destination,
        departureAt: first.departureAt,
        arrivalAt:   last.arrivalAt,
        durationMins,
        cabinClass,
        availableSeats,
        baseFare,
        taxes,
        totalFare,
        currency,
        fareFamily,
        fareBasis,
        isRefundable,
        stopCount: segments.length - 1,
        baggage,
        ancillaries: ["meal", "baggage", "seat"],
        segments,
        providerMeta: {
          // sessionId = CatalogProductOfferings.Identifier.value (production UUID)
          //             OR transactionId (sandbox fallback — no stateful GDS session)
          sessionId,            // used as CatalogProductOfferingsIdentifier in price request
          offeringId: offering.id, // e.g. "o1"
          productId:  productRef,  // e.g. "p0"
          contentSource: brandOffering.ContentSource || "GDS",
          // searchPrice preserved as fallback when sandbox pricing step fails
          searchPrice: { baseFare, taxes, totalFare, currency },
        },
      });
    }
  }

  return results;
}

// ── Public API ────────────────────────────────────────────────────────────────

async function searchFlights({
  origin, destination, departureDate, returnDate,
  adults = 1, children = 0, infants = 0,
  cabin = "Y", contentSourceList,
}) {
  const body = buildSearchBody({ origin, destination, departureDate, returnDate, adults, children, infants, cabin, contentSourceList });
  const raw  = await http.post(SEARCH_PATH, body);

  const responseWrapper = raw?.CatalogProductOfferingsResponse;
  if (!responseWrapper) {
    throw new Error("Travelport search: unexpected response — CatalogProductOfferingsResponse not found");
  }

  const transactionId    = responseWrapper.transactionId;
  const catalogOfferings = responseWrapper.CatalogProductOfferings;
  const rawOfferings     = catalogOfferings?.CatalogProductOffering || [];
  const referenceList    = responseWrapper.ReferenceList || [];
  // In production, CatalogProductOfferings.Identifier.value is the GDS session UUID
  // needed for the pricing step. In sandbox it is absent (only transactionId is present).
  const sessionId        = catalogOfferings?.Identifier?.value || transactionId;

  const indexes = buildIndexes(referenceList);

  // Also index BrandAttributes from ReferenceListBrand for baggage/refund display
  const brandAttribIndex = {};
  for (const rl of referenceList) {
    if (rl["@type"] === "ReferenceListBrand") {
      for (const b of (rl.Brand || [])) {
        if (b.id) brandAttribIndex[b.id] = b;
      }
    }
  }

  const flights = rawOfferings
    .flatMap((o) => normalizeOffering(o, { ...indexes, brandAttribIndex }, sessionId))
    .filter((f) => f.origin && f.destination && f.totalFare > 0);

  return {
    flights,
    meta: {
      transactionId,
      sessionId,
      rawOfferingCount: rawOfferings.length,
      normalizedCount: flights.length,
    },
  };
}

module.exports = { searchFlights, buildSearchBody };
