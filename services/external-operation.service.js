function normalizeString(value) {
  return String(value || "").trim();
}

function isAmbiguousExternalError(error) {
  if (!error) return true;
  if (error.response) return false;

  const code = normalizeString(error.code).toUpperCase();
  if (
    [
      "ECONNABORTED",
      "ECONNRESET",
      "EPIPE",
      "ETIMEDOUT",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_SOCKET",
    ].includes(code)
  ) {
    return true;
  }

  const message = normalizeString(error.message || error.errorMessage).toLowerCase();
  return (
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("connection reset") ||
    message.includes("socket hang up") ||
    message.includes("network")
  );
}

module.exports = {
  isAmbiguousExternalError,
};
