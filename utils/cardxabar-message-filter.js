function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function shouldProcessCardxabarMessage({
  configuredChatId,
  configuredUsername,
  messageChatId,
  senderUsername,
}) {
  const expectedChatId = normalize(configuredChatId);
  const expectedUsername = normalize(configuredUsername);

  if (!expectedChatId && !expectedUsername) return true;

  const chatMatches =
    expectedChatId && normalize(messageChatId) === expectedChatId;
  const usernameMatches =
    expectedUsername && normalize(senderUsername) === expectedUsername;

  return Boolean(chatMatches || usernameMatches);
}

module.exports = { shouldProcessCardxabarMessage };
