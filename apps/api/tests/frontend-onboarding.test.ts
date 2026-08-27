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
  it("starts with one account registration and login CTA", () => {
    expect(html).not.toContain("今すぐ始める");
    expect(html).toContain("アカウント登録 / ログイン");
    expect(html).toContain('onclick="startAccountRegistration()"');
    expect(html).toContain("サービスについて");
    expect(html).toContain(
      "アカウント登録後、通知したいキーワードを設定できます。"
    );
  });

  it("routes an authenticated user by the server subscription", () => {
    expect(script).toContain("function hasActiveSubscription()");
    expect(script).toContain('subscription.status === "ACTIVE"');
    expect(script).toContain("synchronizeContractFromCurrentTeam();");
    expect(script).toContain("openSetupForAuthenticatedUser();");
    expect(script).not.toContain(
      "!currentTeam &&\n      contractStartDate &&\n      contractEndDate"
    );
  });

  it("requires a server session before setup, payment, and app screens", () => {
    expect(script).toContain('"setupScreen",\n    "paymentScreen"');
    expect(script).toContain("authenticatedScreens.has(screenId)");
    expect(script).toContain('screenId === "googleScreen"');
    expect(script).toContain('googleScreenMode === "manage"');
    expect(script).toContain("if (!authenticatedUser)");
    expect(script).toContain('openGoogleScreen("login")');
    expect(script).toContain("!hasActiveSubscription()");
  });

  it("opens monitoring account setup only after payment bootstrap", () => {
    const paymentStart = script.indexOf("async function completeDemoPayment()");
    const paymentEnd = script.indexOf(
      "/* ========================================\n   Googleアカウント選択",
      paymentStart
    );
    const paymentFlow = script.slice(paymentStart, paymentEnd);

    expect(paymentFlow).toContain("bootstrapInitialTeamContext()");
    expect(paymentFlow).toContain('openGoogleScreen("manage")');
    expect(paymentFlow.indexOf("bootstrapInitialTeamContext()")).toBeLessThan(
      paymentFlow.indexOf('openGoogleScreen("manage")')
    );
    expect(html).toContain("メール監視アカウント");
  });

  it("keeps login OAuth separate from monitoring OAuth", () => {
    expect(script).toContain("/api/v1/auth/google/start");
    expect(script).toContain('beginGmailOAuth("oauth/start")');
    expect(script).not.toMatch(/auth\/google\/start[^\n]*gmail\.readonly/iu);
    expect(script).not.toMatch(/refresh[_-]?token/iu);
    expect(script).not.toMatch(/access[_-]?token/iu);
  });
});
