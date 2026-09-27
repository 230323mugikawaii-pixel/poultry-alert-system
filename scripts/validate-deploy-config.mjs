import { pathToFileURL } from "node:url";

// Full Secret Manager IDs, not values. Different environments need not share
// suffixes. Migration and runtime DB credentials must be selected separately.
export const secretReferences = [
  [
    "MIGRATION_DATABASE_URL_SECRET_NAME",
    "MIGRATION_DATABASE_URL_SECRET_VERSION",
  ],
  ["DATABASE_URL_SECRET_NAME", "DATABASE_URL_SECRET_VERSION"],
  ["AUTH_TOKEN_PEPPER_SECRET_NAME", "AUTH_PEPPER_SECRET_VERSION"],
  ["GOOGLE_OAUTH_CLIENT_SECRET_NAME", "GOOGLE_OAUTH_CLIENT_SECRET_VERSION"],
  [
    "MICROSOFT_LOGIN_OAUTH_CLIENT_SECRET_NAME",
    "MICROSOFT_LOGIN_OAUTH_CLIENT_SECRET_VERSION",
  ],
  ["GMAIL_OAUTH_CLIENT_SECRET_NAME", "GMAIL_OAUTH_CLIENT_SECRET_VERSION"],
  [
    "MICROSOFT_OAUTH_CLIENT_SECRET_NAME",
    "MICROSOFT_OAUTH_CLIENT_SECRET_VERSION",
  ],
  ["SMTP_USER_SECRET_NAME", "SMTP_USER_SECRET_VERSION"],
  ["SMTP_PASSWORD_SECRET_NAME", "SMTP_PASSWORD_SECRET_VERSION"],
];

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const cloudRunResourceName = /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/u;

// Offline validation only: no Secret Manager reads, no deploy, no secret output.
// Return field names, never their contents, even for malformed inputs.
export function validateDeployVariables(vars, environment) {
  if (!vars || typeof vars !== "object" || Array.isArray(vars)) {
    return ["DEPLOY_VARIABLES_JSON"];
  }
  const invalid = [];
  if (!["staging", "production"].includes(environment))
    invalid.push("DEPLOY_ENVIRONMENT");
  for (const name of ["API_SERVICE_NAME", "MIGRATION_JOB_NAME"]) {
    if (
      typeof vars[name] !== "string" ||
      !cloudRunResourceName.test(vars[name])
    ) {
      invalid.push(name);
    }
  }
  for (const [name, version] of secretReferences) {
    if (
      typeof vars[name] !== "string" ||
      !/^[a-zA-Z0-9_-]{1,255}$/u.test(vars[name])
    ) {
      invalid.push(name);
    }
    // Explicit immutable versions: no implicit latest or empty substitutions.
    if (
      typeof vars[version] !== "string" ||
      !/^[1-9][0-9]*$/u.test(vars[version])
    ) {
      invalid.push(version);
    }
  }
  for (const name of [
    "GOOGLE_OAUTH_CLIENT_ID",
    "MICROSOFT_LOGIN_OAUTH_CLIENT_ID",
  ]) {
    if (
      typeof vars[name] !== "string" ||
      !/^[a-zA-Z0-9._-]+$/u.test(vars[name])
    )
      invalid.push(name);
  }
  for (const [name, path] of [
    ["GOOGLE_OAUTH_REDIRECT_URI", "/api/v1/auth/google/callback"],
    ["MICROSOFT_LOGIN_OAUTH_REDIRECT_URI", "/api/v1/auth/microsoft/callback"],
  ]) {
    try {
      const raw = vars[name];
      const uri = new URL(raw);
      if (
        typeof raw !== "string" ||
        /[\s,"`$\\]/u.test(raw) ||
        uri.protocol !== "https:" ||
        uri.username ||
        uri.password ||
        uri.search ||
        uri.hash ||
        uri.pathname !== path
      ) {
        invalid.push(name);
      }
    } catch {
      invalid.push(name);
    }
  }
  const tenant = vars.MICROSOFT_LOGIN_OAUTH_TENANT;
  // Matches env.ts; the documented staging registration is single-tenant, so
  // staging additionally requires its explicit directory UUID (never common).
  const tenantIsUuid = typeof tenant === "string" && uuid.test(tenant);
  const tenantIsAlias =
    typeof tenant === "string" &&
    ["common", "organizations", "consumers"].includes(tenant.toLowerCase());
  if (!tenantIsUuid && !(environment === "production" && tenantIsAlias)) {
    invalid.push("MICROSOFT_LOGIN_OAUTH_TENANT");
  }
  return invalid;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  let vars;
  try {
    vars = JSON.parse(process.env.DEPLOY_VARIABLES_JSON ?? "");
  } catch {
    // Do not expose parse errors: they can contain supplied values.
  }
  const invalid = validateDeployVariables(vars, process.env.DEPLOY_ENVIRONMENT);
  if (invalid.length) {
    console.error(`DEPLOY_CONFIGURATION_INVALID: ${invalid.join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log(
      "Deploy configuration metadata valid; cloud resources not checked.",
    );
  }
}
