import { isMainThread, threadId } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "./node-sqlite.js";
import { withSqliteReaderOwner } from "./sqlite-reader-lifecycle.js";
import {
  runSqliteDeferredTransactionSync,
  runSqliteImmediateTransactionSync,
} from "./sqlite-transaction.js";

const openDatabases: Array<import("node:sqlite").DatabaseSync> = [];

function createDatabase(): import("node:sqlite").DatabaseSync {
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE entries (id TEXT NOT NULL PRIMARY KEY, value TEXT NOT NULL)");
  openDatabases.push(db);
  return db;
}

function installDiagnosticClock() {
  let wallTimeMs = 0;
  let monotonicNs = 0n;
  vi.spyOn(Date, "now").mockImplementation(() => wallTimeMs);
  vi.spyOn(process.hrtime, "bigint").mockImplementation(() => monotonicNs);
  return {
    advance(milliseconds: number) {
      wallTimeMs += milliseconds;
      monotonicNs += BigInt(milliseconds) * 1_000_000n;
    },
    setWallTime(milliseconds: number) {
      wallTimeMs = milliseconds;
    },
  };
}

function readEntries(db: import("node:sqlite").DatabaseSync) {
  return db
    .prepare("SELECT id FROM entries ORDER BY id")
    .all()
    .map((row) => row.id);
}

afterEach(() => {
  for (const db of openDatabases.splice(0)) {
    if (db.isOpen) {
      db.close();
    }
  }
  vi.restoreAllMocks();
});

describe("SQLite transaction diagnostics", () => {
  it.each(["explicit", "inherited", "unlabeled"] as const)(
    "logs one structured warning for a terminal lock failure (%s labels)",
    (labels) => {
      const execCalls: string[] = [];
      const logger = {
        warn: vi.fn<(message: string, fields?: Record<string, unknown>) => void>(),
      };
      const clock = installDiagnosticClock();
      const lockError = Object.assign(new Error("database is locked"), {
        code: "ERR_SQLITE_ERROR",
        errcode: 5,
      });
      const db = {
        location: () => "/synthetic/agent.sqlite",
        exec(sql: string) {
          execCalls.push(sql);
          if (sql === "BEGIN IMMEDIATE") {
            clock.advance(7);
            throw lockError;
          }
        },
      } as import("node:sqlite").DatabaseSync;

      let thrown: unknown;
      try {
        const run = () =>
          runSqliteImmediateTransactionSync(db, () => "blocked", {
            busyTimeoutMs: 5_000,
            logger,
            ...(labels === "explicit"
              ? { databaseLabel: "agent.sqlite", operationLabel: "session.patch" }
              : {}),
          });
        if (labels === "unlabeled") {
          run();
        } else {
          withSqliteReaderOwner({ operation: "worker.patch", ownerKind: "worker" }, run);
        }
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBe(lockError);
      expect(execCalls).toEqual(["BEGIN IMMEDIATE"]);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        "SQLite transaction lock wait failed",
        expect.objectContaining({
          async: false,
          busyTimeoutMs: 5_000,
          code: "ERR_SQLITE_ERROR",
          database: labels === "explicit" ? "agent.sqlite" : "/synthetic/agent.sqlite",
          elapsedMs: 7,
          beginAdmission: { nativeAttempts: 1, nativeMs: 7, serviceCalls: 0, serviceMs: 0 },
          failureKind: "lock-contention",
          startedAtWallTimeMs: 0,
          endedAtWallTimeMs: 7,
          isMainThread,
          operationLabel: labels === "explicit" ? "session.patch" : null,
          readerOwnerOperation: labels === "unlabeled" ? null : "worker.patch",
          readerOwnerKind: labels === "unlabeled" ? null : "worker",
          operation:
            labels === "explicit"
              ? "session.patch"
              : labels === "inherited"
                ? "worker.patch"
                : "unlabeled",
          pid: process.pid,
          sqliteErrcode: 5,
          sqlitePrimaryCode: 5,
          step: "begin",
          threadId,
        }),
      );
      const lockCall = logger.warn.mock.calls[0];
      if (!lockCall?.[1]) {
        throw new Error("expected lock diagnostic fields");
      }
      const lockFields = lockCall[1];
      expect(String(lockFields.transactionId).split(":").slice(0, 2)).toEqual([
        String(process.pid),
        String(threadId),
      ]);
      expect(BigInt(String(lockFields.startedAtMonotonicNs))).toBeLessThanOrEqual(
        BigInt(String(lockFields.endedAtMonotonicNs)),
      );
    },
  );

  it("does not warn for busyTimeoutMs: 0 with fast successful transactions (regression)", () => {
    const logger = {
      warn: vi.fn<(message: string, fields?: Record<string, unknown>) => void>(),
    };
    const clock = installDiagnosticClock();
    const db = createDatabase();
    const location = vi.spyOn(db, "location");
    const exec = db.exec.bind(db);
    vi.spyOn(db, "exec").mockImplementation((sql) => {
      exec(sql);
      clock.advance(5);
    });

    runSqliteImmediateTransactionSync(
      db,
      () => {
        clock.advance(5);
        return "committed";
      },
      { busyTimeoutMs: 0, logger },
    );

    // busyTimeoutMs: 0 should NOT collapse threshold to 1ms.
    // With the default 1000ms threshold, 5ms steps are not slow.
    // Before the fix, this would have produced false-positive warnings.
    expect(logger.warn).not.toHaveBeenCalledWith("slow SQLite transaction step", expect.anything());
    expect(location).not.toHaveBeenCalled();
  });

  it("still warns for busyTimeoutMs: 0 when transaction crosses the default 1000ms threshold", () => {
    const logger = {
      warn: vi.fn<(message: string, fields?: Record<string, unknown>) => void>(),
    };
    const clock = installDiagnosticClock();
    const db = createDatabase();
    const exec = db.exec.bind(db);
    vi.spyOn(db, "exec").mockImplementation((sql) => {
      exec(sql);
      clock.advance(1_500);
    });

    runSqliteImmediateTransactionSync(db, () => "committed", {
      busyTimeoutMs: 0,
      databaseLabel: "agent.sqlite",
      logger,
      slowTransactionHoldMs: 0,
    });

    // The 1000ms default threshold still catches genuinely slow transactions.
    expect(logger.warn).toHaveBeenCalledWith("slow SQLite transaction step", expect.anything());
  });

  it("reports monotonic slow intervals despite a backwards wall-clock adjustment", () => {
    const logger = {
      warn: vi.fn<(message: string, fields?: Record<string, unknown>) => void>(),
    };
    const clock = installDiagnosticClock();
    const db = createDatabase();
    const exec = db.exec.bind(db);
    vi.spyOn(db, "exec").mockImplementation((sql) => {
      exec(sql);
      if (sql === "BEGIN IMMEDIATE") {
        clock.advance(5_000);
      }
    });

    runSqliteImmediateTransactionSync(
      db,
      () => {
        clock.advance(5_000);
        clock.setWallTime(0);
        return "completed";
      },
      { logger },
    );

    const beginCall = logger.warn.mock.calls.find(
      ([message, fields]) => message === "slow SQLite transaction step" && fields?.step === "begin",
    );
    if (!beginCall?.[1]) {
      throw new Error("expected slow BEGIN diagnostic fields");
    }
    expect(beginCall[1].elapsedMs).toBe(5_000);

    const holdCall = logger.warn.mock.calls.find(
      ([message]) => message === "slow SQLite transaction hold",
    );
    if (!holdCall?.[1]) {
      throw new Error("expected monotonic slow transaction hold fields");
    }
    expect(holdCall[1].elapsedMs).toBe(5_000);
    expect(holdCall[1].beginSucceededAtWallTimeMs).toBe(5_000);
    expect(holdCall[1].terminalWallTimeMs).toBe(0);
  });

  it.each(["immediate", "deferred"] as const)(
    "logs slow successful %s transaction steps without attributing lock contention",
    (mode) => {
      const logger = {
        warn: vi.fn<(message: string, fields?: Record<string, unknown>) => void>(),
      };
      const clock = installDiagnosticClock();
      const db = createDatabase();
      const exec = db.exec.bind(db);
      vi.spyOn(db, "exec").mockImplementation((sql) => {
        exec(sql);
        clock.advance(1_500);
      });

      const run =
        mode === "immediate" ? runSqliteImmediateTransactionSync : runSqliteDeferredTransactionSync;
      withSqliteReaderOwner({ operation: "worker.entries", ownerKind: "worker" }, () =>
        run(
          db,
          () => {
            db.prepare("INSERT INTO entries VALUES ('committed', 'value')").run();
            clock.advance(1_500);
            return "committed";
          },
          { busyTimeoutMs: 5_000, logger, slowTransactionHoldMs: 0 },
        ),
      );
      expect(readEntries(db)).toEqual(["committed"]);

      expect(logger.warn).toHaveBeenCalledWith(
        "slow SQLite transaction step",
        expect.objectContaining({
          async: false,
          database: ":memory:",
          elapsedMs: 1_500,
          ...(mode === "immediate"
            ? {
                beginAdmission: {
                  nativeAttempts: 1,
                  nativeMs: 1_500,
                  serviceCalls: 0,
                  serviceMs: 0,
                },
              }
            : {}),
          isMainThread,
          operation: "worker.entries",
          operationLabel: null,
          readerOwnerOperation: "worker.entries",
          readerOwnerKind: "worker",
          pid: process.pid,
          step: "begin",
          threadId,
        }),
      );
      expect(logger.warn).toHaveBeenCalledWith(
        "slow SQLite transaction step",
        expect.objectContaining({
          async: false,
          busyTimeoutMs: 5_000,
          database: ":memory:",
          elapsedMs: 1_500,
          isMainThread,
          operation: "worker.entries",
          operationLabel: null,
          readerOwnerOperation: "worker.entries",
          readerOwnerKind: "worker",
          pid: process.pid,
          step: "commit",
          threadId,
        }),
      );
      expect(logger.warn).toHaveBeenCalledWith(
        "slow SQLite transaction hold",
        expect.objectContaining({
          async: false,
          database: ":memory:",
          elapsedMs: 3_000,
          isMainThread,
          mode,
          operation: "worker.entries",
          operationLabel: null,
          readerOwnerOperation: "worker.entries",
          readerOwnerKind: "worker",
          pid: process.pid,
          threadId,
          terminal: "returned",
          connectionState: "open",
          transactionState: "inactive",
        }),
      );
      const beginCall = logger.warn.mock.calls.find(
        ([message, fields]) =>
          message === "slow SQLite transaction step" && fields?.step === "begin",
      );
      if (!beginCall?.[1]) {
        throw new Error("expected slow BEGIN diagnostic fields");
      }
      const beginStep = beginCall[1];
      const commitCall = logger.warn.mock.calls.find(
        ([message, fields]) =>
          message === "slow SQLite transaction step" && fields?.step === "commit",
      );
      if (!commitCall?.[1]) {
        throw new Error("expected slow COMMIT diagnostic fields");
      }
      const commitStep = commitCall[1];
      const holdCall = logger.warn.mock.calls.find(
        ([message]) => message === "slow SQLite transaction hold",
      );
      if (!holdCall?.[1]) {
        throw new Error("expected slow transaction hold diagnostic fields");
      }
      const hold = holdCall[1];
      expect(String(beginStep.transactionId).split(":").slice(0, 2)).toEqual([
        String(process.pid),
        String(threadId),
      ]);
      expect(commitStep.transactionId).toBe(beginStep.transactionId);
      expect(hold.transactionId).toBe(beginStep.transactionId);
      expect(BigInt(String(hold.beginAttemptStartedAtMonotonicNs))).toBeLessThanOrEqual(
        BigInt(String(hold.beginSucceededAtMonotonicNs)),
      );
      expect(BigInt(String(hold.beginSucceededAtMonotonicNs))).toBeLessThanOrEqual(
        BigInt(String(hold.terminalMonotonicNs)),
      );
      const beginAttemptWallTimeMs = hold.beginAttemptStartedAtWallTimeMs;
      const beginSucceededWallTimeMs = hold.beginSucceededAtWallTimeMs;
      const terminalWallTimeMs = hold.terminalWallTimeMs;
      if (
        typeof beginAttemptWallTimeMs !== "number" ||
        typeof beginSucceededWallTimeMs !== "number" ||
        typeof terminalWallTimeMs !== "number"
      ) {
        throw new Error("expected wall-clock timestamps in transaction hold diagnostics");
      }
      expect(beginAttemptWallTimeMs).toBeLessThanOrEqual(beginSucceededWallTimeMs);
      expect(beginSucceededWallTimeMs).toBeLessThanOrEqual(terminalWallTimeMs);
    },
  );

  it.each(["release", "rollback"] as const)(
    "logs only the outer hold after a nested savepoint %s",
    (nestedOutcome) => {
      const logger = {
        warn: vi.fn<(message: string, fields?: Record<string, unknown>) => void>(),
      };
      const clock = installDiagnosticClock();
      const db = createDatabase();
      const exec = db.exec.bind(db);
      vi.spyOn(db, "exec").mockImplementation((sql) => {
        exec(sql);
        clock.advance(1_500);
      });

      runSqliteImmediateTransactionSync(
        db,
        () => {
          try {
            runSqliteImmediateTransactionSync(
              db,
              () => {
                db.prepare("INSERT INTO entries VALUES ('nested', 'value')").run();
                if (nestedOutcome === "rollback") {
                  throw new Error("nested operation rejected");
                }
                return "nested";
              },
              { logger, slowTransactionHoldMs: 0 },
            );
          } catch {
            // The outer transaction deliberately handles the nested rollback.
          }
          return "outer";
        },
        { logger, slowTransactionHoldMs: 0 },
      );

      expect(readEntries(db)).toEqual(nestedOutcome === "release" ? ["nested"] : []);
      const holds = logger.warn.mock.calls.filter(
        ([message]) => message === "slow SQLite transaction hold",
      );
      expect(holds).toHaveLength(1);
      const beginCall = logger.warn.mock.calls.find(
        ([message, fields]) =>
          message === "slow SQLite transaction step" && fields?.step === "begin",
      );
      if (!beginCall?.[1]) {
        throw new Error("expected outer BEGIN diagnostic fields");
      }
      const holdCall = holds[0];
      if (!holdCall?.[1]) {
        throw new Error("expected outer hold diagnostic fields");
      }
      expect(holdCall[1].transactionId).toBe(beginCall[1].transactionId);
      expect(holdCall[1].terminal).toBe("returned");
      expect(holdCall[1].transactionState).toBe("inactive");
    },
  );

  it.each([false, true])(
    "names a slow failed transaction holder (rollback fails: %s)",
    (rollbackFails) => {
      const logger = {
        warn: vi.fn<(message: string, fields?: Record<string, unknown>) => void>(),
      };
      const clock = installDiagnosticClock();
      const db = createDatabase();
      if (rollbackFails) {
        const exec = db.exec.bind(db);
        vi.spyOn(db, "exec").mockImplementation((sql) => {
          if (sql === "ROLLBACK") {
            throw new Error("rollback failed");
          }
          exec(sql);
        });
      }
      expect(() =>
        runSqliteImmediateTransactionSync(
          db,
          () => {
            clock.advance(5_100);
            throw new Error("rejected mutation");
          },
          {
            ...(rollbackFails ? {} : { databaseLabel: "agent.sqlite" }),
            operationLabel: "session.write",
            logger,
          },
        ),
      ).toThrow("rejected mutation");
      expect(db.isOpen).toBe(!rollbackFails);
      if (!rollbackFails) {
        expect(db.isTransaction).toBe(false);
      }
      expect(logger.warn).toHaveBeenCalledWith(
        "slow SQLite transaction hold",
        expect.objectContaining({
          database: rollbackFails ? "unavailable" : "agent.sqlite",
          elapsedMs: 5_100,
          isMainThread,
          mode: "immediate",
          operation: "session.write",
          operationLabel: "session.write",
          terminal: "threw",
          connectionState: rollbackFails ? "retired" : "open",
          transactionState: rollbackFails ? "unavailable" : "inactive",
        }),
      );
    },
  );

  it("does not report a commit when the commit guard throws after COMMIT returns", () => {
    const logger = {
      warn: vi.fn<(message: string, fields?: Record<string, unknown>) => void>(),
    };
    const clock = installDiagnosticClock();
    const db = createDatabase();

    expect(() =>
      runSqliteImmediateTransactionSync(
        db,
        () => {
          clock.advance(1_500);
          return "guard-rejected";
        },
        {
          logger,
          operationLabel: "diagnostic.guard",
          slowTransactionHoldMs: 0,
          withCommit(commit) {
            commit();
            throw new Error("post-commit guard failure");
          },
        },
      ),
    ).toThrow("post-commit guard failure");

    expect(db.isOpen).toBe(false);
    const holdCall = logger.warn.mock.calls.find(
      ([message]) => message === "slow SQLite transaction hold",
    );
    if (!holdCall?.[1]) {
      throw new Error("expected post-guard transaction hold diagnostic fields");
    }
    const hold = holdCall[1];
    expect(hold.terminal).toBe("threw");
    expect(hold.connectionState).toBe("retired");
    expect(hold.transactionState).toBe("unavailable");
  });
});
