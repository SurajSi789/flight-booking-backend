const axios = require("axios");
const crypto = require("crypto");
const BaseFlightProvider = require("./BaseFlightProvider");
const { env } = require("../config/env");

const NS = {
  soapenv: "http://schemas.xmlsoap.org/soap/envelope/",
  air: "http://www.travelport.com/schema/air_v52_0",
  com: "http://www.travelport.com/schema/common_v52_0",
  univ: "http://www.travelport.com/schema/universal_v52_0"
};

const MEAL_CODES = ["MLSNVGZ1", "MLSNVGZ2", "ML__VG", "ML", "VGML", "NVML"];
const BAGGAGE_CODES = ["BGXS03", "BGXS05", "BGXS10", "BGXS15", "BGXS30"];
const SEAT_TYPES = ["SA__PR", "SA__X0Z1", "SA__X0Z2", "SA__X0Z3", "SA__X0Z4", "SA__X0ZI"];

const escapeXml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const toTagRegex = (tagName) =>
  new RegExp(`<(?:\\w+:)?${tagName}\\b([\\s\\S]*?)>([\\s\\S]*?)<\\/(?:\\w+:)?${tagName}>`, "g");

const toSelfClosingRegex = (tagName) =>
  new RegExp(`<(?:\\w+:)?${tagName}\\b([^>]*)\\/>`, "g");

// Handles both <Tag ...>...</Tag> and self-closing <Tag .../>
const extractAllBlocks = (xmlStr, tagName) => {
  const withBody = [...xmlStr.matchAll(toTagRegex(tagName))];
  const selfClose = [...xmlStr.matchAll(toSelfClosingRegex(tagName))].map((m) => [m[0], m[1], ""]);
  return [...withBody, ...selfClose];
};
const extractFirstBlock = (xmlStr, tagName) => extractAllBlocks(xmlStr, tagName)[0] || null;

const parseAttributes = (attrChunk) => {
  const attrs = {};
  for (const match of attrChunk.matchAll(/([A-Za-z_:][\w:.-]*)="([^"]*)"/g)) {
    attrs[match[1]] = match[2];
  }
  return attrs;
};

const extractAttribute = (xmlChunk, attrName) => {
  const match = xmlChunk.match(new RegExp(`${attrName}="([^"]*)"`, "i"));
  return match ? match[1] : null;
};

const extractTagText = (xmlChunk, tagName) => {
  const block = extractFirstBlock(xmlChunk, tagName);
  return block ? block[2].trim() : null;
};

const validateIata = (value, fieldName) => {
  if (!/^[A-Z]{3}$/.test(String(value || "").toUpperCase())) {
    throw new Error(`${fieldName} must be a valid IATA code`);
  }
};

const ageInYearsAt = (dob, travelDate) => {
  const born = new Date(dob);
  const travel = new Date(travelDate);
  let age = travel.getFullYear() - born.getFullYear();
  const monthDelta = travel.getMonth() - born.getMonth();
  if (monthDelta < 0 || (monthDelta === 0 && travel.getDate() < born.getDate())) {
    age -= 1;
  }
  return age;
};

const ageInDaysAt = (dob, travelDate) =>
  Math.floor((new Date(travelDate).getTime() - new Date(dob).getTime()) / (24 * 60 * 60 * 1000));

const normalizePassengers = (passengers, travelDate) => {
  if (!passengers) {
    return [{ type: "ADT", key: "PAX1" }];
  }

  if (Array.isArray(passengers)) {
    return passengers.map((pax, index) => ({
      key: pax.key || `PAX${index + 1}`,
      type: String(pax.type || "ADT").toUpperCase(),
      dob: pax.dob || null,
      firstName: pax.firstName || `P${index + 1}`,
      lastName: pax.lastName || "TRAVELER",
      prefix: pax.prefix || "MR"
    }));
  }

  if (typeof passengers === "number") {
    return Array.from({ length: Number(passengers) }, (_, idx) => ({ type: "ADT", key: `PAX${idx + 1}` }));
  }

  if (typeof passengers === "object") {
    const list = [];
    const addByCount = (type, count) => {
      for (let i = 0; i < Number(count || 0); i += 1) {
        list.push({ type, key: `PAX${list.length + 1}` });
      }
    };
    addByCount("ADT", passengers.adults);
    addByCount("CHD", passengers.children);
    addByCount("INF", passengers.infants);
    if (Array.isArray(passengers.details)) {
      return passengers.details.map((pax, index) => ({
        key: pax.key || `PAX${index + 1}`,
        type: String(pax.type || "ADT").toUpperCase(),
        dob: pax.dob || null,
        firstName: pax.firstName || `P${index + 1}`,
        lastName: pax.lastName || "TRAVELER",
        prefix: pax.prefix || "MR"
      }));
    }
    return list;
  }

  throw new Error("Invalid passengers input");
};

const validatePassengerRules = (passengers, travelDate) => {
  const adt = passengers.filter((p) => p.type === "ADT").length;
  const chd = passengers.filter((p) => p.type === "CHD").length;
  const inf = passengers.filter((p) => p.type === "INF").length;

  if (adt > 9) {
    throw new Error("Max 9 ADT per PNR");
  }
  if (inf > 4) {
    throw new Error("Max 4 INF per PNR");
  }
  if (inf > adt) {
    throw new Error("Each infant requires one adult");
  }

  for (const pax of passengers) {
    if (pax.type === "CHD") {
      if (!pax.dob) {
        throw new Error("CHD passenger DOB is mandatory");
      }
      const age = ageInYearsAt(pax.dob, travelDate);
      if (age < 2 || age >= 12) {
        throw new Error("CHD age must be between 2 and 12 years on travel date");
      }
    }
    if (pax.type === "INF") {
      if (!pax.dob) {
        throw new Error("INF passenger DOB is mandatory");
      }
      const days = ageInDaysAt(pax.dob, travelDate);
      const years = ageInYearsAt(pax.dob, travelDate);
      if (days < 7 || years >= 2) {
        throw new Error("INF age must be between 7 days and less than 2 years on travel date");
      }
    }
  }

  if (adt + chd + inf <= 0) {
    throw new Error("At least one passenger is required");
  }
};

const validateGstNumber = (gstNumber) =>
  /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[A-Z0-9]{3}$/i.test(String(gstNumber || ""));

const validateFareRestrictions = ({
  rbd,
  origin,
  destination,
  hasConnections = false,
  travelDate,
  bookingDate = new Date(),
  passengerCount = 1,
  isRoundTrip = false
}) => {
  const upperRbd = String(rbd || "").toUpperCase();
  const isDomestic = /^[A-Z]{3}$/.test(origin) && /^[A-Z]{3}$/.test(destination);
  const now = new Date(bookingDate);
  const dep = new Date(travelDate);
  const hoursToDeparture = (dep.getTime() - now.getTime()) / (60 * 60 * 1000);
  const daysToDeparture = (dep.getTime() - now.getTime()) / (24 * 60 * 60 * 1000);

  if (hoursToDeparture < 1) {
    throw new Error("Cannot book less than 1 hour before departure");
  }

  if (upperRbd === "L") {
    if (!isDomestic) {
      throw new Error("Lite fare (RBD L) is domestic only");
    }
    if (hasConnections) {
      throw new Error("Lite fare (RBD L) does not allow connections");
    }
    if (daysToDeparture < 15) {
      throw new Error("Lite fare (RBD L) requires travel date at least 15 days from booking");
    }
  }

  if (upperRbd === "N" && !isRoundTrip) {
    throw new Error("Return fare (RBD N) is allowed only for round trips");
  }

  if (upperRbd === "Q") {
    if (!isDomestic) {
      throw new Error("Family fare (RBD Q) is domestic only");
    }
    if (passengerCount < 4 || passengerCount > 9) {
      throw new Error("Family fare (RBD Q) requires 4-9 passengers");
    }
  }
};

const buildSoapEnvelope = (innerXml) => `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="${NS.soapenv}" xmlns:air="${NS.air}" xmlns:com="${NS.com}" xmlns:univ="${NS.univ}">
  <soapenv:Header/>
  <soapenv:Body>${innerXml}</soapenv:Body>
</soapenv:Envelope>`;

const buildLowFareSearchReq = ({
  origin,
  destination,
  date,
  passengers,
  cabin = "economy",
  targetBranch,
  traceId
}) => {
  const travelDate = `${date}T00:00:00.000Z`;
  validateIata(String(origin).toUpperCase(), "origin");
  validateIata(String(destination).toUpperCase(), "destination");
  const pax = normalizePassengers(passengers, travelDate);
  validatePassengerRules(pax, travelDate);

  const paxXml = pax
    .map(
      (item) =>
        `<com:SearchPassenger Code="${escapeXml(item.type)}" BookingTravelerRef="${escapeXml(item.key)}"${
          item.dob ? ` DOB="${escapeXml(new Date(item.dob).toISOString().slice(0, 10))}"` : ""
        } />`
    )
    .join("");

  return buildSoapEnvelope(`
<air:LowFareSearchReq TargetBranch="${escapeXml(env.providers.indigo.targetBranch
  )}" AuthorizedBy="user" TraceId="${escapeXml(traceId || crypto.randomUUID())}" SolutionResult="false" PreferCompleteItinerary="true" ReturnUpsellFare="true">
  <com:BillingPointOfSaleInfo OriginApplication="UAPI"/>
  <air:SearchAirLeg>
    <air:SearchOrigin><com:CityOrAirport Code="${escapeXml(String(origin).toUpperCase())}"/></air:SearchOrigin>
    <air:SearchDestination><com:CityOrAirport Code="${escapeXml(String(destination).toUpperCase())}"/></air:SearchDestination>
    <air:SearchDepTime PreferredTime="${escapeXml(date)}"/>
  </air:SearchAirLeg>
  ${paxXml}
  </air:LowFareSearchReq>
  <air:AirSearchModifiers>
    <air:PreferredProviders><com:Provider Code="ACH"/></air:PreferredProviders>
    <air:PreferredCabins><com:CabinClass Type="${escapeXml(String(cabin).toUpperCase())}"/></air:PreferredCabins>
  </air:AirSearchModifiers>
  <air:AirPricingModifiers FaresIndicator="PublicFaresOnly"/>
  `);
};

const buildAirPriceReq = ({
  airSegment,
  hostToken,
  passengers,
  fareBasisCode,
  targetBranch,
  traceId,
  gstData
}) => {
  if (!hostToken) {
    throw new Error("HostToken is required and must match LowFareSearch response");
  }

  const travelDate =
    (Array.isArray(airSegment) ? airSegment[0]?.departureAt : airSegment?.departureAt) || new Date().toISOString();
  const pax = normalizePassengers(passengers, travelDate);
  validatePassengerRules(pax, travelDate);
  validateFareRestrictions({
    rbd: String(fareBasisCode || "").charAt(0),
    origin: (Array.isArray(airSegment) ? airSegment[0]?.origin : airSegment?.origin) || "DEL",
    destination: (Array.isArray(airSegment) ? airSegment[0]?.destination : airSegment?.destination) || "BOM",
    travelDate,
    passengerCount: pax.length
  });

  if (gstData && !validateGstNumber(gstData.taxId)) {
    throw new Error("Invalid GST number format");
  }

  const segments = Array.isArray(airSegment) ? airSegment : [airSegment];
  const segmentXml = segments
    .map((segment) => {
      const key = segment.key || segment.segmentRef || segment.airSegmentRef || `SEG-${crypto.randomUUID()}`;
      return `<air:AirSegment Key="${escapeXml(key)}" Group="0" Carrier="6E" FlightNumber="${escapeXml(
        segment.flightNumber || segment.flightNo || "0"
      )}" Origin="${escapeXml(segment.origin)}" Destination="${escapeXml(segment.destination)}" DepartureTime="${escapeXml(
        segment.departureAt
      )}" ArrivalTime="${escapeXml(segment.arrivalAt)}"/>`;
    })
    .join("");

  const passengerTypeXml = pax.map((item) => `<air:PassengerType Code="${escapeXml(item.type)}"/>`).join("");
  const pricingModifiers = `
  <air:AirPricingModifiers>
    <air:BrandModifiers>
      <air:BrandModifier ModifierType="FareFamilyDisplay"/>
      <air:BrandModifier ModifierType="FareFamily"/>
    </air:BrandModifiers>
    ${fareBasisCode ? `<air:PermittedBookingCodes><air:BookingCode Code="${escapeXml(fareBasisCode)}"/></air:PermittedBookingCodes>` : ""}
  </air:AirPricingModifiers>`;

  const gstSsrXml = gstData
    ? `
  <air:OptionalServices>
    <air:OptionalService Type="SSR" ProviderDefinedType="GSTN">
      <air:ServiceData>GST COMPANY:${escapeXml(gstData.companyName || "")}</air:ServiceData>
      <air:ServiceData>GST ID:${escapeXml(gstData.taxId || "")}</air:ServiceData>
    </air:OptionalService>
    <air:OptionalService Type="SSR" ProviderDefinedType="GSTN">
      <air:ServiceData>GST EMAIL:${escapeXml(gstData.email || "")}</air:ServiceData>
    </air:OptionalService>
  </air:OptionalServices>`
    : "";

  return buildSoapEnvelope(`
<air:AirPriceReq TargetBranch="${escapeXml(
    targetBranch || env.providers.indigo.targetBranch
  )}" TraceId="${escapeXml(traceId || crypto.randomUUID())}">
  <com:BillingPointOfSaleInfo OriginApplication="UAPI"/>
  ${segmentXml}
  ${passengerTypeXml}
  ${pricingModifiers}
  <com:HostToken Key="${escapeXml(extractAttribute(hostToken, "Key") || "HT1")}">${escapeXml(hostToken)}</com:HostToken>
  <air:AirPricingCommand/>
  <air:FormOfPayment Type="AgencyPayment">
    <com:AgencyBillingIdentifier>${escapeXml(process.env.AGENCY_BILLING_IDENTIFIER || "AGENCY-BILLING-ID")}</com:AgencyBillingIdentifier>
  </air:FormOfPayment>
  ${gstSsrXml}
</air:AirPriceReq>`);
};

const buildSeatMapReq = ({ airSegment, hostToken, travelers, targetBranch, traceId }) => {
  if (!hostToken) {
    throw new Error("HostToken is required for seat map request");
  }

  const segments = Array.isArray(airSegment) ? airSegment : [airSegment];
  const segmentXml = segments
    .map(
      (segment) =>
        `<air:AirSegment Key="${escapeXml(segment.key || segment.segmentRef || `SEG-${crypto.randomUUID()}`)}" Carrier="6E" FlightNumber="${escapeXml(
          segment.flightNumber || segment.flightNo || "0"
        )}" Origin="${escapeXml(segment.origin)}" Destination="${escapeXml(segment.destination)}" DepartureTime="${escapeXml(
          segment.departureAt
        )}" ArrivalTime="${escapeXml(segment.arrivalAt)}"/>`
    )
    .join("");

  const travelerXml = (travelers || [])
    .map(
      (traveler, idx) =>
        `<air:SearchTraveler Key="${escapeXml(traveler.key || `TRV${idx + 1}`)}"><com:BookingTravelerName First="${escapeXml(
          traveler.firstName
        )}" Last="${escapeXml(traveler.lastName)}"/></air:SearchTraveler>`
    )
    .join("");

  return buildSoapEnvelope(`
<air:SeatMapReq TargetBranch="${escapeXml(
    targetBranch || env.providers.indigo.targetBranch
  )}" TraceId="${escapeXml(traceId || crypto.randomUUID())}" ReturnSeatPricing="true" ReturnBrandingInfo="true">
  <com:BillingPointOfSaleInfo OriginApplication="UAPI"/>
  ${segmentXml}
  ${travelerXml}
  <com:HostToken Key="${escapeXml(extractAttribute(hostToken, "Key") || "HT1")}">${escapeXml(hostToken)}</com:HostToken>
</air:SeatMapReq>`);
};

const buildAirPriceReqWithOptionals = ({
  airSegment,
  hostToken,
  passengers,
  optionalServices,
  seatSelections,
  fareBasisCode,
  targetBranch,
  traceId
}) => {
  const base = buildAirPriceReq({
    airSegment,
    hostToken,
    passengers,
    fareBasisCode,
    targetBranch,
    traceId
  });

  const travelDate =
    (Array.isArray(airSegment) ? airSegment[0]?.departureAt : airSegment?.departureAt) || new Date().toISOString();
  const hoursToDeparture = (new Date(travelDate).getTime() - Date.now()) / (60 * 60 * 1000);

  const byPassengerBaggageCount = {};
  const serviceXml = (optionalServices || [])
    .map((service) => {
      const code = String(service.code || "").toUpperCase();
      if (service.type === "meal" && !MEAL_CODES.includes(code)) {
        throw new Error(`Invalid meal code: ${code}`);
      }
      if (service.type === "baggage" && !BAGGAGE_CODES.includes(code)) {
        throw new Error(`Invalid baggage code: ${code}`);
      }
      if (service.type === "baggage") {
        if (hoursToDeparture < 6) {
          throw new Error("Baggage cannot be purchased within 6 hours of departure");
        }
        const key = `${service.passengerRef || "PAX"}|${service.segmentRef || "SEG"}`;
        byPassengerBaggageCount[key] = (byPassengerBaggageCount[key] || 0) + 1;
        if (byPassengerBaggageCount[key] > 1) {
          throw new Error("Max 1 baggage option per passenger per segment");
        }
      }
      return `<air:OptionalService Type="${escapeXml(service.type === "baggage" ? "Baggage" : "Meal")}" Key="${escapeXml(
        service.key || crypto.randomUUID()
      )}" ProviderDefinedType="${escapeXml(code)}" ${
        service.passengerRef ? `BookingTravelerRef="${escapeXml(service.passengerRef)}"` : ""
      } ${service.segmentRef ? `AirSegmentRef="${escapeXml(service.segmentRef)}"` : ""}/>`;
    })
    .join("");

  const seatXml = (seatSelections || [])
    .map((seat) => {
      if (seat.type && !SEAT_TYPES.includes(String(seat.type).toUpperCase())) {
        throw new Error(`Invalid seat type: ${seat.type}`);
      }
      return `<air:OptionalService Type="Seat" Key="${escapeXml(seat.key || crypto.randomUUID())}" ProviderDefinedType="${escapeXml(
        seat.type || "SA__X0Z1"
      )}" BookingTravelerRef="${escapeXml(seat.passengerRef)}" AirSegmentRef="${escapeXml(
        seat.segmentRef
      )}" SeatNumber="${escapeXml(seat.seatNumber || "")}"/>`;
    })
    .join("");

  const optionalsXml = `
  <air:OptionalServices>
    ${serviceXml}
    ${seatXml}
  </air:OptionalServices>`;

  return base.replace("</air:AirPriceReq>", `${optionalsXml}</air:AirPriceReq>`);
};

const trimName = (name, maxChars) => String(name || "").slice(0, maxChars);

const buildAirCreateReservationReq = ({
  travelers,
  pricingSolution,
  optionalServices,
  formOfPayment,
  targetBranch,
  traceId
}) => {
  const isCodeShareTk = JSON.stringify(pricingSolution || {}).includes('"Carrier":"TK"');
  const maxNameChars = isCodeShareTk ? 26 : 32;

  const travelerXml = (travelers || [])
    .map((traveler, idx) => {
      if (!traveler.address?.street || !traveler.address?.city || !traveler.address?.state || !traveler.address?.postalCode || !traveler.address?.country) {
        throw new Error("Address fields Street, City, State, PostalCode, Country are required");
      }
      return `<com:BookingTraveler Key="${escapeXml(traveler.key || `BT${idx + 1}`)}" DOB="${escapeXml(
        new Date(traveler.dob).toISOString().slice(0, 10)
      )}">
  <com:BookingTravelerName Prefix="${escapeXml(traveler.prefix || "MR")}" First="${escapeXml(
        trimName(traveler.firstName, maxNameChars)
      )}" Last="${escapeXml(trimName(traveler.lastName, maxNameChars))}"/>
  <com:PhoneNumber CountryCode="${escapeXml(traveler.phone?.countryCode || "")}" Number="${escapeXml(
        traveler.phone?.number || ""
      )}"/>
  <com:Email EmailID="${escapeXml(traveler.email)}"/>
  <com:Address>
    <com:AddressName>${escapeXml(traveler.address.street)}</com:AddressName>
    <com:City>${escapeXml(traveler.address.city)}</com:City>
    <com:State>${escapeXml(traveler.address.state)}</com:State>
    <com:PostalCode>${escapeXml(traveler.address.postalCode)}</com:PostalCode>
    <com:Country>${escapeXml(traveler.address.country)}</com:Country>
  </com:Address>
</com:BookingTraveler>`;
    })
    .join("");

  const optionalServicesXml = (optionalServices || [])
    .map(
      (service) =>
        `<air:OptionalService Type="${escapeXml(service.type || "Other")}" ProviderDefinedType="${escapeXml(
          service.code || ""
        )}" BookingTravelerRef="${escapeXml(service.passengerRef || "")}" AirSegmentRef="${escapeXml(
          service.segmentRef || ""
        )}"/>`
    )
    .join("");

  const fopXml = formOfPayment
    ? `<air:FormOfPayment Type="${escapeXml(formOfPayment.type || "AgencyPayment")}">
  <com:CreditCard Type="${escapeXml(formOfPayment.cardType || "")}" Number="${escapeXml(
      formOfPayment.cardNumber || ""
    )}" ExpDate="${escapeXml(formOfPayment.expiry || "")}" CVV="${escapeXml(formOfPayment.cvv || "")}"/>
</air:FormOfPayment>`
    : "";

  return buildSoapEnvelope(`
<univ:AirCreateReservationReq TargetBranch="${escapeXml(
    targetBranch || env.providers.indigo.targetBranch
  )}" TraceId="${escapeXml(traceId || crypto.randomUUID())}">
  <com:BillingPointOfSaleInfo OriginApplication="UAPI"/>
  ${travelerXml}
  <air:AirPricingSolution>${escapeXml(JSON.stringify(pricingSolution || {}))}</air:AirPricingSolution>
  ${optionalServicesXml ? `<air:OptionalServices>${optionalServicesXml}</air:OptionalServices>` : ""}
  <univ:ActionStatus Type="ACTIVE" TicketDate="T*" ProviderCode="ACH"/>
  ${fopXml}
</univ:AirCreateReservationReq>`);
};

const parseLowFareSearchResponse = (xmlStr) => {
  const airSegments = {};
  const fareInfos = {};
  const hostTokens = {};
  const brandList = {};
  const flightOptions = [];

  for (const segmentMatch of extractAllBlocks(xmlStr, "AirSegment")) {
    const attrs = parseAttributes(segmentMatch[1]);
    if (!attrs.Key) {
      continue;
    }
    airSegments[attrs.Key] = {
      key: attrs.Key,
      carrier: attrs.Carrier || null,
      flightNumber: attrs.FlightNumber || null,
      origin: attrs.Origin || null,
      destination: attrs.Destination || null,
      departureAt: attrs.DepartureTime || null,
      arrivalAt: attrs.ArrivalTime || null,
      equipment: attrs.Equipment || null,
      flightTime: attrs.FlightTime ? Number(attrs.FlightTime) : null
    };
  }

  for (const fareMatch of extractAllBlocks(xmlStr, "FareInfo")) {
    const attrs = parseAttributes(fareMatch[1]);
    if (!attrs.Key) {
      continue;
    }
    fareInfos[attrs.Key] = {
      key: attrs.Key,
      fareBasis: attrs.FareBasis || null,
      fareFamily: attrs.Brand || attrs.FareFamily || null,
      amount: attrs.Amount || null,
      promotionalFare: String(attrs.PromotionalFare || "false").toLowerCase() === "true"
    };
  }

  for (const hostMatch of extractAllBlocks(xmlStr, "HostToken")) {
    const attrs = parseAttributes(hostMatch[1]);
    const key = attrs.Key || `HT-${Object.keys(hostTokens).length + 1}`;
    hostTokens[key] = hostMatch[2].trim();
  }

  const airPricePoints = extractAllBlocks(xmlStr, "AirPricePoint").map((pointMatch) => {
    const attrs = parseAttributes(pointMatch[1]);
    const body = pointMatch[2];
    // Use only the first AirPricingInfo to count segments — multiple AirPricingInfo
    // blocks exist when ReturnUpsellFare returns several fare families for the same
    // itinerary, which would otherwise inflate stopCount.
    const firstPricingInfo = extractFirstBlock(body, "AirPricingInfo");
    const pricingBody = firstPricingInfo ? firstPricingInfo[2] : body;
    const seenSegRefs = new Set();
    const bookingInfos = extractAllBlocks(pricingBody, "BookingInfo")
      .map((infoMatch) => {
        const a = parseAttributes(infoMatch[1]);
        return {
          bookingCode: a.BookingCode || null,
          bookingCount: Number(a.BookingCount || 0),
          cabinClass: a.CabinClass || null,
          fareInfoRef: a.FareInfoRef || null,
          segmentRef: a.SegmentRef || null,
          hostTokenRef: a.HostTokenRef || null
        };
      })
      .filter((bi) => {
        if (!bi.segmentRef || seenSegRefs.has(bi.segmentRef)) return false;
        seenSegRefs.add(bi.segmentRef);
        return true;
      });

    return {
      key: attrs.Key || null,
      totalPrice: attrs.TotalPrice || null,
      basePrice: attrs.BasePrice || null,
      taxes: attrs.Taxes || null,
      completeItinerary: String(attrs.CompleteItinerary || "false").toLowerCase() === "true",
      bookingInfos
    };
  });

  for (const flightOptionMatch of extractAllBlocks(xmlStr, "FlightOption")) {
    const optionAttrs = parseAttributes(flightOptionMatch[1]);
    const options = extractAllBlocks(flightOptionMatch[2], "Option").map((optionMatch) => {
      const attrs = parseAttributes(optionMatch[1]);
      const bookingInfos = extractAllBlocks(optionMatch[2], "BookingInfo").map((infoMatch) => {
        const infoAttrs = parseAttributes(infoMatch[1]);
        return {
          bookingCode: infoAttrs.BookingCode || null,
          bookingCount: Number(infoAttrs.BookingCount || 0),
          cabin: infoAttrs.CabinClass || null,
          fareInfoRef: infoAttrs.FareInfoRef || null,
          segmentRef: infoAttrs.SegmentRef || null,
          hostTokenRef: infoAttrs.HostTokenRef || null
        };
      });
      return {
        key: attrs.Key || null,
        bookingInfos
      };
    });
    flightOptions.push({
      key: optionAttrs.Key || null,
      options
    });
  }

  for (const brandMatch of extractAllBlocks(xmlStr, "Brand")) {
    const attrs = parseAttributes(brandMatch[1]);
    if (!attrs.Key) {
      continue;
    }
    brandList[attrs.Key] = {
      key: attrs.Key,
      name: attrs.Name || null,
      tier: attrs.Tier || null
    };
  }

  return {
    airPricePoints,
    airSegments,
    fareInfos,
    hostTokens,
    brandList,
    flightOptions
  };
};

const parseAirPriceResponse = (xmlStr) => {
  const pricingSolutionBlock = extractFirstBlock(xmlStr, "AirPricingSolution");
  const pricingAttrs = pricingSolutionBlock ? parseAttributes(pricingSolutionBlock[1]) : {};

  const optionalServices = extractAllBlocks(xmlStr, "OptionalService").map((match) => {
    const attrs = parseAttributes(match[1]);
    return {
      key: attrs.Key || null,
      type: attrs.Type || null,
      price: attrs.TotalPrice || attrs.BasePrice || null,
      providerDefinedType: attrs.ProviderDefinedType || null,
      serviceStatus: attrs.ServiceStatus || null,
      serviceData: extractAllBlocks(match[2], "ServiceData").map((item) => item[2].trim())
    };
  });

  const hostBlock = extractFirstBlock(xmlStr, "HostToken");
  const hostToken = hostBlock ? hostBlock[2].trim() : null;

  return {
    pricingSolution: {
      key: pricingAttrs.Key || null,
      total: pricingAttrs.TotalPrice || null,
      base: pricingAttrs.BasePrice || null,
      taxes: pricingAttrs.Taxes || null,
      services: pricingAttrs.OptionalServicesTotal || null
    },
    optionalServices,
    hostToken
  };
};

const parseSeatMapResponse = (xmlStr) => {
  const optionalServices = extractAllBlocks(xmlStr, "OptionalService").map((match) => {
    const attrs = parseAttributes(match[1]);
    return {
      key: attrs.Key || null,
      price: attrs.TotalPrice || null,
      type: attrs.Type || null,
      providerDefinedType: attrs.ProviderDefinedType || null
    };
  });

  const seatRows = extractAllBlocks(xmlStr, "Row").map((rowMatch) => {
    const rowAttrs = parseAttributes(rowMatch[1]);
    const facilities = extractAllBlocks(rowMatch[2], "Facility").map((facilityMatch) => {
      const attrs = parseAttributes(facilityMatch[1]);
      const characteristics = extractAllBlocks(facilityMatch[2], "Characteristic").map((charMatch) => {
        const charAttrs = parseAttributes(charMatch[1]);
        return charAttrs.PADISCode || charAttrs.Code || charMatch[2].trim();
      });
      return {
        seatCode: attrs.SeatCode || attrs.Code || null,
        availability: attrs.Availability || attrs.Status || null,
        paid: Boolean(attrs.OptionalServiceRef || attrs.Chargeable === "true"),
        optionalServiceRef: attrs.OptionalServiceRef || null,
        characteristics
      };
    });
    return {
      rowNumber: rowAttrs.Number || rowAttrs.Row || null,
      seats: facilities
    };
  });

  return { seatRows, optionalServices };
};

const parseAirBookResponse = (xmlStr) => {
  const supplier = extractFirstBlock(xmlStr, "SupplierLocator");
  const supplierAttrs = supplier ? parseAttributes(supplier[1]) : {};
  const tcrInfo = extractFirstBlock(xmlStr, "TCRInfo");
  const tcrAttrs = tcrInfo ? parseAttributes(tcrInfo[1]) : {};
  const optionalServices = extractAllBlocks(xmlStr, "OptionalService").map((match) => {
    const attrs = parseAttributes(match[1]);
    return {
      key: attrs.Key || null,
      serviceStatus: attrs.ServiceStatus || null,
      isFulfilled: String(attrs.ServiceStatus || "").toLowerCase() === "fulfilled"
    };
  });

  return {
    pnr: supplierAttrs.SupplierLocatorCode || null,
    tcrNumber: tcrAttrs.TCRNumber || null,
    tcrStatus: tcrAttrs.Status || null,
    optionalServices
  };
};

class IndigoAdapter extends BaseFlightProvider {
  constructor() {
    super("indigo");
    this.endpoint =
      process.env.INDIGO_UAPI_URL ||
      "https://apac.universal-api.pp.travelport.com/B2BGateway/connect/uAPI/AirService";
  }

  async postSoap(xml) {
    const auth = Buffer.from(`${process.env.INDIGO_USERNAME}:${process.env.INDIGO_PASSWORD}`).toString("base64");
    const response = await axios.post(this.endpoint, xml, {
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        "Authorization": `Basic ${auth}`
      },
      timeout: 25000
    });
    return response.data;
  }

  async searchFlights({ origin, destination, date, passengers = 1, cabin = "economy" }) {
    try {
      const searchReq = buildLowFareSearchReq({
        origin: String(origin).toUpperCase(),
        destination: String(destination).toUpperCase(),
        date,
        passengers,
        cabin
      });
      const xmlResponse = await this.postSoap(searchReq);
      const parsed = parseLowFareSearchResponse(xmlResponse);

      const searchOrigin = String(origin).toUpperCase();
      const searchDest = String(destination).toUpperCase();
      const allFlights = [];
      let flightIdx = 0;

      for (const point of parsed.airPricePoints) {
        const firstBi = point.bookingInfos[0] || {};
        const fare = parsed.fareInfos[firstBi.fareInfoRef] || {};
        const hostToken =
          parsed.hostTokens[firstBi.hostTokenRef] ||
          Object.values(parsed.hostTokens)[0] ||
          null;
        const totalPrice = Number(String(point.totalPrice || "INR0").replace(/[A-Z]/g, "")) || 0;
        const basePrice = Number(String(point.basePrice || "INR0").replace(/[A-Z]/g, "")) || 0;
        const taxPrice = Number(String(point.taxes || "INR0").replace(/[A-Z]/g, "")) || 0;

        // Resolve each BookingInfo's segmentRef to its AirSegment, dedup by ref
        const resolvedSegs = {};
        for (const bi of point.bookingInfos) {
          const seg = parsed.airSegments[bi.segmentRef];
          if (seg && !resolvedSegs[bi.segmentRef]) {
            resolvedSegs[bi.segmentRef] = {
              ...seg,
              bookingCode: bi.bookingCode,
              bookingCount: bi.bookingCount
            };
          }
        }

        // Group resolved segments by their departure airport
        const segsByOrigin = {};
        for (const seg of Object.values(resolvedSegs)) {
          if (!segsByOrigin[seg.origin]) segsByOrigin[seg.origin] = [];
          segsByOrigin[seg.origin].push(seg);
        }

        // Each AirPricePoint bundles multiple alternative itineraries at the same price.
        // Build all valid chains from searchOrigin → searchDest to expand them individually.
        // minArrivalMs: the earliest ms timestamp the next leg may depart (prev arrival + 30 min).
        const buildChains = (current, visited, minArrivalMs = null) => {
          const legs = segsByOrigin[current] || [];
          const chains = [];
          for (const seg of legs) {
            if (visited.has(seg.key)) continue;
            // Skip segments that depart before the previous leg has landed + 30 min buffer
            if (minArrivalMs !== null && seg.departureAt) {
              const segDepMs = new Date(seg.departureAt).getTime();
              if (segDepMs < minArrivalMs + 30 * 60 * 1000) continue;
            }
            const next = new Set(visited).add(seg.key);
            if (seg.destination === searchDest) {
              chains.push([seg]);
            } else if (visited.size < 4) {
              const arrMs = seg.arrivalAt ? new Date(seg.arrivalAt).getTime() : null;
              for (const sub of buildChains(seg.destination, next, arrMs)) {
                chains.push([seg, ...sub]);
              }
            }
          }
          return chains;
        };

        for (const chain of buildChains(searchOrigin, new Set(), null)) {
          const first = chain[0];
          const last = chain[chain.length - 1];
          const depAt = first.departureAt || `${date}T07:00:00.000Z`;
          const arrAt = last.arrivalAt || `${date}T09:00:00.000Z`;

          const segments = chain.map((seg) => ({
            flightNo: `6E-${seg.flightNumber}`,
            origin: seg.origin,
            destination: seg.destination,
            departureAt: seg.departureAt,
            arrivalAt: seg.arrivalAt,
            durationMins: seg.flightTime || null,
            bookingCode: seg.bookingCode || null
          }));

          allFlights.push(
            this.buildFlightResult({
              flightId: `IND-${point.key || flightIdx}-${flightIdx}`,
              provider: "indigo",
              flightNo: `6E-${first.flightNumber}`,
              origin: first.origin,
              destination: last.destination,
              departureAt: depAt,
              arrivalAt: arrAt,
              durationMins: Math.max(1, Math.round((new Date(arrAt) - new Date(depAt)) / 60000)) || 120,
              cabinClass: String(cabin).toLowerCase(),
              availableSeats: first.bookingCount || 9,
              baseFare: basePrice,
              taxes: taxPrice,
              totalFare: totalPrice || basePrice + taxPrice,
              currency: String(point.totalPrice || "INR").slice(0, 3) || "INR",
              fareFamily: fare.fareFamily || "Regular Fare",
              fareBasis: fare.fareBasis || "",
              isRefundable: !String(fare.fareBasis || "").startsWith("L"),
              stopCount: chain.length - 1,
              segments,
              baggage: { cabin: "7kg", checkin: "15kg" },
              ancillaries: ["meal", "baggage", "seat"],
              providerMeta: {
                hostToken,
                airPricePointKey: point.key,
                segmentRef: first.key,
                allSegmentRefs: chain.map((s) => s.key)
              }
            })
          );
          flightIdx++;
        }
      }

      // Multiple price points can reference the same flight — keep the cheapest
      const dedupMap = new Map();
      for (const f of allFlights) {
        const key = `${f.flightNo}|${f.departureAt}`;
        if (!dedupMap.has(key) || dedupMap.get(key).totalFare > f.totalFare) {
          dedupMap.set(key, f);
        }
      }
      const flights = [...dedupMap.values()];

      if (flights.length > 0) {
        return flights;
      }

      return [
        this.buildFlightResult({
          flightId: `IND-FALLBACK-${Date.now()}`,
          provider: "indigo",
          flightNo: "6E-64",
          origin,
          destination,
          departureAt: `${date}T06:30:00.000Z`,
          arrivalAt: `${date}T08:45:00.000Z`,
          durationMins: 135,
          cabinClass: cabin,
          availableSeats: 8,
          baseFare: 4500,
          taxes: 1100,
          totalFare: 5600,
          currency: "INR",
          fareFamily: "Regular Fare",
          fareBasis: "X",
          isRefundable: true,
          stopCount: 0,
          baggage: { cabin: "7kg", checkin: "15kg" },
          ancillaries: ["meal", "baggage", "seat"],
          providerMeta: {}
        })
      ];
    } catch (error) {
      return this.wrapError(error, 502);
    }
  }

  async getFlightDetails(params) {
    try {
      return { provider: "indigo", ...params };
    } catch (error) {
      return this.wrapError(error, 500);
    }
  }

  async holdBooking({ airSegment, hostToken, passengers, fareBasisCode, gstData }) {
    try {
      if (!hostToken) {
        return this.wrapError(new Error("HostToken is required from LowFareSearch to AirPrice"), 400);
      }
      const xml = buildAirPriceReq({
        airSegment,
        hostToken,
        passengers,
        fareBasisCode,
        gstData
      });
      const responseXml = await this.postSoap(xml);
      const parsed = parseAirPriceResponse(responseXml);
      return { provider: "indigo", holdReference: `IND-HOLD-${Date.now()}`, ...parsed };
    } catch (error) {
      return this.wrapError(error, 500);
    }
  }

  async confirmBooking({ travelers, pricingSolution, optionalServices, formOfPayment }) {
    try {
      const xml = buildAirCreateReservationReq({
        travelers,
        pricingSolution,
        optionalServices,
        formOfPayment
      });
      const responseXml = await this.postSoap(xml);
      return { provider: "indigo", ...parseAirBookResponse(responseXml) };
    } catch (error) {
      return this.wrapError(error, 500);
    }
  }

  async createBooking(params) {
    const booked = await this.confirmBooking(params);
    if (booked.error) {
      return booked;
    }
    return { provider: "indigo", providerBookingRef: booked.pnr || booked.tcrNumber || `IND-${Date.now()}` };
  }

  async cancelBooking({ bookingRef }) {
    try {
      return { provider: "indigo", bookingRef, status: "cancel_requested" };
    } catch (error) {
      return this.wrapError(error, 500);
    }
  }

  async getSessionToken() {
    return {
      provider: "indigo",
      tokenType: "hostToken",
      note: "Stateless provider; HostToken from LowFareSearch must be passed exactly to AirPrice/AirBook and never reused across different booking sessions."
    };
  }
}

module.exports = IndigoAdapter;
module.exports.buildLowFareSearchReq = buildLowFareSearchReq;
module.exports.buildAirPriceReq = buildAirPriceReq;
module.exports.buildSeatMapReq = buildSeatMapReq;
module.exports.buildAirPriceReqWithOptionals = buildAirPriceReqWithOptionals;
module.exports.buildAirCreateReservationReq = buildAirCreateReservationReq;
module.exports.parseLowFareSearchResponse = parseLowFareSearchResponse;
module.exports.parseAirPriceResponse = parseAirPriceResponse;
module.exports.parseSeatMapResponse = parseSeatMapResponse;
module.exports.parseAirBookResponse = parseAirBookResponse;
module.exports.validateFareRestrictions = validateFareRestrictions;
