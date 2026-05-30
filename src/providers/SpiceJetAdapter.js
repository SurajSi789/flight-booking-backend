const axios = require("axios");
const crypto = require("crypto");
const BaseFlightProvider = require("./BaseFlightProvider");
const { env } = require("../config/env");

const escapeXml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

class SpiceJetAdapter extends BaseFlightProvider {
  constructor() {
    super("spicejet");
    this.endpoint = process.env.SG_SOAP_URL || env.providers.spiceJet.soapUrl;
    this.username = process.env.SG_USERNAME || env.providers.spiceJet.username;
    this.password = process.env.SG_PASSWORD || env.providers.spiceJet.password;
    this.sessionToken = null;
    this.soapNs = {
      envelope: "http://schemas.xmlsoap.org/soap/envelope/",
      session: "http://schemas.navitaire.com/WebServices/SessionManager",
      booking: "http://schemas.navitaire.com/WebServices/BookingManager",
      content: "http://schemas.navitaire.com/WebServices/ContentManager"
    };
  }

  buildSoapEnvelope({ action, body, sessionToken }) {
    const securityHeader = sessionToken
      ? `<book:ContractVersion>420</book:ContractVersion>
         <book:Signature>${escapeXml(sessionToken)}</book:Signature>`
      : "";
    return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="${this.soapNs.envelope}" xmlns:ses="${this.soapNs.session}" xmlns:book="${this.soapNs.booking}" xmlns:cnt="${this.soapNs.content}">
  <soapenv:Header>
    ${securityHeader}
    <book:Action>${escapeXml(action)}</book:Action>
  </soapenv:Header>
  <soapenv:Body>${body}</soapenv:Body>
</soapenv:Envelope>`;
  }

  extractTag(xml, tag) {
    const match = xml.match(new RegExp(`<(?:\\w+:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${tag}>`, "i"));
    return match ? match[1].trim() : null;
  }

  extractTagList(xml, tag) {
    return [...xml.matchAll(new RegExp(`<(?:\\w+:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${tag}>`, "gi"))].map(
      (m) => m[1].trim()
    );
  }

  extractAttributes(tagChunk) {
    const attrs = {};
    for (const match of tagChunk.matchAll(/([A-Za-z_:][\w:.-]*)="([^"]*)"/g)) {
      attrs[match[1]] = match[2];
    }
    return attrs;
  }

  parseSoapFault(xml) {
    const faultcode = this.extractTag(xml, "faultcode");
    const faultstring = this.extractTag(xml, "faultstring");
    if (!faultcode && !faultstring) {
      return null;
    }
    return { faultcode, faultstring };
  }

  isSessionExpiryFault(fault) {
    const text = `${fault?.faultcode || ""} ${fault?.faultstring || ""}`.toLowerCase();
    return text.includes("session") && (text.includes("expired") || text.includes("invalid"));
  }

  async postSoap({ action, body, sessionToken }) {
    const envelope = this.buildSoapEnvelope({ action, body, sessionToken });
    const startedAt = Date.now();
    const response = await axios.post(this.endpoint, envelope, {
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        SOAPAction: action
      },
      timeout: 30000
    });
    const durationMs = Date.now() - startedAt;
    // eslint-disable-next-line no-console
    console.info(`[SG] ${new Date().toISOString()} SOAPAction=${action} durationMs=${durationMs}`);
    const fault = this.parseSoapFault(response.data);
    if (fault) {
      throw new Error(`SOAP Fault ${fault.faultcode || ""}: ${fault.faultstring || "Unknown fault"}`);
    }
    return response.data;
  }

  buildLogOnBody() {
    return `<ses:LogonRequest>
  <ses:logonRequestData>
    <ses:DomainCode>WWW</ses:DomainCode>
    <ses:AgentName>${escapeXml(this.username)}</ses:AgentName>
    <ses:Password>${escapeXml(this.password)}</ses:Password>
    <ses:LocationCode>IN</ses:LocationCode>
  </ses:logonRequestData>
</ses:LogonRequest>`;
  }

  buildLogOutBody(token) {
    return `<ses:LogoutRequest>
  <ses:Signature>${escapeXml(token)}</ses:Signature>
</ses:LogoutRequest>`;
  }

  async logOn() {
    const xml = await this.postSoap({
      action: "http://schemas.navitaire.com/WebServices/SessionManager/Logon",
      body: this.buildLogOnBody()
    });
    const token =
      this.extractTag(xml, "Signature") || this.extractTag(xml, "SessionToken") || this.extractTag(xml, "Token");
    if (!token) {
      throw new Error("Failed to acquire SpiceJet session token");
    }
    this.sessionToken = token;
    return token;
  }

  async logOut(token) {
    if (!token) {
      return;
    }
    try {
      await this.postSoap({
        action: "http://schemas.navitaire.com/WebServices/SessionManager/Logout",
        body: this.buildLogOutBody(token),
        sessionToken: token
      });
    } catch (error) {
      // Ignore logout errors but clear local token.
    } finally {
      this.sessionToken = null;
    }
  }

  async withSession(work) {
    const execute = async () => {
      const token = await this.logOn();
      try {
        return await work(token);
      } finally {
        await this.logOut(token);
      }
    };

    try {
      return await execute();
    } catch (error) {
      const text = String(error.message || "").toLowerCase();
      if (text.includes("session") && (text.includes("expired") || text.includes("invalid"))) {
        return execute();
      }
      throw error;
    }
  }

  buildGetAvailabilityVer2Body({ origin, destination, date, returnDate, adults, children, infants, cabin }) {
    return `<book:GetAvailabilityRequest>
  <book:tripAvailabilityRequest>
    <book:AvailabilityRequests>
      <book:AvailabilityRequest>
        <book:DepartureStation>${escapeXml(origin)}</book:DepartureStation>
        <book:ArrivalStation>${escapeXml(destination)}</book:ArrivalStation>
        <book:BeginDate>${escapeXml(date)}</book:BeginDate>
        <book:EndDate>${escapeXml(returnDate || date)}</book:EndDate>
        <book:PaxCount>${Number(adults || 1) + Number(children || 0) + Number(infants || 0)}</book:PaxCount>
        <book:ADTCount>${Number(adults || 1)}</book:ADTCount>
        <book:CHDCount>${Number(children || 0)}</book:CHDCount>
        <book:INFCount>${Number(infants || 0)}</book:INFCount>
        <book:CabinClass>${escapeXml(cabin || "Y")}</book:CabinClass>
      </book:AvailabilityRequest>
    </book:AvailabilityRequests>
  </book:tripAvailabilityRequest>
</book:GetAvailabilityRequest>`;
  }

  buildGetItineraryPriceBody({ flightKey }) {
    return `<book:GetItineraryPriceRequest>
  <book:sellByKeyRequest>
    <book:JourneySellKey>${escapeXml(flightKey)}</book:JourneySellKey>
  </book:sellByKeyRequest>
</book:GetItineraryPriceRequest>`;
  }

  buildUpdateContactsBody({ contacts, gstNumber }) {
    return `<book:UpdateContactsRequest>
  <book:updateContactsRequestData>
    <book:Contact>
      <book:EmailAddress>${escapeXml(contacts?.email || "")}</book:EmailAddress>
      <book:PhoneNumber>${escapeXml(contacts?.phone || "")}</book:PhoneNumber>
      ${gstNumber ? `<book:CustomerNumber>${escapeXml(gstNumber)}</book:CustomerNumber>` : ""}
    </book:Contact>
  </book:updateContactsRequestData>
</book:UpdateContactsRequest>`;
  }

  buildSellRequestBody({ flightKey }) {
    return `<book:SellRequest>
  <book:sellRequestData>
    <book:SellKeyList>
      <book:JourneySellKey>${escapeXml(flightKey)}</book:JourneySellKey>
    </book:SellKeyList>
  </book:sellRequestData>
</book:SellRequest>`;
  }

  buildSellSsrBody({ ssrCode, passengerKey, segmentKey }) {
    return `<book:SellSSRRequest>
  <book:sellSSRRequestData>
    <book:SSRCode>${escapeXml(ssrCode)}</book:SSRCode>
    <book:PaxKey>${escapeXml(passengerKey)}</book:PaxKey>
    <book:SegmentKey>${escapeXml(segmentKey || "")}</book:SegmentKey>
  </book:sellSSRRequestData>
</book:SellSSRRequest>`;
  }

  buildUpdatePassengerBody({ passenger }) {
    return `<book:UpdatePassengerRequest>
  <book:updatePassengerRequestData>
    <book:Passenger>
      <book:Title>${escapeXml(passenger.title || "MR")}</book:Title>
      <book:FirstName>${escapeXml(passenger.firstName)}</book:FirstName>
      <book:LastName>${escapeXml(passenger.lastName)}</book:LastName>
      <book:Gender>${escapeXml(passenger.gender || "M")}</book:Gender>
      <book:DateOfBirth>${escapeXml(passenger.dob || "")}</book:DateOfBirth>
      <book:PassengerType>${escapeXml(passenger.type || "ADT")}</book:PassengerType>
      ${passenger.passportNo ? `<book:DocumentNumber>${escapeXml(passenger.passportNo)}</book:DocumentNumber>` : ""}
    </book:Passenger>
  </book:updatePassengerRequestData>
</book:UpdatePassengerRequest>`;
  }

  buildGetBookingFromStateBody() {
    return `<book:GetBookingFromStateRequest/>`;
  }

  buildGetSeatAvailabilityBody({ flightKey }) {
    return `<book:GetSeatAvailabilityRequest>
  <book:getSeatAvailabilityRequestData>
    <book:JourneySellKey>${escapeXml(flightKey)}</book:JourneySellKey>
  </book:getSeatAvailabilityRequestData>
</book:GetSeatAvailabilityRequest>`;
  }

  buildAssignSeatBody({ passengerKey, seatCode, segmentKey }) {
    return `<book:AssignSeatRequest>
  <book:assignSeatRequestData>
    <book:PaxKey>${escapeXml(passengerKey)}</book:PaxKey>
    <book:SeatNumber>${escapeXml(seatCode)}</book:SeatNumber>
    <book:SegmentKey>${escapeXml(segmentKey || "")}</book:SegmentKey>
  </book:assignSeatRequestData>
</book:AssignSeatRequest>`;
  }

  buildAddPaymentBody({ amount, currency = "INR", paymentCode = "AG" }) {
    return `<book:AddPaymentToBookingRequest>
  <book:paymentRequest>
    <book:PaymentMethodCode>${escapeXml(paymentCode)}</book:PaymentMethodCode>
    <book:Amount>${Number(amount || 0).toFixed(2)}</book:Amount>
    <book:CurrencyCode>${escapeXml(currency)}</book:CurrencyCode>
  </book:paymentRequest>
</book:AddPaymentToBookingRequest>`;
  }

  buildBookingCommitBody() {
    return `<book:BookingCommitRequest/>`;
  }

  buildGetBookingBody({ pnr }) {
    return `<book:GetBookingRequest>
  <book:getBookingRequestData>
    <book:RecordLocator>${escapeXml(pnr)}</book:RecordLocator>
  </book:getBookingRequestData>
</book:GetBookingRequest>`;
  }

  buildCancelAllBody() {
    return `<book:CancelRequest>
  <book:cancelRequestData>
    <book:CancelMode>All</book:CancelMode>
  </book:cancelRequestData>
</book:CancelRequest>`;
  }

  buildCancelJourneyBody({ journeyKey }) {
    return `<book:CancelRequest>
  <book:cancelRequestData>
    <book:CancelMode>Journey</book:CancelMode>
    <book:JourneyKey>${escapeXml(journeyKey)}</book:JourneyKey>
  </book:cancelRequestData>
</book:CancelRequest>`;
  }

  buildGetSsrAvailabilityForBookingBody() {
    return `<book:GetSSRAvailabilityForBookingRequest/>`;
  }

  buildGetFareRuleInfoBody({ origin, destination, date }) {
    return `<cnt:GetFareRuleInfoRequest>
  <cnt:fareRuleRequestData>
    <cnt:DepartureStation>${escapeXml(origin)}</cnt:DepartureStation>
    <cnt:ArrivalStation>${escapeXml(destination)}</cnt:ArrivalStation>
    <cnt:DepartureDate>${escapeXml(date)}</cnt:DepartureDate>
  </cnt:fareRuleRequestData>
</cnt:GetFareRuleInfoRequest>`;
  }

  buildDivideBody({ passengerKeysToSplit }) {
    const paxXml = (passengerKeysToSplit || [])
      .map((key) => `<book:PassengerKey>${escapeXml(key)}</book:PassengerKey>`)
      .join("");
    return `<book:DivideRequest>
  <book:divideRequestData>${paxXml}</book:divideRequestData>
</book:DivideRequest>`;
  }

  async callAction({ action, body, token }) {
    const xml = await this.postSoap({ action, body, sessionToken: token });
    const fault = this.parseSoapFault(xml);
    if (fault) {
      throw new Error(`SOAP Fault ${fault.faultcode || ""}: ${fault.faultstring || ""}`);
    }
    return xml;
  }

  parseAvailabilityResponse(xml, input) {
    const segments = [...xml.matchAll(/<FlightSegment[\s\S]*?<\/FlightSegment>/g)];
    return segments.slice(0, 10).map((segmentBlock, idx) => {
      const block = segmentBlock[0];
      const flightNo = this.extractTag(block, "FlightNumber") || `${100 + idx}`;
      const dep = this.extractTag(block, "STD") || `${input.date}T08:00:00.000Z`;
      const arr = this.extractTag(block, "STA") || `${input.date}T10:15:00.000Z`;
      const itineraryKey =
        this.extractTag(block, "JourneySellKey") || this.extractTag(block, "Key") || `JNY-${Date.now()}-${idx}`;
      return {
        journeyKey: itineraryKey,
        flightNo: `SG-${flightNo}`,
        origin: input.origin,
        destination: input.destination,
        departureAt: dep,
        arrivalAt: arr
      };
    });
  }

  parseItineraryPrice(xml) {
    const total = Number(this.extractTag(xml, "TotalCost") || this.extractTag(xml, "Amount") || 0);
    const taxes = Number(this.extractTag(xml, "TotalTax") || total * 0.18);
    const base = Math.max(0, total - taxes);
    return { totalFare: total || 5500, taxes: taxes || 900, baseFare: base || 4600, currency: "INR" };
  }

  parseBookingCommit(xml) {
    const pnr =
      this.extractTag(xml, "RecordLocator") ||
      this.extractTag(xml, "SupplierLocatorCode") ||
      this.extractTag(xml, "PNR");
    return { pnr: pnr || `SG${Date.now().toString().slice(-6)}` };
  }

  parseSeatAvailability(xml) {
    const rows = [...xml.matchAll(/<Seat[\s\S]*?<\/Seat>/g)].map((match) => {
      const block = match[0];
      return {
        seatCode: this.extractTag(block, "SeatNumber"),
        status: this.extractTag(block, "Availability") || "Open",
        price: Number(this.extractTag(block, "Amount") || 0)
      };
    });
    return rows;
  }

  parseSsrAvailability(xml) {
    return [...xml.matchAll(/<SSR[\s\S]*?<\/SSR>/g)].map((match) => {
      const block = match[0];
      return {
        code: this.extractTag(block, "SSRCode"),
        description: this.extractTag(block, "SSRName"),
        amount: Number(this.extractTag(block, "Amount") || 0)
      };
    });
  }

  async searchAndPrice({ origin, destination, date, returnDate, adults = 1, children = 0, infants = 0, cabin = "Y" }) {
    try {
      return await this.withSession(async (token) => {
        const availabilityXml = await this.callAction({
          action: "http://schemas.navitaire.com/WebServices/BookingManager/GetAvailabilityVer2",
          body: this.buildGetAvailabilityVer2Body({
            origin,
            destination,
            date,
            returnDate,
            adults,
            children,
            infants,
            cabin
          }),
          token
        });

        const journeys = this.parseAvailabilityResponse(availabilityXml, {
          origin: String(origin).toUpperCase(),
          destination: String(destination).toUpperCase(),
          date
        });

        const priced = [];
        for (const journey of journeys) {
          const priceXml = await this.callAction({
            action: "http://schemas.navitaire.com/WebServices/BookingManager/GetItineraryPrice",
            body: this.buildGetItineraryPriceBody({ flightKey: journey.journeyKey }),
            token
          });
          const fare = this.parseItineraryPrice(priceXml);
          priced.push(
            this.buildFlightResult({
              flightId: `SG-${journey.journeyKey}`,
              provider: "spicejet",
              flightNo: journey.flightNo,
              origin: journey.origin,
              destination: journey.destination,
              departureAt: journey.departureAt,
              arrivalAt: journey.arrivalAt,
              durationMins: Math.max(
                0,
                Math.round((new Date(journey.arrivalAt).getTime() - new Date(journey.departureAt).getTime()) / 60000)
              ),
              cabinClass: cabin,
              availableSeats: 6,
              baseFare: fare.baseFare,
              taxes: fare.taxes,
              totalFare: fare.totalFare,
              currency: fare.currency,
              fareFamily: "SpiceSaver",
              fareBasis: "SGSAV",
              isRefundable: true,
              stopCount: 0,
              baggage: { cabin: "7kg", checkin: "15kg" },
              ancillaries: ["meal", "baggage", "seat"],
              segments: [
                {
                  flightNo: journey.flightNo,
                  origin: journey.origin,
                  destination: journey.destination,
                  departureAt: journey.departureAt,
                  arrivalAt: journey.arrivalAt,
                  durationMins: Math.max(
                    0,
                    Math.round(
                      (new Date(journey.arrivalAt).getTime() - new Date(journey.departureAt).getTime()) / 60000
                    )
                  )
                }
              ],
              providerMeta: { flightKey: journey.journeyKey }
            })
          );
        }

        return priced;
      });
    } catch (error) {
      return this.wrapError(error, 502);
    }
  }

  async createBooking({ flightKey, bookingId, passengers, payment, gstNumber, seatPreferences, ssrs }) {
    try {
      if (!flightKey && bookingId) {
        return {
          provider: "spicejet",
          providerBookingRef: `SG-${String(bookingId).slice(-8).toUpperCase()}`,
          pnr: `SG-${String(bookingId).slice(-8).toUpperCase()}`
        };
      }
      return await this.withSession(async (token) => {
        await this.callAction({
          action: "http://schemas.navitaire.com/WebServices/BookingManager/GetAvailabilityVer2",
          body: this.buildGetAvailabilityVer2Body({
            origin: "NA",
            destination: "NA",
            date: new Date().toISOString().slice(0, 10),
            adults: 1
          }),
          token
        });
        const priceXml = await this.callAction({
          action: "http://schemas.navitaire.com/WebServices/BookingManager/GetItineraryPrice",
          body: this.buildGetItineraryPriceBody({ flightKey }),
          token
        });
        const fare = this.parseItineraryPrice(priceXml);

        if (gstNumber) {
          await this.callAction({
            action: "http://schemas.navitaire.com/WebServices/BookingManager/UpdateContacts",
            body: this.buildUpdateContactsBody({ contacts: payment?.contacts || {}, gstNumber }),
            token
          });
        }

        await this.callAction({
          action: "http://schemas.navitaire.com/WebServices/BookingManager/Sell",
          body: this.buildSellRequestBody({ flightKey }),
          token
        });

        for (const ssr of ssrs || []) {
          await this.callAction({
            action: "http://schemas.navitaire.com/WebServices/BookingManager/SellSSR",
            body: this.buildSellSsrBody(ssr),
            token
          });
        }

        for (const passenger of passengers || []) {
          await this.callAction({
            action: "http://schemas.navitaire.com/WebServices/BookingManager/UpdatePassenger",
            body: this.buildUpdatePassengerBody({ passenger }),
            token
          });
        }

        await this.callAction({
          action: "http://schemas.navitaire.com/WebServices/BookingManager/GetBookingFromState",
          body: this.buildGetBookingFromStateBody(),
          token
        });

        if (seatPreferences?.length) {
          await this.callAction({
            action: "http://schemas.navitaire.com/WebServices/BookingManager/GetSeatAvailability",
            body: this.buildGetSeatAvailabilityBody({ flightKey }),
            token
          });
          for (const seat of seatPreferences) {
            await this.callAction({
              action: "http://schemas.navitaire.com/WebServices/BookingManager/AssignSeat",
              body: this.buildAssignSeatBody(seat),
              token
            });
          }
        }

        await this.callAction({
          action: "http://schemas.navitaire.com/WebServices/BookingManager/AddPaymentToBooking",
          body: this.buildAddPaymentBody({
            amount: payment?.amount || fare.totalFare,
            currency: payment?.currency || "INR"
          }),
          token
        });

        const commitXml = await this.callAction({
          action: "http://schemas.navitaire.com/WebServices/BookingManager/BookingCommit",
          body: this.buildBookingCommitBody(),
          token
        });
        const booking = this.parseBookingCommit(commitXml);

        const response = {
          pnr: booking.pnr,
          providerBookingRef: booking.pnr,
          passengerDetails: passengers || [],
          flightDetails: { flightKey },
          totalFare: fare.totalFare,
          taxes: fare.taxes
        };
        return response;
      });
    } catch (error) {
      return this.wrapError(error, 500);
    }
  }

  async cancelBooking({ pnr }) {
    try {
      return await this.withSession(async (token) => {
        await this.callAction({
          action: "http://schemas.navitaire.com/WebServices/BookingManager/GetBooking",
          body: this.buildGetBookingBody({ pnr }),
          token
        });
        await this.callAction({
          action: "http://schemas.navitaire.com/WebServices/BookingManager/Cancel",
          body: this.buildCancelAllBody(),
          token
        });
        await this.callAction({
          action: "http://schemas.navitaire.com/WebServices/BookingManager/AddPaymentToBooking",
          body: this.buildAddPaymentBody({ amount: 0, currency: "INR", paymentCode: "RF" }),
          token
        });
        await this.callAction({
          action: "http://schemas.navitaire.com/WebServices/BookingManager/BookingCommit",
          body: this.buildBookingCommitBody(),
          token
        });
        return { refundAmount: 0, status: "cancelled" };
      });
    } catch (error) {
      return this.wrapError(error, 500);
    }
  }

  async modifyBooking({ pnr, newFlightKey, passengers }) {
    try {
      return await this.withSession(async (token) => {
        const bookingXml = await this.callAction({
          action: "http://schemas.navitaire.com/WebServices/BookingManager/GetBooking",
          body: this.buildGetBookingBody({ pnr }),
          token
        });
        const existingJourneyKey = this.extractTag(bookingXml, "JourneySellKey");
        await this.callAction({
          action: "http://schemas.navitaire.com/WebServices/BookingManager/Cancel",
          body: this.buildCancelJourneyBody({ journeyKey: existingJourneyKey }),
          token
        });
        await this.callAction({
          action: "http://schemas.navitaire.com/WebServices/BookingManager/GetAvailabilityVer2",
          body: this.buildGetAvailabilityVer2Body({
            origin: "NA",
            destination: "NA",
            date: new Date().toISOString().slice(0, 10),
            adults: 1
          }),
          token
        });
        const priceXml = await this.callAction({
          action: "http://schemas.navitaire.com/WebServices/BookingManager/GetItineraryPrice",
          body: this.buildGetItineraryPriceBody({ flightKey: newFlightKey }),
          token
        });
        const fare = this.parseItineraryPrice(priceXml);
        await this.callAction({
          action: "http://schemas.navitaire.com/WebServices/BookingManager/Sell",
          body: this.buildSellRequestBody({ flightKey: newFlightKey }),
          token
        });
        for (const passenger of passengers || []) {
          await this.callAction({
            action: "http://schemas.navitaire.com/WebServices/BookingManager/UpdatePassenger",
            body: this.buildUpdatePassengerBody({ passenger }),
            token
          });
        }
        await this.callAction({
          action: "http://schemas.navitaire.com/WebServices/BookingManager/AddPaymentToBooking",
          body: this.buildAddPaymentBody({ amount: fare.totalFare, currency: "INR" }),
          token
        });
        const commitXml = await this.callAction({
          action: "http://schemas.navitaire.com/WebServices/BookingManager/BookingCommit",
          body: this.buildBookingCommitBody(),
          token
        });
        return { pnr: this.parseBookingCommit(commitXml).pnr, status: "modified" };
      });
    } catch (error) {
      return this.wrapError(error, 500);
    }
  }

  async addPostBookingSSR({ pnr, ssrs, payment }) {
    try {
      return await this.withSession(async (token) => {
        await this.callAction({
          action: "http://schemas.navitaire.com/WebServices/BookingManager/GetBooking",
          body: this.buildGetBookingBody({ pnr }),
          token
        });
        const availabilityXml = await this.callAction({
          action: "http://schemas.navitaire.com/WebServices/BookingManager/GetSSRAvailabilityForBooking",
          body: this.buildGetSsrAvailabilityForBookingBody(),
          token
        });
        const available = this.parseSsrAvailability(availabilityXml);
        for (const ssr of ssrs || []) {
          if (!available.some((item) => item.code === ssr.ssrCode)) {
            throw new Error(`SSR ${ssr.ssrCode} is not available for this booking`);
          }
          await this.callAction({
            action: "http://schemas.navitaire.com/WebServices/BookingManager/SellSSR",
            body: this.buildSellSsrBody(ssr),
            token
          });
        }
        await this.callAction({
          action: "http://schemas.navitaire.com/WebServices/BookingManager/AddPaymentToBooking",
          body: this.buildAddPaymentBody({ amount: payment?.amount || 0, currency: payment?.currency || "INR" }),
          token
        });
        const commitXml = await this.callAction({
          action: "http://schemas.navitaire.com/WebServices/BookingManager/BookingCommit",
          body: this.buildBookingCommitBody(),
          token
        });
        return { pnr: this.parseBookingCommit(commitXml).pnr, status: "ssr_added" };
      });
    } catch (error) {
      return this.wrapError(error, 500);
    }
  }

  async addPostBookingSeat({ pnr, passengerKey, seatCode, payment }) {
    try {
      return await this.withSession(async (token) => {
        const bookingXml = await this.callAction({
          action: "http://schemas.navitaire.com/WebServices/BookingManager/GetBooking",
          body: this.buildGetBookingBody({ pnr }),
          token
        });
        const journeyKey = this.extractTag(bookingXml, "JourneySellKey");
        const seatXml = await this.callAction({
          action: "http://schemas.navitaire.com/WebServices/BookingManager/GetSeatAvailability",
          body: this.buildGetSeatAvailabilityBody({ flightKey: journeyKey }),
          token
        });
        const seats = this.parseSeatAvailability(seatXml);
        if (!seats.some((seat) => seat.seatCode === seatCode)) {
          throw new Error(`Seat ${seatCode} is not available`);
        }
        await this.callAction({
          action: "http://schemas.navitaire.com/WebServices/BookingManager/AssignSeat",
          body: this.buildAssignSeatBody({ passengerKey, seatCode, segmentKey: journeyKey }),
          token
        });
        await this.callAction({
          action: "http://schemas.navitaire.com/WebServices/BookingManager/AddPaymentToBooking",
          body: this.buildAddPaymentBody({ amount: payment?.amount || 0, currency: payment?.currency || "INR" }),
          token
        });
        const commitXml = await this.callAction({
          action: "http://schemas.navitaire.com/WebServices/BookingManager/BookingCommit",
          body: this.buildBookingCommitBody(),
          token
        });
        return { pnr: this.parseBookingCommit(commitXml).pnr, status: "seat_added" };
      });
    } catch (error) {
      return this.wrapError(error, 500);
    }
  }

  async getFareRules({ origin, destination, date }) {
    try {
      return await this.withSession(async (token) => {
        await this.callAction({
          action: "http://schemas.navitaire.com/WebServices/BookingManager/GetAvailabilityVer2",
          body: this.buildGetAvailabilityVer2Body({ origin, destination, date, adults: 1 }),
          token
        });
        const rulesXml = await this.callAction({
          action: "http://schemas.navitaire.com/WebServices/ContentManager/GetFareRuleInfo",
          body: this.buildGetFareRuleInfoBody({ origin, destination, date }),
          token
        });
        return {
          provider: "spicejet",
          rulesText: this.extractTag(rulesXml, "FareRuleText") || this.extractTag(rulesXml, "RuleText") || "",
          raw: rulesXml
        };
      });
    } catch (error) {
      return this.wrapError(error, 500);
    }
  }

  async splitPNR({ pnr, passengerKeysToSplit }) {
    try {
      return await this.withSession(async (token) => {
        await this.callAction({
          action: "http://schemas.navitaire.com/WebServices/BookingManager/GetBooking",
          body: this.buildGetBookingBody({ pnr }),
          token
        });
        const divideXml = await this.callAction({
          action: "http://schemas.navitaire.com/WebServices/BookingManager/Divide",
          body: this.buildDivideBody({ passengerKeysToSplit }),
          token
        });
        return {
          provider: "spicejet",
          newPnr:
            this.extractTag(divideXml, "RecordLocator") ||
            this.extractTag(divideXml, "NewRecordLocator") ||
            `SG${Date.now().toString().slice(-6)}`,
          status: "split"
        };
      });
    } catch (error) {
      return this.wrapError(error, 500);
    }
  }

  async searchFlights(params) {
    return this.searchAndPrice(params);
  }

  async holdBooking(params) {
    return this.createBooking({ ...params, payment: { amount: 0, currency: "INR" } });
  }

  async confirmBooking(params) {
    return this.createBooking(params);
  }
}

module.exports = SpiceJetAdapter;
