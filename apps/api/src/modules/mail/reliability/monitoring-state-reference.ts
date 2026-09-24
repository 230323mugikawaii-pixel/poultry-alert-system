import type { DatabaseClient } from "../../../db/client.js";
import {
  MonitoringStateService,
  type MonitoringScope,
  type MonitoringStateMode
} from "./monitoring-state-service.js";
import type {
  MonitorDesired,
  MonitorObserved
} from "../../../generated/prisma/client.js";

export type MonitoringStateReference = (
  scope: MonitoringScope
) => Promise<void>;
export type MonitoringReferenceResult =
  | { kind: "MISSING" | "UNAVAILABLE" }
  | {
      kind: "STATE";
      desired: MonitorDesired;
      observed: MonitorObserved;
      generation: string;
    };

/** Advisory, read-only. Never initialize rows, change worker routing or claim health. */
export function monitoringStateReference(
  db: DatabaseClient,
  mode: MonitoringStateMode = "off",
  report: (result: MonitoringReferenceResult) => void = () => undefined
): MonitoringStateReference | undefined {
  if (mode === "off") return undefined;
  const service = new MonitoringStateService(db, "shadow");
  return async (scope) => {
    try {
      const result = await service.read(scope);
      if (result.kind === "STATE")
        report({
          kind: "STATE",
          desired: result.state.desired,
          observed: result.state.observed,
          generation: result.state.generation.toString()
        });
      else report({ kind: "MISSING" });
    } catch {
      report({ kind: "UNAVAILABLE" });
    }
  };
}
