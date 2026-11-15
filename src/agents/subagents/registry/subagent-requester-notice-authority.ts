import { isDeepStrictEqual } from "node:util";
import { captureOperatorToolGatewayContinuationContext } from "../../../gateway/server-plugin-in-process-dispatch.js";
import { captureSystemEventStoreCurrentCheck } from "../../../infra/system-event-ownership.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import type { RequesterWakeCommittedWrite } from "../completion/subagent-completion-mutation.types.js";
import { SourceError } from "./subagent-completion-source.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { assertSubagentRegistryWriteSourceCurrent } from "./subagent-registry-persistence.js";
import { subscribeSubagentRunChanges } from "./subagent-registry-publication.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import {
  getSubagentRunRuntimeKey,
  isSameSubagentRunOwner,
  isSameSubagentRun,
} from "./subagent-run-generation.js";

type Custody = NonNullable<
  Awaited<ReturnType<typeof captureOperatorToolGatewayContinuationContext>>
>;
type YieldNoticeAuthority = {
  batch: readonly SubagentRunRecord[];
  runs: ReadonlyMap<string, SubagentRunRecord>;
  custody: Custody;
  requesterTurnRunId: string;
  rearmGeneration?: number;
  assertTarget(committed?: RequesterWakeCommittedWrite): void;
  release: () => void;
};
const byEntry = new WeakMap<object, YieldNoticeAuthority>();
const retained = new Set<YieldNoticeAuthority>();
const noticeTarget = (entry: SubagentRunRecord) => [
  entry.requesterAgentId,
  entry.requesterSessionKey,
  entry.requesterStorePath,
  entry.completionRequesterSessionId,
  entry.completionRequesterLifecycleRevision,
];

function assertCohort(authority: YieldNoticeAuthority, batch: readonly SubagentRunRecord[]): void {
  if (
    batch.length !== authority.batch.length ||
    !authority.batch.every((expected) =>
      batch.some((entry) => isSameSubagentRunOwner(entry, expected)),
    ) ||
    batch.some((entry) => !isSameSubagentRunOwner(authority.runs.get(entry.runId), entry))
  ) {
    throw new SourceError("Requester notice lost its admitted yield cohort");
  }
  authority.assertTarget();
}

/** Retain the original cohort's source before yield can retire child execution custody. */
export async function prepareRequesterYieldNoticeAuthority(
  batch: readonly SubagentRunRecord[],
  runs: ReadonlyMap<string, SubagentRunRecord>,
) {
  const requester = batch[0];
  if (!requester || !requester.completionRequesterSessionId || !requester.requesterTurnRunId) {
    return undefined;
  }
  const target = noticeTarget(requester);
  if (
    batch.some(
      (entry) =>
        !isDeepStrictEqual(noticeTarget(entry), target) ||
        entry.requesterTurnRunId !== requester.requesterTurnRunId,
    )
  ) {
    throw new SourceError("Requester notice requires one exact requester target");
  }
  let custody: Custody | undefined;
  try {
    custody = await subagentRuns.runWithCompletionBatchAuthority(
      batch,
      () =>
        captureOperatorToolGatewayContinuationContext({
          sessionKey: requester.requesterSessionKey,
          agentId: requester.requesterAgentId,
        }),
      { requireRetainedSource: true },
    );
  } catch (error) {
    // Legacy rows do not acquire permission from the yield caller or host.
    if (error instanceof SourceError) {
      return undefined;
    }
    throw error;
  }
  if (!custody) {
    return undefined;
  }
  try {
    const source = captureOpenClawStateWorkerContext();
    const storeCurrent = captureSystemEventStoreCurrentCheck(
      requester.requesterSessionKey,
      requester.requesterAgentId,
    );
    const registryOwner = subagentRuns.readLookup;
    const assertTarget = (committed?: RequesterWakeCommittedWrite) => {
      assertSubagentRegistryWriteSourceCurrent(source);
      if (
        subagentRuns.readLookup !== registryOwner ||
        !storeCurrent(requester.requesterStorePath) ||
        batch.some((entry) => !isDeepStrictEqual(noticeTarget(entry), target)) ||
        batch.some((entry) => {
          const current = runs.get(entry.runId);
          return current
            ? !isSameSubagentRunOwner(current, entry) ||
                !isDeepStrictEqual(noticeTarget(current), target)
            : !(
                committed?.result.applied === true &&
                committed.result.retiredRunIds.includes(entry.runId) &&
                committed.entries.some(({ subagent }) => isSameSubagentRunOwner(subagent, entry))
              );
        })
      ) {
        throw new SourceError("Requester notice target or store changed");
      }
    };
    const authority: YieldNoticeAuthority = {
      batch: [...batch],
      runs,
      custody,
      assertTarget,
      requesterTurnRunId: requester.requesterTurnRunId,
      release: () => {
        retained.delete(authority);
        for (const entry of authority.batch) {
          const key = getSubagentRunRuntimeKey(entry);
          if (byEntry.get(key) === authority) {
            byEntry.delete(key);
          }
        }
        custody.signal.removeEventListener("abort", authority.release);
        custody.release();
      },
    };
    assertCohort(authority, batch);
    custody.assertCurrent();
    return {
      commit() {
        assertCohort(authority, batch);
        custody.assertCurrent();
        for (const entry of batch) {
          byEntry.get(getSubagentRunRuntimeKey(entry))?.release();
        }
        for (const entry of batch) {
          byEntry.set(getSubagentRunRuntimeKey(entry), authority);
        }
        retained.add(authority);
        custody.signal.addEventListener("abort", authority.release, { once: true });
      },
      release: authority.release,
    };
  } catch (error) {
    custody.release();
    throw error;
  }
}

/** Bind the retained parent to the exact committed wake generation before scheduling it. */
export function promoteRequesterYieldNoticeAuthority(params: {
  requesterTurnRunId: string;
  batch: readonly SubagentRunRecord[];
  rearmGeneration: number | undefined;
}): void {
  const authority = params.batch[0] && byEntry.get(getSubagentRunRuntimeKey(params.batch[0]));
  if (!authority) {
    return;
  }
  if (
    params.requesterTurnRunId !== authority.requesterTurnRunId ||
    params.rearmGeneration === undefined
  ) {
    authority.release();
    return;
  }
  assertCohort(authority, params.batch);
  authority.rearmGeneration = params.rearmGeneration;
}

/** A captured receipt survives its own settlement, but never source/target revocation. */
export function captureRequesterYieldNoticeAuthority(
  batch: readonly SubagentRunRecord[],
  committed?: () => RequesterWakeCommittedWrite | undefined,
): Promise<Custody> | undefined {
  const authorities = batch.map((entry) => byEntry.get(getSubagentRunRuntimeKey(entry)));
  const authority = authorities.find((value) => value !== undefined);
  if (!authority) {
    return undefined;
  }
  if (authorities.some((value) => value !== authority)) {
    throw new SourceError("Requester notice sources do not share the admitted yield cohort");
  }
  assertCohort(authority, batch);
  if (
    authority.rearmGeneration === undefined ||
    batch.some(
      (entry) =>
        entry.requesterSettleWake?.rearmGeneration !== authority.rearmGeneration ||
        (entry.requesterSettleWake?.requesterRunId !== undefined &&
          entry.requesterSettleWake?.requesterRunId !== authority.requesterTurnRunId),
    )
  ) {
    throw new SourceError("Requester notice yield generation changed");
  }
  return authority.custody.run(async () => {
    const custody = await captureOperatorToolGatewayContinuationContext();
    if (!custody) {
      throw new SourceError("Requester yield notice lost its retained source");
    }
    const assertCurrent = () => {
      const receipt = committed?.();
      authority.assertTarget(receipt);
      for (const entry of batch) {
        const current = authority.runs.get(entry.runId);
        const wake = current?.requesterSettleWake;
        if (
          current &&
          (wake
            ? wake.rearmGeneration !== authority.rearmGeneration ||
              (wake.requesterRunId !== undefined &&
                wake.requesterRunId !== authority.requesterTurnRunId)
            : !(
                receipt?.result.applied === true &&
                receipt.entries.some(({ subagent }) => isSameSubagentRunOwner(subagent, entry)) &&
                receipt.result.records.some(
                  ({ subagent }) =>
                    isSameSubagentRun(subagent, entry) &&
                    isDeepStrictEqual(noticeTarget(subagent), noticeTarget(entry)) &&
                    subagent.requesterSettleWake === undefined,
                )
              ))
        ) {
          throw new SourceError("Requester notice no longer owns its settlement generation");
        }
      }
      custody.assertCurrent();
    };
    try {
      assertCurrent();
      return { ...custody, assertCurrent };
    } catch (error) {
      custody.release();
      throw error;
    }
  });
}

export function releaseRequesterYieldNoticeAuthority(
  batch: readonly SubagentRunRecord[],
  rearmGeneration: number | undefined,
): void {
  for (const entry of batch) {
    const authority = byEntry.get(getSubagentRunRuntimeKey(entry));
    if (
      authority &&
      rearmGeneration !== undefined &&
      authority.rearmGeneration === rearmGeneration
    ) {
      authority.release();
    }
  }
}

// Registry deletion/replacement/reset closes retained holders; publication never mints permission.
subscribeSubagentRunChanges("projection", () => {
  for (const authority of retained) {
    if (
      authority.batch.some(
        (entry) => !isSameSubagentRunOwner(authority.runs.get(entry.runId), entry),
      )
    ) {
      authority.release();
    }
  }
});
