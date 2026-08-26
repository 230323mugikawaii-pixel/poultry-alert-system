"use strict";
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
  "2026-08-26.1";

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
let currentTeam = null;
let gmailConnection = null;
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

  googleEmail =
    authenticatedUser?.email || "";

  if (authenticatedUser) {
    currentTeam =
      await fetchCurrentTeamContext();
    gmailConnection =
      await fetchGmailConnection();
  }

  if (contractStorageMigrationPending) {
    saveData();
  }

  renderKeywordInputs();

  const canOpenApp =
    Boolean(authenticatedUser) &&
    contractStartDate &&
    contractEndDate;

  const googleAuthResult =
    readGoogleAuthResult();
  const gmailAuthResult =
    readGmailAuthResult();

  if (gmailAuthResult) {
    clearAuthResultFromUrl("gmailAuth");
  }

  if (googleAuthResult) {
    clearAuthResultFromUrl("googleAuth");

    if (
      googleAuthResult === "success" &&
      authenticatedUser
    ) {
      if (contractStartDate && contractEndDate) {
        openApp();
      } else {
        showOnlyScreen("landingScreen");
      }
      return;
    }

    openGoogleScreen(
      contractStartDate && contractEndDate
        ? "login"
        : "link"
    );
    setText(
      "googleError",
      "Googleログインに失敗しました。もう一度お試しください。"
    );
    return;
  }

  if (canOpenApp) {
    openApp();
    if (gmailAuthResult) {
      await showAppAlert(
        gmailAuthResult === "success"
          ? "Gmail監視アカウントを接続しました。"
          : "Gmail監視アカウントを接続できませんでした。もう一度お試しください。",
        {
          title:
            gmailAuthResult === "success"
              ? "Gmail監視の接続完了"
              : "Gmail監視の接続エラー"
        }
      );
    }
  } else {
    showOnlyScreen("landingScreen");
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

    const team = (await response.json())?.team;
    if (
      !team ||
      typeof team.id !== "string" ||
      (team.role !== "OWNER" &&
        team.role !== "MEMBER")
    ) {
      throw new Error("team_current_invalid");
    }

    return {
      id: team.id,
      role: team.role
    };
  } catch (error) {
    console.warn(
      "チーム情報を確認できませんでした。",
      error
    );
    return null;
  }
}


async function fetchGmailConnection() {
  if (currentTeam?.role !== "OWNER") {
    return null;
  }

  try {
    const response = await fetch(
      apiUrl(
        `/api/v1/teams/${encodeURIComponent(currentTeam.id)}/gmail-connection`
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
      return null;
    }

    if (!response.ok) {
      throw new Error(
        `gmail_connection_${response.status}`
      );
    }

    const connection =
      (await response.json())?.connection;
    return connection &&
      typeof connection.email === "string"
      ? connection
      : null;
  } catch (error) {
    console.warn(
      "Gmail監視アカウントの状態を確認できませんでした。",
      error
    );
    return null;
  }
}


function readGoogleAuthResult() {
  const result =
    new URL(window.location.href)
      .searchParams
      .get("googleAuth");

  return result === "success" ||
    result === "error"
    ? result
    : null;
}


function readGmailAuthResult() {
  const result =
    new URL(window.location.href)
      .searchParams
      .get("gmailAuth");

  return result === "success" ||
    result === "error"
    ? result
    : null;
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


/* ========================================
   トップページ
======================================== */

function scrollToService() {
  const section =
    document.getElementById("serviceSection");

  if (section) {
    section.scrollIntoView({
      behavior: "smooth"
    });
  }
}


function startSignup() {
  setupMode =
    contractStartDate && contractEndDate
      ? "login"
      : "signup";

  showOnlyScreen("setupScreen");
  renderKeywordInputs();
  updateSetupScreenText();

  window.scrollTo({
    top: 0
  });
}


function handleSetupBack() {
  if (setupMode === "edit") {
    openApp();
    return;
  }

  showOnlyScreen("landingScreen");

  window.scrollTo({
    top: 0,
    behavior: "smooth"
  });
}


function backToSetup() {
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

  renderKeywordInputs();
}


function changeKeyword(
  index,
  value,
  inputElement = null
) {
  keywords[index] = value;

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
  const keywordCount =
    getValidKeywords().length;

  const extraKeywordCount =
    Math.max(
      0,
      keywordCount -
        INCLUDED_KEYWORD_LIMIT
    );

  const extraPrice =
    extraKeywordCount *
    EXTRA_KEYWORD_PRICE;

  totalPrice =
    keywordPolicy.calculateAnnualPriceYen(
      keywordCount
    );

  setText(
    "keywordCount",
    `${keywordCount}個`
  );

  setText(
    "extraPrice",
    formatYen(extraPrice)
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

  if (setupMode === "login") {
    setText(
      "setupStepLabel",
      "再ログイン"
    );

    setText(
      "setupTitle",
      "通知キーワードを確認"
    );

    setText(
      "setupDescription",
      "前回保存したキーワードが表示されています。確認後、決済内容を確認してください。"
    );

    continueButton.textContent =
      "決済内容を確認";

    return;
  }

  if (setupMode === "edit") {
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

    return;
  }

  setText(
    "setupStepLabel",
    "STEP 1 / 2"
  );

  setText(
    "setupTitle",
    "通知キーワードを設定"
  );

  setText(
    "setupDescription",
    "登録した言葉がメールに含まれていた場合に通知します。基本料金には3個までのキーワードが含まれます。"
  );

  continueButton.textContent =
    "決済内容を確認";
}


async function continueFromSetup() {
  if (!validateKeywords()) {
    return;
  }

  keywords =
    getValidKeywords();

  updatePrice();

  /*
    ログアウト後の再ログイン
  */

    if (setupMode === "login") {
  // ログアウト後に料金が上がった場合
  if (totalPrice > paidAnnualPrice) {
    paymentMode = "upgrade";

    openPayment();
    return;
  }

  // 料金が変わっていない場合
  saveData();
  openGoogleScreen("login");

  return;
}

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

  if (!googleEmail) {
    openGoogleScreen("link");
    return;
  }

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
  paymentMode = "signup";
  openPayment();
}

/* ========================================
   決済確認画面
======================================== */

function openPayment() {
  const renewalMode =
    paymentMode === "renewal";

  setText(
    "paymentStepLabel",
    renewalMode
      ? "契約更新"
      : "STEP 2 / 2"
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

  setText(
    "paymentKeywordCount",
    paymentMode === "upgrade"
      ? `${keywords.length}個（変更後）`
      : `${keywords.length}個`
  );

  const paymentAmount =
    paymentMode === "upgrade"
      ? totalPrice - paidAnnualPrice
      : totalPrice;

  setText(
    "paymentTotal",
    formatYen(paymentAmount)
  );

  const container =
    document.getElementById(
      "paymentKeywords"
    );

  if (container) {
    container.innerHTML = "";

    keywords.forEach(
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

    if (!googleEmail) {
      openGoogleScreen("link");
    } else {
      openApp();
    }

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

  paidAnnualPrice =
    totalPrice;

  saveData();
  openGoogleScreen("link");
}


/* ========================================
   Googleアカウント選択
======================================== */

function openGoogleScreen(
  mode = "link"
) {
  googleScreenMode = mode;
  const isLoginMode =
    mode === "login";

  setText(
    "googleBackButton",
    mode === "manage"
      ? "← ホームへ戻る"
      : "← キーワード設定へ戻る"
  );

  setText(
    "googleScreenTitle",
    isLoginMode
      ? "Googleでログイン"
      : mode === "manage"
        ? "Googleアカウント設定"
        : "監視用Googleアカウントを設定"
  );

  setText(
    "googleScreenDescription",
    isLoginMode
      ? "Call Nowへのログイン用Googleアカウントで本人確認します。"
      : mode === "manage"
        ? "ログイン用アカウントとGmail監視アカウントを別々に管理できます。"
        : "Call Nowへのログインに使うGoogleアカウントで本人確認します。"
  );

  setText(
    "googleAuthButton",
    isLoginMode
      ? "Googleでログイン"
      : "Googleアカウントを設定"
  );

  setText(
    "googleCardTitle",
    isLoginMode
      ? "Googleでログイン"
      : "Googleアカウントを設定"
  );

  setText(
    "finishGoogleLinkButton",
    mode === "manage"
      ? "設定を完了してホームへ"
      : isLoginMode
        ? "ログインしてホームへ"
        : "設定を完了してホームへ"
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
  const gmailAccountCard =
    document.getElementById(
      "gmailMonitoringAccountCard"
    );

  if (accountCard) {
    accountCard.classList.toggle(
      "hidden",
      !showAccountManagement
    );
  }

  if (gmailAccountCard) {
    gmailAccountCard.classList.toggle(
      "hidden",
      !showAccountManagement
    );
  }

  updateGoogleAuthActionText();

  accountList.innerHTML = "";

  if (
    showAccountManagement &&
    !googleEmail
  ) {
    const emptyMessage =
      document.createElement("p");

    emptyMessage.className =
      "google-account-empty";

    emptyMessage.textContent =
      "ログイン中のGoogleアカウントはありません。";

    accountList.appendChild(
      emptyMessage
    );
  } else if (
    showAccountManagement
  ) {
    const accountItem =
      document.createElement("div");

    accountItem.className =
      "linked-google-account";

    accountItem.innerHTML = `
      <span class="account-avatar small-avatar">G</span>
      <span class="linked-google-email">${escapeHtml(googleEmail)}</span>
      <span class="linked-google-actions">
        <button
          type="button"
          class="account-change-button"
          onclick="startGoogleAccountChange()"
        >
          別のGoogleアカウントでログイン
        </button>
        <button
          type="button"
          class="account-remove-button"
          onclick="removeGoogleAccount()"
        >
          ログアウト
        </button>
      </span>
    `;

    accountList.appendChild(
      accountItem
    );
  }

  const finishButton =
    document.getElementById(
      "finishGoogleLinkButton"
    );

  if (finishButton) {
    finishButton.disabled = false;
  }

  renderGmailMonitoringAccount();
}


function updateGoogleAuthActionText() {
  const authCard =
    document.getElementById(
      "googleAuthCard"
    );

  if (authCard) {
    authCard.classList.toggle(
      "hidden",
      Boolean(googleEmail) &&
        googleScreenMode !== "login"
    );
  }

  if (googleScreenMode === "login") {
    setText(
      "googleCardTitle",
      "Googleでログイン"
    );

    setText(
      "googleAuthDescription",
      "Call Nowへのログイン用Googleアカウントで本人確認してください。Gmail監視権限はここでは要求しません。"
    );

    setText(
      "googleAuthButton",
      "Googleでログイン"
    );

    return;
  }

  setText(
    "googleCardTitle",
    "Googleアカウントを設定"
  );

  setText(
    "googleAuthDescription",
    "Googleの認証画面で本人確認してください。Gmail監視アカウントはログイン後に別途接続できます。"
  );

  setText(
    "googleAuthButton",
    "Googleアカウントを設定"
  );
}


async function startGoogleAccountChange() {
  if (!googleEmail) {
    startGoogleLogin("link");
    return;
  }

  const confirmed =
    await showAppConfirm(
      `別のGoogleアカウントでログインしますか？

Googleでの本人確認が成功すると、現在のセッションが新しい利用者のセッションへ切り替わります。`,
      {
        title: "Googleアカウントの切り替え",
        confirmText: "ログインを続ける"
      }
    );

  if (!confirmed) {
    return;
  }

  startGoogleLogin();
}


async function removeGoogleAccount() {
  if (!googleEmail) {
    return;
  }

  const confirmed =
    await showAppConfirm(
      `${googleEmail} からログアウトしますか？`,
      {
        title: "ログアウトの確認",
        confirmText: "ログアウトする",
        tone: "danger"
      }
    );

  if (!confirmed) {
    return;
  }

  await performLogout();
}


function renderGmailMonitoringAccount() {
  const status =
    document.getElementById(
      "gmailMonitoringAccountStatus"
    );
  const connectButton =
    document.getElementById(
      "gmailConnectButton"
    );
  const reauthorizeButton =
    document.getElementById(
      "gmailReauthorizeButton"
    );
  const disconnectButton =
    document.getElementById(
      "gmailDisconnectButton"
    );

  if (
    !status ||
    !connectButton ||
    !reauthorizeButton ||
    !disconnectButton
  ) {
    return;
  }

  connectButton.classList.add("hidden");
  reauthorizeButton.classList.add("hidden");
  disconnectButton.classList.add("hidden");
  connectButton.disabled = false;

  if (!currentTeam) {
    status.innerHTML = `
      <p class="connected-account-empty">
        チーム登録完了後に、代表者がGmail監視アカウントを接続できます。
      </p>
    `;
    connectButton.classList.remove("hidden");
    connectButton.disabled = true;
    return;
  }

  if (currentTeam.role !== "OWNER") {
    status.innerHTML = `
      <p class="connected-account-empty">
        Gmail監視アカウントはチームの代表者が管理します。
      </p>
    `;
    return;
  }

  if (
    !gmailConnection ||
    gmailConnection.connectionStatus === "REVOKED"
  ) {
    status.innerHTML = `
      <p class="connected-account-empty">
        Gmail監視アカウントは接続されていません。
      </p>
    `;
    connectButton.classList.remove("hidden");
    return;
  }

  const requiresReauthorization =
    gmailConnection.connectionStatus ===
      "REAUTH_REQUIRED" ||
    gmailConnection.authorizationStatus ===
      "REAUTH_REQUIRED" ||
    gmailConnection.connectionStatus === "ERROR" ||
    gmailConnection.authorizationStatus === "ERROR";

  status.innerHTML = `
    <p class="connected-account-summary">
      ${requiresReauthorization ? "再認証が必要です" : "1件接続中"}
    </p>
    <p class="connected-account-email">
      ${escapeHtml(gmailConnection.email)}
    </p>
  `;
  disconnectButton.classList.remove("hidden");

  if (requiresReauthorization) {
    reauthorizeButton.classList.remove("hidden");
  }
}


async function startGmailConnection() {
  await beginGmailOAuth("oauth/start");
}


async function reauthorizeGmailConnection() {
  await beginGmailOAuth("reauthorize");
}


async function beginGmailOAuth(action) {
  if (!authenticatedUser) {
    await showAppAlert(
      "先にGoogleでCall Nowへログインしてください。"
    );
    return;
  }

  if (currentTeam?.role !== "OWNER") {
    await showAppAlert(
      currentTeam
        ? "Gmail監視アカウントはチームの代表者だけが管理できます。"
        : "チーム登録完了後にGmail監視アカウントを接続できます。"
    );
    return;
  }

  const form = document.createElement("form");
  form.method = "post";
  form.action = apiUrl(
    `/api/v1/teams/${encodeURIComponent(currentTeam.id)}/gmail-connection/${action}`
  );
  form.hidden = true;
  document.body.appendChild(form);
  form.submit();
}


async function disconnectGmailConnection() {
  if (currentTeam?.role !== "OWNER" ||
      !gmailConnection) {
    return;
  }

  const confirmed = await showAppConfirm(
    "Gmail監視アカウントの接続を解除しますか？解除後はメール監視が停止します。",
    {
      title: "Gmail監視の解除",
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
        `/api/v1/teams/${encodeURIComponent(currentTeam.id)}/gmail-connection`
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
        `gmail_disconnect_${response.status}`
      );
    }

    gmailConnection = null;
    renderGmailMonitoringAccount();
    renderConnectedGoogleAccounts();
    await showAppAlert(
      "Gmail監視アカウントの接続を解除しました。"
    );
  } catch (error) {
    console.error(
      "Gmail監視アカウントを解除できませんでした。",
      error
    );
    await showAppAlert(
      "Gmail監視アカウントを解除できませんでした。通信状態を確認して、もう一度お試しください。"
    );
  }
}


function finishGoogleAccountLinking() {
  if (!authenticatedUser) {
    setText(
      "googleError",
      "Googleでログインしてください。"
    );

    return;
  }

  saveData();
  openApp();
}


function backFromGoogle() {
  if (googleScreenMode === "manage") {
    openApp();
    return;
  }

  showOnlyScreen(
    "setupScreen"
  );

  renderKeywordInputs();

  updateSetupScreenText();

  window.scrollTo({
    top: 0
  });
}


function startGoogleLogin() {
  setText(
    "googleError",
    ""
  );
  window.location.assign(
    apiUrl("/api/v1/auth/google/start")
  );
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
  if (
    !contractStartDate ||
    !contractEndDate
  ) {
    createContractDates();
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
  const expired =
    isContractExpired();

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
      expired
        ? "⛔ 利用停止"
        : "✅ 正常";

    statusDisplay.classList.toggle(
      "expired",
      expired
    );
  }

  setText(
    "serviceStatusDescription",
    expired
      ? "契約期限が切れているため、通知機能を利用できません。"
      : "すべてのシステムは正常に稼働しています。"
  );

  if (appStatus) {
    appStatus.textContent =
      expired
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
        expired;

      button.textContent =
        expired
          ? "契約更新が必要です"
          : "テストを実行";
    });

  if (renewalButton) {
    renewalButton.textContent =
      expired
        ? "契約を1年間更新して再開"
        : "契約期限を1年間延長";
  }
}


function renewContract() {
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
  showOnlyScreen(
    "appScreen"
  );

  renderSavedKeywordList();

  renderTestKeywordCards();

  renderContractInformation();

  renderConnectedGoogleAccounts();

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
  loginAccount.innerHTML = `
    <strong>Call Nowログイン</strong>
    <span class="connected-account-summary">
      ${googleEmail ? "ログイン中" : "未ログイン"}
    </span>
    <span class="connected-account-email">
      ${googleEmail ? escapeHtml(googleEmail) : "Googleでログインしてください"}
    </span>
  `;

  const monitoringAccount =
    document.createElement("div");
  monitoringAccount.className =
    "google-account-role";
  const monitoringStatus =
    gmailConnection &&
    gmailConnection.connectionStatus === "ACTIVE" &&
    gmailConnection.authorizationStatus === "ACTIVE"
      ? "1件接続中"
      : gmailConnection &&
          gmailConnection.connectionStatus !== "REVOKED"
        ? "再認証が必要です"
        : "未接続";
  const monitoringDetail =
    gmailConnection &&
    gmailConnection.connectionStatus !== "REVOKED"
      ? escapeHtml(gmailConnection.email)
      : currentTeam?.role === "OWNER"
        ? "重要メールの監視用アカウントを接続できます"
        : currentTeam
          ? "代表者が管理します"
          : "チーム登録完了後に接続できます";
  monitoringAccount.innerHTML = `
    <strong>Gmail監視</strong>
    <span class="connected-account-summary">
      ${monitoringStatus}
    </span>
    <span class="connected-account-email">
      ${monitoringDetail}
    </span>
  `;

  container.appendChild(loginAccount);
  container.appendChild(monitoringAccount);

  setText(
    "homeGoogleAccountActionButton",
    "Googleアカウントを管理"
  );
}


function openGoogleAccountManager() {
  openGoogleScreen("manage");
}


function showAppPage(
  pageId,
  clickedButton = null
) {
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
  currentTeam = null;
  gmailConnection = null;

  setupMode =
    "login";

  showOnlyScreen(
    "landingScreen"
  );

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
      closeAlarmNotification
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
  detectedAt
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
  const screenIds = [
    "landingScreen",
    "setupScreen",
    "paymentScreen",
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
