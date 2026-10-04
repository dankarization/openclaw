import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readConfigMachineStateWithMetadata } from "../state/config-machine-state.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  createRetainedUpdateRecovery,
  storeRetainedUpdateRecovery,
} from "./update-retained-recovery.test-support.js";
import {
  archiveUpdateRecoveryAfterPreviousBoot,
  persistPreviousBootSettlementReceipt,
} from "./update-run-recovery-settlement.js";
import type { UpdatePreviousBootSettlementReceipt } from "./update-run-recovery-settlement.types.js";
import { archivePreviousBootRecoveryInWorker } from "./update-run-recovery-settlement.worker.js";
import { assertNoPendingUpdateRecovery } from "./update-run-recovery.js";

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ prefix: "previous-boot-archive-", applyEnv: true });
});
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  await state.cleanup();
});

function makeArchive(runId: string, operationId: string, raw: string) {
  const serviceUid = process.getuid?.() ?? 1000;
  const serviceGid = process.getgid?.() ?? 1000;
  const rawSha256 = createHash("sha256").update(raw).digest("hex");
  return {
    version: 1 as const,
    runId,
    operationId,
    rawRecord: raw,
    rawSha256,
    attestationSha256: "a".repeat(64),
    oldBootId: "11111111-1111-4111-8111-111111111111",
    currentBootId: "22222222-2222-4222-8222-222222222222",
    installRoot: "/opt/openclaw",
    anchorQuarantinePath: "/opt/.previous-boot-anchor",
    controlQuarantinePath: "/opt/.previous-boot-control",
    serviceUid,
    serviceGid,
    serviceUnit: "openclaw-gateway.service",
    readiness: {
      version: "2026.9.8",
      buildId: "test-build",
      bootId: "22222222-2222-4222-8222-222222222222",
      readyz: true as const,
      settled: true as const,
      pluginsReady: true as const,
      channelsReady: true as const,
    },
    archivedAtMs: Date.now(),
  };
}

async function pendingRecord() {
  const options = { env: state.env };
  const runId = randomUUID();
  const record = createRetainedUpdateRecovery(
    {
      runId,
      from: { root: "/old", nodePath: process.execPath, version: "1.0.0", buildId: "old" },
      to: { root: "/new", nodePath: process.execPath, version: "2.0.0", buildId: "new" },
    },
    options,
  );
  storeRetainedUpdateRecovery(record, options);
  const row = readConfigMachineStateWithMetadata<unknown>("update.recovery." + runId, options);
  if (!row) {
    throw new Error("Fixture recovery row was not stored");
  }
  return {
    options,
    runId,
    row,
    rawRecord: JSON.stringify(row.value),
    operationId: record.transactionId,
  };
}

describe("previous-boot recovery archive worker", () => {
  it("uses a CAS receipt as the admission barrier when no legacy recovery row exists", async () => {
    const options = { env: state.env };
    openOpenClawStateDatabase(options);
    expect(() => assertNoPendingUpdateRecovery(options)).not.toThrow();
    const operationId = randomUUID();
    const key = "update.previousBootSettlement." + operationId;
    const base: UpdatePreviousBootSettlementReceipt = {
      version: 1,
      operationId,
      attestationSha256: "a".repeat(64),
      phase: "intent-persisted",
      installRoot: "/fixture/openclaw",
      installIdentity: "1:2",
      installFingerprint: { digest: "b".repeat(64), identity: "1:2", version: "9.8.0" },
      previousFingerprint: { digest: "c".repeat(64), identity: "1:3", version: "9.7.0" },
      launchers: [],
      anchorIdentity: "1:4",
      controlIdentity: "1:5",
      quarantineRoot: "/fixture/.settlement",
      packageOperationSha256: "d".repeat(64),
      serviceUnit: "openclaw-gateway.service",
      updatedAtMs: Date.now(),
    };
    const first = await persistPreviousBootSettlementReceipt(base, {
      ...options,
      expectedUpdatedAtMs: null,
    });
    expect(() => assertNoPendingUpdateRecovery(options)).toThrow(
      /previous-boot update settlement/iu,
    );
    await expect(
      persistPreviousBootSettlementReceipt(
        { ...base, phase: "control-moved" },
        {
          ...options,
          expectedUpdatedAtMs: null,
        },
      ),
    ).rejects.toThrow(/CAS lost/u);
    expect(
      readConfigMachineStateWithMetadata<UpdatePreviousBootSettlementReceipt>(key, options)
        ?.updatedAtMs,
    ).toBe(first.updatedAtMs);
    await persistPreviousBootSettlementReceipt(
      { ...base, phase: "committed" },
      {
        ...options,
        expectedUpdatedAtMs: first.updatedAtMs,
      },
    );
    expect(() => assertNoPendingUpdateRecovery(options)).not.toThrow();
  });

  it("keeps admission blocked after archive CAS until terminal receipt survives a lost acknowledgement", async () => {
    const { options, runId, rawRecord, operationId } = await pendingRecord();
    const receiptKey = "update.previousBootSettlement." + operationId;
    const base: UpdatePreviousBootSettlementReceipt = {
      version: 1,
      operationId,
      attestationSha256: "e".repeat(64),
      phase: "inventory-verified",
      installRoot: "/fixture/openclaw",
      installIdentity: "1:2",
      installFingerprint: { digest: "b".repeat(64), identity: "1:2", version: "9.8.0" },
      previousFingerprint: { digest: "c".repeat(64), identity: "1:3", version: "9.7.0" },
      launchers: [],
      anchorIdentity: "1:4",
      controlIdentity: "1:5",
      quarantineRoot: "/fixture/.settlement",
      packageOperationSha256: "d".repeat(64),
      serviceUnit: "openclaw-gateway.service",
      updatedAtMs: Date.now(),
    };
    const pending = await persistPreviousBootSettlementReceipt(base, {
      ...options,
      expectedUpdatedAtMs: null,
    });
    const archive = makeArchive(runId, operationId, rawRecord);
    await archiveUpdateRecoveryAfterPreviousBoot(archive, options);
    expect(readConfigMachineStateWithMetadata("update.recovery." + runId, options)).toBeUndefined();
    expect(() => assertNoPendingUpdateRecovery(options)).toThrow(
      /previous-boot update settlement/iu,
    );
    await expect(
      (async () => {
        await persistPreviousBootSettlementReceipt(
          { ...base, phase: "committed" },
          {
            ...options,
            expectedUpdatedAtMs: pending.updatedAtMs,
          },
        );
        throw new Error("simulated terminal acknowledgement loss");
      })(),
    ).rejects.toThrow("simulated terminal acknowledgement loss");
    expect(
      readConfigMachineStateWithMetadata<UpdatePreviousBootSettlementReceipt>(receiptKey, options),
    ).toMatchObject({ value: { phase: "committed" } });
    expect(() => assertNoPendingUpdateRecovery(options)).not.toThrow();
  });

  it("moves exact pending bytes outside the active recovery range in one worker CAS", async () => {
    const { options, runId, rawRecord, operationId } = await pendingRecord();
    const archive = makeArchive(runId, operationId, rawRecord);
    const result = await archiveUpdateRecoveryAfterPreviousBoot(archive, options);
    expect(result).toMatchObject({
      outcome: "archived",
      archiveKey: "update.previousBootArchive." + runId,
    });
    expect(readConfigMachineStateWithMetadata("update.recovery." + runId, options)).toBeUndefined();
    expect(
      readConfigMachineStateWithMetadata("update.previousBootArchive." + runId, options),
    ).toMatchObject({
      value: archive,
    });
    expect(archive.rawRecord).toBe(rawRecord);
    expect(archive.rawSha256).toBe(createHash("sha256").update(rawRecord).digest("hex"));
    expect(() => assertNoPendingUpdateRecovery(options)).not.toThrow();
  });

  it("retains the active barrier when the captured row revision changes before CAS", async () => {
    const { options, runId, rawRecord, operationId } = await pendingRecord();
    const archive = makeArchive(runId, operationId, rawRecord);
    const db = (await import("../state/openclaw-state-db.js")).openOpenClawStateDatabase(
      options,
    ).db;
    db.prepare(
      "UPDATE config_machine_state SET updated_at_ms = updated_at_ms + 1 WHERE state_key = ?",
    ).run("update.recovery." + runId);
    expect(() =>
      archivePreviousBootRecoveryInWorker(
        {
          runId,
          expectedRawSha256: archive.rawSha256,
          expectedUpdatedAtMs: row.updatedAtMs,
          attestationSha256: archive.attestationSha256,
          archive,
        },
        {
          path: resolveOpenClawStateSqlitePath(options.env),
          env: options.env,
        },
      ),
    ).toThrow(/changed during previous-boot settlement/u);
    expect(readConfigMachineStateWithMetadata("update.recovery." + runId, options)).toBeDefined();
    expect(
      readConfigMachineStateWithMetadata("update.previousBootArchive." + runId, options),
    ).toBeUndefined();
    expect(() => assertNoPendingUpdateRecovery(options)).toThrow();
  });
});
