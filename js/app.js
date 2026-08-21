"use strict";
/* ========================================
   契約データを保存
======================================== */

function saveData() {
  const data = {
    keywords: keywords,
    accountCount: accountCount,
    totalPrice: totalPrice,
    paidAnnualPrice: paidAnnualPrice,
    googleAccounts: googleAccounts,

    /*
      旧版との互換性を保つため、先頭のアカウントも
      従来の項目名で保存する。
    */
    googleEmail:
      googleAccounts[0] || "",

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
      Number.isInteger(data.accountCount) &&
      data.accountCount >= 1 &&
      data.accountCount <= MAX_ACCOUNT_COUNT
    ) {
      accountCount = data.accountCount;
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

    if (Array.isArray(data.googleAccounts)) {
      googleAccounts =
        normalizeGoogleAccounts(
          data.googleAccounts
        );
    } else if (
      typeof data.googleEmail ===
        "string" &&
      isValidEmail(data.googleEmail)
    ) {
      /*
        旧版の単一アカウントを、複数アカウント形式へ
        自動的に引き継ぐ。
      */
      googleAccounts = [
        data.googleEmail.trim()
      ];
    }

    accountCount = Math.max(
      accountCount,
      googleAccounts.length,
      1
    );

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
const BASE_PRICE = 6000;
const INCLUDED_KEYWORD_LIMIT = 3;
const EXTRA_KEYWORD_PRICE = 100;
const INCLUDED_ACCOUNT_LIMIT = 1;
const EXTRA_ACCOUNT_PRICE = 100;
const MAX_ACCOUNT_COUNT = 100;
const STORAGE_KEY = "callNowContract";
const SESSION_KEY = "callNowSession";
const CONTACT_INFO_STORAGE_KEY =
  "callNowContactInfo";
const GOOGLE_CLIENT_ID =
  "187445333976-dpqiiqq2a46ljquoqfiqsh5vnq109hqu.apps.googleusercontent.com";
const GOOGLE_GMAIL_SCOPE =
  "https://www.googleapis.com/auth/gmail.readonly";
const TEST_API_URL =
  "https://script.google.com/macros/s/AKfycbw6hllq-Teht0GXydKn0V9GijokIhaCCUfBAeUKdTgIY2Vi7yqznDG55Xa1BTQtfitMgw/exec";

const TEST_API_TOKEN =
  "callnow-test-2026-Abc123456789";
const TEST_DETECTION_TIMEOUT_MS =
  3 * 60 * 1000;

const APP_BUILD_VERSION =
  "2026-08-21.1";

let alarmAudioContext = null;
let alarmRepeatTimer = null;
let alarmActiveNodes = [];
let alarmIsActive = false;
let alarmFocusBeforeOpen = null;

let keywords = ["停電", "通電", "警報"];
let accountCount = 1;
let totalPrice = BASE_PRICE;
let contractStartDate = null;
let contractEndDate = null;
let googleAccounts = [];
let googleTokenClient = null;
let googleAccessTokens = {};
let googleScreenMode = "link";
let googleAuthMode = "add";
let googleLoginVerified = false;
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
  console.info(
    `Call Now ${APP_BUILD_VERSION}`
  );

  loadSavedData();
  initializeContactInfoPersistence();
  initializeAlarmNotification();
  normalizeKeywords();
  syncAccountCountInput();
  updatePrice();
  renderKeywordInputs();

  const sessionIsActive =
    sessionStorage.getItem(SESSION_KEY) === "active";

  const canOpenApp =
    sessionIsActive &&
    contractStartDate &&
    contractEndDate;

  if (canOpenApp) {
    openApp();
  } else {
    showOnlyScreen("landingScreen");
  }
});


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
  syncAccountCountInput();
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
  syncAccountCountInput();
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
        placeholder="例：停電"
        maxlength="30"
        oninput="changeKeyword(${index}, this.value, this)"
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

  const trimmedValue =
    String(value).trim();

  const errorMessage =
    trimmedValue &&
    !isSingleWordKeyword(trimmedValue)
      ? "キーワードは1つの欄に1単語だけ入力してください。"
      : "";

  if (inputElement) {
    inputElement.setCustomValidity(
      errorMessage
    );
  }

  showSetupError(errorMessage);

  updatePrice();
}


function getValidKeywords() {
  return keywords
    .map((keyword) =>
      String(keyword).trim()
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
  const validKeywords =
    getValidKeywords();

  if (validKeywords.length === 0) {
    showSetupError(
      "最低1個のキーワードを入力してください。"
    );

    return false;
  }

  const invalidKeyword =
    validKeywords.find(
      (keyword) =>
        !isSingleWordKeyword(keyword)
    );

  if (invalidKeyword) {
    showSetupError(
      `「${invalidKeyword}」は複数の単語を含んでいます。1つの欄には1単語だけ入力してください。`
    );

    return false;
  }

  const normalized =
    validKeywords.map((keyword) =>
      keyword.toLowerCase()
    );

  if (
    new Set(normalized).size !==
    normalized.length
  ) {
    showSetupError(
      "同じキーワードが重複しています。"
    );

    return false;
  }

  showSetupError("");

  return true;
}


function isSingleWordKeyword(value) {
  const keyword =
    String(value).trim();

  if (!keyword) {
    return false;
  }

  if (
    /[\s、。・,，/／]+/u.test(
      keyword
    )
  ) {
    return false;
  }

  if (
    typeof Intl.Segmenter ===
      "function"
  ) {
    const segmenter =
      new Intl.Segmenter(
        "ja",
        {
          granularity: "word"
        }
      );

    const wordSegments =
      Array.from(
        segmenter.segment(keyword)
      ).filter(
        (segment) =>
          segment.isWordLike
      );

    return wordSegments.length === 1;
  }

  return true;
}


/* ========================================
   連携Googleアカウント数
======================================== */

function changeAccountCount(value) {
  accountCount = Number(value);

  let errorMessage = "";

  if (!validateAccountCount(false)) {
    errorMessage =
      accountCount < googleAccounts.length
        ? `現在${googleAccounts.length}件のGoogleアカウントが連携されています。先に不要なアカウントを解除してください。`
        : `連携するGoogleアカウント数は1件から${MAX_ACCOUNT_COUNT}件までの整数で入力してください。`;
  }

  showSetupError(errorMessage);
  updatePrice();
}


function validateAccountCount(
  showError = true
) {
  const valid =
    Number.isInteger(accountCount) &&
    accountCount >= 1 &&
    accountCount <= MAX_ACCOUNT_COUNT &&
    accountCount >= googleAccounts.length;

  if (!valid && showError) {
    showSetupError(
      accountCount < googleAccounts.length
        ? `現在${googleAccounts.length}件のGoogleアカウントが連携されています。先に不要なアカウントを解除してください。`
        : `連携するGoogleアカウント数は1件から${MAX_ACCOUNT_COUNT}件までの整数で入力してください。`
    );
  }

  return valid;
}


function getPriceAccountCount() {
  return validateAccountCount(false)
    ? accountCount
    : Math.max(
        googleAccounts.length,
        1
      );
}


function syncAccountCountInput() {
  const input =
    document.getElementById(
      "accountCount"
    );

  if (input) {
    input.value =
      String(getPriceAccountCount());
  }
}


function showSetupError(message) {
  setText(
    "setupError",
    message
  );
}


function normalizeGoogleAccounts(accounts) {
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


function findGoogleAccountIndex(email) {
  const normalizedEmail =
    String(email || "")
      .trim()
      .toLowerCase();

  return googleAccounts.findIndex(
    (account) =>
      account.toLowerCase() ===
        normalizedEmail
  );
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

  const extraAccountCount =
    Math.max(
      0,
      getPriceAccountCount() -
        INCLUDED_ACCOUNT_LIMIT
    );

  const extraAccountPrice =
    extraAccountCount *
    EXTRA_ACCOUNT_PRICE;

  totalPrice =
    BASE_PRICE +
    extraPrice +
    extraAccountPrice;

  setText(
    "keywordCount",
    `${keywordCount}個`
  );

  setText(
    "extraPrice",
    formatYen(extraPrice)
  );

  setText(
    "extraAccountPrice",
    formatYen(extraAccountPrice)
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
      "通知・アカウント設定を編集"
    );

    setText(
      "setupDescription",
      "登録キーワードと、連携するGoogleアカウント数を変更できます。"
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
    "通知キーワードと連携数を設定"
  );

  setText(
    "setupDescription",
    "登録した言葉がメールに含まれていた場合に通知します。基本料金には3個までのキーワードが含まれます。"
  );

  continueButton.textContent =
    "Googleアカウント選択へ";
}


function continueFromSetup() {
  if (!validateKeywords()) {
    return;
  }

  if (!validateAccountCount()) {
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

  if (
    googleAccounts.length <
      accountCount
  ) {
    openGoogleScreen("link");
    return;
  }

  openApp();

  if (totalPrice < paidAnnualPrice) {
    window.alert(
      `契約内容を変更しました。

現在の契約期間中の返金はありません。

次回更新料金は
${formatYen(totalPrice)}
になります。`
    );
  } else {
    window.alert(
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

  setText(
    "paymentAccountCount",
    `${accountCount}件`
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

function completeDemoPayment() {
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

    if (
      googleAccounts.length <
        accountCount
    ) {
      openGoogleScreen("link");
    } else {
      openApp();
    }

    window.alert(
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

  if (mode === "login") {
    googleLoginVerified = false;
  }

  setText(
    "googleBackButton",
    mode === "manage"
      ? "← ホームへ戻る"
      : "← キーワード設定へ戻る"
  );

  setText(
    "googleScreenTitle",
    mode === "login"
      ? "Googleでログイン"
      : "Googleアカウントを連携"
  );

  setText(
    "googleScreenDescription",
    mode === "login"
      ? "連携済みのGoogleアカウントを選んで、本人確認をします。"
      : "通知を確認するGmailを、契約した件数分だけ1件ずつ連携します。"
  );

  setText(
    "googleAuthButton",
    mode === "login"
      ? "Googleでログイン"
      : "Googleアカウントを追加"
  );

  setText(
    "googleCardTitle",
    mode === "login"
      ? "連携済みアカウントで本人確認"
      : "Googleアカウントを追加"
  );

  setText(
    "finishGoogleLinkButton",
    mode === "manage"
      ? "管理を完了してホームへ"
      : mode === "login"
        ? "ログインしてホームへ"
        : "連携を完了してホームへ"
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

  updateGoogleAuthActionText();

  accountList.innerHTML = "";

  if (googleAccounts.length === 0) {
    const emptyMessage =
      document.createElement("p");

    emptyMessage.className =
      "google-account-empty";

    emptyMessage.textContent =
      "連携済みのGoogleアカウントはありません。";

    accountList.appendChild(
      emptyMessage
    );
  } else {
    googleAccounts.forEach(
      (email, index) => {
        const accountItem =
          document.createElement("div");

        accountItem.className =
          "linked-google-account";

        accountItem.innerHTML = `
          <span class="account-avatar small-avatar">G</span>
          <span class="linked-google-email">${escapeHtml(email)}</span>
          <button
            type="button"
            class="account-remove-button"
            onclick="removeGoogleAccount(${index})"
          >
            解除
          </button>
        `;

        accountList.appendChild(
          accountItem
        );
      }
    );
  }

  setText(
    "linkedGoogleAccountCount",
    `${googleAccounts.length} / ${accountCount}件を連携済み`
  );

  const finishButton =
    document.getElementById(
      "finishGoogleLinkButton"
    );

  if (finishButton) {
    finishButton.disabled = false;
  }
}


function updateGoogleAuthActionText() {
  const needsAccountLink =
    googleAccounts.length <
      accountCount;

  if (
    googleScreenMode === "login" &&
    needsAccountLink
  ) {
    setText(
      "googleCardTitle",
      "Googleアカウントを連携"
    );

    setText(
      "googleAuthDescription",
      "Googleの認証画面で、通知を確認するアカウントを選択し、Gmailの閲覧権限を許可してください。連携後、そのまま本人確認が完了します。Call NowがGoogleのパスワードを保存することはありません。"
    );

    setText(
      "googleAuthButton",
      "Googleアカウントを連携"
    );

    return;
  }

  if (googleScreenMode === "login") {
    setText(
      "googleCardTitle",
      "連携済みアカウントで本人確認"
    );

    setText(
      "googleAuthDescription",
      "Googleの認証画面で、連携済みのアカウントを選択してください。Call NowがGoogleのパスワードを保存することはありません。"
    );

    setText(
      "googleAuthButton",
      "Googleでログイン"
    );

    return;
  }

  setText(
    "googleCardTitle",
    "Googleアカウントを追加"
  );

  setText(
    "googleAuthDescription",
    "Googleの認証画面で、まだ連携していないアカウントを選択し、Gmailの閲覧権限を許可してください。Call NowがGoogleのパスワードを保存することはありません。"
  );

  setText(
    "googleAuthButton",
    "Googleアカウントを追加"
  );
}


function removeGoogleAccount(index) {
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    index >= googleAccounts.length
  ) {
    return;
  }

  const email =
    googleAccounts[index];

  const confirmed =
    window.confirm(
      `${email} の連携を解除しますか？`
    );

  if (!confirmed) {
    return;
  }

  delete googleAccessTokens[
    email.toLowerCase()
  ];

  googleAccounts.splice(index, 1);

  saveData();
  renderGoogleAccountOptions();
  renderConnectedGoogleAccounts();
}


function finishGoogleAccountLinking() {
  if (
    googleScreenMode === "login" &&
    (
      googleAccounts.length !==
        accountCount ||
      !googleLoginVerified
    )
  ) {
    setText(
      "googleError",
      "アカウントの連携を済ませてください"
    );

    return;
  }

  if (
    googleAccounts.length !==
      accountCount
  ) {
    setText(
      "googleError",
      `あと${accountCount - googleAccounts.length}件のGoogleアカウントを連携してください。`
    );

    return;
  }
  finishLogin();
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


function initializeGoogleTokenClient() {
  const oauth2 =
    window.google &&
    window.google.accounts &&
    window.google.accounts.oauth2;

  if (!oauth2) {
    return false;
  }

  if (!googleTokenClient) {
    googleTokenClient =
      oauth2.initTokenClient({
        client_id:
          GOOGLE_CLIENT_ID,
        scope:
          GOOGLE_GMAIL_SCOPE,
        callback:
          handleGoogleTokenResponse,
        error_callback:
          handleGoogleLoginError
      });
  }

  return true;
}


function startGoogleLogin(
  mode = null
) {
  const needsAccountLink =
    googleAccounts.length <
      accountCount;

  googleAuthMode =
    mode ||
    (
      googleScreenMode === "login" &&
      !needsAccountLink
        ? "login"
        : "add"
    );

  setText(
    "googleError",
    ""
  );

  if (!initializeGoogleTokenClient()) {
    setText(
      "googleError",
      "Googleログインの準備中です。数秒待って、もう一度押してください。"
    );

    return;
  }

  googleTokenClient.requestAccessToken({
    prompt: "select_account"
  });
}


async function handleGoogleTokenResponse(
  response
) {
  try {
    if (
      !response ||
      response.error ||
      !response.access_token
    ) {
      throw new Error(
        response && response.error
          ? response.error
          : "access_token_missing"
      );
    }

    const oauth2 =
      window.google.accounts.oauth2;

    if (
      !oauth2.hasGrantedAllScopes(
        response,
        GOOGLE_GMAIL_SCOPE
      )
    ) {
      setText(
        "googleError",
        "Gmailの閲覧権限が必要です。もう一度ログインして許可してください。"
      );

      return;
    }

    const accessToken =
      response.access_token;

    const profileResponse =
      await fetch(
        "https://gmail.googleapis.com/gmail/v1/users/me/profile",
        {
          headers: {
            Authorization:
              `Bearer ${accessToken}`
          }
        }
      );

    if (!profileResponse.ok) {
      throw new Error(
        `gmail_profile_${profileResponse.status}`
      );
    }

    const profile =
      await profileResponse.json();

    const selectedEmail =
      String(
        profile.emailAddress || ""
      ).trim();

    if (!isValidEmail(selectedEmail)) {
      throw new Error(
        "gmail_email_missing"
      );
    }

    const normalizedEmail =
      selectedEmail.toLowerCase();

    const existingIndex =
      findGoogleAccountIndex(
        selectedEmail
      );

    if (
      googleAuthMode === "login" &&
      existingIndex === -1
    ) {
      setText(
        "googleError",
        `${selectedEmail} はCall Nowに連携されていません。連携済みのGoogleアカウントを選択してください。`
      );

      return;
    }

    if (
      existingIndex !== -1 &&
      googleAuthMode === "add"
    ) {
      googleAccessTokens[
        normalizedEmail
      ] = accessToken;

      setText(
        "googleError",
        `${selectedEmail} はすでに連携されています。別のGoogleアカウントを選択してください。`
      );

      return;
    }

    if (
      existingIndex === -1 &&
      googleAccounts.length >=
        accountCount
    ) {
      setText(
        "googleError",
        `契約上限は${accountCount}件です。追加する場合は、先に連携アカウント数を変更してください。`
      );

      return;
    }

    if (existingIndex === -1) {
      googleAccounts.push(
        selectedEmail
      );
    }

    googleAccessTokens[
      normalizedEmail
    ] = accessToken;

    googleLoginVerified = true;

    saveData();
    renderGoogleAccountOptions();

    if (googleAuthMode === "login") {
      setText(
        "googleError",
        `${selectedEmail} で本人確認が完了しました。`
      );
    } else if (
      googleAccounts.length ===
        accountCount
    ) {
      setText(
        "googleError",
        "必要なGoogleアカウントの連携が完了しました。"
      );
    }
  } catch (error) {
    console.error(
      "Googleログインに失敗しました。",
      error
    );

    setText(
      "googleError",
      "Googleログインを完了できませんでした。もう一度お試しください。"
    );
  }
}


function handleGoogleLoginError(error) {
  console.error(
    "Googleログイン画面を開けませんでした。",
    error
  );

  setText(
    "googleError",
    "Googleログイン画面を開けませんでした。もう一度お試しください。"
  );
}


function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
    value
  );
}


function finishLogin() {
  sessionStorage.setItem(
    SESSION_KEY,
    "active"
  );

  saveData();

  openApp();
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
    "contractAccountCount",
    `${accountCount}件`
  );

  setText(
    "contractLinkedAccountCount",
    `${googleAccounts.length}件`
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

  container.innerHTML = "";

  if (googleAccounts.length === 0) {
    container.innerHTML = `
      <p class="connected-account-summary">
        0 / ${accountCount}件を連携済み
      </p>
      <p>未選択</p>
    `;
    return;
  }

  const summary =
    document.createElement("p");

  summary.className =
    "connected-account-summary";

  summary.textContent =
    `${googleAccounts.length} / ${accountCount}件を連携済み`;

  const list =
    document.createElement("ul");

  list.className =
    "connected-account-list";

  googleAccounts.forEach((email) => {
    const item =
      document.createElement("li");

    item.textContent = email;
    list.appendChild(item);
  });

  container.appendChild(summary);
  container.appendChild(list);
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
      contactPage: 4
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

function logout() {
  const confirmed =
    window.confirm(
      `Call Nowからログアウトしますか？

契約情報・キーワード・Googleアカウント情報は保存されたままです。`
    );

  if (!confirmed) {
    return;
  }

  closeAlarmNotification();

  sessionStorage.removeItem(
    SESSION_KEY
  );

  googleAccessTokens = {};
  googleTokenClient = null;

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
      window.alert(
        `契約期限が切れています。

契約を更新してください。`
      );
      return;
    }

    if (!TEST_API_URL || !TEST_API_TOKEN) {
      window.alert(
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
      window.alert(
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

    window.alert(
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


async function findTestMailInConnectedGmail(
  requestId
) {
  const accessTokens =
    Array.from(
      new Set(
        Object.values(
          googleAccessTokens
        ).filter(
          (value) =>
            typeof value === "string" &&
            value
        )
      )
    );

  for (const accessToken of accessTokens) {
    try {
      const searchUrl =
        new URL(
          "https://gmail.googleapis.com/gmail/v1/users/me/messages"
        );

      searchUrl.searchParams.set(
        "q",
        `in:inbox newer_than:1d label:CallNow-Test-Detected "${requestId}"`
      );

      searchUrl.searchParams.set(
        "maxResults",
        "1"
      );

      const response =
        await fetch(
          searchUrl.toString(),
          {
            method: "GET",
            headers: {
              Authorization:
                `Bearer ${accessToken}`
            },
            cache: "no-store"
          }
        );

      if (!response.ok) {
        console.warn(
          "Gmailでのテストメール確認に失敗しました。",
          response.status
        );
        continue;
      }

      const result =
        await response.json();

      if (
        Array.isArray(result.messages) &&
        result.messages.length > 0
      ) {
        return {
          state: "detected",
          detectedAt:
            new Date().toISOString(),
          source: "gmail-api"
        };
      }
    } catch (error) {
      console.warn(
        "Gmailでのテストメール確認に失敗しました。",
        error
      );
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

  let attemptCount = 0;

  while (
    Date.now() <
    endTime
  ) {
    /*
      3秒ごとに検知状況を確認する。
    */
    await sleep(3000);
    attemptCount += 1;

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

    /*
      Apps Scriptの状態取得が遅れた場合も、
      Gmailに検知済みラベルが付いていれば
      テスト成功として確認する。
    */
    if (
      attemptCount % 2 === 0
    ) {
      const gmailStatus =
        await findTestMailInConnectedGmail(
          requestId
        );

      if (gmailStatus) {
        return gmailStatus;
      }
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
   お問い合わせ入力情報を保存
======================================== */

function initializeContactInfoPersistence() {
  const fieldIds = [
    "contactName",
    "contactCompany",
    "contactEmail"
  ];

  loadContactInfo();

  fieldIds.forEach((fieldId) => {
    const field =
      document.getElementById(
        fieldId
      );

    if (!field) {
      return;
    }

    field.addEventListener(
      "input",
      saveContactInfo
    );
  });
}


function saveContactInfo() {
  const nameElement =
    document.getElementById(
      "contactName"
    );

  const companyElement =
    document.getElementById(
      "contactCompany"
    );

  const emailElement =
    document.getElementById(
      "contactEmail"
    );

  if (
    !nameElement ||
    !companyElement ||
    !emailElement
  ) {
    return;
  }

  const contactInfo = {
    name: nameElement.value,
    company: companyElement.value,
    email: emailElement.value
  };

  try {
    localStorage.setItem(
      CONTACT_INFO_STORAGE_KEY,
      JSON.stringify(contactInfo)
    );
  } catch (error) {
    console.error(
      "お問い合わせ情報の保存に失敗しました。",
      error
    );
  }
}


function loadContactInfo() {
  let savedContactInfo;

  try {
    savedContactInfo =
      localStorage.getItem(
        CONTACT_INFO_STORAGE_KEY
      );
  } catch (error) {
    console.error(
      "お問い合わせ情報の読み込みに失敗しました。",
      error
    );
    return;
  }

  if (!savedContactInfo) {
    return;
  }

  try {
    const contactInfo =
      JSON.parse(savedContactInfo);

    const nameElement =
      document.getElementById(
        "contactName"
      );

    const companyElement =
      document.getElementById(
        "contactCompany"
      );

    const emailElement =
      document.getElementById(
        "contactEmail"
      );

    if (nameElement) {
      nameElement.value =
        String(contactInfo.name || "");
    }

    if (companyElement) {
      companyElement.value =
        String(contactInfo.company || "");
    }

    if (emailElement) {
      emailElement.value =
        String(contactInfo.email || "");
    }
  } catch (error) {
    console.error(
      "お問い合わせ情報の読み込みに失敗しました。",
      error
    );
  }
}


/* ========================================
   お問い合わせをGmailへ送信
======================================== */

async function sendContact(event) {
  if (event) {
    event.preventDefault();
  }

  const form =
    document.getElementById(
      "contactForm"
    );

  const submitButton =
    document.getElementById(
      "contactSubmitButton"
    );

  const statusElement =
    document.getElementById(
      "contactStatus"
    );

  if (
    !form ||
    !submitButton ||
    !statusElement
  ) {
    return;
  }

  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }

  const name =
    document.getElementById(
      "contactName"
    ).value.trim();

  const company =
    document.getElementById(
      "contactCompany"
    ).value.trim();

  const email =
    document.getElementById(
      "contactEmail"
    ).value.trim();

  const message =
    document.getElementById(
      "contactMessage"
    ).value.trim();

  const website =
    document.getElementById(
      "contactWebsite"
    ).value.trim();

  saveContactInfo();

  if (
    !name ||
    !email ||
    !message
  ) {
    setContactStatus(
      "必須項目を入力してください。",
      "error"
    );
    return;
  }

  if (!TEST_API_URL) {
    setContactStatus(
      "現在、お問い合わせを送信できません。時間をおいて再度お試しください。",
      "error"
    );
    return;
  }

  const originalButtonText =
    submitButton.textContent.trim();

  submitButton.disabled = true;
  submitButton.textContent =
    "送信中...";

  setContactStatus(
    "お問い合わせを送信しています。",
    "sending"
  );

  try {
    const response =
      await fetch(
        TEST_API_URL,
        {
          method: "POST",
          redirect: "follow",
          body: JSON.stringify({
            action: "sendContact",
            token: TEST_API_TOKEN,
            requestId:
              createTestRequestId(),
            name: name,
            company: company,
            email: email,
            message: message,
            website: website
          })
        }
      );

    const result =
      await response.json();

    if (!result.ok) {
      throw new Error(
        result.error ||
        "送信できませんでした"
      );
    }

    form.reset();
    loadContactInfo();

    setContactStatus(
      "お問い合わせを送信しました。内容を確認後、メールでご連絡します。（メールはgmailに直接返信されます）",
      "success"
    );

  } catch (error) {
    console.error(
      "お問い合わせの送信に失敗しました。",
      error
    );

    const errorMessage =
      String(error.message) ===
      "too_many_requests"
        ? "短時間に複数回送信されています。しばらく待ってから再度お試しください。"
        : "送信できませんでした。通信状況を確認して、もう一度お試しください。";

    setContactStatus(
      errorMessage,
      "error"
    );

  } finally {
    submitButton.disabled = false;
    submitButton.textContent =
      originalButtonText;
  }
}


function setContactStatus(
  message,
  state
) {
  const statusElement =
    document.getElementById(
      "contactStatus"
    );

  if (!statusElement) {
    return;
  }

  statusElement.textContent =
    message;

  statusElement.className =
    `contact-status ${state || ""}`
      .trim();
}


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
