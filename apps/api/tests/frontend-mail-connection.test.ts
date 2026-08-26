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

  it("uses one Google login CTA and bootstraps both provider choices", () => {
    expect(frontend).not.toContain("ログインしてホームへ");
    expect(html).toContain('id="finishGoogleLinkButton"');
    expect(html).toContain("full-width hidden");
    expect(script).toContain('mode !== "manage"');
    expect(script).toContain("/api/v1/teams/bootstrap");
    expect(frontend).toContain(
      "メール監視アカウントの変更は管理者のみ行えます。"
    );
    expect(frontend).not.toContain("チーム登録完了後");
    expect(frontend).not.toContain("チームの代表者");
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
