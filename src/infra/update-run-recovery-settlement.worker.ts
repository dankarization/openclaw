import { createHash } from "node:crypto";
import { runExistingOpenClawStateWriteTransaction } from "../state/openclaw-state-db-existing-write.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
import type { OpenClawStateWorkerOperations } from "../state/openclaw-state-worker-contract.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { UPDATE_RECOVERY_KEY_PREFIX } from "./update-run-recovery-keys.js";
import { decodeUpdateRecovery, isUpdateRecoveryPending } from "./update-run-recovery-schema.js";
import type {
  UpdatePreviousBootSettlementReceipt,
  UpdateRecoverySettlementArchive,
} from "./update-run-recovery-settlement.types.js";

type State = Pick<DB, "config_machine_state">;
const schemaStart = OPENCLAW_STATE_SCHEMA_SQL.indexOf(
  "CREATE TABLE IF NOT EXISTS config_machine_state (",
);
const schemaEnd = OPENCLAW_STATE_SCHEMA_SQL.indexOf(") STRICT;", schemaStart);
if (schemaStart < 0 || schemaEnd < 0) {
  throw new Error("config_machine_state schema marker is missing");
}
const stateSchema = OPENCLAW_STATE_SCHEMA_SQL.slice(schemaStart, schemaEnd + ") STRICT;".length);
const activeKey = (runId: string) => UPDATE_RECOVERY_KEY_PREFIX + runId;
const archiveKey = (runId: string) => "update.previousBootArchive." + runId;
const digest = (raw: string) => createHash("sha256").update(raw).digest("hex");

export function archivePreviousBootRecoveryInWorker(
  input: OpenClawStateWorkerOperations["updateRecovery.archivePreviousBoot"]["input"],
  options: { path: string; env: NodeJS.ProcessEnv },
): OpenClawStateWorkerOperations["updateRecovery.archivePreviousBoot"]["output"] {
  if (
    input.archive.runId !== input.runId ||
    !/^[0-9a-f-]{36}$/iu.test(input.archive.operationId) ||
    input.archive.rawSha256 !== input.expectedRawSha256 ||
    input.archive.attestationSha256 !== input.attestationSha256 ||
    digest(input.archive.rawRecord) !== input.expectedRawSha256 ||
    !/^[a-f0-9]{64}$/u.test(input.attestationSha256) ||
    !/^[0-9a-f-]{36}$/iu.test(input.archive.oldBootId) ||
    !/^[0-9a-f-]{36}$/iu.test(input.archive.currentBootId) ||
    input.archive.oldBootId === input.archive.currentBootId
  ) {
    throw new Error("Previous-boot recovery archive binding is invalid.");
  }
  const key = activeKey(input.runId);
  const savedKey = archiveKey(input.runId);
  return runExistingOpenClawStateWriteTransaction(
    ({ db }) => {
      const store = getNodeSqliteKysely<State>(db);
      const current = executeSqliteQueryTakeFirstSync(
        db,
        store
          .selectFrom("config_machine_state")
          .select(["value_json", "updated_at_ms"])
          .where("state_key", "=", key),
      );
      const archived = executeSqliteQueryTakeFirstSync(
        db,
        store
          .selectFrom("config_machine_state")
          .select("value_json")
          .where("state_key", "=", savedKey),
      );
      if (!current) {
        if (archived) {
          const prior = JSON.parse(archived.value_json) as Partial<UpdateRecoverySettlementArchive>;
          if (
            prior.runId === input.runId &&
            prior.rawSha256 === input.expectedRawSha256 &&
            prior.attestationSha256 === input.attestationSha256
          ) {
            return { outcome: "already-archived" as const, archiveKey: savedKey };
          }
        }
        throw new Error("Pending update recovery row disappeared before settlement commit.");
      }
      if (
        current.value_json !== input.archive.rawRecord ||
        current.updated_at_ms !== input.expectedUpdatedAtMs ||
        digest(current.value_json) !== input.expectedRawSha256
      ) {
        throw new Error("Pending update recovery changed during previous-boot settlement.");
      }
      const record = decodeUpdateRecovery(current.value_json, input.runId);
      if (!isUpdateRecoveryPending(record)) {
        throw new Error("Only a pending retained recovery can be archived by this owner.");
      }
      if (archived) {
        throw new Error("A conflicting previous-boot archive already exists.");
      }
      executeSqliteQuerySync(
        db,
        store.insertInto("config_machine_state").values({
          state_key: savedKey,
          value_json: JSON.stringify(input.archive),
          updated_at_ms: input.archive.archivedAtMs,
        }),
      );
      const deleted = executeSqliteQuerySync(
        db,
        store
          .deleteFrom("config_machine_state")
          .where("state_key", "=", key)
          .where("value_json", "=", current.value_json)
          .where("updated_at_ms", "=", current.updated_at_ms),
      );
      if (deleted.numAffectedRows !== 1n) {
        throw new Error("Pending update recovery CAS delete lost its row.");
      }
      return { outcome: "archived" as const, archiveKey: savedKey };
    },
    { path: options.path, env: options.env },
    { schemaSql: stateSchema, operationLabel: "update.recovery.previous-boot-archive" },
  );
}

export function validatePreviousBootArchive(value: unknown): UpdateRecoverySettlementArchive {
  if (!value || typeof value !== "object") {
    throw new Error("Archive must be an object.");
  }
  const record = value as Partial<UpdateRecoverySettlementArchive>;
  if (
    record.version !== 1 ||
    typeof record.runId !== "string" ||
    typeof record.rawRecord !== "string" ||
    typeof record.rawSha256 !== "string" ||
    typeof record.attestationSha256 !== "string" ||
    !record.readiness ||
    record.readiness.readyz !== true ||
    record.readiness.settled !== true ||
    record.readiness.pluginsReady !== true ||
    record.readiness.channelsReady !== true
  ) {
    throw new Error("Previous-boot archive receipt is incomplete.");
  }
  return record as UpdateRecoverySettlementArchive;
}

const settlementKey = (operationId: string) => "update.previousBootSettlement." + operationId;
const settlementPhases = [
  "intent-persisted",
  "control-moved",
  "control-reserved",
  "anchor-moved",
  "inventory-verified",
  "committed",
] as const;

export function recordPreviousBootSettlementReceiptInWorker(
  input: OpenClawStateWorkerOperations["updateRecovery.previousBootReceipt"]["input"],
  options: { path: string; env: NodeJS.ProcessEnv },
): OpenClawStateWorkerOperations["updateRecovery.previousBootReceipt"]["output"] {
  if (
    input.receipt.version !== 1 ||
    input.receipt.operationId !== input.operationId ||
    !/^[0-9a-f-]{36}$/iu.test(input.operationId) ||
    !/^[a-f0-9]{64}$/u.test(input.receipt.attestationSha256) ||
    !/^[a-f0-9]{64}$/u.test(input.receipt.packageOperationSha256) ||
    !input.receipt.installRoot.startsWith("/") ||
    !input.receipt.quarantineRoot.startsWith("/") ||
    !settlementPhases.includes(input.receipt.phase)
  ) {
    throw new Error("Previous-boot settlement receipt binding is invalid.");
  }
  const key = settlementKey(input.operationId);
  return runExistingOpenClawStateWriteTransaction(
    ({ db }) => {
      const store = getNodeSqliteKysely<State>(db);
      const current = executeSqliteQueryTakeFirstSync(
        db,
        store
          .selectFrom("config_machine_state")
          .select(["value_json", "updated_at_ms"])
          .where("state_key", "=", key),
      );
      if ((current?.updated_at_ms ?? null) !== input.expectedUpdatedAtMs) {
        throw new Error("Previous-boot settlement receipt CAS lost its current row.");
      }
      if (current) {
        const previous = JSON.parse(current.value_json) as UpdatePreviousBootSettlementReceipt;
        if (previous.operationId !== input.operationId || previous.version !== 1) {
          throw new Error("Existing settlement receipt belongs to another operation.");
        }
        const oldPhase = settlementPhases.indexOf(previous.phase);
        const nextPhase = settlementPhases.indexOf(input.receipt.phase);
        if (oldPhase < 0 || nextPhase < oldPhase) {
          throw new Error("Settlement receipt phase cannot move backwards.");
        }
      }
      const updatedAtMs = Math.max(Date.now(), (current?.updated_at_ms ?? 0) + 1);
      const valueJson = JSON.stringify({ ...input.receipt, updatedAtMs });
      executeSqliteQuerySync(
        db,
        store
          .insertInto("config_machine_state")
          .values({
            state_key: key,
            value_json: valueJson,
            updated_at_ms: updatedAtMs,
          })
          .onConflict((conflict) =>
            conflict
              .column("state_key")
              .doUpdateSet({ value_json: valueJson, updated_at_ms: updatedAtMs }),
          ),
      );
      return { updatedAtMs };
    },
    { path: options.path, env: options.env },
    { schemaSql: stateSchema, operationLabel: "update.recovery.previous-boot-receipt" },
  );
}
