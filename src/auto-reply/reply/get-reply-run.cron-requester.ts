import type { AdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { createCronCreatorAuthorityCapability } from "../../agents/cron-creator-authority-context.js";
import { normalizeCronAuthenticatedChannelRequester } from "../../cron/tools-allow-provenance.js";
import type { PersonalReminderIdentity } from "../../gateway/cron-creator-authority-grant.types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { normalizeAccountId } from "../../routing/account-id.js";
import { operatorScopeSatisfied } from "../../shared/operator-scope-compat.js";
import { getCommandOwnerAuthority } from "../command-owner-authority.js";

const log = createSubsystemLogger("cron");

/** Map fresh native ingress identity, not message text or stored delivery, to a requester. */
export function resolveReplyCronChannelRequester(
  context: object,
  params: {
    channel?: string;
    senderId?: string;
    accountId?: string;
  },
) {
  const owner = getCommandOwnerAuthority(context);
  const principal = owner?.channelPrincipal;
  if (
    !principal ||
    !owner.isCurrent() ||
    principal.channelId !== params.channel ||
    principal.accountId !== normalizeAccountId(params.accountId) ||
    principal.senderId !== params.senderId
  ) {
    return undefined;
  }
  return normalizeCronAuthenticatedChannelRequester({
    version: 1,
    channel: principal.channelId,
    accountId: principal.accountId,
    senderId: principal.senderId,
  });
}

/** Capture the original source once; queued admission may refresh its live owner check. */
export function createReplyCronAuthorityFactory(
  context: object,
  params: Parameters<typeof resolveReplyCronChannelRequester>[1] & {
    channel: string;
    personalReminder?: PersonalReminderIdentity;
    operator?: AdmittedRunOperatorAuthority;
  },
) {
  if (params.personalReminder && params.operator && params.senderId) {
    const origin = params.personalReminder;
    const operator = params.operator;
    const isCurrent = () => {
      try {
        operator.assertCurrent();
        return (
          operator.profileId === origin.profileId &&
          operatorScopeSatisfied("operator.cron", operator.scopes)
        );
      } catch {
        return false;
      }
    };
    if (!isCurrent()) return undefined;
    const requester = normalizeCronAuthenticatedChannelRequester({
      version: 1,
      channel: params.channel,
      accountId: normalizeAccountId(params.accountId),
      senderId: params.senderId,
    });
    if (!requester) return undefined;
    return (runId: string, _isCurrentOwner?: () => boolean) =>
      createCronCreatorAuthorityCapability(
        runId,
        { kind: "external", channel: params.channel },
        undefined,
        isCurrent,
        requester,
        undefined,
        true,
        origin,
      );
  }
  const authority = getCommandOwnerAuthority(context);
  const requester = resolveReplyCronChannelRequester(context, params);
  if (!authority || !requester) {
    return undefined;
  }
  const owner = {
    channel: requester.channel,
    accountId: requester.accountId,
    senderId: requester.senderId,
  };
  return (runId: string, isCurrentOwner = () => authority.isCurrent()) =>
    createCronCreatorAuthorityCapability(
      runId,
      { kind: "external", channel: params.channel },
      { source: "channel-owner", isCurrent: isCurrentOwner },
      undefined,
      requester,
      { isCurrent: isCurrentOwner, ...owner },
    );
}

/**
 * A configured owner whose ingress identity the host did not bind keeps caller-scoped
 * automations. Record why: the tool itself only reports "cron job not found".
 */
export function logReplyCronOwnerWithoutAuthority(
  context: object,
  params: { channel?: string; accountId?: string },
): void {
  const owner = getCommandOwnerAuthority(context);
  const reason = !owner?.channelPrincipal
    ? "ingress-identity-unbound"
    : owner.isCurrent()
      ? "ingress-identity-mismatch"
      : "owner-revoked";
  log.info("cron: owner turn without management authority", {
    channel: params.channel,
    accountId: normalizeAccountId(params.accountId),
    reason,
  });
}
