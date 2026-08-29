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

const APP_BUILD_VERSION =
  "2026-08-29.3";

/*
  正式なURLが決まった場合だけ設定する公開リンク。
  お知らせは将来APIから同じtitle/url形式で取得できる。
*/
const announcements = Object.freeze([]);
const supportUrl = "";
const appStoreUrl = "";
const googlePlayUrl = "";

let alarmAudioContext = null;
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
let ownerAlerts = [];
let notificationMemberAlerts = [];
let alertEventSource = null;
let currentAlarmAlertContext = null;
const notifiedAlertIds = new Set();
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
    destination ===
    ownerOnboardingRouting.destinations.MONITORING_CONFIRMATION
  ) {
    openMonitoringConfirmation();
  } else {
    openApp();
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
  renderAnnouncements();
  renderHelpExternalLinks();

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
    synchronizeContractFromCurrentTeam();

    if (hasActiveSubscription()) {
      mailProviderAvailability =
        await fetchMailProviderAvailability();
      mailConnections =
        await fetchMailConnections();
      if (currentTeam?.role === "OWNER") {
        notificationMemberManagement =
          await fetchNotificationMembers();
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
    currentTeam.subscription.currentTermAmountYen;
  saveData();
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
    ? "未設定"
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
      "Call Nowを利用するには、少なくとも1つの監視アカウントを設定してください。"
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
  renderAlertList(
    "notificationMemberAlertList",
    notificationMemberAlerts,
    "NOTIFICATION_MEMBER"
  );
  void refreshNotificationMemberAlerts();
  startNotificationMemberAlertStream();
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
  stopAlertEventStream();
  openGuestHome();
}


async function fetchOwnerAlerts() {
  if (!currentTeam || currentTeam.role !== "OWNER") {
    return [];
  }
  return fetchAlerts(
    `/api/v1/teams/${encodeURIComponent(currentTeam.id)}/alerts`,
  );
}

async function fetchNotificationMemberAlerts() {
  if (!notificationMemberSession) {
    return [];
  }
  return fetchAlerts("/api/v1/notification-members/alerts");
}

async function fetchAlerts(path) {
  try {
    const response = await fetch(apiUrl(path), {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) {
      return [];
    }
    const payload = await response.json();
    return Array.isArray(payload.alerts) ? payload.alerts : [];
  } catch {
    return [];
  }
}

async function refreshOwnerAlerts() {
  ownerAlerts = await fetchOwnerAlerts();
  applyAlertUpdate(ownerAlerts, "OWNER");
}

async function refreshNotificationMemberAlerts() {
  notificationMemberAlerts = await fetchNotificationMemberAlerts();
  applyAlertUpdate(notificationMemberAlerts, "NOTIFICATION_MEMBER");
}

function startOwnerAlertStream() {
  if (!currentTeam || currentTeam.role !== "OWNER") {
    stopAlertEventStream();
    return;
  }
  startAlertEventStream(
    `/api/v1/teams/${encodeURIComponent(currentTeam.id)}/alerts/events`,
    "OWNER",
  );
}

function startNotificationMemberAlertStream() {
  if (!notificationMemberSession) {
    stopAlertEventStream();
    return;
  }
  startAlertEventStream(
    "/api/v1/notification-members/alerts/events",
    "NOTIFICATION_MEMBER",
  );
}

function startAlertEventStream(path, audience) {
  stopAlertEventStream();
  if (typeof window.EventSource !== "function") {
    setAlertStreamStatus(audience, "再接続中", true);
    return;
  }
  const stream = new EventSource(apiUrl(path), {
    withCredentials: true,
  });
  alertEventSource = stream;
  setAlertStreamStatus(audience, "接続中", false);
  stream.addEventListener("alerts", (event) => {
    try {
      const payload = JSON.parse(event.data);
      const alerts = Array.isArray(payload.alerts) ? payload.alerts : [];
      if (audience === "OWNER") {
        ownerAlerts = alerts;
      } else {
        notificationMemberAlerts = alerts;
      }
      applyAlertUpdate(alerts, audience);
      setAlertStreamStatus(audience, "接続中", false);
    } catch {
      setAlertStreamStatus(audience, "再接続中", true);
    }
  });
  stream.addEventListener("session-ended", () => {
    stopAlertEventStream();
    if (audience === "NOTIFICATION_MEMBER") {
      notificationMemberSession = null;
      openNotificationMemberLogin();
    } else {
      authenticatedUser = null;
      resetOwnerOnboardingClientState();
      openGuestHome();
    }
  });
  stream.onerror = () => {
    setAlertStreamStatus(audience, "再接続中", true);
  };
}

function stopAlertEventStream() {
  if (alertEventSource) {
    alertEventSource.close();
    alertEventSource = null;
  }
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
  renderAlertList(
    audience === "OWNER" ? "ownerAlertList" : "notificationMemberAlertList",
    alerts,
    audience,
  );
  const current = currentAlarmAlertContext
    ? alerts.find((alert) => alert.id === currentAlarmAlertContext.alertId)
    : null;
  if (currentAlarmAlertContext && current?.status !== "ACTIVE") {
    closeAlarmNotification();
  }
  const nextAlert = alerts.find(
    (alert) => alert.status === "ACTIVE" && !notifiedAlertIds.has(alert.id),
  );
  if (nextAlert) {
    notifiedAlertIds.add(nextAlert.id);
    showAlarmNotification(nextAlert.matchedKeyword, nextAlert.detectedAt, {
      alertId: nextAlert.id,
      audience,
    });
  }
}

function renderAlertList(containerId, alerts, audience) {
  const container = document.getElementById(containerId);
  if (!container) return;
  if (alerts.length === 0) {
    container.innerHTML =
      '<p class="alert-list-empty">現在、確認が必要な通知はありません。</p>';
    return;
  }
  container.innerHTML = alerts
    .map((alert) => {
      const active = alert.status === "ACTIVE";
      const acknowledged = alert.status === "ACKNOWLEDGED";
      const acknowledgedByName =
        alert.acknowledgedByName ||
        (alert.acknowledgedBy === "OWNER" ? "代表者" : "通知メンバー");
      const statusText = active
        ? "未対応"
        : acknowledged
          ? `${acknowledgedByName}さんが対応中`
          : "対応完了";
      const actions = active
        ? `<button type="button" class="btn primary" onclick="acknowledgeAlert('${escapeHtml(alert.id)}', '${audience}')">対応を開始</button>`
        : audience === "OWNER" && acknowledged
          ? `<button type="button" class="btn outline" onclick="resolveAlert('${escapeHtml(alert.id)}')">対応完了にする</button>`
          : "";
      return `
        <article class="alert-list-item ${active ? "active" : ""}">
          <div>
            <h3>「${escapeHtml(alert.matchedKeyword)}」を検知</h3>
            <p class="alert-list-meta">
              ${escapeHtml(formatAlarmDetectedAt(alert.detectedAt))}・${escapeHtml(mailProviderLabel(alert.source.provider))}
            </p>
            <p class="alert-list-status">${escapeHtml(statusText)}</p>
          </div>
          <div class="alert-list-actions">${actions}</div>
        </article>
      `;
    })
    .join("");
}

async function acknowledgeAlert(alertId, audience) {
  const path =
    audience === "OWNER"
      ? `/api/v1/teams/${encodeURIComponent(currentTeam?.id || "")}/alerts/${encodeURIComponent(alertId)}/acknowledge`
      : `/api/v1/notification-members/alerts/${encodeURIComponent(alertId)}/acknowledge`;
  try {
    const response = await fetch(apiUrl(path), {
      method: "POST",
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error("alert_acknowledge_failed");
    const result = await response.json();
    if (audience === "OWNER") {
      await refreshOwnerAlerts();
    } else {
      await refreshNotificationMemberAlerts();
    }
    closeAlarmNotification();
    if (result.alreadyAcknowledged) {
      const acknowledgedByName =
        result.alert?.acknowledgedByName ||
        (result.alert?.acknowledgedBy === "OWNER" ? "代表者" : "通知メンバー");
      await showAppAlert(
        `すでに${acknowledgedByName}さんが対応を開始しています。`,
        { title: "対応開始済み" },
      );
    }
  } catch {
    await showAppAlert(
      "対応開始を記録できませんでした。通信状態を確認して、もう一度お試しください。",
      { title: "対応開始エラー" },
    );
  }
}

async function resolveAlert(alertId) {
  if (!currentTeam || currentTeam.role !== "OWNER") return;
  try {
    const response = await fetch(
      apiUrl(
        `/api/v1/teams/${encodeURIComponent(currentTeam.id)}/alerts/${encodeURIComponent(alertId)}/resolve`,
      ),
      {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json" },
      },
    );
    if (!response.ok) throw new Error("alert_resolve_failed");
    await refreshOwnerAlerts();
  } catch {
    await showAppAlert(
      "通知を対応完了にできませんでした。もう一度お試しください。",
      { title: "通知の更新エラー" },
    );
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
    showSetupError(
      validation.message
    );

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
  const value = Number(
    document.getElementById("ownerSeatCount")?.value
  );
  ownerSetupSeatCount =
    Number.isInteger(value) && value >= 1 && value <= 10
      ? value
      : 1;
  updatePrice();
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
      "ownerMonitoringSetupError",
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
    synchronizeContractFromCurrentTeam();
    saveData();
    openMonitoringConfirmation();
  } catch (error) {
    await showAppAlert(
      error instanceof Error
        ? error.message
        : "契約情報を保存できませんでした。通信状態を確認して、もう一度お試しください。",
      { title: "契約処理のエラー" }
    );
  } finally {
    if (button) button.disabled = false;
  }
}


function openMonitoringConfirmation() {
  if (
    !authenticatedUser ||
    !currentTeam ||
    !ownerOnboarding ||
    !["PURCHASED", "COMPLETED"].includes(
      ownerOnboarding.status
    )
  ) {
    if (authenticatedUser && currentTeam) {
      openApp();
    } else {
      openOwnerSetup();
    }
    return;
  }
  showOnlyScreen("monitoringConfirmationScreen");
  setText("monitoringConfirmationError", "");
  renderMonitoringConfirmation();
  window.scrollTo({ top: 0 });
}


function renderMonitoringConfirmation() {
  const container =
    document.getElementById("monitoringConfirmationList");
  const finishButton =
    document.getElementById(
      "finishMonitoringConfirmationButton"
    );
  if (!container || !finishButton) return;
  const choices =
    ownerOnboarding?.choices?.filter(
      (choice) => choice.email && choice.status !== "SKIPPED"
    ) ?? [];
  container.innerHTML = choices
    .map((choice) => {
      const isActivated = choice.status === "ACTIVATED";
      const isDeferred = choice.status === "DEFERRED";
      const question =
        choice.provider === "MICROSOFT"
          ? "このMicrosoft 365アカウントを監視しますか？"
          : "このGmailアカウントを監視しますか？";
      return `
        <article class="monitoring-confirmation-card">
          <p class="small-label">${escapeHtml(mailProviderLabel(choice.provider))}</p>
          <h2>${question}</h2>
          <p class="confirmation-email">${escapeHtml(choice.email)}</p>
          <p class="input-help">設定完了後も変更できます。</p>
          <div class="monitoring-provider-actions">
            <button
              type="button"
              class="btn primary"
              onclick="activateOwnerMonitoringChoice('${choice.id}')"
              ${isActivated ? "disabled" : ""}
            >${isActivated ? "監視設定済み" : "このアカウントを監視する"}</button>
            <button
              type="button"
              class="btn outline"
              onclick="deferOwnerMonitoringChoice('${choice.id}')"
              ${isActivated || isDeferred ? "disabled" : ""}
            >${isDeferred ? "あとで変更を選択済み" : "あとで変更"}</button>
          </div>
        </article>
      `;
    })
    .join("");
  finishButton.disabled = choices.some(
    (choice) => choice.status === "AUTHORIZED"
  );
}


async function updateOwnerMonitoringChoice(choiceId, action) {
  if (
    !ownerOnboarding ||
    !["activate", "defer"].includes(action)
  ) {
    return;
  }
  setText("monitoringConfirmationError", "");
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
          "監視アカウントの設定を保存できませんでした。"
      );
    }
    ownerOnboarding = result;
    renderMonitoringConfirmation();
  } catch (error) {
    setText(
      "monitoringConfirmationError",
      error instanceof Error
        ? error.message
        : "監視アカウントの設定を保存できませんでした。"
    );
  }
}


function activateOwnerMonitoringChoice(choiceId) {
  return updateOwnerMonitoringChoice(choiceId, "activate");
}


function deferOwnerMonitoringChoice(choiceId) {
  return updateOwnerMonitoringChoice(choiceId, "defer");
}


async function finishOwnerOnboarding() {
  if (
    ownerOnboarding?.choices?.some(
      (choice) => choice.status === "AUTHORIZED"
    )
  ) {
    setText(
      "monitoringConfirmationError",
      "各アカウントで、監視を始めるかあとで変更するかを選んでください。"
    );
    return;
  }
  mailProviderAvailability =
    await fetchMailProviderAvailability();
  mailConnections =
    await fetchMailConnections();
  notificationMemberManagement =
    await fetchNotificationMembers();
  ownerAlerts = await fetchOwnerAlerts();
  openApp();
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
      : "アカウント設定"
  );

  setText(
    "googleScreenDescription",
    isAuthenticationMode
      ? "利用するアカウントを選んでください。認証後はホームへ進みます。"
      : "ログイン方法と、メール監視用アカウントを別々に管理できます。"
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
  const showAccountManagement =
    googleScreenMode === "manage";
  const mailAccountCard =
    document.getElementById(
      "mailMonitoringAccountCard"
    );

  if (accountCard) {
    accountCard.classList.toggle(
      "hidden",
      !showAccountManagement
    );
  }

  if (mailAccountCard) {
    mailAccountCard.classList.toggle(
      "hidden",
      !showAccountManagement
    );
  }

  updateGoogleAuthActionText();

  accountList.innerHTML = "";

  if (showAccountManagement && loginIdentities.length === 0) {
    const emptyMessage =
      document.createElement("p");

    emptyMessage.className =
      "google-account-empty";

    emptyMessage.textContent =
      "ログイン方法を確認できませんでした。";

    accountList.appendChild(
      emptyMessage
    );
  } else if (showAccountManagement) {
    loginIdentities.forEach((identity) => {
      const accountItem =
        document.createElement("div");
      accountItem.className =
        "linked-google-account";
      const canRemove =
        loginIdentities.length > 1;
      accountItem.innerHTML = `
        <span class="account-avatar small-avatar">${loginProviderMark(identity.provider)}</span>
        <span class="linked-google-email">
          <strong>${loginProviderLabel(identity.provider)}</strong><br>
          ${escapeHtml(identity.email)}
        </span>
        <span class="linked-google-actions">
          <button
            type="button"
            class="account-remove-button"
            ${canRemove ? "" : "disabled"}
            onclick="unlinkLoginIdentity('${identity.provider}')"
          >
            ${canRemove ? "ログイン連携を解除" : "最後のログイン方法"}
          </button>
        </span>
      `;
      accountList.appendChild(accountItem);
    });
  }

  renderMailMonitoringAccount();
}


function updateGoogleAuthActionText() {
  const authCard =
    document.getElementById(
      "googleAuthCard"
    );

  if (authCard) {
    authCard.classList.remove("hidden");
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


async function activateDeferredOwnerMonitoring(choiceId) {
  await updateOwnerMonitoringChoice(choiceId, "activate");
  mailConnections = await fetchMailConnections();
  renderMailMonitoringAccount();
  renderConnectedGoogleAccounts();
  renderHomeSetupNotices();
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
    renderHomeSetupNotices();
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
  if (!card || !summary || !list || !createButton) return;
  const canManage =
    currentTeam?.role === "OWNER" &&
    hasActiveSubscription();
  card.classList.toggle("hidden", !canManage);
  if (!canManage) return;

  const seats = notificationMemberManagement?.seats;
  const members = notificationMemberManagement?.members ?? [];
  if (!seats) {
    summary.textContent =
      "通知メンバー情報を読み込めませんでした。";
    list.replaceChildren();
    createButton.disabled = true;
    return;
  }
  summary.innerHTML = `
    <div class="member-seat-item">
      <span>契約利用人数</span>
      <strong>${seats.seatCount}人</strong>
    </div>
    <div class="member-seat-item">
      <span>通知メンバー</span>
      <strong>${seats.activeNotificationMemberCount}人</strong>
    </div>
    <div class="member-seat-item">
      <span>空き人数</span>
      <strong>${seats.availableSeats}人</strong>
    </div>
  `;
  if (seats.pendingSeatCount !== null) {
    summary.insertAdjacentHTML(
      "beforeend",
      `<p class="error-message">${seats.pendingSeatCount}人への変更は、利用人数が上限以下になるまで保留中です。</p>`
    );
  }
  createButton.disabled =
    seats.availableSeats <= 0 ||
    seats.pendingSeatCount !== null;
  list.replaceChildren();
  if (members.length === 0) {
    const empty = document.createElement("p");
    empty.className = "input-help";
    empty.textContent = "通知メンバーはまだ登録されていません。";
    list.appendChild(empty);
    return;
  }
  members.forEach((member) => {
    const item = document.createElement("div");
    item.className = "notification-member-item";
    const active = member.status === "ACTIVE";
    item.innerHTML = `
      <div>
        <strong>${escapeHtml(member.displayName || "通知メンバー")}</strong>
        <div class="notification-member-id">${escapeHtml(member.callNowId)}</div>
        <small>${active ? "利用中" : "無効"}</small>
      </div>
      <div class="notification-member-actions">
        ${active ? `
          <button type="button" class="btn outline" onclick="resetNotificationMemberPassword('${member.id}')">
            パスワード再発行
          </button>
          <button type="button" class="btn outline" onclick="disableNotificationMember('${member.id}')">
            利用停止
          </button>
        ` : ""}
      </div>
    `;
    list.appendChild(item);
  });
}


async function createNotificationMember() {
  if (currentTeam?.role !== "OWNER") return;
  const input = document.getElementById(
    "notificationMemberNameInput"
  );
  const displayName = input?.value?.trim();
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
          "通知メンバーを追加できませんでした。"
      );
    }
    if (input) input.value = "";
    notificationMemberManagement =
      await fetchNotificationMembers();
    renderNotificationMemberManagement();
    await showNotificationMemberCredential(payload);
  } catch (error) {
    await showAppAlert(
      error instanceof Error
        ? error.message
        : "通知メンバーを追加できませんでした。",
      { title: "通知メンバーの追加エラー" }
    );
  }
}


async function resetNotificationMemberPassword(memberId) {
  const confirmed = await showAppConfirm(
    "新しいパスワードを発行すると、現在のログインはすべて解除されます。続けますか？",
    {
      title: "パスワードの再発行",
      confirmText: "再発行する",
      tone: "warning"
    }
  );
  if (!confirmed || currentTeam?.role !== "OWNER") return;
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
    await showNotificationMemberCredential(payload);
  } catch (error) {
    await showAppAlert(
      error instanceof Error
        ? error.message
        : "パスワードを再発行できませんでした。",
      { title: "パスワード再発行エラー" }
    );
  }
}


async function disableNotificationMember(memberId) {
  const confirmed = await showAppConfirm(
    "この通知メンバーを利用停止にしますか？ログイン中の端末も直ちにログアウトされます。",
    {
      title: "通知メンバーの利用停止",
      confirmText: "利用停止にする",
      tone: "danger"
    }
  );
  if (!confirmed || currentTeam?.role !== "OWNER") return;
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
          "通知メンバーを利用停止にできませんでした。"
      );
    }
    notificationMemberManagement = payload;
    currentTeam =
      (await fetchCurrentTeamContext()) || currentTeam;
    renderNotificationMemberManagement();
  } catch (error) {
    await showAppAlert(
      error instanceof Error
        ? error.message
        : "通知メンバーを利用停止にできませんでした。",
      { title: "通知メンバーの利用停止エラー" }
    );
  }
}


function showNotificationMemberCredential(payload) {
  return showAppAlert(
    `Call Now ID：${payload.member.callNowId}\n初期パスワード：${payload.initialPassword}\n\nこのパスワードは再表示できません。安全な方法で本人へお伝えください。`,
    { title: "通知メンバーを登録しました" }
  );
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

  const statusDisplay =
    document.querySelector(
      ".status-display"
    );

  const appStatus =
    document.querySelector(
      ".app-status"
    );

  const renewalButton =
    document.getElementById(
      "renewContractButton"
    );

  if (statusDisplay) {
    statusDisplay.textContent =
      !activeSubscription
        ? "⚠️ 初期設定が必要"
        : expired
          ? "⛔ 利用停止"
          : "✅ 正常";

    statusDisplay.classList.toggle(
      "expired",
      expired
    );
  }

  setText(
    "serviceStatusDescription",
    !activeSubscription
      ? "契約、キーワード、メール監視アカウントを設定すると通知を開始できます。"
      : expired
        ? "契約期限が切れているため、通知機能を利用できません。"
        : "すべてのシステムは正常に稼働しています。"
  );

  if (appStatus) {
    appStatus.textContent =
      !activeSubscription
        ? "未設定"
        : expired
          ? "停止中"
          : "監視中";

    appStatus.classList.toggle(
      "expired",
      expired
    );
  }

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
   お知らせ・外部リンク
======================================== */

function getSafeHttpsUrl(rawUrl) {
  if (
    typeof rawUrl !== "string" ||
    !rawUrl.trim()
  ) {
    return "";
  }

  try {
    const parsedUrl =
      new URL(rawUrl);

    return parsedUrl.protocol ===
        "https:" &&
      !parsedUrl.username &&
      !parsedUrl.password
      ? parsedUrl.href
      : "";
  } catch {
    return "";
  }
}


function configureExternalLink(
  elementId,
  rawUrl
) {
  const link =
    document.getElementById(
      elementId
    );

  if (!link) {
    return false;
  }

  const safeUrl =
    getSafeHttpsUrl(rawUrl);

  link.classList.toggle(
    "hidden",
    !safeUrl
  );

  if (!safeUrl) {
    link.removeAttribute("href");
    return false;
  }

  link.setAttribute("href", safeUrl);
  link.setAttribute(
    "target",
    "_blank"
  );
  link.setAttribute(
    "rel",
    "noopener noreferrer"
  );

  return true;
}


function renderAnnouncements() {
  const list =
    document.getElementById(
      "announcementList"
    );

  if (!list) {
    return;
  }

  list.replaceChildren();
  let renderedAnnouncementCount = 0;

  announcements.forEach(
    (announcement) => {
      const item =
        document.createElement("li");
      const safeUrl =
        getSafeHttpsUrl(
          announcement.url
        );
      const title = String(
        announcement.title || ""
      ).trim();

      if (!title) {
        return;
      }

      item.className =
        "announcement-item";

      if (!safeUrl) {
        const text =
          document.createElement(
            "span"
          );

        text.textContent = title;
        item.appendChild(text);
      } else {
        const link =
          document.createElement("a");
        const indicator =
          document.createElement(
            "span"
          );

        link.href = safeUrl;
        link.target = "_blank";
        link.rel =
          "noopener noreferrer";
        link.textContent = title;

        indicator.className =
          "announcement-link-indicator";
        indicator.textContent = "↗";
        indicator.setAttribute(
          "aria-hidden",
          "true"
        );

        link.appendChild(indicator);
        item.appendChild(link);
      }

      list.appendChild(item);
      renderedAnnouncementCount += 1;
    }
  );

  if (renderedAnnouncementCount === 0) {
    const emptyMessage =
      document.createElement("li");

    emptyMessage.className =
      "announcement-empty";
    emptyMessage.textContent =
      "お知らせは準備中です";

    list.appendChild(emptyMessage);
  }
}


function renderHelpExternalLinks() {
  const hasSupportLink =
    configureExternalLink(
      "supportLink",
      supportUrl
    );

  setText(
    "supportStatus",
    hasSupportLink
      ? "個別サポート窓口をご利用いただけます。"
      : "個別サポート窓口は準備中です。"
  );

  const hasAppStoreLink =
    configureExternalLink(
      "appStoreReviewLink",
      appStoreUrl
    );
  const hasGooglePlayLink =
    configureExternalLink(
      "googlePlayReviewLink",
      googlePlayUrl
    );
  const storeLinks =
    document.getElementById(
      "storeReviewLinks"
    );
  const hasStoreLink =
    hasAppStoreLink ||
    hasGooglePlayLink;

  if (storeLinks) {
    storeLinks.classList.toggle(
      "hidden",
      !hasStoreLink
    );
  }

  setText(
    "storeReviewStatus",
    hasStoreLink
      ? "正式ストアページから、ご意見・評価をお寄せいただけます。"
      : "正式公開後は、App StoreまたはGoogle Playのレビューで受け付ける予定です。現在はストアページ未公開のため、レビューリンクは掲載していません。"
  );
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

  renderSavedKeywordList();

  renderTestKeywordCards();

  renderContractInformation();

  renderConnectedGoogleAccounts();

  renderHomeSetupNotices();

  renderAlertList(
    "ownerAlertList",
    ownerAlerts,
    "OWNER"
  );
  void refreshOwnerAlerts();
  startOwnerAlertStream();

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

  const loginAccount =
    document.createElement("div");
  loginAccount.className =
    "google-account-role";
  const loginProviderNames =
    loginIdentities.length > 0
      ? loginIdentities
          .map((identity) => loginProviderLabel(identity.provider))
          .join("・")
      : "ログイン方法を確認中";
  loginAccount.innerHTML = `
    <strong>Call Nowログイン</strong>
    <span class="connected-account-summary">
      ${loginIdentities.length > 0 ? `${loginIdentities.length}件設定済み` : "ログイン中"}
    </span>
    <span class="connected-account-email">
      ${escapeHtml(loginProviderNames)}<br>
      ${escapeHtml(googleEmail)}
    </span>
  `;

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
        : "未接続";
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

  container.appendChild(loginAccount);
  container.appendChild(monitoringAccount);

  setText(
    "homeGoogleAccountActionButton",
    "アカウント設定を開く"
  );
}


function renderHomeSetupNotices() {
  const monitoringActive =
    mailConnections.some(
      (connection) =>
        connection.connectionStatus === "ACTIVE" &&
        connection.authorizationStatus === "ACTIVE"
    );
  setText(
    "appMonitoringStatus",
    monitoringActive ? "監視中" : "未設定"
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
  ownerAlerts = [];
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
   保存キーワード一覧
======================================== */

function renderSavedKeywordList() {
  const container =
    document.getElementById(
      "savedKeywordList"
    );

  if (!container) {
    return;
  }

  container.innerHTML = "";

  keywords.forEach(
    (keyword, index) => {
      const item =
        document.createElement(
          "div"
        );

      item.className =
        "saved-keyword";

      item.innerHTML = `
        <span class="saved-keyword-number">
          ${index + 1}
        </span>

        <span>
          ${escapeHtml(keyword)}
        </span>
      `;

      container.appendChild(
        item
      );
    }
  );
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

  return new Promise(resolve => {
    appDialogResolver =
      resolve;

    confirmButton.focus();
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

function initializeAlarmNotification() {
  const stopButton =
    document.getElementById(
      "stopAlarmButton"
    );

  const restartButton =
    document.getElementById(
      "restartAlarmButton"
    );

  if (stopButton) {
    stopButton.addEventListener(
      "click",
      () => {
        const context = currentAlarmAlertContext;
        closeAlarmNotification();
        if (context) {
          void acknowledgeAlert(
            context.alertId,
            context.audience
          );
        }
      }
    );
  }

  if (restartButton) {
    restartButton.addEventListener(
      "click",
      () => {
        void startAlarmSound();
      }
    );
  }
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

    return (
      context.state === "running"
    );
  } catch (error) {
    console.warn(
      "通知音の再生準備に失敗しました。",
      error
    );

    return false;
  }
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
          node =>
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
  if (!alarmIsActive) {
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
      "通知音が鳴っています。「通知音を停止」を押すまで繰り返します。";
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
      "Safariが通知音をブロックしました。「通知音を鳴らす」を押してください。";
  }

  if (restartButton) {
    restartButton.classList.remove(
      "hidden"
    );
  }
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
    oscillator => {
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
    stopButton.textContent = alertContext
      ? "対応を開始して通知音を停止"
      : "通知音を停止";
    stopButton.focus();
  }

  void startAlarmSound();
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

  try {
    if (isContractExpired()) {
      await showAppAlert(
        `契約期限が切れています。

契約を更新してください。`
      );
      return;
    }

    if (!TEST_API_URL || !TEST_API_TOKEN) {
      await showAppAlert(
        "テストAPIのURLまたはトークンが設定されていません。"
      );
      return;
    }

    const requestId = createTestRequestId();

    testButtons.forEach((testButton) => {
      testButton.dataset.originalText =
        testButton.textContent.trim();

      testButton.disabled = true;
      testButton.textContent =
        "少々お待ちください";
    });

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
            requestId: requestId
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
        throw error;
      }

      console.warn(
        "送信結果を読み取れませんでしたが、検知確認を続けます。",
        error
      );
    }

    const detectedStatus =
      await waitForTestDetection(
        requestId,
        TEST_DETECTION_TIMEOUT_MS
      );

    if (detectedStatus) {
      showAlarmNotification(
        keyword,
        detectedStatus.detectedAt || ""
      );
    } else {
      await showAppAlert(
        `Gmailへの送信処理は行いましたが、
3分以内に検知結果を確認できませんでした。

Gmailにテストメールが届いているか、
「CallNow-Test-Detected」ラベルが付いているか確認してください。`
      );
    }
  } catch (error) {
    console.error(
      "テスト処理に失敗しました。",
      error
    );

    await showAppAlert(
      `テスト処理に失敗しました。

${String(error.message)
  .replace("SERVER:", "")}`
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

function createTestRequestId() {
  if (
    window.crypto &&
    typeof window.crypto.randomUUID === "function"
  ) {
    return window.crypto.randomUUID();
  }

  return (
    `callnow-${Date.now()}-` +
    Math.random()
      .toString(36)
      .slice(2, 10)
  );
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
    "monitoringConfirmationScreen",
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

  const screenIds = [
    "guestHomeScreen",
    "ownerMonitoringSetupScreen",
    "notificationMemberLoginScreen",
    "notificationMemberAppScreen",
    "setupScreen",
    "paymentScreen",
    "monitoringConfirmationScreen",
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
