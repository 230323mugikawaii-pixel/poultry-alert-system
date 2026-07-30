"use strict";
/* ========================================
   契約データを保存
======================================== */

function saveData() {
  const data = {
    keywords: keywords,
    totalPrice: totalPrice,
    googleEmail: googleEmail,

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
      typeof data.googleEmail ===
      "string"
    ) {
      googleEmail =
        data.googleEmail;
    }

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
const EXTRA_KEYWORD_PRICE = 1000;
const STORAGE_KEY = "callNowContract";
const SESSION_KEY = "callNowSession";
const TEST_API_URL =
  "https://script.google.com/macros/s/AKfycbw6hllq-Teht0GXydKn0V9GijokIhaCCUfBAeUKdTgIY2Vi7yqznDG55Xa1BTQtfitMgw/exec";

const TEST_API_TOKEN =
  "callnow-test-2026-Abc123456789";

let keywords = ["停電", "通電", "警報"];
let totalPrice = BASE_PRICE;
let contractStartDate = null;
let contractEndDate = null;
let googleEmail = "";
let setupMode = "signup";
/*
  現在の契約期間で、すでに支払った年額
*/
let paidAnnualPrice = BASE_PRICE;

/*
  signup：初回契約
  upgrade：キーワード追加による料金アップ
*/
let paymentMode = "signup";

/*
  編集前の料金
*/
let priceBeforeEditing = BASE_PRICE;

window.addEventListener("DOMContentLoaded", () => {
  loadSavedData();
  normalizeKeywords();
  updatePrice();
  renderKeywordInputs();

  const sessionIsActive =
    sessionStorage.getItem(SESSION_KEY) === "active";

  const canOpenApp =
    sessionIsActive &&
    contractStartDate &&
    contractEndDate &&
    googleEmail;

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
        oninput="changeKeyword(${index}, this.value)"
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


function changeKeyword(index, value) {
  keywords[index] = value;

  showSetupError("");

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


function showSetupError(message) {
  setText(
    "setupError",
    message
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

  totalPrice =
    BASE_PRICE +
    extraPrice;

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
      "登録キーワードを変更できます。変更内容を保存すると管理画面へ戻ります。"
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
    "Googleアカウント選択へ";
}


function continueFromSetup() {
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
  openGoogleScreen();

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

}

/* ========================================
   決済確認画面
======================================== */

function openPayment() {
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

function completeDemoPayment() {
  if (paymentMode === "upgrade") {
    const additionalPrice =
      totalPrice - paidAnnualPrice;

    paidAnnualPrice =
      totalPrice;

    saveData();
    openApp();

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
  openGoogleScreen();
}


/* ========================================
   Googleアカウント選択
======================================== */

function openGoogleScreen() {
  showOnlyScreen(
    "googleScreen"
  );

  renderGoogleAccountOptions();

  setText(
    "googleError",
    ""
  );

  const emailInput =
    document.getElementById(
      "googleEmail"
    );

  if (emailInput) {
    emailInput.value = "";
  }

  window.scrollTo({
    top: 0
  });
}


function renderGoogleAccountOptions() {
  const savedAccountCard =
    document.getElementById(
      "savedGoogleAccountCard"
    );

  if (!savedAccountCard) {
    return;
  }

  savedAccountCard.classList.toggle(
    "hidden",
    googleEmail.length === 0
  );

  setText(
    "savedGoogleEmail",
    googleEmail
  );
}


function useSavedGoogleAccount() {
  if (!googleEmail) {
    return;
  }

  finishLogin();
}


function backFromGoogle() {
  showOnlyScreen(
    "setupScreen"
  );

  renderKeywordInputs();

  updateSetupScreenText();

  window.scrollTo({
    top: 0
  });
}


function completeGoogleLogin() {
  const emailInput =
    document.getElementById(
      "googleEmail"
    );

  const enteredEmail =
    emailInput
      ? emailInput.value.trim()
      : "";

  if (!isValidEmail(enteredEmail)) {
    setText(
      "googleError",
      "正しいメールアドレスを入力してください。"
    );

    return;
  }

  googleEmail =
    enteredEmail;

  saveData();

  finishLogin();
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
  const confirmed =
    window.confirm(
      `契約を1年間更新しますか？

更新料金：${formatYen(totalPrice)}

現在は試作版のため、実際の決済は行われません。`
    );

  if (!confirmed) {
    return;
  }

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

  saveData();

  renderTestKeywordCards();

  renderContractInformation();

  window.alert(
    `契約を更新しました。

新しい契約終了日：${formatDate(contractEndDate)}`
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

  setText(
    "connectedGoogleAccount",
    googleEmail || "未選択"
  );

  showAppPage(
    "homePage"
  );

  window.scrollTo({
    top: 0
  });
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

  sessionStorage.removeItem(
    SESSION_KEY
  );

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
  () =>
    testNotification(
      keyword,
      button
    )
);
    }

    container.appendChild(card);
  });

  updateContractStatusUI();
}

async function testNotification(keyword, button) {
  const testButtons =
    document.querySelectorAll(
      'button[onclick*="testNotification"]'
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
        60000
      );

    if (detectedStatus) {
      window.alert(
        `テスト成功！

「${keyword}」のメールをGmailへ送信し、
システムがメールを検知しました。

検知時刻：
${
  detectedStatus.detectedAt ||
  "確認済み"
}`
      );
    } else {
      window.alert(
        `Gmailへの送信処理は行いましたが、
1分以内に検知結果を確認できませんでした。

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

      const result =
        await response.json();

      if (
        result.ok &&
        result.status &&
        result.status.state ===
          "detected"
      ) {
        return result.status;
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
   画面切り替え
======================================== */

function showOnlyScreen(screenId) {
  const screenIds = [
    "landingScreen",
    "setupScreen",
    "paymentScreen",
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
/* ========================================
   契約データを保存
======================================== */

function saveData() {
  const data = {
    keywords: keywords,
    totalPrice: totalPrice,
    googleEmail: googleEmail,

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
      typeof data.googleEmail ===
      "string"
    ) {
      googleEmail =
        data.googleEmail;
    }

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
window.openKeywordEdit = function () {
  setupMode = "edit";

  showOnlyScreen("setupScreen");
  renderKeywordInputs();
  updateSetupScreenText();

  window.scrollTo({
    top: 0
  });
  };