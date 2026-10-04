import { createHash } from "node:crypto";
import {
  readConfigMachineStateRowInDatabase,
  readConfigMachineStateWithMetadata,
} from "../state/config-machine-state.js";
import { withExistingOpenClawStateDatabaseArtifactPreservingReadOnly } from "../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import { createSqliteWorkerWriteAdmission } from "./sqlite-worker-store.js";
import { UPDATE_RECOVERY_KEY_PREFIX } from "./update-run-recovery-keys.js";
import { decodeUpdateRecovery, isUpdateRecoveryPending } from "./update-run-recovery-schema.js";
import type {
  UpdatePreviousBootSettlementReceipt,
  UpdateRecoverySettlementArchive,
} from "./update-run-recovery-settlement.types.js";

export async function archiveUpdateRecoveryAfterPreviousBoot(
  archive: UpdateRecoverySettlementArchive,
  options: { env?: NodeJS.ProcessEnv } = {},
) {
  const env = options.env ?? process.env;
  const stateKey = UPDATE_RECOVERY_KEY_PREFIX + archive.runId;
  const current = withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(
    ({ db }) => readConfigMachineStateRowInDatabase(db, stateKey),
    { env },
  );
  if (!current) {
    const prior = readConfigMachineStateWithMetadata<UpdateRecoverySettlementArchive>(
      "update.previousBootArchive." + archive.runId,
      { env },
    );
    if (
      prior?.value.runId === archive.runId &&
      prior.value.rawSha256 === archive.rawSha256 &&
      prior.value.attestationSha256 === archive.attestationSha256
    ) {
      return {
        outcome: "already-archived" as const,
        archiveKey: "update.previousBootArchive." + archive.runId,
      };
    }
    throw new Error("Pending update recovery record is missing.");
  }
  const record = decodeUpdateRecovery(current.value_json, archive.runId);
  if (!isUpdateRecoveryPending(record)) {
    throw new Error("Only a pending retained update recovery can be archived.");
  }
  if (archive.operationId !== record.transactionId) {
    throw new Error("Archive operation ID does not match the retained recovery transaction.");
  }
  const rawSha256 = createHash("sha256").update(current.value_json).digest("hex");
  if (archive.rawRecord !== current.value_json || archive.rawSha256 !== rawSha256) {
    throw new Error("Archive bytes do not match the current retained recovery record.");
  }
  const context = captureOpenClawStateWorkerContext({ env });
  const assertCurrent = () => context.admission.assertCurrent();
  const result = await runOpenClawStateWorkerOperation(
    context,
    (scope) =>
      scope.execute({
        type: "updateRecovery.archivePreviousBoot",
        input: {
          runId: archive.runId,
          expectedRawSha256: rawSha256,
          expectedUpdatedAtMs: current.updated_at_ms,
          attestationSha256: archive.attestationSha256,
          archive,
        },
      }),
    {
      existingOnly: true,
      assertCurrent,
      createAdmission: createSqliteWorkerWriteAdmission(assertCurrent, [
        context.admission.databasePath,
      ]),
    },
  );
  if (!result) {
    throw new Error("Shared-state worker is unavailable; recovery remains pending.");
  }
  return result;
}

export async function persistPreviousBootSettlementReceipt(
  receipt: UpdatePreviousBootSettlementReceipt,
  options: { env?: NodeJS.ProcessEnv; expectedUpdatedAtMs: number | null },
) {
  const env = options.env ?? process.env;
  const context = captureOpenClawStateWorkerContext({ env });
  const assertCurrent = () => context.admission.assertCurrent();
  const result = await runOpenClawStateWorkerOperation(
    context,
    (scope) =>
      scope.execute({
        type: "updateRecovery.previousBootReceipt",
        input: {
          operationId: receipt.operationId,
          expectedUpdatedAtMs: options.expectedUpdatedAtMs,
          receipt,
        },
      }),
    {
      existingOnly: true,
      assertCurrent,
      createAdmission: createSqliteWorkerWriteAdmission(assertCurrent, [
        context.admission.databasePath,
      ]),
    },
  );
  if (!result) {
    throw new Error("Shared-state worker is unavailable; settlement receipt was not committed.");
  }
  return result;
}
