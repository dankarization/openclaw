import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs, { constants as C } from "node:fs";
import path from "node:path";
import { z } from "zod";

export const UPDATE_PREVIOUS_BOOT_ATTESTATION_DIR =
  "/var/lib/openclaw/update-recovery-attestations";
const bootId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const digest = /^[a-f0-9]{64}$/u;
const absolute = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => path.isAbsolute(value));
const artifact = z.strictObject({
  path: absolute,
  sha256: z.string().regex(digest),
  dev: z.number().int().nonnegative(),
  ino: z.number().int().positive(),
  size: z.number().int().nonnegative(),
});
const directory = z.strictObject({
  path: absolute,
  dev: z.number().int().nonnegative(),
  ino: z.number().int().positive(),
  uid: z.number().int().nonnegative(),
  gid: z.number().int().nonnegative(),
  mode: z.number().int().nonnegative(),
});
const launcher = artifact.extend({ argv0: absolute });
export const UpdatePreviousBootAttestationSchema = z
  .strictObject({
    version: z.literal(1),
    operationId: z.uuid(),
    oldBootId: z.string().regex(bootId),
    currentBootId: z.string().regex(bootId),
    issuerUid: z.literal(0),
    serviceUid: z.number().int().positive(),
    serviceGid: z.number().int().nonnegative(),
    installRoot: absolute,
    anchorPath: absolute,
    controlPath: absolute,
    anchorIdentity: directory,
    controlIdentity: directory,
    journal: artifact,
    helper: artifact,
    archive: artifact,
    serviceUnit: z.string().min(1).max(256),
    launchers: z.array(launcher).min(1).max(16),
    issuedAtMs: z.number().int().positive(),
    nonce: z.uuid(),
  })
  .refine((value) => value.oldBootId.toLowerCase() !== value.currentBootId.toLowerCase(), {
    message: "Attested old and current boot IDs must differ.",
  });
export type UpdatePreviousBootAttestation = z.infer<typeof UpdatePreviousBootAttestationSchema>;
export type UpdatePreviousBootAttestationPaths = {
  installRoot: string;
  anchorPath: string;
  controlPath: string;
  anchorEvidencePath?: string;
  controlEvidencePath?: string;
  quarantineRoot?: string;
  journalPath: string;
  helperPath: string;
  archivePath: string;
  serviceUnit: string;
  launchers: Array<{ path: string; argv0: string }>;
};

type System = {
  effectiveUid(): number;
  readBootId(): string;
  readJournalBootIds(): string[];
  now(): number;
  nonce(): string;
};
function defaults(): System {
  return {
    effectiveUid: () => process.geteuid?.() ?? -1,
    readBootId: () => fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
    readJournalBootIds: () => {
      const result = spawnSync("journalctl", ["--list-boots", "--no-pager"], {
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 64 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
        throw new Error("Persistent system journal boot history is unavailable.");
      }
      return [...result.stdout.matchAll(/^\s*-?\d+\s+([0-9a-f-]{32}|[0-9a-f-]{36})\s/giu)].map(
        (m) => {
          const value = m[1]!.toLowerCase();
          return value.length === 32
            ? value.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/u, "$1-$2-$3-$4-$5")
            : value;
        },
      );
    },
    now: Date.now,
    nonce: randomUUID,
  };
}
function requireRootLinux(system: System): void {
  if (process.platform !== "linux" || system.effectiveUid() !== 0) {
    throw new Error(
      "Attestation production requires a privileged Linux operator (effective UID 0).",
    );
  }
}
function assertProtectedDirectory(serviceGid: number): void {
  const dir = UPDATE_PREVIOUS_BOOT_ATTESTATION_DIR;
  let current = path.parse(dir).root;
  for (const part of dir.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== 0 ||
      (stat.mode & 0o022) !== 0
    ) {
      throw new Error(
        "Attestation directory ancestry must be root-owned and not group/world writable.",
      );
    }
  }
  const stat = fs.statSync(dir);
  if (stat.gid !== serviceGid || (stat.mode & 0o777) !== 0o750) {
    throw new Error("Attestation directory must be root:<service-gid> mode 0750.");
  }
}
function prepareDirectory(serviceGid: number): void {
  const base = "/var/lib";
  const baseStat = fs.lstatSync(base);
  if (
    !baseStat.isDirectory() ||
    baseStat.isSymbolicLink() ||
    baseStat.uid !== 0 ||
    (baseStat.mode & 0o022) !== 0
  ) {
    throw new Error("Attestation base must be a protected root-owned directory.");
  }
  const parent = path.dirname(UPDATE_PREVIOUS_BOOT_ATTESTATION_DIR);
  try {
    fs.mkdirSync(parent, { mode: 0o755 });
    fs.chownSync(parent, 0, 0);
    fs.chmodSync(parent, 0o755);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) {
      throw error;
    }
  }
  const parentStat = fs.lstatSync(parent);
  if (
    !parentStat.isDirectory() ||
    parentStat.isSymbolicLink() ||
    parentStat.uid !== 0 ||
    (parentStat.mode & 0o022) !== 0
  ) {
    throw new Error("Attestation parent must be protected and root-owned.");
  }
  try {
    fs.mkdirSync(UPDATE_PREVIOUS_BOOT_ATTESTATION_DIR, { mode: 0o750 });
    fs.chownSync(UPDATE_PREVIOUS_BOOT_ATTESTATION_DIR, 0, serviceGid);
    fs.chmodSync(UPDATE_PREVIOUS_BOOT_ATTESTATION_DIR, 0o750);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) {
      throw error;
    }
  }
  assertProtectedDirectory(serviceGid);
}
function directoryIdentity(filename: string, serviceUid: number) {
  const pathname = path.resolve(filename);
  const stat = fs.lstatSync(pathname);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== serviceUid ||
    (stat.mode & 0o077) !== 0
  ) {
    throw new Error(
      "Package activation directories must be private directories owned by the service UID.",
    );
  }
  return {
    path: pathname,
    dev: stat.dev,
    ino: stat.ino,
    uid: stat.uid,
    gid: stat.gid,
    mode: stat.mode & 0o777,
  };
}
function assertDirectoryIdentity(filename: string, expected: z.infer<typeof directory>): void {
  const actual = directoryIdentity(filename, expected.uid);
  if (
    actual.dev !== expected.dev ||
    actual.ino !== expected.ino ||
    actual.uid !== expected.uid ||
    actual.gid !== expected.gid ||
    actual.mode !== expected.mode
  ) {
    throw new Error("Package activation directory identity changed after attestation.");
  }
}
function hashArtifact(filename: string) {
  const pathname = path.resolve(filename);
  const before = fs.lstatSync(pathname);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new Error("Attested artifacts must be regular singly-linked files.");
  }
  const fd = fs.openSync(pathname, C.O_RDONLY | (C.O_NOFOLLOW ?? 0));
  try {
    const first = fs.fstatSync(fd);
    if (!first.isFile() || first.dev !== before.dev || first.ino !== before.ino) {
      throw new Error("Artifact identity changed while opening.");
    }
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let size = 0;
    for (;;) {
      const count = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!count) {
        break;
      }
      hash.update(chunk.subarray(0, count));
      size += count;
    }
    const last = fs.fstatSync(fd);
    const named = fs.lstatSync(pathname);
    if (
      last.dev !== first.dev ||
      last.ino !== first.ino ||
      last.size !== first.size ||
      last.mtimeMs !== first.mtimeMs ||
      named.dev !== first.dev ||
      named.ino !== first.ino ||
      size !== first.size
    ) {
      throw new Error("Artifact changed while hashing.");
    }
    return { path: pathname, sha256: hash.digest("hex"), dev: first.dev, ino: first.ino, size };
  } finally {
    fs.closeSync(fd);
  }
}
function hashLauncher(filename: string) {
  const pathname = path.resolve(filename);
  const before = fs.lstatSync(pathname);
  if (!before.isSymbolicLink()) {
    return hashArtifact(pathname);
  }
  const target = fs.readlinkSync(pathname);
  const after = fs.lstatSync(pathname);
  if (
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.mtimeMs !== before.mtimeMs ||
    after.ctimeMs !== before.ctimeMs ||
    !after.isSymbolicLink()
  ) {
    throw new Error("Launcher symlink changed while reading.");
  }
  return {
    path: pathname,
    sha256: createHash("sha256").update(target).digest("hex"),
    dev: before.dev,
    ino: before.ino,
    size: Buffer.byteLength(target),
  };
}
function readAttestation(filename: string, serviceGid: number) {
  assertProtectedDirectory(serviceGid);
  const stat = fs.lstatSync(filename);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== 0 ||
    stat.gid !== serviceGid ||
    (stat.mode & 0o777) !== 0o440 ||
    stat.nlink !== 1 ||
    path.dirname(path.resolve(filename)) !== UPDATE_PREVIOUS_BOOT_ATTESTATION_DIR
  ) {
    throw new Error("Attestation file owner, mode, type, or path is invalid.");
  }
  const fd = fs.openSync(filename, C.O_RDONLY | (C.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) {
      throw new Error("Attestation identity changed.");
    }
    const bytes = fs.readFileSync(fd);
    if (bytes.byteLength > 64 * 1024) {
      throw new Error("Attestation exceeds size limit.");
    }
    const raw = bytes.toString("utf8");
    return { raw, attestation: UpdatePreviousBootAttestationSchema.parse(JSON.parse(raw)) };
  } finally {
    fs.closeSync(fd);
  }
}

/** Root-only attestation producer. The named prior boot is an operator assertion,
 * corroborated by persistent journal history; legacy bytes alone do not prove it. */
export function createUpdatePreviousBootAttestation(
  input: {
    operationId: string;
    oldBootId: string;
    serviceUid: number;
    serviceGid: number;
    paths: UpdatePreviousBootAttestationPaths;
  },
  overrides: Partial<System> = {},
): { path: string; attestation: UpdatePreviousBootAttestation; sha256: string } {
  const system = { ...defaults(), ...overrides };
  requireRootLinux(system);
  const oldBootId = input.oldBootId.toLowerCase();
  const currentBootId = system.readBootId().toLowerCase();
  if (!bootId.test(oldBootId) || !bootId.test(currentBootId) || oldBootId === currentBootId) {
    throw new Error("The explicitly identified old boot must differ from the current kernel boot.");
  }
  const history = new Set(system.readJournalBootIds().map((id) => id.toLowerCase()));
  for (const [name, id] of [
    ["old", oldBootId],
    ["current", currentBootId],
  ] as const) {
    if (!history.has(id)) {
      throw new Error(`${name} boot ID is absent from persistent journal history.`);
    }
  }
  if (
    !Number.isSafeInteger(input.serviceUid) ||
    input.serviceUid <= 0 ||
    !Number.isSafeInteger(input.serviceGid) ||
    input.serviceGid < 0
  ) {
    throw new Error("A concrete non-root Gateway service UID and GID are required.");
  }
  const attestation = UpdatePreviousBootAttestationSchema.parse({
    version: 1,
    operationId: input.operationId,
    oldBootId,
    currentBootId,
    issuerUid: 0,
    serviceUid: input.serviceUid,
    serviceGid: input.serviceGid,
    installRoot: path.resolve(input.paths.installRoot),
    anchorPath: path.resolve(input.paths.anchorPath),
    controlPath: path.resolve(input.paths.controlPath),
    anchorIdentity: directoryIdentity(input.paths.anchorPath, input.serviceUid),
    controlIdentity: directoryIdentity(input.paths.controlPath, input.serviceUid),
    journal: hashArtifact(input.paths.journalPath),
    helper: hashArtifact(input.paths.helperPath),
    archive: hashArtifact(input.paths.archivePath),
    serviceUnit: input.paths.serviceUnit,
    launchers: input.paths.launchers.map((item) => ({
      ...hashLauncher(item.path),
      argv0: path.resolve(item.argv0),
    })),
    issuedAtMs: system.now(),
    nonce: system.nonce(),
  });
  prepareDirectory(input.serviceGid);
  const raw = Buffer.from(JSON.stringify(attestation) + "\n");
  const name = `${attestation.operationId}-${attestation.nonce}.json`;
  const target = path.join(UPDATE_PREVIOUS_BOOT_ATTESTATION_DIR, name);
  const temp = path.join(UPDATE_PREVIOUS_BOOT_ATTESTATION_DIR, `.pending-${attestation.nonce}`);
  const fd = fs.openSync(temp, C.O_WRONLY | C.O_CREAT | C.O_EXCL | (C.O_NOFOLLOW ?? 0), 0o600);
  try {
    fs.fchownSync(fd, 0, input.serviceGid);
    fs.writeFileSync(fd, raw);
    fs.fsyncSync(fd);
    fs.fchmodSync(fd, 0o440);
  } catch (error) {
    fs.closeSync(fd);
    fs.unlinkSync(temp);
    throw error;
  }
  fs.closeSync(fd);
  try {
    fs.linkSync(temp, target);
    fs.unlinkSync(temp);
    const directoryFd = fs.openSync(UPDATE_PREVIOUS_BOOT_ATTESTATION_DIR, C.O_RDONLY);
    try {
      fs.fsyncSync(directoryFd);
    } finally {
      fs.closeSync(directoryFd);
    }
  } catch (error) {
    fs.unlinkSync(temp);
    throw error;
  }
  const saved = readAttestation(target, input.serviceGid);
  if (saved.raw !== raw.toString("utf8")) {
    throw new Error("Attestation read-back mismatch.");
  }
  return { path: target, attestation, sha256: createHash("sha256").update(raw).digest("hex") };
}

/** Revalidate root custody and all bound bytes on every resume. A mutable archive
 * location is acceptable only while its complete SHA-256 matches this receipt. */
export function assertUpdatePreviousBootAttestationBinding(
  attestation: UpdatePreviousBootAttestation,
  input: {
    expectedOperationId: string;
    expectedServiceUid: number;
    expectedServiceGid: number;
    expectedPaths: UpdatePreviousBootAttestationPaths;
  },
  currentBootId: string,
): void {
  if (
    attestation.operationId !== input.expectedOperationId ||
    attestation.serviceUid !== input.expectedServiceUid ||
    attestation.serviceGid !== input.expectedServiceGid ||
    attestation.currentBootId !== currentBootId.toLowerCase() ||
    attestation.oldBootId === attestation.currentBootId ||
    path.resolve(attestation.installRoot) !== path.resolve(input.expectedPaths.installRoot) ||
    path.resolve(attestation.anchorPath) !== path.resolve(input.expectedPaths.anchorPath) ||
    path.resolve(attestation.controlPath) !== path.resolve(input.expectedPaths.controlPath) ||
    attestation.serviceUnit !== input.expectedPaths.serviceUnit ||
    attestation.launchers.length !== input.expectedPaths.launchers.length ||
    attestation.launchers.some(
      (saved, index) =>
        saved.path !== path.resolve(input.expectedPaths.launchers[index]!.path) ||
        saved.argv0 !== path.resolve(input.expectedPaths.launchers[index]!.argv0),
    )
  ) {
    throw new Error(
      "Attestation does not match current operation, boot, service, launcher, or install identity.",
    );
  }
}

export function validateUpdatePreviousBootAttestation(
  input: {
    filename: string;
    expectedOperationId: string;
    expectedServiceUid: number;
    expectedServiceGid: number;
    expectedPaths: UpdatePreviousBootAttestationPaths;
  },
  overrides: Partial<System> = {},
): { attestation: UpdatePreviousBootAttestation; sha256: string } {
  const system = { ...defaults(), ...overrides };
  if (
    system.effectiveUid() !== input.expectedServiceUid ||
    process.getuid?.() !== input.expectedServiceUid
  ) {
    throw new Error("Attestation must be consumed by the exact non-root Gateway service UID.");
  }
  const { raw, attestation } = readAttestation(input.filename, input.expectedServiceGid);
  assertUpdatePreviousBootAttestationBinding(attestation, input, system.readBootId());
  assertDirectoryIdentity(
    input.expectedPaths.anchorEvidencePath ?? input.expectedPaths.anchorPath,
    attestation.anchorIdentity,
  );
  assertDirectoryIdentity(
    input.expectedPaths.controlEvidencePath ?? input.expectedPaths.controlPath,
    attestation.controlIdentity,
  );
  const evidence = [
    [hashArtifact(input.expectedPaths.journalPath), attestation.journal, true],
    [hashArtifact(input.expectedPaths.helperPath), attestation.helper, true],
    [hashArtifact(input.expectedPaths.archivePath), attestation.archive, false],
  ] as const;
  for (const [actual, expected, sameInode] of evidence) {
    const originalPath = actual.path === expected.path;
    const movedPath =
      input.expectedPaths.quarantineRoot !== undefined &&
      actual.path ===
        path.join(input.expectedPaths.quarantineRoot, "control", path.basename(expected.path));
    if (
      (!originalPath && !movedPath) ||
      actual.sha256 !== expected.sha256 ||
      actual.size !== expected.size ||
      (sameInode && (actual.dev !== expected.dev || actual.ino !== expected.ino))
    ) {
      throw new Error("Attested operation artifacts or archive changed after root attestation.");
    }
  }
  const launchers = input.expectedPaths.launchers.map((item) => ({
    ...hashLauncher(item.path),
    argv0: path.resolve(item.argv0),
  }));
  if (JSON.stringify(launchers) !== JSON.stringify(attestation.launchers)) {
    throw new Error("Attested launcher identity changed.");
  }
  return { attestation, sha256: createHash("sha256").update(raw).digest("hex") };
}
