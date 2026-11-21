import { afterEach, describe, expect, it, vi } from "vitest";
import * as gateway from "../../../gateway/server-plugin-in-process-dispatch.js";
import { createContext } from "../../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { sessionMutationForbiddenError } from "../../../gateway/session-mutation-authorization-error.js";
import { createOperatorAuthorityInactiveError } from "../../../infra/operator-authority-error.js";
import { withPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import * as stateContext from "../../../state/openclaw-state-worker-context.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import * as source from "../registry/subagent-registry-persistence.js";
import { publishSubagentRunChanges } from "../registry/subagent-registry-publication.js";
import { retainedOperatorFixture } from "../registry/subagent-registry.completed-followup-authority.test-support.js";
import {
  prepareRequesterYieldNoticeAuthority,
  promoteRequesterYieldNoticeAuthority,
  releaseRequesterYieldNoticeAuthority,
  captureRequesterYieldNoticeAuthority,
  retainRequesterYieldNoticeSettlement,
} from "../registry/subagent-requester-notice-authority.js";
import {
  isSameSubagentRunOwner,
  copySubagentRunRuntimeOwner,
} from "../registry/subagent-run-generation.js";
import {
  isSubagentCompletionFailureNoticeRequired,
  withSubagentCompletionFailureNoticeAuthority,
} from "./subagent-completion-failure-notice.js";
import type { RequesterWakeCommittedWrite } from "./subagent-completion-mutation.types.js";

vi.mock("../../../gateway/server-plugin-in-process-dispatch.js", { spy: true });
vi.mock("../registry/subagent-registry-persistence.js", { spy: true });
vi.mock("../../../state/openclaw-state-worker-context.js", { spy: true });

afterEach(() => vi.restoreAllMocks());

function fixture() {
  vi.clearAllMocks();
  const batch = [createSubagentRunRecord({ runId: "failure-notice-child" })];
  const release = vi.fn();
  let revoked = false;
  const assertCurrent = () => {
    if (revoked) {
      throw createOperatorAuthorityInactiveError("source-invalidated", "source-current", 0);
    }
  };
  const batchAuthority = vi
    .spyOn(subagentRuns, "runWithCompletionBatchAuthority")
    .mockImplementation((_batch, run) => run());
  vi.mocked(source.assertSubagentRegistryWriteSourceCurrent).mockImplementation(() => {});
  vi.mocked(gateway.captureOperatorToolGatewayContinuationContext).mockResolvedValue({
    assertCurrent,
    operatorAuthority: undefined,
    scopes: ["operator.write"],
    signal: new AbortController().signal,
    release,
    run: (run) => {
      assertCurrent();
      return run();
    },
    runWithRequester: (run) => {
      assertCurrent();
      return run();
    },
  });
  vi.mocked(gateway.runWithInProcessGatewaySessionMutation).mockImplementation((_target, run) =>
    Promise.resolve(run(assertCurrent, createContext())),
  );
  return {
    batch,
    release,
    batchAuthority,
    revoke: () => {
      revoked = true;
    },
  };
}

describe("completion failure notice authority", () => {
  it("retains the requester across settlement and publishes an authorized failure", async () => {
    const { batch, release } = fixture();
    const writes: string[] = [];
    await withSubagentCompletionFailureNoticeAuthority(batch, true, async (publish) => {
      // Settlement has released the original batch's custody. The captured source survives.
      vi.spyOn(subagentRuns, "runWithCompletionBatchAuthority").mockImplementation(() => {
        throw new Error("original batch retired");
      });
      await publish(async (assertCurrent) => {
        assertCurrent();
        writes.push("provider failure");
      });
      expect(release).not.toHaveBeenCalled();
    });
    expect(writes).toEqual(["provider failure"]);
    expect(release).toHaveBeenCalledOnce();
  });

  it.each(["source", "target"])(
    "refuses a %s revoke at the delayed write boundary",
    async (kind) => {
      const { batch, release, revoke } = fixture();
      let targetRevoked = false;
      vi.mocked(gateway.runWithInProcessGatewaySessionMutation).mockImplementation((_target, run) =>
        Promise.resolve(
          run(() => {
            if (targetRevoked) {
              throw sessionMutationForbiddenError("Requester removed from audience");
            }
          }, createContext()),
        ),
      );
      const writes: string[] = [];
      let settled = false;
      await withSubagentCompletionFailureNoticeAuthority(batch, true, async (publish) => {
        settled = true;
        await publish(async (assertCurrent) => {
          await Promise.resolve();
          if (kind === "source") {
            revoke();
          } else {
            targetRevoked = true;
          }
          assertCurrent();
          writes.push("unauthorized notice");
        });
      });
      expect(settled).toBe(true);
      expect(writes).toEqual([]);
      expect(release).toHaveBeenCalledOnce();
    },
  );

  it("settles a typed source-revoked capture without publishing or impersonating a caller", async () => {
    const { batch } = fixture();
    vi.mocked(gateway.captureOperatorToolGatewayContinuationContext).mockRejectedValue(
      createOperatorAuthorityInactiveError("source-invalidated", "source-revocation", 0),
    );
    const write = vi.fn();
    const settled = await withSubagentCompletionFailureNoticeAuthority(
      batch,
      true,
      async (publish) => {
        await publish(write);
        return true;
      },
    );
    expect(settled).toBe(true);
    expect(write).not.toHaveBeenCalled();
    expect(gateway.runWithInProcessGatewaySessionMutation).not.toHaveBeenCalled();
  });

  it("does not borrow an ambient caller for a legacy row without retained custody", async () => {
    const { batch, batchAuthority } = fixture();
    batchAuthority.mockRestore();
    const write = vi.fn();
    await withSubagentCompletionFailureNoticeAuthority(batch, true, async (publish) => {
      await publish(write);
    });
    expect(gateway.captureOperatorToolGatewayContinuationContext).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("propagates an unexpected registry lookup failure before capture", async () => {
    const { batch, batchAuthority } = fixture();
    const error = new Error("fixture registry lookup failed");
    batchAuthority.mockImplementation(() => {
      throw error;
    });
    const settle = vi.fn();
    await expect(withSubagentCompletionFailureNoticeAuthority(batch, true, settle)).rejects.toBe(
      error,
    );
    expect(settle).not.toHaveBeenCalled();
    expect(gateway.captureOperatorToolGatewayContinuationContext).not.toHaveBeenCalled();
  });

  it.each(["capture", "guard"] as const)(
    "propagates unexpected state %s failure and releases custody",
    async (phase) => {
      const { batch, release } = fixture();
      const error = new Error("fixture state admission failed");
      if (phase === "capture") {
        vi.spyOn(stateContext, "captureOpenClawStateWorkerContext").mockImplementationOnce(() => {
          throw error;
        });
      } else {
        vi.mocked(source.assertSubagentRegistryWriteSourceCurrent).mockImplementation(() => {
          throw error;
        });
      }
      const write = vi.fn();
      await expect(
        withSubagentCompletionFailureNoticeAuthority(batch, true, async (publish) => {
          await publish(write);
        }),
      ).rejects.toBe(error);
      expect(write).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
    },
  );

  it("preserves a storage error instead of classifying it as revoked authority", async () => {
    const { batch, release } = fixture();
    const error = new Error("fixture storage write failed");
    await expect(
      withSubagentCompletionFailureNoticeAuthority(batch, true, async (publish) => {
        await publish(async () => {
          throw error;
        });
      }),
    ).rejects.toBe(error);
    expect(release).toHaveBeenCalledOnce();
  });

  it("does not manufacture a failure from retirement or intentional nondelivery", () => {
    expect(isSubagentCompletionFailureNoticeRequired(undefined)).toBe(false);
    for (const outcome of [
      { disposition: "intentional_non_delivery" as const },
      { storeReplaced: true as const },
      { reason: "operator_authority_unavailable" as const },
    ]) {
      expect(
        isSubagentCompletionFailureNoticeRequired({ delivered: false, path: "none", ...outcome }),
      ).toBe(false);
    }
    expect(
      isSubagentCompletionFailureNoticeRequired({
        delivered: false,
        path: "none",
        disposition: "permanent_failure",
      }),
    ).toBe(true);
  });
});

async function withYieldNoticeFixture(
  run: (value: {
    batch: ReturnType<typeof createSubagentRunRecord>[];
    revoked: AbortController;
    authority: Awaited<ReturnType<typeof retainedOperatorFixture>>["source"]["authority"];
  }) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const mocked = fixture();
    mocked.batchAuthority.mockRestore();
    vi.mocked(gateway.captureOperatorToolGatewayContinuationContext).mockRestore();
    const original = await retainedOperatorFixture("yield-notice-requester");
    const batch = ["alpha", "beta"].map((name) =>
      createSubagentRunRecord({
        runId: "yield-notice-" + name,
        requesterAgentId: "main",
        requesterSessionKey: "agent:main:main",
        requesterStorePath: "original-store",
        requesterTurnRunId: "original-requester",
        completionRequesterSessionId: "original-session",
        completionRequesterLifecycleRevision: "original-revision",
      }),
    );
    try {
      for (const entry of batch) {
        subagentRuns.set(entry.runId, entry);
        const custody = await withPluginRuntimeGatewayRequestScope(
          { ...original, isWebchatConnect: () => false },
          () => gateway.captureOperatorToolGatewayContinuationContext(),
        );
        expect(custody?.operatorAuthority?.source).toBe(original.source.authority.source);
        expect(custody?.operatorAuthority?.invocation).toBe(original.source.authority.invocation);
        if (!custody) {
          throw new Error("Missing original requester custody");
        }
        subagentRuns.bindCompletionAuthority(entry, custody);
      }
      const prepared = await prepareRequesterYieldNoticeAuthority(batch, subagentRuns);
      expect(prepared).toBeDefined();
      prepared?.commit();
      for (const entry of batch) {
        entry.requesterSettleWake = {
          status: "pending",
          attemptCount: 0,
          requesterYieldBatch: true,
          requesterRunId: "original-requester",
          rearmGeneration: 1,
          batchRunIds: batch.map((member) => member.runId),
        };
      }
      promoteRequesterYieldNoticeAuthority({
        requesterTurnRunId: "original-requester",
        batch,
        rearmGeneration: 1,
      });
      original.source.release();
      await run({ batch, revoked: original.revoked, authority: original.source.authority });
    } finally {
      releaseRequesterYieldNoticeAuthority(batch, 1);
      subagentRuns.clear();
      original.source.release();
    }
  });
}

describe("yielded requester failure notice custody", () => {
  it.each(["retired", "stable"] as const)(
    "keeps the admitted parent notice after %s child execution retirement",
    async (kind) =>
      withYieldNoticeFixture(async ({ batch, authority }) => {
        if (kind === "stable") {
          for (const entry of batch) {
            delete entry.requesterSettleWake!.requesterRunId;
          }
        }
        subagentRuns.retireCompletionAuthority(batch[1]!);
        expect(() => subagentRuns.runWithCompletionBatchAuthority(batch, () => {})).toThrow();
        const writes: string[] = [];
        let committed: RequesterWakeCommittedWrite | undefined;
        await withSubagentCompletionFailureNoticeAuthority(
          batch,
          true,
          async (publish) => {
            committed = {
              entries: batch.map((subagent) => ({ subagent })),
              result: {
                applied: true,
                records: [],
                retiredRunIds: batch.map((entry) => entry.runId),
              },
            };
            releaseRequesterYieldNoticeAuthority(batch, 1);
            for (const entry of batch) {
              subagentRuns.releaseCompletionAuthority(entry);
              subagentRuns.delete(entry.runId);
            }
            await publish(async (assertCurrent) => {
              assertCurrent();
              writes.push("generic failure");
            });
          },
          () => committed,
        );
        expect(writes).toEqual(["generic failure"]);
        expect(gateway.runWithInProcessGatewaySessionMutation).toHaveBeenCalledOnce();
        expect(authority.assertCurrent).toThrow();
      }),
  );

  it("retries a transient notice failure after its committed retirement publication", async () =>
    withYieldNoticeFixture(async ({ batch }) => {
      let committed: RequesterWakeCommittedWrite | undefined;
      retainRequesterYieldNoticeSettlement(batch, () => committed);
      const write = vi
        .fn()
        .mockRejectedValueOnce(new Error("transient append failure"))
        .mockResolvedValue(undefined);
      const attempt = () =>
        withSubagentCompletionFailureNoticeAuthority(
          batch,
          true,
          async (publish) => {
            if (!committed) {
              committed = {
                entries: batch.map((subagent) => ({ subagent })),
                result: {
                  applied: true,
                  records: [],
                  retiredRunIds: batch.map((entry) => entry.runId),
                },
              };
              for (const entry of batch) {
                subagentRuns.delete(entry.runId);
              }
              publishSubagentRunChanges();
            }
            await publish(write);
          },
          () => committed,
        );
      await expect(attempt()).rejects.toThrow("transient append failure");
      await expect(attempt()).resolves.toBeUndefined();
      expect(write).toHaveBeenCalledTimes(2);
    }));

  it("accepts an acknowledged retained-row postimage without a serialized runtime key", async () =>
    withYieldNoticeFixture(async ({ batch }) => {
      let committed: RequesterWakeCommittedWrite | undefined;
      const writes: string[] = [];
      await withSubagentCompletionFailureNoticeAuthority(
        batch,
        true,
        async (publish) => {
          const records = batch.map((entry) => {
            const subagent = structuredClone(entry);
            subagent.requesterSettleWake = undefined;
            expect(isSameSubagentRunOwner(subagent, entry)).toBe(false);
            subagentRuns.set(entry.runId, copySubagentRunRuntimeOwner(entry, { ...subagent }));
            return { subagent };
          });
          committed = {
            entries: batch.map((subagent) => ({ subagent })),
            result: { applied: true, records, retiredRunIds: [] },
          };
          await publish(async (assertCurrent) => {
            assertCurrent();
            writes.push("retained row failure");
          });
        },
        () => committed,
      );
      expect(writes).toEqual(["retained row failure"]);
    }));

  it("does not capture notice authority from an unbound yield", async () => {
    const mocked = fixture();
    mocked.batchAuthority.mockRestore();
    const entry = mocked.batch[0]!;
    entry.requesterTurnRunId = "unbound";
    entry.completionRequesterSessionId = "session";
    subagentRuns.set(entry.runId, entry);
    try {
      await expect(
        prepareRequesterYieldNoticeAuthority([entry], subagentRuns),
      ).resolves.toBeUndefined();
      expect(gateway.captureOperatorToolGatewayContinuationContext).not.toHaveBeenCalled();
    } finally {
      subagentRuns.clear();
    }
  });

  it.each(["generation", "requester", "target", "replacement", "missing", "mixed"] as const)(
    "rejects %s drift before capturing a yielded receipt",
    async (drift) =>
      withYieldNoticeFixture(async ({ batch }) => {
        if (drift === "generation") {
          batch[1]!.requesterSettleWake!.rearmGeneration = 2;
        }
        if (drift === "requester") {
          batch[1]!.requesterSettleWake!.requesterRunId = "other-requester";
        }
        if (drift === "target") {
          batch[1]!.completionRequesterSessionId = "other-session";
        }
        if (drift === "replacement") {
          subagentRuns.set(
            batch[1]!.runId,
            createSubagentRunRecord({
              ...batch[1]!,
              generation: (batch[1]!.generation ?? 1) + 1,
            }),
          );
        }
        if (drift === "missing") {
          subagentRuns.delete(batch[1]!.runId);
        }
        const selected = drift === "mixed" ? [batch[0]!] : batch;
        const write = vi.fn();
        await withSubagentCompletionFailureNoticeAuthority(selected, true, async (publish) => {
          await publish(write);
        });
        expect(write).not.toHaveBeenCalled();
        expect(gateway.runWithInProcessGatewaySessionMutation).not.toHaveBeenCalled();
      }),
  );

  it.each(["deletion", "reset", "generation", "target", "foreign receipt"] as const)(
    "rejects external %s after capturing the parent receipt",
    async (change) =>
      withYieldNoticeFixture(async ({ batch }) => {
        let committed: RequesterWakeCommittedWrite | undefined;
        const writes: string[] = [];
        await withSubagentCompletionFailureNoticeAuthority(
          batch,
          true,
          async (publish) => {
            if (change === "reset") {
              subagentRuns.clear();
            } else if (change === "generation") {
              batch[1]!.requesterSettleWake!.rearmGeneration = 2;
            } else if (change === "target") {
              batch[1]!.completionRequesterSessionId = "replaced-session";
            } else {
              subagentRuns.delete(batch[1]!.runId);
              if (change === "foreign receipt") {
                committed = {
                  entries: [{ subagent: batch[0]! }],
                  result: { applied: true, records: [], retiredRunIds: [batch[1]!.runId] },
                };
              }
            }
            await publish(async (assertCurrent) => {
              assertCurrent();
              writes.push("unauthorized");
            });
          },
          () => committed,
        );
        expect(writes).toEqual([]);
      }),
  );

  it("keeps source revocation effective after capturing the parent receipt", async () =>
    withYieldNoticeFixture(async ({ batch, revoked }) => {
      subagentRuns.retireCompletionAuthority(batch[1]!);
      const write = vi.fn();
      await withSubagentCompletionFailureNoticeAuthority(batch, true, async (publish) => {
        revoked.abort(new Error("requester access revoked"));
        await publish(write);
      });
      expect(write).not.toHaveBeenCalled();
      expect(gateway.runWithInProcessGatewaySessionMutation).not.toHaveBeenCalled();
    }));

  it("propagates a state storage failure through the retained parent receipt", async () =>
    withYieldNoticeFixture(async ({ batch }) => {
      const failure = new Error("state lookup failed");
      const write = vi.fn();
      await expect(
        withSubagentCompletionFailureNoticeAuthority(batch, true, async (publish) => {
          vi.mocked(source.assertSubagentRegistryWriteSourceCurrent).mockImplementation(() => {
            throw failure;
          });
          await publish(write);
        }),
      ).rejects.toBe(failure);
      expect(write).not.toHaveBeenCalled();
    }));

  it("releases parent custody on registry reset without borrowing an ambient caller", async () =>
    withYieldNoticeFixture(async ({ batch, authority }) => {
      subagentRuns.clear();
      expect(captureRequesterYieldNoticeAuthority(batch)).toBeUndefined();
      expect(authority.assertCurrent).toThrow();
      const write = vi.fn();
      await withSubagentCompletionFailureNoticeAuthority(batch, true, async (publish) => {
        await publish(write);
      });
      expect(write).not.toHaveBeenCalled();
    }));
});
