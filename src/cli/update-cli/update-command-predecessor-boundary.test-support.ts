import path from "node:path";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { GatewayServiceStopUnsafeError } from "../../daemon/service-inspection-error.js";
import * as gatewayOwner from "../../infra/gateway-owner-lease.js";
import { stopSupervisedPredecessorGateway } from "../../infra/update-candidate-predecessor-stop.js";
import * as updateLedger from "../../infra/update-run-ledger.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import * as updateWriter from "../../infra/update-run-write.async.js";
import { CommandProcessCleanupError } from "../../process/exec-result.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";
import { PreManagedServiceStop } from "./update-command-service-context-types.js";
import * as serviceMaintenance from "./update-command-service-maintenance.js";

export function registerPredecessorBoundaryControls(makeTempDir: (prefix: string) => string) {
  it
    .runIf(process.platform !== "win32")
    .each([
      "stopped",
      "not-stopped",
      "joined-error",
      "cleanup-uncertain",
      "native-unsafe",
      "receipt-write-failed",
      "receipt-pending",
      "receipt-pending-native-error",
      "receipt-and-stop-failed",
      "run-finished",
      "expired-before-stop",
      "expired-after-preparation",
      "late-stop-receipt",
    ] as const)("settles the POSIX predecessor stop before Doctor: %s", async (scenario) => {
    const home = makeTempDir("predecessor-stop-receipt-");
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(home, ".openclaw"));
    const env = { ...process.env };
    const now = Date.now();
    const deadlineAtMs =
      scenario.startsWith("expired-") || scenario === "late-stop-receipt" ? now + 1_000 : undefined;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    if (scenario === "expired-before-stop") {
      clock.mockReturnValue(now + 1_001);
    }
    const run = createUpdateRun({ trigger: "cli" }, { env });
    vi.spyOn(gatewayOwner, "readGatewayOwnerLease").mockReturnValue({
      owner: "fixture-gateway",
      pid: 631,
      host: "fixture-host",
      startedAt: 1,
      state: "live",
      expired: false,
      mode: "supervised",
      port: 18789,
      supervisor: { kind: "systemd", name: "fixture-gateway" },
    });
    const stopped: PreManagedServiceStop = {
      stopped: true,
      inspected: true,
      runtimeInspected: true,
      running: true,
      stoppedAtMs: 7,
      servicePid: 631,
      serviceManagerUid: 1000,
      serviceUpdateVerdict: {
        kind: "owned",
        root: home,
        fingerprint: "sealed",
        refreshDefinition: false,
      },
    };
    const failure =
      scenario === "cleanup-uncertain"
        ? new AggregateError([new CommandProcessCleanupError()], "native cleanup failed")
        : scenario === "native-unsafe"
          ? new GatewayServiceStopUnsafeError("native stop custody is uncertain")
          : new Error("stop receipt or joined verification failed");
    const receiptFailure = new Error("receipt persistence failed independently");
    const receiptEntered = createDeferred();
    const releaseReceipt = createDeferred();
    const write = updateWriter.recordUpdateRunStepAsync;
    const writer = vi
      .spyOn(updateWriter, "recordUpdateRunStepAsync")
      .mockImplementation(async (...args) => {
        if (scenario.startsWith("receipt-pending")) {
          receiptEntered.resolve();
          await releaseReceipt.promise;
        }
        if (scenario === "receipt-write-failed") {
          throw failure;
        }
        if (scenario === "receipt-and-stop-failed") {
          throw receiptFailure;
        }
        return write(...args);
      });
    vi.spyOn(serviceMaintenance, "maybeStopManagedServiceBeforeMutableUpdate").mockImplementation(
      async (params) => {
        params.assertCurrent?.();
        if (deadlineAtMs !== undefined) {
          expect(params.timeoutMs).toBe(1_000);
        }
        if (scenario === "expired-after-preparation") {
          await Promise.resolve();
          clock.mockReturnValue(now + 1_001);
        }
        params.assertDeadline?.();
        if (scenario === "not-stopped") {
          return { ...stopped, stopped: false };
        }
        if (scenario === "run-finished") {
          updateLedger.finishUpdateRun(run.runId, { status: "failed" }, { env });
        }
        if (scenario === "native-unsafe") {
          throw failure;
        }
        params.onStopped?.(stopped);
        if (scenario === "late-stop-receipt") {
          clock.mockReturnValue(now + 1_001);
        }
        if (
          [
            "joined-error",
            "cleanup-uncertain",
            "receipt-pending-native-error",
            "receipt-and-stop-failed",
          ].includes(scenario)
        ) {
          throw failure;
        }
        return stopped;
      },
    );
    const warn = vi.fn();
    const hostSql = scenario === "stopped" ? observeMainThreadSql() : undefined;
    hostSql?.calibrate();
    const stopping = stopSupervisedPredecessorGateway(
      { runId: run.runId, repair: true },
      {
        root: home,
        ledgerBusyTimeoutMs: 47_000,
        ...(deadlineAtMs !== undefined ? { serviceInspectionDeadlineAtMs: deadlineAtMs } : {}),
        assertCurrent: vi.fn(),
        warn,
      },
    );
    let settled = false;
    void stopping.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    if (scenario.startsWith("receipt-pending")) {
      try {
        await receiptEntered.promise;
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(settled).toBe(false);
        expect(getUpdateRun(run.runId, { env })?.steps).toEqual(run.steps);
      } finally {
        releaseReceipt.resolve();
        await stopping.catch(() => undefined);
      }
    }
    if (scenario.startsWith("expired-")) {
      await expect(stopping).rejects.toThrow("Doctor service-inspection deadline has expired.");
    } else if (["cleanup-uncertain", "native-unsafe", "receipt-write-failed"].includes(scenario)) {
      await expect(stopping).rejects.toBe(failure);
    } else if (scenario === "receipt-and-stop-failed") {
      await expect(stopping).rejects.toMatchObject({
        errors: [failure, receiptFailure],
        cause: failure,
      });
    } else if (scenario === "run-finished") {
      await expect(stopping).rejects.toBeInstanceOf(UpdateCommandRecoveryPendingError);
    } else {
      await expect(stopping).resolves.toBe(scenario !== "not-stopped");
    }
    expect(writer).toHaveBeenCalledTimes(
      ["not-stopped", "native-unsafe", "expired-before-stop", "expired-after-preparation"].includes(
        scenario,
      )
        ? 0
        : 1,
    );
    expect(warn).toHaveBeenCalledTimes(
      ["joined-error", "receipt-pending-native-error"].includes(scenario) ? 1 : 0,
    );
    if (writer.mock.calls.length) {
      expect(writer.mock.calls[0]?.[2]?.busyTimeoutMs).toBe(47_000);
    }
    try {
      hostSql?.expectIdle();
    } finally {
      hostSql?.restore();
    }
    const receipts = getUpdateRun(run.runId, { env })?.steps.filter((step) =>
      step.step.startsWith("finalize:predecessor-stop:"),
    );
    expect(receipts).toEqual(
      [
        "receipt-write-failed",
        "receipt-and-stop-failed",
        "run-finished",
        "not-stopped",
        "native-unsafe",
        "expired-before-stop",
        "expired-after-preparation",
      ].includes(scenario)
        ? []
        : [
            expect.objectContaining({
              step: "finalize:predecessor-stop:7:1000:631:sealed",
              status: "completed",
            }),
          ],
    );
  });
}
