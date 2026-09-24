-- Only in the disposable PR04 round-trip DB; no CASCADE or migration-history edits.
DROP TABLE monitoring_epochs;
DROP TABLE monitoring_states;
DROP TYPE "IngestionOwner";
DROP TYPE "MonitorObserved";
DROP TYPE "MonitorDesired";
