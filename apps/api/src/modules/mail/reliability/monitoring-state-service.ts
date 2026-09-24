import type { DatabaseClient } from "../../../db/client.js";
import { retrySerializableTransaction } from "../../../db/transaction-retry.js";
import {
  Prisma,
  type MonitoringState,
  type MonitorDesired
} from "../../../generated/prisma/client.js";

export type MonitoringStateMode = "off" | "shadow";
export interface MonitoringScope {
  readonly connectionId: string;
  readonly teamId: string;
  readonly mailboxId: string;
}
type TransitionInput = MonitoringScope & {
  readonly expectedGeneration: bigint;
  // Internal trusted clock override for deterministic boundary tests; no HTTP API accepts this.
  readonly at?: Date;
};
export type MonitoringObservation =
  | {
      readonly kind: "AUTH_FAILURE";
      readonly reason: "INVALID_GRANT" | "HTTP_401";
    }
  | { readonly kind: "OAUTH_RECOVERED" | "UNKNOWN" | "HEALTHY" | "DEGRADED" }
  | { readonly kind: "RECOVERING"; readonly recoveryFrom: Date };
export type MonitoringTransition =
  | { readonly kind: "OFF" | "STALE" | "MISSING" }
  | { readonly kind: "APPLIED" | "UNCHANGED"; readonly state: MonitoringState };
export type MonitoringSnapshot =
  | { readonly kind: "OFF" | "MISSING" }
  | { readonly kind: "STATE"; readonly state: MonitoringState };
export type EpochEligibility =
  | { readonly kind: "OFF" | "UNKNOWN" | "OUTSIDE_EPOCH" }
  | {
      readonly kind: "IN_EPOCH";
      readonly epochId: string;
      readonly revision: number;
    };

/** DB-only, additive model. No routes, provider calls, legacy status or cursor writes. */
export class MonitoringStateService {
  public constructor(
    private readonly db: DatabaseClient,
    private readonly mode: MonitoringStateMode = "off"
  ) {}

  public async read(scope: MonitoringScope): Promise<MonitoringSnapshot> {
    if (this.mode === "off") return { kind: "OFF" };
    validateScope(scope);
    const state = await this.db.monitoringState.findFirst({
      where: { connectionId: scope.connectionId, connection: scopeWhere(scope) }
    });
    return state ? { kind: "STATE", state } : { kind: "MISSING" };
  }

  /** Only explicit user intent can initialize/change desired or open/close an epoch. */
  public async setDesired(
    input: TransitionInput & { readonly desired: MonitorDesired }
  ): Promise<MonitoringTransition> {
    if (this.mode === "off") return { kind: "OFF" };
    validateInput(input);
    if (!["RUNNING", "PAUSED", "DISCONNECTED"].includes(input.desired))
      throw new Error("MONITORING_DESIRED_INVALID");
    return this.transaction(async (tx) => {
      await lockScope(tx, input);
      const at = await transitionTime(tx, input.at);
      let state = await tx.monitoringState.findUnique({
        where: { connectionId: input.connectionId }
      });
      if (!state) {
        if (input.expectedGeneration !== 0n) return { kind: "STALE" };
        await tx.$executeRaw`INSERT INTO monitoring_states ("connectionId","updatedAt") VALUES (${input.connectionId}::uuid,${at}) ON CONFLICT ("connectionId") DO NOTHING`;
      }
      await tx.$queryRaw`SELECT "connectionId" FROM monitoring_states WHERE "connectionId"=${input.connectionId}::uuid FOR UPDATE`;
      state = await tx.monitoringState.findUniqueOrThrow({
        where: { connectionId: input.connectionId }
      });
      if (state.generation !== input.expectedGeneration)
        return { kind: "STALE" };
      assertClock(at, state.updatedAt);
      if (state.desired === input.desired) return { kind: "UNCHANGED", state };
      const last = await tx.monitoringEpoch.findFirst({
        where: { connectionId: input.connectionId },
        orderBy: { revision: "desc" }
      });
      if (
        (state.desired === "RUNNING") !==
        Boolean(last && last.endedAt === null)
      )
        throw new Error("MONITORING_EPOCH_INVARIANT");
      if (input.desired === "RUNNING") {
        if (last && (!last.endedAt || last.endedAt > at))
          throw new Error("MONITORING_EPOCH_OVERLAP");
        // Row lock + SERIALIZABLE + explicit overlap query also covers historical intervals.
        const overlap = await tx.monitoringEpoch.count({
          where: {
            connectionId: input.connectionId,
            OR: [{ endedAt: null }, { endedAt: { gt: at } }]
          }
        });
        if (overlap) throw new Error("MONITORING_EPOCH_OVERLAP");
        const connection = await tx.mailConnection.findUniqueOrThrow({
          where: { id: input.connectionId },
          select: { keywords: true, providerCursor: true }
        });
        await tx.monitoringEpoch.create({
          data: {
            connectionId: input.connectionId,
            revision: (last?.revision ?? 0) + 1,
            startedAt: at,
            keywordsSnapshot: connection.keywords,
            boundaryCursor: connection.providerCursor,
            matcherVersion: "existing-matcher-v1",
            createdAt: at
          }
        });
      } else if (last && last.endedAt === null) {
        assertClock(at, last.startedAt);
        await tx.monitoringEpoch.update({
          where: { id: last.id },
          data: {
            endedAt: at,
            closeReason:
              input.desired === "PAUSED" ? "USER_PAUSED" : "USER_DISCONNECTED"
          }
        });
      }
      state = await tx.monitoringState.update({
        where: { connectionId: input.connectionId },
        data: {
          desired: input.desired,
          generation: { increment: 1 },
          updatedAt: at
        }
      });
      return { kind: "APPLIED", state };
    });
  }

  /** Observations never initialize desired and never mutate any epoch. */
  public async observe(
    input: TransitionInput & { readonly observation: MonitoringObservation }
  ): Promise<MonitoringTransition> {
    if (this.mode === "off") return { kind: "OFF" };
    validateInput(input);
    const observation = input.observation;
    if (observation.kind === "RECOVERING")
      validateDate(observation.recoveryFrom);
    const mapped = mapObservation(observation);
    return this.transaction(async (tx) => {
      await lockScope(tx, input);
      await tx.$queryRaw`SELECT "connectionId" FROM monitoring_states WHERE "connectionId"=${input.connectionId}::uuid FOR UPDATE`;
      const current = await tx.monitoringState.findUnique({
        where: { connectionId: input.connectionId }
      });
      if (!current) return { kind: "MISSING" };
      if (current.generation !== input.expectedGeneration)
        return { kind: "STALE" };
      const at = await transitionTime(tx, input.at);
      assertClock(at, current.updatedAt);
      if (observation.kind === "RECOVERING" && observation.recoveryFrom > at)
        throw new Error("MONITORING_RECOVERY_TIME_INVALID");
      const recoveryFrom =
        observation.kind === "RECOVERING"
          ? !current.recoveryFrom ||
            observation.recoveryFrom < current.recoveryFrom
            ? observation.recoveryFrom
            : current.recoveryFrom
          : current.recoveryFrom;
      const state = await tx.monitoringState.update({
        where: { connectionId: input.connectionId },
        data: {
          ...mapped,
          recoveryFrom,
          checkedAt: at,
          updatedAt: at,
          generation: { increment: 1 }
        }
      });
      return { kind: "APPLIED", state };
    });
  }

  /** Temporal eligibility only, not a decision to deliver. Use provider receive time, not mail Date. */
  public async classifyReceivedAt(
    scope: MonitoringScope,
    receivedAt: Date
  ): Promise<EpochEligibility> {
    if (this.mode === "off") return { kind: "OFF" };
    validateScope(scope);
    validateDate(receivedAt);
    return this.transaction(async (tx) => {
      const where = {
        connectionId: scope.connectionId,
        connection: scopeWhere(scope)
      };
      const epoch = await tx.monitoringEpoch.findFirst({
        where: {
          ...where,
          startedAt: { lte: receivedAt },
          OR: [{ endedAt: null }, { endedAt: { gt: receivedAt } }]
        },
        orderBy: { revision: "desc" }
      });
      if (epoch)
        return {
          kind: "IN_EPOCH",
          epochId: epoch.id,
          revision: epoch.revision
        };
      const first = await tx.monitoringEpoch.findFirst({
        where,
        orderBy: { revision: "asc" },
        select: { startedAt: true }
      });
      // Missing history is UNKNOWN, never guessed from a legacy cursor or connection status.
      return {
        kind:
          !first || receivedAt < first.startedAt ? "UNKNOWN" : "OUTSIDE_EPOCH"
      };
    });
  }

  private transaction<T>(
    body: (tx: Prisma.TransactionClient) => Promise<T>
  ): Promise<T> {
    return retrySerializableTransaction(
      () =>
        this.db.$transaction(body, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable
        }),
      () => new Error("MONITORING_STATE_CONFLICT")
    );
  }
}

function scopeWhere(scope: MonitoringScope) {
  return {
    id: scope.connectionId,
    teamId: scope.teamId,
    mailAuthorizationId: scope.mailboxId
  };
}
function validateScope(scope: MonitoringScope) {
  if (
    ![scope.connectionId, scope.teamId, scope.mailboxId].every((id) =>
      /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)
    )
  )
    throw new Error("MONITORING_SCOPE_INVALID");
}
function validateDate(date: Date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime()))
    throw new Error("MONITORING_TIME_INVALID");
}
function validateInput(input: TransitionInput) {
  validateScope(input);
  if (
    typeof input.expectedGeneration !== "bigint" ||
    input.expectedGeneration < 0n
  )
    throw new Error("MONITORING_GENERATION_INVALID");
  if (input.at) validateDate(input.at);
}
function assertClock(at: Date, previous: Date) {
  if (at < previous) throw new Error("MONITORING_TIME_REGRESSION");
}
async function transitionTime(tx: Prisma.TransactionClient, at?: Date) {
  if (at) return at;
  const [row] = await tx.$queryRaw<
    Array<{ at: Date }>
  >`SELECT clock_timestamp()::timestamptz(3) AS at`;
  if (!row) throw new Error("MONITORING_CLOCK_UNAVAILABLE");
  return row.at;
}
async function lockScope(tx: Prisma.TransactionClient, scope: MonitoringScope) {
  // Lock order: trusted connection -> MonitoringState -> epochs. No existing row is changed.
  const rows = await tx.$queryRaw<
    Array<{ id: string }>
  >`SELECT id FROM mail_connections WHERE id=${scope.connectionId}::uuid AND "teamId"=${scope.teamId}::uuid AND "mailAuthorizationId"=${scope.mailboxId}::uuid FOR UPDATE`;
  if (rows.length !== 1) throw new Error("MONITORING_SCOPE_NOT_FOUND");
}
function mapObservation(
  event: MonitoringObservation
): Pick<MonitoringState, "observed" | "lastErrorCode"> {
  switch (event.kind) {
    case "AUTH_FAILURE":
      if (!["INVALID_GRANT", "HTTP_401"].includes(event.reason))
        throw new Error("MONITORING_OBSERVATION_INVALID");
      return {
        observed: "AUTH_REQUIRED",
        lastErrorCode:
          event.reason === "INVALID_GRANT"
            ? "OAUTH_INVALID_GRANT"
            : "OAUTH_HTTP_401"
      };
    case "OAUTH_RECOVERED": // A working credential is not evidence of healthy mail coverage.
    case "UNKNOWN":
      return { observed: "UNKNOWN", lastErrorCode: null };
    case "HEALTHY":
      return { observed: "HEALTHY", lastErrorCode: null };
    case "DEGRADED":
      return { observed: "DEGRADED", lastErrorCode: "MONITORING_DEGRADED" };
    case "RECOVERING":
      return {
        observed: "RECOVERING",
        lastErrorCode: "HISTORY_RECOVERY_REQUIRED"
      };
    default:
      throw new Error("MONITORING_OBSERVATION_INVALID");
  }
}
