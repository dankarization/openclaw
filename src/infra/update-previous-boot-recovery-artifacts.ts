import { createHash } from "node:crypto";
import fs, { constants as C } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { requireDirectorySync, syncDirectorySync } from "./directory-durability.js";
import {
  openPackageActivationJournal,
  assertPackageActivationOperation,
  encodePackageActivationLauncher,
} from "./package-update-activation-journal.js";
import { createPackageIntegrityReader } from "./package-update-integrity.js";
import type {
  UpdatePreviousBootAttestation,
  UpdatePreviousBootAttestationPaths,
} from "./update-previous-boot-attestation.js";

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export type InventoryEntry = {
  relativePath: string;
  kind: "directory" | "file" | "symlink";
  nlink: number;
  dev: number;
  ino: number;
  uid: number;
  gid: number;
  mode: number;
  size: number;
  sha256: string | null;
};
export type Intent = {
  version: 1;
  runId: string;
  operationId: string;
  attestationSha256: string;
  rawSha256: string;
  anchorPath: string;
  controlPath: string;
  quarantineRoot: string;
  inventory: { anchor: InventoryEntry[]; control: InventoryEntry[] };
};
export type PreviousBootQuarantineResult = {
  quarantineRoot: string;
  anchorQuarantinePath: string;
  controlQuarantinePath: string;
  inventory: Intent["inventory"];
};
export type PreviousBootSettlementPhase =
  | "intent-persisted"
  | "control-moved"
  | "control-reserved"
  | "anchor-moved"
  | "inventory-verified"
  | "committed";

export async function verifyOriginalPackageActivation(
  paths: UpdatePreviousBootAttestationPaths,
  operationId: string,
) {
  const journal = openPackageActivationJournal(paths.anchorPath);
  const record = journal.read();
  assertPackageActivationOperation(record, operationId);
  if (record.phase !== "publication-complete") {
    throw new Error(
      "Previous-boot settlement requires the exact completed package-publication journal.",
    );
  }
  const descriptor = record.descriptor;
  if (path.resolve(descriptor.authority.installKey) !== path.resolve(paths.installRoot)) {
    throw new Error("Package activation journal targets a different installed root.");
  }
  const reader = createPackageIntegrityReader(15 * 60_000);
  const [installed, previous] = await Promise.all([
    reader.tree(paths.installRoot),
    reader.tree(path.join(paths.anchorPath, "previous"), paths.installRoot),
  ]);
  if (!isDeepStrictEqual(installed, descriptor.candidate)) {
    throw new Error("Installed package fingerprint differs from the journal candidate.");
  }
  if (!isDeepStrictEqual(previous, descriptor.previous)) {
    throw new Error("Retained package fingerprint differs from the journal previous package.");
  }
  if (paths.launchers.length !== descriptor.launchers.length) {
    throw new Error("Attested launcher set differs from the package activation journal.");
  }
  for (const entry of descriptor.launchers) {
    const requested = paths.launchers.find(
      (item) => path.resolve(item.path) === path.join(descriptor.binDir, entry.name),
    );
    if (!requested) {
      throw new Error("A journal-owned launcher is missing from the attested launcher set.");
    }
    const observed = encodePackageActivationLauncher(await reader.launcher(requested.path));
    if (observed !== entry.candidate) {
      throw new Error("Installed launcher fingerprint differs from the journal candidate.");
    }
  }
  return { record, installed };
}

function fsyncDirectory(directory: string): void {
  requireDirectorySync(syncDirectorySync(directory), "Previous-boot recovery quarantine");
}
function statPrivateDirectory(filename: string, uid: number) {
  const stat = fs.lstatSync(filename);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== uid ||
    (stat.mode & 0o077) !== 0
  ) {
    throw new Error("Previous-boot quarantine objects must be private service-owned directories.");
  }
  return stat;
}
function inventoryDirectory(root: string, serviceUid: number): InventoryEntry[] {
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== serviceUid) {
    throw new Error("Recovery inventory root must be a service-owned directory.");
  }
  const entries: InventoryEntry[] = [];
  const visit = (directory: string, relative: string) => {
    const names = fs.readdirSync(directory).toSorted();
    for (const name of names) {
      if (name === "." || name === "..") {
        throw new Error("Invalid recovery inventory name.");
      }
      const pathname = path.join(directory, name);
      const relativePath = relative ? path.join(relative, name) : name;
      const stat = fs.lstatSync(pathname);
      if (!stat.isDirectory() && !stat.isFile() && !stat.isSymbolicLink()) {
        throw new Error("Recovery inventory contains an unknown filesystem object.");
      }
      if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(pathname);
        entries.push({
          relativePath,
          kind: "symlink",
          dev: stat.dev,
          ino: stat.ino,
          uid: stat.uid,
          gid: stat.gid,
          mode: stat.mode & 0o777,
          size: Buffer.byteLength(target),
          sha256: sha256(target),
          nlink: stat.nlink,
        });
      } else if (stat.isDirectory()) {
        entries.push({
          relativePath,
          kind: "directory",
          dev: stat.dev,
          ino: stat.ino,
          uid: stat.uid,
          gid: stat.gid,
          mode: stat.mode & 0o777,
          size: 0,
          sha256: null,
          nlink: stat.nlink,
        });
        visit(pathname, relativePath);
      } else {
        entries.push({
          relativePath,
          kind: "file",
          dev: stat.dev,
          ino: stat.ino,
          uid: stat.uid,
          gid: stat.gid,
          mode: stat.mode & 0o777,
          size: stat.size,
          sha256: null,
          nlink: stat.nlink,
        });
      }
    }
  };
  visit(root, "");
  return entries;
}
export function assertInventory(
  root: string,
  expected: InventoryEntry[],
  serviceUid: number,
): void {
  if (JSON.stringify(inventoryDirectory(root, serviceUid)) !== JSON.stringify(expected)) {
    throw new Error("Quarantined package activation inventory changed.");
  }
}
function writeReservation(
  controlPath: string,
  runId: string,
  operationId: string,
  attestationSha256: string,
  uid: number,
  gid: number,
): void {
  try {
    fs.mkdirSync(controlPath, { mode: 0o700 });
    fs.chownSync(controlPath, uid, gid);
    fs.chmodSync(controlPath, 0o700);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) {
      throw error;
    }
  }
  statPrivateDirectory(controlPath, uid);
  const receipt = path.join(controlPath, "previous-boot-reservation.json");
  const expected = JSON.stringify({ version: 1, runId, operationId, attestationSha256 }) + "\n";
  const entries = fs.readdirSync(controlPath);
  if (entries.length === 0) {
    const fd = fs.openSync(receipt, C.O_WRONLY | C.O_CREAT | C.O_EXCL | (C.O_NOFOLLOW ?? 0), 0o600);
    try {
      fs.fchownSync(fd, uid, gid);
      fs.writeFileSync(fd, expected);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } else {
    const stat = fs.lstatSync(receipt);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.uid !== uid ||
      (stat.mode & 0o777) !== 0o600 ||
      fs.readFileSync(receipt, "utf8") !== expected ||
      entries.length !== 1
    ) {
      throw new Error("Existing control-path reservation belongs to another operation.");
    }
  }
  fsyncDirectory(controlPath);
  fsyncDirectory(path.dirname(controlPath));
}
function legacyAdmissionMarker(anchor: string): string {
  return anchor + ".recovery.mjs";
}
function writeLegacyAdmissionMarker(
  anchor: string,
  operationId: string,
  receiptSha256: string,
  uid: number,
  gid: number,
): void {
  const filename = legacyAdmissionMarker(anchor);
  const expected =
    JSON.stringify({ kind: "previous-boot-settlement", version: 1, operationId, receiptSha256 }) +
    "\n";
  const existing = fs.lstatSync(filename, { throwIfNoEntry: false });
  if (existing) {
    if (
      !existing.isFile() ||
      existing.isSymbolicLink() ||
      existing.uid !== uid ||
      (existing.mode & 0o777) !== 0o600 ||
      fs.readFileSync(filename, "utf8") !== expected
    ) {
      throw new Error("Existing package admission marker belongs to another owner.");
    }
    return;
  }
  const fd = fs.openSync(filename, C.O_WRONLY | C.O_CREAT | C.O_EXCL | (C.O_NOFOLLOW ?? 0), 0o600);
  try {
    fs.fchownSync(fd, uid, gid);
    fs.writeFileSync(fd, expected);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fsyncDirectory(path.dirname(filename));
}
export function removeLegacyAdmissionMarker(
  anchor: string,
  operationId: string,
  receiptSha256: string,
  uid: number,
): void {
  const filename = legacyAdmissionMarker(anchor);
  const stat = fs.lstatSync(filename, { throwIfNoEntry: false });
  if (!stat) {
    return;
  }
  const expected =
    JSON.stringify({ kind: "previous-boot-settlement", version: 1, operationId, receiptSha256 }) +
    "\n";
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== uid ||
    (stat.mode & 0o777) !== 0o600 ||
    fs.readFileSync(filename, "utf8") !== expected
  ) {
    throw new Error("Refusing to remove another package admission marker.");
  }
  fs.unlinkSync(filename);
  fsyncDirectory(path.dirname(filename));
}

function isExpectedDirectory(
  filename: string,
  identity: UpdatePreviousBootAttestation["anchorIdentity"],
): boolean {
  const stat = fs.lstatSync(filename, { throwIfNoEntry: false });
  return Boolean(
    stat &&
    stat.isDirectory() &&
    !stat.isSymbolicLink() &&
    stat.dev === identity.dev &&
    stat.ino === identity.ino &&
    stat.uid === identity.uid &&
    stat.gid === identity.gid &&
    (stat.mode & 0o777) === identity.mode,
  );
}
function assertMoveState(
  source: string,
  target: string,
  identity: UpdatePreviousBootAttestation["anchorIdentity"],
): "source" | "target" {
  const src = fs.lstatSync(source, { throwIfNoEntry: false });
  const dst = fs.lstatSync(target, { throwIfNoEntry: false });
  if (src && dst) {
    throw new Error("Both original and quarantined activation paths exist.");
  }
  if (src && isExpectedDirectory(source, identity)) {
    return "source";
  }
  if (dst && isExpectedDirectory(target, identity)) {
    return "target";
  }
  throw new Error("Activation path is missing or no longer has its attested identity.");
}
function moveDirectory(
  source: string,
  target: string,
  identity: UpdatePreviousBootAttestation["anchorIdentity"],
): void {
  if (assertMoveState(source, target, identity) === "target") {
    return;
  }
  const parentDevice = fs.statSync(path.dirname(source)).dev;
  if (fs.statSync(path.dirname(target)).dev !== parentDevice) {
    throw new Error("Quarantine must be on the original activation filesystem.");
  }
  fs.renameSync(source, target);
  fsyncDirectory(path.dirname(source));
  if (path.dirname(source) !== path.dirname(target)) {
    fsyncDirectory(path.dirname(target));
  }
  if (!isExpectedDirectory(target, identity)) {
    throw new Error("Renamed activation directory identity changed.");
  }
}
export async function publishPreviousBootArtifacts(input: {
  runId: string;
  operationId: string;
  rawSha256: string;
  attestationSha256: string;
  attestation: UpdatePreviousBootAttestation;
  paths: UpdatePreviousBootAttestationPaths;
  quarantineRoot: string;
  priorInventory?: Intent["inventory"];
  persistPhase?: (
    phase: PreviousBootSettlementPhase,
    inventory: Intent["inventory"],
  ) => Promise<void>;
  assertCurrent?: () => void;
  afterPhase?: (phase: PreviousBootSettlementPhase) => void;
}): Promise<PreviousBootQuarantineResult> {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (
    process.platform !== "linux" ||
    uid === undefined ||
    gid === undefined ||
    uid === 0 ||
    uid !== input.attestation.serviceUid ||
    gid !== input.attestation.serviceGid
  ) {
    throw new Error(
      "Quarantine publication must run as the exact non-root Gateway service account.",
    );
  }
  if (
    input.operationId !== input.attestation.operationId ||
    !/^[a-f0-9]{64}$/u.test(input.attestationSha256) ||
    !/^[a-f0-9]{64}$/u.test(input.rawSha256) ||
    path.resolve(input.paths.installRoot) !== input.attestation.installRoot ||
    path.resolve(input.paths.anchorPath) !== input.attestation.anchorPath ||
    path.resolve(input.paths.controlPath) !== input.attestation.controlPath
  ) {
    throw new Error("Quarantine operation is not bound to the root attestation.");
  }
  const anchor = input.paths.anchorPath;
  const control = input.paths.controlPath;
  const qroot = path.resolve(input.quarantineRoot);
  if (path.dirname(anchor) !== path.dirname(control)) {
    throw new Error("Activation anchor and control must remain siblings.");
  }
  const parent = fs.realpathSync(path.dirname(anchor));
  const qparent = fs.realpathSync(path.dirname(qroot));
  if (
    path.join(parent, path.basename(anchor)) !== anchor ||
    path.join(qparent, path.basename(qroot)) !== qroot
  ) {
    throw new Error("Activation and quarantine paths must be canonical.");
  }
  if (
    qroot === anchor ||
    qroot.startsWith(anchor + path.sep) ||
    qroot === control ||
    qroot.startsWith(control + path.sep)
  ) {
    throw new Error("Quarantine may not be inside the package activation objects.");
  }
  if (qroot.split(path.sep).includes("node_modules")) {
    throw new Error("Quarantine may not be inside shared node_modules.");
  }
  const parentStat = fs.statSync(parent);
  if (fs.statSync(qparent).dev !== parentStat.dev) {
    throw new Error("Quarantine must be on the activation filesystem.");
  }
  if (
    parentStat.dev !== fs.lstatSync(anchor, { throwIfNoEntry: false })?.dev &&
    fs.existsSync(anchor)
  ) {
    throw new Error("Original anchor is not on its parent filesystem.");
  }
  if (
    parentStat.dev !== fs.lstatSync(control, { throwIfNoEntry: false })?.dev &&
    fs.existsSync(control)
  ) {
    throw new Error("Original control directory is not on its parent filesystem.");
  }
  const qStat = fs.lstatSync(qroot, { throwIfNoEntry: false });
  if (qStat) {
    statPrivateDirectory(qroot, uid);
  }
  const anchorQuarantinePath = path.join(qroot, "anchor");
  const controlQuarantinePath = path.join(qroot, "control");
  const knownQuarantineNames = new Set(["anchor", "control"]);
  if (qStat && fs.readdirSync(qroot).some((name) => !knownQuarantineNames.has(name))) {
    throw new Error("Existing quarantine contains unowned filesystem objects.");
  }
  const inventory = input.priorInventory ?? {
    anchor: inventoryDirectory(fs.existsSync(anchor) ? anchor : anchorQuarantinePath, uid),
    control: inventoryDirectory(fs.existsSync(control) ? control : controlQuarantinePath, uid),
  };
  input.assertCurrent?.();
  writeLegacyAdmissionMarker(anchor, input.operationId, input.attestationSha256, uid, gid);
  input.assertCurrent?.();
  await input.persistPhase?.("intent-persisted", inventory);
  input.assertCurrent?.();
  input.afterPhase?.("intent-persisted");
  if (!qStat) {
    input.assertCurrent?.();
    fs.mkdirSync(qroot, { mode: 0o700 });
    fs.chownSync(qroot, uid, gid);
    fs.chmodSync(qroot, 0o700);
    fsyncDirectory(qparent);
  }

  const controlQuarantineExists = isExpectedDirectory(
    controlQuarantinePath,
    input.attestation.controlIdentity,
  );
  if (controlQuarantineExists) {
    assertInventory(controlQuarantinePath, inventory.control, uid);
    input.assertCurrent?.();
    writeReservation(control, input.runId, input.operationId, input.attestationSha256, uid, gid);
  } else {
    input.assertCurrent?.();
    moveDirectory(control, controlQuarantinePath, input.attestation.controlIdentity);
    assertInventory(controlQuarantinePath, inventory.control, uid);
    await input.persistPhase?.("control-moved", inventory);
    input.afterPhase?.("control-moved");
    input.assertCurrent?.();
    writeReservation(control, input.runId, input.operationId, input.attestationSha256, uid, gid);
  }
  await input.persistPhase?.("control-reserved", inventory);
  input.afterPhase?.("control-reserved");

  input.assertCurrent?.();
  moveDirectory(anchor, anchorQuarantinePath, input.attestation.anchorIdentity);
  assertInventory(anchorQuarantinePath, inventory.anchor, uid);
  await input.persistPhase?.("anchor-moved", inventory);
  input.afterPhase?.("anchor-moved");
  assertInventory(controlQuarantinePath, inventory.control, uid);
  await input.persistPhase?.("inventory-verified", inventory);
  input.afterPhase?.("inventory-verified");
  return { quarantineRoot: qroot, anchorQuarantinePath, controlQuarantinePath, inventory };
}

export function removeReservation(
  controlPath: string,
  runId: string,
  operationId: string,
  attestationSha256: string,
  uid: number,
): void {
  statPrivateDirectory(controlPath, uid);
  const receipt = path.join(controlPath, "previous-boot-reservation.json");
  const expected = JSON.stringify({ version: 1, runId, operationId, attestationSha256 }) + "\n";
  const stat = fs.lstatSync(receipt);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== uid ||
    (stat.mode & 0o777) !== 0o600 ||
    fs.readFileSync(receipt, "utf8") !== expected ||
    fs.readdirSync(controlPath).length !== 1
  ) {
    throw new Error("Refusing to remove a reservation not owned by this settlement.");
  }
  fs.unlinkSync(receipt);
  fs.rmdirSync(controlPath);
  fsyncDirectory(path.dirname(controlPath));
}

export function rollbackQuarantine(
  paths: UpdatePreviousBootAttestationPaths,
  quarantined: PreviousBootQuarantineResult,
  attestation: UpdatePreviousBootAttestation,
  runId: string,
  operationId: string,
  attestationSha256: string,
  serviceUid: number,
  assertCurrent: () => void,
): void {
  const anchorState = assertMoveState(
    paths.anchorPath,
    quarantined.anchorQuarantinePath,
    attestation.anchorIdentity,
  );
  if (anchorState === "target") {
    assertInventory(quarantined.anchorQuarantinePath, quarantined.inventory.anchor, serviceUid);
    assertCurrent();
    fs.renameSync(quarantined.anchorQuarantinePath, paths.anchorPath);
    fsyncDirectory(path.dirname(paths.anchorPath));
  }
  const controlAtOriginal = fs.lstatSync(paths.controlPath, { throwIfNoEntry: false });
  if (controlAtOriginal && !isExpectedDirectory(paths.controlPath, attestation.controlIdentity)) {
    assertCurrent();
    removeReservation(paths.controlPath, runId, operationId, attestationSha256, serviceUid);
  }
  const controlState = assertMoveState(
    paths.controlPath,
    quarantined.controlQuarantinePath,
    attestation.controlIdentity,
  );
  if (controlState === "target") {
    assertInventory(quarantined.controlQuarantinePath, quarantined.inventory.control, serviceUid);
    assertCurrent();
    fs.renameSync(quarantined.controlQuarantinePath, paths.controlPath);
    fsyncDirectory(path.dirname(paths.controlPath));
  }
}
