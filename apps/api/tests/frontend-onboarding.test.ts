import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(
  new URL("../../../index.html", import.meta.url),
  "utf8"
);
const script = readFileSync(
  new URL("../../../js/app.js", import.meta.url),
  "utf8"
);

describe("frontend onboarding order", () => {
  it("starts with a simple guest home and no marketing hero", () => {
    expect(html).not.toContain("今すぐ始める");
    expect(html).not.toContain('id="landingScreen"');
    expect(html).not.toContain('class="hero"');
    expect(html).toContain('id="guestHomeScreen"');
    expect(html).toContain("Call Nowを設定する");
    expect(html).toContain("通知グループに参加");
    expect(html).toContain("Call Nowに登録・ログイン");
    expect(html).toContain("Googleで続ける");
    expect(html).toContain("Microsoftで続ける");
    expect(html).toContain("Appleで続ける");
  });

  it("keeps owner and notification-member sessions separate", () => {
    expect(script).toContain("/api/v1/notification-members/me");
    expect(script).toContain("/api/v1/notification-members/login");
    expect(script).toContain("/api/v1/notification-members/logout");
    expect(script).toContain("notificationMemberSession");
    expect(html).toContain('id="notificationMemberAppScreen"');
    expect(html).not.toContain("メール本文を表示");
  });

  it("opens home from an authenticated session without forcing a contract", () => {
    expect(script).toContain("function hasActiveSubscription()");
    expect(script).toContain('subscription.status === "ACTIVE"');
    expect(script).toContain("synchronizeContractFromCurrentTeam();");
    const openApp = script.slice(
      script.indexOf("function openApp()"),
      script.indexOf("function renderConnectedGoogleAccounts()")
    );
    expect(openApp).not.toContain("!hasActiveSubscription()");
    expect(openApp).toContain('showOnlyScreen(\n    "appScreen"');
  });

  it("requires a server session before setup, payment, and app screens", () => {
    expect(script).toContain('"setupScreen",\n    "paymentScreen"');
    expect(script).toContain("authenticatedScreens.has(screenId)");
    expect(script).toContain('screenId === "googleScreen"');
    expect(script).toContain('googleScreenMode === "manage"');
    expect(script).toContain("if (!authenticatedUser)");
    expect(script).toContain("openOwnerSetup()");
    expect(script).not.toContain('"landingScreen",\n    "setupScreen"');
  });

  it("authorizes monitoring before purchase and enters Home after the atomic purchase", () => {
    const paymentStart = script.indexOf("async function completeDemoPayment()");
    const paymentEnd = script.indexOf(
      "/* ========================================\n   Googleアカウント選択",
      paymentStart
    );
    const paymentFlow = script.slice(paymentStart, paymentEnd);

    expect(paymentFlow).toContain("/api/v1/owner-onboarding/demo-purchase");
    expect(paymentFlow).toContain("await fetchMailConnections()");
    expect(paymentFlow).toContain("openApp()");
    expect(paymentFlow).not.toContain("bootstrapInitialTeamContext()");
    expect(paymentFlow).not.toContain('openGoogleScreen("manage")');
    expect(paymentFlow).not.toContain("openMonitoringConfirmation()");
    expect(html).not.toContain("監視アカウント確認");
  });

  it("keeps login OAuth separate from monitoring OAuth", () => {
    expect(script).toContain("/api/v1/auth/${provider.toLowerCase()}/start");
    expect(script).toMatch(/begin(?:Gmail|Mail)OAuth\("oauth\/start"/u);
    expect(script).not.toMatch(/auth\/google\/start[^\n]*gmail\.readonly/iu);
    expect(script).not.toMatch(/refresh[_-]?token/iu);
    expect(script).not.toMatch(/access[_-]?token/iu);
  });
});
