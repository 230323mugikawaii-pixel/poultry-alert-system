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
const frontend = `${html}\n${script}`;

describe("frontend mail connection boundary", () => {
  it("shows login identity and mail monitoring as separate account roles", () => {
    expect(frontend).toContain("ログイン中のGoogleアカウント");
    expect(frontend).toContain("メール監視アカウント");
    expect(frontend).toContain("Call Nowログイン");
    expect(frontend).toContain("Gmail / Google Workspace");
    expect(frontend).toContain("Microsoft 365 / Outlook");
  });

  it("uses common server APIs without storing provider credentials", () => {
    expect(script).toContain('beginMailOAuth("oauth/start", provider)');
    expect(script).toContain('"reauthorize",\n    mailConnection.provider');
    expect(script).toContain("/mail-connection/${action}?provider=");
    expect(script).toContain('method: "DELETE"');
    expect(script).not.toMatch(/refresh[_-]?token/iu);
    expect(script).not.toMatch(/access[_-]?token/iu);
  });

  it("keeps one active monitoring connection and confirms provider changes", () => {
    expect(script).toContain("mailConnection.provider !== provider");
    expect(script).toContain("新しい認証が成功するまで維持されます");
    expect(script).toContain("mailProviderLabel(mailConnection.provider)");
  });
});
