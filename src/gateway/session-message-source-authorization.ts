import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { assertAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { operatorScopeSatisfied } from "../shared/operator-scope-compat.js";
import { resolveUserChannelAuthorizationPolicy } from "../state/user-channel-identities.js";
import { prepareUserChannelIdentityAuthority } from "../state/user-channel-identity-operations.js";
import { resolveMessageActionTurnAuthorization } from "./message-action-turn-capability.js";
import { resolveGatewayOperatorRoleActor } from "./operator-role-policy.js";
import { resolveTelegramSessionDirect } from "./session-channel-direct-read.js";
import type { SessionMutationAuthorizationParams } from "./session-sharing-authorization.js";
import type { SessionSharingTarget } from "./session-sharing-target.types.js";

/** Admit a current linked sender only to the exact native Telegram topic. */
export async function prepareNativeTelegramSourceSend(params: SessionMutationAuthorizationParams) {
  const request = asOptionalRecord(params.requestParams);
  const payload = asOptionalRecord(request?.params);
  const client = params.client;
  const identity = client?.internal?.agentRuntimeIdentity;
  const authority = client?.internal?.operatorRunAuthority;
  const reference = authority?.channelRecoverySource?.reference;
  const token = identity?.messageActionContext?.turnCapability;
  const actor = client ? resolveGatewayOperatorRoleActor(client) : undefined;
  if (
    params.method !== "message.action" ||
    request?.action !== "send" ||
    request.channel !== "telegram" ||
    !payload ||
    !identity ||
    !authority ||
    !reference ||
    !token ||
    actor?.kind !== "operator" ||
    actor.profileId !== authority.profileId ||
    (client?.authenticatedUserProfile &&
      client.authenticatedUserProfile.profileId !== authority.profileId) ||
    !params.context.validateAgentRuntimeApprovalAuthority ||
    !operatorScopeSatisfied("operator.write", authority.scopes) ||
    !operatorScopeSatisfied("operator.write", client?.connect?.scopes ?? [])
  ) {
    return undefined;
  }
  let prepared: Awaited<ReturnType<typeof prepareUserChannelIdentityAuthority>>;
  try {
    assertAdmittedRunOperatorAuthority(authority);
    authority.assertCurrent();
    prepared = await prepareUserChannelIdentityAuthority({
      authorizationId: reference.id,
      policy: resolveUserChannelAuthorizationPolicy(params.context.getRuntimeConfig().gateway),
    });
  } catch {
    return undefined;
  }
  if (
    !prepared ||
    prepared.linked.profileId !== authority.profileId ||
    prepared.linked.authorization?.reference.id !== reference.id
  ) {
    return undefined;
  }
  return (target: SessionSharingTarget): boolean => {
    try {
      assertAdmittedRunOperatorAuthority(authority);
      authority.assertCurrent();
      if (
        !prepared.isCurrent() ||
        !params.context.validateAgentRuntimeApprovalAuthority?.(identity)
      ) {
        return false;
      }
      const turn = resolveMessageActionTurnAuthorization({
        token,
        agentId: identity.agentId,
        runId: identity.operationalRunInstance.runId,
        sessionKey: identity.sessionKey,
        sessionId: identity.messageActionContext?.sessionId,
      });
      const route = resolveTelegramSessionDirect(target.canonicalKey, target.entry);
      const topic =
        target.entry.delivery?.kind === "external"
          ? target.entry.delivery.route.thread?.id
          : undefined;
      const actor = target.entry.createdActor;
      const context = turn?.toolContext;
      return Boolean(
        route &&
        turn &&
        !turn.scheduled &&
        topic !== undefined &&
        /^[1-9]\d*$/.test(String(topic)) &&
        target.entry.createdVia === "channel" &&
        !target.entry.owner &&
        (!target.entry.access || target.entry.access.mode === "unrestricted") &&
        actor?.type === "human" &&
        actor.source === "channel" &&
        !actor.delegatedBy &&
        (actor.id === route.peerId || actor.id === `telegram:${route.peerId}`) &&
        target.agentId === identity.agentId &&
        route.agentId === identity.agentId &&
        target.canonicalKey === identity.sessionKey &&
        request.sessionKey === identity.sessionKey &&
        request.agentId === identity.agentId &&
        request.sessionId === target.entry.sessionId &&
        turn.sessionId === target.entry.sessionId &&
        turn.sourceReplySessionKey === identity.sessionKey &&
        turn.requesterAccountId === route.accountId &&
        turn.requesterSenderId === route.peerId &&
        prepared.linked.authorization?.subject ===
          JSON.stringify(["telegram", route.accountId, route.peerId]) &&
        context?.currentChannelProvider === "telegram" &&
        context.currentChatType === "direct" &&
        String(context.currentThreadTs) === String(topic) &&
        (request.accountId === undefined || request.accountId === route.accountId) &&
        (payload.accountId === undefined || payload.accountId === route.accountId) &&
        (payload.to === route.peerId || payload.to === `telegram:${route.peerId}`) &&
        String(payload.threadId) === String(topic) &&
        payload.topLevel !== true,
      );
    } catch {
      return false;
    }
  };
}
