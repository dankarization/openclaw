import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withUpdateCommandExecutor } from "../cli/update-cli/update-command-executor.js";
import {
  openPackageActivationJournal,
  resolvePackageActivationHelper,
} from "./package-update-activation-journal.js";
import { createPackageActivationLifetimeFixture } from "./package-update-activation-lifetime.test-support.js";
import {
  assertNoPendingPackageActivation,
  runPackageActivationRecovery,
} from "./package-update-activation.js";
import { createPublicationOwner } from "./package-update-publication-owner.js";

const fixtures = createPackageActivationLifetimeFixture();
let base: string;
beforeEach(() => {
  ({ root: base } = fixtures.setup());
});
afterEach(async () => {
  try {
    await fixtures.lifetime.cleanup();
  } finally {
    vi.restoreAllMocks();
  }
});
const acknowledgement = "discard-altered-previous-after-verified-backup" as const;

async function published() {
  const f = await fixtures.prepare();
  const journal = openPackageActivationJournal(f.anchor);
  const initial = journal.read();
  await withUpdateCommandExecutor(
    randomUUID(),
    async (executor) => {
      const fence = await executor.enter(f.packageRoot);
      await createPublicationOwner(f.anchor, journal, fence.assertCurrent).publish(false);
    },
    { existingAuthority: initial.descriptor.authority },
  );
  const previous = path.join(f.anchor, "previous");
  const oldFile = path.join(previous, "package.json");
  const mode = fs.statSync(oldFile).mode & 0o777;
  await fsp.chmod(oldFile, mode ^ 0o100);
  await fsp.chmod(oldFile, mode);
  const backupParent = path.join(base, "evidence-backups");
  await fsp.mkdir(backupParent, { mode: 0o700 });
  return { ...f, previous, oldFile, backupParent };
}

function altered(f: Awaited<ReturnType<typeof published>>) {
  return runPackageActivationRecovery(f.anchor, "retire-altered-previous", f.operationId, {
    acknowledgement,
    backupParent: f.backupParent,
  });
}

function expectUnretired(f: Awaited<ReturnType<typeof published>>) {
  expect(openPackageActivationJournal(f.anchor).read().phase).toBe("publication-complete");
  expect(fs.existsSync(f.previous)).toBe(true);
  expect(fs.existsSync(resolvePackageActivationHelper(f.anchor))).toBe(true);
}

describe.skipIf(process.platform === "win32")("acknowledged altered rollback retirement", () => {
  it("preserves strict ordinary recovery, backs up the altered inode, and emits the existing completion receipt", async () => {
    const f = await published();
    const journal = openPackageActivationJournal(f.anchor);
    const original = journal.read();
    const helper = fs.readFileSync(resolvePackageActivationHelper(f.anchor));
    const previousBytes = fs.readFileSync(f.oldFile);
    await expect(runPackageActivationRecovery(f.anchor, "repair", f.operationId)).rejects.toThrow(
      "publication object changed",
    );
    await expect(runPackageActivationRecovery(f.anchor, "retire", f.operationId)).rejects.toThrow(
      "publication object changed",
    );
    expectUnretired(f);
    expect(fs.readdirSync(f.backupParent)).toEqual([]);
    const result = await altered(f);
    expect(result).toMatchObject({ phase: "complete", operationId: f.operationId });
    const backups = fs.readdirSync(f.backupParent);
    expect(backups).toHaveLength(1);
    const backupDir = path.join(f.backupParent, backups[0]!);
    const receipt = JSON.parse(fs.readFileSync(path.join(backupDir, "receipt.json"), "utf8"));
    expect(fs.readFileSync(receipt.archivePath).length).toBeGreaterThan(0);
    expect(
      fs.readFileSync(
        path.join(receipt.verificationRoot, path.basename(f.anchor), "previous", "package.json"),
      ),
    ).toEqual(previousBytes);
    expect(fs.readFileSync(path.join(backupDir, "original-recovery.mjs"))).toEqual(helper);
    expect(
      JSON.parse(fs.readFileSync(path.join(backupDir, "original-operation.json"), "utf8")),
    ).toEqual(original);
    expect(journal.read().descriptor).toEqual(original.descriptor);
    expect(journal.read().intent).toMatchObject({ kind: "unlink-helper", selected: "candidate" });
    expect(fs.existsSync(f.anchor)).toBe(false);
    expect(() => assertNoPendingPackageActivation(f.packageRoot)).not.toThrow();
    expect(
      JSON.parse(fs.readFileSync(path.join(f.packageRoot, "package.json"), "utf8")).version,
    ).toBe("2.0.0");
  });

  it("requires acknowledgement and the exact recorded operation before starting a backup", async () => {
    const f = await published();
    await expect(
      runPackageActivationRecovery(f.anchor, "retire-altered-previous", f.operationId),
    ).rejects.toThrow("acknowledgement");
    await expect(
      runPackageActivationRecovery(f.anchor, "retire-altered-previous", randomUUID(), {
        acknowledgement,
        backupParent: f.backupParent,
      }),
    ).rejects.toThrow("different operation");
    expectUnretired(f);
    expect(fs.readdirSync(f.backupParent)).toEqual([]);
  });

  it.each(["candidate", "launcher", "helper", "inventory", "previous-identity"] as const)(
    "refuses %s drift without an archive or retirement intent",
    async (kind) => {
      const f = await published();
      if (kind === "candidate") {
        await fsp.appendFile(path.join(f.packageRoot, "package.json"), " ");
      } else if (kind === "launcher") {
        await fsp.appendFile(f.launcher, "foreign\n");
      } else if (kind === "helper") {
        await fsp.appendFile(resolvePackageActivationHelper(f.anchor), "foreign\n");
      } else if (kind === "inventory") {
        await fsp.mkdir(path.join(f.anchor, "foreign"));
      } else {
        await fsp.rename(f.previous, f.previous + ".foreign");
        await fsp.mkdir(f.previous);
      }
      await expect(altered(f)).rejects.toThrow();
      expect(openPackageActivationJournal(f.anchor).read().phase).toBe("publication-complete");
      expect(fs.existsSync(resolvePackageActivationHelper(f.anchor))).toBe(true);
      expect(fs.readdirSync(f.backupParent)).toEqual([]);
    },
  );

  it("leaves the journal and original objects intact when backup creation fails", async () => {
    const f = await published();
    const bytes = fs.readFileSync(f.oldFile);
    await fsp.chmod(f.backupParent, 0o777);
    await expect(altered(f)).rejects.toThrow("not writable by others");
    expectUnretired(f);
    expect(fs.readFileSync(f.oldFile)).toEqual(bytes);
  });

  it("resumes through the ordinary sealed-helper contract after the existing removal intent", async () => {
    const f = await published();
    const removeDirectory = fsp.rmdir.bind(fsp);
    const failure = new Error("injected lost anchor-removal acknowledgement");
    const cut = vi.spyOn(fsp, "rmdir").mockImplementation(async (file, ...args) => {
      if (file === f.anchor) {
        throw failure;
      }
      return removeDirectory(file, ...args);
    });
    await expect(altered(f)).rejects.toThrow(failure.message);
    cut.mockRestore();
    const record = openPackageActivationJournal(f.anchor).read();
    expect(record.phase).toBe("retiring");
    expect(record.intent).toMatchObject({ kind: "remove-anchor", selected: "candidate" });
    expect(fs.existsSync(f.previous)).toBe(false);
    const backupDir = path.join(f.backupParent, fs.readdirSync(f.backupParent)[0]!);
    expect(fs.existsSync(path.join(backupDir, "original-recovery.mjs"))).toBe(true);
    await expect(
      runPackageActivationRecovery(f.anchor, "retire", f.operationId),
    ).resolves.toMatchObject({ phase: "complete" });
    expect(fs.existsSync(path.join(backupDir, "evidence.tar.gz"))).toBe(true);
    expect(() => assertNoPendingPackageActivation(f.packageRoot)).not.toThrow();
  });
});
