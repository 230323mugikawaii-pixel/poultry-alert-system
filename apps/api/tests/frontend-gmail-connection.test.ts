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

describe("frontend Gmail connection boundary", () => {
  it("shows login identity and Gmail monitoring as separate account roles", () => {
    expect(frontend).toContain("ログイン中のGoogleアカウント");
    expect(frontend).toContain("メール監視アカウント");
    expect(frontend).toContain("Call Nowログイン");
    expect(frontend).toContain("Gmail監視");
  });

  it("uses one Google login CTA and bootstraps monitoring access without exposing internal roles", () => {
    expect(frontend).not.toContain("ログインしてホームへ");
    expect(html).toContain('id="finishGoogleLinkButton"');
    expect(html).toContain("full-width hidden");
    expect(script).toContain('mode !== "manage"');
    expect(script).toContain("/api/v1/teams/bootstrap");
    expect(frontend).toContain("Gmail / Google Workspace");
    expect(frontend).toContain(
      "メール監視アカウントの変更は管理者のみ行えます。"
    );
    expect(frontend).not.toContain(
      "チーム登録完了後に、代表者がGmail監視アカウントを接続できます。"
    );
  });

  it("uses the server connection APIs without storing Gmail credentials", () => {
    expect(script).toContain('beginGmailOAuth("oauth/start")');
    expect(script).toContain('beginGmailOAuth("reauthorize")');
    expect(script).toContain("/gmail-connection/${action}");
    expect(script).toContain('method: "DELETE"');
    expect(script).not.toMatch(/refresh[_-]?token/iu);
    expect(script).not.toMatch(/access[_-]?token/iu);
  });
});
