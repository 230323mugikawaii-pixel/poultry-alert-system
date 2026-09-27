import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  secretReferences,
  validateDeployVariables,
} from "../scripts/validate-deploy-config.mjs";

const workflow = readFileSync(
  new URL("../.github/workflows/deploy.yml", import.meta.url),
  "utf8",
);
const stagingNames = [
  "synthetic-staging-migrator-db-url",
  "call-now-staging-runtime-db-url",
  "call-now-staging-auth-token-pepper",
  "call-now-staging-google-login-client-secret",
  "call-now-staging-microsoft-login-client-secret",
  "synthetic-staging-gmail-secret",
  "synthetic-staging-microsoft-mail-secret",
  "synthetic-staging-smtp-user",
  "synthetic-staging-smtp-password",
];
const productionNames = [
  "call-now-database-url",
  "call-now-database-url",
  "call-now-auth-token-pepper",
  "call-now-google-oauth-client-secret",
  "call-now-microsoft-login-oauth-client-secret",
  "call-now-gmail-oauth-client-secret",
  "call-now-microsoft-oauth-client-secret",
  "call-now-smtp-user",
  "call-now-smtp-password",
];

function fixture(environment = "staging") {
  const names = environment === "staging" ? stagingNames : productionNames;
  return {
    ...Object.fromEntries(
      secretReferences.flatMap(([name, version], index) => [
        [name, names[index]],
        [version, String(index + 1)],
      ]),
    ),
    GOOGLE_OAUTH_CLIENT_ID: "synthetic-google.apps.googleusercontent.com",
    GOOGLE_OAUTH_REDIRECT_URI: `https://${environment}.example/api/v1/auth/google/callback`,
    MICROSOFT_LOGIN_OAUTH_CLIENT_ID: "3f5a7e56-c7cb-46a0-9477-ca90b696d3d8",
    MICROSOFT_LOGIN_OAUTH_REDIRECT_URI: `https://${environment}.example/api/v1/auth/microsoft/callback`,
    MICROSOFT_LOGIN_OAUTH_TENANT: "6af9d90a-8ed4-420b-ad82-a80296dee18d",
  };
}

function render(template, vars) {
  return template.replace(/\$\{\{ vars\.([A-Z0-9_]+) \}\}/gu, (_, key) => {
    assert.ok(Object.hasOwn(vars, key), `Missing fixture field ${key}`);
    return vars[key];
  });
}

for (const environment of ["staging", "production"]) {
  test(`${environment}: explicit names and pinned versions resolve every deployed secret`, () => {
    const vars = fixture(environment);
    assert.deepEqual(validateDeployVariables(vars, environment), []);
    const options = [...workflow.matchAll(/--set-secrets "([^"\n]+)"/gu)];
    assert.equal(options.length, 2);
    const [migration, api] = options.map(([, template]) =>
      Object.fromEntries(
        render(template, vars)
          .split(",")
          .map((item) => item.split("=")),
      ),
    );
    assert.deepEqual(migration, {
      DATABASE_URL: `${vars.MIGRATION_DATABASE_URL_SECRET_NAME}:${vars.MIGRATION_DATABASE_URL_SECRET_VERSION}`,
    });
    assert.deepEqual(api, {
      DATABASE_URL: `${vars.DATABASE_URL_SECRET_NAME}:${vars.DATABASE_URL_SECRET_VERSION}`,
      AUTH_TOKEN_PEPPER: `${vars.AUTH_TOKEN_PEPPER_SECRET_NAME}:${vars.AUTH_PEPPER_SECRET_VERSION}`,
      GOOGLE_OAUTH_CLIENT_SECRET: `${vars.GOOGLE_OAUTH_CLIENT_SECRET_NAME}:${vars.GOOGLE_OAUTH_CLIENT_SECRET_VERSION}`,
      MICROSOFT_LOGIN_OAUTH_CLIENT_SECRET: `${vars.MICROSOFT_LOGIN_OAUTH_CLIENT_SECRET_NAME}:${vars.MICROSOFT_LOGIN_OAUTH_CLIENT_SECRET_VERSION}`,
      GMAIL_OAUTH_CLIENT_SECRET: `${vars.GMAIL_OAUTH_CLIENT_SECRET_NAME}:${vars.GMAIL_OAUTH_CLIENT_SECRET_VERSION}`,
      MICROSOFT_OAUTH_CLIENT_SECRET: `${vars.MICROSOFT_OAUTH_CLIENT_SECRET_NAME}:${vars.MICROSOFT_OAUTH_CLIENT_SECRET_VERSION}`,
      SMTP_USER: `${vars.SMTP_USER_SECRET_NAME}:${vars.SMTP_USER_SECRET_VERSION}`,
      SMTP_PASSWORD: `${vars.SMTP_PASSWORD_SECRET_NAME}:${vars.SMTP_PASSWORD_SECRET_VERSION}`,
    });
    for (const [name, version] of secretReferences) {
      assert.ok(workflow.includes(`\${{ vars.${name} }}`));
      assert.ok(workflow.includes(`\${{ vars.${version} }}`));
    }
    assert.doesNotMatch(options.map((x) => x[1]).join(""), /=call-now-/u);
  });
}

test("Microsoft login's four values use the dedicated login contract, not mail monitoring", () => {
  const env = /--set-env-vars "([^"\n]+)"/u.exec(workflow)[1];
  for (const key of ["CLIENT_ID", "REDIRECT_URI", "TENANT"]) {
    const name = `MICROSOFT_LOGIN_OAUTH_${key}`;
    assert.ok(env.includes(`${name}=\${{ vars.${name} }}`));
    const mailName = `MICROSOFT_OAUTH_${key}`;
    assert.ok(env.includes(`${mailName}=\${{ vars.${mailName} }}`));
  }
  assert.ok(
    workflow.includes(
      "MICROSOFT_LOGIN_OAUTH_CLIENT_SECRET=${{ vars.MICROSOFT_LOGIN_OAUTH_CLIENT_SECRET_NAME }}:${{ vars.MICROSOFT_LOGIN_OAUTH_CLIENT_SECRET_VERSION }}",
    ),
  );
  assert.doesNotMatch(env, /CLIENT_SECRET=/u);
  assert.ok(
    env.includes("GOOGLE_OAUTH_CLIENT_ID=${{ vars.GOOGLE_OAUTH_CLIENT_ID }}"),
  );
});

test("metadata preflight runs before Cloud auth or side effects; deploy remains manual", () => {
  const preflight = workflow.indexOf(
    "run: node scripts/validate-deploy-config.mjs",
  );
  assert.ok(
    preflight > 0 &&
      preflight < workflow.indexOf("google-github-actions/auth@"),
  );
  assert.ok(preflight < workflow.indexOf("docker build"));
  assert.match(workflow, /environment: \$\{\{ inputs\.environment \}\}/u);
  assert.match(workflow, /DEPLOY_VARIABLES_JSON: \$\{\{ toJSON\(vars\) \}\}/u);
  assert.match(
    workflow,
    /DEPLOY_ENVIRONMENT: \$\{\{ inputs\.environment \}\}/u,
  );
  assert.match(workflow, /on:\n  workflow_dispatch:/u);
  assert.doesNotMatch(workflow, /^  (push|pull_request|schedule):/mu);
});

test("every missing name/version fails closed, including migration and Microsoft login", () => {
  for (const key of secretReferences.flat()) {
    const vars = fixture();
    delete vars[key];
    assert.deepEqual(validateDeployVariables(vars, "staging"), [key]);
  }
});

test("invalid secret IDs, unpinned versions and gcloud delimiter injection are rejected", () => {
  for (const value of [
    "",
    "other/name",
    "x:1",
    "x,y",
    " x",
    "$(command)",
    "x\nOTHER=bad",
  ]) {
    assert.deepEqual(
      validateDeployVariables(
        { ...fixture(), DATABASE_URL_SECRET_NAME: value },
        "staging",
      ),
      ["DATABASE_URL_SECRET_NAME"],
    );
  }
  for (const value of ["", "latest", "0", "-1", "1,OTHER=bad", "1\n"]) {
    assert.deepEqual(
      validateDeployVariables(
        { ...fixture(), DATABASE_URL_SECRET_VERSION: value },
        "staging",
      ),
      ["DATABASE_URL_SECRET_VERSION"],
    );
  }
});

test("single-tenant staging cannot silently fall back to common", () => {
  for (const value of [
    "",
    "common",
    "organizations",
    "consumers",
    "not/a/tenant",
  ]) {
    assert.deepEqual(
      validateDeployVariables(
        { ...fixture(), MICROSOFT_LOGIN_OAUTH_TENANT: value },
        "staging",
      ),
      ["MICROSOFT_LOGIN_OAUTH_TENANT"],
    );
  }
  for (const value of ["common", "organizations", "consumers", "COMMON"]) {
    assert.deepEqual(
      validateDeployVariables(
        { ...fixture("production"), MICROSOFT_LOGIN_OAUTH_TENANT: value },
        "production",
      ),
      [],
    );
  }
});

test("both login client IDs and exact HTTPS callback paths must be configured", () => {
  for (const provider of ["GOOGLE", "MICROSOFT_LOGIN"]) {
    const key = `${provider}_OAUTH_CLIENT_ID`;
    assert.deepEqual(
      validateDeployVariables({ ...fixture(), [key]: "" }, "staging"),
      [key],
    );
    assert.deepEqual(
      validateDeployVariables(
        { ...fixture(), [key]: "x,$(echo unsafe)" },
        "staging",
      ),
      [key],
    );
  }
  for (const key of [
    "GOOGLE_OAUTH_REDIRECT_URI",
    "MICROSOFT_LOGIN_OAUTH_REDIRECT_URI",
  ]) {
    for (const value of [
      "",
      "http://staging.example/callback",
      "https://staging.example/wrong",
      fixture()[key] + "/",
      fixture()[key] + "?code=unsafe",
    ]) {
      assert.deepEqual(
        validateDeployVariables({ ...fixture(), [key]: value }, "staging"),
        [key],
      );
    }
  }
});

test("preflight handles malformed metadata safely and rejects an unknown environment", () => {
  for (const value of [undefined, null, [], "not-an-object"]) {
    assert.deepEqual(validateDeployVariables(value, "staging"), [
      "DEPLOY_VARIABLES_JSON",
    ]);
  }
  assert.deepEqual(validateDeployVariables(fixture(), "wrong"), [
    "DEPLOY_ENVIRONMENT",
  ]);
});

test("CLI does not echo invalid values or parse errors and performs no cloud lookup", () => {
  const script = fileURLToPath(
    new URL("../scripts/validate-deploy-config.mjs", import.meta.url),
  );
  const marker = "synthetic-sensitive-marker-do-not-print";
  for (const json of [
    marker,
    JSON.stringify({ ...fixture(), DATABASE_URL_SECRET_NAME: marker + ",bad" }),
    JSON.stringify(fixture()),
  ]) {
    const result = spawnSync(process.execPath, [script], {
      env: { DEPLOY_ENVIRONMENT: "staging", DEPLOY_VARIABLES_JSON: json },
      encoding: "utf8",
    });
    assert.equal(result.status, json === JSON.stringify(fixture()) ? 0 : 1);
    assert.ok(!(result.stdout + result.stderr).includes(marker));
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /\bat file:|SyntaxError|call-now-staging-/u,
    );
  }
});
