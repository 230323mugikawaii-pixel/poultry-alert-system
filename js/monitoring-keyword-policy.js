"use strict";

(function initializeMonitoringKeywordPolicy(root, factory) {
  const policy = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = policy;
  }

  if (root) {
    root.CallNowMonitoringKeywordPolicy = policy;
  }
})(typeof globalThis === "object" ? globalThis : this, function createPolicy() {
  function findActiveGoogleConnection(connections) {
    if (!Array.isArray(connections)) {
      return null;
    }

    return (
      connections.find(
        (connection) =>
          connection?.provider === "GOOGLE" &&
          connection.connectionStatus === "ACTIVE" &&
          connection.authorizationStatus === "ACTIVE"
      ) ?? null
    );
  }

  function getActiveGoogleKeywords(connections) {
    const connection = findActiveGoogleConnection(connections);
    if (!connection || !Array.isArray(connection.keywords)) {
      return [];
    }

    return connection.keywords
      .filter((keyword) => typeof keyword === "string")
      .map((keyword) => keyword.trim())
      .filter(Boolean);
  }

  return {
    findActiveGoogleConnection,
    getActiveGoogleKeywords
  };
});
