const ChatSession = require("../models/ChatSession");
const ChatService = require("../services/ChatService");

const sendMessage = async (req, res) => {
  const { message, sessionId } = req.body;
  const authContext = {
    userId: req.user?.userId || null,
    role: req.user?.role || "guest",
    email: req.user?.email || null
  };

  const session = await ChatService.getOrCreateSession({
    sessionId,
    userId: authContext.userId
  });

  await ChatService.appendMessage(session, {
    role: "user",
    content: message,
    timestamp: new Date()
  });

  const response = await ChatService.processMessage(session, message, authContext);

  await ChatService.appendMessage(session, {
    role: "assistant",
    content: response.reply,
    timestamp: new Date()
  });

  return res.status(200).json({
    success: true,
    message: "Chat response generated",
    data: {
      reply: response.reply,
      sessionId: session.sessionId,
      suggestedActions: response.suggestedActions
    }
  });
};

const getSession = async (req, res) => {
  const session = await ChatSession.findOne({ sessionId: req.params.sessionId });
  if (!session) {
    return res.status(404).json({ success: false, message: "Session not found" });
  }
  if (session.userId && req.user?.role !== "admin" && session.userId.toString() !== req.user?.userId) {
    return res.status(403).json({ success: false, message: "Access denied for this session" });
  }

  return res.json({
    success: true,
    message: "Session fetched",
    data: {
      sessionId: session.sessionId,
      messages: session.messages.slice(-20),
      isEscalated: session.isEscalated,
      ticketId: session.ticketId
    }
  });
};

const deleteSession = async (req, res) => {
  const session = await ChatSession.findOne({ sessionId: req.params.sessionId });
  if (!session) {
    return res.status(404).json({ success: false, message: "Session not found" });
  }
  if (session.userId && req.user?.role !== "admin" && session.userId.toString() !== req.user?.userId) {
    return res.status(403).json({ success: false, message: "Access denied for this session" });
  }

  await ChatSession.deleteOne({ _id: session._id });
  return res.json({
    success: true,
    message: "Session cleared"
  });
};

module.exports = {
  sendMessage,
  getSession,
  deleteSession
};
