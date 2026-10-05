import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { createVerifiedPackageEvidenceBackup } from "./package-update-evidence-backup.js";

const lifetime = createFixtureLifetime();
afterEach(async () => {
  await lifetime.cleanup();
  vi.restoreAllMocks();
});

async function fixture() {
  const base = lifetime.createTempDir("package-evidence-backup-");
  const sourceParent = path.join(base, "source-parent");
  const backupParent = path.join(base, "backup-parent");
  await fsp.mkdir(sourceParent, { mode: 0o700 });
  await fsp.mkdir(backupParent, { mode: 0o700 });
  const source = path.join(sourceParent, "anchor");
  await fsp.mkdir(source, { mode: 0o700 });
  await fsp.mkdir(path.join(source, "previous"), { mode: 0o700 });
  await fsp.writeFile(path.join(source, "previous", "package.json"), '{"version":"1.0.0"}\n');
  await fsp.writeFile(path.join(source, "previous", "payload.js"), "payload\n");
  await fsp.link(
    path.join(source, "previous", "payload.js"),
    path.join(source, "previous", "payload-link.js"),
  );
  await fsp.symlink("payload.js", path.join(source, "previous", "inside-link"));
  await fsp.symlink("../../outside-launcher-target", path.join(source, "openclaw"));
  return {
    base,
    source,
    backupParent,
    externalLinks: { openclaw: "../../outside-launcher-target" },
  };
}

it("creates a verified archive and independent extraction while preserving source inode/content and links", async () => {
  const f = await fixture();
  const sourceBefore = fs.lstatSync(f.source, { bigint: true });
  const fileBefore = fs.lstatSync(path.join(f.source, "previous", "payload.js"), { bigint: true });
  const result = await createVerifiedPackageEvidenceBackup({
    sourceRoot: f.source,
    backupParent: f.backupParent,
    operationId: randomUUID(),
    allowedExternalSymlinks: f.externalLinks,
  });
  expect(fs.lstatSync(f.source, { bigint: true }).ino).toBe(sourceBefore.ino);
  expect(fs.lstatSync(path.join(f.source, "previous", "payload.js"), { bigint: true }).ino).toBe(
    fileBefore.ino,
  );
  expect(fs.readFileSync(path.join(f.source, "previous", "payload.js"), "utf8")).toBe("payload\n");
  expect(fs.lstatSync(path.join(f.source, "previous", "payload.js"), { bigint: true }).nlink).toBe(
    2n,
  );
  expect(fs.readlinkSync(path.join(f.source, "openclaw"))).toBe(f.externalLinks.openclaw);
  const extracted = path.join(result.verificationRoot, "anchor");
  expect(fs.readFileSync(path.join(extracted, "previous", "payload.js"), "utf8")).toBe("payload\n");
  expect(fs.lstatSync(path.join(extracted, "previous", "payload.js"), { bigint: true }).ino).toBe(
    fs.lstatSync(path.join(extracted, "previous", "payload-link.js"), { bigint: true }).ino,
  );
  expect(fs.readlinkSync(path.join(extracted, "previous", "inside-link"))).toBe("payload.js");
  expect(fs.readlinkSync(path.join(extracted, "openclaw"))).toBe(f.externalLinks.openclaw);
  expect(fs.existsSync(path.join(result.verificationRoot, "outside-launcher-target"))).toBe(false);
  expect(result.portableInventory).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        path: "previous/payload.js",
        kind: "file",
        hardlinkGroup: "previous/payload-link.js",
      }),
      expect.objectContaining({
        path: "openclaw",
        kind: "symlink",
        target: f.externalLinks.openclaw,
      }),
    ]),
  );
  expect(fs.statSync(result.archivePath).mode & 0o777).toBe(0o600);
  expect(fs.statSync(path.dirname(result.archivePath)).mode & 0o077).toBe(0);
});

it("rejects an outbound symlink unless its exact source target is explicitly allowed", async () => {
  const f = await fixture();
  await expect(
    createVerifiedPackageEvidenceBackup({
      sourceRoot: f.source,
      backupParent: f.backupParent,
      operationId: randomUUID(),
    }),
  ).rejects.toThrow("outbound symbolic link");
  expect(fs.existsSync(path.join(f.source, "previous", "payload.js"))).toBe(true);
});

it("rejects source changes during the backup and leaves original source entries intact", async () => {
  const f = await fixture();
  let changed = false;
  let assertions = 0;
  await expect(
    createVerifiedPackageEvidenceBackup({
      sourceRoot: f.source,
      backupParent: f.backupParent,
      operationId: randomUUID(),
      allowedExternalSymlinks: f.externalLinks,
      assertCurrent() {
        assertions += 1;
        if (!changed && assertions === 3) {
          changed = true;
          fs.writeFileSync(path.join(f.source, "previous", "payload.js"), "changed\n");
        }
      },
    }),
  ).rejects.toThrow();
  expect(fs.readFileSync(path.join(f.source, "previous", "payload.js"), "utf8")).toBe("changed\n");
  expect(fs.existsSync(path.join(f.source, "previous", "package.json"))).toBe(true);
});

it("preserves source if archive creation fails and retains private failure evidence", async () => {
  const f = await fixture();
  let assertions = 0;
  await expect(
    createVerifiedPackageEvidenceBackup({
      sourceRoot: f.source,
      backupParent: f.backupParent,
      operationId: randomUUID(),
      allowedExternalSymlinks: f.externalLinks,
      assertCurrent() {
        assertions += 1;
        if (assertions === 3) {
          throw new Error("injected failure after archive sync");
        }
      },
    }),
  ).rejects.toThrow("injected failure after archive sync");
  expect(fs.readFileSync(path.join(f.source, "previous", "payload.js"), "utf8")).toBe("payload\n");
  const staging = fs.readdirSync(f.backupParent);
  expect(staging.some((name) => name.startsWith(".openclaw-package-evidence-"))).toBe(true);
});
