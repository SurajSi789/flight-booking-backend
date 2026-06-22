class BaseFlightProvider {
  constructor(providerName) {
    this.providerName = providerName;
  }

  wrapError(error, fallbackCode = 500) {
    return {
      provider: this.providerName,
      error: error?.message || "Provider request failed",
      code: Number(error?.response?.status || error?.code || fallbackCode)
    };
  }

  toIsoDateTime(value) {
    if (!value) {
      return new Date().toISOString();
    }
    return new Date(value).toISOString();
  }

  buildFlightResult(base) {
    return {
      flightId: base.flightId,
      provider: base.provider,
      carrierCode: base.carrierCode || null,
      flightNo: base.flightNo,
      origin: base.origin,
      destination: base.destination,
      departureAt: new Date(base.departureAt),
      arrivalAt: new Date(base.arrivalAt),
      durationMins: Number(base.durationMins || 0),
      cabinClass: base.cabinClass || "economy",
      availableSeats: Number(base.availableSeats || 0),
      baseFare: Number(base.baseFare || 0),
      taxes: Number(base.taxes || 0),
      totalFare: Number(base.totalFare || 0),
      currency: base.currency || "INR",
      fareFamily: base.fareFamily || "",
      fareBasis: base.fareBasis || "",
      isRefundable: Boolean(base.isRefundable),
      stopCount: Number(base.stopCount || 0),
      baggage: base.baggage || { cabin: "", checkin: "" },
      ancillaries: Array.isArray(base.ancillaries) ? base.ancillaries : [],
      segments: Array.isArray(base.segments) ? base.segments : [],
      providerMeta: base.providerMeta || {}
    };
  }

  async searchFlights() {
    return this.wrapError(new Error(`${this.providerName}: searchFlights() not implemented`), 501);
  }

  async getFlightDetails() {
    return this.wrapError(new Error(`${this.providerName}: getFlightDetails() not implemented`), 501);
  }

  async holdBooking() {
    return this.wrapError(new Error(`${this.providerName}: holdBooking() not implemented`), 501);
  }

  async createBooking(params) {
    return this.confirmBooking(params);
  }

  async confirmBooking() {
    return this.wrapError(new Error(`${this.providerName}: confirmBooking() not implemented`), 501);
  }

  async cancelBooking() {
    return this.wrapError(new Error(`${this.providerName}: cancelBooking() not implemented`), 501);
  }

  async getSessionToken() {
    return this.wrapError(new Error(`${this.providerName}: getSessionToken() not implemented`), 501);
  }
}

module.exports = BaseFlightProvider;
