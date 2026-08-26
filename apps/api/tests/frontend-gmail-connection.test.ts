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
    expect(frontend).toContain("Gmail監視アカウント");
    expect(frontend).toContain("Call Nowログイン");
    expect(frontend).toContain("Gmail監視");
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
