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
    // Synthetic test targets only: not evidence of real resource names.
    API_SERVICE_NAME: `synthetic-${environment}-api`,
    MIGRATION_JOB_NAME: `synthetic-${environment}-job`,
    GCP_PROJECT_ID: "synthetic-project",
    GCP_REGION: "asia-northeast1",
    GCP_RUNTIME_SERVICE_ACCOUNT:
      "synthetic@synthetic-project.iam.gserviceaccount.com",
    CLOUD_SQL_CONNECTION_NAME: "synthetic-project:asia-northeast1:synthetic-db",
    PUBLIC_ORIGIN: `https://${environment}.example`,
    COOKIE_NAME: "synthetic_session",
    GOOGLE_OAUTH_CLIENT_ID: "synthetic-google.apps.googleusercontent.com",
    GOOGLE_OAUTH_REDIRECT_URI: `https://${environment}.example/api/v1/auth/google/callback`,
    MICROSOFT_LOGIN_OAUTH_CLIENT_ID: "3f5a7e56-c7cb-46a0-9477-ca90b696d3d8",
    MICROSOFT_LOGIN_OAUTH_REDIRECT_URI: `https://${environment}.example/api/v1/auth/microsoft/callback`,
    MICROSOFT_LOGIN_OAUTH_TENANT: "6af9d90a-8ed4-420b-ad82-a80296dee18d",
    GMAIL_OAUTH_CLIENT_ID: "synthetic-gmail-client-id",
    GMAIL_OAUTH_REDIRECT_URI: `https://${environment}.example/api/v1/auth/gmail/callback`,
    MICROSOFT_OAUTH_CLIENT_ID: "synthetic-microsoft-mail-client-id",
    MICROSOFT_OAUTH_REDIRECT_URI: `https://${environment}.example/api/v1/auth/mail/microsoft/callback`,
    MICROSOFT_OAUTH_TENANT: "common",
    MAIL_TOKEN_ENCRYPTION_KEY_VERSION: "synthetic-v1",
    MAIL_KMS_KEY_NAME:
      "projects/synthetic/locations/test/keyRings/test/cryptoKeys/test",
    SMTP_HOST: "smtp.synthetic.example",
    SMTP_PORT: "587",
    SMTP_SECURE: "false",
    EMAIL_FROM: "Call Now <no-reply@synthetic.example>",
  };
}

function render(template, vars) {
  return template.replace(/\$\{\{ vars\.([A-Z0-9_]+) \}\}/gu, (_, key) => {
    assert.ok(Object.hasOwn(vars, key), `Missing fixture field ${key}`);
    return vars[key];
  });
}

const smtpPlainVariables = [
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_SECURE",
  "EMAIL_FROM",
];
const smtpPairs = secretReferences.filter(([name]) => name.startsWith("SMTP_"));
const smtpVariables = [...smtpPlainVariables, ...smtpPairs.flat()];

// Execute only the workflow's command assembly with synthetic metadata. Replace
// gcloud with a Bash builtin recorder; PATH has no binaries, credentials or SDK.
function apiArguments(vars, environment) {
  const step = workflow.split("      - name: Deploy HTTPS API\n")[1];
  const [metadata, body] = step.split("        run: |\n");
  assert.ok(body, "API deploy must use a literal shell block");
  const env = {
    PATH: "/no-external-programs",
    API_IMAGE: "synthetic-api-image:synthetic-sha",
  };
  for (const [, name, key] of metadata.matchAll(
    /^ {10}([A-Z0-9_]+): \$\{\{ vars\.([A-Z0-9_]+) \}\}$/gmu,
  )) {
    env[name] = vars[key] ?? "";
  }
  let script = render(
    body
      .replace(/^ {10}/gmu, "")
      .replaceAll("${{ inputs.environment }}", environment),
    vars,
  );
  assert.equal((script.match(/gcloud run deploy /gu) ?? []).length, 1);
  script = script.replace("gcloud run deploy ", "capture_deploy run deploy ");
  const result = spawnSync(
    "/bin/bash",
    [
      "-euo",
      "pipefail",
      "-c",
      "capture_deploy() { printf '%s\\0' \"$@\"; }\n" + script,
    ],
    { env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, "offline command assembly failed");
  assert.equal(result.stderr, "");
  const args = result.stdout.split("\0");
  assert.equal(args.pop(), "");
  assert.deepEqual(args.slice(0, 3), ["run", "deploy", vars.API_SERVICE_NAME]);
  for (const option of ["--set-env-vars", "--set-secrets"]) {
    assert.equal(args.filter((value) => value === option).length, 1);
  }
  return args;
}

function optionMap(args, option) {
  const value = args[args.indexOf(option) + 1];
  const entries = value.split(",").map((item) => {
    const split = item.indexOf("=");
    assert.ok(split > 0);
    return [item.slice(0, split), item.slice(split + 1)];
  });
  assert.equal(new Set(entries.map(([key]) => key)).size, entries.length);
  assert.ok(entries.every(([, value]) => value !== ""));
  return Object.fromEntries(entries);
}

for (const environment of ["staging", "production"]) {
  test(`${environment}: service deploy and job deploy/execute use explicit targets without fallback`, () => {
    const commands = workflow
      .split("\n")
      .map((line) => line.trim().replace(/ \\$/u, ""))
      .filter((line) => line.startsWith("gcloud run "));
    assert.deepEqual(commands, [
      'gcloud run jobs deploy "${{ vars.MIGRATION_JOB_NAME }}"',
      'gcloud run jobs execute "${{ vars.MIGRATION_JOB_NAME }}"',
      'gcloud run deploy "${{ vars.API_SERVICE_NAME }}"',
    ]);
    const vars = fixture(environment);
    assert.deepEqual(
      commands.map((command) => render(command, vars)),
      [
        `gcloud run jobs deploy "${vars.MIGRATION_JOB_NAME}"`,
        `gcloud run jobs execute "${vars.MIGRATION_JOB_NAME}"`,
        `gcloud run deploy "${vars.API_SERVICE_NAME}"`,
      ],
    );
  });

  test(`${environment}: explicit names and pinned versions resolve every deployed secret`, () => {
    const vars = fixture(environment);
    assert.deepEqual(validateDeployVariables(vars, environment), []);
    const migrationTemplate = /--set-secrets "([^"\n]+)"/u.exec(workflow)[1];
    const migration = Object.fromEntries(
      render(migrationTemplate, vars)
        .split(",")
        .map((item) => item.split("=")),
    );
    const api = optionMap(apiArguments(vars, environment), "--set-secrets");
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
    assert.doesNotMatch(migrationTemplate, /=call-now-/u);
  });
}

test("Artifact Registry image names remain shared and independent of resource targets", () => {
  const images = workflow
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^(API_IMAGE|MIGRATION_IMAGE):/u.test(line));
  const registry =
    "${{ vars.GCP_REGION }}-docker.pkg.dev/${{ vars.GCP_PROJECT_ID }}/${{ vars.ARTIFACT_REPOSITORY }}";
  assert.deepEqual(images, [
    `API_IMAGE: ${registry}/call-now-api:\${{ github.sha }}`,
    `MIGRATION_IMAGE: ${registry}/call-now-db-migrate:\${{ github.sha }}`,
  ]);
});

for (const key of ["API_SERVICE_NAME", "MIGRATION_JOB_NAME"]) {
  test(`${key}: accepts lowercase RFC-1035 labels at length boundaries`, () => {
    for (const environment of ["staging", "production"]) {
      for (const value of [
        "a",
        "a0",
        "a-b",
        "a".repeat(63),
        "a" + "-".repeat(61) + "0",
      ]) {
        assert.deepEqual(
          validateDeployVariables(
            { ...fixture(environment), [key]: value },
            environment,
          ),
          [],
        );
      }
    }
  });

  test(`${key}: missing value fails closed in both environments`, () => {
    for (const environment of ["staging", "production"]) {
      const vars = fixture(environment);
      delete vars[key];
      assert.deepEqual(validateDeployVariables(vars, environment), [key]);
    }
  });

  test(`${key}: rejects invalid format and types without reporting values`, () => {
    for (const environment of ["staging", "production"]) {
      for (const value of [
        "",
        null,
        7,
        false,
        {},
        [],
        "API",
        "aB",
        "0api",
        "-api",
        "api-",
        "api_name",
        "api.name",
        " api",
        "api ",
        "a".repeat(64),
        "a\n",
        "a\r",
        "a\t",
        "a\nb",
        "é",
        "a/b",
        "a,b",
        'a"',
        "$(command)",
      ]) {
        assert.deepEqual(
          validateDeployVariables(
            { ...fixture(environment), [key]: value },
            environment,
          ),
          [key],
        );
      }
    }
  });
}

test("both resource names are required even when every previous setting is valid", () => {
  const vars = fixture();
  delete vars.API_SERVICE_NAME;
  delete vars.MIGRATION_JOB_NAME;
  assert.deepEqual(validateDeployVariables(vars, "staging"), [
    "API_SERVICE_NAME",
    "MIGRATION_JOB_NAME",
  ]);
});

test("Microsoft login's four values use the dedicated login contract, not mail monitoring", () => {
  const env = /api_env_vars="([^"\n]+)"/u.exec(workflow)[1];
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

test("staging: all SMTP variables absent or empty are valid and omitted from both command options", () => {
  for (const empty of [undefined, ""]) {
    const vars = fixture();
    for (const key of smtpVariables) {
      if (empty === undefined) delete vars[key];
      else vars[key] = empty;
    }
    assert.deepEqual(validateDeployVariables(vars, "staging"), []);
    const args = apiArguments(vars, "staging");
    const env = optionMap(args, "--set-env-vars");
    const secrets = optionMap(args, "--set-secrets");
    assert.ok(smtpPlainVariables.every((key) => !Object.hasOwn(env, key)));
    assert.ok(!Object.hasOwn(secrets, "SMTP_USER"));
    assert.ok(!Object.hasOwn(secrets, "SMTP_PASSWORD"));
    const configured = apiArguments(fixture(), "staging");
    const originalEnv = optionMap(configured, "--set-env-vars");
    const originalSecrets = optionMap(configured, "--set-secrets");
    for (const key of smtpPlainVariables) delete originalEnv[key];
    delete originalSecrets.SMTP_USER;
    delete originalSecrets.SMTP_PASSWORD;
    assert.deepEqual(env, originalEnv);
    assert.deepEqual(secrets, originalSecrets);
  }
});

test("production: each SMTP variable remains required, including explicit empty strings", () => {
  for (const key of smtpVariables) {
    for (const empty of [undefined, ""]) {
      const vars = { ...fixture("production"), [key]: empty };
      assert.deepEqual(validateDeployVariables(vars, "production"), [key]);
    }
  }
});

for (const [name, version] of smtpPairs) {
  test(`${name}: staging allows an omitted pair but rejects a partial pair`, () => {
    for (const empty of [undefined, ""]) {
      const vars = { ...fixture(), [name]: empty, [version]: empty };
      assert.deepEqual(validateDeployVariables(vars, "staging"), []);
      const secrets = optionMap(apiArguments(vars, "staging"), "--set-secrets");
      assert.ok(!Object.hasOwn(secrets, name.replace("_SECRET_NAME", "")));
      for (const key of [name, version]) {
        assert.deepEqual(
          validateDeployVariables({ ...fixture(), [key]: empty }, "staging"),
          [key],
        );
      }
    }
  });

  test(`${name}: provided staging and production names/versions retain strict validation`, () => {
    for (const environment of ["staging", "production"]) {
      for (const [key, values] of [
        [
          name,
          [
            null,
            1,
            false,
            {},
            [],
            " ",
            "a/b",
            "x:1",
            "a,b",
            "x\n",
            "x\r",
            "$(command)",
          ],
        ],
        [
          version,
          [
            null,
            1,
            false,
            {},
            [],
            " ",
            "latest",
            "0",
            "-1",
            "1.5",
            "1\n",
            "1,OTHER=bad",
          ],
        ],
      ]) {
        for (const value of values) {
          assert.deepEqual(
            validateDeployVariables(
              { ...fixture(environment), [key]: value },
              environment,
            ),
            [key],
          );
        }
      }
    }
  });
}

test("plain SMTP variables: staging omits each unset field independently", () => {
  for (const key of smtpPlainVariables) {
    const vars = fixture();
    delete vars[key];
    assert.deepEqual(validateDeployVariables(vars, "staging"), []);
    const env = optionMap(apiArguments(vars, "staging"), "--set-env-vars");
    assert.ok(!Object.hasOwn(env, key));
    for (const other of smtpPlainVariables.filter((name) => name !== key)) {
      assert.equal(env[other], vars[other]);
    }
  }
});

test("plain SMTP variables: validate configured types/ranges and reject delimiters/control characters", () => {
  for (const environment of ["staging", "production"]) {
    for (const [key, values] of [
      ["SMTP_HOST", [" ", "smtp host", "host,OTHER=bad", "host\n", "host\0"]],
      ["SMTP_PORT", ["0", "65536", "-1", "1.2", "25x", "25\n", "25,OTHER=bad"]],
      ["SMTP_SECURE", ["TRUE", "0", "yes", "false\n", "true,OTHER=bad"]],
      ["EMAIL_FROM", ["ab", "   ", "x\r\nBcc: x", "x,y", "x\0y"]],
    ]) {
      for (const value of [null, 1, false, {}, [], ...values]) {
        assert.deepEqual(
          validateDeployVariables(
            { ...fixture(environment), [key]: value },
            environment,
          ),
          [key],
        );
      }
    }
    for (const port of ["1", "25", "465", "587", "65535"]) {
      assert.deepEqual(
        validateDeployVariables(
          { ...fixture(environment), SMTP_PORT: port },
          environment,
        ),
        [],
      );
    }
    for (const secure of ["true", "false"]) {
      const vars = { ...fixture(environment), SMTP_SECURE: secure };
      assert.deepEqual(validateDeployVariables(vars, environment), []);
      assert.equal(
        optionMap(apiArguments(vars, environment), "--set-env-vars")
          .SMTP_SECURE,
        secure,
      );
    }
  }
});

test("production: generated environment and secret mappings preserve all existing configured values", () => {
  const vars = fixture("production");
  assert.deepEqual(validateDeployVariables(vars, "production"), []);
  const env = optionMap(apiArguments(vars, "production"), "--set-env-vars");
  assert.deepEqual(env, {
    APP_ENV: "production",
    TRUST_PROXY_HOPS: "1",
    MAIL_TOKEN_ENCRYPTION_PROVIDER: "gcp-kms",
    ...Object.fromEntries(
      [
        "PUBLIC_ORIGIN",
        "COOKIE_NAME",
        "GOOGLE_OAUTH_CLIENT_ID",
        "GOOGLE_OAUTH_REDIRECT_URI",
        "MICROSOFT_LOGIN_OAUTH_CLIENT_ID",
        "MICROSOFT_LOGIN_OAUTH_REDIRECT_URI",
        "MICROSOFT_LOGIN_OAUTH_TENANT",
        "GMAIL_OAUTH_CLIENT_ID",
        "GMAIL_OAUTH_REDIRECT_URI",
        "MICROSOFT_OAUTH_CLIENT_ID",
        "MICROSOFT_OAUTH_REDIRECT_URI",
        "MICROSOFT_OAUTH_TENANT",
        "MAIL_TOKEN_ENCRYPTION_KEY_VERSION",
        "MAIL_KMS_KEY_NAME",
        ...smtpPlainVariables,
      ].map((key) => [key, vars[key]]),
    ),
  });
});

test("SMTP shell environment preserves quoted display names without executing substitutions", () => {
  const vars = {
    ...fixture(),
    EMAIL_FROM: '"Call Now $(exit 9) `exit 8`" <no-reply@synthetic.example>',
  };
  assert.deepEqual(validateDeployVariables(vars, "staging"), []);
  assert.equal(
    optionMap(apiArguments(vars, "staging"), "--set-env-vars").EMAIL_FROM,
    vars.EMAIL_FROM,
  );
});

test("all non-SMTP secret pairs, including both mail-monitoring providers, stay required everywhere", () => {
  for (const environment of ["staging", "production"]) {
    for (const [name, version] of secretReferences.filter(
      ([key]) => !key.startsWith("SMTP_"),
    )) {
      const vars = fixture(environment);
      delete vars[name];
      delete vars[version];
      assert.deepEqual(validateDeployVariables(vars, environment), [
        name,
        version,
      ]);
    }
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
    JSON.stringify({ ...fixture(), API_SERVICE_NAME: marker + ",bad" }),
    JSON.stringify({ ...fixture(), MIGRATION_JOB_NAME: marker + ",bad" }),
    JSON.stringify({ ...fixture(), SMTP_USER_SECRET_NAME: marker + ",bad" }),
    JSON.stringify({ ...fixture(), SMTP_PASSWORD_SECRET_VERSION: marker }),
    JSON.stringify({ ...fixture(), SMTP_HOST: marker + ",bad" }),
    JSON.stringify({ ...fixture(), EMAIL_FROM: marker + "\r\n" }),
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
