import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it, vi } from "vitest";
import { useSqliteWorkerFault } from "../../../../test/helpers/sqlite-worker-fault.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../../config/io.js";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { captureOperatorToolGatewayContinuationContext } from "../../../gateway/server-plugin-in-process-dispatch.js";
import { createContext } from "../../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { withPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { createRequesterWakeSettlement } from "../registry/subagent-registry-requester-wake-mutation.js";
import { loadSubagentRegistryFromSqlite } from "../registry/subagent-registry-state.fixture.test-support.js";
import { retainedOperatorFixture } from "../registry/subagent-registry.completed-followup-authority.test-support.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import {
  prepareRequesterYieldNoticeAuthority,
  promoteRequesterYieldNoticeAuthority,
  releaseRequesterYieldNoticeAuthority,
} from "../registry/subagent-requester-notice-authority.js";
import { useCompletionDatabase } from "./completion-database.test-support.js";
import {
  armRequesterWake,
  records,
  requesterWakeDriver,
  seedSubagentCompletionOwner,
} from "./subagent-completion-admission.test-helpers.js";

vi.mock("../registry/subagent-registry.js", () => ({ resumeSubagentRun: vi.fn() }));

const noticeFault = useSqliteWorkerFault([
  {
    name: "reject_requester_notice",
    match: /^insert into transcript_events\b/iu,
    sql: `CREATE TEMP TRIGGER reject_requester_notice BEFORE INSERT ON main.transcript_events
      BEGIN SELECT RAISE(ABORT, 'transient requester notice append'); END`,
  },
]);

describe("retired requester notice retry", () => {
  const db = useCompletionDatabase("openclaw-subagent-notice-retry-");
  const persistOwner = (input: ReturnType<typeof records>) =>
    seedSubagentCompletionOwner({
      subagent: input.subagent,
      databaseOptions: { database: db.value },
    });
  const stored = (input: ReturnType<typeof records>) =>
    loadSubagentRegistryFromSqlite().get(input.subagent.runId);

  it.each(["retry", "revoked", "reset", "intentional"] as const)(
    "reconciles a retired yielded settlement after an actual notice append failure (%s)",
    async (result) => {
      const input = armRequesterWake(records());
      const requesterRunId = "original-yielded-turn";
      const storePath = path.join(process.env.OPENCLAW_STATE_DIR!, "sessions.json");
      const sessionId = "retry-requester-session";
      const revision = "retry-requester-revision";
      Object.assign(input.subagent, {
        requesterTurnRunId: requesterRunId,
        requesterStorePath: storePath,
        completionRequesterSessionId: sessionId,
        completionRequesterLifecycleRevision: revision,
        completionTarget: "parent",
      });
      Object.assign(input.subagent.requesterSettleWake!, {
        requesterYieldBatch: true,
        requesterRunId,
        retireAfterSettle: true,
      });
      const scope = {
        sessionKey: input.subagent.requesterSessionKey,
        agentId: input.subagent.requesterAgentId,
        storePath,
        sessionId,
      };
      setRuntimeConfigSnapshot({ session: { store: storePath } });
      const operator = await retainedOperatorFixture(
        "retry-notice-owner",
        createContext([], () => ({ session: { store: storePath } })),
      );
      using driver = requesterWakeDriver([input]);
      try {
        await replaceSessionEntry(scope, {
          sessionId,
          lifecycleRevision: revision,
          lifecycleRunId: requesterRunId,
          activeWriterRunId: requesterRunId,
          startedAt: Date.now() - 1000,
          endedAt: Date.now() - 500,
          updatedAt: Date.now(),
        });
        subagentRuns.set(input.subagent.runId, input.subagent);
        const custody = expectDefined(
          await withPluginRuntimeGatewayRequestScope(
            { ...operator, isWebchatConnect: () => false },
            () => captureOperatorToolGatewayContinuationContext(scope),
          ),
          "original requester custody",
        );
        subagentRuns.bindCompletionAuthority(input.subagent, custody);
        const prepared = expectDefined(
          await prepareRequesterYieldNoticeAuthority([input.subagent], subagentRuns),
          "yield notice custody",
        );
        prepared.commit();
        promoteRequesterYieldNoticeAuthority({
          requesterTurnRunId: requesterRunId,
          batch: [input.subagent],
          rearmGeneration: 1,
        });
        // The original turn has ended; delete cleanup now retires the child at settlement.
        input.subagent.requesterTurnRunId = undefined;
        persistOwner(input);
        operator.source.release();
        const release = vi.fn((members: readonly SubagentRunRecord[]) =>
          releaseRequesterYieldNoticeAuthority(members, 1),
        );
        const settle = createRequesterWakeSettlement({
          context: driver.controller,
          scope: "retry-yielded-requester",
          batch: [input.subagent],
          rearmGeneration: 1,
          outcome: {
            delivered: false,
            path: "none",
            disposition:
              result === "intentional" ? "intentional_non_delivery" : "permanent_failure",
            error: "provider failed",
          },
          stateContext: captureOpenClawStateWorkerContext(),
          admittedWake: structuredClone(input.subagent.requesterSettleWake),
          release,
        });
        if (result !== "intentional") {
          noticeFault.enable();
          await expect(settle()).rejects.toThrow("transient requester notice append");
          expect(stored(input)).toBeUndefined();
          expect(subagentRuns.has(input.subagent.runId)).toBe(false);
          expect(await loadTranscriptEvents(scope)).toEqual([]);
          expect(release).not.toHaveBeenCalled();
          noticeFault.disable();
        }
        if (result === "revoked") {
          operator.revoked.abort(new Error("operator revoked"));
        } else if (result === "reset") {
          subagentRuns.clear();
          expect(operator.source.authority.assertCurrent).toThrow();
        }
        await settle();
        const events = await loadTranscriptEvents(scope);
        const reports = events.filter((event) =>
          JSON.stringify(event).includes("run-failed-before-reply"),
        );
        expect(reports).toHaveLength(result === "retry" ? 1 : 0);
        expect(release).toHaveBeenCalledOnce();
        expect(operator.source.authority.assertCurrent).toThrow();
      } finally {
        noticeFault.disable();
        releaseRequesterYieldNoticeAuthority([input.subagent], 1);
        operator.source.release();
        clearRuntimeConfigSnapshot();
      }
    },
  );
});
