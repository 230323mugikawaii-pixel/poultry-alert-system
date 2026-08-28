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
    expect(frontend).toContain("ログイン方法");
    expect(frontend).toContain("メール監視アカウント");
    expect(frontend).toContain("Call Nowログイン");
    expect(frontend).toContain("Gmail / Google Workspace");
    expect(frontend).toContain("Microsoft 365 / Outlook");
  });

  it("uses three primary login choices and bootstraps monitoring choices", () => {
    expect(frontend).not.toContain("ログインしてホームへ");
    expect(html).not.toContain('id="finishGoogleLinkButton"');
    expect(html).toContain('id="googleLoginProviderButton"');
    expect(html).toContain('id="microsoftLoginProviderButton"');
    expect(html).toContain('id="appleLoginProviderButton"');
    expect(script).toContain("/api/v1/teams/bootstrap");
    expect(frontend).toContain(
      "メール監視アカウントの変更は管理者のみ行えます。"
    );
    expect(frontend).not.toContain("チーム登録完了後");
    expect(frontend).not.toContain("チームの代表者");
  });

  it("uses common server APIs without storing provider credentials", () => {
    expect(script).toContain('beginMailOAuth("oauth/start", provider, null)');
    expect(script).toContain(
      "/mail-connections/${encodeURIComponent(connectionId)}"
    );
    expect(script).toContain("/mail-connection/providers");
    expect(html).toContain('id="googleMailProviderButton"');
    expect(html).toContain('id="microsoftMailProviderButton"');
    expect(script).toContain(
      'mailProviderAvailability[provider] !==\n    "AVAILABLE"'
    );
    expect(frontend).toContain(
      "接続を開始できませんでした。現在サービス設定を確認しています。"
    );
    expect(script).toContain('method: "DELETE"');
    expect(script).not.toMatch(/refresh[_-]?token/iu);
    expect(script).not.toMatch(/access[_-]?token/iu);
  });

  it("renders and manages multiple monitoring connections independently", () => {
    expect(script).toContain("let mailConnections = []");
    expect(script).toContain("mailConnections.map(renderMailConnectionItem)");
    expect(script).toContain("disconnectMailConnection('${connection.id}')");
    expect(script).toContain("reauthorizeMailConnection('${connection.id}'");
    expect(frontend).not.toContain("接続先を変更");
  });
});
