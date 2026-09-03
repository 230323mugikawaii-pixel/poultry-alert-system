"use strict";

const ownerOnboardingRouting =
  globalThis.CallNowOwnerOnboardingRouting;

if (!ownerOnboardingRouting) {
  throw new Error(
    "Owner onboarding routing is unavailable."
  );
}

/* ========================================
   契約データを保存
======================================== */

function saveData() {
  const data = {
    storageVersion: STORAGE_VERSION,
    keywords: keywords,
    totalPrice: totalPrice,
    paidAnnualPrice: paidAnnualPrice,

    ...(legacyGoogleAccountsFallbackBackup.length > 1
      ? {
          legacyGoogleAccountsBackup:
            legacyGoogleAccountsFallbackBackup
        }
      : {}),

    contractStartDate:
      contractStartDate
        ? contractStartDate.toISOString()
        : null,

    contractEndDate:
      contractEndDate
        ? contractEndDate.toISOString()
        : null
  };

  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify(data)
  );

  contractStorageMigrationPending =
    false;
}


/* ========================================
   契約データを読み込む
======================================== */

function loadSavedData() {
  const savedData =
    localStorage.getItem(
      STORAGE_KEY
    );

  if (!savedData) {
    return;
  }

  try {
    const data =
      JSON.parse(savedData);

    contractStorageMigrationPending =
      data.storageVersion !==
        STORAGE_VERSION ||
      Array.isArray(data.googleAccounts) ||
      Object.prototype.hasOwnProperty.call(
        data,
        "accountCount"
      ) ||
      Object.prototype.hasOwnProperty.call(
        data,
        "googleEmail"
      );

    if (
      Array.isArray(data.keywords) &&
      data.keywords.length > 0
    ) {
      keywords =
        data.keywords.map(
          (keyword) =>
            String(keyword)
        );
    }

    if (
      typeof data.totalPrice ===
      "number"
    ) {
      totalPrice =
        data.totalPrice;
    }

    if (
      typeof data.paidAnnualPrice ===
        "number" &&
      data.paidAnnualPrice >= BASE_PRICE
    ) {
      paidAnnualPrice =
        data.paidAnnualPrice;
    } else if (
      data.contractStartDate &&
      typeof data.totalPrice ===
        "number"
    ) {
      /*
        旧形式の保存データでは、現在の年額を
        支払い済み年額として引き継ぐ。
      */
      paidAnnualPrice =
        data.totalPrice;
    }

    resolveSavedGoogleEmail(data);

    if (data.contractStartDate) {
      const startDate =
        new Date(
          data.contractStartDate
        );

      if (
        !Number.isNaN(
          startDate.getTime()
        )
      ) {
        contractStartDate =
          startDate;
      }
    }

    if (data.contractEndDate) {
      const endDate =
        new Date(
          data.contractEndDate
        );

      if (
        !Number.isNaN(
          endDate.getTime()
        )
      ) {
        contractEndDate =
          endDate;
      }
    }

  } catch (error) {
    console.error(
      "保存データの読み込みに失敗しました。",
      error
    );
  }
}
const keywordPolicy =
  window.CallNowKeywordPolicy;

if (!keywordPolicy) {
  throw new Error(
    "キーワード検証機能を読み込めませんでした。"
  );
}

const BASE_PRICE =
  keywordPolicy.BASE_PRICE_YEN;
const INCLUDED_KEYWORD_LIMIT =
  keywordPolicy.INCLUDED_KEYWORD_LIMIT;
const EXTRA_KEYWORD_PRICE =
  keywordPolicy.EXTRA_KEYWORD_PRICE_YEN;
const EXTRA_USER_PRICE = 100;
const STORAGE_VERSION = 2;
const STORAGE_KEY = "callNowContract";
const LEGACY_GOOGLE_ACCOUNTS_BACKUP_KEY =
  "callNowLegacyGoogleAccountsBackup";
const API_ORIGIN = resolveApiOrigin();
const TEST_API_URL =
  "https://script.google.com/macros/s/AKfycbw6hllq-Teht0GXydKn0V9GijokIhaCCUfBAeUKdTgIY2Vi7yqznDG55Xa1BTQtfitMgw/exec";

const TEST_API_TOKEN =
  "callnow-test-2026-Abc123456789";
const TEST_DETECTION_TIMEOUT_MS =
  3 * 60 * 1000;
const ALERT_SOUND_SETTING_KEY =
  "callNowAlertSoundSetting";
const ALERT_SOUND_SETTING_VERSION = 1;
const NOTIFIED_ALERT_IDS_KEY =
  "callNowNotifiedAlertIds";
const ALERT_FALLBACK_DELAY_MS = 4000;
const ALERT_FALLBACK_INTERVAL_MS = 4000;
const ALERT_LONG_DISCONNECT_MS = 12000;

const APP_BUILD_VERSION =
  "2026-08-31.5";

let alarmAudioContext = null;
let alarmSoundEnabled =
  loadAlarmSoundPreference();
let alarmSoundError = "";
let alarmRepeatTimer = null;
let alarmActiveNodes = [];
let alarmIsActive = false;
let alarmFocusBeforeOpen = null;
let appDialogFocusBeforeOpen = null;
let appDialogResolver = null;
let appDialogQueue =
  Promise.resolve();

let keywords = ["停電", "通電", "警報"];
let totalPrice = BASE_PRICE;
let contractStartDate = null;
let contractEndDate = null;
let googleEmail = "";
let authenticatedUser = null;
let notificationMemberSession = null;
let loginIdentities = [];
let loginProviderAvailability = {
  GOOGLE: "UNKNOWN",
  MICROSOFT: "UNKNOWN",
  APPLE: "UNKNOWN"
};
let currentTeam = null;
let mailConnections = [];
let mailProviderAvailability = {
  GOOGLE: "UNKNOWN",
  MICROSOFT: "UNKNOWN"
};
let ownerMonitoringProviderAvailability = {
  GOOGLE: "UNKNOWN",
  MICROSOFT: "UNKNOWN"
};
let ownerOnboarding = null;
let ownerSetupSeatCount = 1;
const ownerSetupLocalSkips = new Set();
let ownerSetupKeywordProvider = null;
const ownerSetupKeywordDrafts = {
  GOOGLE: null,
  MICROSOFT: null
};
const ownerSetupKeywordDirty = {
  GOOGLE: false,
  MICROSOFT: false
};
let notificationMemberManagement = null;
let notificationMemberManagementLoadState = "idle";
let notificationMemberLoginInfo = null;
let notificationMemberCredential = null;
let pendingContractChange = null;
let ownerAlerts = [];
let userNotifications = [];
let notificationUnreadCount = 0;
let notificationMemberAlerts = [];
let alertEventSource = null;
let alertFallbackStartTimer = null;
let alertFallbackInterval = null;
let alertLongDisconnectTimer = null;
let activeAlertAudience = null;
let currentAlarmAlertContext = null;
const notificationSelectionModes = {
  OWNER: false,
  NOTIFICATION_MEMBER: false
};
const selectedNotificationKeys = {
  OWNER: new Set(),
  NOTIFICATION_MEMBER: new Set()
};
const expandedEmergencyAlertIds = {
  OWNER: new Set(),
  NOTIFICATION_MEMBER: new Set()
};
const notifiedAlertIds =
  loadNotifiedAlertIds();
let legacyGoogleAccountsFallbackBackup =
  [];
let contractStorageMigrationPending =
  false;
let googleScreenMode = "link";
let setupMode = "signup";
/*
  現在の契約期間で、すでに支払った年額
*/
let paidAnnualPrice = BASE_PRICE;

/*
  signup：初回契約
  upgrade：キーワード追加による料金アップ
  renewal：契約期間の1年延長
*/
let paymentMode = "signup";

/*
  編集前の料金
*/
let priceBeforeEditing = BASE_PRICE;


function openAuthenticatedStartupDestination() {
  const destination =
    ownerOnboardingRouting.selectAuthenticatedDestination({
      onboardingStatus: ownerOnboarding?.status ?? null,
      hasCurrentTeam: Boolean(currentTeam)
    });

  if (
    destination ===
    ownerOnboardingRouting.destinations.OWNER_SETUP
  ) {
    openOwnerSetup();
  } else if (
    destination === ownerOnboardingRouting.destinations.APP
  ) {
    openApp();
  } else {
    openOwnerSetup();
  }

  return destination;
}

window.addEventListener("DOMContentLoaded", () => {
  void initializeApplication();
});


async function initializeApplication() {
  console.info(
    `Call Now ${APP_BUILD_VERSION}`
  );

  loadSavedData();
  clearLegacyContactInfo();
  initializeAppDialog();
  initializeAlarmNotification();
  normalizeKeywords();
  updatePrice();

  authenticatedUser =
    await fetchCurrentUser();

  if (!authenticatedUser) {
    notificationMemberSession =
      await fetchNotificationMemberSession();
  }

  loginProviderAvailability =
    await fetchLoginProviderAvailability();
  ownerMonitoringProviderAvailability =
    await fetchOwnerMonitoringProviderAvailability();

  googleEmail =
    authenticatedUser?.email || "";

  if (authenticatedUser) {
    ownerOnboarding =
      await fetchOwnerOnboarding();
    loginIdentities =
      await fetchLoginIdentities();
    currentTeam =
      await fetchCurrentTeamContext();
    hydrateContractKeywordsFromServer();
    await refreshUserNotifications();
    synchronizeContractFromCurrentTeam();

    if (hasActiveSubscription()) {
      mailProviderAvailability =
        await fetchMailProviderAvailability();
      mailConnections =
        await fetchMailConnections();
      hydrateContractKeywordsFromServer();
      if (currentTeam?.role === "OWNER") {
        await refreshNotificationMemberManagement();
        ownerAlerts =
          await fetchOwnerAlerts();
      }
    }
  }

  if (contractStorageMigrationPending) {
    saveData();
  }

  renderKeywordInputs();

  const primaryAuthResult =
    readPrimaryAuthResult();
  const identityLinkResult =
    readIdentityLinkResult();
  const loginProvider =
    readLoginProvider();
  const mailAuthResult =
    readMailAuthResult();
  const mailAuthProvider =
    readMailAuthProvider();
  const ownerOnboardingResult =
    readOwnerOnboardingResult();
  const ownerOnboardingProvider =
    readOwnerOnboardingProvider();

  if (ownerOnboardingResult) {
    clearAuthResultFromUrl("ownerOnboarding");
    clearAuthResultFromUrl("mailProvider");
  }

  if (mailAuthResult) {
    clearAuthResultFromUrl("mailAuth");
    clearAuthResultFromUrl("mailProvider");
  }

  if (primaryAuthResult) {
    clearAuthResultFromUrl("primaryAuth");
    clearAuthResultFromUrl("loginProvider");

    if (
      primaryAuthResult === "success" &&
      authenticatedUser
    ) {
      openAuthenticatedStartupDestination();
      return;
    }

    openGoogleScreen("login");
    setText(
      "googleError",
      primaryAuthResult === "unavailable"
        ? `${loginProviderLabel(loginProvider)}ログインは現在準備中です。`
        : `${loginProviderLabel(loginProvider)}ログインに失敗しました。もう一度お試しください。`
    );
    return;
  }

  if (identityLinkResult && authenticatedUser) {
    clearAuthResultFromUrl("identityLink");
    clearAuthResultFromUrl("loginProvider");
    openGoogleScreen("manage");
    await showAppAlert(
      identityLinkResult === "success"
        ? `${loginProviderLabel(loginProvider)}ログインを追加しました。`
        : identityLinkResult === "unavailable"
          ? `${loginProviderLabel(loginProvider)}ログインは現在準備中です。`
          : `${loginProviderLabel(loginProvider)}ログインを追加できませんでした。`,
      {
        title:
          identityLinkResult === "success"
            ? "ログイン方法を追加しました"
            : "ログイン方法の追加エラー"
      }
    );
    return;
  }

  if (ownerOnboardingResult) {
    if (
      ownerOnboardingResult === "success" &&
      authenticatedUser
    ) {
      ownerOnboarding =
        await fetchOwnerOnboarding();
      currentTeam =
        await fetchCurrentTeamContext();
      openAuthenticatedStartupDestination();
      return;
    }

    openOwnerSetup();
    setText(
      "ownerMonitoringSetupError",
      ownerOnboardingResult === "unavailable"
        ? `${mailProviderLabel(ownerOnboardingProvider)}は現在準備中です。別のアカウントを設定するか、時間をおいてお試しください。`
        : `${mailProviderLabel(ownerOnboardingProvider)}を設定できませんでした。もう一度お試しください。`
    );
    return;
  }

  if (authenticatedUser) {
    const destination =
      openAuthenticatedStartupDestination();
    if (
      destination !==
      ownerOnboardingRouting.destinations.APP
    ) {
      return;
    }
    if (mailAuthResult) {
      await showAppAlert(
        mailAuthResult === "success"
          ? "メール監視アカウントを接続しました。"
          : mailAuthResult === "unavailable"
            ? `${mailProviderLabel(mailAuthProvider)}接続を開始できませんでした。現在サービス設定を確認しています。`
            : "メール監視アカウントを接続できませんでした。もう一度お試しください。",
        {
          title:
            mailAuthResult === "success"
              ? "メール監視の接続完了"
              : "メール監視の接続エラー"
        }
      );
    }
  } else if (notificationMemberSession) {
    openNotificationMemberApp();
  } else {
    openGuestHome();
  }
}


function resolveApiOrigin() {
  const configuredOrigin =
    document
      .querySelector(
        'meta[name="call-now-api-origin"]'
      )
      ?.getAttribute("content")
      ?.trim();

  if (configuredOrigin) {
    return configuredOrigin.replace(/\/$/u, "");
  }

  if (
    window.location.hostname === "127.0.0.1" ||
    window.location.hostname === "localhost"
  ) {
    return `${window.location.protocol}//${window.location.hostname}:8080`;
  }

  return window.location.origin;
}


function apiUrl(path) {
  return new URL(path, `${API_ORIGIN}/`).toString();
}


async function fetchCurrentUser() {
  try {
    const response = await fetch(
      apiUrl("/api/v1/auth/me"),
      {
        method: "GET",
        credentials: "include",
        headers: {
          Accept: "application/json"
        },
        cache: "no-store"
      }
    );

    if (response.status === 401) {
      return null;
    }

    if (!response.ok) {
      throw new Error(
        `auth_me_${response.status}`
      );
    }

    const result = await response.json();
    const user = result?.user;

    if (
      !user ||
      typeof user.id !== "string" ||
      !isValidEmail(user.email)
    ) {
      throw new Error("auth_me_invalid");
    }

    return {
      id: user.id,
      email: user.email.trim(),
      displayName:
        typeof user.displayName === "string"
          ? user.displayName
          : null
    };
  } catch (error) {
    console.warn(
      "ログイン状態を確認できませんでした。",
      error
    );
    return null;
  }
}


async function fetchNotificationMemberSession() {
  try {
    const response = await fetch(
      apiUrl("/api/v1/notification-members/me"),
      {
        method: "GET",
        credentials: "include",
        headers: { Accept: "application/json" },
        cache: "no-store"
      }
    );
    if (response.status === 401) return null;
    if (!response.ok) {
      throw new Error(
        `notification_member_me_${response.status}`
      );
    }
    const result = await response.json();
    if (
      typeof result?.member?.id !== "string" ||
      typeof result?.member?.callNowId !== "string" ||
      typeof result?.team?.id !== "string"
    ) {
      throw new Error("notification_member_me_invalid");
    }
    return result;
  } catch (error) {
    console.warn(
      "通知メンバーのログイン状態を確認できませんでした。",
      error
    );
    return null;
  }
}


async function fetchLoginProviderAvailability() {
  const unknown = {
    GOOGLE: "UNKNOWN",
    MICROSOFT: "UNKNOWN",
    APPLE: "UNKNOWN"
  };
  try {
    const response = await fetch(
      apiUrl("/api/v1/auth/providers"),
      {
        method: "GET",
        credentials: "include",
        headers: { Accept: "application/json" },
        cache: "no-store"
      }
    );
    if (!response.ok) return unknown;
    const providers =
      (await response.json())?.providers;
    if (!Array.isArray(providers)) return unknown;
    const result = { ...unknown };
    providers.forEach((entry) => {
      if (
        ["GOOGLE", "MICROSOFT", "APPLE"].includes(
          entry?.provider
        ) &&
        ["AVAILABLE", "NOT_CONFIGURED"].includes(
          entry?.status
        )
      ) {
        result[entry.provider] = entry.status;
      }
    });
    return result;
  } catch (error) {
    console.warn(
      "ログイン方法の準備状況を確認できませんでした。",
      error
    );
    return unknown;
  }
}


async function fetchOwnerMonitoringProviderAvailability() {
  const unknown = {
    GOOGLE: "UNKNOWN",
    MICROSOFT: "UNKNOWN"
  };
  try {
    const response = await fetch(
      apiUrl("/api/v1/owner-onboarding/providers"),
      {
        method: "GET",
        credentials: "include",
        headers: { Accept: "application/json" },
        cache: "no-store"
      }
    );
    if (!response.ok) return unknown;
    const providers =
      (await response.json())?.providers;
    if (!Array.isArray(providers)) return unknown;
    const result = { ...unknown };
    providers.forEach((entry) => {
      if (
        (entry?.provider === "GOOGLE" ||
          entry?.provider === "MICROSOFT") &&
        (entry.status === "AVAILABLE" ||
          entry.status === "NOT_CONFIGURED")
      ) {
        result[entry.provider] = entry.status;
      }
    });
    return result;
  } catch (error) {
    console.warn(
      "監視アカウント設定の準備状況を確認できませんでした。",
      error
    );
    return unknown;
  }
}


async function fetchOwnerOnboarding() {
  if (!authenticatedUser) return null;
  try {
    const response = await fetch(
      apiUrl("/api/v1/owner-onboarding/current"),
      {
        method: "GET",
        credentials: "include",
        headers: { Accept: "application/json" },
        cache: "no-store"
      }
    );
    if (response.status === 401) return null;
    if (!response.ok) {
      throw new Error(
        `owner_onboarding_${response.status}`
      );
    }
    const onboarding =
      (await response.json())?.onboarding;
    return isOwnerOnboarding(onboarding)
      ? onboarding
      : null;
  } catch (error) {
    console.warn(
      "初回設定の状態を確認できませんでした。",
      error
    );
    return null;
  }
}


function isOwnerOnboarding(value) {
  return Boolean(
    value &&
      typeof value.id === "string" &&
      [
        "PENDING",
        "PURCHASED",
        "COMPLETED",
        "EXPIRED",
        "ABANDONED"
      ].includes(value.status) &&
      Array.isArray(value.choices)
  );
}


async function fetchLoginIdentities() {
  try {
    const response = await fetch(
      apiUrl("/api/v1/auth/identities"),
      {
        method: "GET",
        credentials: "include",
        headers: { Accept: "application/json" },
        cache: "no-store"
      }
    );
    if (!response.ok) return [];
    const identities =
      (await response.json())?.identities;
    if (!Array.isArray(identities)) return [];
    return identities.filter(
      (identity) =>
        ["GOOGLE", "MICROSOFT", "APPLE"].includes(
          identity?.provider
        ) &&
        typeof identity.email === "string"
    );
  } catch (error) {
    console.warn(
      "ログイン方法を確認できませんでした。",
      error
    );
    return [];
  }
}


async function fetchCurrentTeamContext() {
  try {
    const response = await fetch(
      apiUrl("/api/v1/teams/current"),
      {
        method: "GET",
        credentials: "include",
        headers: {
          Accept: "application/json"
        },
        cache: "no-store"
      }
    );

    if (
      response.status === 401 ||
      response.status === 404
    ) {
      return null;
    }

    if (!response.ok) {
      throw new Error(
        `team_current_${response.status}`
      );
    }

    const team = parseTeamContext(
      (await response.json())?.team
    );
    if (!team) {
      throw new Error("team_current_invalid");
    }
    return team;
  } catch (error) {
    console.warn(
      "チーム情報を確認できませんでした。",
      error
    );
    return null;
  }
}


async function bootstrapInitialTeamContext() {
  try {
    const response = await fetch(
      apiUrl("/api/v1/teams/bootstrap"),
      {
        method: "POST",
        credentials: "include",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          keywords: [...keywords]
        })
      }
    );

    if (response.status === 401) {
      return null;
    }
    if (!response.ok) {
      throw new Error(
        `team_bootstrap_${response.status}`
      );
    }

    const team = parseTeamContext(
      (await response.json())?.team
    );
    if (!team) {
      throw new Error("team_bootstrap_invalid");
    }
    return team;
  } catch (error) {
    console.warn(
      "初期設定を完了できませんでした。",
      error
    );
    return null;
  }
}


function parseTeamContext(team) {
  const subscription =
    team?.subscription;
  const termStartedAt =
    new Date(
      subscription?.currentTermStartedAt ??
        ""
    );
  const termEndsAt =
    new Date(
      subscription?.currentTermEndsAt ??
        ""
    );

  if (
    !team ||
    typeof team.id !== "string" ||
    (team.role !== "OWNER" &&
      team.role !== "MEMBER") ||
    !subscription ||
    typeof team?.seats?.seatLimit !== "number" ||
    typeof team?.seats?.activeMemberCount !== "number" ||
    typeof team?.seats?.availableSeats !== "number" ||
    typeof team?.seats?.totalUserLimit !== "number" ||
    ![
      "ACTIVE",
      "PAST_DUE",
      "CANCELED"
    ].includes(subscription.status) ||
    typeof subscription.currentTermAmountYen !==
      "number" ||
    Number.isNaN(termStartedAt.getTime()) ||
    Number.isNaN(termEndsAt.getTime())
  ) {
    return null;
  }
  return {
    id: team.id,
    role: team.role,
    keywords: Array.isArray(
      team.keywords
    )
      ? team.keywords
          .filter(
            (keyword) =>
              typeof keyword ===
              "string"
          )
          .map((keyword) =>
            keyword.trim()
          )
          .filter(Boolean)
      : [],
    teamCode:
      typeof team.teamCode === "string"
        ? team.teamCode
        : "",
    seats: {
      additionalSeatLimit:
        team.seats.seatLimit,
      activeMemberCount:
        team.seats.activeMemberCount,
      availableSeats:
        team.seats.availableSeats,
      seatCount:
        team.seats.totalUserLimit
    },
    pendingSeatCount:
      typeof team.pendingSeatLimit === "number"
        ? 1 + team.pendingSeatLimit
        : null,
    subscription: {
      status: subscription.status,
      currentTermAmountYen:
        subscription.currentTermAmountYen,
      renewalAmountYen:
        typeof subscription.renewalAmountYen === "number"
          ? subscription.renewalAmountYen
          : subscription.currentTermAmountYen,
      currentTermStartedAt:
        termStartedAt,
      currentTermEndsAt:
        termEndsAt
    }
  };
}


async function fetchNotificationMembers() {
  if (currentTeam?.role !== "OWNER") return null;
  try {
    const response = await fetch(
      apiUrl(
        `/api/v1/teams/${encodeURIComponent(currentTeam.id)}/notification-members`
      ),
      {
        method: "GET",
        credentials: "include",
        headers: { Accept: "application/json" },
        cache: "no-store"
      }
    );
    if (response.status === 401 || response.status === 403) {
      return null;
    }
    if (!response.ok) {
      throw new Error(
        `notification_members_${response.status}`
      );
    }
    const result = await response.json();
    return Array.isArray(result?.members) && result?.seats
      ? result
      : null;
  } catch (error) {
    console.warn(
      "通知メンバー情報を確認できませんでした。",
      error
    );
    return null;
  }
}


async function refreshNotificationMemberManagement() {
  if (currentTeam?.role !== "OWNER") {
    notificationMemberManagement = null;
    notificationMemberManagementLoadState = "idle";
    renderNotificationMemberManagement();
    return null;
  }
  notificationMemberManagementLoadState = "loading";
  renderNotificationMemberManagement();
  const result = await fetchNotificationMembers();
  notificationMemberManagement = result;
  notificationMemberManagementLoadState = result
    ? "ready"
    : "error";
  renderNotificationMemberManagement();
  return result;
}


function hasActiveSubscription() {
  const subscription =
    currentTeam?.subscription;

  return Boolean(
    subscription &&
      subscription.status === "ACTIVE" &&
      subscription.currentTermEndsAt >
        new Date()
  );
}


function synchronizeContractFromCurrentTeam() {
  if (!currentTeam?.subscription) {
    return;
  }

  contractStartDate =
    new Date(
      currentTeam.subscription.currentTermStartedAt
    );
  contractEndDate =
    new Date(
      currentTeam.subscription.currentTermEndsAt
    );
  paidAnnualPrice =
    currentTeam.subscription.currentTermAmountYen;
  totalPrice =
    currentTeam.subscription.renewalAmountYen;
  saveData();
}


function hydrateContractKeywordsFromServer() {
  if (
    !currentTeam ||
    !Array.isArray(currentTeam.keywords)
  ) {
    return;
  }

  keywords = [...currentTeam.keywords];
  ownerSetupSeatCount =
    currentTeam.seats?.seatCount ?? 1;
}

async function fetchMailConnections() {
  if (currentTeam?.role !== "OWNER") {
    return [];
  }

  try {
    const response = await fetch(
      apiUrl(
        `/api/v1/teams/${encodeURIComponent(currentTeam.id)}/mail-connections`
      ),
      {
        method: "GET",
        credentials: "include",
        headers: {
          Accept: "application/json"
        },
        cache: "no-store"
      }
    );

    if (response.status === 401) {
      return [];
    }

    if (!response.ok) {
      throw new Error(
        `mail_connection_${response.status}`
      );
    }

    const connections =
      (await response.json())?.connections;
    return Array.isArray(connections)
      ? connections.filter(
          (connection) =>
            typeof connection?.id === "string" &&
            typeof connection.email === "string" &&
            (connection.provider === "GOOGLE" ||
              connection.provider === "MICROSOFT")
          )
          .map((connection) => ({
            ...connection,
            keywords: Array.isArray(
              connection.keywords
            )
              ? connection.keywords
                  .filter(
                    (keyword) =>
                      typeof keyword ===
                      "string"
                  )
                  .map((keyword) =>
                    keyword.trim()
                  )
                  .filter(Boolean)
              : []
          })
        )
      : [];
  } catch (error) {
    console.warn(
      "メール監視アカウントの状態を確認できませんでした。",
      error
    );
    return [];
  }
}


async function fetchMailProviderAvailability() {
  const unknown = {
    GOOGLE: "UNKNOWN",
    MICROSOFT: "UNKNOWN"
  };
  if (currentTeam?.role !== "OWNER") {
    return unknown;
  }

  try {
    const response = await fetch(
      apiUrl(
        `/api/v1/teams/${encodeURIComponent(currentTeam.id)}/mail-connection/providers`
      ),
      {
        method: "GET",
        credentials: "include",
        headers: {
          Accept: "application/json"
        },
        cache: "no-store"
      }
    );
    if (!response.ok) {
      throw new Error(
        `mail_provider_status_${response.status}`
      );
    }
    const providers =
      (await response.json())?.providers;
    if (!Array.isArray(providers)) {
      return unknown;
    }
    const result = { ...unknown };
    providers.forEach((entry) => {
      if (
        (entry?.provider === "GOOGLE" ||
          entry?.provider === "MICROSOFT") &&
        (entry.status === "AVAILABLE" ||
          entry.status === "NOT_CONFIGURED")
      ) {
        result[entry.provider] = entry.status;
      }
    });
    return result;
  } catch (error) {
    console.warn(
      "メール接続の準備状況を確認できませんでした。",
      error
    );
    return unknown;
  }
}


function readPrimaryAuthResult() {
  const result =
    new URL(window.location.href)
      .searchParams
      .get("primaryAuth");

  return result === "success" ||
    result === "error" ||
    result === "unavailable"
    ? result
    : null;
}


function readIdentityLinkResult() {
  const result =
    new URL(window.location.href)
      .searchParams
      .get("identityLink");
  return result === "success" ||
    result === "error" ||
    result === "unavailable"
    ? result
    : null;
}


function readLoginProvider() {
  const provider =
    new URL(window.location.href)
      .searchParams
      .get("loginProvider");
  return ["MICROSOFT", "APPLE"].includes(provider)
    ? provider
    : "GOOGLE";
}


function readMailAuthProvider() {
  const provider =
    new URL(window.location.href)
      .searchParams
      .get("mailProvider");
  return provider === "MICROSOFT"
    ? "MICROSOFT"
    : "GOOGLE";
}


function readMailAuthResult() {
  const result =
    new URL(window.location.href)
      .searchParams
      .get("mailAuth");

  return result === "success" ||
    result === "error" ||
    result === "unavailable"
    ? result
    : null;
}


function readOwnerOnboardingResult() {
  const result =
    new URL(window.location.href)
      .searchParams
      .get("ownerOnboarding");
  return result === "success" ||
    result === "error" ||
    result === "unavailable"
    ? result
    : null;
}


function readOwnerOnboardingProvider() {
  const provider =
    new URL(window.location.href)
      .searchParams
      .get("mailProvider");
  return provider === "MICROSOFT"
    ? "MICROSOFT"
    : "GOOGLE";
}


function clearAuthResultFromUrl(parameterName) {
  const url = new URL(window.location.href);
  url.searchParams.delete(parameterName);
  window.history.replaceState(
    null,
    "",
    `${url.pathname}${url.search}${url.hash}`
  );
}


function openGuestHome() {
  showOnlyScreen("guestHomeScreen");
  setText("notificationMemberLoginError", "");
  window.scrollTo({ top: 0 });
}


function openOwnerLogin() {
  openGoogleScreen("login");
}


function openOwnerSetup() {
  setText("ownerMonitoringSetupError", "");
  showOnlyScreen("ownerMonitoringSetupScreen");
  renderOwnerMonitoringSetup();
  window.scrollTo({ top: 0 });
}


function renderOwnerMonitoringSetup() {
  renderOwnerMonitoringProvider("GOOGLE");
  renderOwnerMonitoringProvider("MICROSOFT");
  const authorizedChoices =
    getOwnerAuthorizedChoices();
  const continueButton =
    document.getElementById(
      "ownerMonitoringContinueButton"
    );
  if (continueButton) {
    continueButton.disabled = false;
  }

  const choices =
    ownerOnboarding?.choices ?? [];
  const skippedProviders =
    ["GOOGLE", "MICROSOFT"].filter(
      (provider) =>
        ownerSetupLocalSkips.has(provider) ||
        choices.some(
          (choice) =>
            choice.provider === provider &&
            choice.status === "SKIPPED"
        )
    );
  setText(
    "ownerMonitoringSetupError",
    authorizedChoices.length === 0 &&
      skippedProviders.length === 2
      ? "Call Nowを利用するには、GoogleまたはMicrosoftの監視アカウントを1件以上設定してください。"
      : ""
  );
}


function renderOwnerMonitoringProvider(provider) {
  const prefix =
    provider === "GOOGLE"
      ? "ownerGoogle"
      : "ownerMicrosoft";
  const status =
    document.getElementById(`${prefix}SetupStatus`);
  const setupButton =
    document.getElementById(`${prefix}SetupButton`);
  const skipButton =
    document.getElementById(`${prefix}SkipButton`);
  if (!status || !setupButton || !skipButton) return;

  const choice = ownerOnboarding?.choices?.find(
    (candidate) => candidate.provider === provider
  );
  const isAuthorized = Boolean(
    choice?.email &&
      ["AUTHORIZED", "ACTIVATED", "DEFERRED"].includes(
        choice.status
      )
  );
  const isSkipped =
    ownerSetupLocalSkips.has(provider) ||
    choice?.status === "SKIPPED";
  const isAvailable =
    ownerMonitoringProviderAvailability[provider] ===
    "AVAILABLE";

  setupButton.disabled = !isAvailable;
  skipButton.classList.toggle("hidden", isAuthorized);
  setupButton.classList.toggle("primary", !isAuthorized);
  setupButton.classList.toggle("outline", isAuthorized);

  if (isAuthorized) {
    status.innerHTML = `
      <strong>✓ 設定しました</strong>
      <span>${escapeHtml(choice.email)}</span>
    `;
    setupButton.textContent =
      provider === "GOOGLE"
        ? "Googleアカウントを変更"
        : "Microsoftアカウントを変更";
    return;
  }

  setupButton.textContent =
    provider === "GOOGLE"
      ? "Googleを設定する"
      : "Microsoftを設定する";
  if (isSkipped) {
    status.textContent =
      `${provider === "GOOGLE" ? "Google" : "Microsoft"}アカウントは今回は設定しません。あとからいつでも設定できます。`;
    return;
  }

  status.textContent = isAvailable
    ? ""
    : "現在準備中です。別のアカウントを設定してください。";
}


function startOwnerMonitoringOAuth(provider) {
  if (
    provider !== "GOOGLE" &&
    provider !== "MICROSOFT"
  ) {
    return;
  }
  if (
    ownerMonitoringProviderAvailability[provider] !==
    "AVAILABLE"
  ) {
    setText(
      "ownerMonitoringSetupError",
      `${mailProviderLabel(provider)}は現在準備中です。`
    );
    return;
  }
  ownerSetupLocalSkips.delete(provider);
  setText("ownerMonitoringSetupError", "");
  const form = document.createElement("form");
  form.method = "post";
  form.action = apiUrl(
    `/api/v1/owner-onboarding/oauth/${provider.toLowerCase()}/start`
  );
  form.hidden = true;
  document.body.appendChild(form);
  form.submit();
}


async function skipOwnerMonitoringProvider(provider) {
  if (
    provider !== "GOOGLE" &&
    provider !== "MICROSOFT"
  ) {
    return;
  }
  setText("ownerMonitoringSetupError", "");
  if (authenticatedUser && ownerOnboarding?.status === "PENDING") {
    try {
      const response = await fetch(
        apiUrl(
          `/api/v1/owner-onboarding/providers/${provider.toLowerCase()}/skip`
        ),
        {
          method: "POST",
          credentials: "include",
          headers: { Accept: "application/json" }
        }
      );
      const result = await response.json().catch(() => null);
      if (!response.ok || !isOwnerOnboarding(result)) {
        throw new Error(
          result?.error?.message ||
            `owner_onboarding_skip_${response.status}`
        );
      }
      ownerOnboarding = result;
    } catch (error) {
      setText(
        "ownerMonitoringSetupError",
        error instanceof Error
          ? error.message
          : "設定状態を保存できませんでした。"
      );
      return;
    }
  } else {
    ownerSetupLocalSkips.add(provider);
  }
  renderOwnerMonitoringSetup();
}


function continueFromOwnerMonitoringSetup() {
  const authorizedChoices =
    getOwnerAuthorizedChoices();
  if (!authenticatedUser || authorizedChoices.length === 0) {
    setText(
      "ownerMonitoringSetupError",
      "Call Nowを利用するには、GoogleまたはMicrosoftの監視アカウントを1件以上設定してください。"
    );
    return;
  }
  setupMode = "signup";
  synchronizeOwnerKeywordDrafts();
  const firstUndecided = authorizedChoices.find(
    (choice) => !isOwnerKeywordChoiceDecided(choice)
  );
  openOwnerKeywordSetup(
    firstUndecided?.provider ?? authorizedChoices[0].provider
  );
}


function getOwnerAuthorizedChoices() {
  return (ownerOnboarding?.choices ?? []).filter(
    (choice) =>
      choice.status === "AUTHORIZED" &&
      choice.email &&
      (choice.provider === "GOOGLE" ||
        choice.provider === "MICROSOFT")
  );
}


function synchronizeOwnerKeywordDrafts() {
  getOwnerAuthorizedChoices().forEach((choice) => {
    if (ownerSetupKeywordDrafts[choice.provider] !== null) {
      return;
    }
    ownerSetupKeywordDrafts[choice.provider] =
      Array.isArray(choice.keywords) && choice.keywords.length > 0
        ? [...choice.keywords]
        : ["停電", "通電", "警報"];
    ownerSetupKeywordDirty[choice.provider] = false;
  });
}


function saveCurrentOwnerKeywordDraft() {
  if (
    setupMode !== "signup" ||
    !ownerSetupKeywordProvider
  ) {
    return;
  }
  ownerSetupKeywordDrafts[ownerSetupKeywordProvider] =
    [...keywords];
}


function isOwnerKeywordChoiceDecided(choice) {
  return Boolean(
    choice?.keywordsConfirmedAt &&
      !ownerSetupKeywordDirty[choice.provider]
  );
}


function openOwnerKeywordSetup(provider) {
  const choices = getOwnerAuthorizedChoices();
  if (!choices.some((choice) => choice.provider === provider)) {
    openOwnerSetup();
    return;
  }
  saveCurrentOwnerKeywordDraft();
  synchronizeOwnerKeywordDrafts();
  ownerSetupKeywordProvider = provider;
  keywords = [
    ...(ownerSetupKeywordDrafts[provider] ??
      ["停電", "通電", "警報"])
  ];
  showOnlyScreen("setupScreen");
  renderKeywordInputs();
  updateSetupScreenText();
  updatePrice();
  window.scrollTo({ top: 0 });
}


function switchOwnerKeywordProvider(provider) {
  if (provider === ownerSetupKeywordProvider) return;
  openOwnerKeywordSetup(provider);
}


function renderOwnerKeywordProviderNavigation() {
  const section = document.getElementById(
    "ownerKeywordProviderSection"
  );
  const tabs = document.getElementById(
    "ownerKeywordProviderTabs"
  );
  if (!section || !tabs) return;
  const choices = getOwnerAuthorizedChoices();
  section.classList.toggle(
    "hidden",
    setupMode !== "signup" || choices.length === 0
  );
  if (setupMode !== "signup" || choices.length === 0) {
    return;
  }
  const choice = choices.find(
    (candidate) =>
      candidate.provider === ownerSetupKeywordProvider
  ) ?? choices[0];
  ownerSetupKeywordProvider = choice.provider;
  tabs.classList.toggle("hidden", choices.length < 2);
  tabs.innerHTML = choices.length < 2
    ? ""
    : choices.map((candidate) => `
        <button
          type="button"
          class="owner-keyword-provider-tab ${candidate.provider === choice.provider ? "active" : ""}"
          onclick="switchOwnerKeywordProvider('${candidate.provider}')"
          ${candidate.provider === choice.provider ? 'aria-current="true"' : ""}
        >
          ${candidate.provider === "GOOGLE" ? "Google" : "Microsoft"}
          ${isOwnerKeywordChoiceDecided(candidate) ? '<span class="tab-complete">✓</span>' : ""}
        </button>
      `).join("");
  setText(
    "ownerKeywordProviderLabel",
    choice.provider === "GOOGLE" ? "Google" : "Microsoft"
  );
  setText(
    "ownerKeywordProviderTitle",
    choice.provider === "GOOGLE"
      ? "Gmailの通知キーワード"
      : "Microsoft 365の通知キーワード"
  );
  setText("ownerKeywordProviderEmail", choice.email);
  setText(
    "ownerKeywordDecisionStatus",
    isOwnerKeywordChoiceDecided(choice)
      ? "✓ 決定済み"
      : choice.keywordsConfirmedAt
        ? "変更あり・再決定が必要"
        : "未決定"
  );
}


function getOwnerSetupBillingKeywords() {
  saveCurrentOwnerKeywordDraft();
  const merged = [];
  const seen = new Set();
  getOwnerAuthorizedChoices().forEach((choice) => {
    const values =
      ownerSetupKeywordDrafts[choice.provider] ??
      choice.keywords ?? [];
    values.forEach((value) => {
      const normalized = keywordPolicy.normalizeKeyword(value);
      const key = normalized
        .normalize("NFKC")
        .toLocaleLowerCase("ja-JP");
      if (!normalized || seen.has(key)) return;
      seen.add(key);
      merged.push(normalized);
    });
  });
  return merged;
}


function openNotificationMemberLogin() {
  showOnlyScreen("notificationMemberLoginScreen");
  setText("notificationMemberLoginError", "");
  document
    .getElementById("notificationMemberCallNowId")
    ?.focus();
  window.scrollTo({ top: 0 });
}


async function loginNotificationMember(event) {
  event?.preventDefault();
  const callNowId = document
    .getElementById("notificationMemberCallNowId")
    ?.value?.trim();
  const password = document
    .getElementById("notificationMemberPassword")
    ?.value;
  setText("notificationMemberLoginError", "");
  if (!callNowId || !password) {
    setText(
      "notificationMemberLoginError",
      "Call Now IDとパスワードを入力してください。"
    );
    return;
  }
  try {
    const response = await fetch(
      apiUrl("/api/v1/notification-members/login"),
      {
        method: "POST",
        credentials: "include",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ callNowId, password })
      }
    );
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(
        payload?.error?.message ||
          "Call Now IDまたはパスワードを確認してください。"
      );
    }
    notificationMemberSession = await response.json();
    const passwordInput = document.getElementById(
      "notificationMemberPassword"
    );
    if (passwordInput) passwordInput.value = "";
    openNotificationMemberApp();
  } catch (error) {
    setText(
      "notificationMemberLoginError",
      error instanceof Error
        ? error.message
        : "ログインできませんでした。もう一度お試しください。"
    );
  }
}


function openNotificationMemberApp() {
  if (!notificationMemberSession) {
    openNotificationMemberLogin();
    return;
  }
  showOnlyScreen("notificationMemberAppScreen");
  setText(
    "notificationMemberWelcome",
    notificationMemberSession.member.displayName ||
      "通知メンバー"
  );
  setText(
    "notificationMemberTeamName",
    notificationMemberSession.team.name ||
      `通知グループ ${notificationMemberSession.team.teamCode}`
  );
  showNotificationMemberHome();
  renderEmergencyNotifications(
    "notificationMemberEmergencyNotificationList",
    notificationMemberAlerts,
    "NOTIFICATION_MEMBER"
  );
  renderNotificationBadge();
  void refreshNotificationMemberAlerts();
  startNotificationMemberAlertStream();
  updateAlarmAudioReadiness("NOTIFICATION_MEMBER");
  window.scrollTo({ top: 0 });
}


function showNotificationMemberHome() {
  document
    .getElementById("notificationMemberHomePage")
    ?.classList.remove("hidden");
  document
    .getElementById("notificationMemberNotificationCenterPage")
    ?.classList.add("hidden");
  window.scrollTo({ top: 0 });
}


function openNotificationMemberNotificationCenter() {
  document
    .getElementById("notificationMemberHomePage")
    ?.classList.add("hidden");
  document
    .getElementById("notificationMemberNotificationCenterPage")
    ?.classList.remove("hidden");
  setText("notificationMemberNotificationCenterError", "");
  setText("notificationMemberNotificationCenterStatus", "");
  renderNotificationSelectionControls("NOTIFICATION_MEMBER");
  renderEmergencyNotifications(
    "notificationMemberEmergencyNotificationList",
    notificationMemberAlerts,
    "NOTIFICATION_MEMBER"
  );
  void refreshNotificationMemberAlerts();
  window.scrollTo({ top: 0 });
}


async function logoutNotificationMember() {
  try {
    await fetch(
      apiUrl("/api/v1/notification-members/logout"),
      {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json" }
      }
    );
  } catch (error) {
    console.warn(
      "通知メンバーのログアウト状態を確認できませんでした。",
      error
    );
  }
  notificationMemberSession = null;
  notificationMemberAlerts = [];
  resetNotificationCenterUiState("NOTIFICATION_MEMBER");
  renderNotificationBadge();
  stopAlertEventStream();
  openGuestHome();
}


async function fetchOwnerAlerts() {
  if (!currentTeam || currentTeam.role !== "OWNER") {
    return [];
  }
  return fetchAlerts(
    `/api/v1/teams/${encodeURIComponent(currentTeam.id)}/alerts`,
    "OWNER");
}

async function fetchNotificationMemberAlerts() {
  if (!notificationMemberSession) {
    return [];
  }
  return fetchAlerts(
    "/api/v1/notification-members/alerts",
    "NOTIFICATION_MEMBER");
}

async function fetchAlerts(path, audience) {
  try {
    const response = await fetch(apiUrl(path), {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
      cache: "no-store"});
    if (response.status === 401) {
      handleAlertSessionEnded(audience);
      return null;
    }
    if (!response.ok) {
      return null;
    }
    const payload = await response.json();
    return Array.isArray(payload.alerts) ? payload.alerts : [];
  } catch {
    return null;
  }
}

async function refreshOwnerAlerts() {
  const alerts = await fetchOwnerAlerts();
  if (!Array.isArray(alerts)) return false;
  ownerAlerts = alerts;
  applyAlertUpdate(alerts, "OWNER");
  return true;
}

async function refreshNotificationMemberAlerts() {
  const alerts = await fetchNotificationMemberAlerts();
  if (!Array.isArray(alerts)) return false;
  notificationMemberAlerts = alerts;
  applyAlertUpdate(alerts, "NOTIFICATION_MEMBER");
  return true;
}

function startOwnerAlertStream() {
  if (!currentTeam || currentTeam.role !== "OWNER") {
    stopAlertEventStream();
    return;
  }
  startAlertEventStream(
    `/api/v1/teams/${encodeURIComponent(currentTeam.id)}/alerts/events`,
    "OWNER");
}

function startNotificationMemberAlertStream() {
  if (!notificationMemberSession) {
    stopAlertEventStream();
    return;
  }
  startAlertEventStream(
    "/api/v1/notification-members/alerts/events",
    "NOTIFICATION_MEMBER");
}

function startAlertEventStream(path, audience) {
  stopAlertEventStream();
  activeAlertAudience = audience;
  setAlertStreamStatus(
    audience,
    "接続しています…",
    true);
  if (typeof window.EventSource !== "function") {
    markAlertStreamDisconnected(audience, true);
    return;
  }
  const stream = new EventSource(apiUrl(path), {
    withCredentials: true});
  alertEventSource = stream;
  stream.onopen = () => {
    setAlertStreamStatus(audience, "接続中", false);
    stopAlertFallbackPolling();
    void refreshAlertsForAudience(audience);
  };
  stream.addEventListener("alerts", (event) => {
    try {
      const payload = JSON.parse(event.data);
      const alerts = Array.isArray(payload.alerts) ? payload.alerts : [];
      applyAlertsForAudience(alerts, audience);
      setAlertStreamStatus(audience, "接続中", false);
    } catch {
      markAlertStreamDisconnected(audience);
    }
  });
  stream.addEventListener("session-ended", () => {
    handleAlertSessionEnded(audience);
  });
  stream.addEventListener("stream-error", () => {
    markAlertStreamDisconnected(audience);
  });
  stream.onerror = () => {
    markAlertStreamDisconnected(audience);
  };
}

function stopAlertEventStream() {
  if (alertEventSource) {
    alertEventSource.close();
    alertEventSource = null;
  }
  stopAlertFallbackPolling();
  activeAlertAudience = null;
}

function markAlertStreamDisconnected(audience, immediate = false) {
  setAlertStreamStatus(audience, "再接続中", true);
  startAlertFallbackPolling(audience, immediate);
}

function startAlertFallbackPolling(audience, immediate = false) {
  if (activeAlertAudience !== audience) return;
  if (alertFallbackStartTimer || alertFallbackInterval) return;

  alertLongDisconnectTimer = window.setTimeout(() => {
    if (activeAlertAudience === audience) {
      setAlertStreamStatus(
        audience,
        "リアルタイム接続が切れています。自動で再接続しています。",
        true);
    }
  }, ALERT_LONG_DISCONNECT_MS);

  alertFallbackStartTimer = window.setTimeout(() => {
    alertFallbackStartTimer = null;
    if (activeAlertAudience !== audience) return;
    void refreshAlertsForAudience(audience);
    alertFallbackInterval = window.setInterval(() => {
      void refreshAlertsForAudience(audience);
    }, ALERT_FALLBACK_INTERVAL_MS);
  }, immediate ? 0 : ALERT_FALLBACK_DELAY_MS);
}

function stopAlertFallbackPolling() {
  if (alertFallbackStartTimer) {
    window.clearTimeout(alertFallbackStartTimer);
    alertFallbackStartTimer = null;
  }
  if (alertFallbackInterval) {
    window.clearInterval(alertFallbackInterval);
    alertFallbackInterval = null;
  }
  if (alertLongDisconnectTimer) {
    window.clearTimeout(alertLongDisconnectTimer);
    alertLongDisconnectTimer = null;
  }
}

function refreshAlertsForAudience(audience) {
  return audience === "OWNER"
    ? refreshOwnerAlerts()
    : refreshNotificationMemberAlerts();
}

function applyAlertsForAudience(alerts, audience) {
  if (audience === "OWNER") {
    ownerAlerts = alerts;
  } else {
    notificationMemberAlerts = alerts;
  }
  applyAlertUpdate(alerts, audience);
}

function handleAlertSessionEnded(audience) {
  stopAlertEventStream();
  if (audience === "NOTIFICATION_MEMBER") {
    notificationMemberSession = null;
    resetNotificationCenterUiState("NOTIFICATION_MEMBER");
    openNotificationMemberLogin();
    return;
  }
  authenticatedUser = null;
  resetNotificationCenterUiState("OWNER");
  resetOwnerOnboardingClientState();
  openGuestHome();
}

function setAlertStreamStatus(audience, text, reconnecting) {
  const elementId =
    audience === "OWNER"
      ? "ownerAlertStreamStatus"
      : "notificationMemberAlertStreamStatus";
  setText(elementId, text);
  document
    .getElementById(elementId)
    ?.classList.toggle("reconnecting", reconnecting);
}

function applyAlertUpdate(alerts, audience) {
  pruneNotificationSelection(audience);
  renderEmergencyNotifications(
    audience === "OWNER"
      ? "ownerEmergencyNotificationList"
      : "notificationMemberEmergencyNotificationList",
    alerts,
    audience
  );
  renderNotificationBadge();
  const current = currentAlarmAlertContext?.audience === audience
    ? alerts.find((alert) => alert.id === currentAlarmAlertContext.alertId)
    : null;
  if (currentAlarmAlertContext?.audience === audience && !current) {
    closeAlarmNotification();
  }
  const nextAlert = alerts.find(
    (alert) =>
      alert.status === "ACTIVE" &&
      !alert.readAt &&
      !notifiedAlertIds.has(alert.id));
  if (nextAlert) {
    rememberNotifiedAlert(nextAlert.id);
    if (alarmSoundEnabled) {
      showAlarmNotification(nextAlert.matchedKeyword, nextAlert.detectedAt, {
        alertId: nextAlert.id,
        audience,
        kind: nextAlert.kind || "REAL"});
    }
  }
}

function openSetupForAuthenticatedUser() {
  if (!authenticatedUser) {
    openOwnerSetup();
    return;
  }

  if (!currentTeam && ownerOnboarding?.status === "PENDING") {
    openOwnerSetup();
    return;
  }

  setupMode = "signup";

  showOnlyScreen("setupScreen");
  renderKeywordInputs();
  updateSetupScreenText();

  window.scrollTo({
    top: 0
  });
}


function handleSetupBack() {
  if (setupMode === "signup") {
    saveCurrentOwnerKeywordDraft();
    openOwnerSetup();
  } else {
    openApp();
  }

  window.scrollTo({
    top: 0,
    behavior: "smooth"
  });
}


function backToSetup() {
  if (!authenticatedUser) {
    openOwnerSetup();
    return;
  }

  if (setupMode === "signup" && ownerSetupKeywordProvider) {
    openOwnerKeywordSetup(ownerSetupKeywordProvider);
    return;
  }

  showOnlyScreen("setupScreen");
  renderKeywordInputs();
  updateSetupScreenText();

  window.scrollTo({
    top: 0
  });
}


function backFromPayment() {
  if (paymentMode === "renewal") {
    showOnlyScreen("appScreen");
    showAppPage("contractPage");
    return;
  }

  backToSetup();
}


/* ========================================
   キーワード設定
======================================== */

function renderKeywordInputs() {
  const container =
    document.getElementById("keywordInputs");

  if (!container) {
    return;
  }

  container.innerHTML = "";

  keywords.forEach((keyword, index) => {
    const row =
      document.createElement("div");

    row.className =
      "keyword-input-row";

    row.innerHTML = `
      <div class="keyword-number">
        ${index + 1}
      </div>

      <input
        type="text"
        value="${escapeHtml(keyword)}"
        placeholder="例：停電のお知らせ"
        maxlength="${keywordPolicy.KEYWORD_MAX_LENGTH}"
        oninput="changeKeyword(${index}, this.value, this)"
        onblur="normalizeKeywordAt(${index}, this)"
      >

      <button
        type="button"
        class="remove-keyword"
        onclick="removeKeyword(${index})"
        ${keywords.length <= 1 ? "disabled" : ""}
        aria-label="キーワードを削除"
      >
        ×
      </button>
    `;

    container.appendChild(row);
  });

  updatePrice();
  updateSetupScreenText();
}


function addKeyword() {
  if (keywords.length >= 20) {
    showSetupError(
      "登録できるキーワードは最大20個です。"
    );

    return;
  }

  keywords.push("");
  markOwnerKeywordDraftDirty();

  renderKeywordInputs();

  const inputs =
    document.querySelectorAll(
      "#keywordInputs input"
    );

  const lastInput =
    inputs[inputs.length - 1];

  if (lastInput) {
    lastInput.focus();
  }
}


function removeKeyword(index) {
  if (keywords.length <= 1) {
    return;
  }

  keywords.splice(index, 1);
  markOwnerKeywordDraftDirty();

  renderKeywordInputs();
}


function changeKeyword(
  index,
  value,
  inputElement = null
) {
  keywords[index] = value;
  markOwnerKeywordDraftDirty();

  const normalizedValue =
    keywordPolicy.normalizeKeyword(
      value
    );
  const validation =
    keywordPolicy.validateKeyword(
      value
    );
  const errorMessage =
    normalizedValue &&
    !validation.valid
      ? validation.message
      : "";

  if (inputElement) {
    inputElement.setCustomValidity(
      errorMessage
    );
    if (errorMessage) {
      inputElement.setAttribute("aria-invalid", "true");
    } else {
      inputElement.removeAttribute("aria-invalid");
    }
  }

  showSetupError(errorMessage);

  updatePrice();
}


function normalizeKeywordAt(
  index,
  inputElement
) {
  const normalizedValue =
    keywordPolicy.normalizeKeyword(
      keywords[index]
    );

  keywords[index] = normalizedValue;

  if (inputElement) {
    inputElement.value =
      normalizedValue;
  }

  changeKeyword(
    index,
    normalizedValue,
    inputElement
  );
}


function getValidKeywords() {
  return keywords
    .map((keyword) =>
      keywordPolicy.normalizeKeyword(
        keyword
      )
    )
    .filter((keyword) =>
      keyword.length > 0
    );
}


function normalizeKeywords() {
  const validKeywords =
    getValidKeywords();

  keywords =
    validKeywords.length > 0
      ? validKeywords
      : ["停電", "通電", "警報"];
}


function validateKeywords() {
  const validation =
    keywordPolicy.validateKeywordList(
      keywords
    );

  if (!validation.valid) {
    const invalidInput = document.querySelectorAll("#keywordInputs input")[
      validation.index ?? 0
    ];
    const rawValue = keywords[validation.index ?? 0] ?? "";
    const message =
      validation.reasonCode === "KEYWORD_REQUIRED" ||
      (keywords.length === 1 && !rawValue)
        ? "通知キーワードを1件以上入力してください。"
        : rawValue.length > 0 && !rawValue.trim()
          ? "空白だけのキーワードは登録できません。"
          : validation.message;
    showSetupValidationError(message, invalidInput);

    return false;
  }

  showSetupError("");

  return true;
}


function showSetupError(message) {
  setText(
    "setupError",
    message
  );
}

function showSetupValidationError(message, input = null) {
  showSetupError(message);
  if (input) {
    input.setAttribute("aria-invalid", "true");
    input.scrollIntoView({ behavior: "smooth", block: "center" });
    input.focus({ preventScroll: true });
  }
}


function markOwnerKeywordDraftDirty() {
  if (setupMode === "signup" && ownerSetupKeywordProvider) {
    ownerSetupKeywordDirty[ownerSetupKeywordProvider] = true;
    renderOwnerKeywordProviderNavigation();
  }
}


function resetOwnerOnboardingClientState() {
  ownerOnboarding = null;
  ownerSetupKeywordProvider = null;
  ownerSetupSeatCount = 1;
  ownerSetupLocalSkips.clear();
  ["GOOGLE", "MICROSOFT"].forEach((provider) => {
    ownerSetupKeywordDrafts[provider] = null;
    ownerSetupKeywordDirty[provider] = false;
  });
}


/* ========================================
   旧Googleアカウント保存形式の移行
======================================== */

function normalizeLegacyGoogleAccounts(
  accounts
) {
  const uniqueAccounts = [];
  const seenAccounts = new Set();

  accounts.forEach((account) => {
    const email =
      String(account || "")
        .trim();

    const normalizedEmail =
      email.toLowerCase();

    if (
      isValidEmail(email) &&
      !seenAccounts.has(normalizedEmail)
    ) {
      seenAccounts.add(normalizedEmail);
      uniqueAccounts.push(email);
    }
  });

  return uniqueAccounts;
}


function preserveLegacyGoogleAccounts(
  accounts,
  selectedEmail
) {
  const accountsToPreserve =
    normalizeLegacyGoogleAccounts([
      selectedEmail,
      ...accounts
    ]);

  if (accountsToPreserve.length <= 1) {
    return;
  }

  try {
    if (
      localStorage.getItem(
        LEGACY_GOOGLE_ACCOUNTS_BACKUP_KEY
      )
    ) {
      legacyGoogleAccountsFallbackBackup =
        [];
      return;
    }

    localStorage.setItem(
      LEGACY_GOOGLE_ACCOUNTS_BACKUP_KEY,
      JSON.stringify({
        migratedAt:
          new Date().toISOString(),
        selectedGoogleEmail:
          selectedEmail,
        googleAccounts:
          accountsToPreserve
      })
    );

    legacyGoogleAccountsFallbackBackup =
      [];
  } catch (error) {
    legacyGoogleAccountsFallbackBackup =
      accountsToPreserve;

    console.error(
      "旧Googleアカウント情報の退避に失敗しました。",
      error
    );
  }
}


function resolveSavedGoogleEmail(data) {
  const legacyAccountSource =
    Array.isArray(data.googleAccounts)
      ? data.googleAccounts
      : Array.isArray(
            data.legacyGoogleAccountsBackup
          )
        ? data.legacyGoogleAccountsBackup
        : [];

  const legacyAccounts =
    normalizeLegacyGoogleAccounts(
      legacyAccountSource
    );

  const legacyPrimaryEmail =
    typeof data.googleEmail === "string" &&
    isValidEmail(data.googleEmail)
      ? data.googleEmail.trim()
      : "";

  const selectedEmail =
    legacyPrimaryEmail ||
    legacyAccounts[0] ||
    "";

  preserveLegacyGoogleAccounts(
    legacyAccounts,
    selectedEmail
  );

  return selectedEmail;
}


/* ========================================
   料金計算
======================================== */

function updatePrice() {
  const currentKeywordCount =
    getValidKeywords().length;
  const billingKeywords =
    setupMode === "signup"
      ? getOwnerSetupBillingKeywords()
      : getValidKeywords();
  const keywordCount = billingKeywords.length;

  const extraKeywordCount =
    Math.max(
      0,
      keywordCount -
        INCLUDED_KEYWORD_LIMIT
    );

  const extraPrice =
    extraKeywordCount *
    EXTRA_KEYWORD_PRICE;

  const additionalSeatCount =
    setupMode === "signup"
      ? Math.max(ownerSetupSeatCount - 1, 0)
      : Math.max(
          currentTeam?.seats?.additionalSeatLimit ?? 0,
          0
        );
  const seatPrice =
    additionalSeatCount * EXTRA_USER_PRICE;

  totalPrice =
    keywordPolicy.calculateAnnualPriceYen(
      keywordCount
    ) + seatPrice;

  setText(
    "keywordCount",
    `${currentKeywordCount}個`
  );

  setText(
    "extraPrice",
    formatYen(extraPrice)
  );

  setText(
    "ownerSeatPrice",
    formatYen(seatPrice)
  );

  setText(
    "totalPrice",
    formatYen(totalPrice)
  );

  setText(
    "monthlyPrice",
    Math
      .ceil(totalPrice / 12)
      .toLocaleString("ja-JP")
  );
}


function updateOwnerSeatCount() {
  const input = document.getElementById("ownerSeatCount");
  const value = Number(input?.value);
  if (Number.isInteger(value) && value >= 1) {
    ownerSetupSeatCount = value;
    input?.removeAttribute("aria-invalid");
    showSetupError("");
  }
  updatePrice();
}

function validateOwnerSeatCount() {
  const input = document.getElementById("ownerSeatCount");
  const value = Number(input?.value);
  if (!Number.isInteger(value) || value < 1) {
    showSetupValidationError(
      "合計利用人数は1以上の整数で入力してください。",
      input
    );
    return false;
  }
  if (value > 1_000_000) {
    showSetupValidationError(
      "入力できる利用人数の上限を超えています。",
      input
    );
    return false;
  }
  ownerSetupSeatCount = value;
  input?.removeAttribute("aria-invalid");
  return true;
}


function formatYen(price) {
  return `${Number(price).toLocaleString(
    "ja-JP"
  )}円`;
}


/* ========================================
   設定画面
======================================== */

function updateSetupScreenText() {
  const continueButton =
    document.getElementById(
      "setupContinueButton"
    );

  if (!continueButton) {
    return;
  }

  if (setupMode === "edit") {
    document
      .getElementById("setupProgress")
      ?.classList.add("hidden");
    document
      .getElementById("ownerSeatSection")
      ?.classList.add("hidden");
    document
      .getElementById("ownerSeatPriceRow")
      ?.classList.add("hidden");
    setText(
      "setupStepLabel",
      "設定変更"
    );

    setText(
      "setupTitle",
      "通知キーワードを編集"
    );

    setText(
      "setupDescription",
      "登録キーワードを変更できます。監視用Googleアカウントは管理画面から変更できます。"
    );

    continueButton.textContent =
      "変更内容を保存";

    document
      .getElementById("ownerKeywordProviderSection")
      ?.classList.add("hidden");

    return;
  }

  document
    .getElementById("setupProgress")
    ?.classList.remove("hidden");
  document
    .getElementById("ownerSeatSection")
    ?.classList.remove("hidden");
  document
    .getElementById("ownerSeatPriceRow")
    ?.classList.remove("hidden");
  const seatSelect =
    document.getElementById("ownerSeatCount");
  if (seatSelect) {
    seatSelect.value = String(ownerSetupSeatCount);
  }

  setText(
    "setupStepLabel",
    "利用設定"
  );

  setText(
    "setupTitle",
    "通知キーワードを設定"
  );

  setText(
    "setupDescription",
    "この監視アカウントで、メールに含まれていたら通知するキーワードを設定してください。"
  );

  continueButton.textContent =
    "このアカウントのキーワードを決定";
  renderOwnerKeywordProviderNavigation();
}


async function continueFromSetup() {
  if (!authenticatedUser) {
    openOwnerSetup();
    return;
  }

  if (
    setupMode === "signup" &&
    (!ownerOnboarding ||
      ownerOnboarding.status !== "PENDING" ||
      !ownerOnboarding.choices.some(
        (choice) => choice.status === "AUTHORIZED" && choice.email
      ))
  ) {
    openOwnerSetup();
    setText(
      "ownerMonitoringSetupError",
      "Call Nowを利用するには、少なくとも1つの監視アカウントを設定してください。"
    );
    return;
  }

  if (setupMode === "signup" && !validateOwnerSeatCount()) {
    return;
  }

  if (!validateKeywords()) {
    return;
  }

  keywords =
    getValidKeywords();

  updatePrice();

  /*
    契約内容を編集している場合
  */

if (setupMode === "edit") {
  /*
    変更後の年額が、
    現在支払い済みの年額より高い場合
  */
  if (totalPrice > paidAnnualPrice) {
    paymentMode = "upgrade";

    openPayment();
    return;
  }

  /*
    同額・値下げの場合は追加決済なし
  */
  saveData();

  openApp();

  if (totalPrice < paidAnnualPrice) {
    await showAppAlert(
      `契約内容を変更しました。

現在の契約期間中の返金はありません。

次回更新料金は
${formatYen(totalPrice)}
になります。`
    );
  } else {
    await showAppAlert(
      "契約内容の変更を保存しました。"
    );
  }

  return;
}
  const currentChoice = getOwnerAuthorizedChoices().find(
    (choice) => choice.provider === ownerSetupKeywordProvider
  );
  if (!currentChoice) {
    openOwnerSetup();
    return;
  }
  const continueButton = document.getElementById(
    "setupContinueButton"
  );
  if (continueButton) continueButton.disabled = true;
  try {
    const response = await fetch(
      apiUrl(
        `/api/v1/owner-onboarding/choices/${encodeURIComponent(currentChoice.id)}/keywords`
      ),
      {
        method: "POST",
        credentials: "include",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ keywords: [...keywords] })
      }
    );
    const result = await response.json().catch(() => null);
    if (!response.ok || !isOwnerOnboarding(result)) {
      throw new Error(
        result?.error?.message ||
          "キーワードを保存できませんでした。"
      );
    }
    ownerOnboarding = result;
    ownerSetupKeywordDrafts[currentChoice.provider] = [...keywords];
    ownerSetupKeywordDirty[currentChoice.provider] = false;
    const nextChoice = getOwnerAuthorizedChoices().find(
      (choice) => !isOwnerKeywordChoiceDecided(choice)
    );
    if (nextChoice) {
      openOwnerKeywordSetup(nextChoice.provider);
      showSetupError(
        `${nextChoice.provider === "GOOGLE" ? "Google" : "Microsoft"}の通知キーワードを決定してください。`
      );
      return;
    }
  } catch (error) {
    showSetupError(
      error instanceof Error
        ? error.message
        : "キーワードを保存できませんでした。"
    );
    return;
  } finally {
    if (continueButton) continueButton.disabled = false;
  }
  paymentMode = "signup";
  openPayment();
}

/* ========================================
   決済確認画面
======================================== */

function openPayment() {
  if (!authenticatedUser) {
    openOwnerSetup();
    return;
  }

  if (
    paymentMode === "signup" &&
    (!ownerOnboarding ||
      ownerOnboarding.status !== "PENDING" ||
      getOwnerAuthorizedChoices().length === 0)
  ) {
    openOwnerSetup();
    setText(
      "ownerMonitoringSetupError",
      "購入前の設定を確認できませんでした。監視アカウントを設定してください。"
    );
    return;
  }
  if (paymentMode === "signup") {
    const undecided = getOwnerAuthorizedChoices().find(
      (choice) => !isOwnerKeywordChoiceDecided(choice)
    );
    if (undecided) {
      openOwnerKeywordSetup(undecided.provider);
      showSetupError(
        `${undecided.provider === "GOOGLE" ? "Google" : "Microsoft"}の通知キーワードを決定してください。`
      );
      return;
    }
  }
  setText("paymentError", "");

  const renewalMode =
    paymentMode === "renewal";
  const signupMode =
    paymentMode === "signup";

  document
    .getElementById("paymentProgress")
    ?.classList.toggle("hidden", renewalMode);

  setText(
    "paymentStepLabel",
    renewalMode
      ? "契約更新"
      : "購入内容の確認"
  );

  setText(
    "paymentTitle",
    renewalMode
      ? "契約更新の決済内容を確認"
      : "決済内容を確認"
  );

  setText(
    "paymentCompleteButton",
    renewalMode
      ? "決済を完了する"
      : "決済を完了して次へ"
  );

  const paymentKeywordValues =
    signupMode
      ? getOwnerSetupBillingKeywords()
      : [...keywords];

  setText(
    "paymentKeywordCount",
    paymentMode === "upgrade"
      ? `${paymentKeywordValues.length}個（変更後）`
      : `${paymentKeywordValues.length}個`
  );

  const paymentAmount =
    paymentMode === "upgrade"
      ? totalPrice - paidAnnualPrice
      : totalPrice;

  setText(
    "paymentTotal",
    formatYen(paymentAmount)
  );

  setText(
    "paymentSeatCount",
    `${ownerSetupSeatCount}人`
  );
  setText(
    "paymentMailAccountCount",
    `${ownerOnboarding?.choices?.filter(
      (choice) => choice.status === "AUTHORIZED" && choice.email
    ).length ?? 0}件`
  );
  document
    .getElementById("paymentSeatDetail")
    ?.classList.toggle("hidden", !signupMode);
  document
    .getElementById("paymentMailAccountDetail")
    ?.classList.toggle("hidden", !signupMode);

  const container =
    document.getElementById(
      "paymentKeywords"
    );

  if (container) {
    container.innerHTML = "";

    paymentKeywordValues.forEach(
      (keyword) => {
        const chip =
          document.createElement(
            "span"
          );

        chip.className =
          "keyword-chip";

        chip.textContent =
          keyword;

        container.appendChild(
          chip
        );
      }
    );
  }

  showOnlyScreen(
    "paymentScreen"
  );

  window.scrollTo({
    top: 0
  });
}

async function completeDemoPayment() {
  if (!authenticatedUser) {
    setText("paymentError", "ログイン状態を確認できませんでした。初期設定をもう一度お試しください。");
    openOwnerSetup();
    return;
  }

  if (paymentMode === "renewal") {
    extendContractByOneYear();

    paidAnnualPrice =
      totalPrice;

    saveData();

    setText(
      "renewalCompleteEndDate",
      formatDate(contractEndDate)
    );

    setText(
      "renewalCompleteAmount",
      formatYen(totalPrice)
    );

    showOnlyScreen(
      "renewalCompleteScreen"
    );

    window.scrollTo({
      top: 0
    });

    return;
  }

  if (paymentMode === "upgrade") {
    const additionalPrice =
      totalPrice - paidAnnualPrice;

    paidAnnualPrice =
      totalPrice;

    saveData();

    openApp();

    await showAppAlert(
      `契約内容を変更しました。

追加料金：
${formatYen(additionalPrice)}

変更後の年額：
${formatYen(totalPrice)}

現在は試作版のため、
実際の決済は行われません。`
    );

    return;
  }

  if (
    !contractStartDate ||
    !contractEndDate
  ) {
    createContractDates();
  }
  if (
    !ownerOnboarding ||
    ownerOnboarding.status !== "PENDING"
  ) {
    openOwnerSetup();
    setText(
      "paymentError",
      "購入前の設定を確認できませんでした。初期設定をもう一度お試しください。"
    );
    return;
  }

  const button =
    document.getElementById("paymentCompleteButton");
  if (button) button.disabled = true;
  try {
    const response = await fetch(
      apiUrl("/api/v1/owner-onboarding/demo-purchase"),
      {
        method: "POST",
        credentials: "include",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          onboardingId: ownerOnboarding.id,
          seatCount: ownerSetupSeatCount
        })
      }
    );
    const result = await response.json().catch(() => null);
    if (
      !response.ok ||
      !isOwnerOnboarding(result?.onboarding)
    ) {
      throw new Error(
        result?.error?.message ||
          "契約情報を保存できませんでした。"
      );
    }
    ownerOnboarding = result.onboarding;
    keywords = getOwnerSetupBillingKeywords();
    totalPrice = result.amountYen;
    paidAnnualPrice = result.amountYen;
    currentTeam = await fetchCurrentTeamContext();
    if (!currentTeam || !hasActiveSubscription()) {
      throw new Error(
        "契約情報を確認できませんでした。"
      );
    }
    hydrateContractKeywordsFromServer();
    synchronizeContractFromCurrentTeam();
    saveData();
    await refreshNotificationMemberManagement();
    mailProviderAvailability =
      await fetchMailProviderAvailability();
    mailConnections = await fetchMailConnections();
    hydrateContractKeywordsFromServer();
    ownerAlerts = (await fetchOwnerAlerts()) ?? [];
    openApp();
  } catch (error) {
    setText(
      "paymentError",
      error instanceof Error
        ? error.message
        : "契約情報を保存できませんでした。通信状態を確認して、もう一度お試しください。"
    );
  } finally {
    if (button) button.disabled = false;
  }
}


/* ========================================
   Googleアカウント選択
======================================== */

function openGoogleScreen(
  mode = "link"
) {
  if (
    mode === "manage" &&
    !authenticatedUser
  ) {
    openGoogleScreen("login");
    return;
  }

  googleScreenMode = mode;
  const isAuthenticationMode =
    mode !== "manage";

  setText(
    "googleBackButton",
    "← ホームへ戻る"
  );
  document
    .getElementById("googleBackButton")
    ?.classList.toggle(
      "hidden",
      false
    );

  setText(
    "googleBackButton",
    isAuthenticationMode
      ? "← ホームへ戻る"
      : "← ホームへ戻る"
  );

  setText(
    "googleScreenTitle",
    isAuthenticationMode
      ? "Call Nowに登録・ログイン"
      : "監視アカウント設定"
  );

  setText(
    "googleScreenDescription",
    isAuthenticationMode
      ? "利用するアカウントを選んでください。認証後はホームへ進みます。"
      : "重要メールを監視するアカウントを追加・変更できます。"
  );

  setText(
    "googleCardTitle",
    isAuthenticationMode
      ? "登録・ログイン方法を選択"
      : "ログイン方法を追加"
  );

  showOnlyScreen(
    "googleScreen"
  );

  renderGoogleAccountOptions();

  setText(
    "googleError",
    ""
  );

  window.scrollTo({
    top: 0
  });
}


function renderGoogleAccountOptions() {
  const accountList =
    document.getElementById(
      "linkedGoogleAccounts"
    );

  if (!accountList) {
    return;
  }

  const accountCard =
    document.getElementById(
      "linkedGoogleAccountCard"
    );
  const showMailManagement =
    googleScreenMode === "manage";
  const mailAccountCard =
    document.getElementById(
      "mailMonitoringAccountCard"
    );

  if (accountCard) {
    accountCard.classList.add("hidden");
  }

  if (mailAccountCard) {
    mailAccountCard.classList.toggle(
      "hidden",
      !showMailManagement
    );
  }

  updateGoogleAuthActionText();

  accountList.innerHTML = "";

  renderMailMonitoringAccount();
}


function updateGoogleAuthActionText() {
  const authCard =
    document.getElementById(
      "googleAuthCard"
    );

  if (authCard) {
    authCard.classList.toggle(
      "hidden",
      googleScreenMode === "manage"
    );
  }

  if (googleScreenMode !== "manage") {
    setText(
      "googleCardTitle",
      "登録・ログイン方法を選択"
    );

    setText(
      "googleAuthDescription",
      "Google、Microsoft、Appleのいずれかで本人確認してください。メール監視権限はここでは要求しません。"
    );
  } else {
    setText(
      "googleCardTitle",
      "ログイン方法を追加"
    );
    setText(
      "googleAuthDescription",
      "現在のアカウントへ別のログイン方法を追加できます。同じメールアドレスだけを理由にアカウントを統合することはありません。"
    );
  }
  updateLoginProviderButtons();
}


function updateLoginProviderButtons() {
  const providers = ["GOOGLE", "MICROSOFT", "APPLE"];
  const unavailable = [];
  providers.forEach((provider) => {
    const button = document.getElementById(
      `${provider.toLowerCase()}LoginProviderButton`
    );
    if (!button) return;
    const alreadyLinked = loginIdentities.some(
      (identity) => identity.provider === provider
    );
    const available =
      loginProviderAvailability[provider] === "AVAILABLE";
    button.disabled =
      !available ||
      (googleScreenMode === "manage" && alreadyLinked);
    const label = button.querySelector("strong");
    if (label) {
      label.textContent =
        googleScreenMode === "manage" && alreadyLinked
          ? `${loginProviderLabel(provider)}（追加済み）`
          : googleScreenMode === "manage"
            ? `${loginProviderLabel(provider)}を追加`
            : `${loginProviderLabel(provider)}で続ける`;
    }
    if (!available) unavailable.push(loginProviderLabel(provider));
  });
  setText(
    "loginProviderNotice",
    unavailable.length > 0
      ? `${unavailable.join("・")}は現在準備中です。設定完了後に利用できます。`
      : ""
  );
}


function startPrimaryLogin(provider) {
  if (!["GOOGLE", "MICROSOFT", "APPLE"].includes(provider)) return;
  setText("googleError", "");
  if (loginProviderAvailability[provider] !== "AVAILABLE") {
    setText(
      "googleError",
      `${loginProviderLabel(provider)}ログインは現在準備中です。`
    );
    return;
  }
  if (googleScreenMode === "manage") {
    const form = document.createElement("form");
    form.method = "post";
    form.action = apiUrl(
      `/api/v1/auth/identities/${provider.toLowerCase()}/link/start`
    );
    form.hidden = true;
    document.body.appendChild(form);
    form.submit();
    return;
  }
  window.location.assign(
    apiUrl(`/api/v1/auth/${provider.toLowerCase()}/start`)
  );
}


async function unlinkLoginIdentity(provider) {
  if (loginIdentities.length <= 1) return;
  const confirmed = await showAppConfirm(
    `${loginProviderLabel(provider)}ログインの連携を解除しますか？`,
    {
      title: "ログイン方法の解除",
      confirmText: "連携を解除",
      tone: "danger"
    }
  );
  if (!confirmed) return;
  try {
    const response = await fetch(
      apiUrl(
        `/api/v1/auth/identities/${provider.toLowerCase()}`
      ),
      {
        method: "DELETE",
        credentials: "include",
        headers: { Accept: "application/json" }
      }
    );
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(
        result?.error?.code || `identity_unlink_${response.status}`
      );
    }
    loginIdentities = await fetchLoginIdentities();
    renderGoogleAccountOptions();
    renderConnectedGoogleAccounts();
    await showAppAlert(
      `${loginProviderLabel(provider)}ログインの連携を解除しました。`
    );
  } catch (error) {
    console.error("ログイン方法を解除できませんでした。", error);
    await showAppAlert(
      "ログイン方法を解除できませんでした。別のログイン方法が追加されているか確認してください。"
    );
  }
}


function loginProviderLabel(provider) {
  if (provider === "MICROSOFT") return "Microsoft";
  if (provider === "APPLE") return "Apple";
  return "Google";
}


function loginProviderMark(provider) {
  if (provider === "MICROSOFT") return "M";
  if (provider === "APPLE") return "●";
  return "G";
}


function renderMailMonitoringAccount() {
  const status =
    document.getElementById(
      "mailMonitoringAccountStatus"
    );
  const providerChoices =
    document.getElementById(
      "mailProviderChoices"
    );
  const googleProviderButton =
    document.getElementById(
      "googleMailProviderButton"
    );
  const microsoftProviderButton =
    document.getElementById(
      "microsoftMailProviderButton"
    );
  if (
    !status ||
    !providerChoices ||
    !googleProviderButton ||
    !microsoftProviderButton
  ) {
    return;
  }

  providerChoices.classList.remove("hidden");
  providerChoices
    .querySelectorAll("button")
    .forEach((button) => {
      button.disabled = false;
    });

  if (!currentTeam) {
    status.innerHTML = `
      <p class="connected-account-empty">
        メール監視を利用するには、先に契約とキーワード設定を完了してください。
      </p>
    `;
    providerChoices.classList.remove("hidden");
    providerChoices
      .querySelectorAll("button")
      .forEach((button) => {
        button.disabled = true;
      });
    return;
  }

  if (currentTeam.role !== "OWNER") {
    status.innerHTML = `
      <p class="connected-account-empty">
        メール監視アカウントの変更は管理者のみ行えます。
      </p>
    `;
    providerChoices.classList.remove("hidden");
    providerChoices
      .querySelectorAll("button")
      .forEach((button) => {
        button.disabled = true;
      });
    return;
  }

  googleProviderButton.disabled =
    mailProviderAvailability.GOOGLE !==
      "AVAILABLE";
  microsoftProviderButton.disabled =
    mailProviderAvailability.MICROSOFT !==
      "AVAILABLE";

  if (mailConnections.length === 0) {
    const deferredChoices =
      ownerOnboarding?.choices?.filter(
        (choice) =>
          choice.status === "DEFERRED" && choice.email
      ) ?? [];
    status.innerHTML = `
      <p class="connected-account-empty">
        ${deferredChoices.length > 0
          ? "監視開始を保留しているアカウントがあります。"
          : "メール監視アカウントは接続されていません。"}
      </p>
      ${deferredChoices.map(renderDeferredMailChoice).join("")}
      ${mailProviderAvailabilityNotice()}
    `;
    return;
  }

  status.innerHTML = `
    <p class="connected-account-summary">
      ${mailConnections.length}件接続中
    </p>
    <div class="mail-connection-list">
      ${mailConnections.map(renderMailConnectionItem).join("")}
      ${(ownerOnboarding?.choices ?? [])
        .filter(
          (choice) =>
            choice.status === "DEFERRED" && choice.email
        )
        .map(renderDeferredMailChoice)
        .join("")}
    </div>
    ${mailProviderAvailabilityNotice()}
  `;
}


function renderMailConnectionItem(connection) {
  const requiresReauthorization =
    connection.connectionStatus ===
      "REAUTH_REQUIRED" ||
    connection.authorizationStatus ===
      "REAUTH_REQUIRED" ||
    connection.connectionStatus === "ERROR" ||
    connection.authorizationStatus === "ERROR";
  const reauthorizeDisabled =
    mailProviderAvailability[
      connection.provider
    ] !== "AVAILABLE";
  const isPaused =
    connection.connectionStatus === "PAUSED";
  return `
    <article class="mail-connection-item">
      <div>
        <p class="connected-account-provider">
          ${mailProviderLabel(connection.provider)}
        </p>
        <p class="connected-account-email">
          ${escapeHtml(connection.email)}
        </p>
        <p class="connected-account-empty">
          ${requiresReauthorization
            ? "再認証が必要です"
            : isPaused
              ? "監視停止中"
              : "監視接続中"}
        </p>
      </div>
      <div class="mail-account-actions">
        ${requiresReauthorization ? `
          <button
            type="button"
            class="btn outline"
            ${reauthorizeDisabled ? "disabled" : ""}
            onclick="reauthorizeMailConnection('${connection.id}', '${connection.provider}')"
          >再認証</button>
        ` : ""}
        ${!requiresReauthorization ? `
          <button
            type="button"
            class="btn outline"
            onclick="setMailMonitoringState('${connection.id}', '${isPaused ? "resume" : "pause"}')"
          >${isPaused ? "監視を開始" : "監視を停止"}</button>
        ` : ""}
        <button
          type="button"
          class="account-remove-button"
          onclick="disconnectMailConnection('${connection.id}')"
        >接続を解除</button>
      </div>
    </article>
  `;
}


function renderDeferredMailChoice(choice) {
  return `
    <article class="mail-connection-item deferred">
      <div>
        <p class="connected-account-provider">
          ${escapeHtml(mailProviderLabel(choice.provider))}
        </p>
        <p class="connected-account-email">
          ${escapeHtml(choice.email)}
        </p>
        <p class="connected-account-empty">監視開始を保留中</p>
      </div>
      <div class="mail-account-actions">
        <button
          type="button"
          class="btn outline"
          onclick="activateDeferredOwnerMonitoring('${choice.id}')"
        >監視を開始</button>
      </div>
    </article>
  `;
}


async function updateOwnerMonitoringChoice(choiceId, action) {
  if (!ownerOnboarding || action !== "activate") return null;
  try {
    const response = await fetch(
      apiUrl(
        `/api/v1/owner-onboarding/choices/${encodeURIComponent(choiceId)}/${action}`
      ),
      {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json" }
      }
    );
    const result = await response.json().catch(() => null);
    if (!response.ok || !isOwnerOnboarding(result)) {
      throw new Error(
        result?.error?.message ||
          "監視を開始できませんでした。"
      );
    }
    ownerOnboarding = result;
    return result;
  } catch (error) {
    await showAppAlert(
      error instanceof Error
        ? error.message
        : "監視を開始できませんでした。",
      { title: "監視設定のエラー" }
    );
    return null;
  }
}


async function activateDeferredOwnerMonitoring(choiceId) {
  await updateOwnerMonitoringChoice(choiceId, "activate");
  mailConnections = await fetchMailConnections();
  renderMailMonitoringAccount();
  renderConnectedGoogleAccounts();
}


async function setMailMonitoringState(connectionId, action) {
  if (
    currentTeam?.role !== "OWNER" ||
    !["pause", "resume"].includes(action)
  ) {
    return;
  }
  try {
    const response = await fetch(
      apiUrl(
        `/api/v1/teams/${encodeURIComponent(currentTeam.id)}/mail-connections/${encodeURIComponent(connectionId)}/${action}`
      ),
      {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json" }
      }
    );
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(
        result?.error?.message ||
          "監視状態を変更できませんでした。"
      );
    }
    mailConnections = await fetchMailConnections();
    renderMailMonitoringAccount();
    renderConnectedGoogleAccounts();
  } catch (error) {
    await showAppAlert(
      error instanceof Error
        ? error.message
        : "監視状態を変更できませんでした。",
      { title: "監視設定のエラー" }
    );
  }
}


function mailProviderAvailabilityNotice() {
  const unavailable = [
    ["GOOGLE", "Gmail"],
    ["MICROSOFT", "Microsoft 365"]
  ]
    .filter(
      ([provider]) =>
        mailProviderAvailability[provider] !==
        "AVAILABLE"
    )
    .map(([, label]) => label);
  if (unavailable.length === 0) {
    return "";
  }
  return `
    <p class="connected-account-empty">
      ${unavailable.join("・")}接続は現在準備中です。しばらくしてからもう一度お試しください。
    </p>
  `;
}


function showMailProviderChoices() {
  document
    .getElementById("mailProviderChoices")
    ?.classList.toggle("hidden");
}


async function startMailConnection(provider) {
  if (provider !== "GOOGLE" &&
      provider !== "MICROSOFT") {
    return;
  }

  await beginMailOAuth("oauth/start", provider, null);
}


async function reauthorizeMailConnection(
  connectionId,
  provider
) {
  await beginMailOAuth(
    "reauthorize",
    provider,
    connectionId
  );
}


async function beginMailOAuth(
  action,
  provider,
  connectionId
) {
  if (!authenticatedUser) {
    await showAppAlert(
      "先にCall Nowへログインしてください。"
    );
    return;
  }

  if (currentTeam?.role !== "OWNER") {
    await showAppAlert(
      currentTeam
        ? "メール監視アカウントの変更は管理者のみ行えます。"
        : "メール監視を利用するには、先に契約とキーワード設定を完了してください。"
    );
    return;
  }

  if (
    mailProviderAvailability[provider] !==
    "AVAILABLE"
  ) {
    await showAppAlert(
      `${mailProviderLabel(provider)}接続を開始できませんでした。現在サービス設定を確認しています。`
    );
    return;
  }

  const form = document.createElement("form");
  form.method = "post";
  const path = connectionId
    ? `/api/v1/teams/${encodeURIComponent(currentTeam.id)}/mail-connections/${encodeURIComponent(connectionId)}/${action}`
    : `/api/v1/teams/${encodeURIComponent(currentTeam.id)}/mail-connection/${action}`;
  form.action = apiUrl(
    `${path}?provider=${encodeURIComponent(provider)}`
  );
  form.hidden = true;
  document.body.appendChild(form);
  form.submit();
}


async function disconnectMailConnection(
  connectionId
) {
  if (currentTeam?.role !== "OWNER" ||
      !mailConnections.some(
        (connection) =>
          connection.id === connectionId
      )) {
    return;
  }

  const confirmed = await showAppConfirm(
    "メール監視アカウントの接続を解除しますか？解除後はメール監視が停止します。",
    {
      title: "メール監視の解除",
      confirmText: "接続を解除",
      tone: "danger"
    }
  );

  if (!confirmed) {
    return;
  }

  try {
    const response = await fetch(
      apiUrl(
        `/api/v1/teams/${encodeURIComponent(currentTeam.id)}/mail-connections/${encodeURIComponent(connectionId)}`
      ),
      {
        method: "DELETE",
        credentials: "include",
        headers: {
          Accept: "application/json"
        }
      }
    );

    if (!response.ok) {
      throw new Error(
        `mail_disconnect_${response.status}`
      );
    }

    mailConnections =
      await fetchMailConnections();
    renderMailMonitoringAccount();
    renderConnectedGoogleAccounts();
    await showAppAlert(
      "メール監視アカウントの接続を解除しました。"
    );
  } catch (error) {
    console.error(
      "メール監視アカウントを解除できませんでした。",
      error
    );
    await showAppAlert(
      "メール監視アカウントを解除できませんでした。通信状態を確認して、もう一度お試しください。"
    );
  }
}


function mailProviderLabel(provider) {
  return provider === "MICROSOFT"
    ? "Microsoft 365 / Outlook"
    : "Gmail / Google Workspace";
}


function backFromGoogle() {
  if (googleScreenMode === "manage") {
    openApp();
  } else {
    openGuestHome();
  }
}


function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
    value
  );
}


/* ========================================
   契約情報
======================================== */

function createContractDates() {
  contractStartDate =
    new Date();

  contractStartDate.setHours(
    0,
    0,
    0,
    0
  );

  contractEndDate =
    new Date(contractStartDate);

  contractEndDate.setFullYear(
    contractEndDate.getFullYear() +
      1
  );

  contractEndDate.setDate(
    contractEndDate.getDate() -
      1
  );
}


function renderContractInformation() {
  if (!hasActiveSubscription()) {
    setText("contractStartDate", "未契約");
    setText("contractEndDate", "―");
    setText("remainingDays", "―");
    setText("contractKeywordCount", `${keywords.length}個`);
    setText("contractPrice", formatYen(totalPrice));
    updateContractStatusUI();
    renderNotificationMemberManagement();
    return;
  }

  const remainingDays =
    calculateRemainingDays();

  const expired =
    isContractExpired();

  setText(
    "contractStartDate",
    formatDate(contractStartDate)
  );

  setText(
    "contractEndDate",
    formatDate(contractEndDate)
  );

  setText(
    "remainingDays",
    expired
      ? "契約期限切れ"
      : remainingDays === 0
        ? "本日まで"
        : `あと${remainingDays}日`
  );

  setText(
    "contractKeywordCount",
    `${keywords.length}個`
  );

  setText(
    "contractPrice",
    formatYen(totalPrice)
  );

  updateContractStatusUI();
  renderNotificationMemberManagement();
}


function renderContractSettings() {
  const container =
    document.getElementById(
      "contractSettingsProviders"
    );
  const seatInput =
    document.getElementById(
      "contractSeatCount"
    );
  const saveButton =
    document.getElementById(
      "saveContractSettingsButton"
    );
  if (
    !container ||
    !seatInput ||
    !saveButton
  )
    return;

  container.replaceChildren();
  pendingContractChange = null;
  const canManage =
    currentTeam?.role === "OWNER" &&
    hasActiveSubscription();
  if (mailConnections.length === 0) {
    const empty =
      document.createElement("p");
    empty.className =
      "contract-provider-empty";
    empty.textContent =
      "監視アカウントが設定されていません。監視アカウントを追加してください。";
    container.appendChild(empty);
  }

  mailConnections.forEach(
    (connection) => {
      const card =
        document.createElement(
          "section"
        );
      card.className =
        "contract-provider-card";
      card.dataset.contractConnectionId =
        connection.id;

      const heading =
        document.createElement("div");
      heading.className =
        "contract-provider-heading";
      const title =
        document.createElement("div");
      const providerName =
        document.createElement("h3");
      providerName.textContent =
        mailProviderLabel(
          connection.provider
        );
      const email =
        document.createElement("p");
      email.textContent =
        connection.email;
      title.append(providerName, email);
      const status =
        document.createElement("span");
      status.className =
        "contract-provider-status";
      status.textContent =
        connection.connectionStatus ===
        "ACTIVE"
          ? "監視中"
          : connection.connectionStatus ===
              "PAUSED"
            ? "停止中"
            : "再設定が必要";
      heading.append(title, status);

      const label =
        document.createElement("h4");
      label.textContent =
        "通知キーワード";
      const inputs =
        document.createElement("div");
      inputs.className =
        "contract-keyword-inputs";
      const values =
        connection.keywords.length > 0
          ? connection.keywords
          : [""];
      values.forEach((keyword) => {
        inputs.appendChild(
          createContractKeywordRow(
            connection.id,
            keyword,
            canManage
          )
        );
      });
      card.append(
        heading,
        label,
        inputs
      );

      const providerError = document.createElement("p");
      providerError.className = "field-error contract-provider-error";
      providerError.dataset.contractProviderError = connection.id;
      providerError.setAttribute("aria-live", "polite");
      card.appendChild(providerError);

      const addButton =
        document.createElement(
          "button"
        );
      addButton.type = "button";
      addButton.className =
        "btn outline contract-keyword-add";
      addButton.textContent =
        "キーワードを追加";
      addButton.disabled = !canManage;
      addButton.addEventListener(
        "click",
        () => {
          addContractKeyword(
            connection.id
          );
        }
      );
      card.appendChild(addButton);
      container.appendChild(card);
    }
  );

  seatInput.value = String(
    currentTeam?.seats?.seatCount ?? 1
  );
  seatInput.disabled = !canManage;
  saveButton.disabled =
    !canManage;
  setText(
    "contractSeatHelp",
    `現在の利用人数は${1 + (currentTeam?.seats?.activeMemberCount ?? 0)}人です。これより少ない人数には変更できません。`
  );
  setText(
    "contractCurrentAnnualPrice",
    formatYen(
      currentTeam?.subscription
        ?.currentTermAmountYen ?? 0
    )
  );
  setText("contractSeatError", "");
  setText("contractSettingsError", "");
  if (!canManage) {
    setText(
      "contractSettingsError",
      currentTeam?.role === "OWNER"
        ? "現在の契約状態では変更できません。"
        : "契約内容の変更は管理者のみ行えます。"
    );
  }
  updateContractSettingsPreview();
}

function createContractKeywordRow(
  connectionId,
  keyword,
  enabled
) {
  const row =
    document.createElement("div");
  row.className =
    "contract-keyword-row";
  const input =
    document.createElement("input");
  input.type = "text";
  input.maxLength = 100;
  input.value = keyword;
  input.placeholder =
    "例：停電のお知らせ";
  input.disabled = !enabled;
  input.setAttribute(
    "aria-label",
    "通知キーワード"
  );
  input.addEventListener(
    "input",
    () => {
      clearContractInputError(input);
      updateContractSettingsPreview();
    }
  );
  const remove =
    document.createElement("button");
  remove.type = "button";
  remove.className =
    "contract-keyword-remove";
  remove.textContent = "削除";
  remove.disabled = !enabled;
  remove.addEventListener(
    "click",
    () => {
      row.remove();
      const card =
        document.querySelector(
          `[data-contract-connection-id="${connectionId}"]`
        );
      if (
        card &&
        card.querySelectorAll(
          ".contract-keyword-row"
        ).length === 0
      ) {
        card
          .querySelector(
            ".contract-keyword-inputs"
          )
          ?.appendChild(
            createContractKeywordRow(
              connectionId,
              "",
              enabled
            )
          );
      }
      updateContractSettingsPreview();
    }
  );
  row.append(input, remove);
  return row;
}

function addContractKeyword(
  connectionId
) {
  const card = document.querySelector(
    `[data-contract-connection-id="${connectionId}"]`
  );
  const inputs = card?.querySelector(
    ".contract-keyword-inputs"
  );
  if (!inputs) return;
  const row = createContractKeywordRow(
    connectionId,
    "",
    true
  );
  inputs.appendChild(row);
  row.querySelector("input")?.focus();
  updateContractSettingsPreview();
}

function readContractSettingsForm(
  showError = false
) {
  const seatInput = document.getElementById("contractSeatCount");
  const seatCount = Number(seatInput?.value);
  const minimumSeatCount =
    1 +
    (currentTeam?.seats
      ?.activeMemberCount ?? 0);
  if (!Number.isInteger(seatCount) || seatCount < 1) {
    if (showError)
      showContractValidationError(
        "合計利用人数は1以上の整数で入力してください。",
        seatInput,
        "contractSeatError"
      );
    return null;
  }
  if (seatCount < minimumSeatCount) {
    if (showError)
      showContractValidationError(
        `現在${minimumSeatCount}人が利用中のため、${minimumSeatCount}人未満には変更できません。`,
        seatInput,
        "contractSeatError"
      );
    return null;
  }
  if (seatCount > 1_000_000) {
    if (showError)
      showContractValidationError(
        "入力できる利用人数の上限を超えています。",
        seatInput,
        "contractSeatError"
      );
    return null;
  }

  const connections = [];
  for (const card of document.querySelectorAll(
    "[data-contract-connection-id]"
  )) {
    const connectionId =
      card.dataset.contractConnectionId;
    const inputs = [
      ...card.querySelectorAll(
        ".contract-keyword-row input"
      )
    ];
    const values = inputs.map((input) => input.value);
    const normalizedValues = values.map((value) =>
      keywordPolicy.normalizeKeyword(value)
    );
    if (normalizedValues.every((value) => !value)) {
      if (showError) {
        const firstInput = inputs[0] ?? card;
        showContractValidationError(
          "各監視アカウントに通知キーワードを1件以上設定してください。",
          firstInput,
          null,
          card
        );
      }
      return null;
    }
    const validation =
      keywordPolicy.validateKeywordList(
        values
      );
    if (
      !connectionId ||
      !validation.valid ||
      validation.keywords.length === 0
    ) {
      if (showError) {
        const invalidInput =
          inputs[validation.index ?? 0] ?? inputs[0] ?? card;
        const rawValue = values[validation.index ?? 0] ?? "";
        showContractValidationError(
          rawValue.length > 0 && !rawValue.trim()
            ? "空白だけのキーワードは登録できません。"
            : validation.message ||
                "各監視アカウントに通知キーワードを1件以上設定してください。",
          invalidInput,
          null,
          card
        );
      }
      return null;
    }
    connections.push({
      connectionId,
      keywords: validation.keywords
    });
  }
  if (connections.length === 0) {
    if (showError) {
      showContractValidationError(
        "監視アカウントを1件以上設定してください。",
        document.getElementById("contractSettingsProviders")
      );
    }
    return null;
  }
  const billingKeywords =
    mergeContractBillingKeywords(
      connections.map(
        (connection) =>
          connection.keywords
      )
    );
  return {
    seatCount,
    connections,
    billingKeywords
  };
}

function mergeContractBillingKeywords(
  keywordSets
) {
  const merged = [];
  const normalized = new Set();
  keywordSets
    .flat()
    .forEach((keyword) => {
      const key = keyword
        .normalize("NFKC")
        .toLocaleLowerCase("ja-JP");
      if (normalized.has(key)) return;
      normalized.add(key);
      merged.push(keyword);
    });
  return merged;
}

function calculateContractSettingsPrice(
  settings
) {
  return (
    keywordPolicy.calculateAnnualPriceYen(
      settings.billingKeywords.length
    ) +
    Math.max(
      settings.seatCount - 1,
      0
    ) *
      EXTRA_USER_PRICE
  );
}

function updateContractSettingsPreview() {
  const settings =
    readContractSettingsForm(false);
  setText(
    "contractNextAnnualPrice",
    settings
      ? formatYen(
          calculateContractSettingsPrice(
            settings
          )
        )
      : "―"
  );
  const button = document.getElementById("saveContractSettingsButton");
  if (button && currentTeam?.role === "OWNER") {
    const currentPrice =
      currentTeam?.subscription?.currentTermAmountYen ?? 0;
    const nextPrice = settings
      ? calculateContractSettingsPrice(settings)
      : null;
    button.textContent =
      nextPrice !== null && nextPrice > currentPrice
        ? "決済内容を確認"
        : "契約内容を保存";
  }
}

async function saveContractSettings() {
  if (currentTeam?.role !== "OWNER") {
    setText(
      "contractSettingsError",
      "契約内容の変更は管理者のみ行えます。"
    );
    return;
  }
  setText("contractSettingsError", "");
  const settings =
    readContractSettingsForm(true);
  if (!settings) return;
  if (!contractSettingsHaveChanges(settings)) {
    showContractValidationError("変更内容がありません。", document.getElementById("saveContractSettingsButton"));
    return;
  }
  const button =
    document.getElementById(
      "saveContractSettingsButton"
    );
  if (button) button.disabled = true;
  try {
    button.textContent = "料金を確認中…";
    const response = await fetch(
      apiUrl(
        `/api/v1/teams/${encodeURIComponent(currentTeam.id)}/contract-settings/quote`
      ),
      {
        method: "POST",
        credentials: "include",
        headers: {
          Accept: "application/json",
          "Content-Type":
            "application/json"
        },
        body: JSON.stringify({
          seatCount: settings.seatCount,
          connections:
            settings.connections,
          idempotencyKey: createClientRequestId()
        })
      }
    );
    const payload = await response
      .json()
      .catch(() => null);
    if (!response.ok) {
      throw new Error(
        payload?.error?.message ||
          "契約内容を保存できませんでした。"
      );
    }
    const quote = parseContractChangeQuote(payload?.quote);
    if (!quote) {
      throw new Error(
        "変更後の料金を計算できませんでした。入力内容を確認してください。"
      );
    }
    pendingContractChange = {
      quote,
      applyIdempotencyKey: createClientRequestId()
    };
    if (quote.additionalChargeYen > 0) {
      openContractChangeCheckout();
      return;
    }
    const isDowngrade =
      quote.nextAnnualAmountYen < quote.previousAnnualAmountYen;
    const confirmed = await showAppConfirm(
      isDowngrade
        ? `現在の契約期間中の返金はありません。次回更新時から年額${formatYen(quote.nextAnnualAmountYen)}になります。保存しますか？`
        : "追加料金はありません。契約内容を保存しますか？",
      {
        title: "契約内容を変更する",
        confirmText: "保存する",
        tone: "warning"
      }
    );
    if (!confirmed) {
      pendingContractChange = null;
      return;
    }
    await applyPendingContractChange();
  } catch (error) {
    setText(
      "contractSettingsError",
      error instanceof Error
        ? error.message
        : "契約内容を保存できませんでした。通信状態を確認して、もう一度お試しください。"
    );
  } finally {
    if (button) {
      button.disabled = false;
      updateContractSettingsPreview();
    }
  }
}

function contractSettingsHaveChanges(settings) {
  if (!currentTeam || settings.seatCount !== currentTeam.seats.seatCount) {
    return true;
  }
  const currentById = new Map(
    mailConnections.map((connection) => [
      connection.id,
      (connection.keywords ?? []).map((keyword) =>
        keywordPolicy.comparisonKey(keyword)
      ).sort()
    ])
  );
  if (currentById.size !== settings.connections.length) return true;
  return settings.connections.some((connection) => {
    const current = currentById.get(connection.connectionId);
    const next = connection.keywords
      .map((keyword) => keywordPolicy.comparisonKey(keyword))
      .sort();
    return !current || JSON.stringify(current) !== JSON.stringify(next);
  });
}

function parseContractChangeQuote(value) {
  if (
    !value ||
    typeof value.id !== "string" ||
    !["PENDING", "APPLIED"].includes(value.status) ||
    !Number.isInteger(value.previousAnnualAmountYen) ||
    !Number.isInteger(value.nextAnnualAmountYen) ||
    !Number.isInteger(value.additionalChargeYen) ||
    !Number.isInteger(value.seatCount) ||
    !Number.isInteger(value.keywordCount) ||
    !Number.isInteger(value.mailConnectionCount)
  ) return null;
  return value;
}

function openContractChangeCheckout() {
  const quote = pendingContractChange?.quote;
  if (!quote || quote.additionalChargeYen <= 0) {
    showContractValidationError(
      "追加料金を確認できませんでした。",
      document.getElementById("saveContractSettingsButton")
    );
    return;
  }
  setText("contractCheckoutCurrentAnnual", formatYen(quote.previousAnnualAmountYen));
  setText("contractCheckoutNextAnnual", formatYen(quote.nextAnnualAmountYen));
  setText("contractCheckoutAdditionalCharge", formatYen(quote.additionalChargeYen));
  setText("contractCheckoutSeatCount", `${quote.seatCount}人`);
  setText("contractCheckoutKeywordCount", `${quote.keywordCount}個`);
  setText("contractCheckoutMailConnectionCount", `${quote.mailConnectionCount}件`);
  setText("contractCheckoutError", "");
  showOnlyScreen("contractChangeCheckoutScreen");
  window.scrollTo({ top: 0 });
}

function backFromContractChangeCheckout() {
  pendingContractChange = null;
  showOnlyScreen("appScreen");
  showAppPage("keywordPage");
}

async function applyPendingContractChange() {
  const pending = pendingContractChange;
  if (!pending || !currentTeam) {
    setText(
      "contractCheckoutError",
      "契約変更の内容を確認できませんでした。戻ってもう一度確認してください。"
    );
    return;
  }
  const checkoutVisible = !document
    .getElementById("contractChangeCheckoutScreen")
    ?.classList.contains("hidden");
  const button = document.getElementById(
    checkoutVisible ? "applyContractChangeButton" : "saveContractSettingsButton"
  );
  const originalText = button?.textContent ?? "";
  if (button) {
    button.disabled = true;
    button.textContent = "変更を適用中…";
  }
  const errorId = checkoutVisible
    ? "contractCheckoutError"
    : "contractSettingsError";
  setText(errorId, "");
  try {
    const quote = pending.quote;
    const response = await fetch(
      apiUrl(
        `/api/v1/teams/${encodeURIComponent(currentTeam.id)}/contract-settings/quotes/${encodeURIComponent(quote.id)}/apply`
      ),
      {
        method: "POST",
        credentials: "include",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          idempotencyKey: pending.applyIdempotencyKey,
          expectedPreviousAnnualAmountYen: quote.previousAnnualAmountYen,
          expectedNextAnnualAmountYen: quote.nextAnnualAmountYen,
          expectedAdditionalChargeYen: quote.additionalChargeYen
        })
      }
    );
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const staleMessage = response.status === 409
        ? "契約情報が更新されました。内容と料金をもう一度確認してください。"
        : payload?.error?.message ||
          "契約内容を保存できませんでした。通信状態を確認して、もう一度お試しください。";
      throw new Error(staleMessage);
    }
    const updatedTeam = parseTeamContext(payload?.team);
    if (!updatedTeam) throw new Error("契約内容を確認できませんでした。再読み込みしてもう一度お試しください。");
    const appliedQuote = pending.quote;
    currentTeam = updatedTeam;
    pendingContractChange = null;
    mailConnections = await fetchMailConnections();
    hydrateContractKeywordsFromServer();
    synchronizeContractFromCurrentTeam();
    renderTestKeywordCards();
    renderContractInformation();
    await refreshNotificationMemberManagement();
    showOnlyScreen("appScreen");
    showAppPage("keywordPage");
    renderContractSettings();
    if (appliedQuote.nextAnnualAmountYen < appliedQuote.previousAnnualAmountYen) {
      await showAppAlert(
        `契約内容を保存しました。\n\n現在の契約期間中の返金はありません。\n次回更新時から年額${formatYen(appliedQuote.nextAnnualAmountYen)}になります。`
      );
    } else {
      await showAppAlert("契約内容を保存しました。");
    }
  } catch (error) {
    setText(
      errorId,
      error instanceof Error
        ? error.message
        : "契約内容または料金が変更されています。戻ってもう一度確認してください。"
    );
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

function showContractValidationError(message, target, errorId = null, card = null) {
  setText("contractSettingsError", message);
  if (errorId) setText(errorId, message);
  const providerError = card?.querySelector("[data-contract-provider-error]");
  if (providerError) providerError.textContent = message;
  if (target?.matches?.("input, textarea, select")) {
    target.setAttribute("aria-invalid", "true");
  }
  target?.scrollIntoView?.({ behavior: "smooth", block: "center" });
  target?.focus?.({ preventScroll: true });
}

function clearContractInputError(input) {
  input?.removeAttribute?.("aria-invalid");
  setText("contractSettingsError", "");
  setText("contractSeatError", "");
  const card = input?.closest?.("[data-contract-connection-id]");
  const providerError = card?.querySelector("[data-contract-provider-error]");
  if (providerError) providerError.textContent = "";
}

function createClientRequestId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  return `request-${Date.now()}-${Math.random().toString(36).slice(2, 14)}`;
}

function renderNotificationMemberManagement() {
  const card = document.getElementById(
    "notificationMemberManagementCard"
  );
  const summary = document.getElementById(
    "notificationMemberSeatSummary"
  );
  const list = document.getElementById(
    "notificationMemberList"
  );
  const createButton = document.getElementById(
    "createNotificationMemberButton"
  );
  const openCreateButton = document.getElementById(
    "openNotificationMemberCreateButton"
  );
  const createPanel = document.getElementById(
    "notificationMemberCreatePanel"
  );
  const capacityMessage = document.getElementById(
    "notificationMemberCapacityMessage"
  );
  if (
    !card ||
    !summary ||
    !list ||
    !createButton ||
    !openCreateButton ||
    !createPanel ||
    !capacityMessage
  ) return;
  const canManage =
    currentTeam?.role === "OWNER" &&
    hasActiveSubscription();
  card.classList.toggle("hidden", !canManage);
  if (!canManage) {
    closeNotificationMemberCreateForm();
    closeNotificationMemberLoginInfo();
    closeNotificationMemberCredential();
    return;
  }

  const seats = notificationMemberManagement?.seats;
  const members = notificationMemberManagement?.members ?? [];
  if (!seats) {
    summary.textContent =
      notificationMemberManagementLoadState === "error"
        ? "参加者情報を読み込めませんでした。契約画面を開き直してください。"
        : "参加者情報を読み込んでいます。";
    list.replaceChildren();
    createButton.disabled = true;
    openCreateButton.disabled = true;
    capacityMessage.textContent = "";
    setText(
      "notificationMemberActionError",
      notificationMemberManagementLoadState === "error"
        ? "参加者情報を読み込めませんでした。再読み込みしてください。"
        : ""
    );
    return;
  }
  setText("notificationMemberActionError", "");
  summary.innerHTML = `
    <div class="member-seat-item">
      <span>利用人数</span>
      <strong>${1 + seats.occupiedAdditionalSeats}/${seats.seatCount}人</strong>
    </div>
    <div class="member-seat-item">
      <span>参加者</span>
      <strong>${seats.activeNotificationMemberCount}人</strong>
    </div>
    <div class="member-seat-item">
      <span>追加可能</span>
      <strong>${seats.availableSeats}人</strong>
    </div>
  `;
  if (seats.pendingSeatCount !== null) {
    summary.insertAdjacentHTML(
      "beforeend",
      `<p class="error-message">${seats.pendingSeatCount}人への変更は、利用人数が上限以下になるまで保留中です。</p>`
    );
  }
  const cannotAdd =
    seats.availableSeats <= 0 ||
    seats.pendingSeatCount !== null;
  createButton.disabled = cannotAdd;
  openCreateButton.disabled = cannotAdd;
  capacityMessage.textContent =
    seats.availableSeats <= 0
      ? "現在の利用人数上限に達しています。"
      : seats.pendingSeatCount !== null
        ? "利用人数の変更が完了するまで参加者を追加できません。"
        : "";
  if (cannotAdd) {
    closeNotificationMemberCreateForm();
  }
  list.replaceChildren();
  if (members.length === 0) {
    closeNotificationMemberLoginInfo();
    const empty = document.createElement("p");
    empty.className = "input-help";
    empty.textContent = "参加者はまだ登録されていません。";
    list.appendChild(empty);
    return;
  }
  if (notificationMemberLoginInfo) {
    const selectedMember = members.find(
      (member) =>
        member.id === notificationMemberLoginInfo.id &&
        member.status === "ACTIVE"
    );
    if (selectedMember) {
      renderNotificationMemberLoginInfo(selectedMember);
    } else {
      closeNotificationMemberLoginInfo();
    }
  }
  members.forEach((member) => {
    const item = document.createElement("div");
    item.className = "notification-member-item";
    const active = member.status === "ACTIVE";
    item.innerHTML = `
      <div>
        <strong>${escapeHtml(member.displayName || "参加者")}</strong>
        <div class="notification-member-id">${escapeHtml(member.callNowId)}</div>
        <small>${active ? "有効" : "無効"}</small>
      </div>
      <div class="notification-member-actions">
        ${active ? `
          <button type="button" class="btn outline" onclick="openNotificationMemberLoginInfo('${member.id}')">
            ログイン情報を確認
          </button>
          <button type="button" class="btn outline" onclick="disableNotificationMember('${member.id}')">
            無効にする
          </button>
        ` : `
          <button type="button"class="btn outline" onclick="reactivateNotificationMember('${member.id}')">
            再び有効にする
          </button>
          <button type="button" class="btn outline danger-outline" onclick="deleteNotificationMember('${member.id}')">
            削除する
          </button>
        `
        }
      </div>
    `;
    list.appendChild(item);
  });
}


function openNotificationMemberCreateForm() {
  const seats = notificationMemberManagement?.seats;
  const capacityMessage = document.getElementById(
    "notificationMemberCapacityMessage"
  );
  if (
    !seats ||
    seats.availableSeats <= 0 ||
    seats.pendingSeatCount !== null
  ) {
    if (capacityMessage) {
      capacityMessage.textContent = !seats
        ? "参加者情報を読み込んでいます。少し待ってからもう一度お試しください。"
        : seats?.pendingSeatCount !== null &&
        seats?.pendingSeatCount !== undefined &&
        seats?.availableSeats > 0
          ? "利用人数の変更が完了するまで参加者を追加できません。"
          : "現在の利用人数上限に達しています。";
    }
    return;
  }
  setText("notificationMemberActionError", "");
  closeNotificationMemberLoginInfo();
  closeNotificationMemberCredential();
  document
    .getElementById("notificationMemberCreatePanel")
    ?.classList.remove("hidden");
  document
    .getElementById("notificationMemberNameInput")
    ?.focus();
}


function closeNotificationMemberCreateForm() {
  document
    .getElementById("notificationMemberCreatePanel")
    ?.classList.add("hidden");
  const input = document.getElementById(
    "notificationMemberNameInput"
  );
  if (input) input.value = "";
}


async function createNotificationMember() {
  if (currentTeam?.role !== "OWNER") {
    showNotificationMemberActionError("参加者の管理は管理者のみ行えます。");
    return;
  }
  const input = document.getElementById(
    "notificationMemberNameInput"
  );
  const displayName = input?.value?.trim();
  setText("notificationMemberActionError", "");
  try {
    const response = await fetch(
      apiUrl(
        `/api/v1/teams/${encodeURIComponent(currentTeam.id)}/notification-members`
      ),
      {
        method: "POST",
        credentials: "include",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify(
          displayName ? { displayName } : {}
        )
      }
    );
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(
        payload?.error?.message ||
          "参加者を追加できませんでした。"
      );
    }
    await refreshNotificationMemberManagement();
    closeNotificationMemberCreateForm();
    showNotificationMemberCredential(payload, "create");
  } catch (error) {
    if (
      error instanceof Error &&
      /(?:利用人数|追加枠|上限)/u.test(error.message)
    ) {
      const capacityMessage = document.getElementById(
        "notificationMemberCapacityMessage"
      );
      if (capacityMessage) {
        capacityMessage.textContent =
          "現在の利用人数上限に達しています。";
      }
      showNotificationMemberActionError("現在の利用人数上限に達しています。");
      return;
    }
    showNotificationMemberActionError(
      error instanceof Error
        ? error.message
        : "参加者を追加できませんでした。"
    );
  }
}


function openNotificationMemberLoginInfo(memberId) {
  const member = notificationMemberManagement?.members?.find(
    (candidate) =>
      candidate.id === memberId && candidate.status === "ACTIVE"
  );
  if (!member) {
    showNotificationMemberActionError(
      "参加者の最新情報を確認できませんでした。契約画面を開き直してください。"
    );
    return;
  }
  closeNotificationMemberCreateForm();
  closeNotificationMemberCredential();
  renderNotificationMemberLoginInfo(member);
}


function renderNotificationMemberLoginInfo(member) {
  const panel = document.getElementById(
    "notificationMemberLoginInfoPanel"
  );
  if (!panel) return;
  notificationMemberLoginInfo = {
    id: String(member.id),
    callNowId: String(member.callNowId),
    displayName: String(member.displayName || "参加者")
  };
  setText(
    "notificationMemberLoginInfoName",
    notificationMemberLoginInfo.displayName
  );
  setText(
    "notificationMemberLoginInfoId",
    notificationMemberLoginInfo.callNowId
  );
  setText("notificationMemberLoginInfoError", "");
  setText("notificationMemberLoginInfoCopyStatus", "");
  panel.classList.remove("hidden");
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}


function closeNotificationMemberLoginInfo() {
  notificationMemberLoginInfo = null;
  setText("notificationMemberLoginInfoName", "");
  setText("notificationMemberLoginInfoId", "");
  setText("notificationMemberLoginInfoError", "");
  setText("notificationMemberLoginInfoCopyStatus", "");
  document
    .getElementById("notificationMemberLoginInfoPanel")
    ?.classList.add("hidden");
}


async function copyNotificationMemberLoginId() {
  if (!notificationMemberLoginInfo) return;
  try {
    await writeTextToClipboard(notificationMemberLoginInfo.callNowId);
    setText(
      "notificationMemberLoginInfoCopyStatus",
      "IDをコピーしました。"
    );
  } catch {
    showNotificationMemberLoginInfoError(
      "IDをコピーできませんでした。選択してコピーしてください。"
    );
  }
}


function showNotificationMemberLoginInfoError(message) {
  setText("notificationMemberLoginInfoError", message);
  document
    .getElementById("notificationMemberLoginInfoError")
    ?.scrollIntoView({ behavior: "smooth", block: "center" });
}


async function resetNotificationMemberPassword(
  memberId = notificationMemberLoginInfo?.id
) {
  if (!memberId) return;
  const confirmed = await showAppConfirm(
    "現在のパスワードではログインできなくなり、ログイン中の端末もログアウトされます。",
    {
      title: "新しいパスワードを発行しますか？",
      confirmText: "発行する",
      tone: "warning"
    }
  );
  if (!confirmed) return;
  const showInlineError =
    notificationMemberLoginInfo?.id === memberId;
  if (currentTeam?.role !== "OWNER") {
    const message = "参加者の管理は管理者のみ行えます。";
    if (showInlineError) {
      showNotificationMemberLoginInfoError(message);
    } else {
      showNotificationMemberActionError(message);
    }
    return;
  }
  setText("notificationMemberLoginInfoError", "");
  setText("notificationMemberActionError", "");
  try {
    const response = await fetch(
      apiUrl(
        `/api/v1/teams/${encodeURIComponent(currentTeam.id)}/notification-members/${encodeURIComponent(memberId)}/password-reset`
      ),
      {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json" }
      }
    );
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(
        payload?.error?.message ||
          "パスワードを再発行できませんでした。"
      );
    }
    closeNotificationMemberLoginInfo();
    showNotificationMemberCredential(payload, "reset");
  } catch (error) {
    const message =
      error instanceof Error &&
      error.message &&
      !/(?:Failed to fetch|Load failed|NetworkError)/iu.test(error.message)
        ? error.message
        : "新しいパスワードを発行できませんでした。通信状態を確認して、もう一度お試しください。";
    if (showInlineError) {
      showNotificationMemberLoginInfoError(message);
    } else {
      showNotificationMemberActionError(message);
    }
  }
}


async function disableNotificationMember(memberId) {
  const confirmed = await showAppConfirm(
    "この参加者を無効にしますか？ログイン中の端末も直ちにログアウトされます。",
    {
      title: "参加者を無効にする",
      confirmText: "無効にする",
      tone: "danger"
    }
  );
  if (!confirmed) return;
  if (currentTeam?.role !== "OWNER") {
    showNotificationMemberActionError("参加者の管理は管理者のみ行えます。");
    return;
  }
  setText("notificationMemberActionError", "");
  try {
    const response = await fetch(
      apiUrl(
        `/api/v1/teams/${encodeURIComponent(currentTeam.id)}/notification-members/${encodeURIComponent(memberId)}`
      ),
      {
        method: "DELETE",
        credentials: "include",
        headers: { Accept: "application/json" }
      }
    );
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(
        payload?.error?.message ||
          "参加者を無効にできませんでした。"
      );
    }
    notificationMemberManagement = payload;
    notificationMemberManagementLoadState = "ready";
    currentTeam =
      (await fetchCurrentTeamContext()) || currentTeam;
    if (notificationMemberLoginInfo?.id === memberId) {
      closeNotificationMemberLoginInfo();
    }
    renderNotificationMemberManagement();
  } catch (error) {
    showNotificationMemberActionError(
      error instanceof Error
        ? error.message
        : "参加者を無効にできませんでした。"
    );
  }
}


async function reactivateNotificationMember(
  memberId
) {
  const confirmed =
    await showAppConfirm(
      "この参加者を再び有効にしますか？新しいパスワードを発行し、以前のパスワードは利用できないままになります。",
      {
        title: "参加者を再び有効にする",
        confirmText: "再び有効にする",
        tone: "warning"
      }
    );
  if (!confirmed) return;
  if (currentTeam?.role !== "OWNER") {
    showNotificationMemberActionError("参加者の管理は管理者のみ行えます。");
    return;
  }
  setText("notificationMemberActionError", "");
  try {
    const response = await fetch(
      apiUrl(
        `/api/v1/teams/${encodeURIComponent(currentTeam.id)}/notification-members/${encodeURIComponent(memberId)}/reactivate`
      ),
      {
        method: "POST",
        credentials: "include",
        headers: {
          Accept: "application/json"
        }
      }
    );
    const payload = await response
      .json()
      .catch(() => null);
    if (!response.ok) {
      throw new Error(
        payload?.error?.message ||
          "参加者を再有効化できませんでした。"
      );
    }
    await refreshNotificationMemberManagement();
    currentTeam =
      (await fetchCurrentTeamContext()) ||
      currentTeam;
    renderNotificationMemberManagement();
    showNotificationMemberCredential(
      payload,
      "reactivate"
    );
  } catch (error) {
    showNotificationMemberActionError(
      error instanceof Error
        ? error.message
        : "この参加者を再び有効にするための空き枠がありません。"
    );
  }
}

async function deleteNotificationMember(
  memberId
) {
  const confirmed =
    await showAppConfirm(
      "この参加者を削除しますか？参加者IDとパスワードは利用できなくなります。過去の通知履歴は保持されます。",
      {
        title: "参加者を削除する",
        confirmText: "削除する",
        tone: "danger"
      }
    );
  if (!confirmed) return;
  if (currentTeam?.role !== "OWNER") {
    showNotificationMemberActionError("参加者の管理は管理者のみ行えます。");
    return;
  }
  setText("notificationMemberActionError", "");
  try {
    const response = await fetch(
      apiUrl(
        `/api/v1/teams/${encodeURIComponent(currentTeam.id)}/notification-members/${encodeURIComponent(memberId)}/record`
      ),
      {
        method: "DELETE",
        credentials: "include",
        headers: {
          Accept: "application/json"
        }
      }
    );
    const payload = await response
      .json()
      .catch(() => null);
    if (!response.ok) {
      throw new Error(
        payload?.error?.message ||
          "参加者を削除できませんでした。"
      );
    }
    notificationMemberManagement =
      payload;
    notificationMemberManagementLoadState =
      "ready";
    closeNotificationMemberCredential();
    renderNotificationMemberManagement();
  } catch (error) {
    showNotificationMemberActionError(
      error instanceof Error
        ? error.message
        : "この参加者はすでに削除されています。"
    );
  }
}

function showNotificationMemberActionError(message) {
  setText("notificationMemberActionError", message);
  document
    .getElementById("notificationMemberActionError")
    ?.scrollIntoView({ behavior: "smooth", block: "center" });
}

function showNotificationMemberCredential(
  payload,
  mode = "create"
) {
  const panel = document.getElementById(
    "notificationMemberCredentialPanel"
  );
  if (
    !panel ||
    !payload?.member?.callNowId ||
    !payload?.initialPassword
  ) return;
  closeNotificationMemberLoginInfo();
  notificationMemberCredential = {
    callNowId: String(payload.member.callNowId),
    password: String(payload.initialPassword)
  };
  setText(
    "notificationMemberCredentialTitle",
    mode === "reset"
      ? "新しいログイン情報を発行しました"
      : mode === "reactivate"
        ? "参加者を再び有効にしました"
        : "参加者情報を発行しました"
  );
  setText(
    "notificationMemberCredentialPasswordLabel",
    mode !== "create"
      ? "新しいパスワード"
      : "初期パスワード"
  );
  setText(
    "notificationMemberCredentialWarning",
    `${mode !== "create" ? "新しい" : "初期"}パスワードはこの画面を閉じると再表示できません。必要な場合は参加者へ共有するか、安全な場所に保存してください。`
  );
  setText(
    "notificationMemberCredentialId",
    notificationMemberCredential.callNowId
  );
  setText(
    "notificationMemberCredentialPassword",
    notificationMemberCredential.password
  );
  setText("notificationMemberCredentialCopyStatus", "");
  panel.classList.remove("hidden");
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}


function closeNotificationMemberCredential() {
  notificationMemberCredential = null;
  setText("notificationMemberCredentialId", "");
  setText("notificationMemberCredentialPassword", "");
  setText("notificationMemberCredentialCopyStatus", "");
  document
    .getElementById("notificationMemberCredentialPanel")
    ?.classList.add("hidden");
}


async function copyNotificationMemberCredential(target) {
  if (!notificationMemberCredential) return;
  const { callNowId, password } =
    notificationMemberCredential;
  const copyValue =
    target === "id"
      ? callNowId
      : target === "password"
        ? password
        : `Call Now参加者情報\nID：${callNowId}\nパスワード：${password}`;
  const successMessage =
    target === "id"
      ? "IDをコピーしました。"
      : target === "password"
        ? "パスワードをコピーしました。"
        : "IDとパスワードをコピーしました。";
  try {
    await writeTextToClipboard(copyValue);
    setText(
      "notificationMemberCredentialCopyStatus",
      successMessage
    );
  } catch {
    await showAppAlert(
      "コピーできませんでした。内容を選択してコピーしてください。",
      { title: "コピーエラー" }
    );
  }
}


async function writeTextToClipboard(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textArea = document.createElement("textarea");
  textArea.value = value;
  textArea.setAttribute("readonly", "");
  textArea.style.position = "fixed";
  textArea.style.opacity = "0";
  document.body.appendChild(textArea);
  textArea.select();
  const copied = document.execCommand("copy");
  textArea.remove();
  if (!copied) throw new Error("clipboard_copy_failed");
}


function calculateRemainingDays() {
  if (!contractEndDate) {
    return 0;
  }

  const today =
    new Date();

  today.setHours(
    0,
    0,
    0,
    0
  );

  const endDate =
    new Date(contractEndDate);

  endDate.setHours(
    0,
    0,
    0,
    0
  );

  const oneDay =
    1000 * 60 * 60 * 24;

  return Math.max(
    0,
    Math.ceil(
      (
        endDate.getTime() -
        today.getTime()
      ) /
        oneDay
    )
  );
}


function isContractExpired() {
  if (!contractEndDate) {
    return true;
  }

  const endDate =
    new Date(contractEndDate);

  endDate.setHours(
    23,
    59,
    59,
    999
  );

  return new Date() > endDate;
}


function updateContractStatusUI() {
  const activeSubscription =
    hasActiveSubscription();
  const expired =
    activeSubscription && isContractExpired();

  const renewalButton =
    document.getElementById(
      "renewContractButton"
    );

  document
    .querySelectorAll(
      ".test-button"
    )
    .forEach((button) => {
      button.disabled =
        !activeSubscription || expired;

      button.textContent =
        !activeSubscription
          ? "初期設定が必要です"
          : expired
            ? "契約更新が必要です"
            : "テストを実行";
    });

  if (renewalButton) {
    renewalButton.textContent =
      !activeSubscription
        ? "契約設定を始める"
        : expired
          ? "契約を1年間更新して再開"
          : "契約期限を1年間延長";
  }
}


function renewContract() {
  if (!hasActiveSubscription()) {
    openSetupForAuthenticatedUser();
    return;
  }
  paymentMode =
    "renewal";

  openPayment();
}


function extendContractByOneYear() {

  if (isContractExpired()) {
    createContractDates();
  } else {
    contractEndDate =
      new Date(contractEndDate);

    contractEndDate.setFullYear(
      contractEndDate.getFullYear() +
        1
    );
  }
}


function returnToContractPage() {
  renderTestKeywordCards();

  renderContractInformation();

  renderContractSettings();

  showOnlyScreen(
    "appScreen"
  );

  showAppPage(
    "contractPage"
  );
}


function formatDate(dateValue) {
  return new Intl.DateTimeFormat(
    "ja-JP",
    {
      year: "numeric",
      month: "long",
      day: "numeric"
    }
  ).format(
    new Date(dateValue)
  );
}


/* ========================================
   利用者向け通知・フィードバック
======================================== */

async function refreshUserNotifications() {
  if (!authenticatedUser) {
    userNotifications = [];
    notificationUnreadCount = 0;
    renderNotificationBadge();
    return false;
  }

  try {
    const response = await fetch(
      apiUrl("/api/v1/notifications"),
      {
        credentials: "include",
        headers: { Accept: "application/json" }
      }
    );
    const payload = await response.json().catch(() => null);
    if (!response.ok || !Array.isArray(payload?.notifications)) {
      return false;
    }
    userNotifications = payload.notifications;
    notificationUnreadCount =
      Number.isInteger(payload.unreadCount) &&
      payload.unreadCount >= 0
        ? payload.unreadCount
        : userNotifications.filter(
            (notification) => !notification.readAt
          ).length;
    pruneNotificationSelection("OWNER");
    renderNotificationBadge();
    renderUserNotifications();
    return true;
  } catch {
    return false;
  }
}


function renderNotificationBadge() {
  const ownerUnread =
    notificationUnreadCount + countUnreadAlerts(ownerAlerts);
  updateNotificationBadge(
    "notificationUnreadBadge",
    "notificationCenterButton",
    ownerUnread,
    "通知を開く"
  );
  updateNotificationBadge(
    "notificationMemberUnreadBadge",
    "notificationMemberNotificationCenterButton",
    countUnreadAlerts(notificationMemberAlerts),
    "緊急通知を開く"
  );
}


function countUnreadAlerts(alerts) {
  return alerts.filter((alert) => !alert.readAt).length;
}


function updateNotificationBadge(badgeId, buttonId, unreadCount, label) {
  const badge = document.getElementById(badgeId);
  const button = document.getElementById(buttonId);
  if (!badge || !button) return;
  const hasUnread = unreadCount > 0;
  badge.classList.toggle("hidden", !hasUnread);
  badge.textContent = hasUnread
    ? unreadCount > 99
      ? "99+"
      : String(unreadCount)
    : "";
  button.setAttribute(
    "aria-label",
    hasUnread ? `${label}（未読${unreadCount}件）` : label
  );
}


async function openNotificationCenter() {
  showAppPage("notificationCenterPage");
  setText("notificationCenterError", "");
  setText("notificationCenterStatus", "");
  renderNotificationSelectionControls("OWNER");
  renderEmergencyNotifications(
    "ownerEmergencyNotificationList",
    ownerAlerts,
    "OWNER"
  );
  renderUserNotifications();
  await Promise.all([
    refreshUserNotifications(),
    refreshOwnerAlerts()
  ]);
}


function renderEmergencyNotifications(containerId, alerts, audience) {
  const list = document.getElementById(containerId);
  if (!list) return;
  list.replaceChildren();
  const selectionMode = notificationSelectionModes[audience];

  if (alerts.length === 0) {
    const empty = document.createElement("p");
    empty.className = "notification-empty";
    empty.textContent = "緊急通知はありません。";
    list.appendChild(empty);
    return;
  }

  alerts.forEach((alert) => {
    const item = document.createElement("article");
    item.className = `emergency-notification-item${alert.readAt ? "" : " unread"}`;
    const key = notificationItemKey("ALERT", alert.id);
    item.dataset.notificationKey = key;
    item.setAttribute(
      "aria-selected",
      String(selectedNotificationKeys[audience].has(key))
    );
    if (selectionMode) {
      item.classList.add("selection-mode");
      appendNotificationSelectionControl(item, {
        audience,
        key,
        label: `「${String(alert.matchedKeyword || "キーワード")}」の緊急通知を選択`
      });
    }

    const heading = document.createElement("div");
    heading.className = "emergency-notification-heading";
    const readState = document.createElement("span");
    readState.className = "notification-read-state";
    readState.textContent = alert.readAt ? "既読" : "未読";
    const kind = document.createElement("span");
    kind.className = `alert-kind-badge${alert.kind === "TEST" ? " test" : ""}`;
    kind.textContent = alert.kind === "TEST" ? "テスト通知" : "緊急通知";
    heading.append(readState, kind);

    const title = document.createElement("h3");
    title.textContent = `「${String(alert.matchedKeyword || "キーワード")}」を検知しました`;
    const date = document.createElement("time");
    date.dateTime = String(alert.detectedAt || "");
    date.textContent = formatNotificationDate(alert.detectedAt);
    const details = document.createElement("button");
    details.type = "button";
    details.className = "notification-read-button";
    const expanded = expandedEmergencyAlertIds[audience].has(alert.id);
    details.textContent = expanded ? "詳細を閉じる" : "詳細を開く";
    details.setAttribute("aria-expanded", String(expanded));
    details.addEventListener("click", () => {
      void openEmergencyAlertDetails(alert.id, audience);
    });
    item.append(heading, title, date, details);
    if (expanded) {
      item.appendChild(createEmergencyAlertDetails(alert));
    }
    list.appendChild(item);
  });
}


function createEmergencyAlertDetails(alert) {
  const details = document.createElement("div");
  details.className = "emergency-notification-details";

  const list = document.createElement("dl");
  appendNotificationDetail(list, "種別", alert.kind === "TEST" ? "テスト通知" : "緊急通知");
  appendNotificationDetail(list, "通知キーワード", String(alert.matchedKeyword || "キーワード"));
  appendNotificationDetail(list, "検知時刻", formatNotificationDate(alert.detectedAt));
  appendNotificationDetail(list, "確認状態", alert.readAt ? "既読" : "未読");
  appendNotificationDetail(
    list,
    "配信について",
    alert.kind === "TEST"
      ? "通知テストにより、あなたのお知らせへ配信されました。"
      : "登録したキーワードを含む重要メールを検知したため、あなたのお知らせへ配信されました。"
  );
  details.appendChild(list);
  return details;
}


function appendNotificationDetail(list, label, value) {
  const term = document.createElement("dt");
  term.textContent = label;
  const description = document.createElement("dd");
  description.textContent = value;
  list.append(term, description);
}


async function openEmergencyAlertDetails(alertId, audience) {
  const alerts =
    audience === "OWNER" ? ownerAlerts : notificationMemberAlerts;
  const alert = alerts.find((candidate) => candidate.id === alertId);
  if (!alert) return;
  if (!alert.readAt) {
    const marked = await markEmergencyAlertRead(alertId, audience);
    if (!marked) return;
  }
  const expanded = expandedEmergencyAlertIds[audience];
  if (expanded.has(alertId)) {
    expanded.delete(alertId);
  } else {
    expanded.add(alertId);
  }
  renderEmergencyNotifications(
    audience === "OWNER"
      ? "ownerEmergencyNotificationList"
      : "notificationMemberEmergencyNotificationList",
    audience === "OWNER" ? ownerAlerts : notificationMemberAlerts,
    audience
  );
}


async function markEmergencyAlertRead(alertId, audience) {
  const owner = audience === "OWNER";
  const errorId = owner
    ? "notificationCenterError"
    : "notificationMemberNotificationCenterError";
  setText(errorId, "");
  if (owner && (!currentTeam || currentTeam.role !== "OWNER")) return false;
  const path = owner
    ? `/api/v1/teams/${encodeURIComponent(currentTeam.id)}/alerts/${encodeURIComponent(alertId)}/read`
    : `/api/v1/notification-members/alerts/${encodeURIComponent(alertId)}/read`;
  try {
    const response = await fetch(apiUrl(path), {
      method: "POST",
      credentials: "include",
      headers: { Accept: "application/json" }
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.id) {
      throw new Error(
        payload?.error?.message ||
          "緊急通知を既読にできませんでした。もう一度お試しください。"
      );
    }
    const alerts = owner ? ownerAlerts : notificationMemberAlerts;
    const index = alerts.findIndex((alert) => alert.id === payload.id);
    if (index >= 0) alerts[index] = payload;
    applyAlertUpdate(alerts, audience);
    return true;
  } catch (error) {
    setText(
      errorId,
      error instanceof Error
        ? error.message
        : "緊急通知を既読にできませんでした。もう一度お試しください。"
    );
    return false;
  }
}


function renderUserNotifications() {
  const list =
    document.getElementById(
      "userNotificationList"
    );
  if (!list) return;
  list.replaceChildren();

  if (userNotifications.length === 0) {
    const empty = document.createElement("p");
    empty.className = "notification-empty";
    empty.textContent = "新しい通知はありません。";
    list.appendChild(empty);
    return;
  }

  userNotifications.forEach((notification) => {
    const item = document.createElement("article");
    item.className = `user-notification-item${notification.readAt ? "" : " unread"}`;
    const key = notificationItemKey("USER_NOTIFICATION", notification.id);
    item.dataset.notificationKey = key;
    item.setAttribute(
      "aria-selected",
      String(selectedNotificationKeys.OWNER.has(key))
    );
    if (notificationSelectionModes.OWNER) {
      item.classList.add("selection-mode");
      appendNotificationSelectionControl(item, {
        audience: "OWNER",
        key,
        label: `「${String(notification.title || "お知らせ")}」を選択`
      });
    }

    const title = document.createElement("h2");
    title.textContent = String(notification.title || "通知");
    const message = document.createElement("p");
    message.textContent = String(notification.message || "");
    const date = document.createElement("time");
    date.dateTime = String(notification.createdAt || "");
    date.textContent = formatNotificationDate(notification.createdAt);
    item.append(title, message, date);

    if (!notification.readAt) {
      const readButton = document.createElement("button");
      readButton.type = "button";
      readButton.className = "notification-read-button";
      readButton.textContent = "既読にする";
      readButton.addEventListener("click", () => {
        void markUserNotificationRead(notification.id);
      });
      item.appendChild(readButton);
    }
    list.appendChild(item);
  });
}


function appendNotificationSelectionControl(
  item,
  { audience, key, label }
) {
  const wrapper = document.createElement("label");
  wrapper.className = "notification-select-control";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = selectedNotificationKeys[audience].has(key);
  checkbox.setAttribute("aria-checked", String(checkbox.checked));
  checkbox.setAttribute("aria-label", label);
  checkbox.addEventListener("change", () => {
    checkbox.setAttribute("aria-checked", String(checkbox.checked));
    toggleNotificationSelection(audience, key, checkbox.checked);
    item.setAttribute("aria-selected", String(checkbox.checked));
  });
  const text = document.createElement("span");
  text.className = "visually-hidden";
  text.textContent = label;
  wrapper.append(checkbox, text);
  item.prepend(wrapper);
}


function notificationItemKey(type, id) {
  return `${type}:${id}`;
}


function resetNotificationCenterUiState(audience) {
  notificationSelectionModes[audience] = false;
  selectedNotificationKeys[audience].clear();
  expandedEmergencyAlertIds[audience].clear();
}


function getNotificationCenterItems(audience) {
  const alerts = (audience === "OWNER" ? ownerAlerts : notificationMemberAlerts).map(
    (alert) => ({
      key: notificationItemKey("ALERT", alert.id),
      type: "ALERT",
      id: alert.id,
      readAt: alert.readAt
    })
  );
  if (audience !== "OWNER") return alerts;
  return alerts.concat(
    userNotifications.map((notification) => ({
      key: notificationItemKey("USER_NOTIFICATION", notification.id),
      type: "USER_NOTIFICATION",
      id: notification.id,
      readAt: notification.readAt
    }))
  );
}


function startNotificationSelection(audience) {
  notificationSelectionModes[audience] = true;
  selectedNotificationKeys[audience].clear();
  renderNotificationCenterForAudience(audience);
}


function cancelNotificationSelection(audience) {
  notificationSelectionModes[audience] = false;
  selectedNotificationKeys[audience].clear();
  renderNotificationCenterForAudience(audience);
}


function toggleNotificationSelection(audience, key, selected) {
  if (selected) {
    selectedNotificationKeys[audience].add(key);
  } else {
    selectedNotificationKeys[audience].delete(key);
  }
  renderNotificationSelectionControls(audience);
}


function selectAllNotifications(audience) {
  selectedNotificationKeys[audience].clear();
  getNotificationCenterItems(audience)
    .forEach(({ key }) => selectedNotificationKeys[audience].add(key));
  renderNotificationCenterForAudience(audience);
}


function clearNotificationSelection(audience) {
  selectedNotificationKeys[audience].clear();
  renderNotificationCenterForAudience(audience);
}


function pruneNotificationSelection(audience) {
  const available = new Set(
    getNotificationCenterItems(audience)
      .map(({ key }) => key)
  );
  for (const key of selectedNotificationKeys[audience]) {
    if (!available.has(key)) selectedNotificationKeys[audience].delete(key);
  }
  for (const alertId of expandedEmergencyAlertIds[audience]) {
    const exists = (audience === "OWNER" ? ownerAlerts : notificationMemberAlerts).some(
      ({ id }) => id === alertId
    );
    if (!exists) expandedEmergencyAlertIds[audience].delete(alertId);
  }
  renderNotificationSelectionControls(audience);
}


function renderNotificationCenterForAudience(audience) {
  pruneNotificationSelection(audience);
  renderEmergencyNotifications(
    audience === "OWNER"
      ? "ownerEmergencyNotificationList"
      : "notificationMemberEmergencyNotificationList",
    audience === "OWNER" ? ownerAlerts : notificationMemberAlerts,
    audience
  );
  if (audience === "OWNER") renderUserNotifications();
}


function renderNotificationSelectionControls(audience) {
  const owner = audience === "OWNER";
  const toolbarId = owner
    ? "ownerNotificationSelectionToolbar"
    : "notificationMemberSelectionToolbar";
  const selectionButtonId = owner
    ? "ownerNotificationSelectionButton"
    : "notificationMemberSelectionButton";
  const countId = owner
    ? "ownerNotificationSelectionCount"
    : "notificationMemberSelectionCount";
  const deleteButtonId = owner
    ? "ownerDeleteSelectionButton"
    : "notificationMemberDeleteSelectionButton";
  const active = notificationSelectionModes[audience];
  const count = selectedNotificationKeys[audience].size;
  document.getElementById(toolbarId)?.classList.toggle("hidden", !active);
  document.getElementById(selectionButtonId)?.classList.toggle("hidden", active);
  setText(countId, `${count}件選択中`);
  const deleteButton = document.getElementById(deleteButtonId);
  if (deleteButton) deleteButton.disabled = count === 0;
}


async function deleteSelectedNotifications(audience) {
  const selected = selectedNotificationKeys[audience];
  const visibleByKey = new Map(
    getNotificationCenterItems(audience).map((item) => [item.key, item])
  );
  const items = [...selected]
    .map((key) => visibleByKey.get(key))
    .filter(Boolean);
  const errorId =
    audience === "OWNER"
      ? "notificationCenterError"
      : "notificationMemberNotificationCenterError";
  const statusId =
    audience === "OWNER"
      ? "notificationCenterStatus"
      : "notificationMemberNotificationCenterStatus";
  setText(errorId, "");
  setText(statusId, "");
  if (items.length < 1) return;
  if (items.length > 100) {
    setText(errorId, "一度に削除できるお知らせは100件までです。");
    return;
  }

  const confirmation = buildNotificationDeletionConfirmation(items);
  const confirmed = await showAppConfirm(
    confirmation.message,
    {
      title: confirmation.title,
      confirmText: confirmation.confirmText,
      cancelText: "キャンセル",
      tone: "danger"
    }
  );
  if (!confirmed) return;

  const path =
    audience === "OWNER"
      ? "/api/v1/notification-center/delete"
      : "/api/v1/notification-members/notification-center/delete";
  const body =
    audience === "OWNER"
      ? { items: items.map(({ type, id }) => ({ type, id })) }
      : { alertIds: items.map(({ id }) => id) };
  try {
    const response = await fetch(apiUrl(path), {
      method: "POST",
      credentials: "include",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !Array.isArray(payload?.items)) {
      throw new Error(
        payload?.error?.message ||
          "お知らせを削除できませんでした。もう一度お試しください。"
      );
    }

    const deletedKeys = new Set(items.map(({ key }) => key));
    if (
      currentAlarmAlertContext?.audience === audience &&
      items.some(
        ({ type, id }) =>
          type === "ALERT" && id === currentAlarmAlertContext.alertId
      )
    ) {
      closeAlarmNotification();
    }
    if (audience === "OWNER") {
      ownerAlerts = ownerAlerts.filter(
        ({ id }) => !deletedKeys.has(notificationItemKey("ALERT", id))
      );
      userNotifications = userNotifications.filter(
        ({ id }) =>
          !deletedKeys.has(notificationItemKey("USER_NOTIFICATION", id))
      );
      notificationUnreadCount = userNotifications.filter(
        ({ readAt }) => !readAt
      ).length;
    } else {
      notificationMemberAlerts = notificationMemberAlerts.filter(
        ({ id }) => !deletedKeys.has(notificationItemKey("ALERT", id))
      );
    }
    notificationSelectionModes[audience] = false;
    selected.clear();
    renderNotificationCenterForAudience(audience);
    renderNotificationBadge();
    setText(statusId, `${items.length}件のお知らせを削除しました。`);

    if (audience === "OWNER") {
      await Promise.all([refreshOwnerAlerts(), refreshUserNotifications()]);
    } else {
      await refreshNotificationMemberAlerts();
    }
    setText(statusId, `${items.length}件のお知らせを削除しました。`);
  } catch (error) {
    setText(
      errorId,
      error instanceof Error
        ? error.message
        : "お知らせを削除できませんでした。もう一度お試しください。"
    );
  }
}


function buildNotificationDeletionConfirmation(items) {
  const count = items.length;
  const unreadEmergencyCount = items.filter(
    ({ type, readAt }) => type === "ALERT" && !readAt
  ).length;
  if (count === 1 && items[0].type === "ALERT") {
    return {
      title: items[0].readAt
        ? "緊急通知を削除"
        : "未読の緊急通知を削除",
      message: items[0].readAt
        ? "この緊急通知を削除しますか？\n\n削除すると、このアカウントのお知らせ一覧から消えます。ほかの利用者の通知や共有データには影響しません。"
        : "未読の緊急通知を削除しますか？\n\n削除すると、このアカウントのお知らせ一覧から消えます。ほかの利用者の通知や共有データには影響しません。",
      confirmText: "削除する"
    };
  }
  if (count === 1) {
    return {
      title: "お知らせを削除",
      message:
        "このお知らせを削除しますか？\n\n一覧から削除されます。ほかの利用者の通知や共有データには影響しません。",
      confirmText: "削除する"
    };
  }
  const unreadMessage = unreadEmergencyCount
    ? `\n\n未読の緊急通知が${unreadEmergencyCount}件含まれています。`
    : "";
  return {
    title: "お知らせを一括削除",
    message: `選択した${count}件を削除しますか？${unreadMessage}\n\n削除すると、このアカウントのお知らせ一覧から消えます。ほかの利用者の通知や共有データには影響しません。`,
    confirmText: `${count}件を削除`
  };
}


async function markUserNotificationRead(notificationId) {
  setText("notificationCenterError", "");
  try {
    const response = await fetch(
      apiUrl(
        `/api/v1/notifications/${encodeURIComponent(notificationId)}/read`
      ),
      {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json" }
      }
    );
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.id) {
      throw new Error(
        payload?.error?.message ||
          "通知を既読にできませんでした。もう一度お試しください。"
      );
    }

    const index = userNotifications.findIndex(
      (notification) => notification.id === payload.id
    );
    if (index >= 0) {
      userNotifications[index] = payload;
    }
    notificationUnreadCount = userNotifications.filter(
      (notification) => !notification.readAt
    ).length;
    renderNotificationBadge();
    renderUserNotifications();
  } catch (error) {
    setText(
      "notificationCenterError",
      error instanceof Error
        ? error.message
        : "通知を既読にできませんでした。もう一度お試しください。"
    );
  }
}


async function submitFeedback(event) {
  event.preventDefault();
  const input =
    document.getElementById("feedbackContent");
  const button =
    document.getElementById(
      "feedbackSubmitButton"
    );
  const content = input?.value.trim() ?? "";
  setText("feedbackStatus", "");
  document.getElementById("feedbackStatus")?.classList.remove("error");
  if (!content) {
    setText(
      "feedbackStatus",
      "ご意見・フィードバックの内容を入力してください。"
    );
    document.getElementById("feedbackStatus")?.classList.add("error");
    input?.setAttribute("aria-invalid", "true");
    input?.focus();
    return;
  }

  if (button) button.disabled = true;
  try {
    const response = await fetch(
      apiUrl("/api/v1/feedback"),
      {
        method: "POST",
        credentials: "include",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          content,
          ...(currentTeam?.id
            ? { teamId: currentTeam.id }
            : {})
        })
      }
    );
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(
        payload?.error?.message ||
          "送信できませんでした。時間をおいてお試しください。"
      );
    }
    if (input) input.value = "";
    setText(
      "feedbackStatus",
      "送信しました。返信がある場合は通知でお知らせします。"
    );
  } catch (error) {
    document.getElementById("feedbackStatus")?.classList.add("error");
    setText(
      "feedbackStatus",
      error instanceof Error
        ? error.message
        : "送信できませんでした。時間をおいてお試しください。"
    );
  } finally {
    if (button) button.disabled = false;
  }
}

function clearFeedbackError(input) {
  input?.removeAttribute("aria-invalid");
  setText("feedbackStatus", "");
  document.getElementById("feedbackStatus")?.classList.remove("error");
}


function formatNotificationDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}


/* ========================================
   管理画面
======================================== */

function openApp() {
  if (!authenticatedUser) {
    openGuestHome();
    return;
  }

  showOnlyScreen(
    "appScreen"
  );


  renderTestKeywordCards();

  renderContractInformation();

  renderConnectedGoogleAccounts();

  renderNotificationBadge();

  renderEmergencyNotifications(
    "ownerEmergencyNotificationList",
    ownerAlerts,
    "OWNER"
  );

  renderUserNotifications();

  void refreshOwnerAlerts();
  startOwnerAlertStream();

  updateAlarmAudioReadiness("OWNER");

  showAppPage(
    "homePage"
  );

  window.scrollTo({
    top: 0
  });
}


function renderConnectedGoogleAccounts() {
  const container =
    document.getElementById(
      "connectedGoogleAccounts"
    );

  if (!container) {
    return;
  }

  container.replaceChildren();

  const monitoringAccount =
    document.createElement("div");
  monitoringAccount.className =
    "google-account-role";
  const activeMailConnections =
    mailConnections.filter(
      (connection) =>
        connection.connectionStatus === "ACTIVE" &&
        connection.authorizationStatus === "ACTIVE"
    );
  const requiresMailReauthorization =
    mailConnections.some(
      (connection) =>
        ["REAUTH_REQUIRED", "ERROR"].includes(
          connection.connectionStatus
        ) ||
        connection.authorizationStatus !== "ACTIVE"
    );
  const pausedMailConnections =
    mailConnections.filter(
      (connection) =>
        connection.connectionStatus === "PAUSED"
    );
  const deferredMailChoices =
    ownerOnboarding?.choices?.filter(
      (choice) =>
        choice.status === "DEFERRED" && choice.email
    ) ?? [];
  const monitoringStatus =
    mailConnections.length > 0
      ? requiresMailReauthorization
        ? `${mailConnections.length}件中、再認証が必要な接続があります`
        : pausedMailConnections.length > 0
          ? `${activeMailConnections.length}件監視中・${pausedMailConnections.length}件停止中`
          : `${mailConnections.length}件接続中`
      : deferredMailChoices.length > 0
        ? `${deferredMailChoices.length}件設定保留`
        : "接続されていません";
  const monitoringDetail =
    mailConnections.length > 0
      ? mailConnections
          .map((connection) =>
            escapeHtml(connection.email)
          )
          .join("<br>")
      : deferredMailChoices.length > 0
        ? deferredMailChoices
            .map((choice) =>
              `${escapeHtml(choice.email)}（設定保留）`
            )
            .join("<br>")
        : currentTeam?.role === "OWNER"
          ? "重要メールの監視用アカウントを接続できます"
        : currentTeam
          ? "メール監視アカウントの変更は管理者のみ行えます"
          : "契約後にメール監視アカウントを設定できます";
  const monitoringProvider =
    mailConnections.length > 0
      ? [...new Set(
          mailConnections.map((connection) =>
            mailProviderLabel(connection.provider)
          )
        )].join("・")
      : "Gmail / Microsoft 365";
  monitoringAccount.innerHTML = `
    <strong>メール監視アカウント</strong>
    <span class="connected-account-summary">
      ${monitoringStatus}
    </span>
    <span class="connected-account-email">
      ${monitoringProvider}<br>
      ${monitoringDetail}
    </span>
  `;

  container.appendChild(monitoringAccount);

  setText(
    "homeGoogleAccountActionButton",
    "監視アカウント設定を開く"
  );
}


function openGoogleAccountManager() {
  openGoogleScreen("manage");
}


function showAppPage(
  pageId,
  clickedButton = null
) {
  if (!authenticatedUser) {
    openGoogleScreen("login");
    return;
  }

  if (pageId !== "contractPage") {
    closeNotificationMemberCreateForm();
    closeNotificationMemberLoginInfo();
    closeNotificationMemberCredential();
  }

  if (
    pageId === "contractPage" &&
    currentTeam?.role === "OWNER"
  ) {
    void refreshNotificationMemberManagement();
  }

  if (pageId === "keywordPage") {
    renderContractSettings();
  }

  document
    .querySelectorAll(
      ".app-page"
    )
    .forEach((page) => {
      page.classList.remove(
        "active"
      );
    });

  const selectedPage =
    document.getElementById(
      pageId
    );

  if (selectedPage) {
    selectedPage.classList.add(
      "active"
    );
  }

  const tabButtons =
    document.querySelectorAll(
      ".tab-button"
    );

  tabButtons.forEach((button) => {
    button.classList.remove(
      "active"
    );
  });

  if (clickedButton) {
    clickedButton.classList.add(
      "active"
    );
  } else {
    const pageOrder = {
      homePage: 0,
      testPage: 1,
      contractPage: 2,
      keywordPage: 3,
      helpFeedbackPage: 4
    };

    const buttonIndex =
      pageOrder[pageId];

    if (
      typeof buttonIndex ===
        "number" &&
      tabButtons[buttonIndex]
    ) {
      tabButtons[
        buttonIndex
      ].classList.add(
        "active"
      );
    }
  }

  window.scrollTo({
    top: 0,
    behavior: "smooth"
  });
}


/* ========================================
   ログアウト
======================================== */

async function logout() {
  const confirmed =
    await showAppConfirm(
      `Call Nowからログアウトしますか？

契約情報とキーワードは保存されたままです。`,
      {
        title: "ログアウトの確認",
        confirmText: "ログアウトする",
        tone: "warning"
      }
    );

  if (!confirmed) {
    return;
  }

  await performLogout();
}


async function performLogout() {
  try {
    const response = await fetch(
      apiUrl("/api/v1/auth/logout"),
      {
        method: "POST",
        credentials: "include",
        headers: {
          Accept: "application/json"
        }
      }
    );

    if (
      !response.ok &&
      response.status !== 401
    ) {
      throw new Error(
        `auth_logout_${response.status}`
      );
    }
  } catch (error) {
    console.error(
      "ログアウトに失敗しました。",
      error
    );
    await showAppAlert(
      "ログアウトできませんでした。通信状態を確認して、もう一度お試しください。"
    );
    return;
  }

  closeAlarmNotification();
  authenticatedUser = null;
  googleEmail = "";
  loginIdentities = [];
  currentTeam = null;
  mailConnections = [];
  mailProviderAvailability = {
    GOOGLE: "UNKNOWN",
    MICROSOFT: "UNKNOWN"
  };
  resetOwnerOnboardingClientState();
  notificationMemberManagement = null;
  notificationMemberManagementLoadState = "idle";
  closeNotificationMemberCreateForm();
  closeNotificationMemberLoginInfo();
  closeNotificationMemberCredential();
  ownerAlerts = [];
  userNotifications = [];
  notificationUnreadCount = 0;
  resetNotificationCenterUiState("OWNER");
  stopAlertEventStream();

  setupMode =
    "signup";

  openGuestHome();

  window.scrollTo({
    top: 0,
    behavior: "smooth"
  });
}


/* ========================================
   共通ダイアログ
======================================== */

function initializeAppDialog() {
  const dialog =
    document.getElementById(
      "appDialog"
    );

  const cancelButton =
    document.getElementById(
      "appDialogCancelButton"
    );

  const confirmButton =
    document.getElementById(
      "appDialogConfirmButton"
    );

  if (
    !dialog ||
    !cancelButton ||
    !confirmButton
  ) {
    return;
  }

  cancelButton.addEventListener(
    "click",
    () => {
      closeAppDialog(false);
    }
  );

  confirmButton.addEventListener(
    "click",
    () => {
      closeAppDialog(true);
    }
  );

  dialog.addEventListener(
    "keydown",
    handleAppDialogKeydown
  );
}


function showAppDialog(options = {}) {
  const dialogTask =
    appDialogQueue.then(
      () => openAppDialog(options),
      () => openAppDialog(options)
    );

  appDialogQueue =
    dialogTask.then(
      () => undefined,
      () => undefined
    );

  return dialogTask;
}


function openAppDialog(options) {
  const dialog =
    document.getElementById(
      "appDialog"
    );

  const titleElement =
    document.getElementById(
      "appDialogTitle"
    );

  const messageElement =
    document.getElementById(
      "appDialogMessage"
    );

  const iconElement =
    document.getElementById(
      "appDialogIcon"
    );

  const cancelButton =
    document.getElementById(
      "appDialogCancelButton"
    );

  const confirmButton =
    document.getElementById(
      "appDialogConfirmButton"
    );

  if (
    !dialog ||
    !titleElement ||
    !messageElement ||
    !iconElement ||
    !cancelButton ||
    !confirmButton
  ) {
    console.error(
      "共通ダイアログの要素が見つかりません。"
    );

    return Promise.resolve(false);
  }

  const showCancel =
    Boolean(options.showCancel);

  const tone =
    ["info", "warning", "danger"]
      .includes(options.tone)
      ? options.tone
      : "info";

  const title =
    typeof options.title === "string" &&
    options.title.trim()
      ? options.title
      : showCancel
        ? "確認"
        : "お知らせ";

  const message =
    typeof options.message === "string"
      ? options.message
      : String(options.message || "");

  const confirmText =
    typeof options.confirmText === "string" &&
    options.confirmText.trim()
      ? options.confirmText
      : "OK";

  const cancelText =
    typeof options.cancelText === "string" &&
    options.cancelText.trim()
      ? options.cancelText
      : "キャンセル";

  titleElement.textContent =
    title;

  messageElement.textContent =
    message;

  confirmButton.textContent =
    confirmText;

  cancelButton.textContent =
    cancelText;

  iconElement.className =
    `app-dialog-icon ${tone}`;

  iconElement.textContent =
    showCancel && tone === "info"
      ? "?"
      : tone === "info"
        ? "i"
        : "!";

  cancelButton.classList.toggle(
    "hidden",
    !showCancel
  );

  dialog.setAttribute(
    "role",
    showCancel
      ? "dialog"
      : "alertdialog"
  );

  dialog.setAttribute(
    "aria-hidden",
    "false"
  );

  appDialogFocusBeforeOpen =
    document.activeElement;

  document.body.classList.add(
    "app-dialog-open"
  );

  dialog.classList.remove(
    "hidden"
  );

  return new Promise((resolve ) => {
    appDialogResolver =
      resolve;

    (showCancel ? cancelButton : confirmButton).focus();
  });
}


function showAppAlert(
  message,
  options = {}
) {
  return showAppDialog({
    ...options,
    message: message,
    showCancel: false
  }).then(() => undefined);
}


function showAppConfirm(
  message,
  options = {}
) {
  return showAppDialog({
    ...options,
    message: message,
    showCancel: true
  });
}


function closeAppDialog(result) {
  if (!appDialogResolver) {
    return;
  }

  const resolve =
    appDialogResolver;

  appDialogResolver = null;

  const dialog =
    document.getElementById(
      "appDialog"
    );

  if (dialog) {
    dialog.classList.add(
      "hidden"
    );

    dialog.setAttribute(
      "aria-hidden",
      "true"
    );
  }

  document.body.classList.remove(
    "app-dialog-open"
  );

  if (
    appDialogFocusBeforeOpen &&
    typeof appDialogFocusBeforeOpen.focus ===
      "function" &&
    document.contains(
      appDialogFocusBeforeOpen
    )
  ) {
    appDialogFocusBeforeOpen.focus();
  }

  appDialogFocusBeforeOpen = null;

  resolve(Boolean(result));
}


function handleAppDialogKeydown(event) {
  const dialog =
    document.getElementById(
      "appDialog"
    );

  if (
    !dialog ||
    dialog.classList.contains(
      "hidden"
    )
  ) {
    return;
  }

  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();

    closeAppDialog(false);
    return;
  }

  if (event.key !== "Tab") {
    return;
  }

  const cancelButton =
    document.getElementById(
      "appDialogCancelButton"
    );

  const confirmButton =
    document.getElementById(
      "appDialogConfirmButton"
    );

  if (!confirmButton) {
    return;
  }

  const focusableElements = [];

  if (
    cancelButton &&
    !cancelButton.classList.contains(
      "hidden"
    )
  ) {
    focusableElements.push(
      cancelButton
    );
  }

  focusableElements.push(
    confirmButton
  );

  const firstElement =
    focusableElements[0];

  const lastElement =
    focusableElements[
      focusableElements.length - 1
    ];

  if (
    event.shiftKey &&
    document.activeElement === firstElement
  ) {
    event.preventDefault();
    lastElement.focus();
    return;
  }

  if (
    !event.shiftKey &&
    document.activeElement === lastElement
  ) {
    event.preventDefault();
    firstElement.focus();
    return;
  }

  if (
    !focusableElements.includes(
      document.activeElement
    )
  ) {
    event.preventDefault();
    firstElement.focus();
  }
}


/* ========================================
   警報音・停止画面
======================================== */

function loadAlarmSoundPreference() {
  try {
    const saved = JSON.parse(
      window.localStorage.getItem(ALERT_SOUND_SETTING_KEY) || "null"
    );
    if (
      saved?.version === ALERT_SOUND_SETTING_VERSION &&
      typeof saved.enabled === "boolean"
    ) {
      return saved.enabled;
    }
  } catch {
    /* 保存値が壊れている場合は安全な初期値を使う。 */
  }
  return true;
}

function saveAlarmSoundPreference(enabled) {
  alarmSoundEnabled = Boolean(enabled);
  try {
    window.localStorage.setItem(
      ALERT_SOUND_SETTING_KEY,
      JSON.stringify({
        version: ALERT_SOUND_SETTING_VERSION,
        enabled: alarmSoundEnabled
      })
    );
  } catch {
    /* 保存できなくても現在のタブでは設定を維持する。 */
  }
}

function loadNotifiedAlertIds() {
  try {
    const saved = JSON.parse(
      window.sessionStorage.getItem(NOTIFIED_ALERT_IDS_KEY) || "[]"
    );
    if (Array.isArray(saved)) {
      return new Set(saved.filter((value) => typeof value === "string"));
    }
  } catch {
    /* 保存値が壊れている場合は空の履歴から開始する。 */
  }
  return new Set();
}

function rememberNotifiedAlert(alertId) {
  notifiedAlertIds.add(alertId);
  try {
    window.sessionStorage.setItem(
      NOTIFIED_ALERT_IDS_KEY,
      JSON.stringify(Array.from(notifiedAlertIds).slice(-100))
    );
  } catch {
    /* 通知表示自体は継続する。 */
  }
}

function initializeAlarmNotification() {
  const stopButton =
    document.getElementById(
      "stopAlarmButton"
    );

  const restartButton =
    document.getElementById(
      "restartAlarmButton"
    );

  const modal =
    document.getElementById(
      "alarmModal"
    );

  if (stopButton) {
    stopButton.addEventListener(
      "click",
      stopCurrentAlarmLocally
    );
  }

  modal?.addEventListener(
    "keydown",
    handleAlarmModalKeydown
  );

  if (restartButton) {
    restartButton.addEventListener(
      "click",
      () => {
        void enableAlarmSoundForCurrentAlert();
      }
    );
  }

  window.addEventListener("storage", (event) => {
    if (event.key !== ALERT_SOUND_SETTING_KEY) return;
    alarmSoundEnabled = loadAlarmSoundPreference();
    alarmSoundError = "";
    if (!alarmSoundEnabled) {
      closeAlarmNotification();
    }
    updateAllAlarmSoundControls();
  });

  updateAllAlarmSoundControls();
}


function stopCurrentAlarmLocally() {
  closeAlarmNotification();
}


function handleAlarmModalKeydown(event) {
  const modal =
    document.getElementById(
      "alarmModal"
    );
  if (
    !modal ||
    modal.classList.contains("hidden") ||
    event.key !== "Escape"
  ) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  closeAlarmNotification();
}


function getAlarmAudioContext() {
  const AudioContextClass =
    window.AudioContext ||
    window.webkitAudioContext;

  if (!AudioContextClass) {
    return null;
  }

  if (!alarmAudioContext) {
    alarmAudioContext =
      new AudioContextClass();

    alarmAudioContext.addEventListener?.(
      "statechange",
      () => {
        updateAllAlarmSoundControls();
      }
    );
  }

  return alarmAudioContext;
}


async function unlockAlarmAudio() {
  const context =
    getAlarmAudioContext();

  if (!context) {
    return false;
  }

  try {
    if (
      context.state ===
      "suspended"
    ) {
      await context.resume();
    }

    /*
      Safariで、テストボタンを押した操作を
      通知音の再生許可として記憶させる。
    */
    const oscillator =
      context.createOscillator();

    const gain =
      context.createGain();

    gain.gain.setValueAtTime(
      0.0001,
      context.currentTime
    );

    oscillator.connect(gain);
    gain.connect(
      context.destination
    );

    oscillator.start();
    oscillator.stop(
      context.currentTime + 0.01
    );

    const ready = context.state === "running";
    updateAllAlarmSoundControls();
    return ready;
  } catch (error) {
    console.warn(
      "通知音の再生準備に失敗しました。",
      error
    );

    updateAllAlarmSoundControls();

    return false;
  }
}


async function enableAlarmAudio(audience) {
  const wasEnabled = alarmSoundEnabled;
  const ready = await unlockAlarmAudio();
  if (ready) {
    saveAlarmSoundPreference(true);
    alarmSoundError = "";
  } else {
    if (!wasEnabled) saveAlarmSoundPreference(false);
    alarmSoundError =
      "通知音を有効にできませんでした。ブラウザの音声設定を確認してください。";
  }
  updateAllAlarmSoundControls();
  return ready;
}

async function toggleAlarmSoundPreference(audience) {
  if (alarmSoundEnabled) {
    saveAlarmSoundPreference(false);
    alarmSoundError = "";
    closeAlarmNotification();
    updateAllAlarmSoundControls();
    return;
  }

  const ready = await enableAlarmAudio(audience);
  if (ready && currentAlarmAlertContext) {
    await startAlarmSound();
  }
}

async function enableAlarmSoundForCurrentAlert() {
  const audience = currentAlarmAlertContext?.audience || "OWNER";
  const ready = await enableAlarmAudio(audience);
  if (ready && currentAlarmAlertContext) {
    await startAlarmSound();
  }
}

function updateAllAlarmSoundControls() {
  updateAlarmAudioReadiness("OWNER");
  updateAlarmAudioReadiness("NOTIFICATION_MEMBER");
}

function alarmAudioReadiness() {
  if (!window.AudioContext && !window.webkitAudioContext) {
    return "UNAVAILABLE";
  }
  return alarmAudioContext?.state === "running"
    ? "READY"
    : "NEEDS_USER_GESTURE";
}


function updateAlarmAudioReadiness(audience) {
  const owner = audience === "OWNER";
  const status = document.getElementById(
    owner ? "ownerAudioStatus" : "notificationMemberAudioStatus"
  );
  const button = document.getElementById(
    owner ? "ownerEnableAudioButton" : "notificationMemberEnableAudioButton"
  );
  const container = status?.closest(".alert-audio-readiness");
  const toggle = document.getElementById(
    owner ? "ownerSoundToggleButton" : "notificationMemberSoundToggleButton"
  );
  if (!status || !button || !toggle) return;

  const readiness = alarmAudioReadiness();
  const ready = alarmSoundEnabled && readiness === "READY";
  const needsGesture =
    alarmSoundEnabled && readiness === "NEEDS_USER_GESTURE";
  const unavailable = readiness === "UNAVAILABLE";
  const label = alarmSoundEnabled
    ? needsGesture
      ? "通知音 ON・有効化必要"
      : "通知音 ON"
    : "通知音 OFF";

  status.textContent = alarmSoundError
    ? alarmSoundError
    : !alarmSoundEnabled
      ? "通知音はOFFです。緊急通知はベルから確認できます。"
      : unavailable
        ? "このブラウザでは通知音を利用できません。緊急通知はベルから確認できます。"
        : ready
          ? "通知音を受け取る準備ができています。"
          : "ブラウザの制限により、最初に一度だけ通知音を有効にしてください。";
  button.textContent = alarmSoundEnabled
    ? "通知音を有効にする"
    : "通知音をONにする";
  button.classList.toggle("hidden", ready || unavailable);
  container?.classList.toggle("ready", ready);
  container?.classList.toggle("off", !alarmSoundEnabled);
  container?.classList.toggle("error", Boolean(alarmSoundError));

  toggle.classList.toggle("off", !alarmSoundEnabled);
  toggle.classList.toggle("needs-gesture", needsGesture);
  toggle.setAttribute("aria-pressed", String(alarmSoundEnabled));
  toggle.setAttribute("aria-label", `${label}。押すと切り替えます。`);
  toggle.setAttribute("title", `${label}。押すと切り替えます。`);
  const toggleLabel = toggle.querySelector(".sound-toggle-label");
  if (toggleLabel) toggleLabel.textContent = label;
  const icon = toggle.querySelector("[aria-hidden='true']");
  if (icon) icon.textContent = alarmSoundEnabled ? "🔊" : "🔇";
}


function scheduleAlarmTone(
  context,
  startTime,
  frequency,
  duration
) {
  const oscillator =
    context.createOscillator();

  const gain =
    context.createGain();

  oscillator.type = "square";

  oscillator.frequency
    .setValueAtTime(
      frequency,
      startTime
    );

  gain.gain.setValueAtTime(
    0.0001,
    startTime
  );

  gain.gain
    .exponentialRampToValueAtTime(
      0.28,
      startTime + 0.02
    );

  gain.gain.setValueAtTime(
    0.28,
    startTime + duration - 0.04
  );

  gain.gain
    .exponentialRampToValueAtTime(
      0.0001,
      startTime + duration
    );

  oscillator.connect(gain);
  gain.connect(
    context.destination
  );

  alarmActiveNodes.push(
    oscillator
  );

  oscillator.addEventListener(
    "ended",
    () => {
      alarmActiveNodes =
        alarmActiveNodes.filter(
          (node ) =>
            node !== oscillator
        );

      oscillator.disconnect();
      gain.disconnect();
    },
    {
      once: true
    }
  );

  oscillator.start(startTime);

  oscillator.stop(
    startTime + duration
  );
}


function playAlarmPattern() {
  if (!alarmIsActive || !alarmSoundEnabled) {
    return;
  }

  if (alarmRepeatTimer) {
    window.clearTimeout(
      alarmRepeatTimer
    );
  }

  const context =
    getAlarmAudioContext();

  if (
    !context ||
    context.state !== "running"
  ) {
    showAlarmAudioFallback();
    return;
  }

  const status =
    document.getElementById(
      "alarmSoundStatus"
    );

  const restartButton =
    document.getElementById(
      "restartAlarmButton"
    );

  if (status) {
    status.textContent =
      "通知音が鳴っています。「この端末の通知音を停止」を押すまで繰り返します。";
  }

  if (restartButton) {
    restartButton.classList.add(
      "hidden"
    );
  }

  const startTime =
    context.currentTime + 0.03;

  scheduleAlarmTone(
    context,
    startTime,
    880,
    0.22
  );

  scheduleAlarmTone(
    context,
    startTime + 0.32,
    1175,
    0.22
  );

  scheduleAlarmTone(
    context,
    startTime + 0.64,
    880,
    0.22
  );

  alarmRepeatTimer =
    window.setTimeout(
      playAlarmPattern,
      1300
    );
}


async function startAlarmSound() {
  stopAlarmSound();
  if (!alarmSoundEnabled) {
    updateAlarmModalSoundStatus();
    return;
  }
  alarmIsActive = true;

  const isReady =
    await unlockAlarmAudio();

  if (!alarmIsActive) {
    return;
  }

  if (!isReady) {
    showAlarmAudioFallback();
    return;
  }

  playAlarmPattern();
}


function showAlarmAudioFallback() {
  const status =
    document.getElementById(
      "alarmSoundStatus"
    );

  const restartButton =
    document.getElementById(
      "restartAlarmButton"
    );

  if (status) {
    status.textContent =
      "ブラウザが通知音をブロックしました。「通知音を鳴らす」を押してください。";
  }

  if (restartButton) {
    restartButton.classList.remove(
      "hidden"
    );
  }
}


function updateAlarmModalSoundStatus() {
  const status =
    document.getElementById(
      "alarmSoundStatus"
    );
  const restartButton =
    document.getElementById(
      "restartAlarmButton"
    );
  if (!status || !restartButton) return;

  if (!alarmSoundEnabled) {
    status.textContent =
      "通知音はOFFです。緊急通知はベルから確認できます。";
    restartButton.textContent =
      "通知音をONにする";
    restartButton.classList.remove(
      "hidden"
    );
    return;
  }

  restartButton.textContent =
    "通知音を鳴らす";
}


function stopAlarmSound() {
  alarmIsActive = false;

  if (alarmRepeatTimer) {
    window.clearTimeout(
      alarmRepeatTimer
    );

    alarmRepeatTimer = null;
  }

  alarmActiveNodes.forEach(
    (oscillator ) => {
      try {
        oscillator.stop();
      } catch (error) {
        /* すでに停止済みの場合は何もしない。 */
      }

      try {
        oscillator.disconnect();
      } catch (error) {
        /* すでに切断済みの場合は何もしない。 */
      }
    }
  );

  alarmActiveNodes = [];
}


function showAlarmNotification(
  keyword,
  detectedAt,
  alertContext = null
) {
  const modal =
    document.getElementById(
      "alarmModal"
    );

  if (!modal) {
    return;
  }

  const keywordElement =
    document.getElementById(
      "alarmKeyword"
    );

  const detectedAtElement =
    document.getElementById(
      "alarmDetectedAt"
    );

  const status =
    document.getElementById(
      "alarmSoundStatus"
    );

  const kindBadge =
    document.getElementById(
      "alarmKindBadge"
    );

  const eyebrow =
    document.getElementById(
      "alarmEyebrow"
    );

  const message =
    document.getElementById(
      "alarmMessage"
    );

  const restartButton =
    document.getElementById(
      "restartAlarmButton"
    );

  const stopButton =
    document.getElementById(
      "stopAlarmButton"
    );

  alarmFocusBeforeOpen =
    document.activeElement;
  currentAlarmAlertContext =
    alertContext;

  const isTest =
    alertContext?.kind === "TEST";

  kindBadge?.classList.toggle(
    "hidden",
    !isTest
  );

  if (eyebrow) {
    eyebrow.textContent = isTest
      ? "テストメールを検知しました"
      : "メールを検知しました";
  }

  if (message) {
    message.textContent = isTest
      ? "本番と同じ通知経路で配信されたテスト通知です。"
      : "登録キーワードを含むメールを検知しました。";
  }

  if (keywordElement) {
    keywordElement.textContent =
      `「${keyword}」`;
  }

  if (detectedAtElement) {
    const formatted =
      formatAlarmDetectedAt(
        detectedAt
      );

    detectedAtElement.textContent =
      formatted
        ? `検知時刻：${formatted}`
        : "";
  }

  if (status) {
    status.textContent =
      "通知音を準備しています。";
  }

  if (restartButton) {
    restartButton.classList.add(
      "hidden"
    );
  }

  modal.classList.remove(
    "hidden"
  );

  if (stopButton) {
    stopButton.textContent =
      "この端末の通知音を停止";
    stopButton.focus();
  }

  if (alarmSoundEnabled) {
    void startAlarmSound();
  } else {
    updateAlarmModalSoundStatus();
  }
}


function closeAlarmNotification() {
  stopAlarmSound();

  const modal =
    document.getElementById(
      "alarmModal"
    );

  const status =
    document.getElementById(
      "alarmSoundStatus"
    );

  const restartButton =
    document.getElementById(
      "restartAlarmButton"
    );

  if (modal) {
    modal.classList.add(
      "hidden"
    );
  }

  if (restartButton) {
    restartButton.classList.add(
      "hidden"
    );
  }

  if (status) {
    status.textContent = "";
  }

  if (
    alarmFocusBeforeOpen &&
    typeof alarmFocusBeforeOpen.focus ===
      "function"
  ) {
    alarmFocusBeforeOpen.focus();
  }

  alarmFocusBeforeOpen = null;
  currentAlarmAlertContext = null;
}


function formatAlarmDetectedAt(value) {
  if (!value) {
    return "";
  }

  const date =
    new Date(value);

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return "";
  }

  return new Intl.DateTimeFormat(
    "ja-JP",
    {
      dateStyle: "medium",
      timeStyle: "medium"
    }
  ).format(date);
}


/* ========================================
   通知テスト
======================================== */

function renderTestKeywordCards() {
  const container =
    document.getElementById(
      "testKeywordCards"
    );

  if (!container) {
    return;
  }

  container.innerHTML = "";

  if (keywords.length === 0) {
    const empty =
      document.createElement("article");
    empty.className =
      "card test-empty-card";
    const message =
      document.createElement("p");
    message.textContent =
      "通知キーワードが設定されていません。";
    const button =
      document.createElement("button");
    button.type = "button";
    button.className = "btn primary";
    button.textContent =
      "契約内容を設定する";
    button.addEventListener(
      "click",
      () => {
        showAppPage("keywordPage");
      }
    );
    empty.append(message, button);
    container.appendChild(empty);
    updateContractStatusUI();
    return;
  }

  keywords.forEach((keyword) => {
    const card =
      document.createElement(
        "article"
      );

    card.className =
      "test-card";

    card.innerHTML = `
      <h2>
        🔔 ${escapeHtml(keyword)}テスト
      </h2>

      <p>
        「${escapeHtml(keyword)}」を検知した場合の
        テスト通知を送信します。
      </p>

      <button
        type="button"
        class="test-button"
      >
        テストを実行
      </button>
    `;

    const button =
      card.querySelector(
        ".test-button"
      );

    if (button) {
      button.addEventListener(
        "click",
        async () => {
          await unlockAlarmAudio();
          await testNotification(
            keyword,
            button
          );
        }
      );
    }

    container.appendChild(card);
  });

  updateContractStatusUI();
}
async function testNotification(keyword, button) {
  const testButtons =
    document.querySelectorAll(
      ".test-button"
    );
  let serverTest = null;

  try {
    setText("notificationTestError", "");
    setText("notificationTestStatus", "");
    if (isContractExpired()) {
      setText(
        "notificationTestError",
        "契約期限が切れています。契約を更新してください。"
      );
      return;
    }

    if (!TEST_API_URL || !TEST_API_TOKEN) {
      setText(
        "notificationTestError",
        "テストAPIのURLまたはトークンが設定されていません。"
      );
      return;
    }

    const connection =
      findNotificationTestConnection(keyword);
    if (!currentTeam || currentTeam.role !== "OWNER") {
      setText(
        "notificationTestError",
        "通知テストは契約の管理者だけが実行できます。"
      );
      return;
    }
    if (!connection) {
      setText(
        "notificationTestError",
        "このキーワードを監視している有効なメールアカウントがありません。"
      );
      return;
    }

    testButtons.forEach((testButton) => {
      testButton.dataset.originalText =
        testButton.textContent.trim();

      testButton.disabled = true;
      testButton.textContent =
        "少々お待ちください";
    });

    serverTest = await startServerNotificationTest(
      connection.id,
      keyword
    );

    if (serverTest.status === "DETECTED") {
      await confirmServerNotificationTest(serverTest);
      setText(
        "notificationTestStatus",
        "テスト通知を配信しました。管理者と有効な参加者へ通知しています。"
      );
      return;
    }

    /*
      Apps Scriptへテスト送信を依頼
    */
    try {
      const response = await fetch(
        TEST_API_URL,
        {
          method: "POST",
          redirect: "follow",
          body: JSON.stringify({
            action: "sendTest",
            token: TEST_API_TOKEN,
            // キーワードはJSON本文で送り、URLやGmail検索式へ連結しない。
            keyword: keyword,
            requestId: serverTest.requestId
          })
        }
      );

      const result = await response.json();

      if (!result.ok) {
        throw new Error(
          `SERVER:${
            result.error ||
            "送信が拒否されました"
          }`
        );
      }
    } catch (error) {
      /*
        Apps Scriptには届いていても、
        ブラウザが応答を取得できない場合がある。
        サーバーから明確に拒否された場合だけ停止する。
      */
      if (
        String(error.message)
          .startsWith("SERVER:")
      ) {
        await failServerNotificationTest(
          serverTest,
          "DELIVERY_REQUEST_FAILED"
        );
        throw error;
      }

      console.warn(
        "送信結果を読み取れませんでしたが、検知確認を続けます。",
        error
      );
    }

    const detectedStatus =
      await waitForTestDetection(
        serverTest.requestId,
        TEST_DETECTION_TIMEOUT_MS
      );

    if (detectedStatus) {
      await confirmServerNotificationTest(
        serverTest
      );
      setText(
        "notificationTestStatus",
        "テスト通知を配信しました。管理者と有効な参加者へ通知しています。"
      );
    } else {
      await expireServerNotificationTest(
        serverTest
      );
      setText(
        "notificationTestError",
        "3分以内にテストメールの検知を確認できなかったため、参加者へのテスト通知は送信されませんでした。"
      );
    }
  } catch (error) {
    console.error(
      "テスト処理に失敗しました。",
      error
    );

    setText(
      "notificationTestError",
      notificationTestErrorMessage(error)
    );
  } finally {
    testButtons.forEach((testButton) => {
      testButton.disabled = false;

      testButton.textContent =
        testButton.dataset.originalText ||
        "テストを実行";

      delete testButton.dataset.originalText;
    });
  }
}

function findNotificationTestConnection(keyword) {
  const normalizedKeyword =
    keyword
      .trim()
      .replace(/[ \u00a0\u3000]+/gu, " ")
      .normalize("NFKC")
      .toLocaleLowerCase("ja-JP");
  return mailConnections.find(
    (connection) =>
      connection.connectionStatus === "ACTIVE" &&
      connection.authorizationStatus === "ACTIVE" &&
      connection.keywords.some(
        (candidate) =>
          candidate
            .trim()
            .replace(/[ \u00a0\u3000]+/gu, " ")
            .normalize("NFKC")
            .toLocaleLowerCase("ja-JP") ===
          normalizedKeyword
      )
  ) || null;
}

async function startServerNotificationTest(
  mailConnectionId,
  keyword
) {
  const response = await fetch(
    apiUrl(
      `/api/v1/teams/${encodeURIComponent(currentTeam.id)}/notification-tests`
    ),
    {
      method: "POST",
      credentials: "include",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        mailConnectionId,
        keyword
      })
    }
  );
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.test?.id || !payload.test.requestId) {
    const error = new Error(
      payload?.error?.message ||
        "通知テストを開始できませんでした。"
    );
    error.code = payload?.error?.code || "NOTIFICATION_TEST_START_FAILED";
    throw error;
  }
  return payload.test;
}

async function confirmServerNotificationTest(test) {
  const response = await fetch(
    apiUrl(
      `/api/v1/teams/${encodeURIComponent(currentTeam.id)}/notification-tests/${encodeURIComponent(test.id)}/confirm`
    ),
    {
      method: "POST",
      credentials: "include",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ requestId: test.requestId })
    }
  );
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.test?.status !== "ALERT_CREATED") {
    const error = new Error(
      payload?.error?.message ||
        "検知結果をテスト通知として配信できませんでした。"
    );
    error.code = payload?.error?.code || "NOTIFICATION_TEST_CONFIRM_FAILED";
    throw error;
  }
  await refreshOwnerAlerts();
  return payload.test;
}

async function failServerNotificationTest(test, reasonCode) {
  await updateServerNotificationTest(
    test,
    "fail",
    { requestId: test.requestId, reasonCode }
  );
}

async function expireServerNotificationTest(test) {
  await updateServerNotificationTest(
    test,
    "expire",
    { requestId: test.requestId }
  );
}

async function updateServerNotificationTest(test, action, body) {
  const response = await fetch(
    apiUrl(
      `/api/v1/teams/${encodeURIComponent(currentTeam.id)}/notification-tests/${encodeURIComponent(test.id)}/${action}`
    ),
    {
      method: "POST",
      credentials: "include",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(
      payload?.error?.message ||
        "通知テストの状態を更新できませんでした。"
    );
  }
}

function notificationTestErrorMessage(error) {
  if (error?.code === "NOTIFICATION_TEST_RATE_LIMITED") {
    return "通知テストが続いています。少し時間をおいてお試しください。";
  }
  const message =
    error instanceof Error
      ? error.message.replace("SERVER:", "")
      : "通知テストを完了できませんでした。";
  return `テスト処理に失敗しました。${message}`;
}

/* ========================================
   Gmailで検知されるまで確認する
======================================== */

function parseJsonSafely(value) {
  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    return null;
  }
}


function extractTestDetectionStatus(result) {
  const parsedResult =
    parseJsonSafely(result);

  if (
    !parsedResult ||
    typeof parsedResult !== "object"
  ) {
    return null;
  }

  const candidates = [
    parsedResult.status,
    parsedResult.state
      ? parsedResult
      : null,
    parsedResult.data &&
      parsedResult.data.status,
    parsedResult.data
  ];

  for (const candidate of candidates) {
    const parsedCandidate =
      parseJsonSafely(candidate);

    if (
      parsedCandidate &&
      typeof parsedCandidate === "object" &&
      typeof parsedCandidate.state === "string"
    ) {
      return parsedCandidate;
    }
  }

  return null;
}


async function waitForTestDetection(
  requestId,
  timeoutMilliseconds
) {
  const endTime =
    Date.now() +
    timeoutMilliseconds;

  while (
    Date.now() <
    endTime
  ) {
    /*
      3秒ごとに検知状況を確認する。
    */
    await sleep(3000);

    try {
      const statusUrl =
        new URL(
          TEST_API_URL
        );

      statusUrl.searchParams.set(
        "action",
        "status"
      );

      statusUrl.searchParams.set(
        "token",
        TEST_API_TOKEN
      );

      statusUrl.searchParams.set(
        "requestId",
        requestId
      );

      /*
        キャッシュされた古い結果を
       表示しないようにする。
      */
      statusUrl.searchParams.set(
        "time",
        String(Date.now())
      );

      const response =
        await fetch(
          statusUrl.toString(),
          {
            method: "GET",
            cache: "no-store",
            redirect: "follow"
          }
        );

      if (!response.ok) {
        throw new Error(
          `status_http_${response.status}`
        );
      }

      const responseText =
        await response.text();

      const result =
        parseJsonSafely(
          responseText
        );

      const status =
        extractTestDetectionStatus(
          result
        );

      if (
        status &&
        status.state ===
          "detected"
      ) {
        return status;
      }

    } catch (error) {
      console.warn(
        "検知状況の確認に失敗しました。",
        error
      );
    }

  }

  return null;
}


/* ========================================
   指定時間待つ
======================================== */

function sleep(milliseconds) {
  return new Promise(
    (resolve) => {
      window.setTimeout(
        resolve,
        milliseconds
      );
    }
  );
}


/* ========================================
   旧お問い合わせフォームの保存情報を削除
======================================== */

function clearLegacyContactInfo() {
  try {
    localStorage.removeItem(
      "callNowContactInfo"
    );
  } catch (error) {
    console.error(
      "旧お問い合わせ情報の削除に失敗しました。",
      error
    );
  }
}


/* ========================================
   GASの旧お問い合わせ処理
======================================== */

/*
  GAS側のsendContact actionは後方互換のため残す。
  現在のフロントエンドからは呼び出さない。
*/


/* ========================================
   画面切り替え
======================================== */

function showOnlyScreen(screenId) {
  const authenticatedScreens = new Set([
    "setupScreen",
    "paymentScreen",
    "contractChangeCheckoutScreen",
    "renewalCompleteScreen",
    "appScreen"
  ]);

  if (
    screenId === "googleScreen" &&
    googleScreenMode === "manage" &&
    !authenticatedUser
  ) {
    openGoogleScreen("login");
    return;
  }

  if (
    authenticatedScreens.has(screenId) &&
    !authenticatedUser
  ) {
    openOwnerSetup();
    return;
  }

  if (
    screenId === "notificationMemberAppScreen" &&
    !notificationMemberSession
  ) {
    openNotificationMemberLogin();
    return;
  }

  if (screenId !== "appScreen") {
    closeNotificationMemberCreateForm();
    closeNotificationMemberLoginInfo();
    closeNotificationMemberCredential();
  }

  const screenIds = [
    "guestHomeScreen",
    "ownerMonitoringSetupScreen",
    "notificationMemberLoginScreen",
    "notificationMemberAppScreen",
    "setupScreen",
    "paymentScreen",
    "contractChangeCheckoutScreen",
    "renewalCompleteScreen",
    "googleScreen",
    "appScreen"
  ];

  screenIds.forEach((id) => {
    const screen =
      document.getElementById(id);

    if (screen) {
      screen.classList.toggle(
        "hidden",
        id !== screenId
      );
    }
  });
}


/* ========================================
   共通処理
======================================== */

function setText(elementId, text) {
  const element =
    document.getElementById(
      elementId
    );

  if (element) {
    element.textContent =
      text;
  }
}


function escapeHtml(value) {
  return String(value)
    .replaceAll(
      "&",
      "&amp;"
    )
    .replaceAll(
      "<",
      "&lt;"
    )
    .replaceAll(
      ">",
      "&gt;"
    )
    .replaceAll(
      '"',
      "&quot;"
    )
    .replaceAll(
      "'",
      "&#039;"
    );
}
window.openKeywordEdit = function () {
  setupMode = "edit";

  showOnlyScreen("setupScreen");
  renderKeywordInputs();
  updateSetupScreenText();

  window.scrollTo({
    top: 0
  });
  };
