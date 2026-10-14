import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { execFileSync } from "node:child_process";

const [mode, source, profile, artifacts] = process.argv.slice(2);
const file = new URL(import.meta.url).pathname;
const moduleAt = (name) => pathToFileURL(path.join(source, name)).href;
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const errorFacts = (error) => ({
  name: error?.name,
  message: String(error?.message ?? error),
  code: error?.code,
  errcode: error?.errcode,
  errstr: error?.errstr,
  stack: error?.stack?.split("\n").slice(0, 10),
  ...(error?.cause && error.cause !== error ? { cause: errorFacts(error.cause) } : {}),
});

if (mode === "consumer" || mode === "readout") {
  fs.mkdirSync(profile, { recursive: true });
  const env = {
    ...process.env,
    HOME: profile,
    OPENCLAW_HOME: profile,
    OPENCLAW_STATE_DIR: profile,
    OPENCLAW_CONFIG_PATH: path.join(profile, "openclaw.json"),
  };
  Object.assign(process.env, env);
  const ledger = await import(moduleAt("src/infra/update-run-ledger.ts"));
  const state = await import(moduleAt("src/state/openclaw-state-db.ts"));
  const { resolveOpenClawStateSqlitePath } = await import(
    moduleAt("src/state/openclaw-state-db.paths.ts")
  );
  if (mode === "readout") {
    const runId = fs.readFileSync(path.join(profile, "proof-run-id"), "utf8");
    const run = ledger.getUpdateRun(runId, { env });
    emit({ event: "native-readout", runId, record: run });
    await state.closeOpenClawStateDatabaseAsync();
  } else {
    const { completeUpdateCommandRun } = await import(
      moduleAt("src/cli/update-cli/update-command-run.ts")
    );
    const record = ledger.createUpdateRun({ trigger: "cli" }, { env, busyTimeoutMs: 71_000 });
    const run = { runId: record.runId, env, ledgerBusyTimeoutMs: 71_000 };
    fs.writeFileSync(path.join(profile, "proof-run-id"), run.runId);
    const warm = ledger.getUpdateRun(run.runId, { env });
    if (warm?.status !== "running") throw new Error("Synthetic native ledger was not admitted");
    const input = createInterface({ input: process.stdin });
    const go = new Promise((resolve) => input.once("line", resolve));
    emit({ event: "ready", pid: process.pid, runId: run.runId,
      databasePath: resolveOpenClawStateSqlitePath(env), allowanceMs: 71_000, atMs: Date.now() });
    if ((await go) !== "go") throw new Error("Expected explicit lock-ready go barrier");
    input.close();
    const startedAtMs = Date.now();
    const start = performance.now();
    await new Promise((resolve) => process.stdout.write(
      `${JSON.stringify({ event: "operation-start", startedAtMs })}\n`, resolve));
    try {
      const result = completeUpdateCommandRun(
        { status: "ok", mode: "npm", durationMs: 1, steps: [] }, run,
      );
      emit({ event: "operation-result", outcome: "returned", result,
        startedAtMs, finishedAtMs: Date.now(), durationMs: performance.now() - start });
    } catch (error) {
      emit({ event: "operation-result", outcome: "threw", error: errorFacts(error),
        startedAtMs, finishedAtMs: Date.now(), durationMs: performance.now() - start });
      process.exitCode = 2;
    } finally {
      await state.closeOpenClawStateDatabaseAsync();
    }
  }
} else if (mode === "blocker") {
  const { DatabaseSync } = await import("node:sqlite");
  const databasePath = profile;
  const db = new DatabaseSync(databasePath);
  const start = performance.now();
  let acquiredAtMs;
  try {
    db.exec("BEGIN IMMEDIATE");
    acquiredAtMs = Date.now();
    emit({ event: "locked", databasePath, pid: process.pid, acquiredAtMs,
      transactionActive: db.isTransaction });
    await new Promise((resolve) => setTimeout(resolve, 8_000));
    db.exec("ROLLBACK");
    emit({ event: "unlocked", acquiredAtMs, releasedAtMs: Date.now(),
      heldMs: performance.now() - start, transactionActive: db.isTransaction });
  } finally {
    if (db.isTransaction) db.exec("ROLLBACK");
    db.close();
  }
} else if (mode === "runner") {
  const { runManagedCommand } = await import(moduleAt("scripts/lib/managed-child-process.mts"));
  const { runCancelableCommand } = await import(moduleAt("scripts/lib/cancelable-command.mts"));
  fs.mkdirSync(artifacts, { recursive: true });
  const events = [];
  const children = [];
  const record = (name, event) => {
    const entry = { child: name, observedAtMs: Date.now(), ...event };
    events.push(entry);
    fs.appendFileSync(path.join(artifacts, "events.jsonl"), `${JSON.stringify(entry)}\n`);
    emit(entry);
  };
  process.exitCode = await runCancelableCommand(async (parentSignal) => {
    const controller = new AbortController();
    const signal = AbortSignal.any([parentSignal, controller.signal]);
    function launch(name, childMode, childProfile, timeoutMs = 60_000) {
      let child;
      const waiting = new Map();
      const observed = new Map();
      const done = runManagedCommand({
        bin: process.execPath,
        args: ["--max-old-space-size=768", "--import", path.join(source, "scripts/tsx.mjs"),
          file, childMode, source, childProfile, artifacts],
        cwd: source, env: { ...process.env }, stdio: ["pipe", "pipe", "pipe"],
        timeoutMs, signal, requireProcessTreeExit: true,
        onReady(process) {
          child = process;
          createInterface({ input: process.stdout }).on("line", (line) => {
            fs.appendFileSync(path.join(artifacts, `${name}.stdout`), `${line}\n`);
            if (!line.startsWith("{")) return;
            let event;
            try { event = JSON.parse(line); } catch { return; }
            if (!event.event) return;
            observed.set(event.event, event);
            record(name, event);
            waiting.get(event.event)?.(event);
          });
          process.stderr.on("data", (data) =>
            fs.appendFileSync(path.join(artifacts, `${name}.stderr`), data));
        },
      }).then((exit) => ({ exit }), (error) => ({ error: errorFacts(error) }));
      const handle = {
        done,
        send(value) { child.stdin.end(`${value}\n`); },
        event(name) {
          if (observed.has(name)) return Promise.resolve(observed.get(name));
          return Promise.race([
            new Promise((resolve) => waiting.set(name, resolve)),
            done.then((outcome) => { throw new Error(`Child ended before ${name}: ${JSON.stringify(outcome)}`); }),
          ]);
        },
      };
      children.push(handle);
      return handle;
    }
    let failure;
    let receipt;
    try {
      const sourceHead = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      const sourceTree = execFileSync("git", ["-C", source, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
      const consumer = launch("consumer", "consumer", profile);
      const ready = await consumer.event("ready");
      const blocker = launch("blocker", "blocker", ready.databasePath, 20_000);
      const locked = await blocker.event("locked");
      if (!locked.transactionActive) throw new Error("Real SQLite lock was not acquired");
      consumer.send("go");
      const operation = await consumer.event("operation-result");
      const unlocked = await blocker.event("unlocked");
      const joined = await Promise.all([consumer.done, blocker.done]);
      if (joined.some((x) => x.error) || joined[1].exit !== 0) throw new Error(JSON.stringify(joined));
      const reader = launch("readout", "readout", profile);
      const readout = await reader.event("native-readout");
      const readerJoined = await reader.done;
      if (readerJoined.exit !== 0) throw new Error(JSON.stringify(readerJoined));
      receipt = { kind: "native-terminal-owner-real-sqlite-contention", sourceHead, sourceTree,
        allowanceMs: 71_000, requestedHoldMs: 8_000, ready, locked, operation, unlocked,
        nativeReadout: readout.record, joined, readerJoined, cleanup: "all-managed-children-joined",
        scope: "source behavior only; not published-driver or service-readiness proof" };
      fs.writeFileSync(path.join(artifacts, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
    } catch (error) {
      failure = errorFacts(error);
      controller.abort();
      fs.writeFileSync(path.join(artifacts, "failure.json"), `${JSON.stringify(failure, null, 2)}\n`);
    } finally {
      const cleanup = await Promise.all(children.map((child) => child.done));
      fs.writeFileSync(path.join(artifacts, "cleanup.json"), `${JSON.stringify(cleanup, null, 2)}\n`);
    }
    if (failure) { emit({ event: "proof-blocked", failure }); return 1; }
    emit({ event: "proof-complete", outcome: receipt.operation.outcome,
      durableStatus: receipt.nativeReadout?.status, heldMs: receipt.unlocked.heldMs });
    return 0;
  });
} else {
  throw new Error("Expected runner, consumer, blocker or readout mode");
}
