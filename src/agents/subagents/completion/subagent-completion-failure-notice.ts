import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { GatewayClientRequestError } from "../../../../packages/gateway-client/src/request-error.js";
import {
  captureOperatorToolGatewayContinuationContext,
  runWithInProcessGatewaySessionMutation,
} from "../../../gateway/server-plugin-in-process-dispatch.js";
import { SessionMutationAuthorizationChangedError } from "../../../gateway/session-mutation-authorization-error.js";
import {
  isOperatorAuthorityUnavailable,
  readOperatorAuthorityFailure,
} from "../../../infra/operator-authority-error.js";
import { getGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import type { SubagentAnnounceDeliveryResult } from "../announce/subagent-announce-dispatch.js";
import { SourceError } from "../registry/subagent-completion-source.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { assertSubagentRegistryWriteSourceCurrent } from "../registry/subagent-registry-persistence.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import { captureRequesterYieldNoticeAuthority } from "../registry/subagent-requester-notice-authority.js";
import { isSameSubagentRunOwner } from "../registry/subagent-run-generation.js";
import type { RequesterWakeCommittedWrite } from "./subagent-completion-mutation.types.js";

export function isSubagentCompletionFailureNoticeRequired(
  outcome: SubagentAnnounceDeliveryResult | undefined,
): boolean {
  return (
    outcome !== undefined &&
    !outcome.delivered &&
    !outcome.storeReplaced &&
    outcome.disposition !== "intentional_non_delivery" &&
    outcome.reason !== "operator_authority_unavailable"
  );
}

/** A committed retirement may report only its fixed diagnostic to the original target. */
export function isHostRetirementFailureNotice(
  outcome: SubagentAnnounceDeliveryResult | undefined,
  entries: readonly SubagentRunRecord[],
): boolean {
  return (
    outcome !== undefined &&
    !outcome.delivered &&
    outcome.reason !== "operator_authority_unavailable" &&
    (outcome.storeReplaced === true ||
      entries.every((entry) => {
        const current = subagentRuns.get(entry.runId);
        return (
          isSameSubagentRunOwner(current, entry) && current?.delivery?.suspendedReason === "expiry"
        );
      }))
  );
}

type PublishFailureNotice = (write: (assertCurrent: () => void) => Promise<void>) => Promise<void>;
const skipNotice: PublishFailureNotice = async () => {};

class FailureNoticeAuthorityDenied extends Error {}

function isAuthorityDenied(error: unknown): boolean {
  return (
    readOperatorAuthorityFailure(error) !== undefined ||
    isOperatorAuthorityUnavailable(error) ||
    collectNestedErrorCandidates(error).some(
      (cause) =>
        cause instanceof FailureNoticeAuthorityDenied ||
        cause instanceof SourceError ||
        cause instanceof SessionMutationAuthorizationChangedError ||
        (cause instanceof GatewayClientRequestError && cause.code === "FORBIDDEN"),
    )
  );
}

/** Settlement may retire batch custody; retain its caller before recording that postimage. */
export async function withSubagentCompletionFailureNoticeAuthority<T>(
  batch: readonly SubagentRunRecord[],
  required: boolean,
  settle: (publish: PublishFailureNotice) => Promise<T>,
  committed?: () => RequesterWakeCommittedWrite | undefined,
): Promise<T> {
  const requester = batch[0];
  if (!required || !requester) {
    return settle(skipNotice);
  }
  const target = {
    sessionKey: requester.requesterSessionKey,
    agentId: requester.requesterAgentId,
    resolveGatewayContext: getGatewayContextResolver(requester),
  };
  let custody: Awaited<ReturnType<typeof captureOperatorToolGatewayContinuationContext>>;
  try {
    custody = await (captureRequesterYieldNoticeAuthority(batch, committed) ??
      subagentRuns.runWithCompletionBatchAuthority(
        batch,
        () => {
          return captureOperatorToolGatewayContinuationContext(target);
        },
        { requireRetainedSource: true },
      ));
  } catch (error) {
    if (isAuthorityDenied(error)) {
      return settle(skipNotice);
    }
    throw error;
  }
  if (!custody) {
    return settle(skipNotice);
  }
  try {
    const source = captureOpenClawStateWorkerContext();
    const assertSourceCurrent = () => {
      // Storage/source preparation errors are not operator denials and must remain observable.
      assertSubagentRegistryWriteSourceCurrent(source);
      if (custody.signal.aborted) {
        throw new FailureNoticeAuthorityDenied("Completion notice custody was revoked", {
          cause: custody.signal.reason,
        });
      }
      custody.assertCurrent();
    };
    const publish: PublishFailureNotice = async (write) => {
      try {
        assertSourceCurrent();
        await custody.run(() =>
          runWithInProcessGatewaySessionMutation(target, async (assertTargetCurrent) => {
            const assertCurrent = () => {
              assertSourceCurrent();
              assertTargetCurrent();
            };
            assertCurrent();
            await write(assertCurrent);
          }),
        );
      } catch (error) {
        if (!isAuthorityDenied(error)) {
          throw error;
        }
        // Retire the obligation without a new transcript effect under revoked authority.
      }
    };
    return await settle(publish);
  } finally {
    custody?.release();
  }
}
