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
  it("starts with provider selection and no marketing hero", () => {
    expect(html).not.toContain("今すぐ始める");
    expect(html).not.toContain('id="landingScreen"');
    expect(html).not.toContain('class="hero"');
    expect(html).toContain("Call Nowに登録・ログイン");
    expect(html).toContain("Googleで続ける");
    expect(html).toContain("Microsoftで続ける");
    expect(html).toContain("Appleで続ける");
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
    expect(script).toContain('openGoogleScreen("login")');
    expect(script).not.toContain('"landingScreen",\n    "setupScreen"');
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
    expect(script).toContain("/api/v1/auth/${provider.toLowerCase()}/start");
    expect(script).toMatch(/begin(?:Gmail|Mail)OAuth\("oauth\/start"/u);
    expect(script).not.toMatch(/auth\/google\/start[^\n]*gmail\.readonly/iu);
    expect(script).not.toMatch(/refresh[_-]?token/iu);
    expect(script).not.toMatch(/access[_-]?token/iu);
  });
});
