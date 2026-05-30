const mongoose = require("mongoose");

const schemaOptions = {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
};

const messageSchema = new mongoose.Schema(
  {
    /** Message role in the conversation. */
    role: { type: String, enum: ["user", "assistant", "tool"], required: true },
    /** Message content body. */
    content: { type: String, required: true },
    /** Optional tool name used to produce message. */
    toolName: { type: String, trim: true },
    /** Optional tool result payload. */
    toolResult: { type: mongoose.Schema.Types.Mixed },
    /** Message timestamp. */
    timestamp: { type: Date, default: Date.now }
  },
  { _id: false }
);

const ChatSessionSchema = new mongoose.Schema(
  {
    /** User id for this chat session (null for guest). */
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    /** Unique session identifier (UUID). */
    sessionId: { type: String, required: true, unique: true, trim: true },
    /** Ordered chat message list. */
    messages: { type: [messageSchema], default: [] },
    /** Archived chat messages beyond rolling session cap. */
    archivedMessages: { type: [messageSchema], default: [] },
    /** Context cache for intent-aware support flow. */
    context: {
      /** Last booking reference discussed. */
      lastBookingRef: { type: String, trim: true },
      /** Last flight search payload/state. */
      lastFlightSearch: { type: mongoose.Schema.Types.Mixed },
      /** Intents resolved in conversation so far. */
      resolvedIntents: { type: [String], default: [] }
    },
    /** Whether session is escalated to human support. */
    isEscalated: { type: Boolean, default: false },
    /** Linked support ticket id when escalated. */
    ticketId: { type: String, trim: true },
    /** Expiry timestamp for TTL cleanup. */
    expiresAt: { type: Date }
  },
  schemaOptions
);

ChatSessionSchema.index({ userId: 1 });
ChatSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const ChatSession = mongoose.model("ChatSession", ChatSessionSchema);

module.exports = ChatSession;
module.exports.ChatSession = ChatSession;
module.exports.ChatSessionSchema = ChatSessionSchema;
