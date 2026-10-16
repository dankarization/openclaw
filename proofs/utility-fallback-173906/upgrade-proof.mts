/**
 * v2026.10.4 upgrade data-compat proof for openclaw#173906.
 *
 * The profile config was authored by the released `openclaw@2026.10.4` CLI
 * (commit 383c124) with the string `utilityModel` form at both default and
 * per-agent scope. This loads that file with the CANDIDATE config owner and shows
 * it still validates and resolves to the same explicit utility selection, with the
 * file left byte-identical (no forced migration).
 *
 * Run: node --import ./scripts/tsx.mjs proofs/utility-fallback-173906/upgrade-proof.mts
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { readUtilityModelSetting } from "../../src/agents/utility-model-setting.js";
import { readConfigFileSnapshot } from "../../src/config/config.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";

const configPath =
  process.env.PROOF_CONFIG ?? "/home/dankar/.openclaw-upgrade-proof-104/openclaw.json";
process.env.OPENCLAW_CONFIG_PATH = configPath;

const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const before = sha(configPath);

const snapshot = await readConfigFileSnapshot();
const cfg = (snapshot.config ?? {}) as OpenClawConfig;

const defaultsUtility = readUtilityModelSetting(cfg);
const agentUtility = readUtilityModelSetting(cfg, "main");
const after = sha(configPath);

// The only persisted shape this change touches is config; confirm the 10.4 state
// database still opens intact under the candidate runtime.
const stateDbPath =
  process.env.PROOF_STATE_DB ?? "/home/dankar/.openclaw-upgrade-proof-104/state/openclaw.sqlite";
let stateDb: { integrity: string; tables: number; schemaVersion: string | null } | null = null;
try {
  const db = new DatabaseSync(stateDbPath, { readOnly: true });
  const integrity = db.prepare("PRAGMA integrity_check").get() as Record<string, string>;
  const tables = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get() as {
    n: number;
  };
  let schemaVersion: string | null = null;
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as
      | { value?: string }
      | undefined;
    schemaVersion = row?.value ?? null;
  } catch {
    schemaVersion = null;
  }
  db.close();
  stateDb = { integrity: integrity.integrity_check ?? "unknown", tables: tables.n, schemaVersion };
} catch (error) {
  stateDb = { integrity: `error: ${String(error)}`, tables: -1, schemaVersion: null };
}

const report = {
  head: process.env.PROOF_HEAD ?? "unknown",
  configPath,
  exists: snapshot.exists,
  valid: snapshot.valid,
  shaBefore: before,
  shaAfter: after,
  unchanged: before === after,
  migrationMarker:
    (cfg as { meta?: { migrations?: { utilityModelSeparation?: boolean } } }).meta?.migrations
      ?.utilityModelSeparation ?? null,
  defaultsUtility,
  agentUtility,
  stateDb,
};
console.log(JSON.stringify(report, null, 2));

const expected = "openai/gpt-5.4-mini";
const ok =
  snapshot.exists === true &&
  snapshot.valid === true &&
  before === after &&
  defaultsUtility.kind === "explicit" &&
  defaultsUtility.modelRef === expected &&
  agentUtility.kind === "explicit" &&
  agentUtility.modelRef === expected &&
  stateDb.integrity === "ok" &&
  stateDb.tables > 0;
process.exitCode = ok ? 0 : 1;
