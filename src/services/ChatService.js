const { v4: uuidv4 } = require("uuid");
const OpenAI = require("openai");
const ChatSession = require("../models/ChatSession");
const Booking = require("../models/Booking");
const CouponService = require("./CouponService");
const FlightSearchOrchestrator = require("./FlightSearchOrchestrator");
const EmailService = require("./EmailService");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT =
  "You are a helpful flight booking assistant. You help users:\n- Search for flights between cities\n- Check existing booking status and details\n- Understand cancellation policies and refund status\n- Apply coupons and understand discounts\n- Get information about baggage policies, check-in, and seat selection\n- Resolve booking issues\n\nBe concise, friendly, and always confirm before taking any action.\nWhen searching flights, always confirm the route and date before searching.\nIf you cannot help with something, say so clearly and offer to escalate.\nNever share another user's booking information.";

const FAQ_MAP = {
  baggage: {
    indigo: "Cabin: 7kg, Check-in: 15kg standard domestic fare.",
    airindia: "Cabin: 7kg, Check-in: usually 15-20kg by fare.",
    spicejet: "Cabin: 7kg, Check-in: 15kg standard.",
    flightroutes24: "Baggage depends on partner airline fare terms."
  },
  checkin: {
    indigo: "Online check-in: 48 hours to 60 minutes before departure.",
    airindia: "Online check-in: typically 48 hours to 2 hours before departure.",
    spicejet: "Online check-in: typically 48 hours to 60 minutes before departure.",
    flightroutes24: "Check-in window follows operating airline policy."
  },
  cancellation:
    "Cancellation penalties depend on fare class and time-to-departure. Non-refundable fares can incur near-full penalty.",
  seats: "Preferred and extra-legroom seats may have additional charges and vary by airline.",
  passport: "Passport should be valid for at least 6 months for most international travel.",
  infant: "Infants typically require age proof and may be charged a fixed fee without separate seat.",
  meal: "Meals can be pre-booked where available; onboard options depend on airline and route.",
  refund: "Refund timelines usually range 5-7 business days after processing."
};

const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "search_flights",
      parameters: {
        type: "object",
        properties: {
          origin: { type: "string", description: "Origin IATA code" },
          destination: { type: "string", description: "Destination IATA code" },
          date: { type: "string", description: "Departure date YYYY-MM-DD" },
          returnDate: { type: "string" },
          adults: { type: "integer", default: 1 },
          children: { type: "integer", default: 0 },
          cabin: { type: "string", enum: ["economy"], default: "economy" }
        },
        required: ["origin", "destination", "date"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_booking_status",
      parameters: {
        type: "object",
        properties: {
          bookingRef: { type: "string" },
          lastName: { type: "string" }
        },
        required: ["bookingRef"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_refund_status",
      parameters: {
        type: "object",
        properties: { bookingRef: { type: "string" } },
        required: ["bookingRef"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "validate_coupon",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string" },
          totalFare: { type: "number" },
          provider: { type: "string" }
        },
        required: ["code", "totalFare"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_faq",
      parameters: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            enum: ["baggage", "checkin", "cancellation", "seats", "passport", "infant", "meal", "refund"]
          }
        },
        required: ["topic"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_cancellation_estimate",
      parameters: {
        type: "object",
        properties: { bookingRef: { type: "string" } },
        required: ["bookingRef"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "escalate_to_human",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string" },
          urgency: { type: "string", enum: ["low", "medium", "high"] }
        },
        required: ["reason", "urgency"]
      }
    }
  }
];

class ChatService {
  getExpiryDate(userId) {
    const ms = userId ? 7 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    return new Date(Date.now() + ms);
  }

  async getOrCreateSession({ sessionId, userId }) {
    const effectiveSessionId = sessionId || uuidv4();
    let session = await ChatSession.findOne({ sessionId: effectiveSessionId });

    if (session) {
      if (session.userId && userId && session.userId.toString() !== String(userId)) {
        throw new Error("Session ownership mismatch");
      }
      if (!session.userId && userId) {
        session.userId = userId;
      }
      session.expiresAt = this.getExpiryDate(session.userId);
      await session.save();
      return session;
    }

    session = await ChatSession.create({
      userId: userId || null,
      sessionId: effectiveSessionId,
      messages: [],
      archivedMessages: [],
      context: { resolvedIntents: [] },
      expiresAt: this.getExpiryDate(userId)
    });
    return session;
  }

  async appendMessage(session, message) {
    session.messages.push(message);
    if (session.messages.length > 50) {
      const overflow = session.messages.splice(0, session.messages.length - 50);
      session.archivedMessages.push(...overflow);
    }
    session.expiresAt = this.getExpiryDate(session.userId);
    await session.save();
    return session;
  }

  async findOwnedBooking({ bookingRef, userId, userRole, guestLastName }) {
    const booking = await Booking.findOne({ bookingRef: String(bookingRef).toUpperCase() });
    if (!booking) {
      throw new Error("Booking not found");
    }

    if (userId) {
      if (userRole !== "admin" && booking.userId.toString() !== String(userId)) {
        throw new Error("You are not authorized to access this booking");
      }
      return booking;
    }

    if (!guestLastName) {
      throw new Error("For guest lookup, lastName is required");
    }
    const matched = booking.passengers.some(
      (passenger) => String(passenger.lastName || "").toLowerCase() === String(guestLastName).toLowerCase()
    );
    if (!matched) {
      throw new Error("Guest verification failed");
    }
    return booking;
  }

  addBusinessDays(date, daysRangeStart = 5, daysRangeEnd = 7) {
    const startDate = new Date(date);
    const endDate = new Date(date);
    let addedStart = 0;
    while (addedStart < daysRangeStart) {
      startDate.setDate(startDate.getDate() + 1);
      if (startDate.getDay() !== 0 && startDate.getDay() !== 6) {
        addedStart += 1;
      }
    }
    let addedEnd = 0;
    while (addedEnd < daysRangeEnd) {
      endDate.setDate(endDate.getDate() + 1);
      if (endDate.getDay() !== 0 && endDate.getDay() !== 6) {
        addedEnd += 1;
      }
    }
    return { startDate, endDate };
  }

  calculateCancellation(booking) {
    const departureMs = new Date(booking.flightDetails.departureAt).getTime();
    const hoursBefore = (departureMs - Date.now()) / (1000 * 60 * 60);
    const fare = Number(booking.fareBreakdown.totalFare || 0);
    const fareClass = String(booking.flightDetails.fareFamily || "").toLowerCase();

    let penaltyRate = 0.3;
    if (fareClass.includes("nonref")) {
      penaltyRate = 1;
    } else if (hoursBefore <= 6) {
      penaltyRate = 0.9;
    } else if (hoursBefore <= 24) {
      penaltyRate = 0.6;
    }
    const penaltyAmount = Math.min(fare, fare * penaltyRate);
    const refundAmount = Math.max(0, fare - penaltyAmount);
    return {
      penaltyAmount,
      refundAmount,
      canCancel: hoursBefore > 0,
      reason: hoursBefore > 0 ? "Cancellation allowed with penalty" : "Flight has already departed"
    };
  }

  formatFlightResult(flight) {
    const itinerary = Array.isArray(flight.segments) && flight.segments.length > 1
      ? flight.segments.map((s) => `${s.origin}->${s.destination} (${s.flightNo})`).join(", ")
      : `${flight.origin}->${flight.destination}`;
    return {
      flightNo: flight.flightNo,
      times: `${flight.departureAt} -> ${flight.arrivalAt}`,
      duration: `${flight.durationMins}m`,
      price: flight.totalFare,
      stops: flight.stopCount || 0,
      itinerary
    };
  }

  async executeTool(toolCall, session, authContext) {
    const toolName = toolCall.function.name;
    const args = JSON.parse(toolCall.function.arguments || "{}");

    if (toolName === "search_flights") {
      const passengers = Number(args.adults || 1) + Number(args.children || 0);
      const flights = await FlightSearchOrchestrator.search({
        origin: String(args.origin).toUpperCase(),
        destination: String(args.destination).toUpperCase(),
        departureDate: args.date,
        passengers
      });
      const top = flights.slice(0, 5).map((flight) => this.formatFlightResult(flight));
      session.context.lastFlightSearch = args;
      await session.save();
      return top;
    }

    if (toolName === "get_booking_status") {
      const booking = await this.findOwnedBooking({
        bookingRef: args.bookingRef,
        userId: authContext.userId,
        userRole: authContext.role,
        guestLastName: args.lastName
      });
      return {
        bookingRef: booking.bookingRef,
        status: booking.bookingStatus,
        pnr: booking.pnrMap?.[booking.flightDetails.provider] || null,
        flightDetails: booking.flightDetails,
        passengerCount: booking.passengers.length,
        totalFare: booking.fareBreakdown.totalFare
      };
    }

    if (toolName === "get_refund_status") {
      const booking = await this.findOwnedBooking({
        bookingRef: args.bookingRef,
        userId: authContext.userId,
        userRole: authContext.role,
        guestLastName: args.lastName
      });
      const baseDate = booking.refundProcessedAt || booking.updatedAt;
      const estimate = this.addBusinessDays(baseDate);
      return {
        refundAmount: booking.refundAmount || 0,
        refundStatus: booking.refundStatus || "na",
        estimatedCreditDate:
          booking.refundStatus === "processed"
            ? `${estimate.startDate.toISOString().slice(0, 10)} to ${estimate.endDate.toISOString().slice(0, 10)}`
            : null
      };
    }

    if (toolName === "validate_coupon") {
      const result = await CouponService.validate(
        args.code,
        Number(args.totalFare),
        args.provider || "indigo",
        authContext.userId || session.userId || "000000000000000000000000",
        { origin: "ANY", destination: "ANY" }
      );
      return {
        valid: result.valid,
        discountAmount: result.discountAmount,
        finalFare: result.finalFare,
        expiryDate: result.coupon?.validTo || null,
        conditions: result.message
      };
    }

    if (toolName === "get_faq") {
      return FAQ_MAP[args.topic] || "No FAQ available for this topic";
    }

    if (toolName === "get_cancellation_estimate") {
      const booking = await this.findOwnedBooking({
        bookingRef: args.bookingRef,
        userId: authContext.userId,
        userRole: authContext.role,
        guestLastName: args.lastName
      });
      return this.calculateCancellation(booking);
    }

    if (toolName === "escalate_to_human") {
      const ticketId = `TICK${Date.now()}`;
      session.isEscalated = true;
      session.ticketId = ticketId;
      await session.save();
      await EmailService.send({
        to: process.env.SUPPORT_EMAIL || process.env.SMTP_USER,
        subject: `Chat escalation ${ticketId}`,
        html: `<p>Urgency: ${args.urgency}</p><p>Reason: ${args.reason}</p><p>Session: ${session.sessionId}</p>`
      });
      return {
        ticketId,
        message: "A support agent will contact you within 2-4 hours"
      };
    }

    return { error: "Unknown tool call" };
  }

  extractSuggestedActions(replyText) {
    const text = String(replyText || "").toLowerCase();
    const suggestions = [];
    if (text.includes("search")) {
      suggestions.push("Search flights");
    }
    if (text.includes("booking")) {
      suggestions.push("Check booking status");
    }
    if (text.includes("refund")) {
      suggestions.push("Check refund status");
    }
    return suggestions.slice(0, 3);
  }

  async processMessage(session, userMessage, authContext) {
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...session.messages.slice(-12).map((item) => ({ role: item.role, content: item.content })),
      { role: "user", content: userMessage }
    ];

    let response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages,
      tools: TOOL_DEFINITIONS,
      tool_choice: "auto",
      max_tokens: 800,
      temperature: 0.3
    });

    while (response.choices[0]?.finish_reason === "tool_calls") {
      const toolCalls = response.choices[0].message.tool_calls || [];
      const toolResults = await Promise.all(
        toolCalls.map((toolCall) => this.executeTool(toolCall, session, authContext))
      );

      messages.push(response.choices[0].message);
      toolResults.forEach((result, index) => {
        messages.push({
          role: "tool",
          tool_call_id: toolCalls[index].id,
          content: JSON.stringify(result)
        });
      });

      response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages,
        tools: TOOL_DEFINITIONS,
        max_tokens: 800
      });
    }

    const reply = response.choices[0]?.message?.content || "I could not generate a response.";
    const suggestedActions = this.extractSuggestedActions(reply);
    return { reply, suggestedActions };
  }
}

module.exports = new ChatService();
