import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, expect, it } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { createVerifiedPackageEvidenceBackup } from "./package-update-evidence-backup.js";

const lifetime = createFixtureLifetime();
afterEach(async () => {
  await lifetime.cleanup();
});

function tarArchive(
  entries: Array<{ path: string; type?: string; data?: string; link?: string }>,
): Buffer {
  const blocks: Buffer[] = [];
  for (const item of entries) {
    const header = Buffer.alloc(512);
    const write = (offset: number, length: number, value: string) => {
      const bytes = Buffer.from(value);
      if (bytes.length > length) {
        throw new Error("test tar field too long");
      }
      bytes.copy(header, offset);
    };
    const octal = (offset: number, length: number, value: number) => {
      write(offset, length, value.toString(8).padStart(length - 1, "0") + "\0");
    };
    write(0, 100, item.path);
    octal(100, 8, 0o600);
    octal(108, 8, 0);
    octal(116, 8, 0);
    const data = Buffer.from(item.data ?? "");
    octal(124, 12, data.length);
    octal(136, 12, 1);
    header.fill(0x20, 148, 156);
    header[156] = (item.type ?? "0").charCodeAt(0);
    write(157, 100, item.link ?? "");
    write(257, 6, "ustar\0");
    write(263, 2, "00");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    write(148, 8, checksum.toString(8).padStart(6, "0") + "\0 ");
    blocks.push(header);
    if (data.length) {
      blocks.push(data);
      const padding = (512 - (data.length % 512)) % 512;
      if (padding) {
        blocks.push(Buffer.alloc(padding));
      }
    }
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

async function fixture() {
  const base = lifetime.createTempDir("package-evidence-header-");
  const sourceParent = path.join(base, "source-parent");
  const backupParent = path.join(base, "backup-parent");
  await fsp.mkdir(sourceParent, { mode: 0o700 });
  await fsp.mkdir(backupParent, { mode: 0o700 });
  const source = path.join(sourceParent, "anchor");
  await fsp.mkdir(source, { mode: 0o700 });
  await fsp.mkdir(path.join(source, "previous"), { mode: 0o700 });
  await fsp.writeFile(path.join(source, "previous", "package.json"), "{}\n");
  return { source, backupParent };
}

async function replaceArchiveAfterSync(
  source: string,
  backupParent: string,
  archive: Buffer,
): Promise<void> {
  let checks = 0;
  await expect(
    createVerifiedPackageEvidenceBackup({
      sourceRoot: source,
      backupParent,
      operationId: randomUUID(),
      assertCurrent() {
        checks += 1;
        if (checks !== 3) {
          return;
        }
        const stage = fs
          .readdirSync(backupParent)
          .find((name) => name.startsWith(".openclaw-package-evidence-"));
        if (!stage) {
          throw new Error("test could not find evidence stage");
        }
        fs.writeFileSync(path.join(backupParent, stage, "evidence.partial.tar.gz"), archive);
      },
    }),
  ).rejects.toThrow();
  expect(checks).toBeGreaterThanOrEqual(3);
}

it("rejects traversal paths in a validly checksummed archive before extraction", async () => {
  const f = await fixture();
  const archive = tarArchive([
    { path: "anchor", type: "5" },
    { path: "anchor/../escape", data: "bad" },
  ]);
  await replaceArchiveAfterSync(f.source, f.backupParent, archive);
  expect(fs.existsSync(path.join(path.dirname(f.source), "escape"))).toBe(false);
});

it("rejects duplicate paths in an archive before extraction", async () => {
  const f = await fixture();
  const archive = tarArchive([
    { path: "anchor", type: "5" },
    { path: "anchor/previous", type: "5" },
    { path: "anchor/previous/package.json", data: "{}\n" },
    { path: "anchor/previous/package.json", data: "overwrite\n" },
  ]);
  await replaceArchiveAfterSync(f.source, f.backupParent, archive);
  expect(fs.readFileSync(path.join(f.source, "previous", "package.json"), "utf8")).toBe("{}\n");
});

it("rejects an archive entry beneath a symbolic-link ancestor", async () => {
  const f = await fixture();
  const archive = tarArchive([
    { path: "anchor", type: "5" },
    { path: "anchor/link", type: "2", link: "previous" },
    { path: "anchor/link/package.json", data: "overwrite\n" },
  ]);
  await replaceArchiveAfterSync(f.source, f.backupParent, archive);
  expect(fs.readFileSync(path.join(f.source, "previous", "package.json"), "utf8")).toBe("{}\n");
});

it("rejects hard links without a previously archived regular-file target", async () => {
  const f = await fixture();
  const archive = tarArchive([
    { path: "anchor", type: "5" },
    { path: "anchor/previous", type: "5" },
    { path: "anchor/previous/payload", type: "1", link: "anchor/previous/missing" },
  ]);
  await replaceArchiveAfterSync(f.source, f.backupParent, archive);
});

it("rejects special filesystem types in archive evidence", async () => {
  const f = await fixture();
  const archive = tarArchive([
    { path: "anchor", type: "5" },
    { path: "anchor/previous", type: "5" },
    { path: "anchor/previous/fifo", type: "6" },
  ]);
  await replaceArchiveAfterSync(f.source, f.backupParent, archive);
});

it("round-trips production-like directory and file permissions", async () => {
  const f = await fixture();
  await fsp.chmod(f.source, 0o775);
  await fsp.chmod(path.join(f.source, "previous"), 0o775);
  await fsp.chmod(path.join(f.source, "previous", "package.json"), 0o644);
  const result = await createVerifiedPackageEvidenceBackup({
    sourceRoot: f.source,
    backupParent: f.backupParent,
    operationId: randomUUID(),
  });
  const restored = path.join(result.verificationRoot, "anchor");
  expect(fs.statSync(restored).mode & 0o777).toBe(0o775);
  expect(fs.statSync(path.join(restored, "previous")).mode & 0o777).toBe(0o775);
  expect(fs.statSync(path.join(restored, "previous", "package.json")).mode & 0o777).toBe(0o644);
});

it("preserves archived modes under a restrictive caller umask", async () => {
  const f = await fixture();
  await fsp.chmod(f.source, 0o775);
  const launchers = path.join(f.source, "launchers");
  await fsp.mkdir(launchers, { mode: 0o775 });
  await fsp.writeFile(path.join(launchers, "openclaw"), "launcher\n");
  await fsp.chmod(launchers, 0o775);
  await fsp.chmod(path.join(launchers, "openclaw"), 0o644);

  const backupModule = new URL("./package-update-evidence-backup.ts", import.meta.url).href;
  const childScript = `
    process.umask(0o077);
    const { createVerifiedPackageEvidenceBackup } = await import(${JSON.stringify(backupModule)});
    const result = await createVerifiedPackageEvidenceBackup({
      sourceRoot: ${JSON.stringify(f.source)},
      backupParent: ${JSON.stringify(f.backupParent)},
      operationId: ${JSON.stringify(randomUUID())},
    });
    console.log(JSON.stringify({ verificationRoot: result.verificationRoot }));
  `;
  const child = spawnSync(
    process.execPath,
    ["--import", import.meta.resolve("tsx"), "--input-type=module", "--eval", childScript],
    { cwd: process.cwd(), encoding: "utf8", timeout: 120_000 },
  );
  expect(child.status, child.stderr || child.error?.message).toBe(0);
  const result = JSON.parse(child.stdout.trim()) as { verificationRoot: string };
  const extracted = path.join(result.verificationRoot, "anchor");
  expect(fs.statSync(result.verificationRoot).mode & 0o777).toBe(0o700);
  expect(fs.statSync(extracted).mode & 0o777).toBe(0o775);
  expect(fs.statSync(path.join(extracted, "launchers")).mode & 0o777).toBe(0o775);
  expect(fs.statSync(path.join(extracted, "launchers", "openclaw")).mode & 0o777).toBe(0o644);
});

it("detects source changes after the archive has been synced", async () => {
  const f = await fixture();
  const file = path.join(f.source, "previous", "package.json");
  let checks = 0;
  const before = fs.lstatSync(file, { bigint: true });
  await expect(
    createVerifiedPackageEvidenceBackup({
      sourceRoot: f.source,
      backupParent: f.backupParent,
      operationId: randomUUID(),
      assertCurrent() {
        checks += 1;
        if (checks === 3) {
          fs.writeFileSync(file, "changed\n");
        }
      },
    }),
  ).rejects.toThrow();
  expect(fs.readFileSync(file, "utf8")).toBe("changed\n");
  expect(fs.lstatSync(file, { bigint: true }).ino).toBe(before.ino);
});
