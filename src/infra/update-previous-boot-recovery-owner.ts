import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createGatewayRestartDeadline } from "../cli/daemon-cli/restart-health-deadline.js";
import { captureUpdateCommandExecutorAuthority } from "../cli/update-cli/update-command-executor.js";
import { readGatewayServiceState } from "../daemon/service-state.js";
import { resolveManagedGatewayServiceCommand } from "../daemon/service-types.js";
import { resolveGatewayService } from "../daemon/service.js";
import {
  readConfigMachineStateRowInDatabase,
  readConfigMachineStateWithMetadata,
} from "../state/config-machine-state.js";
import { withExistingOpenClawStateDatabaseArtifactPreservingReadOnly } from "../state/openclaw-state-db-readonly.js";
import { resolveOpenClawPackageRoot } from "./openclaw-root.js";
import { readPackageVersion } from "./package-json.js";
import { encodePackageActivationLauncher } from "./package-update-activation-journal.js";
import { createPackageIntegrityReader } from "./package-update-integrity.js";
import { readBuiltGatewayBuildId } from "./update-git-runtime.js";
import {
  validateUpdatePreviousBootAttestation,
  type UpdatePreviousBootAttestationPaths,
} from "./update-previous-boot-attestation.js";
import {
  assertInventory,
  publishPreviousBootArtifacts,
  removeLegacyAdmissionMarker,
  removeReservation,
  rollbackQuarantine,
  verifyOriginalPackageActivation,
} from "./update-previous-boot-recovery-artifacts.js";
import type {
  Intent,
  PreviousBootQuarantineResult,
  PreviousBootSettlementPhase,
} from "./update-previous-boot-recovery-artifacts.js";
import { observeInterruptedUpdateGateway } from "./update-run-interruption-health.js";
import { UPDATE_RECOVERY_KEY_PREFIX } from "./update-run-recovery-keys.js";
import { decodeUpdateRecovery, isUpdateRecoveryPending } from "./update-run-recovery-schema.js";
import {
  archiveUpdateRecoveryAfterPreviousBoot,
  persistPreviousBootSettlementReceipt,
} from "./update-run-recovery-settlement.js";
import type {
  UpdatePreviousBootSettlementReceipt,
  UpdateRecoverySettlementArchive,
} from "./update-run-recovery-settlement.types.js";
import type { UpdateRecoveryFence } from "./update-run-recovery-types.js";

export { publishPreviousBootArtifacts };
export type { Intent, PreviousBootQuarantineResult, PreviousBootSettlementPhase };

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

async function verifySavedPackageActivation(
  paths: UpdatePreviousBootAttestationPaths,
  saved: UpdatePreviousBootSettlementReceipt,
) {
  const reader = createPackageIntegrityReader(15 * 60_000);
  const anchor = fs.existsSync(paths.anchorPath)
    ? paths.anchorPath
    : path.join(saved.quarantineRoot, "anchor");
  const [installed, retainedPrevious] = await Promise.all([
    reader.tree(paths.installRoot),
    reader.tree(path.join(anchor, "previous"), paths.installRoot),
  ]);
  if (
    !isDeepStrictEqual(installed, saved.installFingerprint) ||
    !isDeepStrictEqual(retainedPrevious, saved.previousFingerprint)
  ) {
    throw new Error(
      "Installed or retained package fingerprint differs from the native settlement receipt.",
    );
  }
  for (const item of saved.launchers) {
    const requested = paths.launchers.find(
      (entry) => path.resolve(entry.path) === path.resolve(item.path),
    );
    if (!requested) {
      throw new Error("Native settlement receipt launcher set changed.");
    }
    const observed = encodePackageActivationLauncher(await reader.launcher(requested.path));
    if (observed !== item.candidate) {
      throw new Error("Installed launcher no longer matches the activation receipt.");
    }
    const previousPath = path.join(anchor, "previous-launchers", item.name);
    if (item.previous === null) {
      if (fs.existsSync(previousPath)) {
        throw new Error("Unexpected retained previous launcher exists.");
      }
    } else {
      const previous = encodePackageActivationLauncher(await reader.launcher(previousPath));
      if (previous !== item.previous) {
        throw new Error("Retained previous launcher differs from the activation receipt.");
      }
    }
  }
  return installed;
}

async function observeCurrentReadiness(
  expectedRoot: string,
  expectedServiceUnit: string,
  timeoutMs: number,
) {
  const service = await readGatewayServiceState(resolveGatewayService(), {
    env: process.env,
    timeoutMs: Math.min(timeoutMs, 15_000),
    requireEffective: true,
    requireLoadedCommand: true,
  });
  const command = resolveManagedGatewayServiceCommand(service.command);
  if (service.runtime?.systemd?.unit !== expectedServiceUnit) {
    throw new Error("Observed Gateway service unit does not match the attested service.");
  }
  if (!service.running || !command || command.programArguments.length < 2) {
    throw new Error("The loaded Gateway service command is unavailable or not running.");
  }
  const serviceEntry = command.programArguments[1]!;
  const packageRoot = await resolveOpenClawPackageRoot({ argv1: serviceEntry });
  if (!packageRoot || path.resolve(packageRoot) !== path.resolve(expectedRoot)) {
    throw new Error(
      "Loaded Gateway service package root does not match the attested install root.",
    );
  }
  const [version, buildId] = await Promise.all([
    readPackageVersion(packageRoot),
    readBuiltGatewayBuildId(packageRoot),
  ]);
  if (!version || !buildId) {
    throw new Error("Current OpenClaw package version/build identity is unavailable.");
  }
  const deadline = createGatewayRestartDeadline({ timeoutMs });
  try {
    const observed = await observeInterruptedUpdateGateway({ version, buildId }, { deadline });
    if (
      observed.outcome !== "settled" ||
      !observed.verification ||
      observed.verification.serviceRunning !== true ||
      observed.verification.versionMatch !== true ||
      observed.verification.readyz !== true ||
      observed.verification.settled !== true ||
      observed.verification.channelsReady !== true ||
      (observed.verification.pluginErrors?.length ?? 0) > 0
    ) {
      throw new Error("Current Gateway did not pass native package and readiness verification.");
    }
    return {
      version,
      buildId,
      readyz: true as const,
      settled: true as const,
      pluginsReady: true as const,
      channelsReady: true as const,
      bootId: fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim().toLowerCase(),
    };
  } finally {
    deadline.dispose();
  }
}

export async function settlePreviousBootUpdateRecovery(input: {
  runId: string;
  attestationPath: string;
  paths: UpdatePreviousBootAttestationPaths;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  executorFence: UpdateRecoveryFence;
}): Promise<{ outcome: "archived" | "settled" | "already-archived"; archiveKey: string }> {
  const env = input.env ?? process.env;
  const authority = captureUpdateCommandExecutorAuthority(input.executorFence, input.runId);
  const assertCurrent = () => {
    input.executorFence.assertCurrent();
    if (authority.installKey !== path.resolve(input.paths.installRoot)) {
      throw new Error("Current update executor is bound to another install root.");
    }
  };
  assertCurrent();
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined || uid === 0) {
    throw new Error("Settlement must run as the non-root Gateway service account.");
  }
  const key = UPDATE_RECOVERY_KEY_PREFIX + input.runId;
  const row = withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(
    ({ db }) => readConfigMachineStateRowInDatabase(db, key),
    { env },
  );
  let priorArchive: UpdateRecoverySettlementArchive | undefined;
  if (!row) {
    const archived = readConfigMachineStateWithMetadata<UpdateRecoverySettlementArchive>(
      "update.previousBootArchive." + input.runId,
      { env },
    );
    if (!archived) {
      // Operation-specific receipt handles filesystem-only publication recovery.
    } else {
      priorArchive = archived.value;
      const saved = archived.value;
      const savedRecord = decodeUpdateRecovery(saved.rawRecord, input.runId);
      if (
        saved.operationId !== savedRecord.transactionId ||
        saved.rawSha256 !== sha256(saved.rawRecord) ||
        saved.installRoot !== path.resolve(input.paths.installRoot)
      ) {
        throw new Error("Existing settlement archive does not match this update operation.");
      }
      const quarantineRoot = path.dirname(saved.anchorQuarantinePath);
      const verified = validateUpdatePreviousBootAttestation({
        filename: input.attestationPath,
        expectedOperationId: saved.operationId,
        expectedServiceUid: uid,
        expectedServiceGid: gid,
        expectedPaths: {
          ...input.paths,
          anchorEvidencePath: saved.anchorQuarantinePath,
          controlEvidencePath: saved.controlQuarantinePath,
          journalPath: path.join(
            saved.controlQuarantinePath,
            path.basename(input.paths.journalPath),
          ),
          helperPath: path.join(saved.controlQuarantinePath, path.basename(input.paths.helperPath)),
          quarantineRoot,
        },
      });
      if (verified.sha256 !== saved.attestationSha256) {
        throw new Error("Existing archive is bound to another root attestation.");
      }
      assertCurrent();
      const readiness = await observeCurrentReadiness(
        saved.installRoot,
        saved.serviceUnit,
        input.timeoutMs ?? 30_000,
      );
      assertCurrent();
      if (
        readiness.bootId !== saved.readiness.bootId ||
        readiness.version !== saved.readiness.version ||
        readiness.buildId !== saved.readiness.buildId
      ) {
        throw new Error("Current Gateway does not match the archived readiness receipt.");
      }
    }
  }
  const recovery = row ? decodeUpdateRecovery(row.value_json, input.runId) : undefined;
  if (recovery && !isUpdateRecoveryPending(recovery)) {
    throw new Error("Recovery row is not pending.");
  }
  const operationId = recovery?.transactionId ?? priorArchive?.operationId ?? input.runId;
  const rawSha256 = row ? sha256(row.value_json) : (priorArchive?.rawSha256 ?? sha256(operationId));
  const anchorParts = path.resolve(input.paths.anchorPath).split(path.sep);
  const nodeModulesIndex = anchorParts.lastIndexOf("node_modules");
  const quarantineParent =
    nodeModulesIndex > 0
      ? path.join(path.sep, ...anchorParts.slice(1, nodeModulesIndex))
      : path.dirname(input.paths.anchorPath);
  const quarantineRoot = path.join(
    quarantineParent,
    ".openclaw-previous-boot-settlement-" + operationId,
  );
  const receiptKey = "update.previousBootSettlement." + operationId;
  const existingReceipt = readConfigMachineStateWithMetadata<UpdatePreviousBootSettlementReceipt>(
    receiptKey,
    { env },
  );
  if (priorArchive && !existingReceipt) {
    throw new Error(
      "Existing recovery archive has no native settlement receipt to reconcile safely.",
    );
  }
  if (existingReceipt?.value.phase === "committed") {
    const saved = existingReceipt.value;
    const movedPaths = {
      ...input.paths,
      anchorEvidencePath: path.join(saved.quarantineRoot, "anchor"),
      controlEvidencePath: path.join(saved.quarantineRoot, "control"),
      journalPath: path.join(
        saved.quarantineRoot,
        "control",
        path.basename(input.paths.journalPath),
      ),
      helperPath: path.join(saved.quarantineRoot, "control", path.basename(input.paths.helperPath)),
      quarantineRoot: saved.quarantineRoot,
    };
    const verified = validateUpdatePreviousBootAttestation({
      filename: input.attestationPath,
      expectedOperationId: operationId,
      expectedServiceUid: uid,
      expectedServiceGid: gid,
      expectedPaths: movedPaths,
    });
    if (verified.sha256 !== saved.attestationSha256) {
      throw new Error("Committed receipt has a different attestation.");
    }
    assertInventory(path.join(saved.quarantineRoot, "anchor"), saved.inventory!.anchor, uid);
    assertInventory(path.join(saved.quarantineRoot, "control"), saved.inventory!.control, uid);
    const installed = await createPackageIntegrityReader(15 * 60_000).tree(saved.installRoot);
    if (!isDeepStrictEqual(installed, saved.installFingerprint)) {
      throw new Error("Installed package changed after settlement commit.");
    }
    const ready = await observeCurrentReadiness(
      saved.installRoot,
      saved.serviceUnit,
      input.timeoutMs ?? 30_000,
    );
    if (
      ready.bootId !==
      fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim().toLowerCase()
    ) {
      throw new Error("Gateway readiness boot changed during settlement receipt reconciliation.");
    }
    assertCurrent();
    const reservation = path.join(input.paths.controlPath, "previous-boot-reservation.json");
    if (fs.existsSync(reservation)) {
      assertCurrent();
      removeReservation(input.paths.controlPath, input.runId, operationId, verified.sha256, uid);
    }
    assertCurrent();
    removeLegacyAdmissionMarker(input.paths.anchorPath, operationId, verified.sha256, uid);
    return { outcome: "already-archived", archiveKey: receiptKey };
  }
  const anchorEvidencePath = fs.existsSync(input.paths.anchorPath)
    ? input.paths.anchorPath
    : path.join(quarantineRoot, "anchor");
  const reservationPath = path.join(input.paths.controlPath, "previous-boot-reservation.json");
  const controlEvidencePath = fs.existsSync(reservationPath)
    ? path.join(quarantineRoot, "control")
    : fs.existsSync(input.paths.controlPath)
      ? input.paths.controlPath
      : path.join(quarantineRoot, "control");
  const attestationPaths = {
    ...input.paths,
    anchorEvidencePath,
    controlEvidencePath,
    journalPath: path.join(controlEvidencePath, path.basename(input.paths.journalPath)),
    helperPath: path.join(controlEvidencePath, path.basename(input.paths.helperPath)),
    quarantineRoot,
  };
  const initialAttestation = validateUpdatePreviousBootAttestation({
    filename: input.attestationPath,
    expectedOperationId: operationId,
    expectedServiceUid: uid,
    expectedServiceGid: gid,
    expectedPaths: existingReceipt ? attestationPaths : input.paths,
  });
  const activation = existingReceipt
    ? {
        installed: await verifySavedPackageActivation(input.paths, existingReceipt.value),
        record: null,
      }
    : await verifyOriginalPackageActivation(input.paths, operationId);
  if (
    initialAttestation.attestation.serviceUid !== uid ||
    initialAttestation.attestation.serviceGid !== gid ||
    initialAttestation.attestation.installRoot !== path.resolve(input.paths.installRoot)
  ) {
    throw new Error("Attestation service or installation identity differs.");
  }
  assertCurrent();
  const readinessBefore = await observeCurrentReadiness(
    initialAttestation.attestation.installRoot,
    initialAttestation.attestation.serviceUnit,
    input.timeoutMs ?? 30_000,
  );
  assertCurrent();
  if (readinessBefore.bootId !== initialAttestation.attestation.currentBootId) {
    throw new Error("Gateway readiness was observed under a different OS boot.");
  }
  let receiptRow = existingReceipt;
  const anchorStat = fs.lstatSync(input.paths.anchorPath, { throwIfNoEntry: false });
  const controlStat = fs.lstatSync(input.paths.controlPath, { throwIfNoEntry: false });
  if (!receiptRow && (!anchorStat || !controlStat)) {
    throw new Error(
      "Quarantined activation paths have no native settlement receipt to resume safely.",
    );
  }
  const baseReceipt: UpdatePreviousBootSettlementReceipt = {
    version: 1,
    operationId,
    attestationSha256: initialAttestation.sha256,
    phase: receiptRow?.value.phase ?? "intent-persisted",
    installRoot: path.resolve(input.paths.installRoot),
    installIdentity: activation.installed.identity,
    installFingerprint: activation.installed,
    anchorIdentity:
      receiptRow?.value.anchorIdentity ??
      (anchorStat ? String(anchorStat.dev) + ":" + String(anchorStat.ino) : ""),
    controlIdentity:
      receiptRow?.value.controlIdentity ??
      (controlStat ? String(controlStat.dev) + ":" + String(controlStat.ino) : ""),
    quarantineRoot,
    packageOperationSha256:
      receiptRow?.value.packageOperationSha256 ??
      sha256(JSON.stringify(activation.record!.descriptor)),
    serviceUnit: receiptRow?.value.serviceUnit ?? initialAttestation.attestation.serviceUnit,
    previousFingerprint:
      receiptRow?.value.previousFingerprint ?? activation.record!.descriptor.previous,
    launchers:
      receiptRow?.value.launchers ??
      activation.record!.descriptor.launchers.map((entry) => ({
        name: entry.name,
        path: path.join(activation.record!.descriptor.binDir, entry.name),
        candidate: entry.candidate,
        previous: entry.previous,
      })),
    ...(receiptRow?.value.inventory ? { inventory: receiptRow.value.inventory } : {}),
    updatedAtMs: Date.now(),
  };
  if (
    receiptRow &&
    (receiptRow.value.operationId !== operationId ||
      receiptRow.value.attestationSha256 !== initialAttestation.sha256 ||
      receiptRow.value.installIdentity !== activation.installed.identity)
  ) {
    throw new Error("Existing native settlement receipt is bound to another operation or package.");
  }
  let receiptVersion = receiptRow?.updatedAtMs ?? null;
  let receipt = baseReceipt;
  const persistPhase = async (
    phase: PreviousBootSettlementPhase,
    inventory: Intent["inventory"],
  ) => {
    const ranks = [
      "intent-persisted",
      "control-moved",
      "control-reserved",
      "anchor-moved",
      "inventory-verified",
      "committed",
    ];
    if (ranks.indexOf(phase) < ranks.indexOf(receipt.phase)) {
      return;
    }
    const next: UpdatePreviousBootSettlementReceipt = {
      ...receipt,
      phase,
      inventory,
      updatedAtMs: Date.now(),
    };
    assertCurrent();
    const persisted = await persistPreviousBootSettlementReceipt(next, {
      env,
      expectedUpdatedAtMs: receiptVersion,
    });
    assertCurrent();
    receiptVersion = persisted.updatedAtMs;
    receipt = { ...next, updatedAtMs: persisted.updatedAtMs };
    receiptRow = { value: receipt, updatedAtMs: persisted.updatedAtMs };
  };

  let commitAttempted = false;
  const quarantined: PreviousBootQuarantineResult = await publishPreviousBootArtifacts({
    runId: input.runId,
    operationId,
    rawSha256,
    attestationSha256: initialAttestation.sha256,
    attestation: initialAttestation.attestation,
    paths: input.paths,
    quarantineRoot,
    priorInventory: receiptRow?.value.inventory,
    persistPhase,
    assertCurrent,
  });
  try {
    const movedPaths = {
      ...input.paths,
      anchorEvidencePath: quarantined.anchorQuarantinePath,
      controlEvidencePath: quarantined.controlQuarantinePath,
      journalPath: path.join(
        quarantined.controlQuarantinePath,
        path.basename(input.paths.journalPath),
      ),
      helperPath: path.join(
        quarantined.controlQuarantinePath,
        path.basename(input.paths.helperPath),
      ),
      quarantineRoot: quarantined.quarantineRoot,
    };
    const verified = validateUpdatePreviousBootAttestation({
      filename: input.attestationPath,
      expectedOperationId: operationId,
      expectedServiceUid: uid,
      expectedServiceGid: gid,
      expectedPaths: movedPaths,
    });
    if (verified.sha256 !== initialAttestation.sha256) {
      throw new Error("Root attestation changed during package quarantine.");
    }
    assertCurrent();
    const verifiedPackage = await verifySavedPackageActivation(input.paths, receipt);
    if (!isDeepStrictEqual(verifiedPackage, receipt.installFingerprint)) {
      throw new Error("Installed package fingerprint changed during settlement.");
    }
    const readinessAfter = await observeCurrentReadiness(
      initialAttestation.attestation.installRoot,
      initialAttestation.attestation.serviceUnit,
      input.timeoutMs ?? 30_000,
    );
    assertCurrent();
    if (
      readinessAfter.bootId !== readinessBefore.bootId ||
      readinessAfter.version !== readinessBefore.version ||
      readinessAfter.buildId !== readinessBefore.buildId
    ) {
      throw new Error("Gateway runtime identity changed during recovery settlement.");
    }
    const archive = {
      version: 1 as const,
      runId: input.runId,
      operationId,
      rawRecord: row?.value_json ?? "",
      rawSha256,
      attestationSha256: verified.sha256,
      oldBootId: verified.attestation.oldBootId,
      currentBootId: verified.attestation.currentBootId,
      installRoot: verified.attestation.installRoot,
      anchorQuarantinePath: quarantined.anchorQuarantinePath,
      controlQuarantinePath: quarantined.controlQuarantinePath,
      inventory: quarantined.inventory,
      serviceUid: uid,
      serviceGid: gid,
      serviceUnit: verified.attestation.serviceUnit,
      readiness: readinessAfter,
      archivedAtMs: Date.now(),
    };
    let archived: { outcome: "archived" | "already-archived"; archiveKey: string } | undefined;
    if (row) {
      assertCurrent();
      commitAttempted = true;
      archived = await archiveUpdateRecoveryAfterPreviousBoot(archive, { env });
      assertCurrent();
      const durableArchive = readConfigMachineStateWithMetadata<UpdateRecoverySettlementArchive>(
        "update.previousBootArchive." + input.runId,
        { env },
      );
      if (
        !durableArchive ||
        durableArchive.value.rawSha256 !== rawSha256 ||
        durableArchive.value.attestationSha256 !== verified.sha256 ||
        durableArchive.value.operationId !== operationId
      ) {
        throw new Error(
          "Native state worker did not durably publish the exact settlement archive.",
        );
      }
    }
    assertCurrent();
    commitAttempted = true;
    await persistPhase("committed", quarantined.inventory);
    assertCurrent();
    const committedReceipt =
      readConfigMachineStateWithMetadata<UpdatePreviousBootSettlementReceipt>(receiptKey, {
        env,
      });
    if (
      committedReceipt?.value.phase !== "committed" ||
      committedReceipt.value.attestationSha256 !== verified.sha256
    ) {
      throw new Error("Terminal native settlement receipt was not durably published.");
    }
    assertCurrent();
    removeReservation(input.paths.controlPath, input.runId, operationId, verified.sha256, uid);
    assertCurrent();
    removeLegacyAdmissionMarker(input.paths.anchorPath, operationId, verified.sha256, uid);
    return archived ?? { outcome: "settled" as const, archiveKey: receiptKey };
  } catch (error) {
    const committed = readConfigMachineStateWithMetadata<UpdateRecoverySettlementArchive>(
      "update.previousBootArchive." + input.runId,
      { env },
    );
    const committedReceipt =
      readConfigMachineStateWithMetadata<UpdatePreviousBootSettlementReceipt>(receiptKey, {
        env,
      });
    if (
      commitAttempted ||
      committedReceipt?.value.phase === "committed" ||
      (committed?.value.rawSha256 === rawSha256 &&
        committed.value.attestationSha256 === initialAttestation.sha256 &&
        committed.value.operationId === operationId)
    ) {
      // The terminal archive owns the result. Keep quarantine and reservation
      // intact so a later invocation can verify and clean up idempotently.
      throw error;
    }
    assertCurrent();
    rollbackQuarantine(
      input.paths,
      quarantined,
      initialAttestation.attestation,
      input.runId,
      operationId,
      initialAttestation.sha256,
      uid,
      assertCurrent,
    );
    assertCurrent();
    removeLegacyAdmissionMarker(
      input.paths.anchorPath,
      operationId,
      initialAttestation.sha256,
      uid,
    );
    throw error;
  }
}
