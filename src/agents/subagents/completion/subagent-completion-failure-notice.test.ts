import { afterEach, describe, expect, it, vi } from "vitest";
import * as gateway from "../../../gateway/server-plugin-in-process-dispatch.js";
import { createContext } from "../../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { sessionMutationForbiddenError } from "../../../gateway/session-mutation-authorization-error.js";
import { createOperatorAuthorityInactiveError } from "../../../infra/operator-authority-error.js";
import * as stateContext from "../../../state/openclaw-state-worker-context.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import * as source from "../registry/subagent-registry-persistence.js";
import {
  isSubagentCompletionFailureNoticeRequired,
  withSubagentCompletionFailureNoticeAuthority,
} from "./subagent-completion-failure-notice.js";

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
