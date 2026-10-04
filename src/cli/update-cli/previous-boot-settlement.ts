import path from "node:path";
import {
  createUpdatePreviousBootAttestation,
  type UpdatePreviousBootAttestationPaths,
} from "../../infra/update-previous-boot-attestation.js";
import { settlePreviousBootUpdateRecovery } from "../../infra/update-previous-boot-recovery-owner.js";
import { defaultRuntime } from "../../runtime.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";

type AttestOptions = {
  operationId: string;
  oldBootId: string;
  serviceUid: string;
  serviceGid: string;
  installRoot: string;
  anchor: string;
  control: string;
  journal: string;
  helper: string;
  archive: string;
  serviceUnit: string;
  launcher: string[];
};
type SettleOptions = Omit<AttestOptions, "oldBootId" | "serviceUid" | "serviceGid"> & {
  attestation: string;
  apply: boolean;
};

function requiredNumber(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(label + " must be a non-negative integer.");
  }
  return parsed;
}
function pathsFromOptions(
  opts: Omit<AttestOptions, "operationId" | "oldBootId" | "serviceUid" | "serviceGid">,
): UpdatePreviousBootAttestationPaths {
  const launchers = (opts.launcher ?? []).map((item) => {
    const split = item.indexOf("|");
    if (split < 1 || split === item.length - 1) {
      throw new Error("Each --launcher must be PATH|ARGV0.");
    }
    return { path: item.slice(0, split), argv0: item.slice(split + 1) };
  });
  return {
    installRoot: path.resolve(opts.installRoot),
    anchorPath: path.resolve(opts.anchor),
    controlPath: path.resolve(opts.control),
    journalPath: path.resolve(opts.journal),
    helperPath: path.resolve(opts.helper),
    archivePath: path.resolve(opts.archive),
    serviceUnit: opts.serviceUnit,
    launchers,
  };
}

export async function createPreviousBootAttestationCommand(opts: AttestOptions): Promise<void> {
  const result = createUpdatePreviousBootAttestation({
    operationId: opts.operationId,
    oldBootId: opts.oldBootId,
    serviceUid: requiredNumber(opts.serviceUid, "--service-uid"),
    serviceGid: requiredNumber(opts.serviceGid, "--service-gid"),
    paths: pathsFromOptions(opts),
  });
  defaultRuntime.log(
    JSON.stringify({
      status: "attested",
      path: result.path,
      operationId: result.attestation.operationId,
      currentBootId: result.attestation.currentBootId,
      oldBootId: result.attestation.oldBootId,
      evidenceSha256: result.sha256,
    }),
  );
}

export async function settlePreviousBootRecoveryCommand(opts: SettleOptions): Promise<void> {
  const paths = pathsFromOptions(opts);
  if (!opts.apply) {
    const { openPackageActivationJournal } =
      await import("../../infra/package-update-activation-journal.js");
    const record = openPackageActivationJournal(paths.anchorPath).read();
    defaultRuntime.log(
      JSON.stringify({
        status: "plan-only",
        operationId: record.descriptor.operationId,
        requestedOperationId: opts.operationId,
        operationMatches: record.descriptor.operationId === opts.operationId,
        installRoot: paths.installRoot,
        anchor: paths.anchorPath,
        control: paths.controlPath,
        attestation: path.resolve(opts.attestation),
        verification: "journal-descriptor-only",
        readinessChecked: false,
        artifactsHashed: false,
        applyRequired: true,
      }),
    );
    return;
  }
  const result = await withUpdateCommandExecutor(opts.operationId, async (executor) => {
    const executorFence = await executor.enter(paths.installRoot, { preflight: true });
    return settlePreviousBootUpdateRecovery({
      runId: opts.operationId,
      attestationPath: opts.attestation,
      paths,
      executorFence,
    });
  });
  defaultRuntime.log(JSON.stringify(result));
}
