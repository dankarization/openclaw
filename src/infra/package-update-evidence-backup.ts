import { createHash, randomUUID } from "node:crypto";
import { constants, createWriteStream, type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import * as tar from "tar";
import { requireDirectorySync, syncDirectory } from "./directory-durability.js";
import {
  createPackageIntegrityReader,
  type PackageIntegrityFingerprint,
} from "./package-update-integrity.js";
import { UPDATE_RUNNER_TIMEOUT_MS } from "./update-run-timeouts.js";

const MAX_ENTRIES = 50_000;
const MAX_BYTES = 1024 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = MAX_BYTES + 64 * 1024 * 1024;
const MAX_PATH_COMPONENTS = 256;

export type PackageEvidenceInventoryEntry = {
  path: string;
  kind: "directory" | "file" | "symlink";
  mode: number;
  uid: number;
  gid: number;
  size: number;
  digest?: string;
  target?: string;
  hardlinkGroup?: string;
};

export type PackageEvidenceBackupReceipt = {
  format: "openclaw-package-evidence-backup-v1";
  operationId: string;
  sourceRoot: string;
  archivePath: string;
  verificationRoot: string;
  archiveSha256: string;
  sourceFingerprintBefore?: PackageIntegrityFingerprint;
  sourceFingerprintAfter?: PackageIntegrityFingerprint;
  portableInventory: PackageEvidenceInventoryEntry[];
  verifiedAt: string;
};

type TarMember = { path: string; type: string; linkpath?: string; size?: number };

function inside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
}

function snapshot(stat: BigIntStats): string {
  return [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.uid,
    stat.gid,
    stat.nlink,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
  ]
    .map(String)
    .join("/");
}

function portableStat(stat: BigIntStats) {
  return {
    mode: Number(stat.mode & 0o7777n),
    uid: Number(stat.uid),
    gid: Number(stat.gid),
  };
}

async function hashFile(file: string, expected: BigIntStats): Promise<string> {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await fs.open(file, constants.O_RDONLY | noFollow | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || snapshot(opened) !== snapshot(expected)) {
      throw new Error("Evidence file identity changed before reading: " + file);
    }
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += (chunk as Buffer).byteLength;
      if (size > MAX_BYTES) {
        throw new Error("Evidence backup byte limit exceeded.");
      }
      hash.update(chunk as Buffer);
    }
    const after = await handle.stat({ bigint: true });
    if (size !== Number(expected.size) || snapshot(after) !== snapshot(expected)) {
      throw new Error("Evidence file changed while reading: " + file);
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

function safeRelative(raw: string): string {
  if (
    !raw ||
    raw.includes("\\") ||
    raw.includes("\0") ||
    path.posix.isAbsolute(raw) ||
    /^[A-Za-z]:/u.test(raw)
  ) {
    throw new Error("Evidence contains an absolute or non-portable path.");
  }
  const value = raw.endsWith("/") ? raw.slice(0, -1) : raw;
  const parts = value.split("/");
  if (
    !value ||
    parts.length > MAX_PATH_COMPONENTS ||
    parts.some((p) => !p || p === "." || p === ".." || p.length > 255)
  ) {
    throw new Error("Evidence contains an unsafe path: " + raw);
  }
  return parts.join("/");
}

function safeLink(member: string, target: string): void {
  if (
    !target ||
    target.includes("\\") ||
    target.includes("\0") ||
    path.posix.isAbsolute(target) ||
    /^[A-Za-z]:/u.test(target)
  ) {
    throw new Error("Evidence contains an absolute or non-portable link target: " + member);
  }
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(member), target));
  if (resolved === ".." || resolved.startsWith("../") || resolved.startsWith("/")) {
    throw new Error("Evidence contains an outbound symbolic link: " + member);
  }
  let descended = false;
  for (const segment of target.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === ".." && descended) {
      throw new Error("Evidence contains ambiguous symbolic-link traversal: " + member);
    }
    descended ||= segment !== "..";
  }
}

type Inventory = { portable: PackageEvidenceInventoryEntry[]; observations: Map<string, string> };

async function inventory(
  root: string,
  allowedExternalSymlinks: ReadonlyMap<string, string>,
): Promise<Inventory> {
  const rootStat = await fs.lstat(root, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.ino === 0n) {
    throw new Error("Evidence source must be a retained directory.");
  }
  const portable: PackageEvidenceInventoryEntry[] = [];
  const observations = new Map<string, string>();
  const hardlinks = new Map<string, string[]>();
  let entries = 0;
  let bytes = 0;
  const walk = async (directory: string, prefix: string): Promise<void> => {
    const before = await fs.lstat(directory, { bigint: true });
    const beforeFingerprint = snapshot(before);
    const names = (await fs.readdir(directory)).toSorted();
    for (const name of names) {
      const relative = prefix ? prefix + "/" + name : name;
      safeRelative(relative);
      const file = path.join(directory, name);
      const stat = await fs.lstat(file, { bigint: true });
      observations.set(file, snapshot(stat));
      entries += 1;
      if (entries > MAX_ENTRIES) {
        throw new Error("Evidence backup entry limit exceeded.");
      }
      const common = portableStat(stat);
      if (stat.isSymbolicLink()) {
        const target = await fs.readlink(file);
        if (allowedExternalSymlinks.get(relative) !== target) {
          safeLink(relative, target);
        }
        const after = await fs.lstat(file, { bigint: true });
        if (snapshot(after) !== snapshot(stat)) {
          throw new Error("Evidence symlink changed during inventory.");
        }
        portable.push({ path: relative, kind: "symlink", ...common, size: 0, target });
      } else if (stat.isDirectory()) {
        portable.push({ path: relative, kind: "directory", ...common, size: 0 });
        await walk(file, relative);
      } else if (stat.isFile()) {
        bytes += Number(stat.size);
        if (!Number.isSafeInteger(bytes) || bytes > MAX_BYTES) {
          throw new Error("Evidence backup byte limit exceeded.");
        }
        const key = stat.dev.toString() + ":" + stat.ino.toString();
        if (stat.nlink > 1n) {
          const group = hardlinks.get(key) ?? [];
          group.push(relative);
          hardlinks.set(key, group);
        }
        const digest = await hashFile(file, stat);
        portable.push({ path: relative, kind: "file", ...common, size: Number(stat.size), digest });
      } else {
        throw new Error("Evidence backup refuses unsupported filesystem object: " + relative);
      }
    }
    const after = await fs.lstat(directory, { bigint: true });
    if (snapshot(after) !== beforeFingerprint) {
      throw new Error("Evidence directory changed during inventory.");
    }
    observations.set(directory, beforeFingerprint);
  };
  await walk(root, "");
  for (const [file, expected] of observations) {
    const current = await fs.lstat(file, { bigint: true });
    if (snapshot(current) !== expected) {
      throw new Error("Evidence source changed during inventory: " + file);
    }
  }
  const groups = new Map<string, string>();
  for (const members of hardlinks.values()) {
    if (members.length > 1) {
      for (const member of members) {
        groups.set(member, members[0]!);
      }
    }
  }
  for (const row of portable) {
    const group = groups.get(row.path);
    if (group) {
      row.hardlinkGroup = group;
    }
  }
  return { portable, observations };
}

async function syncFile(file: string): Promise<void> {
  const handle = await fs.open(file, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncTree(root: string): Promise<void> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const file = path.join(root, entry.name);
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) {
      continue;
    }
    if (stat.isDirectory()) {
      await syncTree(file);
    } else if (stat.isFile()) {
      await syncFile(file);
    } else {
      throw new Error("Verification tree contains an unsupported object: " + file);
    }
  }
  requireDirectorySync(await syncDirectory(root), "Evidence verification directory");
}

async function listAndValidateTar(
  archive: string,
  rootName: string,
  allowedExternalSymlinks: ReadonlyMap<string, string>,
): Promise<TarMember[]> {
  const members: TarMember[] = [];
  let listedBytes = 0;
  await tar.t({
    file: archive,
    strict: true,
    onentry(entry) {
      if (members.length >= MAX_ENTRIES) {
        throw new Error("Evidence archive entry limit exceeded.");
      }
      listedBytes += entry.size ?? 0;
      if (!Number.isSafeInteger(listedBytes) || listedBytes > MAX_BYTES) {
        throw new Error("Evidence archive byte limit exceeded.");
      }
      members.push({
        path: entry.path,
        type: entry.type,
        linkpath: entry.linkpath,
        size: entry.size,
      });
    },
  });
  const byPath = new Map<string, TarMember>();
  let bytes = 0;
  for (const entry of members) {
    const memberPath = safeRelative(entry.path);
    if (byPath.has(memberPath)) {
      throw new Error("Evidence archive contains duplicate path: " + memberPath);
    }
    if (entry.type === "File" || entry.type === "OldFile") {
      const size = entry.size ?? 0;
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_BYTES) {
        throw new Error("Evidence archive file size is invalid.");
      }
      bytes += size;
      if (bytes > MAX_BYTES) {
        throw new Error("Evidence archive byte limit exceeded.");
      }
    } else if (entry.type === "Directory") {
      // Accepted directory.
    } else if (entry.type === "SymbolicLink") {
      const target = entry.linkpath ?? "";
      const sourceRelative = memberPath.startsWith(rootName + "/")
        ? memberPath.slice(rootName.length + 1)
        : memberPath;
      if (allowedExternalSymlinks.get(sourceRelative) !== target) {
        safeLink(memberPath, target);
      }
    } else if (entry.type === "Link") {
      const target = safeRelative(entry.linkpath ?? "");
      const prior = byPath.get(target);
      if (!prior || (prior.type !== "File" && prior.type !== "OldFile")) {
        throw new Error("Evidence hard link must target a prior regular file.");
      }
    } else {
      throw new Error("Evidence archive contains unsupported entry type: " + entry.type);
    }
    byPath.set(memberPath, entry);
    if (byPath.size > MAX_ENTRIES) {
      throw new Error("Evidence archive entry limit exceeded.");
    }
  }
  if (members.length === 0) {
    throw new Error("Evidence archive is empty.");
  }
  for (const member of byPath.keys()) {
    const parts = member.split("/");
    for (let i = 1; i < parts.length; i += 1) {
      const ancestor = byPath.get(parts.slice(0, i).join("/"));
      if (ancestor && ancestor.type !== "Directory") {
        throw new Error("Evidence archive places a child under a non-directory: " + member);
      }
    }
  }
  return members;
}

export async function createVerifiedPackageEvidenceBackup(params: {
  sourceRoot: string;
  backupParent: string;
  operationId: string;
  protectedPackageRoot?: string;
  protectedLogicalRoot?: string;
  allowedExternalSymlinks?: Readonly<Record<string, string>>;
  assertCurrent?: () => void;
}): Promise<PackageEvidenceBackupReceipt> {
  const sourceRoot = path.resolve(params.sourceRoot);
  const backupParent = path.resolve(params.backupParent);
  if (sourceRoot !== params.sourceRoot || backupParent !== params.backupParent) {
    throw new Error("Evidence paths must be absolute and canonical.");
  }
  if (!/^[0-9a-f-]{36}$/iu.test(params.operationId)) {
    throw new Error("Evidence operation id is invalid.");
  }
  const [sourceReal, parentReal] = await Promise.all([
    fs.realpath(sourceRoot),
    fs.realpath(backupParent),
  ]);
  if (sourceReal !== sourceRoot || parentReal !== backupParent) {
    throw new Error("Evidence paths must not traverse symbolic links.");
  }
  const sourceStat = await fs.lstat(sourceRoot, { bigint: true });
  const parentStat = await fs.lstat(backupParent, { bigint: true });
  if (
    !sourceStat.isDirectory() ||
    sourceStat.isSymbolicLink() ||
    !parentStat.isDirectory() ||
    parentStat.isSymbolicLink()
  ) {
    throw new Error("Evidence source and parent must be physical directories.");
  }
  if (parentStat.uid !== BigInt(process.getuid?.() ?? -1) || (parentStat.mode & 0o022n) !== 0n) {
    throw new Error(
      "Evidence parent must be owned by the current user and not writable by others.",
    );
  }
  if (inside(sourceRoot, backupParent) || inside(backupParent, sourceRoot)) {
    throw new Error("Evidence source and backup parent must be disjoint.");
  }
  const protectedRoot = path.resolve(params.protectedPackageRoot ?? sourceRoot);
  const protectedLogicalRoot = path.resolve(params.protectedLogicalRoot ?? protectedRoot);
  if (
    protectedRoot !== (params.protectedPackageRoot ?? sourceRoot) ||
    !inside(sourceRoot, protectedRoot)
  ) {
    throw new Error(
      "Protected package root must be a canonical descendant of the evidence source.",
    );
  }
  const allowedExternalSymlinks = new Map(Object.entries(params.allowedExternalSymlinks ?? {}));
  const name = "openclaw-package-evidence-" + params.operationId + "-" + randomUUID();
  const stage = await fs.mkdtemp(path.join(backupParent, "." + name + "-"));
  await fs.chmod(stage, 0o700);
  const stageStat = await fs.lstat(stage, { bigint: true });
  if (
    !stageStat.isDirectory() ||
    stageStat.isSymbolicLink() ||
    stageStat.uid !== parentStat.uid ||
    (stageStat.mode & 0o077n) !== 0n
  ) {
    throw new Error("Evidence staging directory has unsafe identity or permissions.");
  }
  const tempArchive = path.join(stage, "evidence.partial.tar.gz");
  const archivePath = path.join(stage, "evidence.tar.gz");
  const verificationRoot = path.join(stage, "verified");
  const reader = createPackageIntegrityReader(UPDATE_RUNNER_TIMEOUT_MS);
  const sourceFingerprintBefore = params.protectedPackageRoot
    ? await reader.tree(protectedRoot, protectedLogicalRoot)
    : undefined;
  try {
    params.assertCurrent?.();
    const sourceInventory = await inventory(sourceRoot, allowedExternalSymlinks);
    params.assertCurrent?.();
    let archiveBytes = 0;
    const deadline = AbortSignal.timeout(UPDATE_RUNNER_TIMEOUT_MS);
    const byteLimit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        archiveBytes += chunk.length;
        callback(
          archiveBytes > MAX_ARCHIVE_BYTES
            ? new Error("Evidence archive byte limit exceeded while writing.")
            : null,
          chunk,
        );
      },
    });
    await pipeline(
      Readable.from(
        tar.c(
          {
            cwd: path.dirname(sourceRoot),
            gzip: false,
            // tar 7.5.22 can emit EOF twice while resolving concurrent hard links.
            // Serial entry preparation preserves topology without late producer errors.
            jobs: 1,
            portable: false,
            preservePaths: false,
            strict: true,
          },
          [path.basename(sourceRoot)],
        ),
      ),
      createGzip(),
      byteLimit,
      createWriteStream(tempArchive, { flags: "wx", mode: 0o600 }),
      { signal: deadline },
    );
    const archiveStat = await fs.lstat(tempArchive, { bigint: true });
    if (
      !archiveStat.isFile() ||
      archiveStat.isSymbolicLink() ||
      archiveStat.size > MAX_ARCHIVE_BYTES
    ) {
      throw new Error("Evidence archive is unsafe or exceeds its size limit.");
    }
    await syncFile(tempArchive);
    params.assertCurrent?.();

    const initialArchiveHash = await hashFile(tempArchive, archiveStat);
    const assertArchive = async () => {
      const current = await fs.lstat(tempArchive, { bigint: true });
      if (
        snapshot(current) !== snapshot(archiveStat) ||
        (await hashFile(tempArchive, archiveStat)) !== initialArchiveHash
      ) {
        throw new Error("Evidence archive identity or contents changed during verification.");
      }
      params.assertCurrent?.();
    };
    const rootName = path.basename(sourceRoot);
    const tarMembers = await listAndValidateTar(tempArchive, rootName, allowedExternalSymlinks);
    await assertArchive();
    const roots = tarMembers.filter((entry) => safeRelative(entry.path) === rootName);
    if (roots.length !== 1 || roots[0]!.type !== "Directory") {
      throw new Error("Evidence archive must contain exactly the source root directory.");
    }
    const expectedPaths = new Set(sourceInventory.portable.map((entry) => entry.path));
    const archivedPaths = new Set<string>();
    for (const entry of tarMembers) {
      const member = safeRelative(entry.path);
      if (member === rootName) {
        continue;
      }
      if (!member.startsWith(rootName + "/")) {
        throw new Error("Evidence archive contains a foreign root.");
      }
      archivedPaths.add(member.slice(rootName.length + 1));
    }
    for (const entry of expectedPaths) {
      if (!archivedPaths.has(entry)) {
        throw new Error("Evidence archive omitted source path: " + entry);
      }
    }
    if ([...archivedPaths].some((entry) => !expectedPaths.has(entry))) {
      throw new Error("Evidence archive contains a path absent from the source inventory.");
    }

    await fs.mkdir(verificationRoot, { mode: 0o700 });
    const externalLinkPaths = new Set(
      tarMembers
        .filter((entry) => entry.type === "SymbolicLink")
        .filter(
          (entry) =>
            allowedExternalSymlinks.get(safeRelative(entry.path).slice(rootName.length + 1)) ===
            entry.linkpath,
        )
        .map((entry) => safeRelative(entry.path)),
    );
    await assertArchive();
    await tar.x({
      file: tempArchive,
      cwd: verificationRoot,
      strict: true,
      preservePaths: false,
      keep: false,
      filter(memberPath) {
        const normalized = safeRelative(memberPath);
        return !externalLinkPaths.has(normalized);
      },
    });
    await assertArchive();
    const extractedRoot = path.join(verificationRoot, path.basename(sourceRoot));
    // External launcher links are restored as opaque link text only after tar extraction;
    // no archive path may descend through one, as checked by listAndValidateTar.
    for (const [relative, target] of allowedExternalSymlinks) {
      if (!expectedPaths.has(relative)) {
        continue;
      }
      const destination = path.join(extractedRoot, ...safeRelative(relative).split("/"));
      await fs.symlink(target, destination);
    }
    const extractedInventory = await inventory(extractedRoot, allowedExternalSymlinks);
    const sourceInventoryAfter = await inventory(sourceRoot, allowedExternalSymlinks);
    const sourceFingerprintAfter = params.protectedPackageRoot
      ? await reader.tree(protectedRoot, protectedLogicalRoot)
      : undefined;
    if (
      JSON.stringify(sourceInventory.portable) !== JSON.stringify(sourceInventoryAfter.portable) ||
      JSON.stringify(sourceInventory.portable) !== JSON.stringify(extractedInventory.portable) ||
      (params.protectedPackageRoot &&
        JSON.stringify(sourceFingerprintBefore) !== JSON.stringify(sourceFingerprintAfter))
    ) {
      throw new Error(
        "Evidence backup failed inventory/fingerprint verification or source changed.",
      );
    }

    await assertArchive();
    const archiveHash = initialArchiveHash;
    await fs.rename(tempArchive, archivePath);
    await syncFile(archivePath);
    await syncTree(verificationRoot);
    const publishedArchive = await fs.lstat(archivePath, { bigint: true });
    if (
      !publishedArchive.isFile() ||
      publishedArchive.isSymbolicLink() ||
      publishedArchive.dev !== archiveStat.dev ||
      publishedArchive.ino !== archiveStat.ino ||
      publishedArchive.size !== archiveStat.size ||
      (await hashFile(archivePath, publishedArchive)) !== initialArchiveHash
    ) {
      throw new Error("Published evidence archive changed before its verified receipt.");
    }
    params.assertCurrent?.();
    const receipt: PackageEvidenceBackupReceipt = {
      format: "openclaw-package-evidence-backup-v1",
      operationId: params.operationId,
      sourceRoot,
      archivePath,
      verificationRoot,
      archiveSha256: archiveHash,
      sourceFingerprintBefore,
      sourceFingerprintAfter,
      portableInventory: sourceInventory.portable,
      verifiedAt: new Date().toISOString(),
    };
    await fs.writeFile(path.join(stage, "receipt.json"), JSON.stringify(receipt, null, 2), {
      flag: "wx",
      mode: 0o600,
    });
    await syncFile(path.join(stage, "receipt.json"));
    requireDirectorySync(await syncDirectory(stage), "Evidence backup directory");
    params.assertCurrent?.();
    requireDirectorySync(await syncDirectory(backupParent), "Evidence backup parent");
    return receipt;
  } catch (error) {
    throw new Error(
      `Evidence backup failed (${error instanceof Error ? error.message : String(error)}); source preserved, incomplete evidence retained at ${stage}.`,
      { cause: error },
    );
  }
}
