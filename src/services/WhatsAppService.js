const axios = require("axios");
const { env } = require("../config/env");

const IST = "Asia/Kolkata";

function fmtTime(d) {
  if (!d) return "N/A";
  return new Date(d).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: IST });
}

function fmtDate(d) {
  if (!d) return "N/A";
  return new Date(d).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: IST });
}

function paxCountLabel(passengers = []) {
  const adults   = passengers.filter((p) => p.type === "ADT").length;
  const children = passengers.filter((p) => p.type === "CHD").length;
  const infants  = passengers.filter((p) => p.type === "INF").length;
  const parts = [];
  if (adults)   parts.push(`${adults} Adult${adults > 1 ? "s" : ""}`);
  if (children) parts.push(`${children} Child${children > 1 ? "ren" : ""}`);
  if (infants)  parts.push(`${infants} Infant${infants > 1 ? "s" : ""}`);
  return parts.join(", ") || "1 Adult";
}

function parsePhone(contactPhone) {
  const digits = String(contactPhone || "").replace(/\D/g, "");
  if (digits.startsWith("91") && digits.length === 12) {
    return { countryCode: "91", number: digits.slice(2) };
  }
  return { countryCode: "91", number: digits.slice(-10) };
}

class WhatsAppService {
  constructor() {
    this.apiUrl               = env.myoperator.apiUrl;
    this.token                = env.myoperator.token;
    this.companyId            = env.myoperator.companyId;
    this.phoneNumberId        = env.myoperator.phoneNumberId;
    this.bookingTemplateId    = env.myoperator.bookingTemplateId;
    this.cancellationTemplateId = env.myoperator.cancellationTemplateId;
  }

  _isConfigured() {
    return !!(this.token && this.companyId && this.phoneNumberId && this.apiUrl);
  }

  async _post(payload) {
    try {
      const response = await axios.post(this.apiUrl, payload, {
        headers: {
          "Content-Type":      "application/json",
          "Accept":            "application/json",
          "Authorization":     `Bearer ${this.token}`,
          "X-MYOP-COMPANY-ID": this.companyId,
        },
        timeout: 10_000,
      });
      console.info("[WhatsAppService] Message sent", { status: response.status, data: response.data });
      return response;
    } catch (err) {
      console.error("[WhatsAppService] API error", {
        status:  err.response?.status,
        body:    err.response?.data,
        message: err.message,
      });
      throw err;
    }
  }

  async sendBookingConfirmation({ booking, pnr }) {
    if (!this._isConfigured()) {
      console.warn("[WhatsAppService] Not configured — skipping booking WhatsApp");
      return null;
    }
    if (!this.bookingTemplateId) {
      console.warn("[WhatsAppService] MYOPERATOR_BOOKING_TEMPLATE_ID not set — skipping");
      return null;
    }

    const phone = booking.contactPhone;
    if (!phone) {
      console.warn(`[WhatsAppService] No contactPhone on booking ${booking.bookingRef} — skipping`);
      return null;
    }

    const { countryCode, number } = parsePhone(phone);
    const fd   = booking.flightDetails || {};
    const fare = booking.fareBreakdown  || {};
    const sym  = (fare.currency || "INR") === "INR" ? "₹" : fare.currency;

    const payload = {
      phone_number_id:       this.phoneNumberId,
      customer_country_code: countryCode,
      customer_number:       number,
      data: {
        type: "template",
        context: {
          template_id: this.bookingTemplateId,
          language:    "en",
          body: {
            "1":  booking.passengers?.[0]?.firstName || "Passenger",
            "2":  booking.bookingRef,
            "3":  pnr || booking.bookingRef,
            "4":  fd.origin      || "—",
            "5":  fd.destination || "—",
            "6":  fd.flightNo    || "—",
            "7":  fmtDate(fd.departureAt),
            "8":  fmtTime(fd.departureAt),
            "9":  fmtTime(fd.arrivalAt),
            "10": fd.cabinClass  || "Economy",
            "11": paxCountLabel(booking.passengers),
            "12": `${sym}${(fare.totalFare || 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`,
          },
        },
      },
      myop_ref_id: booking.bookingRef,
    };

    const response = await this._post(payload);
    return response.data;
  }

  async sendCancellationConfirmation({ booking, refundAmount }) {
    if (!this._isConfigured()) {
      console.warn("[WhatsAppService] Not configured — skipping cancellation WhatsApp");
      return null;
    }
    if (!this.cancellationTemplateId) {
      console.warn("[WhatsAppService] MYOPERATOR_CANCELLATION_TEMPLATE_ID not set — skipping");
      return null;
    }

    const phone = booking.contactPhone;
    if (!phone) return null;

    const { countryCode, number } = parsePhone(phone);
    const fd  = booking.flightDetails || {};
    const sym = (booking.fareBreakdown?.currency || "INR") === "INR" ? "₹" : booking.fareBreakdown?.currency;

    const payload = {
      phone_number_id:       this.phoneNumberId,
      customer_country_code: countryCode,
      customer_number:       number,
      data: {
        type: "template",
        context: {
          template_id: this.cancellationTemplateId,
          language:    "en",
          body: {
            "1": booking.passengers?.[0]?.firstName || "Passenger",
            "2": booking.bookingRef,
            "3": fd.origin      || "—",
            "4": fd.destination || "—",
            "5": fmtDate(fd.departureAt),
            "6": `${sym}${(refundAmount || 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`,
            "7": "Original payment method",
            "8": "5–7 business days",
          },
        },
      },
      myop_ref_id: `${booking.bookingRef}-cancel`,
    };

    const response = await this._post(payload);
    return response.data;
  }
}

module.exports = new WhatsAppService();
