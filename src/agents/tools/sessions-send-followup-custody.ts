import { getRuntimeConfig } from "../../config/config.js";
import { operatorRoleSubject } from "../../gateway/operator-role-enforcement.js";
import {
  resolveGatewayOperatorRoleActor,
  resolveOperatorRolePolicyForAssignment,
} from "../../gateway/operator-role-policy.js";
import { captureOperatorToolGatewayContinuationContext } from "../../gateway/server-plugin-in-process-dispatch.js";
import { authorizePreparedSessionMutation } from "../../gateway/session-sharing-policy.js";
import { prepareSessionMutationFacts } from "../../gateway/session-sharing-preparation.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { assertionSucceeds } from "../../shared/assertion.js";
import { prepareUserProfileRoleAuthority } from "../../state/user-channel-identity-operations.js";
import type { FollowupRequest } from "../subagents/completion/session-followup-completion.types.js";
import { captureRequesterFollowupAuthority } from "../subagents/requester-cron-authority.js";
import {
  captureGatewayToolCallerAssertion,
  getGatewayToolCallerIdentity,
} from "./gateway-caller-context.js";

type FollowupAccessPhase = "admission" | "revocation";
type FollowupAccessEndpoint = "requester" | "child";
type FollowupAccessCode = "INVALID_REQUEST" | "FORBIDDEN" | "UNAVAILABLE";

// Private custody errors never expose session identities or policy details to tool callers.
class FollowupAccessChangedError extends Error {
  constructor(
    message: string,
    readonly phase: FollowupAccessPhase,
    readonly endpoint: FollowupAccessEndpoint,
    readonly code: FollowupAccessCode,
  ) {
    super(message);
  }
}

/** Public, bounded projection of this owner's own admission or revocation verdict. */
export function readFollowupAccessDenial(error: unknown) {
  if (!(error instanceof FollowupAccessChangedError)) return undefined;
  return {
    error: "Ask an authorized operator to check continuation access for both conversations.",
    followupAccess: {
      phase: error.phase,
      endpoint: error.endpoint,
      code: error.code,
    },
  };
}

function publicFollowupAccessCode(code: string): FollowupAccessCode {
  return code === "INVALID_REQUEST" || code === "UNAVAILABLE" ? code : "FORBIDDEN";
}

/** Prepare current facts through their worker owner; no stored identity becomes authority. */
export async function prepareSessionsSendFollowup(params: {
  runId: string;
  requesterTurnRunId?: string;
  withRequesterAuthority?: <T>(run: () => T) => T;
  requesterAgentId: string;
  requesterSessionKey: string;
  targetAgentId: string;
  targetSessionKey: string;
}): Promise<FollowupRequest | undefined> {
  const caller = getGatewayToolCallerIdentity();
  if (!caller) {
    return undefined;
  }
  const assertInvocation = captureGatewayToolCallerAssertion();
  assertInvocation?.();
  if (
    caller.agentId !== params.requesterAgentId ||
    caller.sessionKey !== params.requesterSessionKey
  ) {
    throw new Error("Followup result requester differs from its admitted tool caller.");
  }
  const captured = await captureOperatorToolGatewayContinuationContext();
  if (!captured) {
    throw new Error("Followup completion requires in-process caller custody.");
  }
  const facts: Awaited<ReturnType<typeof prepareSessionMutationFacts>>[] = [];
  const revoked = new AbortController();
  const signal = AbortSignal.any([captured.signal, revoked.signal]);
  let stopAccessWatch: (() => void) | undefined;
  let released = false;
  let observationReleased = false;
  // Custody is admitted only once preparation is complete and ownership is returned.
  let custodyAdmitted = false;
  const denialPhase = (): FollowupAccessPhase => (custodyAdmitted ? "revocation" : "admission");
  let authorityReleased = true;
  let requesterAuthority: ReturnType<typeof captureRequesterFollowupAuthority>;
  const releaseResources = () => {
    if (released || !observationReleased || !authorityReleased) {
      return;
    }
    released = true;
    stopAccessWatch?.();
    for (const read of facts) {
      read.release();
    }
    captured.release();
  };
  const release = () => {
    if (observationReleased) {
      return;
    }
    observationReleased = true;
    requesterAuthority?.release();
    releaseResources();
  };
  try {
    assertInvocation?.();
    const cfg = getRuntimeConfig();
    const client = captured.run(() => getPluginRuntimeGatewayRequestScope()?.client);
    const actor = resolveGatewayOperatorRoleActor(client ?? null);
    if (!client || !actor) {
      throw new Error("Followup has no retained original caller policy.");
    }
    const policyClient = {
      ...client,
      connect: { ...client.connect, scopes: [...(client.connect.scopes ?? [])] },
      internal: { ...client.internal, operatorRoleActor: { ...actor } },
    };
    const profile =
      actor.kind === "operator"
        ? await prepareUserProfileRoleAuthority(actor.profileId)
        : undefined;
    if (actor.kind === "operator" && (!profile || profile.profileId !== actor.profileId)) {
      throw new FollowupAccessChangedError(
        "Followup requester profile is unavailable.",
        denialPhase(),
        "requester",
        "FORBIDDEN",
      );
    }
    assertInvocation?.();
    for (const target of [
      {
        agentId: params.requesterAgentId,
        sessionKey: params.requesterSessionKey,
        followLifecycle: true,
      },
      { agentId: params.targetAgentId, sessionKey: params.targetSessionKey },
    ]) {
      facts.push(await prepareSessionMutationFacts({ cfg, ...target }));
      assertInvocation?.();
      captured.assertCurrent();
    }
    const assertCurrent = () => {
      signal.throwIfAborted();
      if (released) {
        throw new Error("Followup completion custody was released.");
      }
      captured.assertCurrent();
      if (profile && !profile.isCurrent()) {
        throw new FollowupAccessChangedError(
          "Followup requester identity changed.",
          denialPhase(),
          "requester",
          "FORBIDDEN",
        );
      }
      const currentConfig = getRuntimeConfig();
      // The prepared reader owns canonical routing, physical store and incarnation fencing.
      for (const [index, read] of facts.entries()) {
        const endpoint: FollowupAccessEndpoint = index === 0 ? "requester" : "child";
        const currentFacts = read.readCurrent(currentConfig);
        const current = currentFacts.target;
        if (!current?.entry || current.entry.archivedAt !== undefined) {
          throw new FollowupAccessChangedError(
            "Followup conversation was archived.",
            denialPhase(),
            endpoint,
            "INVALID_REQUEST",
          );
        }
        const denied = authorizePreparedSessionMutation(
          {
            cfg: currentConfig,
            client: policyClient,
            sessionKey: read.storageTarget.canonicalKey,
            agentId: read.storageTarget.agentId,
          },
          currentFacts,
          {
            policy:
              actor.kind === "system"
                ? undefined
                : resolveOperatorRolePolicyForAssignment(
                    actor.profileId,
                    profile?.role ?? null,
                    currentConfig,
                    profile?.githubLogin ?? null,
                    operatorRoleSubject(profile),
                  ),
            aliases: new Set(profile?.aliases ?? []),
          },
        );
        if (denied) {
          throw new FollowupAccessChangedError(
            "Followup session access was revoked.",
            denialPhase(),
            endpoint,
            publicFollowupAccessCode(denied.code),
          );
        }
      }
    };
    assertCurrent();
    const watchedKeys = new Set(
      facts.flatMap((read) => {
        const target = read.readCurrent(cfg).target;
        return [target.canonicalKey, target.storeKey, ...target.storeKeys];
      }),
    );
    stopAccessWatch = sessionChanges.subscribe((change) => {
      if ("sessionKey" in change && !watchedKeys.has(change.sessionKey)) {
        return;
      }
      try {
        assertCurrent();
      } catch (error) {
        // Pending metadata remains fenced. A committed denial is irreversible for this capture.
        if (error instanceof FollowupAccessChangedError) {
          revoked.abort(error);
        }
      }
    });
    const requesterSessionId = facts[0]!.readCurrent(getRuntimeConfig()).target.entry.sessionId;
    if (params.requesterTurnRunId && params.withRequesterAuthority) {
      const requesterTurnRunId = params.requesterTurnRunId;
      requesterAuthority = params.withRequesterAuthority(() =>
        captureRequesterFollowupAuthority({
          requesterTurnRunId,
          requesterAgentId: params.requesterAgentId,
          requesterSessionKey: params.requesterSessionKey,
          requesterSessionId,
          sourceSessionKey: params.targetSessionKey,
          release: () => {
            authorityReleased = true;
            releaseResources();
          },
          isCurrent: () => assertionSucceeds(assertCurrent),
        }),
      );
      // The observer and the admitted parent share the prepared custody. Either
      // can finish first; release its readers only after both owners are done.
      authorityReleased = requesterAuthority === undefined;
    }
    custodyAdmitted = true;
    return {
      runId: params.runId,
      requesterSessionKey: params.requesterSessionKey,
      requesterSessionId,
      requesterAuthority,
      requesterAgentId: params.requesterAgentId,
      targetSessionKey: params.targetSessionKey,
      targetAgentId: params.targetAgentId,
      custody: {
        signal,
        assertCurrent,
        release,
        run<T>(work: () => T): T {
          assertCurrent();
          return captured.run(work);
        },
      },
    };
  } catch (error) {
    release();
    throw error;
  }
}
