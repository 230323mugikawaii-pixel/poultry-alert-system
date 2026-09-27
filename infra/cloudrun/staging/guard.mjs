export const project = "call-now-staging-20260927";
export const database = "callnow_staging";
export const socket = `/cloudsql/${project}:asia-northeast1:call-now-staging-db`;

export function stagingDatabase(env, value, allowedUsers) {
  if (env.APP_ENV !== "staging" || env.STAGING_PROJECT_ID !== project)
    throw new Error("STAGING_TARGET_REQUIRED");
  const url = new URL(value);
  if (
    url.protocol !== "postgresql:" ||
    url.hostname !== "localhost" ||
    url.pathname !== `/${database}` ||
    url.searchParams.get("host") !== socket ||
    !allowedUsers.includes(url.username) ||
    !/^[A-Za-z0-9_-]{43,128}$/u.test(url.password)
  ) throw new Error("STAGING_DATABASE_REQUIRED");
  return url;
}
