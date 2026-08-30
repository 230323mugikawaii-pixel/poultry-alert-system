"use strict";

(function initializeOwnerOnboardingRouting(root, factory) {
  const routing = factory();

  if (
    typeof module === "object" &&
    module.exports
  ) {
    module.exports = routing;
  }

  if (root) {
    root.CallNowOwnerOnboardingRouting = routing;
  }
})(
  typeof globalThis !== "undefined"
    ? globalThis
    : this,
  () => {
    const destinations = Object.freeze({
      OWNER_SETUP: "OWNER_SETUP",
      APP: "APP"
    });

    function selectAuthenticatedDestination(input) {
      const onboardingStatus = input?.onboardingStatus ?? null;

      if (onboardingStatus === "PENDING") {
        return destinations.OWNER_SETUP;
      }

      if (onboardingStatus === "PURCHASED") return destinations.APP;

      return input?.hasCurrentTeam
        ? destinations.APP
        : destinations.OWNER_SETUP;
    }

    return Object.freeze({
      destinations,
      selectAuthenticatedDestination
    });
  }
);
