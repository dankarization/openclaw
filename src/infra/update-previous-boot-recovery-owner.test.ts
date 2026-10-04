import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settlePreviousBootRecoveryCommand } from "../cli/update-cli/previous-boot-settlement.js";
import { withUpdateCommandExecutor } from "../cli/update-cli/update-command-executor.js";
import * as serviceStateModule from "../daemon/service-state.js";
import * as serviceTypesModule from "../daemon/service-types.js";
import { defaultRuntime } from "../runtime.js";
import { readConfigMachineStateWithMetadata } from "../state/config-machine-state.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import * as packageJsonModule from "./package-json.js";
import {
  assertPackageActivationLayout,
  openPackageActivationJournal,
  resolvePackageActivationAnchor,
  resolvePackageActivationControl,
  resolvePackageActivationHelper,
  resolvePackageActivationJournalPath,
} from "./package-update-activation-journal.js";
import { createPackageActivationLifetimeFixture } from "./package-update-activation-lifetime.test-support.js";
import { swapStagedPackageInstall } from "./package-update-swap.js";
import { createPackageSwapFixture } from "./package-update-swap.test-support.js";
import * as updateGitRuntimeModule from "./update-git-runtime.js";
import * as attestationModule from "./update-previous-boot-attestation.js";
import {
  UpdatePreviousBootAttestationSchema,
  type UpdatePreviousBootAttestation,
  type UpdatePreviousBootAttestationPaths,
} from "./update-previous-boot-attestation.js";
import {
  publishPreviousBootArtifacts,
  settlePreviousBootUpdateRecovery,
  type PreviousBootQuarantineResult,
  type PreviousBootSettlementPhase,
} from "./update-previous-boot-recovery-owner.js";
import {
  createRetainedUpdateRecovery,
  storeRetainedUpdateRecovery,
} from "./update-retained-recovery.test-support.js";
import * as interruptionHealthModule from "./update-run-interruption-health.js";
import * as settlementModule from "./update-run-recovery-settlement.js";
import type { UpdatePreviousBootSettlementReceipt } from "./update-run-recovery-settlement.types.js";
import { assertNoPendingUpdateRecovery } from "./update-run-recovery.js";

let state: OpenClawTestState;
let tempRoot: string;
beforeEach(async () => {
  state = await createOpenClawTestState({ prefix: "previous-boot-owner-", applyEnv: true });
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "previous-boot-owner-files-"));
});
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  await state.cleanup();
  fs.rmSync(tempRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function recoveryFixture(runId: string, operationId: string) {
  const parent = path.join(tempRoot, operationId);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  fs.chmodSync(parent, 0o700);
  const anchorPath = path.join(parent, ".anchor");
  const controlPath = anchorPath + ".control";
  for (const directory of [anchorPath, controlPath]) {
    fs.mkdirSync(directory, { mode: 0o700 });
    fs.chmodSync(directory, 0o700);
  }
  fs.writeFileSync(path.join(anchorPath, "activation.sqlite"), "synthetic anchor bytes", {
    mode: 0o600,
  });
  fs.writeFileSync(path.join(controlPath, "operation.sqlite"), "synthetic journal bytes", {
    mode: 0o600,
  });
  fs.writeFileSync(path.join(controlPath, "recovery.mjs"), "synthetic helper bytes", {
    mode: 0o600,
  });
  const serviceUid = process.getuid?.() ?? 1000;
  const serviceGid = process.getgid?.() ?? 1000;
  const paths: UpdatePreviousBootAttestationPaths = {
    installRoot: path.join(parent, "current"),
    anchorPath,
    controlPath,
    journalPath: path.join(controlPath, "operation.sqlite"),
    helperPath: path.join(controlPath, "recovery.mjs"),
    archivePath: path.join(parent, "archive.tar"),
    serviceUnit: "openclaw-gateway.service",
    launchers: [{ path: path.join(parent, "launcher"), argv0: path.join(parent, "launcher") }],
  };
  fs.mkdirSync(paths.installRoot, { mode: 0o700 });
  fs.writeFileSync(paths.archivePath, "preserved archive", { mode: 0o600 });
  fs.writeFileSync(paths.launchers[0]!.path, "launcher", { mode: 0o700 });
  const identity = (filename: string) => {
    const stat = fs.lstatSync(filename);
    return {
      path: filename,
      dev: stat.dev,
      ino: stat.ino,
      uid: stat.uid,
      gid: stat.gid,
      mode: stat.mode & 0o777,
    };
  };
  const artifact = (filename: string) => {
    const stat = fs.lstatSync(filename);
    return {
      path: filename,
      sha256: "a".repeat(64),
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
    };
  };
  const attestation = UpdatePreviousBootAttestationSchema.parse({
    version: 1,
    operationId,
    oldBootId: "11111111-1111-4111-8111-111111111111",
    currentBootId: "22222222-2222-4222-8222-222222222222",
    issuerUid: 0,
    serviceUid,
    serviceGid,
    installRoot: paths.installRoot,
    anchorPath,
    controlPath,
    anchorIdentity: identity(anchorPath),
    controlIdentity: identity(controlPath),
    journal: artifact(paths.journalPath),
    helper: artifact(paths.helperPath),
    archive: artifact(paths.archivePath),
    serviceUnit: paths.serviceUnit,
    launchers: [{ ...artifact(paths.launchers[0]!.path), argv0: paths.launchers[0]!.argv0 }],
    issuedAtMs: Date.now(),
    nonce: randomUUID(),
  });
  return { parent, paths, attestation, serviceUid, serviceGid };
}

describe("previous-boot artifact quarantine", () => {
  it("rejects the wrong service unit before effects and applies through the local native worker after lease-loss recovery", async () => {
    const activation = createPackageActivationLifetimeFixture();
    const { root: fixtureRoot } = activation.setup();
    const leasePath = path.join(fixtureRoot, "private-tmp", "managed-update-handoffs.sqlite");
    const readService = vi.spyOn(serviceStateModule, "readGatewayServiceState");
    const resolveCommand = vi.spyOn(serviceTypesModule, "resolveManagedGatewayServiceCommand");
    const observeGateway = vi.spyOn(interruptionHealthModule, "observeInterruptedUpdateGateway");
    const validateAttestation = vi.spyOn(
      attestationModule,
      "validateUpdatePreviousBootAttestation",
    );
    const readPackageVersion = vi
      .spyOn(packageJsonModule, "readPackageVersion")
      .mockResolvedValue("2026.9.8");
    const readBuildId = vi
      .spyOn(updateGitRuntimeModule, "readBuiltGatewayBuildId")
      .mockResolvedValue("fixture-build");
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    try {
      const fixture = await createPackageSwapFixture(fixtureRoot);
      await activation.writePostCoreCapability(fixture.params.stage.packageRoot);
      const swap = await withUpdateCommandExecutor(randomUUID(), async (executor) => {
        const fence = await executor.enter(fixture.packageRoot);
        return swapStagedPackageInstall({
          ...fixture.params,
          activation: { fence, nodeRunner: process.execPath, onPrepared: () => {} },
          onTransaction: () => {},
        });
      });
      expect(swap.status).toBe("committed");
      const anchor = resolvePackageActivationAnchor(fixture.packageRoot);
      const record = openPackageActivationJournal(anchor).read();
      expect(record.phase).toBe("publication-complete");
      const control = resolvePackageActivationControl(anchor);
      const journal = resolvePackageActivationJournalPath(anchor);
      const helper = resolvePackageActivationHelper(anchor);
      const archive = path.join(fixtureRoot, "previous-update.tar");
      fs.writeFileSync(archive, "original package archive", { mode: 0o600 });
      const serviceUid = process.getuid?.() ?? 1000;
      const serviceGid = process.getgid?.() ?? 1000;
      const identity = (filename: string) => {
        const stat = fs.lstatSync(filename);
        return {
          path: filename,
          dev: stat.dev,
          ino: stat.ino,
          uid: stat.uid,
          gid: stat.gid,
          mode: stat.mode & 0o777,
        };
      };
      const artifact = (filename: string) => {
        const stat = fs.lstatSync(filename);
        return {
          path: filename,
          sha256: "a".repeat(64),
          dev: stat.dev,
          ino: stat.ino,
          size: stat.size,
        };
      };
      const bootId = fs
        .readFileSync("/proc/sys/kernel/random/boot_id", "utf8")
        .trim()
        .toLowerCase();
      const oldBootId =
        bootId === "11111111-1111-4111-8111-111111111111"
          ? "22222222-2222-4222-8222-222222222222"
          : "11111111-1111-4111-8111-111111111111";
      const paths: UpdatePreviousBootAttestationPaths = {
        installRoot: fixture.packageRoot,
        anchorPath: anchor,
        controlPath: control,
        journalPath: journal,
        helperPath: helper,
        archivePath: archive,
        serviceUnit: "openclaw-gateway.service",
        launchers: [{ path: fixture.launcher, argv0: fixture.launcher }],
      };
      const attestation = UpdatePreviousBootAttestationSchema.parse({
        version: 1,
        operationId: record.descriptor.operationId,
        oldBootId,
        currentBootId: bootId,
        issuerUid: 0,
        serviceUid,
        serviceGid,
        installRoot: fixture.packageRoot,
        anchorPath: anchor,
        controlPath: control,
        anchorIdentity: identity(anchor),
        controlIdentity: identity(control),
        journal: artifact(journal),
        helper: artifact(helper),
        archive: artifact(archive),
        serviceUnit: paths.serviceUnit,
        launchers: [{ ...artifact(fixture.launcher), argv0: fixture.launcher }],
        issuedAtMs: Date.now(),
        nonce: randomUUID(),
      }) as UpdatePreviousBootAttestation;
      validateAttestation.mockImplementation(() => ({
        attestation,
        sha256: "b".repeat(64),
      }));
      let currentUnit = "wrong-openclaw-gateway.service";
      readService.mockImplementation(
        async () =>
          ({
            installed: true,
            loadState: "loaded",
            running: true,
            env: {},
            command: {
              programArguments: [
                process.execPath,
                path.join(fixture.packageRoot, "dist", "index.js"),
              ],
            },
            runtime: { systemd: { unit: currentUnit } },
          }) as never,
      );
      resolveCommand.mockReturnValue({
        programArguments: [process.execPath, path.join(fixture.packageRoot, "dist", "index.js")],
      } as never);
      observeGateway.mockResolvedValue({
        outcome: "settled",
        elapsedMs: 1,
        phase: "settled",
        verification: {
          serviceRunning: true,
          versionMatch: true,
          readyz: true,
          settled: true,
          channelsReady: true,
          pluginsReady: true,
          pluginErrors: [],
        },
      } as never);

      openOpenClawStateDatabase({ env: state.env });
      expect(() => assertNoPendingUpdateRecovery({ env: state.env })).not.toThrow();
      expect(fs.existsSync(leasePath)).toBe(true);
      fs.rmSync(leasePath, { force: true });
      fs.rmSync(leasePath + "-wal", { force: true });
      fs.rmSync(leasePath + "-shm", { force: true });
      await expect(
        settlePreviousBootRecoveryCommand({
          operationId: record.descriptor.operationId,
          installRoot: fixture.packageRoot,
          anchor,
          control,
          journal,
          helper,
          archive,
          serviceUnit: paths.serviceUnit,
          launcher: [fixture.launcher + "|" + fixture.launcher],
          attestation: path.join(fixtureRoot, "root-attestation.json"),
          apply: true,
        }),
      ).rejects.toThrow(/service unit does not match/u);
      expect(fs.existsSync(anchor)).toBe(true);
      expect(fs.existsSync(control)).toBe(true);
      expect(fs.existsSync(anchor + ".recovery.mjs")).toBe(false);
      expect(
        readConfigMachineStateWithMetadata(
          "update.previousBootSettlement." + record.descriptor.operationId,
          { env: state.env },
        ),
      ).toBeUndefined();
      expect(() => assertNoPendingUpdateRecovery({ env: state.env })).not.toThrow();

      currentUnit = paths.serviceUnit;
      let committedPersisted = false;
      const persistReceiptOriginal = settlementModule.persistPreviousBootSettlementReceipt;
      const persistReceipt = vi.spyOn(settlementModule, "persistPreviousBootSettlementReceipt");
      persistReceipt.mockImplementation(async (receipt, options) => {
        const result = await persistReceiptOriginal(receipt, options);
        if (receipt.phase === "committed") {
          committedPersisted = true;
        }
        return result;
      });
      await expect(
        withUpdateCommandExecutor(record.descriptor.operationId, async (executor) => {
          const fence = await executor.enter(fixture.packageRoot, { preflight: true });
          const originalAssertCurrent = fence.assertCurrent.bind(fence);
          Object.defineProperty(fence, "assertCurrent", {
            configurable: true,
            value: () => {
              if (committedPersisted) {
                throw new Error("injected expired executor fence");
              }
              originalAssertCurrent();
            },
          });
          return settlePreviousBootUpdateRecovery({
            runId: record.descriptor.operationId,
            attestationPath: path.join(fixtureRoot, "root-attestation.json"),
            paths,
            executorFence: fence,
          });
        }),
      ).rejects.toThrow(/injected expired executor fence/u);
      persistReceipt.mockRestore();
      expect(fs.existsSync(anchor)).toBe(false);
      expect(fs.existsSync(control)).toBe(true);
      expect(fs.existsSync(path.join(control, "previous-boot-reservation.json"))).toBe(true);
      await settlePreviousBootRecoveryCommand({
        operationId: record.descriptor.operationId,
        installRoot: fixture.packageRoot,
        anchor,
        control,
        journal,
        helper,
        archive,
        serviceUnit: paths.serviceUnit,
        launcher: [fixture.launcher + "|" + fixture.launcher],
        attestation: path.join(fixtureRoot, "root-attestation.json"),
        apply: true,
      });
      expect(fs.existsSync(leasePath)).toBe(true);
      expect(fs.existsSync(anchor)).toBe(false);
      expect(fs.existsSync(control)).toBe(false);
      expect(fs.existsSync(anchor + ".recovery.mjs")).toBe(false);
      expect(
        readConfigMachineStateWithMetadata<UpdatePreviousBootSettlementReceipt>(
          "update.previousBootSettlement." + record.descriptor.operationId,
          { env: state.env },
        )?.value.phase,
      ).toBe("committed");
      expect(() => assertNoPendingUpdateRecovery({ env: state.env })).not.toThrow();
    } finally {
      log.mockRestore();
      validateAttestation.mockRestore();
      readBuildId.mockRestore();
      readPackageVersion.mockRestore();
      observeGateway.mockRestore();
      resolveCommand.mockRestore();
      readService.mockRestore();
      await activation.lifetime.cleanup();
    }
  });

  it("keeps the CLI default a journal-only plan against a real package activation descriptor", async () => {
    const activation = createPackageActivationLifetimeFixture();
    const { root: fixtureRoot } = activation.setup();
    try {
      const fixture = await activation.prepare();
      const journalPath = resolvePackageActivationJournalPath(fixture.anchor);
      const beforeJournal = fs.readFileSync(journalPath);
      const beforeControl = fs
        .readdirSync(resolvePackageActivationControl(fixture.anchor))
        .toSorted();
      const emitted: string[] = [];
      const log = vi.spyOn(defaultRuntime, "log").mockImplementation((value) => {
        emitted.push(String(value));
      });
      try {
        await settlePreviousBootRecoveryCommand({
          operationId: fixture.operationId,
          installRoot: fixture.packageRoot,
          anchor: fixture.anchor,
          control: resolvePackageActivationControl(fixture.anchor),
          journal: journalPath,
          helper: resolvePackageActivationHelper(fixture.anchor),
          archive: path.join(fixtureRoot, "archive.tar"),
          serviceUnit: "openclaw-gateway.service",
          launcher: [fixture.launcher + "|" + fixture.launcher],
          attestation: path.join(fixtureRoot, "attestation.json"),
          apply: false,
        });
      } finally {
        log.mockRestore();
      }
      expect(JSON.parse(emitted[0] ?? "{}")).toMatchObject({
        status: "plan-only",
        operationId: fixture.operationId,
        operationMatches: true,
        verification: "journal-descriptor-only",
        readinessChecked: false,
        artifactsHashed: false,
        applyRequired: true,
      });
      expect(fs.readFileSync(journalPath)).toEqual(beforeJournal);
      expect(fs.readdirSync(resolvePackageActivationControl(fixture.anchor)).toSorted()).toEqual(
        beforeControl,
      );
      expect(fs.existsSync(path.join(fixtureRoot, "archive.tar"))).toBe(false);
      expect(fs.existsSync(path.join(fixtureRoot, "attestation.json"))).toBe(false);
    } finally {
      await activation.lifetime.cleanup();
    }
  });

  it("resumes each durable move phase while the active recovery row remains the admission barrier", async () => {
    const runId = randomUUID();
    const record = createRetainedUpdateRecovery(
      {
        runId,
        from: { root: "/old", nodePath: process.execPath, version: "1.0.0", buildId: "old" },
        to: { root: "/new", nodePath: process.execPath, version: "2.0.0", buildId: "new" },
      },
      { env: state.env },
    );
    storeRetainedUpdateRecovery(record, { env: state.env });
    const f = recoveryFixture(runId, record.transactionId);
    const quarantineRoot = path.join(
      f.parent,
      ".openclaw-previous-boot-settlement-" + record.transactionId,
    );
    const stopped = new Set<PreviousBootSettlementPhase>();
    let savedInventory: PreviousBootQuarantineResult["inventory"] | undefined;
    const persistPhase = async (
      _phase: PreviousBootSettlementPhase,
      inventory: NonNullable<typeof savedInventory>,
    ) => {
      savedInventory = inventory;
    };
    for (const phase of [
      "intent-persisted",
      "control-moved",
      "control-reserved",
      "anchor-moved",
    ] as const) {
      if (stopped.has(phase)) {
        continue;
      }
      await expect(
        publishPreviousBootArtifacts({
          runId,
          operationId: record.transactionId,
          rawSha256: "b".repeat(64),
          attestationSha256: "c".repeat(64),
          attestation: f.attestation,
          paths: f.paths,
          quarantineRoot,
          priorInventory: savedInventory,
          persistPhase,
          afterPhase: (current) => {
            if (current === phase) {
              stopped.add(phase);
              throw new Error("simulated process stop");
            }
          },
        }),
      ).rejects.toThrow("simulated process stop");
      expect(() => assertNoPendingUpdateRecovery({ env: state.env })).toThrow();
    }

    const complete = await publishPreviousBootArtifacts({
      runId,
      operationId: record.transactionId,
      rawSha256: "b".repeat(64),
      attestationSha256: "c".repeat(64),
      attestation: f.attestation,
      paths: f.paths,
      quarantineRoot,
      priorInventory: savedInventory,
      persistPhase,
    });
    expect(fs.existsSync(complete.anchorQuarantinePath)).toBe(true);
    expect(fs.existsSync(complete.controlQuarantinePath)).toBe(true);
    expect(fs.existsSync(path.join(f.paths.controlPath, "previous-boot-reservation.json"))).toBe(
      true,
    );
    expect(() => assertPackageActivationLayout(f.paths.anchorPath)).toThrow(
      /Legacy package activation artifacts/iu,
    );
    expect(() => assertNoPendingUpdateRecovery({ env: state.env })).toThrow();
  });

  it("preserves symlink identity and target without following the linked path", async () => {
    const runId = randomUUID();
    const operationId = randomUUID();
    const f = recoveryFixture(runId, operationId);
    fs.symlinkSync("/etc/passwd", path.join(f.paths.controlPath, "unexpected-link"));
    const result = await publishPreviousBootArtifacts({
      runId,
      operationId,
      rawSha256: "b".repeat(64),
      attestationSha256: "c".repeat(64),
      attestation: f.attestation,
      paths: f.paths,
      quarantineRoot: path.join(f.parent, ".openclaw-previous-boot-settlement-" + operationId),
    });
    expect(fs.readlinkSync(path.join(result.controlQuarantinePath, "unexpected-link"))).toBe(
      "/etc/passwd",
    );
    expect(fs.existsSync(f.paths.anchorPath)).toBe(false);
    expect(fs.existsSync(path.join(f.paths.controlPath, "previous-boot-reservation.json"))).toBe(
      true,
    );
  });

  it("refuses a changed quarantine inventory and leaves the recovery row pending", async () => {
    const runId = randomUUID();
    const record = createRetainedUpdateRecovery(
      {
        runId,
        from: { root: "/old", nodePath: process.execPath, version: "1.0.0", buildId: "old" },
        to: { root: "/new", nodePath: process.execPath, version: "2.0.0", buildId: "new" },
      },
      { env: state.env },
    );
    storeRetainedUpdateRecovery(record, { env: state.env });
    const f = recoveryFixture(runId, record.transactionId);
    const quarantineRoot = path.join(
      f.parent,
      ".openclaw-previous-boot-settlement-" + record.transactionId,
    );
    let savedInventory: PreviousBootQuarantineResult["inventory"] | undefined;
    await expect(
      publishPreviousBootArtifacts({
        runId,
        operationId: record.transactionId,
        rawSha256: "b".repeat(64),
        attestationSha256: "c".repeat(64),
        attestation: f.attestation,
        paths: f.paths,
        quarantineRoot,
        persistPhase: async (_phase, inventory) => {
          savedInventory = inventory;
        },
        afterPhase: (phase) => {
          if (phase === "control-moved") {
            throw new Error("simulated stop");
          }
        },
      }),
    ).rejects.toThrow("simulated stop");
    fs.appendFileSync(path.join(quarantineRoot, "control", "operation.sqlite"), "tamper");
    await expect(
      publishPreviousBootArtifacts({
        runId,
        operationId: record.transactionId,
        rawSha256: "b".repeat(64),
        attestationSha256: "c".repeat(64),
        attestation: f.attestation,
        paths: f.paths,
        quarantineRoot,
        priorInventory: savedInventory,
      }),
    ).rejects.toThrow(/inventory changed/u);
    expect(() => assertNoPendingUpdateRecovery({ env: state.env })).toThrow();
  });
});
