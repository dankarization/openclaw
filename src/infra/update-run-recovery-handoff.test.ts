import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runExistingOpenClawStateWriteTransaction } from "../state/openclaw-state-db-existing-write.js";
import * as handles from "../state/openclaw-state-db-handle.js";
import { withExistingOpenClawStateSchema } from "../state/openclaw-state-db-schema-policy.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import {
  createRetainedUpdateRecovery,
  storeRetainedUpdateRecovery,
} from "./update-retained-recovery.test-support.js";
import { createUpdateRun, recordUpdateRunPhase } from "./update-run-ledger.js";
import { updateRunLedgerSchema } from "./update-run-write.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);
// These tests own every writer in their disposable state roots.
function source(legacySchema = true) {
  const root = dirs.make("openclaw-handoff-before-migration-");
  const options = { env: { HOME: root, OPENCLAW_STATE_DIR: root } };
  const run = createUpdateRun({ trigger: "cli" }, options);
  const from = {
    root: path.join(root, "previous"),
    nodePath: process.execPath,
    version: "1.0.0",
    buildId: "old",
  };
  const to = { ...from, root: path.join(root, "candidate"), version: "2.0.0", buildId: "new" };
  const record = createRetainedUpdateRecovery({ runId: run.runId, from, to }, options);
  record.handoff = { handoffId: randomUUID(), state: "prepared" };
  storeRetainedUpdateRecovery(record, options);
  const pathname = openOpenClawStateDatabase(options).path;
  closeOpenClawStateDatabaseForTest();
  const legacy = openNodeSqliteDatabase(pathname);
  try {
    if (legacySchema) {
      // Legitimate v15/no-Workshop shape also covered by the state-owner migration tests.
      legacy.exec(`PRAGMA foreign_keys=OFF;
        DROP TABLE IF EXISTS skill_workshop_proposal_events;
        DROP TABLE IF EXISTS skill_workshop_proposal_rollbacks;
        DROP TABLE IF EXISTS skill_workshop_collection_reviews;
        DROP TABLE IF EXISTS skill_workshop_proposals;
        UPDATE schema_meta SET schema_version=15 WHERE meta_key='primary';`);
      legacy.prepare("PRAGMA user_version=15").run();
    }
    const journalMode = legacy.prepare("PRAGMA journal_mode=WAL").get();
    if (journalMode?.journal_mode !== "wal") {
      throw new Error("WAL mode was not enabled for the writer-preflight fixture");
    }
    legacy.prepare("PRAGMA wal_autocheckpoint=0").run();
    legacy.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  } finally {
    legacy.close();
  }
  return { root, options, run, to, record, pathname };
}
function shape(pathname: string) {
  const db = openNodeSqliteDatabase(pathname, { readOnly: true });
  try {
    return {
      version: db.prepare("PRAGMA user_version").get(),
      schema: db
        .prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name")
        .all(),
      metadata: db.prepare("SELECT * FROM schema_meta ORDER BY meta_key").all(),
    };
  } finally {
    db.close();
  }
}
function commitPeerStateChange(pathname: string) {
  const peer = new DatabaseSync(pathname);
  try {
    peer.exec("PRAGMA busy_timeout=0; PRAGMA wal_autocheckpoint=0;");
    peer
      .prepare(
        "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
      )
      .run("test.preflight." + randomUUID(), '"peer"', Date.now());
  } finally {
    peer.close();
  }
}

function observeSchemaQueries(onCheck: (count: number) => void) {
  const nativeAll = Object.getOwnPropertyDescriptor(StatementSync.prototype, "all")?.value as
    | ((
        this: StatementSync,
        ...params: unknown[]
      ) => Array<Record<string, import("node:sqlite").SQLOutputValue>>)
    | undefined;
  if (!nativeAll) {
    throw new Error("StatementSync.all descriptor is unavailable");
  }
  let count = 0;
  const spy = vi.spyOn(StatementSync.prototype, "all").mockImplementation(function (
    this: StatementSync,
    ...params: unknown[]
  ) {
    const result = nativeAll.call(this, ...params);
    if (/sqlite_schema/i.test(this.sourceSQL)) {
      onCheck(++count);
    }
    return result;
  });
  return {
    count: () => count,
    restore: () => spy.mockRestore(),
  };
}

function expectPeerWriterBlocked(pathname: string) {
  const peer = new DatabaseSync(pathname);
  try {
    peer.exec("PRAGMA busy_timeout=0");
    expect(() => peer.exec("BEGIN IMMEDIATE")).toThrow(/locked/i);
  } finally {
    if (peer.isTransaction) {
      peer.exec("ROLLBACK");
    }
    peer.close();
  }
}

it("lets a WAL peer commit during deferred integrity preflight, then revalidates under the writer lock", () => {
  const f = source();
  const nativeOpen = handles.openTrackedStateDatabase;
  let target: DatabaseSync | undefined;
  let immediateBegin = false;
  let peerCommitted = false;
  let fallbackHeldWriterLock = false;
  const open = vi.spyOn(handles, "openTrackedStateDatabase").mockImplementation((...args) => {
    target = nativeOpen(...args);
    return target;
  });
  const nativeExec = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "exec")?.value as
    | ((this: DatabaseSync, sql: string) => void)
    | undefined;
  if (!nativeExec) {
    throw new Error("DatabaseSync.exec descriptor is unavailable");
  }
  const exec = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
    this: DatabaseSync,
    sql: string,
  ) {
    const result = nativeExec.call(this, sql);
    if (this === target && /^BEGIN IMMEDIATE$/i.test(sql.trim())) {
      immediateBegin = true;
    }
    return result;
  });
  const integrity = observeSchemaQueries((count) => {
    if (count === 1) {
      // The schema read has established the deferred snapshot; WAL permits this peer commit.
      commitPeerStateChange(f.pathname);
      peerCommitted = true;
    } else if (immediateBegin && count >= 2 && !fallbackHeldWriterLock) {
      expectPeerWriterBlocked(f.pathname);
      fallbackHeldWriterLock = true;
    }
  });
  try {
    expect(() => probeExistingWriter(f)).not.toThrow();
    expect(peerCommitted).toBe(true);
    expect(integrity.count()).toBeGreaterThanOrEqual(2);
    expect(immediateBegin).toBe(true);
    expect(fallbackHeldWriterLock).toBe(true);
  } finally {
    integrity.restore();
    exec.mockRestore();
    open.mockRestore();
  }
});

it("revalidates after a WAL peer commits between the deferred snapshot and BEGIN IMMEDIATE", () => {
  const f = source(false);
  const nativeOpen = handles.openTrackedStateDatabase;
  let target: DatabaseSync | undefined;
  let peerCommitted = false;
  let fallbackHeldWriterLock = false;
  const open = vi.spyOn(handles, "openTrackedStateDatabase").mockImplementation((...args) => {
    target = nativeOpen(...args);
    return target;
  });
  const nativeExec = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "exec")?.value as
    | ((this: DatabaseSync, sql: string) => void)
    | undefined;
  if (!nativeExec) {
    throw new Error("DatabaseSync.exec descriptor is unavailable");
  }
  const exec = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
    this: DatabaseSync,
    sql: string,
  ) {
    const result = nativeExec.call(this, sql);
    if (this === target && /^COMMIT$/i.test(sql.trim()) && !peerCommitted) {
      commitPeerStateChange(f.pathname);
      peerCommitted = true;
    }
    return result;
  });
  const integrity = observeSchemaQueries((count) => {
    if (peerCommitted && count >= 2 && !fallbackHeldWriterLock) {
      expectPeerWriterBlocked(f.pathname);
      fallbackHeldWriterLock = true;
    }
  });
  try {
    expect(() => probeExistingWriter(f, undefined, true)).not.toThrow();
    expect(peerCommitted).toBe(true);
    expect(integrity.count()).toBeGreaterThanOrEqual(2);
    expect(fallbackHeldWriterLock).toBe(true);
  } finally {
    integrity.restore();
    exec.mockRestore();
    open.mockRestore();
  }
});

it("falls back to locked validation when a peer repairs the schema after a failed preflight", () => {
  const f = source(false);
  const drop = openNodeSqliteDatabase(f.pathname);
  try {
    drop.exec("DROP TABLE update_runs");
  } finally {
    drop.close();
  }
  const nativeAll = Object.getOwnPropertyDescriptor(StatementSync.prototype, "all")?.value as
    | ((
        this: StatementSync,
        ...params: unknown[]
      ) => Array<Record<string, import("node:sqlite").SQLOutputValue>>)
    | undefined;
  if (!nativeAll) {
    throw new Error("StatementSync.all descriptor is unavailable");
  }
  const nativeExec = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "exec")?.value as
    | ((this: DatabaseSync, sql: string) => void)
    | undefined;
  if (!nativeExec) {
    throw new Error("DatabaseSync.exec descriptor is unavailable");
  }
  let repaired = false;
  let immediateBegin = false;
  let checksAfterBegin = 0;
  let operationSawRepair = false;
  const exec = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
    this: DatabaseSync,
    sql: string,
  ) {
    const result = nativeExec.call(this, sql);
    if (this === target && /^BEGIN IMMEDIATE$/i.test(sql.trim())) {
      immediateBegin = true;
    }
    return result;
  });
  const nativeOpen = handles.openTrackedStateDatabase;
  let target: DatabaseSync | undefined;
  const open = vi.spyOn(handles, "openTrackedStateDatabase").mockImplementation((...args) => {
    target = nativeOpen(...args);
    return target;
  });
  const all = vi.spyOn(StatementSync.prototype, "all").mockImplementation(function (
    this: StatementSync,
    ...params: unknown[]
  ) {
    const result = nativeAll.call(this, ...params);
    if (/^PRAGMA\s+integrity_check/i.test(this.sourceSQL.trim()) && immediateBegin) {
      checksAfterBegin += 1;
    }
    if (!repaired && /sqlite_schema/i.test(this.sourceSQL)) {
      const peer = new DatabaseSync(f.pathname);
      try {
        peer.exec("PRAGMA busy_timeout=0; PRAGMA wal_autocheckpoint=0;");
        peer.exec(updateRunLedgerSchema);
        repaired = true;
      } finally {
        peer.close();
      }
    }
    return result;
  });
  try {
    expect(() =>
      probeExistingWriter(f, undefined, false, () => {
        const reader = openNodeSqliteDatabase(f.pathname, { readOnly: true });
        try {
          operationSawRepair =
            reader
              .prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='update_runs'")
              .get() !== undefined;
        } finally {
          reader.close();
        }
      }),
    ).not.toThrow();
    expect(repaired).toBe(true);
    expect(immediateBegin).toBe(true);
    expect(checksAfterBegin).toBeGreaterThan(0);
    expect(operationSawRepair).toBe(true);
  } finally {
    all.mockRestore();
    exec.mockRestore();
    open.mockRestore();
  }
});

it.each([
  { existingSchemaScope: false, legacySchema: true },
  { existingSchemaScope: true, legacySchema: false },
])(
  "reuses an unchanged same-handle integrity preflight after writer admission (scope=$existingSchemaScope)",
  ({ existingSchemaScope, legacySchema }) => {
    const f = source(legacySchema);
    const nativeOpen = handles.openTrackedStateDatabase;
    let target: DatabaseSync | undefined;
    let immediateBegin = false;
    let integrityChecks = 0;
    let integrityChecksAfterBegin = 0;
    let operationChecks = -1;
    const open = vi.spyOn(handles, "openTrackedStateDatabase").mockImplementation((...args) => {
      target = nativeOpen(...args);
      return target;
    });
    const nativeExec = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "exec")?.value as
      | ((this: DatabaseSync, sql: string) => void)
      | undefined;
    if (!nativeExec) {
      throw new Error("DatabaseSync.exec descriptor is unavailable");
    }
    const exec = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      const result = nativeExec.call(this, sql);
      if (this === target && /^BEGIN IMMEDIATE$/i.test(sql.trim())) {
        immediateBegin = true;
      }
      return result;
    });
    const nativeAll = Object.getOwnPropertyDescriptor(StatementSync.prototype, "all")?.value;
    if (!nativeAll) {
      throw new Error("StatementSync.all descriptor is unavailable");
    }
    const all = vi.spyOn(StatementSync.prototype, "all").mockImplementation(function (
      this: StatementSync,
      ...params: unknown[]
    ) {
      const result = nativeAll.call(this, ...params);
      if (/^PRAGMA\s+integrity_check/i.test(this.sourceSQL.trim())) {
        integrityChecks += 1;
        if (immediateBegin) {
          integrityChecksAfterBegin += 1;
        }
      }
      return result;
    });
    try {
      probeExistingWriter(f, undefined, existingSchemaScope, () => {
        operationChecks = integrityChecks;
      });
      const expectedIntegrityChecks = existingSchemaScope ? 2 : 1;
      expect(integrityChecks).toBe(expectedIntegrityChecks);
      expect(integrityChecksAfterBegin).toBe(0);
      expect(operationChecks).toBe(expectedIntegrityChecks);
    } finally {
      all.mockRestore();
      exec.mockRestore();
      open.mockRestore();
    }
  },
);

it("refuses existing-state writes while another connection holds the native transaction", () => {
  const f = source();
  const before = fs.readFileSync(f.pathname);
  const writer = openNodeSqliteDatabase(f.pathname);
  writer.exec("BEGIN IMMEDIATE");
  try {
    expect(() => probeExistingWriter(f, 0)).toThrow(/locked/);
    expect(fs.readFileSync(f.pathname)).toEqual(before);
  } finally {
    writer.exec("ROLLBACK");
    writer.close();
  }
});

it("does not create a canonical database when a prepared handoff loses its source", () => {
  const f = source();
  fs.renameSync(f.pathname, f.pathname + ".retained");
  expect(() => probeExistingWriter(f)).toThrow();
  expect(fs.existsSync(f.pathname)).toBe(false);
  expect(shape(f.pathname + ".retained").version).toEqual({ user_version: 15 });
});
it.each(["future", "metadata", "trigger"])(
  "refuses %s state without changing a retained handoff",
  (scenario) => {
    const f = source();
    const raw = openNodeSqliteDatabase(f.pathname);
    try {
      if (scenario === "future") {
        raw.exec(
          "PRAGMA user_version=2147483647; UPDATE schema_meta SET schema_version=2147483647 WHERE meta_key='primary'",
        );
      } else if (scenario === "metadata") {
        raw.exec("UPDATE schema_meta SET schema_version=14 WHERE meta_key='primary'");
      } else {
        raw.exec(
          "CREATE TRIGGER unexpected_recovery_write AFTER UPDATE ON config_machine_state BEGIN UPDATE schema_meta SET app_version='unexpected'; END;",
        );
      }
    } finally {
      raw.close();
    }
    const before = shape(f.pathname);
    expect(() => probeExistingWriter(f)).toThrow();
    expect(shape(f.pathname)).toEqual(before);
    const read = openNodeSqliteDatabase(f.pathname, { readOnly: true });
    try {
      const row = read
        .prepare(
          "SELECT value_json FROM config_machine_state WHERE state_key LIKE 'update.recovery.%'",
        )
        .get();
      // Match the exact retained row without opening it through a schema-mutating runtime.
      expect(row).toBeDefined();
      expect(JSON.parse(String(row?.value_json))).toEqual(f.record);
    } finally {
      read.close();
    }
  },
);

it("does not recreate canonical state displaced immediately before the tracked writer", () => {
  const f = source();
  const before = shape(f.pathname);
  const open = handles.openTrackedStateDatabase;
  const spy = vi
    .spyOn(handles, "openTrackedStateDatabase")
    .mockImplementation((pathname, options) => {
      fs.renameSync(pathname, pathname + ".retained");
      return open(pathname, options);
    });
  try {
    expect(() => probeExistingWriter(f)).toThrow();
  } finally {
    spy.mockRestore();
  }
  expect(fs.existsSync(f.pathname)).toBe(false);
  expect(shape(f.pathname + ".retained")).toEqual(before);
});

function probeExistingWriter(
  f: ReturnType<typeof source>,
  busyTimeoutMs?: number,
  existingSchemaScope = false,
  operation: () => void = () => undefined,
) {
  const run = () =>
    runExistingOpenClawStateWriteTransaction(() => operation(), f.options, {
      schemaSql: ["schema_meta", "config_machine_state", "update_runs"]
        .map((table) => {
          const start = OPENCLAW_STATE_SCHEMA_SQL.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
          const marker = ") STRICT;";
          return OPENCLAW_STATE_SCHEMA_SQL.slice(
            start,
            OPENCLAW_STATE_SCHEMA_SQL.indexOf(marker, start) + marker.length,
          );
        })
        .join("\n"),
      operationLabel: "retained-test-owner",
      busyTimeoutMs,
    });
  return existingSchemaScope ? withExistingOpenClawStateSchema({ path: f.pathname }, run) : run();
}
it("preserves the previous runtime schema during ledger bookkeeping", () => {
  const f = source();
  const before = shape(f.pathname);
  expect(recordUpdateRunPhase(f.run.runId, "verifying", {}, f.options).phase).toBe("verifying");
  closeOpenClawStateDatabaseForTest();
  expect(shape(f.pathname)).toEqual(before);
});
